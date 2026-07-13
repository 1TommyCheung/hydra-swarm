import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { RecordReviewError, recordReview } from '../src/record-review.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-record-review');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeStateRoot(): string {
  return join(TEST_TMP, `state-${uniqueName('root')}`);
}

function createRun(stateRoot: string, runId: string): void {
  const dir = join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'reviews');
  mkdirSync(dir, { recursive: true });
}

function writeVerdict(content: Record<string, unknown>): string {
  const p = join(TEST_TMP, `${uniqueName('verdict')}.json`);
  writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function ledgerPath(stateRoot: string, runId: string): string {
  return join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
}

function reviewPath(stateRoot: string, runId: string, taskId: string): string {
  return join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'reviews', `${taskId}.json`);
}

function captureStdout<T>(fn: () => T): { output: string; result: T } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = fn();
    return { output: chunks.join(''), result };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe('recordReview', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  const validVerdict = {
    task_id: 'task-a',
    verdict: 'accept',
    reviewed_base: 'abc123',
    reviewed_head: 'def456',
    reviewer: 'claude',
    risk: 'low',
  };

  it('throws when required arguments are missing', () => {
    assert.throws(() => recordReview('', 'task', '/tmp/v.json'), /usage: recordReview/);
    assert.throws(() => recordReview('run', '', '/tmp/v.json'), /usage: recordReview/);
    assert.throws(() => recordReview('run', 'task', ''), /usage: recordReview/);
  });

  it('throws when the verdict file is missing', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-missing');
    assert.throws(
      () => recordReview('run-missing', 'task', join(TEST_TMP, 'no-such.json'), { stateRoot }),
      /verdict file not found/,
    );
  });

  it('records a valid verdict and emits a review_verdict ledger event', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-ok');
    const verdictPath = writeVerdict(validVerdict);

    const { output, result } = captureStdout(() =>
      recordReview('run-ok', 'task-a', verdictPath, { stateRoot }),
    );

    const expectedPath = reviewPath(stateRoot, 'run-ok', 'task-a');
    assert.equal(result, expectedPath);
    assert.equal(existsSync(result), true);
    assert.equal(output, `${expectedPath}\n`);
    assert.deepEqual(JSON.parse(readFileSync(result, 'utf8')), validVerdict);

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-ok'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'review_verdict');
    assert.equal(ledger[0].run_id, 'run-ok');
    assert.equal(ledger[0].task_id, 'task-a');
    assert.equal(ledger[0].verdict, 'accept');
    assert.equal(ledger[0].reviewer, 'claude');
    assert.equal(ledger[0].risk, 'low');
    assert.match(String(ledger[0].time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('defaults reviewer and risk to unknown when the schema permits absence', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-defaults');
    const schemaPath = join(TEST_TMP, 'defaults-review.schema.json');
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: 'object',
        required: ['task_id', 'verdict', 'reviewed_base', 'reviewed_head'],
        properties: {
          task_id: { type: 'string' },
          verdict: { type: 'string' },
          reviewed_base: { type: 'string' },
          reviewed_head: { type: 'string' },
          reviewer: { type: 'string' },
          risk: { type: 'string' },
        },
      }),
      'utf8',
    );
    const verdictPath = writeVerdict({
      task_id: 'task-b',
      verdict: 'revise',
      reviewed_base: 'abc123',
      reviewed_head: 'def456',
    });

    recordReview('run-defaults', 'task-b', verdictPath, { stateRoot, schemaPath });

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-defaults'));
    assert.equal(ledger[0].reviewer, 'unknown');
    assert.equal(ledger[0].risk, 'unknown');
  });

  it('rejects a verdict that fails schema validation and emits review_rejected', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-bad');
    const verdictPath = writeVerdict({
      task_id: 'task-c',
      verdict: 'accept',
      // missing reviewed_base, reviewed_head, reviewer, risk
    });

    assert.throws(
      () => recordReview('run-bad', 'task-c', verdictPath, { stateRoot }),
      (error: unknown) =>
        error instanceof RecordReviewError &&
        error.exitCode === 5 &&
        /review verdict rejected \(schema\)/.test(error.message),
    );

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-bad'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'review_rejected');
    assert.equal(ledger[0].task_id, 'task-c');
    assert.equal(ledger[0].reason, 'schema_invalid');
    assert.match(String(ledger[0].detail), /missing required property/);
  });

  it('rejects a verdict with an invalid enum value', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-enum');
    const verdictPath = writeVerdict({
      ...validVerdict,
      task_id: 'task-d',
      verdict: 'maybe',
      risk: 'extreme',
    });

    assert.throws(
      () => recordReview('run-enum', 'task-d', verdictPath, { stateRoot }),
      /review verdict rejected \(schema\)/,
    );

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-enum'));
    assert.equal(ledger[0].event, 'review_rejected');
    assert.equal(ledger[0].reason, 'schema_invalid');
  });

  it('truncates schema error detail to the first two errors', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-truncate');
    const verdictPath = writeVerdict({
      task_id: 'task-e',
      verdict: 'maybe',
      risk: 'extreme',
      // missing reviewed_base and reviewed_head too
    });

    assert.throws(() => recordReview('run-truncate', 'task-e', verdictPath, { stateRoot }));

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-truncate'));
    const detail = String(ledger[0].detail);
    const semicolons = detail.match(/;/g) ?? [];
    assert.ok(semicolons.length <= 1, 'detail should contain at most one separator');
  });

  it('honours the stateRoot option', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'opt');
    const verdictPath = writeVerdict(validVerdict);

    const { result } = captureStdout(() =>
      recordReview('opt', 'task-opt', verdictPath, { stateRoot }),
    );

    assert.equal(result, reviewPath(stateRoot, 'opt', 'task-opt'));
    assert.equal(existsSync(result), true);
  });

  it('keeps independently scheduled stateRoot calls isolated', async () => {
    const firstRoot = makeStateRoot();
    const secondRoot = makeStateRoot();
    createRun(firstRoot, 'concurrent-a');
    createRun(secondRoot, 'concurrent-b');
    const firstVerdict = writeVerdict({ ...validVerdict, task_id: 'task-concurrent-a' });
    const secondVerdict = writeVerdict({ ...validVerdict, task_id: 'task-concurrent-b' });
    const originalStateRoot = process.env.HYDRA_STATE_ROOT;
    const sentinelRoot = makeStateRoot();
    process.env.HYDRA_STATE_ROOT = sentinelRoot;

    try {
      const result = await Promise.all([
        new Promise<string>((resolve) =>
          setImmediate(() =>
            resolve(
              recordReview('concurrent-a', 'task-concurrent-a', firstVerdict, {
                stateRoot: firstRoot,
              }),
            ),
          ),
        ),
        new Promise<string>((resolve) =>
          setImmediate(() =>
            resolve(
              recordReview('concurrent-b', 'task-concurrent-b', secondVerdict, {
                stateRoot: secondRoot,
              }),
            ),
          ),
        ),
      ]);

      assert.deepEqual(result, [
        reviewPath(firstRoot, 'concurrent-a', 'task-concurrent-a'),
        reviewPath(secondRoot, 'concurrent-b', 'task-concurrent-b'),
      ]);
      assert.equal(
        readJsonl(ledgerPath(firstRoot, 'concurrent-a'))[0].task_id,
        'task-concurrent-a',
      );
      assert.equal(
        readJsonl(ledgerPath(secondRoot, 'concurrent-b'))[0].task_id,
        'task-concurrent-b',
      );
      assert.equal(process.env.HYDRA_STATE_ROOT, sentinelRoot);
    } finally {
      if (originalStateRoot === undefined) delete process.env.HYDRA_STATE_ROOT;
      else process.env.HYDRA_STATE_ROOT = originalStateRoot;
    }
  });

  it('honours the schemaPath option', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-schema');
    const schemaPath = join(TEST_TMP, 'custom-review.schema.json');
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: 'object',
        required: ['task_id', 'verdict'],
        properties: {
          task_id: { type: 'string' },
          verdict: { type: 'string' },
        },
      }),
      'utf8',
    );
    const verdictPath = writeVerdict({ task_id: 'task-schema', verdict: 'accept' });

    const { result } = captureStdout(() =>
      recordReview('run-schema', 'task-schema', verdictPath, { stateRoot, schemaPath }),
    );

    assert.equal(existsSync(result), true);
  });

  it('rejects an unreadable schema with exit code 5 and emits review_rejected', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-schema-unreadable');
    const verdictPath = writeVerdict(validVerdict);
    const schemaPath = join(TEST_TMP, 'missing-review.schema.json');

    assert.throws(
      () =>
        recordReview('run-schema-unreadable', 'task-schema-unreadable', verdictPath, {
          stateRoot,
          schemaPath,
        }),
      (error: unknown) =>
        error instanceof RecordReviewError &&
        error.exitCode === 5 &&
        /cannot read\/parse schema/.test(error.message),
    );

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-schema-unreadable'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'review_rejected');
    assert.equal(ledger[0].reason, 'schema_invalid');
    assert.match(String(ledger[0].detail), /cannot read\/parse schema/);
  });

  it('copies a valid verdict byte-for-byte even with non-UTF-8 bytes', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-bytes');
    const verdictPath = join(TEST_TMP, `${uniqueName('verdict-bytes')}.json`);
    const verdictBytes = Buffer.concat([
      Buffer.from(
        '{"task_id":"task-bytes","verdict":"accept","reviewed_base":"abc123",' +
          '"reviewed_head":"def456","reviewer":"',
      ),
      Buffer.from([0xff]),
      Buffer.from('","risk":"low"}'),
    ]);
    writeFileSync(verdictPath, verdictBytes);

    const { result } = captureStdout(() =>
      recordReview('run-bytes', 'task-bytes', verdictPath, { stateRoot }),
    );

    assert.deepEqual(readFileSync(result), verdictBytes);
  });
});
