import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  aggregateScorecard,
  discoverRunIds,
  extractDivergenceRecords,
  isDivergenceTrue,
  measureDivergence,
  readLedger,
  scorecardPath,
  writeScorecard,
  type Scorecard,
  type VendorScore,
} from '../src/measure-divergence.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-measure-divergence');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeStateRoot(): string {
  const root = join(TEST_TMP, `state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeLedger(root: string, runId: string, lines: Record<string, unknown>[]): void {
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

function readScorecard(root: string): Scorecard {
  return JSON.parse(readFileSync(scorecardPath(root), 'utf8')) as Scorecard;
}

describe('isDivergenceTrue', () => {
  it('treats boolean true and string "true" as divergent', () => {
    assert.equal(isDivergenceTrue(true), true);
    assert.equal(isDivergenceTrue('true'), true);
  });

  it('treats everything else as not divergent', () => {
    assert.equal(isDivergenceTrue(false), false);
    assert.equal(isDivergenceTrue('false'), false);
    assert.equal(isDivergenceTrue(undefined), false);
    assert.equal(isDivergenceTrue(null), false);
    assert.equal(isDivergenceTrue(''), false);
    assert.equal(isDivergenceTrue(1), false);
  });
});

describe('readLedger', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('parses newline-delimited JSON objects', () => {
    const root = makeStateRoot();
    writeLedger(root, '0001', [{ event: 'task_started', task_id: 't1', vendor: 'claude' }]);
    const events = readLedger(join(root, 'runs', 'run-0001', 'authoritative', 'ledger', 'events.jsonl'));
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'task_started');
  });

  it('ignores blank lines', () => {
    const root = makeStateRoot();
    writeLedger(root, '0002', []);
    const ledgerFile = join(root, 'runs', 'run-0002', 'authoritative', 'ledger', 'events.jsonl');
    writeFileSync(ledgerFile, '\n\n', 'utf8');
    const events = readLedger(ledgerFile);
    assert.equal(events.length, 0);
  });

  it('skips the whole ledger when any JSON line is malformed', () => {
    const root = makeStateRoot();
    writeLedger(root, '0003', []);
    const ledgerFile = join(root, 'runs', 'run-0003', 'authoritative', 'ledger', 'events.jsonl');
    writeFileSync(
      ledgerFile,
      '{"event":"task_started","task_id":"t1","vendor":"claude"}\n{bad json\n',
      'utf8',
    );
    assert.deepEqual(readLedger(ledgerFile), []);
  });

  it('parses CRLF-delimited JSON', () => {
    const root = makeStateRoot();
    writeLedger(root, '0004', []);
    const ledgerFile = join(root, 'runs', 'run-0004', 'authoritative', 'ledger', 'events.jsonl');
    writeFileSync(
      ledgerFile,
      '{"event":"task_started","task_id":"t1","vendor":"claude"}\r\n' +
        '{"event":"result_promoted","task_id":"t1","divergence":true}\r\n',
      'utf8',
    );
    assert.equal(readLedger(ledgerFile).length, 2);
  });
});

describe('extractDivergenceRecords', () => {
  it('joins result_promoted events with their task_started vendor', () => {
    const records = extractDivergenceRecords([
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
      { event: 'task_started', task_id: 't2', vendor: 'codex' },
      { event: 'result_promoted', task_id: 't2', divergence: 'false' },
    ]);
    assert.deepEqual(records, [
      { vendor: 'claude', divergence: true },
      { vendor: 'codex', divergence: false },
    ]);
  });

  it('falls back to unknown vendor when task_started is missing', () => {
    const records = extractDivergenceRecords([
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);
    assert.deepEqual(records, [{ vendor: 'unknown', divergence: true }]);
  });

  it('does not emit a result_promoted event without a task_id', () => {
    const records = extractDivergenceRecords([
      { event: 'result_promoted', divergence: true },
    ]);
    assert.deepEqual(records, []);
  });

  it('treats a false task_started vendor as unknown', () => {
    const records = extractDivergenceRecords([
      { event: 'task_started', task_id: 't1', vendor: false },
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);
    assert.deepEqual(records, [{ vendor: 'unknown', divergence: true }]);
  });

  it('handles string "true" divergence', () => {
    const records = extractDivergenceRecords([
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: 'true' },
    ]);
    assert.deepEqual(records, [{ vendor: 'claude', divergence: true }]);
  });
});

describe('aggregateScorecard', () => {
  it('groups records by vendor and computes divergence ratio', () => {
    const scorecard = aggregateScorecard([
      { vendor: 'claude', divergence: true },
      { vendor: 'claude', divergence: false },
      { vendor: 'claude', divergence: true },
      { vendor: 'codex', divergence: false },
    ]);
    assert.deepEqual(scorecard.claude, { n: 3, divergent: 2, claim_vs_verified_divergence: 2 / 3 });
    assert.deepEqual(scorecard.codex, { n: 1, divergent: 0, claim_vs_verified_divergence: 0 });
  });

  it('returns an empty object when there are no records', () => {
    assert.deepEqual(aggregateScorecard([]), {});
  });
});

describe('discoverRunIds', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('lists run-* directories sorted', () => {
    const root = makeStateRoot();
    mkdirSync(join(root, 'runs', 'run-0002'), { recursive: true });
    mkdirSync(join(root, 'runs', 'run-0010'), { recursive: true });
    mkdirSync(join(root, 'runs', 'run-0001'), { recursive: true });
    assert.deepEqual(discoverRunIds(root), ['0001', '0002', '0010']);
  });
});

describe('measureDivergence', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('throws when no runs exist', () => {
    const root = makeStateRoot();
    assert.throws(() => measureDivergence(undefined, { stateRoot: root }), /no runs found/);
  });

  it('aggregates divergence across a single run', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
      { event: 'task_started', task_id: 't2', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't2', divergence: false },
      { event: 'task_started', task_id: 't3', vendor: 'codex' },
      { event: 'result_promoted', task_id: 't3', divergence: true },
    ]);

    const scorecard = measureDivergence(undefined, { stateRoot: root });
    assert.equal(scorecard.evidence_class, 'measured');
    assert.match(scorecard.measured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(scorecard.per_vendor.claude, { n: 2, divergent: 1, claim_vs_verified_divergence: 0.5 });
    assert.deepEqual(scorecard.per_vendor.codex, { n: 1, divergent: 1, claim_vs_verified_divergence: 1 });
  });

  it('combines records across multiple runs', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);
    writeLedger(root, '0018', [
      { event: 'task_started', task_id: 't2', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't2', divergence: false },
    ]);

    const scorecard = measureDivergence(undefined, { stateRoot: root });
    assert.deepEqual(scorecard.per_vendor.claude, { n: 2, divergent: 1, claim_vs_verified_divergence: 0.5 });
  });

  it('limits aggregation to the requested run IDs', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);
    writeLedger(root, '0018', [
      { event: 'task_started', task_id: 't2', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't2', divergence: false },
    ]);

    const scorecard = measureDivergence(['0018'], { stateRoot: root });
    assert.deepEqual(scorecard.per_vendor.claude, { n: 1, divergent: 0, claim_vs_verified_divergence: 0 });
  });

  it('skips runs with no ledger', () => {
    const root = makeStateRoot();
    mkdirSync(join(root, 'runs', 'run-0017', 'authoritative', 'ledger'), { recursive: true });
    writeLedger(root, '0018', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: false },
    ]);

    const scorecard = measureDivergence(undefined, { stateRoot: root });
    assert.deepEqual(scorecard.per_vendor.claude, { n: 1, divergent: 0, claim_vs_verified_divergence: 0 });
  });

  it('returns an empty per_vendor map when no result_promoted events exist', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
    ]);

    const scorecard = measureDivergence(undefined, { stateRoot: root });
    assert.deepEqual(scorecard.per_vendor, {});
  });
});

describe('writeScorecard', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('writes the scorecard JSON to agents/divergence-scorecard.json', () => {
    const root = makeStateRoot();
    const scorecard: Scorecard = {
      measured_at: '2024-01-01T00:00:00Z',
      evidence_class: 'measured',
      per_vendor: {
        claude: { n: 1, divergent: 0, claim_vs_verified_divergence: 0 },
      },
    };
    writeScorecard(scorecard, { stateRoot: root });
    const written = readScorecard(root);
    assert.deepEqual(written, scorecard);
    assert.equal(
      readFileSync(scorecardPath(root), 'utf8'),
      `${JSON.stringify(scorecard, null, 2)}\n`,
    );
  });
});

describe('CLI', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('pretty-prints the same scorecard to stdout and the output file', () => {
    const root = makeStateRoot();
    writeLedger(root, '0017', [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { event: 'result_promoted', task_id: 't1', divergence: true },
    ]);

    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'measure-divergence.ts'),
      ],
      { encoding: 'utf8', env: { ...process.env, HYDRA_STATE_ROOT: root } },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, readFileSync(scorecardPath(root), 'utf8'));
    assert.match(result.stdout, /\n  "measured_at":/);
    assert.deepEqual(JSON.parse(result.stdout), readScorecard(root));
  });

  it('reports die errors without a stack trace', () => {
    const root = makeStateRoot();
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'measure-divergence.ts'),
      ],
      { encoding: 'utf8', env: { ...process.env, HYDRA_STATE_ROOT: root } },
    );

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `hydra: error: no runs found under ${join(root, 'runs')}\n`);
  });
});
