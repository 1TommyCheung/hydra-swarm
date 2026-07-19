import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runInit } from '../src/run-init.ts';
import { ledger, pinnedHerdrWorkspace, runDir, yamlScalar } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-run-init');
const STATE_TMP = join(TEST_TMP, 'state');

const ORIGINAL_HYDRA_STATE_ROOT = process.env.HYDRA_STATE_ROOT;
const ORIGINAL_HYDRA_REPO_ID = process.env.HYDRA_REPO_ID;

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupEnv(): void {
  process.env.HYDRA_STATE_ROOT = STATE_TMP;
  process.env.HYDRA_REPO_ID = 'test-repo';
}

function restoreEnv(): void {
  if (ORIGINAL_HYDRA_STATE_ROOT === undefined) {
    delete process.env.HYDRA_STATE_ROOT;
  } else {
    process.env.HYDRA_STATE_ROOT = ORIGINAL_HYDRA_STATE_ROOT;
  }
  if (ORIGINAL_HYDRA_REPO_ID === undefined) {
    delete process.env.HYDRA_REPO_ID;
  } else {
    process.env.HYDRA_REPO_ID = ORIGINAL_HYDRA_REPO_ID;
  }
}

describe('runInit', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    setupEnv();
  });

  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('throws when runId is empty', () => {
    assert.throws(() => runInit(''), /usage: runInit/);
  });

  it('throws when the run directory already exists', () => {
    const runId = 'already-exists';
    mkdirSync(runDir(runId), { recursive: true });
    assert.throws(() => runInit(runId), /run already exists/);
  });

  it('creates the expected directory tree', () => {
    const runId = 'tree-test';
    const dir = runInit(runId);

    assert.equal(dir, runDir(runId));
    assert.ok(existsSync(join(dir, 'tasks')));
    assert.ok(existsSync(join(dir, 'inbox')));
    assert.ok(existsSync(join(dir, 'authoritative', 'ledger')));
    assert.ok(existsSync(join(dir, 'authoritative', 'results')));
    assert.ok(existsSync(join(dir, 'authoritative', 'reviews')));
    assert.ok(existsSync(join(dir, 'authoritative', 'verification')));
    assert.ok(existsSync(join(dir, 'sessions')));
  });

  it('writes run.yaml with the expected fields', () => {
    const runId = 'yaml-test';
    const baseCommit = 'abc123def456';
    const dir = runInit(runId, baseCommit);
    const yamlPath = join(dir, 'run.yaml');

    assert.ok(existsSync(yamlPath));
    assert.equal(yamlScalar(yamlPath, 'run_id'), runId);
    assert.equal(yamlScalar(yamlPath, 'base_commit'), baseCommit);
    assert.equal(yamlScalar(yamlPath, 'repo_id'), 'test-repo');
    assert.equal(yamlScalar(yamlPath, 'state'), 'planning');
    assert.equal(yamlScalar(yamlPath, 'tasks'), '[]');

    const created = yamlScalar(yamlPath, 'created');
    assert.match(created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(!Number.isNaN(Date.parse(created)));
  });

  it('appends a run_started ledger event', () => {
    const runId = 'ledger-test';
    const baseCommit = 'deadbeef';
    runInit(runId, baseCommit);

    const events = readFileSync(ledger(runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'run_started');
    assert.equal(events[0].run_id, runId);
    assert.equal(events[0].base_commit, baseCommit);
    assert.ok(events[0].time);
  });

  it('defaults base_commit to the current git HEAD', () => {
    const runId = 'default-head-test';
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dir = runInit(runId);
    const yamlPath = join(dir, 'run.yaml');
    assert.equal(yamlScalar(yamlPath, 'base_commit'), head);
  });

  it('defaults an empty base_commit to the repository HEAD', () => {
    const runId = 'empty-base-test';
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dir = runInit(runId, '');

    assert.equal(yamlScalar(join(dir, 'run.yaml'), 'base_commit'), head);

    const events = readFileSync(ledger(runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events[0].base_commit, head);
  });

  it('honours an explicit base_commit override', () => {
    const runId = 'explicit-base-test';
    const baseCommit = 'custombase0001';
    const dir = runInit(runId, baseCommit);
    const yamlPath = join(dir, 'run.yaml');
    assert.equal(yamlScalar(yamlPath, 'base_commit'), baseCommit);

    const events = readFileSync(ledger(runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events[0].base_commit, baseCommit);
  });

  it('prints the initialized run directory followed by a newline', () => {
    const runId = 'stdout-test';
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const dir = runInit(runId, 'stdout-base');
      assert.equal(chunks.join(''), `${dir}\n`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('does not pre-populate herdr_workspace (the pin is captured lazily on the first pane spawn, issue #19)', () => {
    const runId = 'no-workspace-pin-at-init';
    const dir = runInit(runId, 'no-pin-base');
    const yamlPath = join(dir, 'run.yaml');
    assert.ok(existsSync(yamlPath));
    // herdr_workspace is intentionally NOT a run-init field — it is added by
    // dispatch.ts/review-dispatch.ts the first time a pane is spawned in the
    // run. Verifying this keeps the lazy-capture contract explicit.
    assert.equal(yamlScalar(yamlPath, 'herdr_workspace'), '');
    assert.equal(pinnedHerdrWorkspace(yamlPath), undefined);
  });
});
