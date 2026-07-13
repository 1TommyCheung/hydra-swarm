import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshnessGate, type FreshnessGateResult } from '../src/freshness-gate.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-freshness-gate');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, uniqueName(prefix));
  mkdirSync(p, { recursive: true });
  return p;
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
}

function commitFile(dir: string, filename: string, content: string): string {
  writeFileSync(join(dir, filename), content, 'utf8');
  execFileSync('git', ['-C', dir, 'add', filename], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', `add ${filename}`], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

interface FixturePaths {
  stateRoot: string;
  worktree: string;
  taskSpec: string;
  manifest: string;
}

function setupFixture(runId: string, taskId: string, worktree?: string): FixturePaths {
  const stateRoot = makeTempDir('state');
  const actualWorktree = worktree ?? makeTempDir('worktree');
  const run_dir = join(stateRoot, 'runs', `run-${runId}`);
  const tasksDir = join(run_dir, 'tasks');
  const graphDir = join(run_dir, 'authoritative', 'graph');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(graphDir, { recursive: true });

  const taskSpec = join(tasksDir, `${taskId}.yaml`);
  writeFileSync(taskSpec, `worktree: ${actualWorktree}\n`, 'utf8');

  const manifest = join(graphDir, `${taskId}.manifest.yaml`);
  return { stateRoot, worktree: actualWorktree, taskSpec, manifest };
}

function withStateRoot<T>(stateRoot: string, fn: () => T): T {
  const previous = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = stateRoot;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = previous;
    }
  }
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

describe('freshnessGate', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('returns fresh when indexed_commit matches HEAD and tree is clean', () => {
    const runId = '0017';
    const taskId = 'freshness-gate';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const head = commitFile(fixture.worktree, 'file.txt', 'hello');

    writeFileSync(fixture.manifest, `indexed_commit: ${head}\n`, 'utf8');

    const result = withStateRoot(fixture.stateRoot, () =>
      freshnessGate(runId, taskId),
    ) as FreshnessGateResult;

    assert.equal(result.fresh, true);
    assert.equal(result.head, head);
    assert.equal(result.indexedCommit, head);
    assert.equal(result.reason, undefined);
  });

  it('returns stale when indexed_commit differs from HEAD', () => {
    const runId = '0017';
    const taskId = 'freshness-gate';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const first = commitFile(fixture.worktree, 'file.txt', 'hello');
    const second = commitFile(fixture.worktree, 'file2.txt', 'world');

    writeFileSync(fixture.manifest, `indexed_commit: ${first}\n`, 'utf8');

    const result = withStateRoot(fixture.stateRoot, () =>
      freshnessGate(runId, taskId),
    ) as FreshnessGateResult;

    assert.equal(result.fresh, false);
    assert.equal(result.head, second);
    assert.equal(result.indexedCommit, first);
    assert.match(result.reason ?? '', /indexed_commit != HEAD/);
  });

  it('returns stale when the working tree is dirty', () => {
    const runId = '0017';
    const taskId = 'freshness-gate';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const head = commitFile(fixture.worktree, 'file.txt', 'hello');

    writeFileSync(fixture.manifest, `indexed_commit: ${head}\n`, 'utf8');
    writeFileSync(join(fixture.worktree, 'file.txt'), 'modified', 'utf8');

    const result = withStateRoot(fixture.stateRoot, () =>
      freshnessGate(runId, taskId),
    ) as FreshnessGateResult;

    assert.equal(result.fresh, false);
    assert.equal(result.head, head);
    assert.equal(result.indexedCommit, head);
    assert.match(result.reason ?? '', /working tree dirty/);
  });

  it('returns stale when the manifest is missing', () => {
    const runId = '0017';
    const taskId = 'freshness-gate';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    commitFile(fixture.worktree, 'file.txt', 'hello');

    const result = withStateRoot(fixture.stateRoot, () =>
      freshnessGate(runId, taskId),
    ) as FreshnessGateResult;

    assert.equal(result.fresh, false);
    assert.equal(result.reason, 'no index manifest');
  });

  it('throws when the task spec is missing', () => {
    const runId = '0017';
    const taskId = 'freshness-gate';
    const fixture = setupFixture(runId, taskId);
    writeFileSync(fixture.manifest, 'indexed_commit: abc123\n', 'utf8');
    rmSync(fixture.taskSpec);

    assert.throws(
      () => withStateRoot(fixture.stateRoot, () => freshnessGate(runId, taskId)),
      /task spec not found/,
    );
  });

  it('throws when the worktree does not exist', () => {
    const runId = '0017';
    const taskId = 'freshness-gate';
    const fixture = setupFixture(runId, taskId, '/nonexistent/worktree/path');
    writeFileSync(fixture.manifest, 'indexed_commit: abc123\n', 'utf8');

    assert.throws(
      () => withStateRoot(fixture.stateRoot, () => freshnessGate(runId, taskId)),
      /worktree not found/,
    );
  });
});
