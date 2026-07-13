import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  aggregateUsage,
  aggregatePromotedByVendor,
  aggregateUsageByVendor,
  aggregateVerdictsByVendor,
  extractPromotedRecords,
  extractVerdictRecords,
  readUsageLog,
  type MeasuredProfile,
} from '../src/aggregate-usage.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-aggregate-usage');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeStateRoot(): string {
  const root = join(
    TEST_TMP,
    `state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

function writeLedger(
  root: string,
  runId: string,
  lines: Record<string, unknown>[],
): void {
  const ledgerFile = join(
    root,
    'runs',
    `run-${runId}`,
    'authoritative',
    'ledger',
    'events.jsonl',
  );
  mkdirSync(join(ledgerFile, '..'), { recursive: true });
  writeFileSync(
    ledgerFile,
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  );
}

function writeUsageLog(
  root: string,
  lines: Record<string, unknown>[],
): void {
  const logFile = join(root, 'agents', 'usage.jsonl');
  mkdirSync(join(logFile, '..'), { recursive: true });
  writeFileSync(
    logFile,
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  );
}

function readProfile(
  root: string,
  vendor: string,
): MeasuredProfile {
  return JSON.parse(
    readFileSync(join(root, 'agents', 'profiles', `${vendor}.measured.json`), 'utf8'),
  ) as MeasuredProfile;
}

// ---------------------------------------------------------------------------
// Unit-level helpers.
// ---------------------------------------------------------------------------

describe('aggregateUsageByVendor', () => {
  it('computes dispatch counts, totals and median cost', () => {
    const result = aggregateUsageByVendor([
      { vendor: 'claude', time: '2024-01-01T00:00:00Z', cost_usd: 10, tokens_out: 10 },
      { vendor: 'claude', time: '2024-01-02T00:00:00Z', cost_usd: 30, tokens_out: 20 },
      { vendor: 'claude', time: '2024-01-03T00:00:00Z', cost_usd: 20, tokens_out: 30 },
    ]);
    assert.equal(result.claude.n_dispatch, 3);
    assert.equal(result.claude.total_cost_usd, 60);
    assert.equal(result.claude.median_cost_usd, 20);
  });

  it('keeps the last 40 entries in the rolling window sorted by time', () => {
    const events = Array.from({ length: 45 }, (_, i) => {
      const day = Math.floor(i / 24) + 1;
      const hour = String(i % 24).padStart(2, '0');
      return {
        vendor: 'codex',
        time: `2024-01-0${day}T${hour}:00:00Z`,
        cost_usd: i * 0.01,
        tokens_out: i,
      };
    });
    const result = aggregateUsageByVendor(events);
    assert.equal(result.codex.rolling_window.length, 40);
    assert.equal(result.codex.rolling_window[0].time, '2024-01-01T05:00:00Z');
    assert.equal(result.codex.rolling_window.at(-1)?.time, '2024-01-02T20:00:00Z');
  });

  it('treats missing cost_usd as zero', () => {
    const result = aggregateUsageByVendor([
      { vendor: 'claude', time: '2024-01-01T00:00:00Z' },
      { vendor: 'claude', time: '2024-01-02T00:00:00Z', cost_usd: 0.1 },
    ]);
    assert.equal(result.claude.total_cost_usd, 0.1);
    assert.equal(result.claude.median_cost_usd, 0.1);
  });
});

describe('readUsageLog', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('returns an empty object when the usage log is missing', () => {
    const root = makeStateRoot();
    assert.deepEqual(readUsageLog(root), {});
  });

  it('returns an empty object when the usage log is malformed', () => {
    const root = makeStateRoot();
    writeUsageLog(root, []);
    writeFileSync(join(root, 'agents', 'usage.jsonl'), 'not-json\n', 'utf8');
    assert.deepEqual(readUsageLog(root), {});
  });
});

describe('extractPromotedRecords', () => {
  it('joins result_promoted events with their task_started vendor', () => {
    const records = extractPromotedRecords([
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
      { event: 'task_started', task_id: 't2', vendor: 'codex' },
      { event: 'result_promoted', task_id: 't2', divergence: 'false' },
    ]);
    assert.deepEqual(records, [
      { vendor: 'claude', task_id: 't1', divergent: true },
      { vendor: 'codex', task_id: 't2', divergent: false },
    ]);
  });

  it('falls back to unknown vendor when task_started is missing', () => {
    const records = extractPromotedRecords([
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);
    assert.deepEqual(records, [
      { vendor: 'unknown', task_id: 't1', divergent: true },
    ]);
  });

  it('treats string "true" and boolean true as divergent', () => {
    const records = extractPromotedRecords([
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: 'true' },
      { event: 'task_started', task_id: 't2', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't2', divergence: true },
    ]);
    assert.deepEqual(
      records.map((r) => r.divergent),
      [true, true],
    );
  });
});

describe('aggregatePromotedByVendor', () => {
  it('computes n_promoted, divergent count and divergence ratio', () => {
    const result = aggregatePromotedByVendor([
      { vendor: 'claude', task_id: 't1', divergent: true },
      { vendor: 'claude', task_id: 't2', divergent: false },
      { vendor: 'claude', task_id: 't3', divergent: true },
      { vendor: 'codex', task_id: 't4', divergent: false },
    ]);
    assert.deepEqual(result.claude, {
      n_promoted: 3,
      divergent: 2,
      claim_vs_verified_divergence: 2 / 3,
    });
    assert.deepEqual(result.codex, {
      n_promoted: 1,
      divergent: 0,
      claim_vs_verified_divergence: 0,
    });
  });
});

describe('extractVerdictRecords', () => {
  it('joins review_verdict events with their implementer vendor', () => {
    const records = extractVerdictRecords([
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'review_verdict', task_id: 't1', verdict: 'accept' },
      { event: 'task_started', task_id: 't2', vendor: 'codex' },
      { event: 'review_verdict', task_id: 't2', verdict: 'revise' },
    ]);
    assert.deepEqual(records, [
      { impl_vendor: 'claude', verdict: 'accept' },
      { impl_vendor: 'codex', verdict: 'revise' },
    ]);
  });
});

describe('aggregateVerdictsByVendor', () => {
  it('computes acceptance and revision rates', () => {
    const result = aggregateVerdictsByVendor([
      { impl_vendor: 'claude', verdict: 'accept' },
      { impl_vendor: 'claude', verdict: 'accept' },
      { impl_vendor: 'claude', verdict: 'revise' },
      { impl_vendor: 'claude', verdict: 'reject' },
    ]);
    assert.equal(result.claude.n_reviewed, 4);
    assert.equal(result.claude.acceptance_rate, 0.5);
    assert.equal(result.claude.revision_rate, 0.5);
  });
});

// ---------------------------------------------------------------------------
// End-to-end aggregation.
// ---------------------------------------------------------------------------

describe('aggregateUsage', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('creates the profiles directory even when nothing is aggregated', () => {
    const root = makeStateRoot();
    const profiles = aggregateUsage({ stateRoot: root });
    assert.deepEqual(profiles, []);
    assert.ok(existsSync(join(root, 'agents', 'profiles')));
  });

  it('writes per-vendor measured profiles from the usage log', () => {
    const root = makeStateRoot();
    writeUsageLog(root, [
      {
        time: '2024-01-01T00:00:00Z',
        event: 'dispatch',
        run_id: 'r1',
        task_id: 't1',
        vendor: 'claude',
        cost_usd: 0.1,
        tokens_out: 100,
      },
      {
        time: '2024-01-02T00:00:00Z',
        event: 'dispatch',
        run_id: 'r1',
        task_id: 't2',
        vendor: 'claude',
        cost_usd: 0.3,
        tokens_out: 200,
      },
      {
        time: '2024-01-03T00:00:00Z',
        event: 'dispatch',
        run_id: 'r1',
        task_id: 't3',
        vendor: 'codex',
        cost_usd: 0.05,
        tokens_out: 50,
      },
    ]);

    const profiles = aggregateUsage({ stateRoot: root });
    assert.equal(profiles.length, 2);
    const vendors = profiles.map((p) => p.vendor).sort();
    assert.deepEqual(vendors, ['claude', 'codex']);

    const claude = readProfile(root, 'claude');
    assert.equal(claude.evidence_class, 'measured');
    assert.match(claude.measured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(claude.measured.n_dispatch, 2);
    assert.equal(claude.measured.total_cost_usd, 0.4);
    assert.equal(claude.measured.median_cost_usd, 0.3);
    assert.equal(claude.measured.rolling_window.length, 2);
    assert.deepEqual(claude.measured.rolling_window[0], {
      time: '2024-01-01T00:00:00Z',
      cost_usd: 0.1,
      tokens_out: 100,
    });

    const codex = readProfile(root, 'codex');
    assert.equal(codex.measured.n_dispatch, 1);
    assert.equal(codex.measured.total_cost_usd, 0.05);
  });

  it('aggregates promoted outcomes and verdicts from ledgers', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
      { event: 'review_verdict', task_id: 't1', verdict: 'accept' },
    ]);
    writeLedger(root, '0018', [
      { event: 'task_started', task_id: 't2', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't2', divergence: 'false' },
      { event: 'review_verdict', task_id: 't2', verdict: 'revise' },
    ]);

    aggregateUsage({ stateRoot: root });
    const claude = readProfile(root, 'claude');
    assert.equal(claude.measured.n_promoted, 2);
    assert.equal(claude.measured.divergent, 1);
    assert.equal(claude.measured.claim_vs_verified_divergence, 0.5);
    assert.equal(claude.measured.n_reviewed, 2);
    assert.equal(claude.measured.acceptance_rate, 0.5);
    assert.equal(claude.measured.revision_rate, 0.5);
  });

  it('combines data across multiple runs', () => {
    const root = makeStateRoot();
    writeUsageLog(root, [
      { time: '2024-01-01T00:00:00Z', vendor: 'claude', cost_usd: 0.1, tokens_out: 10 },
      { time: '2024-01-02T00:00:00Z', vendor: 'claude', cost_usd: 0.2, tokens_out: 20 },
    ]);
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: false },
    ]);
    writeLedger(root, '0018', [
      { event: 'task_started', task_id: 't2', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't2', divergence: true },
    ]);

    aggregateUsage({ stateRoot: root });
    const claude = readProfile(root, 'claude');
    assert.equal(claude.measured.n_dispatch, 2);
    assert.equal(claude.measured.n_promoted, 2);
    assert.equal(claude.measured.divergent, 1);
  });

  it('skips runs with missing or malformed ledgers', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);
    mkdirSync(join(root, 'runs', 'run-0018', 'authoritative', 'ledger'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'runs', 'run-0018', 'authoritative', 'ledger', 'events.jsonl'),
      'bad json\n',
      'utf8',
    );

    aggregateUsage({ stateRoot: root });
    const claude = readProfile(root, 'claude');
    assert.equal(claude.measured.n_promoted, 1);
  });

  it('excludes the unknown vendor from output files', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);

    const profiles = aggregateUsage({ stateRoot: root });
    assert.equal(profiles.length, 0);
    assert.equal(
      existsSync(join(root, 'agents', 'profiles', 'unknown.measured.json')),
      false,
    );
  });

  it('preserves an existing measured file for a vendor no longer seen', () => {
    const root = makeStateRoot();
    const profDir = join(root, 'agents', 'profiles');
    mkdirSync(profDir, { recursive: true });
    writeFileSync(
      join(profDir, 'stale.measured.json'),
      JSON.stringify({ vendor: 'stale', evidence_class: 'measured' }) + '\n',
      'utf8',
    );

    writeUsageLog(root, [
      { time: '2024-01-01T00:00:00Z', vendor: 'claude', cost_usd: 0.1, tokens_out: 10 },
    ]);

    aggregateUsage({ stateRoot: root });
    assert.ok(existsSync(join(profDir, 'stale.measured.json')));
    assert.ok(existsSync(join(profDir, 'claude.measured.json')));
  });
});

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

describe('CLI', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('pretty-prints measured profiles and writes the output files', () => {
    const root = makeStateRoot();
    writeUsageLog(root, [
      { time: '2024-01-01T00:00:00Z', vendor: 'claude', cost_usd: 0.1, tokens_out: 10 },
    ]);

    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'aggregate-usage.ts'),
      ],
      { encoding: 'utf8', env: { ...process.env, HYDRA_STATE_ROOT: root } },
    );

    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.vendor, 'claude');
    assert.equal(parsed.m.n_dispatch, 1);
    assert.ok(existsSync(join(root, 'agents', 'profiles', 'claude.measured.json')));
  });

  it('reports die errors without a stack trace', () => {
    // Running from a non-git directory without HYDRA_STATE_ROOT forces
    // repoRoot() to fail before any state mutation.
    const env = { ...process.env };
    delete env.HYDRA_STATE_ROOT;

    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'aggregate-usage.ts'),
      ],
      { encoding: 'utf8', env, cwd: '/tmp' },
    );

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'hydra: error: not inside a git repository\n');
  });
});
