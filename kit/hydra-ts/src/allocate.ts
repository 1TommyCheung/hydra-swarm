import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, repoRoot, stateRoot, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Allocation RECOMMENDATION (vendor-adapters.md §5).
//
// Ranking pipeline:
//   hard constraints (capability matrix + role rules)
//     -> availability filter
//     -> capability ranking (measured when n>=8, else seeded priors)
//     -> cost/latency tie-break
//     -> cross-vendor-review diversity override
// RECOMMEND-ONLY. No automatic role-pin changes — the ledger recommends, humans
// pin. Community-sourced claims (do_not_allocate_on) never drive allocation.
// ---------------------------------------------------------------------------

const MIN_N = 8; // measured drives ranking only at n>=8 (§5); else seeded priors

const SEED_FILES: Record<string, string> = {
  claude: 'claude-fable-5.yaml',
  codex: 'codex-gpt-5.6-sol.yaml',
  opencode: 'opencode-glm-5.2.yaml',
  kimi: 'kimi-k2.7-code.yaml',
};

export interface Candidate {
  vendor: string;
  evidence_class: 'seeded' | 'measured';
  n_measured: number;
  seed_relevant: boolean;
  acceptance_rate: number | null;
  divergence: number | null;
  cost_hint: string;
}

export interface AllocateResult {
  role: string;
  task_type: string;
  risk: string;
  excluded: string | null;
  recommendation: string | null;
  ranked: Candidate[];
  human_gated: boolean;
  note: string;
}

export interface AllocateOptions {
  /** Optional working directory passed to side-effectful commands. */
  cwd?: string;
  /** Optional override for the external state root. */
  stateRoot?: string;
  /** Optional override for the repository root (avoids shelling out to git). */
  repoRoot?: string;
  /** Optional execFileSync injection for testing side-effectful calls. */
  exec?: typeof execFileSync;
}

// Hard constraints: which vendors CAN take this role at all
// (capability matrix §2/§3; role rules §8; Wave 2 write-role policy).
function eligible(role: string): string[] {
  switch (role) {
    case 'visual_debugging':
      return ['kimi']; // multimodal HARD pin
    case 'implementer':
      return ['claude', 'codex', 'kimi']; // opencode read-only; kimi sandboxed
    case 'integrator':
      return ['claude', 'codex'];
    case 'reviewer':
      return ['codex', 'opencode', 'claude']; // glm long-diff; kimi small-context excluded
    case 'explorer':
      return ['claude', 'codex', 'opencode', 'kimi'];
    default:
      return ['claude', 'codex'];
  }
}

function resolveRepoRoot(options: AllocateOptions): string {
  if (options.repoRoot) return options.repoRoot;
  if (options.exec) {
    return options.exec('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      cwd: options.cwd,
    }).trim();
  }
  return repoRoot();
}

// Seeded relevance: does any seeded_strength mention the task_type stem or the
// generic capability keywords?
function isSeedRelevant(seedPath: string, taskType: string): boolean {
  if (!existsSync(seedPath)) return false;
  const stem = taskType.split('_')[0];
  // The shell source interpolates the stem directly into grep -E. Preserve
  // that regex behavior; malformed patterns make grep return non-zero.
  try {
    const pattern = new RegExp(`${stem}|review|refactor|implement|visual|explor`, 'i');
    return pattern.test(readFileSync(seedPath, 'utf8'));
  } catch {
    return false;
  }
}

interface MeasuredStats {
  n: number;
  acceptance: number | null;
  divergence: number | null;
}

