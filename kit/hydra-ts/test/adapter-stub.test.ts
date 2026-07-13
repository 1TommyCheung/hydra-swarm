// Unit tests for the offline deterministic stub adapter (TS port of stub.sh).
//
// Exercises stub() directly against a scratch git repo — no dispatch spawn,
// no real vendor CLI. Mirrors the three STUB_MODE shapes the bash fixture
// exposes (success / fail / no_commit) plus verb validation.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stub } from '../src/adapter-stub.ts';

const TEST_TMP = join(tmpdir(), `hydra-adapter-stub-${process.pid}`);

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

interface Fixture {
  worktree: string;
  taskSpec: string;
  inbox: string;
  sessions: string;
  base: string;
  branch: string;
  agentRunId: string;
}

function setupFixture(label: string): Fixture {
  const dir = join(TEST_TMP, label);
  const worktree = join(dir, 'repo');
  const taskSpec = join(dir, 'task.yaml');
  const inbox = join(dir, 'inbox');
  const sessions = join(dir, 'sessions');
  mkdirSync(worktree, { recursive: true });
  git(['init', '-q', '-b', 'main'], worktree);
  git(['config', 'user.email', 'stub-unit@hydra.test'], worktree);
  git(['config', 'user.name', 'Stub Unit'], worktree);
  writeFileSync(join(worktree, 'base.txt'), 'base\n');
  git(['add', '.'], worktree);
  git(['commit', '-qm', 'base'], worktree);
  const base = git(['rev-parse', 'HEAD'], worktree);
  const branch = `hydra/stub/${label}`;
  git(['checkout', '-qb', branch], worktree);

  const agentRunId = `stub-${label}-v1`;
  writeFileSync(
    taskSpec,
    [
      'task_id: stubtask',
      'run_id: 0031',
      'spec_version: 1',
      `base_commit: ${base}`,
      `branch: ${branch}`,
      'writable_paths:',
      '  - stub-output.txt',
      'objective: >',
      '  stub unit fixture',
      '',
    ].join('\n'),
  );

  return { worktree, taskSpec, inbox, sessions, base, branch, agentRunId };
}

