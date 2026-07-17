import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, stateRoot, warn, YAML_BLOCK_HEADER } from './lib.ts';
import {
  KNOWN_HEADS,
  headsFilePath,
  probeHeads,
  readHeadsFile,
  type DetectHeadsOptions,
  type HeadsSnapshot,
  type ProbeExec,
} from './detect-heads.ts';
import { isCompiledBinary, kitAssetText } from './kit-assets.ts';

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

/**
 * Seed profile content for a vendor. The `profilesDir` override (tests) reads
 * from that directory on disk and wins; the default goes through kit-assets
 * (embedded map inside a compiled binary, checkout file in the source lane —
 * spike §9 verdict #1). A missing seed yields null, matching the old
 * existsSync() guards.
 */
function readSeedText(vendor: string, profilesDir: string | undefined): string | null {
  if (profilesDir !== undefined) {
    const seedPath = join(profilesDir, SEED_FILES[vendor]);
    return existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : null;
  }
  try {
    return kitAssetText(`profiles/${SEED_FILES[vendor]}`);
  } catch {
    return null;
  }
}

/**
 * yamlScalar (lib.ts) applied to in-memory text instead of a file path — same
 * first-match, comment-stripping, quote-stripping semantics. Used for seed
 * `cost_hint`, which now arrives as content rather than a path.
 */
function yamlScalarText(text: string, key: string): string {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = line.match(new RegExp(`^${key}:[\\s]*`));
    if (match) {
      let value = line.slice(match[0].length);
      value = value.replace(/\s+#.*$/, '');
      const wasQuoted = /^".*"$/.test(value.trim());
      value = value.replace(/^"|"$/g, '');
      value = value.replace(/\s+$/, '');
      if (!wasQuoted && YAML_BLOCK_HEADER.test(value)) return '';
      return value;
    }
  }
  return '';
}

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
  /** Eligible vendors dropped because their CLI is not on PATH (run 0047). */
  unavailable: string[];
  /** True when NO eligible vendor probed available and ranking proceeded unfiltered (advisory degrade). */
  availability_degraded: boolean;
  human_gated: boolean;
  note: string;
}

export interface AllocateOptions {
  /** Optional working directory passed to side-effectful commands. */
  cwd?: string;
  /** Optional override for the external state root. */
  stateRoot?: string;
  /** Optional override for the seeded profile directory (used by tests). */
  profilesDir?: string;
  /** Optional execFileSync injection for testing side-effectful calls. */
  exec?: typeof execFileSync;
  /** Optional override path for the machine-global heads.json snapshot. */
  headsFile?: string;
  /** Optional injectable live head probe (heads.json fallback, used by tests). */
  probeHeads?: (options?: DetectHeadsOptions) => HeadsSnapshot;
}

// Hard constraints: which vendors CAN take this role at all
// (capability matrix §2/§3; role rules §8; Wave 2 write-role policy).
// Exported for dispatch.ts's fail-with-suggestions substitute lookup.
export function eligible(role: string): string[] {
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

// Seeded relevance: does any seeded_strength mention the task_type stem or the
// generic capability keywords?
function isSeedRelevant(seedText: string | null, taskType: string): boolean {
  if (seedText === null) return false;
  const stem = taskType.split('_')[0];
  // The shell source interpolates the stem directly into grep -E. Preserve
  // that regex behavior; malformed patterns make grep return non-zero.
  try {
    const pattern = new RegExp(`${stem}|review|refactor|implement|visual|explor`, 'i');
    return pattern.test(seedText);
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

/** Adapt AllocateOptions.exec (typeof execFileSync) to the probe exec shape. */
function allocateProbeExec(exec: typeof execFileSync): ProbeExec {
  return (file, args, probeOptions) =>
    exec(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: probeOptions?.timeoutMs,
    }) as string;
}

/**
 * Per-vendor CLI availability (run 0047): the availability filter made real.
 * The machine-global heads.json snapshot is authoritative when present and
 * parseable; when it is missing (or malformed) the vendors are probed live
 * through the same injectable exec detect-heads uses — allocation NEVER fails
 * just because the file is absent. A probe that itself blows up fails open
 * (every vendor treated as available) so detection trouble cannot wedge
 * allocation; a probe that answers "not on PATH" fails closed for exactly
 * that vendor, which is the signal this filter exists for.
 */
function availabilityByVendor(options: AllocateOptions): Record<string, boolean> {
  const headsFile = options.headsFile ?? headsFilePath();
  let snapshot = readHeadsFile(headsFile);
  if (snapshot === null) {
    const probe = options.probeHeads
      ?? (() => probeHeads({ exec: options.exec ? allocateProbeExec(options.exec) : undefined }));
    try {
      snapshot = probe();
    } catch {
      snapshot = null;
    }
  }
  const availability: Record<string, boolean> = {};
  for (const name of KNOWN_HEADS) {
    availability[name] = snapshot === null ? true : snapshot.heads[name].available === true;
  }
  return availability;
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
  const stateRootPath = options.stateRoot ?? stateRoot();

  const measuredDir = join(stateRootPath, 'agents', 'profiles');

  // Availability filter (run 0047): drop vendors whose CLI is not on PATH
  // BEFORE ranking — recommending a head that cannot launch is useless.
  const availability = availabilityByVendor(options);
  const eligibleVendors = eligible(role);
  const eligibleAfterExclude = eligibleVendors.filter((vendor) => vendor !== excludeVendor);
  if (eligibleAfterExclude.length === 0) {
    die(`no eligible vendor for role=${role}`);
  }
  const unavailable = eligibleAfterExclude.filter((vendor) => availability[vendor] === false);
  let candidates = eligibleAfterExclude.filter((vendor) => availability[vendor] !== false);
  let availabilityDegraded = false;
  if (candidates.length === 0) {
    // Allocation is recommend-only ("the ledger recommends, humans pin"): an
    // environment where NO eligible CLI probes as available — a scrubbed CI
    // PATH, cron without a login env — must degrade to unfiltered ranking
    // with a warning, not die. A hard error here breaks advisory callers
    // that never intend to dispatch from this environment; dispatch has its
    // own fail-fast gate for the machine that actually launches the worker.
    warn(
      `allocate: no eligible vendor for role=${role} is available on PATH `
      + `(${unavailable.join(', ')}); ranking unfiltered — verify availability before dispatch`,
    );
    candidates = eligibleAfterExclude;
    availabilityDegraded = true;
  }

  const ranked: Candidate[] = candidates.map((vendor) => {
    const seedText = readSeedText(vendor, options.profilesDir);
    const measured = join(measuredDir, `${vendor}.measured.json`);
    const seedRelevant = isSeedRelevant(seedText, taskType);
    const measuredStats = readMeasured(measured);
    const cost = seedText !== null ? yamlScalarText(seedText, 'cost_hint') : '';

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
    unavailable,
    availability_degraded: availabilityDegraded,
    human_gated: true,
    note: 'Recommendation only — a human pins the role. Ranking uses measured stats at n>=8, else seeded priors; community claims marked do_not_allocate_on are never used.',
  };
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const role = args[0];
    const taskType = args[1];
    const risk = args[2] || 'medium';

    const excludeVendor = args[3] === '--exclude-vendor'
      ? (args[4] || '')
      : '';

    const result = allocate(role, taskType, risk, excludeVendor);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
