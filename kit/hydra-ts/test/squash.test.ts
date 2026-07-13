import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { squash, type SquashRecord } from '../src/squash.ts';
import { ledger } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-squash');

interface RepoFixture {
  repoPath: string;
  baseCommit: string;
  candidateHead: string;
  sourceCommits: string[];
  runId: string;
  taskId: string;
  stateRoot: string;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(name: string): RepoFixture {
  const repoPath = join(TEST_TMP, name);
  mkdirSync(repoPath, { recursive: true });

  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'hydra@test']);
  git(repoPath, ['config', 'user.name', 'Hydra Test']);

  writeFileSync(join(repoPath, 'base.txt'), 'base\n', 'utf8');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-m', 'base commit']);
  const baseCommit = git(repoPath, ['rev-parse', 'HEAD']);

  git(repoPath, ['checkout', '-b', 'candidate']);

  writeFileSync(join(repoPath, 'a.txt'), 'a\n', 'utf8');
  git(repoPath, ['add', 'a.txt']);
  git(repoPath, ['commit', '-m', 'candidate commit 1']);
  const commitA = git(repoPath, ['rev-parse', 'HEAD']);

  writeFileSync(join(repoPath, 'b.txt'), 'b\n', 'utf8');
  git(repoPath, ['add', 'b.txt']);
  git(repoPath, ['commit', '-m', 'candidate commit 2']);
  const commitB = git(repoPath, ['rev-parse', 'HEAD']);

  return {
    repoPath,
    baseCommit,
    candidateHead: commitB,
    sourceCommits: [commitA, commitB],
    runId: '0017',
    taskId: 'squash',
    stateRoot: join(TEST_TMP, `${name}-state`),
  };
}

function writeTaskSpec(fixture: RepoFixture): void {
  const specDir = join(fixture.stateRoot, 'runs', `run-${fixture.runId}`, 'tasks');
  mkdirSync(specDir, { recursive: true });
  const specPath = join(specDir, `${fixture.taskId}.yaml`);
  writeFileSync(
    specPath,
    `run_id: ${fixture.runId}\ntask_id: ${fixture.taskId}\nworktree: ${fixture.repoPath}\nbase_commit: ${fixture.baseCommit}\nbranch: hydra/0017/squash\n`,
    'utf8',
  );
}

function writePromotedResult(fixture: RepoFixture): void {
  const resultDir = join(
    fixture.stateRoot,
    'runs',
    `run-${fixture.runId}`,
    'authoritative',
    'results',
  );
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, `${fixture.taskId}.json`);
  const result = {
    task_id: fixture.taskId,
    run_id: fixture.runId,
    spec_version: 1,
    vendor: 'test',
    status: 'completed',
    branch: 'hydra/0017/squash',
    base_commit: fixture.baseCommit,
    head_commit: fixture.candidateHead,
    claims: {
      head_commit: fixture.candidateHead,
    },
  };
  writeFileSync(resultPath, `${JSON.stringify(result)}\n`, 'utf8');
}

function setupFixture(name: string): RepoFixture {
  const fixture = initRepo(name);
  process.env.HYDRA_STATE_ROOT = fixture.stateRoot;
  writeTaskSpec(fixture);
  writePromotedResult(fixture);
  return fixture;
}

describe('squash', { concurrency: 1 }, () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('creates an integration commit with the candidate tree and base parent', () => {
    const fixture = setupFixture('squash-success');

    const result = squash(fixture.runId, fixture.taskId);

    assert.ok(result.integrationCommit);
    assert.match(result.integrationCommit, /^[0-9a-f]{40}$/);

    const parents = git(fixture.repoPath, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      result.integrationCommit,
    ])
      .split(' ')
      .map((s) => s.trim())
      .filter(Boolean);
    assert.deepEqual(parents, [result.integrationCommit, fixture.baseCommit]);

    const tree = git(fixture.repoPath, ['rev-parse', `${result.integrationCommit}^{tree}`]);
    assert.equal(tree, git(fixture.repoPath, ['rev-parse', `${fixture.candidateHead}^{tree}`]));
  });

  it('writes a squash record with source commits', () => {
    const fixture = setupFixture('squash-record');

    const result = squash(fixture.runId, fixture.taskId);

    const recordPath = join(
      fixture.stateRoot,
      'runs',
      `run-${fixture.runId}`,
      'authoritative',
      'results',
      `${fixture.taskId}.squash.json`,
    );
    assert.equal(result.recordPath, recordPath);
    assert.ok(existsSync(recordPath));

    const record: SquashRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(record.candidate_head, fixture.candidateHead);
    assert.equal(record.integration_commit, result.integrationCommit);
    assert.deepEqual(record.source_commits, fixture.sourceCommits);
  });

  it('appends a squash_created ledger event', () => {
    const fixture = setupFixture('squash-ledger');

    const result = squash(fixture.runId, fixture.taskId);

    const ledgerPath = ledger(fixture.runId);
    assert.ok(existsSync(ledgerPath));
    const events = readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const event = events.find((e) => e.event === 'squash_created');
    assert.ok(event);
    assert.equal(event.task_id, fixture.taskId);
    assert.equal(event.integration_commit, result.integrationCommit);
    assert.equal(event.run_id, fixture.runId);
    assert.match(event.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('dies when the task spec is missing', () => {
    const fixture = setupFixture('squash-no-spec');
    rmSync(
      join(
        fixture.stateRoot,
        'runs',
        `run-${fixture.runId}`,
        'tasks',
        `${fixture.taskId}.yaml`,
      ),
      { force: true },
    );

    assert.throws(
      () => squash(fixture.runId, fixture.taskId),
      /task spec not found/,
    );
  });

  it('dies when the promoted result is missing', () => {
    const fixture = setupFixture('squash-no-promoted');
    rmSync(
      join(
        fixture.stateRoot,
        'runs',
        `run-${fixture.runId}`,
        'authoritative',
        'results',
        `${fixture.taskId}.json`,
      ),
      { force: true },
    );

    assert.throws(
      () => squash(fixture.runId, fixture.taskId),
      /cannot squash a non-promoted candidate/,
    );
  });

  it('dies when the candidate head is missing', () => {
    const fixture = setupFixture('squash-missing-head');
    const resultDir = join(
      fixture.stateRoot,
      'runs',
      `run-${fixture.runId}`,
      'authoritative',
      'results',
    );
    const resultPath = join(resultDir, `${fixture.taskId}.json`);
    const promoted = JSON.parse(readFileSync(resultPath, 'utf8'));
    promoted.claims.head_commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    writeFileSync(resultPath, `${JSON.stringify(promoted)}\n`, 'utf8');

    assert.throws(
      () => squash(fixture.runId, fixture.taskId),
      /candidate head missing/,
    );
  });
});
