import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocate, type AllocateResult } from '../src/allocate.ts';
import type { HeadsSnapshot } from '../src/detect-heads.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-allocate');

const ORIGINAL_HYDRA_HEADS_FILE = process.env.HYDRA_HEADS_FILE;

// Existing ranking tests must not depend on which vendor CLIs happen to be on
// this machine's PATH: pin availability to an all-available heads.json fixture
// via HYDRA_HEADS_FILE (inherited by the CLI subprocess tests too).
const ALL_AVAILABLE_HEADS = join(TEST_TMP, 'heads-all-available.json');

function setupHeadsEnv(): void {
  writeHeadsSnapshot(ALL_AVAILABLE_HEADS, {});
  process.env.HYDRA_HEADS_FILE = ALL_AVAILABLE_HEADS;
}

function restoreHeadsEnv(): void {
  if (ORIGINAL_HYDRA_HEADS_FILE === undefined) delete process.env.HYDRA_HEADS_FILE;
  else process.env.HYDRA_HEADS_FILE = ORIGINAL_HYDRA_HEADS_FILE;
}

function writeHeadsSnapshot(path: string, availability: Partial<Record<string, boolean>>): void {
  mkdirSync(dirname(path), { recursive: true });
  const heads: Record<string, unknown> = {};
  for (const name of ['claude', 'codex', 'opencode', 'kimi']) {
    const available = availability[name] ?? true;
    heads[name] = { available, path: available ? `/usr/bin/${name}` : null };
  }
  writeFileSync(path, JSON.stringify({ detected_at: '2026-01-01T00:00:00Z', heads }), 'utf8');
}

function liveSnapshot(availability: Partial<Record<string, boolean>>): HeadsSnapshot {
  const head = (name: string) => ({
    available: availability[name] ?? true,
    path: (availability[name] ?? true) ? `/usr/bin/${name}` : null,
  });
  return {
    detected_at: '2026-01-01T00:00:00Z',
    heads: {
      claude: head('claude'),
      codex: head('codex'),
      opencode: { ...head('opencode'), models: [], active_model: 'zai-coding-plan/glm-5.2' },
      kimi: { ...head('kimi'), srt_available: true, write_capable: true },
    },
  };
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, uniqueName(prefix));
  mkdirSync(p, { recursive: true });
  return p;
}

interface FixturePaths {
  profilesDir: string;
  stateRoot: string;
}

function setupFixture(): FixturePaths {
  const profilesDir = makeTempDir('profiles');
  const stateRoot = makeTempDir('state');
  mkdirSync(join(stateRoot, 'agents', 'profiles'), { recursive: true });
  return { profilesDir, stateRoot };
}

function writeSeed(
  profilesDir: string,
  vendor: string,
  content: string,
): void {
  const filename: Record<string, string> = {
    claude: 'claude-fable-5.yaml',
    codex: 'codex-gpt-5.6-sol.yaml',
    opencode: 'opencode-glm-5.2.yaml',
    kimi: 'kimi-k2.7-code.yaml',
  };
  writeFileSync(join(profilesDir, filename[vendor]), content, 'utf8');
}

function writeMeasured(
  stateRoot: string,
  vendor: string,
  measured: Record<string, unknown>,
): void {
  writeFileSync(
    join(stateRoot, 'agents', 'profiles', `${vendor}.measured.json`),
    JSON.stringify({ vendor, evidence_class: 'measured', measured_at: '2024-01-01T00:00:00Z', measured }),
    'utf8',
  );
}

function vendors(result: AllocateResult): string[] {
  return result.ranked.map((c) => c.vendor);
}

