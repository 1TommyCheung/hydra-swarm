import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertGitObjectId, canonicalJson, findingId, publishVerdict, reviewDirFor, reviewFileName,
} from '../src/review-store.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-review-store');
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const REVIEW_STORE_PATH = resolve(import.meta.dirname, '..', 'src', 'review-store.ts');

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function makeRunDir(): string {
  const path = join(TEST_TMP, unique('run'));
  mkdirSync(path, { recursive: true });
  return path;
}

interface Hooks { dir: string; capability: string; env: Record<string, string> }
function makeHooks(tag = 'test'): Hooks {
  const dir = resolve(TEST_TMP, unique('hooks'));
  const capability = randomBytes(32).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.hydra-review-store.capability'), capability);
  return {
    dir,
    capability,
    env: {
      HYDRA_REVIEW_STORE_HOOK_DIR: dir,
      HYDRA_REVIEW_STORE_HOOK_CAPABILITY: capability,
      HYDRA_REVIEW_STORE_HOOK_TAG: tag,
    },
  };
}

function withHooks<T>(hooks: Hooks, extra: Record<string, string>, fn: () => T): T {
  const keys = [...Object.keys(hooks.env), ...Object.keys(extra)];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, hooks.env, extra);
  try { return fn(); }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function childScript(): string {
  const path = join(TEST_TMP, `${unique('child')}.ts`);
  writeFileSync(path, [
    `import { publishVerdict } from ${JSON.stringify(REVIEW_STORE_PATH)};`,
    'const [runDir, taskId, head, payload] = process.argv.slice(2);',
    'const result = publishVerdict(runDir!, taskId!, Buffer.from(payload!), head!);',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n'));
  return path;
}

interface ChildHandle {
  result: Promise<{ seq: number; path: string }>;
  exited: () => boolean;
}

function spawnChild(
  script: string, runDir: string, taskId: string, head: string, payload: string,
  env: Record<string, string> = {},
): ChildHandle {
  let didExit = false;
  const result = new Promise<{ seq: number; path: string }>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [
      '--no-warnings', '--experimental-strip-types', script, runDir, taskId, head, payload,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', rejectChild);
    child.on('close', (code) => {
      didExit = true;
      if (code !== 0) { rejectChild(new Error(`child exited ${code}: ${stderr}`)); return; }
      try { resolveChild(JSON.parse(stdout) as { seq: number; path: string }); }
      catch (err) { rejectChild(err); }
    });
  });
  return { result, exited: () => didExit };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(path: string, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}: ${path}`);
    await sleep(10);
  }
}

function lockArtifacts(dir: string): string[] {
  return readdirSync(dir).filter((name) =>
    name === '.publish.lock' || name.includes('.claimed') || name.includes('.owner-')
    || name.includes('.tmp-') || name.includes('.reclaim-'));
}

function writeOwner(claimPath: string, token: string, acquired: number): string {
  mkdirSync(claimPath, { recursive: true });
  const owner = join(claimPath, `.owner-${token}`);
  writeFileSync(owner, JSON.stringify({ pid: 99999999, token, acquired }), { flag: 'wx' });
  return owner;
}

describe('review-store', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => rmSync(TEST_TMP, { recursive: true, force: true }));

  it('normalizes valid 40-character object ids to lowercase', () => {
    assert.equal(assertGitObjectId(HEAD_A.toUpperCase(), 'head'), HEAD_A);
    assert.equal(assertGitObjectId(HEAD_A, 'head'), HEAD_A);
  });

  for (const [label, value] of [
    ['empty', ''],
    ['slash', 'abc/def'],
    ['nonhex', 'g'.repeat(40)],
    ['short', 'a'.repeat(39)],
    ['long', 'a'.repeat(41)],
  ] as const) {
    it(`rejects a ${label} reviewed head and includes its field label`, () => {
      assert.throws(() => assertGitObjectId(value, 'reviewed_head'), /reviewed_head/);
    });
  }

  it('rejects the complete non-canonical taskId grammar matrix', () => {
    const badIds = ['.', '..', '', 'a/b', 'a\\b', 'Task-A', 'task_a', 'a b', '-task', 'task-'];
    for (const bad of badIds) {
      assert.throws(
        () => reviewDirFor('/state/run-0061', bad),
        /taskId/,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });

  it('rejects a 65-character taskId and accepts the 64-character boundary', () => {
    assert.throws(() => reviewDirFor('/state/run-0061', 'a'.repeat(65)), /taskId/);
    assert.equal(
      reviewDirFor('/state/run-0061', 'a'.repeat(64)),
      `/state/run-0061/authoritative/reviews/${'a'.repeat(64)}`,
    );
  });

  it('accepts canonical lowercase-hyphen taskIds', () => {
    for (const task of ['a', 'task-a', 'review-store-append-only', 'a1-b2']) {
      assert.equal(
        reviewDirFor('/state/run-0061', task),
        `/state/run-0061/authoritative/reviews/${task}`,
      );
    }
  });

  it('formats four- and five-digit review file sequences without truncation', () => {
    assert.equal(reviewFileName(2, HEAD_A.toUpperCase()), `0002-${HEAD_A}.json`);
    assert.equal(reviewFileName(10_000, HEAD_A), `10000-${HEAD_A}.json`);
  });

  it('rejects an invalid reviewed head before building a review filename', () => {
    assert.throws(() => reviewFileName(1, '../escape'), /reviewedHead/);
  });

  it('sorts object keys recursively regardless of insertion order', () => {
    const first = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const second = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    assert.equal(first, second);
    assert.equal(first, '{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order in canonical JSON', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  });

  it('serializes an own __proto__ property as data', () => {
    const parsed = JSON.parse('{"__proto__":1,"a":2}') as Record<string, unknown>;
    assert.equal(canonicalJson(parsed), '{"__proto__":1,"a":2}');
    assert.notEqual(canonicalJson(parsed), canonicalJson({ a: 2 }));
  });

  it('rejects every non-JSON primitive and nested non-JSON value', () => {
    for (const value of [
      undefined, () => 1, Symbol('s'), Number.NaN, Number.POSITIVE_INFINITY,
      { nested: undefined }, [Number.NaN],
    ]) {
      assert.throws(() => canonicalJson(value), /not a JSON value/);
    }
  });

  it('makes finding ids deterministic and independent of object key order', () => {
    assert.equal(
      findingId('ref', 'blocking', 0, { file: 'a.ts', line: 1 }),
      findingId('ref', 'blocking', 0, { line: 1, file: 'a.ts' }),
    );
  });

  for (const [dimension, left, right] of [
    ['ref', findingId('ref-a', 'blocking', 0, 'x'), findingId('ref-b', 'blocking', 0, 'x')],
    ['field', findingId('ref', 'blocking', 0, 'x'), findingId('ref', 'advisory', 0, 'x')],
    ['index', findingId('ref', 'blocking', 0, 'x'), findingId('ref', 'blocking', 1, 'x')],
  ]) {
    it(`makes finding ids sensitive to ${dimension}`, () => {
      assert.notEqual(left, right);
    });
  }

  it('formats finding ids as lowercase sha256 digests', () => {
    assert.match(findingId('ref', 'blocking', 0, 'x'), /^[0-9a-f]{64}$/);
  });

  it('publishes append-only verdicts with ordered sequences and no artifacts', () => {
    const runDir = makeRunDir();
    const one = Buffer.from('one');
    const two = Buffer.from('two');
    const first = publishVerdict(runDir, 'task-basic', one, HEAD_A);
    const second = publishVerdict(runDir, 'task-basic', two, HEAD_B);
    assert.deepEqual([first.seq, second.seq], [1, 2]);
    assert.deepEqual(readFileSync(first.path), one);
    assert.deepEqual(readFileSync(second.path), two);
    assert.equal(first.sha256, createHash('sha256').update(one).digest('hex'));
    assert.deepEqual(lockArtifacts(reviewDirFor(runDir, 'task-basic')), []);
  });

  it('rejects an invalid taskId before creating any filesystem path', () => {
    const runDir = join(TEST_TMP, unique('missing-run'));
    assert.equal(existsSync(runDir), false);
    assert.throws(() => publishVerdict(runDir, '../task', Buffer.from('{}'), HEAD_A), /taskId/);
    assert.equal(existsSync(runDir), false);
  });

  it('rejects an invalid reviewed head before creating any filesystem path', () => {
    const runDir = join(TEST_TMP, unique('missing-run'));
    assert.equal(existsSync(runDir), false);
    assert.throws(() => publishVerdict(runDir, 'task-invalid-head', Buffer.from('{}'), '../head'), /reviewedHead/);
    assert.equal(existsSync(runDir), false);
  });

  it('keeps independent tasks on independent sequence counters', () => {
    const runDir = makeRunDir();
    const first = publishVerdict(runDir, 'task-independent-a', Buffer.from('a'), HEAD_A);
    const second = publishVerdict(runDir, 'task-independent-b', Buffer.from('b'), HEAD_B);
    assert.deepEqual([first.seq, second.seq], [1, 1]);
  });

  it('discovers sequences wider than four digits and preserves existing bytes', () => {
    const runDir = makeRunDir();
    const dir = reviewDirFor(runDir, 'task-overflow');
    mkdirSync(dir, { recursive: true });
    const existing = Buffer.from([0, 255, 10, 13, 65]);
    const existingPath = join(dir, `10000-${HEAD_A}.json`);
    writeFileSync(existingPath, existing);
    assert.throws(
      () => publishVerdict(runDir, 'task-overflow', Buffer.from('{}'), HEAD_B),
      /bound/,
    );
    assert.deepEqual(readFileSync(existingPath), existing);
    assert.deepEqual(readdirSync(dir), [`10000-${HEAD_A}.json`]);
  });

  it('publishes sequence 9999 and fails loudly on the next publish', () => {
    const runDir = makeRunDir();
    const dir = reviewDirFor(runDir, 'task-bound');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `9998-${HEAD_A}.json`), '{}');
    const atBound = publishVerdict(runDir, 'task-bound', Buffer.from('bound'), HEAD_B);
    assert.equal(atBound.seq, 9999);
    assert.equal(readFileSync(atBound.path, 'utf8'), 'bound');
    assert.throws(() => publishVerdict(runDir, 'task-bound', Buffer.from('{}'), HEAD_A), /bound/);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, 2);
  });

  it('requires a validated capability before hook paths or fault tags activate', () => {
    const runDir = makeRunDir();
    const hookDir = resolve(TEST_TMP, unique('uncapable'));
    mkdirSync(hookDir, { recursive: true });
    process.env.HYDRA_REVIEW_STORE_HOOK_DIR = hookDir;
    process.env.HYDRA_REVIEW_STORE_HOOK_TAG = 'plain';
    process.env.HYDRA_REVIEW_STORE_FAULT = 'lock-write';
    try {
      assert.equal(publishVerdict(runDir, 'task-capability', Buffer.from('{}'), HEAD_A).seq, 1);
      assert.equal(existsSync(join(hookDir, 'plain.acquired')), false);
    } finally {
      delete process.env.HYDRA_REVIEW_STORE_HOOK_DIR;
      delete process.env.HYDRA_REVIEW_STORE_HOOK_TAG;
      delete process.env.HYDRA_REVIEW_STORE_FAULT;
    }
  });

  it('fsyncs a newly-created task directory parent before making a claim', () => {
    const runDir = makeRunDir();
    const hooks = makeHooks();
    withHooks(hooks, { HYDRA_REVIEW_STORE_FAULT: 'reviews-dir-fsync' }, () => {
      assert.throws(() => publishVerdict(runDir, 'task-parent-sync', Buffer.from('{}'), HEAD_A), /reviews-dir-fsync/);
    });
    const dir = reviewDirFor(runDir, 'task-parent-sync');
    assert.equal(existsSync(dir), true);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(publishVerdict(runDir, 'task-parent-sync', Buffer.from('{}'), HEAD_A).seq, 1);
  });

  for (const stage of [
    'lock-write', 'lock-write-zero', 'lock-write-short', 'lock-fsync', 'lock-close',
    'lock-dir-fsync', 'lock-dir-close', 'lock-parent-dir-close',
  ]) {
    it(`bounds and cleans a ${stage} ownership-publication failure`, () => {
      const runDir = makeRunDir();
      const task = `task-${stage}`;
      const hooks = makeHooks();
      if (stage === 'lock-write-short') {
        const result = withHooks(hooks, { HYDRA_REVIEW_STORE_FAULT: stage }, () =>
          publishVerdict(runDir, task, Buffer.from('{}'), HEAD_A));
        assert.equal(result.seq, 1, 'short writes must be completed');
      } else {
        withHooks(hooks, { HYDRA_REVIEW_STORE_FAULT: stage }, () => {
          assert.throws(() => publishVerdict(runDir, task, Buffer.from('{}'), HEAD_A),
            stage === 'lock-write-zero' ? /zero progress/ : /injected fault/);
        });
      }
      const dir = reviewDirFor(runDir, task);
      assert.deepEqual(lockArtifacts(dir), []);
      const next = publishVerdict(runDir, task, Buffer.from('next'), HEAD_B);
      assert.equal(next.seq, stage === 'lock-write-short' ? 2 : 1);
      assert.equal(readFileSync(next.path, 'utf8'), 'next');
    });
  }

  for (const stage of ['open', 'write', 'fsync-file', 'file-close', 'link', 'unlink-tmp', 'dir-fsync', 'dir-close']) {
    it(`preserves append-only state and cleans temporary state on ${stage}`, () => {
      const runDir = makeRunDir();
      const hooks = makeHooks();
      withHooks(hooks, { HYDRA_REVIEW_STORE_FAULT: stage }, () => {
        assert.throws(() => publishVerdict(runDir, `task-file-${stage}`, Buffer.from(stage), HEAD_A), /injected fault/);
      });
      const dir = reviewDirFor(runDir, `task-file-${stage}`);
      assert.deepEqual(lockArtifacts(dir), []);
      const linked = new Set(['unlink-tmp', 'dir-fsync', 'dir-close']).has(stage);
      assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, linked ? 1 : 0);
      const next = publishVerdict(runDir, `task-file-${stage}`, Buffer.from('next'), HEAD_B);
      assert.equal(next.seq, linked ? 2 : 1);
      assert.equal(readFileSync(next.path, 'utf8'), 'next');
    });
  }

  it('keeps the original error when close and cleanup also fail', () => {
    const runDir = makeRunDir();
    const hooks = makeHooks();
    withHooks(hooks, {
      HYDRA_REVIEW_STORE_FAULT: 'write,file-close,temp-cleanup,lock-cleanup-owner,lock-cleanup-claim,release-owner-unlink',
    }, () => {
      assert.throws(() => publishVerdict(runDir, 'task-primary', Buffer.from('{}'), HEAD_A), /stage: write/);
    });
  });

  it('blocks child B behind acquired child A, then publishes strict seq 1/2', { timeout: 30_000 }, async () => {
    const runDir = makeRunDir();
    const task = 'task-contention';
    const hooks = makeHooks('a');
    const script = childScript();
    const a = spawnChild(script, runDir, task, HEAD_A, 'a', {
      ...hooks.env, HYDRA_REVIEW_STORE_HOOK_PAUSE: 'acquired',
    });
    await waitFor(join(hooks.dir, 'a.acquired'), 'A acquired');
    const bEnv = { ...hooks.env, HYDRA_REVIEW_STORE_HOOK_TAG: 'b' };
    const b = spawnChild(script, runDir, task, HEAD_B, 'b', bEnv);
    await waitFor(join(hooks.dir, 'b.blocked'), 'B blocked');
    assert.equal(existsSync(join(hooks.dir, 'b.acquired')), false);
    assert.equal(readdirSync(reviewDirFor(runDir, task)).some((name) => name.endsWith(HEAD_B + '.json')), false);
    assert.equal(b.exited(), false);
    writeFileSync(join(hooks.dir, 'a.acquired.release'), 'release');
    const [ra, rb] = await Promise.all([a.result, b.result]);
    assert.deepEqual([ra.seq, rb.seq], [1, 2]);
    assert.deepEqual(lockArtifacts(reviewDirFor(runDir, task)), []);
  });

  it('recovers a genuinely stale immutable owner by age, not PID liveness', () => {
    const runDir = makeRunDir();
    const dir = reviewDirFor(runDir, 'task-stale');
    mkdirSync(dir, { recursive: true });
    writeOwner(join(dir, '.seq-0001.claimed'), '1'.repeat(32), Date.now() - 120_000);
    const result = publishVerdict(runDir, 'task-stale', Buffer.from('ok'), HEAD_A);
    assert.equal(result.seq, 2);
    assert.equal(readFileSync(result.path, 'utf8'), 'ok');
    assert.deepEqual(lockArtifacts(dir), []);
  });

  it('reclaims a stale owner whose recorded pid is currently live', () => {
    const runDir = makeRunDir();
    const task = 'task-recycled-pid';
    const dir = reviewDirFor(runDir, task);
    const claim = join(dir, '.seq-0001.claimed');
    mkdirSync(dir, { recursive: true });
    mkdirSync(claim);
    const token = '7'.repeat(32);
    writeFileSync(
      join(claim, `.owner-${token}`),
      JSON.stringify({ pid: process.pid, token, acquired: Date.now() - 120_000 }),
      { flag: 'wx' },
    );
    const result = publishVerdict(runDir, task, Buffer.from('recycled'), HEAD_A);
    assert.equal(result.seq, 2);
    assert.equal(readFileSync(result.path, 'utf8'), 'recycled');
    assert.deepEqual(lockArtifacts(dir), []);
  });

  it('never reclaims or modifies a young owner and times out without publishing', { timeout: 15_000 }, () => {
    const runDir = makeRunDir();
    const task = 'task-young-owner';
    const dir = reviewDirFor(runDir, task);
    const claim = join(dir, '.seq-0001.claimed');
    mkdirSync(dir, { recursive: true });
    const token = '8'.repeat(32);
    const owner = join(claim, `.owner-${token}`);
    mkdirSync(claim);
    const exactBytes = Buffer.from(JSON.stringify({ pid: 99999999, token, acquired: Date.now() }));
    writeFileSync(owner, exactBytes, { flag: 'wx' });
    assert.throws(() => publishVerdict(runDir, task, Buffer.from('{}'), HEAD_A), /timed out/);
    assert.deepEqual(readFileSync(owner), exactBytes);
    assert.deepEqual(readdirSync(claim), [`.owner-${token}`]);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, 0);
    for (const name of readdirSync(dir).filter((entry) => entry.includes('.claimed'))) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  });

  it('admits exactly one stale reclaimer while six children publish distinct verdicts', { timeout: 30_000 }, async () => {
    const runDir = makeRunDir();
    const task = 'task-stale-race';
    const dir = reviewDirFor(runDir, task);
    mkdirSync(dir, { recursive: true });
    writeOwner(join(dir, '.seq-0001.claimed'), '9'.repeat(32), Date.now() - 120_000);
    const hooks = makeHooks();
    const script = childScript();
    const heads = ['a', 'b', 'c', 'd', 'e', 'f'].map((character) => character.repeat(40));
    const payloads = heads.map((_, index) => `verdict-from-child-${index}`);
    const children = heads.map((head, index) => spawnChild(script, runDir, task, head, payloads[index], {
      ...hooks.env,
      HYDRA_REVIEW_STORE_HOOK_TAG: `child-${index}`,
    }));
    const results = await Promise.all(children.map((child) => child.result));
    assert.deepEqual(results.map((result) => result.seq).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
    for (let index = 0; index < results.length; index += 1) {
      assert.equal(readFileSync(results[index].path, 'utf8'), payloads[index]);
    }
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, 6);
    assert.equal(
      readdirSync(hooks.dir).filter((name) => name.endsWith('.stale-claimed')).length,
      1,
      'only the child that retired the immutable stale owner may be admitted as reclaimer',
    );
    assert.deepEqual(lockArtifacts(dir), []);
  });

  it('cleans standalone temporary publish files after each successful publish', () => {
    const runDir = makeRunDir();
    const task = 'task-temp-cleanup';
    publishVerdict(runDir, task, Buffer.from('one'), HEAD_A);
    publishVerdict(runDir, task, Buffer.from('two'), HEAD_B);
    const entries = readdirSync(reviewDirFor(runDir, task));
    assert.equal(entries.filter((name) => name.endsWith('.json')).length, 2);
    assert.deepEqual(entries.filter((name) => name.includes('.tmp-')), []);
    assert.deepEqual(lockArtifacts(reviewDirFor(runDir, task)), []);
  });

  for (const stage of ['stale-read', 'stale-owner-unlink', 'stale-cleanup']) {
    it(`fails closed and bounded on ${stage} without publishing or removing a live owner`, () => {
      const runDir = makeRunDir();
      const task = `task-${stage}`;
      const dir = reviewDirFor(runDir, task);
      const staleClaim = join(dir, '.seq-0001.claimed');
      mkdirSync(dir, { recursive: true });
      const stale = writeOwner(staleClaim, '5'.repeat(32), Date.now() - 120_000);
      const liveClaim = join(dir, '.seq-0002.claimed');
      const live = writeOwner(liveClaim, '6'.repeat(32), Date.now());
      const hooks = makeHooks();
      withHooks(hooks, { HYDRA_REVIEW_STORE_FAULT: stage }, () => {
        assert.throws(() => publishVerdict(runDir, task, Buffer.from('{}'), HEAD_A), /injected fault/);
      });
      assert.equal(existsSync(live), true, 'faulting stale recovery may not address another identity');
      assert.equal(readdirSync(dir).some((name) => name.endsWith('.json')), false);
      if (stage !== 'stale-cleanup') assert.equal(existsSync(stale), true);
      rmSync(staleClaim, { recursive: true, force: true });
      rmSync(liveClaim, { recursive: true, force: true });
      for (const name of readdirSync(dir).filter((entry) => entry.includes('.claimed'))) {
        rmSync(join(dir, name), { recursive: true, force: true });
      }
      const next = publishVerdict(runDir, task, Buffer.from('next'), HEAD_B);
      assert.equal(next.seq, 1);
      assert.equal(readFileSync(next.path, 'utf8'), 'next');
    });
  }

  for (const stage of ['release-owner-unlink', 'release-claim-rmdir']) {
    it(`preserves the verdict and fails closed on ${stage}`, () => {
      const runDir = makeRunDir();
      const task = `task-${stage}`;
      const hooks = makeHooks();
      withHooks(hooks, { HYDRA_REVIEW_STORE_FAULT: stage }, () => {
        assert.throws(() => publishVerdict(runDir, task, Buffer.from(stage), HEAD_A), /injected fault/);
      });
      const dir = reviewDirFor(runDir, task);
      assert.equal(readFileSync(join(dir, `0001-${HEAD_A}.json`), 'utf8'), stage);
      assert.equal(readdirSync(dir).filter((name) => name.endsWith('.json')).length, 1);
      for (const name of readdirSync(dir).filter((entry) => entry.includes('.claimed'))) {
        rmSync(join(dir, name), { recursive: true, force: true });
      }
      const next = publishVerdict(runDir, task, Buffer.from('next'), HEAD_B);
      assert.equal(next.seq, 2);
      assert.equal(readFileSync(next.path, 'utf8'), 'next');
    });
  }

  for (const pause of ['stale-observed', 'stale-claimed']) {
    it(`${pause} racing a live replacement preserves it in place without a restore window`, { timeout: 30_000 }, async () => {
      const runDir = makeRunDir();
      const task = `task-stale-aba-${pause}`;
      const dir = reviewDirFor(runDir, task);
      const claim = join(dir, '.seq-0001.claimed');
      mkdirSync(dir, { recursive: true });
      const stale = writeOwner(claim, '2'.repeat(32), Date.now() - 120_000);
      const hooks = makeHooks('reclaimer');
      const child = spawnChild(childScript(), runDir, task, HEAD_A, 'reclaimer', {
        ...hooks.env, HYDRA_REVIEW_STORE_HOOK_PAUSE: pause,
      });
      await waitFor(join(hooks.dir, `reclaimer.${pause}`), pause);
      if (pause === 'stale-observed') unlinkSync(stale);
      else assert.equal(existsSync(stale), false, 'the immutable stale identity was atomically retired');
      const live = writeOwner(claim, '3'.repeat(32), Date.now());
      writeFileSync(join(hooks.dir, `reclaimer.${pause}.release`), 'release');
      await waitFor(join(hooks.dir, 'reclaimer.stale-replacement-preserved'), 'replacement preservation');
      await waitFor(join(hooks.dir, 'reclaimer.blocked'), 'replacement blocks reclaimer');
      assert.equal(existsSync(live), true, 'the observed pathname cannot capture the replacement identity');
      unlinkSync(live);
      rmdirSync(claim);
      const result = await child.result;
      assert.equal(result.seq, 2);
      assert.deepEqual(lockArtifacts(dir), []);
    });
  }

  it('a release paused before destruction cannot delete B inserted in its generation', { timeout: 30_000 }, async () => {
    const runDir = makeRunDir();
    const task = 'task-release-aba';
    const hooks = makeHooks('a');
    const child = spawnChild(childScript(), runDir, task, HEAD_A, 'a', {
      ...hooks.env, HYDRA_REVIEW_STORE_HOOK_PAUSE: 'release-before-owner-unlink',
    });
    await waitFor(join(hooks.dir, 'a.release-before-owner-unlink'), 'release validation boundary');
    const dir = reviewDirFor(runDir, task);
    const claim = join(dir, '.seq-0001.claimed');
    const [aOwner] = readdirSync(claim).filter((name) => name.startsWith('.owner-'));
    assert.ok(aOwner);
    unlinkSync(join(claim, aOwner));
    const bOwner = writeOwner(claim, '4'.repeat(32), Date.now());
    writeFileSync(join(hooks.dir, 'a.release-before-owner-unlink.release'), 'release');
    await assert.rejects(child.result, /ambiguous review publish release preserved/);
    assert.equal(existsSync(bOwner), true, 'A may only address its immutable owner pathname');
    unlinkSync(bOwner);
    rmdirSync(claim);
  });
});
