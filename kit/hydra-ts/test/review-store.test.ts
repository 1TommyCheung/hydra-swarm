import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertGitObjectId,
  canonicalJson,
  findingId,
  publishVerdict,
  reviewDirFor,
  reviewFileName,
} from '../src/review-store.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-review-store');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeRunDir(): string {
  const dir = join(TEST_TMP, uniqueName('run'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const REVIEW_STORE_PATH = join(import.meta.dirname, '..', 'src', 'review-store.ts');

function writePublishChildScript(): string {
  const childScript = join(TEST_TMP, `${uniqueName('publish-child')}.ts`);
  writeFileSync(
    childScript,
    [
      `import { publishVerdict } from ${JSON.stringify(REVIEW_STORE_PATH)};`,
      'const [runDir, taskId, head, payload] = process.argv.slice(2);',
      'if (!runDir || !taskId || !head || payload === undefined) {',
      "  throw new Error('usage: publish-child <runDir> <taskId> <head> <payload>');",
      '}',
      'const result = publishVerdict(runDir, taskId, Buffer.from(payload, "utf8"), head);',
      'process.stdout.write(JSON.stringify(result));',
      '',
    ].join('\n'),
  );
  return childScript;
}

function runPublishChild(
  childScript: string,
  runDir: string,
  taskId: string,
  head: string,
  payload: string,
): Promise<{ seq: number; path: string }> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', childScript, runDir, taskId, head, payload],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', rejectChild);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectChild(new Error(`child exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolveChild(JSON.parse(stdout) as { seq: number; path: string });
      } catch (error) {
        rejectChild(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

describe('review-store', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => rmSync(TEST_TMP, { recursive: true, force: true }));

  describe('assertGitObjectId', () => {
    it('returns a lowercased 40-char hex id unchanged in case', () => {
      assert.equal(assertGitObjectId(HEAD_A.toUpperCase(), 'label'), HEAD_A);
      assert.equal(assertGitObjectId(HEAD_A, 'label'), HEAD_A);
    });

    it('rejects the empty string', () => {
      assert.throws(() => assertGitObjectId('', 'reviewed_head'), /reviewed_head/);
    });

    it('rejects a slash-shaped value', () => {
      assert.throws(() => assertGitObjectId('abc/def', 'reviewed_head'), /reviewed_head/);
    });

    it('rejects a path-traversal-shaped value', () => {
      assert.throws(() => assertGitObjectId('../escape', 'reviewed_head'), /reviewed_head/);
    });

    it('rejects non-hex characters', () => {
      assert.throws(() => assertGitObjectId('g'.repeat(40), 'reviewed_head'), /reviewed_head/);
    });

    it('rejects a value that is not exactly 40 characters', () => {
      assert.throws(() => assertGitObjectId('a'.repeat(39), 'reviewed_head'), /reviewed_head/);
      assert.throws(() => assertGitObjectId('a'.repeat(41), 'reviewed_head'), /reviewed_head/);
    });

    it('includes the label in the error message', () => {
      assert.throws(() => assertGitObjectId('bad', 'my_field_label'), /my_field_label/);
    });
  });

  describe('reviewDirFor', () => {
    it('joins runDirPath, authoritative/reviews and taskId', () => {
      assert.equal(
        reviewDirFor('/state/runs/run-1', 'task-a'),
        '/state/runs/run-1/authoritative/reviews/task-a',
      );
    });

    it('rejects a path-traversal task id and names the offending value', () => {
      assert.throws(
        () => reviewDirFor('/state/run-0057', '../../../../tmp/pwned'),
        (error: unknown) =>
          error instanceof Error && error.message.includes('../../../../tmp/pwned'),
      );
    });

    it('rejects dots, slashes, underscores, uppercase, spaces and boundary hyphens', () => {
      const badIds = ['.', '..', '', 'a/b', 'a\\b', 'Task-A', 'task_a', 'a b', '-task', 'task-'];
      for (const bad of badIds) {
        assert.throws(
          () => reviewDirFor('/state/run-0057', bad),
          /taskId/,
          `expected ${JSON.stringify(bad)} to be rejected`,
        );
      }
    });

    it('rejects an over-long task id', () => {
      assert.throws(() => reviewDirFor('/state/run-0057', 'a'.repeat(65)), /taskId/);
      assert.equal(
        reviewDirFor('/state/run-0057', 'a'.repeat(64)),
        `/state/run-0057/authoritative/reviews/${'a'.repeat(64)}`,
      );
    });

    it('accepts canonical lowercase-hyphen task ids', () => {
      for (const good of ['a', 'task-a', 'review-store-append-only', 'a1-b2']) {
        assert.equal(
          reviewDirFor('/state/run-0057', good),
          `/state/run-0057/authoritative/reviews/${good}`,
        );
      }
    });
  });

  describe('reviewFileName', () => {
    it('zero-pads seq to 4 digits and lowercases the head', () => {
      assert.equal(reviewFileName(1, HEAD_A.toUpperCase()), `0001-${HEAD_A}.json`);
      assert.equal(reviewFileName(23, HEAD_A), `0023-${HEAD_A}.json`);
      assert.equal(reviewFileName(10000, HEAD_A), `10000-${HEAD_A}.json`);
    });

    it('rejects an invalid reviewed head before building the name', () => {
      assert.throws(() => reviewFileName(1, '../escape'), /reviewedHead/);
    });
  });

  describe('canonicalJson', () => {
    it('sorts object keys recursively regardless of insertion order', () => {
      const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
      const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
      assert.equal(a, b);
      assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
    });

    it('preserves array order', () => {
      assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
    });

    it('treats an own __proto__ key as data instead of mutating a prototype', () => {
      const parsed = JSON.parse('{"__proto__":1,"a":2}') as Record<string, unknown>;
      assert.equal(canonicalJson(parsed), '{"__proto__":1,"a":2}');
      assert.notEqual(
        canonicalJson(parsed),
        canonicalJson({ a: 2 }),
        'an own __proto__ key must change the serialization',
      );
    });

    it('rejects values that are not JSON values instead of collapsing them', () => {
      assert.throws(() => canonicalJson(undefined), /not a JSON value/);
      assert.throws(() => canonicalJson(() => 1), /not a JSON value/);
      assert.throws(() => canonicalJson(Symbol('s')), /not a JSON value/);
      assert.throws(() => canonicalJson(Number.NaN), /not a JSON value/);
      assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /not a JSON value/);
      assert.throws(() => canonicalJson({ nested: undefined }), /not a JSON value/);
      assert.throws(() => canonicalJson([Number.NaN]), /not a JSON value/);
    });
  });

  describe('findingId', () => {
    it('is deterministic for identical inputs', () => {
      const id1 = findingId('ref-1', 'blocking_findings', 0, 'missing test');
      const id2 = findingId('ref-1', 'blocking_findings', 0, 'missing test');
      assert.equal(id1, id2);
    });

    it('differs when the ref differs for byte-identical findings', () => {
      const id1 = findingId('ref-1', 'blocking_findings', 0, 'missing test');
      const id2 = findingId('ref-2', 'blocking_findings', 0, 'missing test');
      assert.notEqual(id1, id2);
    });

    it('differs when the field differs', () => {
      const id1 = findingId('ref-1', 'blocking_findings', 0, 'missing test');
      const id2 = findingId('ref-1', 'non_blocking_findings', 0, 'missing test');
      assert.notEqual(id1, id2);
    });

    it('differs when the index differs', () => {
      const id1 = findingId('ref-1', 'blocking_findings', 0, 'missing test');
      const id2 = findingId('ref-1', 'blocking_findings', 1, 'missing test');
      assert.notEqual(id1, id2);
    });

    it('handles object findings as well as string findings', () => {
      const id1 = findingId('ref-1', 'blocking_findings', 0, { file: 'a.ts', line: 1 });
      const id2 = findingId('ref-1', 'blocking_findings', 0, { line: 1, file: 'a.ts' });
      assert.equal(id1, id2, 'object key order must not affect the id');
    });

    it('produces a sha256 hex digest', () => {
      const id = findingId('ref-1', 'blocking_findings', 0, 'x');
      assert.match(id, /^[0-9a-f]{64}$/);
    });
  });

  describe('publishVerdict', () => {
    it('writes seq 0001 with the reviewed head embedded in the filename', () => {
      const runDir = makeRunDir();
      const bytes = Buffer.from(JSON.stringify({ task_id: 'task-a', verdict: 'accept' }));

      const result = publishVerdict(runDir, 'task-a', bytes, HEAD_A);

      assert.equal(result.seq, 1);
      assert.equal(result.path, join(reviewDirFor(runDir, 'task-a'), `0001-${HEAD_A}.json`));
      assert.equal(existsSync(result.path), true);
      assert.deepEqual(readFileSync(result.path), bytes);
      assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    });

    it('does not overwrite an earlier verdict on a second publish for the same task', () => {
      const runDir = makeRunDir();
      const first = Buffer.from(JSON.stringify({ task_id: 'task-b', verdict: 'revise', round: 1 }));
      const second = Buffer.from(JSON.stringify({ task_id: 'task-b', verdict: 'accept', round: 2 }));

      const r1 = publishVerdict(runDir, 'task-b', first, HEAD_A);
      const r2 = publishVerdict(runDir, 'task-b', second, HEAD_B);

      assert.equal(r1.seq, 1);
      assert.equal(r2.seq, 2);
      assert.notEqual(r1.path, r2.path);
      assert.equal(existsSync(r1.path), true);
      assert.equal(existsSync(r2.path), true);
      assert.deepEqual(readFileSync(r1.path), first);
      assert.deepEqual(readFileSync(r2.path), second);

      const dir = reviewDirFor(runDir, 'task-b');
      const published = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
      assert.deepEqual(published, [`0001-${HEAD_A}.json`, `0002-${HEAD_B}.json`]);
    });

    it('rejects a non-40-hex reviewed_head before touching the filesystem', () => {
      const runDir = makeRunDir();
      const bytes = Buffer.from('{}');

      assert.throws(() => publishVerdict(runDir, 'task-c', bytes, '../escape'), /reviewedHead/);
      assert.equal(existsSync(reviewDirFor(runDir, 'task-c')), false);
    });

    it('releases the lock so a subsequent publish is not blocked', () => {
      const runDir = makeRunDir();
      const bytes = Buffer.from('{}');

      publishVerdict(runDir, 'task-d', bytes, HEAD_A);
      publishVerdict(runDir, 'task-d', bytes, HEAD_B);

      const dir = reviewDirFor(runDir, 'task-d');
      assert.equal(existsSync(join(dir, '.publish.lock')), false);
    });

    it('keeps independent tasks on independent sequence counters', () => {
      const runDir = makeRunDir();
      const bytes = Buffer.from('{}');

      const a = publishVerdict(runDir, 'task-e', bytes, HEAD_A);
      const b = publishVerdict(runDir, 'task-f', bytes, HEAD_A);

      assert.equal(a.seq, 1);
      assert.equal(b.seq, 1);
    });

    it('rejects a traversal-shaped taskId before touching the filesystem', () => {
      const runDir = makeRunDir();
      const bytes = Buffer.from('{}');

      assert.throws(
        () => publishVerdict(runDir, '../../../../tmp/pwned', bytes, HEAD_A),
        (error: unknown) =>
          error instanceof Error && error.message.includes('../../../../tmp/pwned'),
      );
      assert.equal(existsSync(join(runDir, 'authoritative')), false);
    });

    it('discovers sequence numbers wider than 4 digits and rejects past the safe bound', () => {
      const runDir = makeRunDir();
      const dir = reviewDirFor(runDir, 'task-overflow');
      mkdirSync(dir, { recursive: true });
      // A 5-digit sequence published by some other means: discovery must see
      // it, so the next allocation is 10001 (past the bound) — never 1 again.
      writeFileSync(join(dir, `10000-${HEAD_A}.json`), '{"round":10000}');

      assert.throws(
        () => publishVerdict(runDir, 'task-overflow', Buffer.from('{"round":10001}'), HEAD_B),
        /bound/,
      );
      // The pre-existing verdict must be untouched — no silent overwrite.
      assert.equal(readFileSync(join(dir, `10000-${HEAD_A}.json`), 'utf8'), '{"round":10000}');
      assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 1);
    });

    it('publishes at the documented bound (9999) and fails loudly on the next', () => {
      const runDir = makeRunDir();
      const dir = reviewDirFor(runDir, 'task-bound');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `9998-${HEAD_A}.json`), '{}');

      const atBound = publishVerdict(runDir, 'task-bound', Buffer.from('{}'), HEAD_B);
      assert.equal(atBound.seq, 9999);
      assert.equal(atBound.path, join(dir, `9999-${HEAD_B}.json`));

      assert.throws(
        () => publishVerdict(runDir, 'task-bound', Buffer.from('{}'), HEAD_B),
        /bound/,
      );
    });

    it('reclaims a stale lock left behind by a killed publisher (fault injection)', () => {
      const runDir = makeRunDir();
      const dir = reviewDirFor(runDir, 'task-stale-lock');
      mkdirSync(dir, { recursive: true });
      // Simulate a crash after lock acquisition: the lock is far older than
      // the stale threshold, so a later publisher must reclaim it. Staleness
      // is judged by AGE — a recorded pid cannot distinguish PID reuse.
      writeFileSync(
        join(dir, '.publish.lock'),
        JSON.stringify({ pid: 99999999, token: 'crashed-owner', acquired: Date.now() - 120_000 }),
        { flag: 'wx' },
      );

      const result = publishVerdict(runDir, 'task-stale-lock', Buffer.from('{"ok":true}'), HEAD_A);

      assert.equal(result.seq, 1);
      assert.equal(existsSync(result.path), true);
      assert.equal(readFileSync(result.path, 'utf8'), '{"ok":true}');
      assert.equal(existsSync(join(dir, '.publish.lock')), false, 'recovered lock must be released');
    });

    it('reclaims an old lock even when its recorded pid is alive (recycled pid)', () => {
      const runDir = makeRunDir();
      const dir = reviewDirFor(runDir, 'task-recycled-pid');
      mkdirSync(dir, { recursive: true });
      // The recorded pid belongs to a LIVE process (this one) — exactly what
      // a recycled pid looks like. A pid-liveness check would call this lock
      // owned and time out every future publish forever; reclamation must
      // trust the lock's AGE, not the liveness of its recorded pid.
      writeFileSync(
        join(dir, '.publish.lock'),
        JSON.stringify({ pid: process.pid, token: 'recycled-pid-owner', acquired: Date.now() - 120_000 }),
        { flag: 'wx' },
      );

      const result = publishVerdict(runDir, 'task-recycled-pid', Buffer.from('{"ok":true}'), HEAD_A);

      assert.equal(result.seq, 1);
      assert.equal(readFileSync(result.path, 'utf8'), '{"ok":true}');
      const entries = readdirSync(dir);
      assert.deepEqual(
        entries.filter((n) => n === '.publish.lock' || n.includes('.reclaim-')),
        [],
        'the reclaimed stale lock and any claim copy must be gone',
      );
    });

    it('never reclaims or deletes a young lock — publishes wait, then fail loudly', { timeout: 15000 }, () => {
      const runDir = makeRunDir();
      const dir = reviewDirFor(runDir, 'task-live-lock');
      mkdirSync(dir, { recursive: true });
      // A YOUNG lock: its owner acquired it a moment ago and is still inside
      // its critical section. Even a dead recorded pid must not make this
      // reclaimable — only age can, and this lock is far below the threshold.
      const liveRecord = JSON.stringify({ pid: 99999999, token: 'live-owner', acquired: Date.now() });
      writeFileSync(join(dir, '.publish.lock'), liveRecord, { flag: 'wx' });

      assert.throws(
        () => publishVerdict(runDir, 'task-live-lock', Buffer.from('{}'), HEAD_A),
        /timed out/,
      );
      // The live lock must be EXACTLY as its owner left it — not reclaimed,
      // not deleted, not displaced — and nothing may have been published.
      assert.equal(readFileSync(join(dir, '.publish.lock'), 'utf8'), liveRecord);
      assert.equal(readdirSync(dir).filter((n) => n.endsWith('.json')).length, 0);
    });

    it('admits exactly one reclaimer when many publishers race the same stale lock', async () => {
      const runDir = makeRunDir();
      const dir = reviewDirFor(runDir, 'task-stale-race');
      mkdirSync(dir, { recursive: true });
      // A provably-stale crash leftover. Every child observes the SAME dead
      // lock and attempts reclamation at once. With pathname-based unlink
      // reclamation, two waiters can both judge it stale and both unlink —
      // the second unlink deletes the FIRST reclaimer's freshly acquired
      // lock, admitting two publishers into the critical section and losing
      // verdicts. Reclamation is therefore atomic with respect to the lock
      // identity (rename-to-claim + re-verify), so exactly one claimant wins;
      // and because POSIX offers no conditional unlink, seq allocation is
      // additionally fenced by atomic claim markers, so no two publishers can
      // ever take the same seq even in the irreducible residual corner.
      writeFileSync(
        join(dir, '.publish.lock'),
        JSON.stringify({ pid: 99999999, token: 'dead-owner', acquired: Date.now() - 120_000 }),
        { flag: 'wx' },
      );

      const childScript = writePublishChildScript();
      const heads = ['a', 'b', 'c', 'd', 'e', 'f'].map((ch) => ch.repeat(40));
      const payloads = heads.map((_, i) => `verdict-from-reclaimer-${i}`);
      const results = await Promise.all(
        heads.map((head, i) => runPublishChild(childScript, runDir, 'task-stale-race', head, payloads[i])),
      );

      assert.deepEqual(
        results.map((r) => r.seq).sort((x, y) => x - y),
        [1, 2, 3, 4, 5, 6],
        'every publish must receive a distinct seq — no verdict lost, none duplicated',
      );
      for (let i = 0; i < heads.length; i += 1) {
        assert.equal(readFileSync(results[i].path, 'utf8'), payloads[i]);
      }
      const entries = readdirSync(dir);
      assert.equal(entries.filter((n) => n.endsWith('.json')).length, 6, 'no verdict may be lost');
      assert.deepEqual(
        entries.filter((n) => n === '.publish.lock' || n.includes('.reclaim-') || n.includes('.tmp-')),
        [],
        'no lock, reclaim-claim or temp junk may be left behind',
      );
    });

    it('leaves no temp files behind after publishing', () => {
      const runDir = makeRunDir();
      publishVerdict(runDir, 'task-tidy', Buffer.from('{}'), HEAD_A);
      publishVerdict(runDir, 'task-tidy', Buffer.from('{}'), HEAD_B);

      const entries = readdirSync(reviewDirFor(runDir, 'task-tidy'));
      assert.deepEqual(entries.filter((n) => n.includes('.tmp')), []);
    });

    it('two child processes publishing to the same task get distinct seqs and lose no verdict', async () => {
      const runDir = makeRunDir();
      const childScript = writePublishChildScript();

      const [first, second] = await Promise.all([
        runPublishChild(childScript, runDir, 'task-race', HEAD_A, 'verdict-from-child-1'),
        runPublishChild(childScript, runDir, 'task-race', HEAD_B, 'verdict-from-child-2'),
      ]);

      assert.deepEqual([first.seq, second.seq].sort((a, b) => a - b), [1, 2]);
      assert.notEqual(first.path, second.path);
      assert.equal(readFileSync(first.path, 'utf8'), 'verdict-from-child-1');
      assert.equal(readFileSync(second.path, 'utf8'), 'verdict-from-child-2');
      const published = readdirSync(reviewDirFor(runDir, 'task-race'))
        .filter((n) => n.endsWith('.json'));
      assert.equal(published.length, 2, 'no verdict may be lost');
    });

    // Fault injection covers every stage of the temp-file lifecycle: a
    // failure at ANY point must fail loudly with the PRIMARY error, leak no
    // temp file into the reviews directory, release the lock, and never
    // unpublish a verdict that was already linked (append-only).
    describe('temp-file fault injection', () => {
      const FAULT_STAGES = ['open', 'write', 'fsync-file', 'link', 'unlink-tmp', 'dir-fsync'] as const;
      // Stages at which the verdict has already been linked into place before
      // the failure: it must REMAIN published.
      const LINKED_STAGES: ReadonlySet<string> = new Set(['unlink-tmp', 'dir-fsync']);

      for (const stage of FAULT_STAGES) {
        it(`fails loudly and leaks no temp file when ${stage} fails`, () => {
          const runDir = makeRunDir();
          const taskId = `task-fault-${stage}`;
          const bytes = Buffer.from(JSON.stringify({ stage }));

          process.env.HYDRA_REVIEW_STORE_FAULT = stage;
          try {
            assert.throws(
              () => publishVerdict(runDir, taskId, bytes, HEAD_A),
              /injected fault/,
            );
          } finally {
            delete process.env.HYDRA_REVIEW_STORE_FAULT;
          }

          const dir = reviewDirFor(runDir, taskId);
          const entries = readdirSync(dir);
          assert.deepEqual(
            entries.filter((n) => n.includes('.tmp-')),
            [],
            `temp file must not leak when ${stage} fails`,
          );
          assert.equal(existsSync(join(dir, '.publish.lock')), false, 'lock must be released');

          const verdictName = `0001-${HEAD_A}.json`;
          if (LINKED_STAGES.has(stage)) {
            // The verdict was already linked before the failure: append-only
            // storage must NOT unpublish it because a later step failed.
            assert.equal(readFileSync(join(dir, verdictName), 'utf8'), bytes.toString('utf8'));
          } else {
            assert.equal(existsSync(join(dir, verdictName)), false, 'no verdict may be published');
          }

          // The store must keep working: the next publish succeeds and
          // continues the sequence (2 when the failed attempt had linked a
          // verdict, otherwise 1).
          const next = publishVerdict(runDir, taskId, Buffer.from('{}'), HEAD_B);
          assert.equal(next.seq, LINKED_STAGES.has(stage) ? 2 : 1);
        });
      }
    });
  });
});