describe('allocate', () => {
  before(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    setupHeadsEnv();
  });
  after(() => {
    cleanTmp();
    restoreHeadsEnv();
  });

  it('throws when role is empty', () => {
    assert.throws(() => allocate('', 'implement'), /usage: allocate/);
  });

  it('throws when task_type is empty', () => {
    assert.throws(() => allocate('implementer', ''), /task_type required/);
  });

  it('throws when no eligible vendor remains after exclusion', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    assert.throws(
      () => allocate('visual_debugging', 'screenshot', 'medium', 'kimi', { profilesDir, stateRoot }),
      /no eligible vendor for role=visual_debugging/,
    );
  });

  it('returns only kimi for visual_debugging role', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    const result = allocate('visual_debugging', 'screenshot', 'medium', '', { profilesDir, stateRoot });
    assert.deepEqual(vendors(result), ['kimi']);
    assert.equal(result.recommendation, 'kimi');
  });

  it('excludes opencode from implementer candidates', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot });
    assert.deepEqual(vendors(result), ['claude', 'codex', 'kimi']);
  });

  it('ranks by measured acceptance when n>=8', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');

    // High acceptance + high divergence still wins over low acceptance.
    writeMeasured(stateRoot, 'claude', { n_reviewed: 8, acceptance_rate: 0.9, claim_vs_verified_divergence: 0.5 });
    writeMeasured(stateRoot, 'codex', { n_reviewed: 8, acceptance_rate: 0.5, claim_vs_verified_divergence: 0.1 });

    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot });
    // claude wins on measured acceptance; kimi (null divergence -> 0) edges codex (0.1).
    assert.deepEqual(vendors(result), ['claude', 'kimi', 'codex']);
    assert.equal(result.ranked[0].evidence_class, 'measured');
    assert.equal(result.ranked[0].acceptance_rate, 0.9);
    assert.equal(result.ranked[0].divergence, 0.5);
  });

  it('uses zero for missing measured stats when n>=8', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');

    writeMeasured(stateRoot, 'claude', { n_reviewed: 8 });

    const result = allocate('integrator', 'feature', 'medium', '', { profilesDir, stateRoot });
    assert.deepEqual(vendors(result), ['codex', 'claude']);
    const claude = result.ranked.find((candidate) => candidate.vendor === 'claude');
    assert.equal(claude?.evidence_class, 'measured');
    assert.equal(claude?.acceptance_rate, 0);
    assert.equal(claude?.divergence, 0);
  });

  it('treats false measured stats as zero when n>=8', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');

    writeMeasured(stateRoot, 'claude', {
      n_reviewed: 8,
      acceptance_rate: false,
      claim_vs_verified_divergence: false,
    });

    const result = allocate('integrator', 'feature', 'medium', '', { profilesDir, stateRoot });
    const claude = result.ranked.find((candidate) => candidate.vendor === 'claude');
    assert.equal(claude?.acceptance_rate, 0);
    assert.equal(claude?.divergence, 0);
  });

  it('falls back to seeded priors when measured n<8', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'seeded_strengths:\n  - claim: implementation\n    cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');

    writeMeasured(stateRoot, 'claude', { n_reviewed: 3, acceptance_rate: 0.9, claim_vs_verified_divergence: 0.0 });

    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot });
    assert.equal(result.ranked[0].evidence_class, 'seeded');
    assert.equal(result.ranked[0].n_measured, 3);
    assert.equal(result.ranked[0].acceptance_rate, null);
  });

  it('uses seed relevance to break ties', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'seeded_strengths:\n  - claim: implementation\ncost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'seeded_strengths:\n  - claim: review\ncost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');

    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot });
    // claude (implement) and codex (review) match the generic relevance regex;
    // kimi has no relevant keyword. Relevant candidates come first.
    const relevant = result.ranked.filter((c) => c.seed_relevant).map((c) => c.vendor);
    assert.deepEqual(relevant, ['claude', 'codex']);
    assert.equal(result.ranked[result.ranked.length - 1].vendor, 'kimi');
    assert.equal(result.ranked[result.ranked.length - 1].seed_relevant, false);
  });

  it('honours --exclude-vendor', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');

    const result = allocate('implementer', 'feature', 'medium', 'claude', { profilesDir, stateRoot });
    assert.deepEqual(vendors(result), ['codex', 'kimi']);
    assert.equal(result.excluded, 'claude');
    assert.equal(result.recommendation, 'codex');
  });

  it('defaults risk to medium', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    const result = allocate('integrator', 'merge', '', '', { profilesDir, stateRoot });
    assert.equal(result.risk, 'medium');
  });

  it('passes through risk and excluded null when empty', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    const result = allocate('integrator', 'merge', 'high', '', { profilesDir, stateRoot });
    assert.equal(result.risk, 'high');
    assert.equal(result.excluded, null);
  });

  it('reflects reviewer role ordering and excludes kimi', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'opencode', 'cost_hint: free_tier\n');
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    const result = allocate('reviewer', 'audit', 'medium', '', { profilesDir, stateRoot });
    assert.deepEqual(vendors(result), ['codex', 'opencode', 'claude']);
  });

  it('uses the claude and codex default for an unknown role', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');

    const result = allocate('unknown', 'feature', 'medium', '', { profilesDir, stateRoot });
    assert.deepEqual(vendors(result), ['claude', 'codex']);
  });

  it('preserves grep -E behavior for regex metacharacters in task types', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'seeded_strengths:\n  - claim: c++\ncost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');

    const result = allocate('integrator', 'c++_build', 'medium', '', { profilesDir, stateRoot });
    assert.equal(result.ranked.find((candidate) => candidate.vendor === 'claude')?.seed_relevant, false);
  });

  it('prefers lower divergence when acceptance and relevance tie', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');

    writeMeasured(stateRoot, 'claude', { n_reviewed: 8, acceptance_rate: 0.8, claim_vs_verified_divergence: 0.5 });
    writeMeasured(stateRoot, 'codex', { n_reviewed: 8, acceptance_rate: 0.8, claim_vs_verified_divergence: 0.1 });

    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot });
    assert.deepEqual(vendors(result), ['codex', 'claude', 'kimi']);
  });

  it('throws when excluding the only eligible vendor', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    assert.throws(
      () => allocate('visual_debugging', 'ui', 'medium', 'kimi', { profilesDir, stateRoot }),
      /no eligible vendor for role=visual_debugging/,
    );
  });
});