// jq's `value // 0 | tonumber` falls back for null and false, then returns
// null rather than coercing non-numeric JSON values.
function measuredNumber(value: unknown): number | null {
  const selected = value === false || value == null ? 0 : value;
  if (typeof selected === 'number') return selected;
  if (typeof selected !== 'string') return null;
  try {
    const parsed = JSON.parse(selected) as unknown;
    return typeof parsed === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function readMeasured(measuredPath: string): MeasuredStats {
  if (!existsSync(measuredPath)) {
    return { n: 0, acceptance: null, divergence: null };
  }
  const data = JSON.parse(readFileSync(measuredPath, 'utf8')) as Record<string, unknown>;
  const measured = (data.measured ?? {}) as Record<string, unknown>;
  const n = Number(measured.n_reviewed ?? measured.n_promoted ?? 0);
  if (n < MIN_N) {
    return { n, acceptance: null, divergence: null };
  }
  return {
    n,
    acceptance: measuredNumber(measured.acceptance_rate),
    divergence: measuredNumber(measured.claim_vs_verified_divergence),
  };
}

/**
 * Choose a vendor for a task from live capability profiles (seeded/measured).
 *
 * Mirrors hydra/scripts/allocate.sh:
 *   allocate <role> <task_type> [risk] [--exclude-vendor <v>]
 *
 * @param role - implementer | reviewer | explorer | visual_debugging | integrator
 * @param taskType - task type used for seeded relevance matching
 * @param risk - risk level (defaults to "medium")
 * @param excludeVendor - vendor to exclude from consideration
 * @param options - optional overrides for cwd/stateRoot/repoRoot/exec
 * @returns ranked recommendation object
 */
export function allocate(
  role: string,
  taskType: string,
  risk = 'medium',
  excludeVendor = '',
  options: AllocateOptions = {},
): AllocateResult {
  if (!role) die('usage: allocate <role> <task_type> [risk] [--exclude-vendor <v>]');
  if (!taskType) die('task_type required');

  const resolvedRisk = risk || 'medium';
  const repoRootPath = resolveRepoRoot(options);
  const stateRootPath = options.stateRoot ?? stateRoot();

  const profDir = join(repoRootPath, 'hydra', 'profiles');
  const measuredDir = join(stateRootPath, 'agents', 'profiles');

  const candidates = eligible(role).filter((v) => v !== excludeVendor);
  if (candidates.length === 0) die(`no eligible vendor for role=${role}`);

  const ranked: Candidate[] = candidates.map((vendor) => {
    const seed = join(profDir, SEED_FILES[vendor]);
    const measured = join(measuredDir, `${vendor}.measured.json`);
    const seedRelevant = isSeedRelevant(seed, taskType);
    const measuredStats = readMeasured(measured);
    const cost = existsSync(seed) ? yamlScalar(seed, 'cost_hint') : '';

    return {
      vendor,
      evidence_class: measuredStats.n >= MIN_N ? 'measured' : 'seeded',
      n_measured: measuredStats.n,
      seed_relevant: seedRelevant,
      acceptance_rate: measuredStats.acceptance,
      divergence: measuredStats.divergence,
      cost_hint: cost,
    };
  });

  // Rank: measured acceptance desc (when present) -> seed relevance -> divergence.
  ranked.sort((a, b) => {
    const aAccept = a.acceptance_rate != null ? 1 - a.acceptance_rate : 0.5;
    const bAccept = b.acceptance_rate != null ? 1 - b.acceptance_rate : 0.5;
    if (aAccept !== bAccept) return aAccept - bAccept;

    const aRelevant = a.seed_relevant ? 0 : 1;
    const bRelevant = b.seed_relevant ? 0 : 1;
    if (aRelevant !== bRelevant) return aRelevant - bRelevant;

    const aDiv = a.divergence ?? 0;
    const bDiv = b.divergence ?? 0;
    return aDiv - bDiv;
  });

  return {
    role,
    task_type: taskType,
    risk: resolvedRisk,
    excluded: excludeVendor || null,
    recommendation: ranked[0]?.vendor ?? null,
    ranked,
    human_gated: true,
    note: 'Recommendation only — a human pins the role. Ranking uses measured stats at n>=8, else seeded priors; community claims marked do_not_allocate_on are never used.',
  };
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const role = process.argv[2];
    const taskType = process.argv[3];
    const risk = process.argv[4] || 'medium';

    const excludeVendor = process.argv[5] === '--exclude-vendor'
      ? (process.argv[6] || '')
      : '';

    const result = allocate(role, taskType, risk, excludeVendor);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
