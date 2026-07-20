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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordReviewError, recordReview } from '../src/record-review.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-record-review');
const BASE_HEAD = 'a'.repeat(40);
const REVIEWED_HEAD = 'b'.repeat(40);

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

function reviewPath(
  stateRoot: string,
  runId: string,
  taskId: string,
  seq: number,
  reviewedHead: string,
): string {
  const paddedSeq = String(seq).padStart(4, '0');
  return join(
    stateRoot,
    'runs',
    `run-${runId}`,
    'authoritative',
    'reviews',
    taskId,
    `${paddedSeq}-${reviewedHead}.json`,
  );
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
    reviewed_base: BASE_HEAD,
    reviewed_head: REVIEWED_HEAD,
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

    const expectedPath = reviewPath(stateRoot, 'run-ok', 'task-a', 1, REVIEWED_HEAD);
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
    assert.equal(ledger[0].reviewed_head, REVIEWED_HEAD);
    assert.equal(ledger[0].seq, '1');
    assert.match(String(ledger[0].content_sha256), /^[0-9a-f]{64}$/);
    assert.match(String(ledger[0].time), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('appends a second verdict for the same task without destroying the first', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-append');
    const firstVerdictPath = writeVerdict(validVerdict);

    const first = recordReview('run-append', 'task-a', firstVerdictPath, { stateRoot });

    const secondHead = 'c'.repeat(40);
    const secondVerdictPath = writeVerdict({
      ...validVerdict,
      reviewed_head: secondHead,
      verdict: 'revise',
    });
    const second = recordReview('run-append', 'task-a', secondVerdictPath, { stateRoot });

    assert.notEqual(first, second);
    assert.equal(existsSync(first), true, 'first verdict must not be overwritten');
    assert.equal(existsSync(second), true);
    assert.equal(first, reviewPath(stateRoot, 'run-append', 'task-a', 1, REVIEWED_HEAD));
    assert.equal(second, reviewPath(stateRoot, 'run-append', 'task-a', 2, secondHead));
    assert.deepEqual(JSON.parse(readFileSync(first, 'utf8')).verdict, 'accept');
    assert.deepEqual(JSON.parse(readFileSync(second, 'utf8')).verdict, 'revise');

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-append'));
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].seq, '1');
    assert.equal(ledger[1].seq, '2');
    assert.equal(ledger[1].reviewed_head, secondHead);
  });

  it('rejects a verdict whose body task_id does not match the recording target', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-mismatch');
    const verdictPath = writeVerdict({ ...validVerdict, task_id: 'task-other' });

    assert.throws(
      () => recordReview('run-mismatch', 'task-a', verdictPath, { stateRoot }),
      (error: unknown) =>
        error instanceof RecordReviewError &&
        error.exitCode === 5 &&
        /review verdict rejected \(task_id_mismatch\)/.test(error.message),
    );

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-mismatch'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'review_rejected');
    assert.equal(ledger[0].reason, 'task_id_mismatch');
  });

  it('rejects a reviewed_head that is not 40-char hex, before any path is constructed', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-bad-head');
    const verdictPath = writeVerdict({ ...validVerdict, task_id: 'task-x', reviewed_head: '../escape' });

    assert.throws(
      () => recordReview('run-bad-head', 'task-x', verdictPath, { stateRoot }),
      (error: unknown) =>
        error instanceof RecordReviewError &&
        error.exitCode === 5 &&
        /review verdict rejected \(reviewed_head\)/.test(error.message),
    );

    const ledger = readJsonl(ledgerPath(stateRoot, 'run-bad-head'));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'review_rejected');
    assert.equal(ledger[0].reason, 'invalid_reviewed_head');
    assert.equal(
      existsSync(join(stateRoot, 'runs', 'run-run-bad-head', 'authoritative', 'reviews', 'task-x')),
      false,
    );
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
      reviewed_base: BASE_HEAD,
      reviewed_head: REVIEWED_HEAD,
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
    const verdictPath = writeVerdict({ ...validVerdict, task_id: 'task-opt' });

    const { result } = captureStdout(() =>
      recordReview('opt', 'task-opt', verdictPath, { stateRoot }),
    );

    assert.equal(result, reviewPath(stateRoot, 'opt', 'task-opt', 1, REVIEWED_HEAD));
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
        reviewPath(firstRoot, 'concurrent-a', 'task-concurrent-a', 1, REVIEWED_HEAD),
        reviewPath(secondRoot, 'concurrent-b', 'task-concurrent-b', 1, REVIEWED_HEAD),
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
    const verdictPath = writeVerdict({
      task_id: 'task-schema',
      verdict: 'accept',
      reviewed_head: REVIEWED_HEAD,
    });

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
        `{"task_id":"task-bytes","verdict":"accept","reviewed_base":"${BASE_HEAD}",` +
          `"reviewed_head":"${REVIEWED_HEAD}","reviewer":"`,
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

  it('resolves the default schema relative to the source file, not cwd', () => {
    const stateRoot = makeStateRoot();
    createRun(stateRoot, 'run-self-relative');
    const verdictPath = writeVerdict(validVerdict);

    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'record-review.ts'),
        'run-self-relative',
        'task-a',
        verdictPath,
      ],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: {
          ...process.env,
          HYDRA_STATE_ROOT: stateRoot,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const recordedPath = result.stdout.trim();
    assert.equal(existsSync(recordedPath), true);
    assert.equal(
      recordedPath,
      reviewPath(stateRoot, 'run-self-relative', 'task-a', 1, REVIEWED_HEAD),
    );
  });
});