describe('allocate CLI', () => {
  before(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    setupHeadsEnv();
  });
  after(() => {
    cleanTmp();
    restoreHeadsEnv();
  });

  it('prints a JSON recommendation to stdout', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');

    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'allocate.ts'),
        'integrator',
        'merge',
        'low',
        '--exclude-vendor',
        'codex',
      ],
      { encoding: 'utf8', env: { ...process.env, HYDRA_STATE_ROOT: stateRoot } },
    );

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as AllocateResult;
    assert.equal(parsed.role, 'integrator');
    assert.equal(parsed.task_type, 'merge');
    assert.equal(parsed.risk, 'low');
    assert.equal(parsed.excluded, 'codex');
    assert.equal(parsed.recommendation, 'claude');
    assert.equal(parsed.human_gated, true);
  });

  it('reports die errors without a stack trace', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'allocate.ts'),
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'hydra: error: usage: allocate <role> <task_type> [risk] [--exclude-vendor <v>]\n');
  });

  it('only recognizes --exclude-vendor in the fourth argument position', () => {
    const { stateRoot } = setupFixture();
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'allocate.ts'),
        'integrator',
        'merge',
        '--exclude-vendor',
        'codex',
      ],
      { encoding: 'utf8', env: { ...process.env, HYDRA_STATE_ROOT: stateRoot } },
    );

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as AllocateResult;
    assert.equal(parsed.risk, '--exclude-vendor');
    assert.equal(parsed.excluded, null);
  });

  it('resolves the default profile directory relative to the source file, not cwd', () => {
    const { stateRoot } = setupFixture();

    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'allocate.ts'),
        'integrator',
        'merge',
        'low',
        '--exclude-vendor',
        'codex',
      ],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: { ...process.env, HYDRA_STATE_ROOT: stateRoot },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as AllocateResult;
    assert.equal(parsed.recommendation, 'claude');
  });
});