describe('adapter-stub (TS port of hydra/adapters/stub.sh)', () => {
  let savedStubMode: string | undefined;

  before(() => {
    savedStubMode = process.env.STUB_MODE;
    if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
  });

  afterEach(() => {
    if (savedStubMode === undefined) delete process.env.STUB_MODE;
    else process.env.STUB_MODE = savedStubMode;
  });

  after(() => {
    if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
  });

  it('success mode: commits, reports completed, derives git fields from the worktree', () => {
    process.env.STUB_MODE = 'success';
    const f = setupFixture('success');

    const returned = stub('start', f.taskSpec, f.worktree, f.inbox, f.sessions, f.agentRunId);
    assert.equal(returned, f.agentRunId);

    const head = git(['rev-parse', 'HEAD'], f.worktree);
    const drop = JSON.parse(readFileSync(join(f.inbox, 'result.json'), 'utf8'));
    assert.equal(drop.task_id, 'stubtask');
    assert.equal(drop.run_id, '0031');
    assert.equal(drop.spec_version, 1);
    assert.equal(drop.vendor, 'stub');
    assert.equal(drop.session_id, '');
    assert.equal(drop.status, 'completed');
    assert.equal(drop.branch, f.branch);
    assert.equal(drop.base_commit, git(['rev-parse', f.base], f.worktree));
    assert.equal(drop.head_commit, head);
    assert.notEqual(drop.head_commit, f.base);
    assert.deepEqual(drop.files_changed, ['stub-output.txt']);
    assert.deepEqual(drop.verification_claims, []);
    assert.deepEqual(drop.risks, []);
    assert.deepEqual(drop.unresolved_questions, []);
    assert.deepEqual(drop.suggested_additional_checks, []);

    const marker = `stub worker marker for ${f.agentRunId}\n`;
    assert.equal(git(['show', `${head}:stub-output.txt`], f.worktree) + '\n', marker);
    assert.equal(drop.summary, 'stub deterministic commit');

    const session = JSON.parse(readFileSync(join(f.sessions, `${f.agentRunId}.json`), 'utf8'));
    assert.deepEqual(session, { agent_run_id: f.agentRunId, vendor: 'stub', session_id: '' });
  });

  it('fail mode: still commits, but reports status failed with a risk', () => {
    process.env.STUB_MODE = 'fail';
    const f = setupFixture('fail');

    stub('start', f.taskSpec, f.worktree, f.inbox, f.sessions, f.agentRunId);

    const head = git(['rev-parse', 'HEAD'], f.worktree);
    assert.notEqual(head, f.base, 'fail mode must still make a real commit');
    const drop = JSON.parse(readFileSync(join(f.inbox, 'result.json'), 'utf8'));
    assert.equal(drop.status, 'failed');
    assert.equal(drop.head_commit, head);
    assert.deepEqual(drop.files_changed, ['stub-output.txt']);
    assert.equal(drop.summary, 'stub committed but simulated a failed worker report');
    assert.deepEqual(drop.risks, ['stub fail mode after commit']);
  });

  it('no_commit mode: makes no commit, reports completed with empty files_changed', () => {
    process.env.STUB_MODE = 'no_commit';
    const f = setupFixture('no-commit');

    stub('start', f.taskSpec, f.worktree, f.inbox, f.sessions, f.agentRunId);

    assert.equal(git(['rev-parse', 'HEAD'], f.worktree), f.base, 'no_commit must not advance HEAD');
    assert.equal(existsSync(join(f.worktree, 'stub-output.txt')), false, 'no_commit writes no marker');
    const drop = JSON.parse(readFileSync(join(f.inbox, 'result.json'), 'utf8'));
    assert.equal(drop.status, 'completed');
    assert.equal(drop.head_commit, f.base);
    assert.deepEqual(drop.files_changed, []);
    assert.equal(drop.summary, 'stub simulated completed report without a commit');
    assert.deepEqual(drop.risks, ['stub produced no commit']);
  });

  it('resume verb is treated identically to start', () => {
    process.env.STUB_MODE = 'success';
    const f = setupFixture('resume');

    stub('resume', f.taskSpec, f.worktree, f.inbox, f.sessions, f.agentRunId);

    const drop = JSON.parse(readFileSync(join(f.inbox, 'result.json'), 'utf8'));
    assert.equal(drop.status, 'completed');
    assert.notEqual(drop.head_commit, f.base);
    assert.deepEqual(drop.files_changed, ['stub-output.txt']);
  });

  it('rejects unknown verbs and missing required arguments', () => {
    process.env.STUB_MODE = 'success';
    const f = setupFixture('validation');
    assert.throws(() => stub('bogus', f.taskSpec, f.worktree, f.inbox, f.sessions, f.agentRunId), /unknown verb/);
    assert.throws(() => stub('', f.taskSpec, f.worktree, f.inbox, f.sessions, f.agentRunId), /usage:/);
    assert.throws(() => stub('start', '', f.worktree, f.inbox, f.sessions, f.agentRunId), /task_spec required/);
    assert.throws(() => stub('start', f.taskSpec, '', f.inbox, f.sessions, f.agentRunId), /worktree required/);
    assert.throws(() => stub('start', f.taskSpec, f.worktree, '', f.sessions, f.agentRunId), /inbox required/);
    assert.throws(() => stub('start', f.taskSpec, f.worktree, f.inbox, '', f.agentRunId), /sessions required/);
    assert.throws(() => stub('start', f.taskSpec, f.worktree, f.inbox, f.sessions, ''), /agent_run_id required/);
  });

  it('rejects an unknown STUB_MODE', () => {
    process.env.STUB_MODE = 'explode';
    const f = setupFixture('bad-mode');
    assert.throws(() => stub('start', f.taskSpec, f.worktree, f.inbox, f.sessions, f.agentRunId), /unknown STUB_MODE/);
  });
});