describe('allocate availability filter', () => {
  before(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    setupHeadsEnv();
  });
  after(() => {
    cleanTmp();
    restoreHeadsEnv();
  });

  it('drops vendors whose CLI is unavailable per heads.json before ranking', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'opencode', 'cost_hint: free_tier\n');
    const headsFile = join(stateRoot, 'heads.json');
    writeHeadsSnapshot(headsFile, { codex: false });

    const result = allocate('reviewer', 'audit', 'medium', '', { profilesDir, stateRoot, headsFile });

    assert.deepEqual(vendors(result), ['opencode', 'claude']);
    assert.deepEqual(result.unavailable, ['codex']);
    assert.equal(result.recommendation, 'opencode');
  });

  it('recommends the best available vendor', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'seeded_strengths:\n  - claim: implementation\ncost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'seeded_strengths:\n  - claim: review\ncost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    const headsFile = join(stateRoot, 'heads.json');
    writeHeadsSnapshot(headsFile, { claude: false });

    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot, headsFile });

    assert.deepEqual(vendors(result), ['codex', 'kimi']);
    assert.equal(result.recommendation, 'codex');
    assert.deepEqual(result.unavailable, ['claude']);
  });

  it('degrades to unfiltered ranking with a warning when every eligible vendor is unavailable', () => {
    // Allocation is recommend-only: a scrubbed environment (blackbox harness,
    // CI, cron without a login PATH) must still produce a ranking — dispatch
    // owns the fail-fast gate on the machine that actually launches.
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    const headsFile = join(stateRoot, 'heads.json');
    writeHeadsSnapshot(headsFile, { claude: false, codex: false, opencode: false, kimi: false });

    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot, headsFile });
    assert.equal(result.availability_degraded, true);
    assert.deepEqual(result.unavailable, ['claude', 'codex', 'kimi']);
    assert.ok(result.recommendation !== null);
    assert.equal(result.ranked.length, 3);
  });

  it('probes live with the injectable when heads.json is missing', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    const headsFile = join(stateRoot, 'absent-heads.json');
    let probed = 0;
    const probeHeads = (): HeadsSnapshot => {
      probed += 1;
      return liveSnapshot({ kimi: false });
    };

    const result = allocate('visual_debugging', 'screenshot', 'medium', '', { profilesDir, stateRoot, headsFile, probeHeads });
    assert.equal(probed, 1);
    // kimi (the only eligible vendor) probed unavailable → advisory degrade,
    // not a hard error: the live probe was still consulted exactly once.
    assert.equal(result.availability_degraded, true);
    assert.deepEqual(result.unavailable, ['kimi']);
    assert.equal(result.recommendation, 'kimi');
  });

  it('does not probe live when heads.json is present', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    const headsFile = join(stateRoot, 'heads.json');
    writeHeadsSnapshot(headsFile, {});
    let probed = 0;
    const probeHeads = (): HeadsSnapshot => {
      probed += 1;
      return liveSnapshot({ kimi: false });
    };

    const result = allocate('visual_debugging', 'screenshot', 'medium', '', { profilesDir, stateRoot, headsFile, probeHeads });

    assert.deepEqual(vendors(result), ['kimi']);
    assert.equal(probed, 0);
  });

  it('falls back to a live probe when heads.json is malformed', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    writeSeed(profilesDir, 'opencode', 'cost_hint: free_tier\n');
    const headsFile = join(stateRoot, 'heads.json');
    writeFileSync(headsFile, 'not json', 'utf8');

    const result = allocate('reviewer', 'audit', 'medium', '', {
      profilesDir,
      stateRoot,
      headsFile,
      probeHeads: () => liveSnapshot({ opencode: false }),
    });

    assert.deepEqual(vendors(result), ['codex', 'claude']);
    assert.deepEqual(result.unavailable, ['opencode']);
  });

  it('routes the live probe through the injectable exec', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'claude', 'cost_hint: subscription\n');
    writeSeed(profilesDir, 'codex', 'cost_hint: "5.0/30.0"\n');
    const headsFile = join(stateRoot, 'absent-heads.json');
    const exec = (file: string, args: string[]): string => {
      const command = args.join(' ');
      if (file === 'sh' && command.includes('command -v claude')) return '/usr/bin/claude\n';
      const error = new Error(`not found: ${command}`) as Error & { status?: number };
      error.status = 1;
      throw error;
    };

    const result = allocate('integrator', 'merge', 'medium', '', {
      profilesDir,
      stateRoot,
      headsFile,
      exec: exec as unknown as typeof execFileSync,
    });

    assert.deepEqual(vendors(result), ['claude']);
    assert.deepEqual(result.unavailable, ['codex']);
  });

  it('never fails allocation because heads.json is absent', () => {
    const { profilesDir, stateRoot } = setupFixture();
    writeSeed(profilesDir, 'kimi', 'cost_hint: "0.95/4.00"\n');
    const headsFile = join(stateRoot, 'absent-heads.json');

    const result = allocate('visual_debugging', 'screenshot', 'medium', '', {
      profilesDir,
      stateRoot,
      headsFile,
      probeHeads: () => liveSnapshot({}),
    });

    assert.equal(result.recommendation, 'kimi');
    assert.deepEqual(result.unavailable, []);
  });
});
