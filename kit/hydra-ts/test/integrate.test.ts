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
import { dirname, join, resolve } from 'node:path';
import {
  integrate,
  IntegrationError,
  type ExecFunction,
  type VerifyFunction,
} from '../src/integrate.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-integrate');
const ORIGINAL_HYDRA_STATE_ROOT = process.env.HYDRA_STATE_ROOT;
const ORIGINAL_HYDRA_WORKTREE_ROOT = process.env.HYDRA_WORKTREE_ROOT;
const ORIGINAL_HYDRA_REPO_ID = process.env.HYDRA_REPO_ID;
const ORIGINAL_HYDRA_VERIFY_POLICY = process.env.HYDRA_VERIFY_POLICY;
const ORIGINAL_HYDRA_SMOKE_POLICY = process.env.HYDRA_SMOKE_POLICY;

interface TaskDef {
  id: string;
  files: Record<string, string>;
}

interface Fixture {
  repoPath: string;
  baseCommit: string;
  taskCommits: Record<string, string>;
  stateRoot: string;
  worktreeRoot: string;
  runId: string;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupEnv(): void {
  process.env.HYDRA_REPO_ID = 'test-repo';
  delete process.env.HYDRA_VERIFY_POLICY;
  delete process.env.HYDRA_SMOKE_POLICY;
}

function restoreEnv(): void {
  if (ORIGINAL_HYDRA_REPO_ID === undefined) {
    delete process.env.HYDRA_REPO_ID;
  } else {
    process.env.HYDRA_REPO_ID = ORIGINAL_HYDRA_REPO_ID;
  }
  if (ORIGINAL_HYDRA_STATE_ROOT === undefined) {
    delete process.env.HYDRA_STATE_ROOT;
  } else {
    process.env.HYDRA_STATE_ROOT = ORIGINAL_HYDRA_STATE_ROOT;
  }
  if (ORIGINAL_HYDRA_WORKTREE_ROOT === undefined) {
    delete process.env.HYDRA_WORKTREE_ROOT;
  } else {
    process.env.HYDRA_WORKTREE_ROOT = ORIGINAL_HYDRA_WORKTREE_ROOT;
  }
  if (ORIGINAL_HYDRA_VERIFY_POLICY === undefined) {
    delete process.env.HYDRA_VERIFY_POLICY;
  } else {
    process.env.HYDRA_VERIFY_POLICY = ORIGINAL_HYDRA_VERIFY_POLICY;
  }
  if (ORIGINAL_HYDRA_SMOKE_POLICY === undefined) {
    delete process.env.HYDRA_SMOKE_POLICY;
  } else {
    process.env.HYDRA_SMOKE_POLICY = ORIGINAL_HYDRA_SMOKE_POLICY;
  }
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initRepoWithTasks(
  name: string,
  tasks: TaskDef[],
  baseFiles: Record<string, string> = { 'base.txt': 'base\n' },
): { repoPath: string; baseCommit: string; taskCommits: Record<string, string> } {
  const repoPath = join(TEST_TMP, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'hydra@test']);
  git(repoPath, ['config', 'user.name', 'Hydra Test']);

  for (const [file, content] of Object.entries(baseFiles)) {
    writeFileSync(join(repoPath, file), content, 'utf8');
    git(repoPath, ['add', file]);
  }
  git(repoPath, ['commit', '-m', 'base commit']);
  const baseCommit = git(repoPath, ['rev-parse', 'HEAD']);

  const taskCommits: Record<string, string> = {};
  for (const task of tasks) {
    git(repoPath, ['checkout', baseCommit]);
    git(repoPath, ['checkout', '-b', `branch-${task.id}`]);
    for (const [file, content] of Object.entries(task.files)) {
      writeFileSync(join(repoPath, file), content, 'utf8');
      git(repoPath, ['add', file]);
    }
    git(repoPath, ['commit', '-m', `task ${task.id}`]);
    taskCommits[task.id] = git(repoPath, ['rev-parse', 'HEAD']);
  }

  git(repoPath, ['checkout', baseCommit]);
  return { repoPath, baseCommit, taskCommits };
}

function setupState(
  fixture: {
    repoPath: string;
    baseCommit: string;
    taskCommits: Record<string, string>;
  },
  runId: string,
  taskIds: string[],
): Fixture {
  const stateRoot = join(TEST_TMP, `${runId}-state`);
  const worktreeRoot = join(TEST_TMP, `${runId}-worktrees`);

  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  const rDir = join(stateRoot, 'runs', `run-${runId}`);
  mkdirSync(join(rDir, 'authoritative', 'results'), { recursive: true });
  mkdirSync(join(rDir, 'authoritative', 'verification'), { recursive: true });

  writeFileSync(
    join(rDir, 'run.yaml'),
    `run_id: ${runId}\nbase_commit: ${fixture.baseCommit}\n`,
    'utf8',
  );

  for (const taskId of taskIds) {
    const commit = fixture.taskCommits[taskId];
    if (!commit) continue;
    const recordPath = join(
      rDir,
      'authoritative',
      'results',
      `${taskId}.squash.json`,
    );
    writeFileSync(
      recordPath,
      JSON.stringify({ integration_commit: commit }),
      'utf8',
    );
  }

  return {
    repoPath: fixture.repoPath,
    baseCommit: fixture.baseCommit,
    taskCommits: fixture.taskCommits,
    stateRoot,
    worktreeRoot,
    runId,
  };
}

function readLedger(stateRoot: string, runId: string): Record<string, unknown>[] {
  const ledgerPath = join(
    stateRoot,
    'runs',
    `run-${runId}`,
    'authoritative',
    'ledger',
    'events.jsonl',
  );
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeVerify(results: {
  smoke: boolean;
  combined: boolean;
}): { fn: VerifyFunction; calls: Array<{ worktree: string; policy: string; out?: string }> } {
  const calls: Array<{ worktree: string; policy: string; out?: string }> = [];
  const fn: VerifyFunction = (worktree: string, policy: string, out?: string) => {
    calls.push({ worktree, policy, out });
    return out ? results.combined : results.smoke;
  };
  return { fn, calls };
}

function squashRecordPath(fixture: Fixture, taskId: string): string {
  return join(
    fixture.stateRoot,
    'runs',
    `run-${fixture.runId}`,
    'authoritative',
    'results',
    `${taskId}.squash.json`,
  );
}

function hasExitCode(error: unknown, exitCode: number, message: RegExp): boolean {
  return error instanceof IntegrationError
    && error.exitCode === exitCode
    && message.test(error.message);
}

function pathWithMapfileBash(): string {
  const candidates = [
    '/opt/homebrew/bin/bash',
    '/usr/local/bin/bash',
    '/bin/bash',
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'type mapfile'], {
      stdio: 'ignore',
    });
    if (probe.status === 0) {
      return `${dirname(candidate)}:${process.env.PATH ?? ''}`;
    }
  }
  throw new Error('verify.sh tests require Bash with mapfile support');
}

describe('integrate', { concurrency: 1 }, () => {
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
    assert.throws(
      () => integrate('', ['a']),
      (error: unknown) => hasExitCode(error, 1, /usage: integrate/),
    );
  });

  it('throws when no tasks are given', () => {
    assert.throws(
      () => integrate('0018', []),
      (error: unknown) => hasExitCode(error, 1, /no tasks to integrate/),
    );
  });

  it('throws when run.yaml is missing base_commit', () => {
    const fixture = initRepoWithTasks('no-base', []);
    const f = setupState(fixture, 'no-base', []);
    const rDir = join(f.stateRoot, 'runs', `run-${f.runId}`);
    writeFileSync(join(rDir, 'run.yaml'), 'run_id: no-base\n', 'utf8');

    assert.throws(
      () =>
        integrate('no-base', ['a'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: () => true,
        }),
      (error: unknown) => hasExitCode(error, 1, /base_commit not recorded/),
    );
  });

  it('throws when integration worktree already exists', () => {
    const fixture = initRepoWithTasks('existing-wt', [
      { id: 'a', files: { 'a.txt': 'a\n' } },
    ]);
    const f = setupState(fixture, 'existing-wt', ['a']);
    mkdirSync(join(f.worktreeRoot, 'run-existing-wt-integration'), {
      recursive: true,
    });

    assert.throws(
      () =>
        integrate('existing-wt', ['a'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: () => true,
        }),
      (error: unknown) =>
        hasExitCode(error, 1, /integration worktree already exists/),
    );
  });

  it('reports a bare structured error when worktree add fails', () => {
    const fixture = initRepoWithTasks('worktree-add-fail', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'worktree-add-fail', ['alpha']);
    const failingExec: ExecFunction = (file, args) => {
      assert.equal(file, 'git');
      assert.ok(args.includes('worktree'));
      throw new Error('git diagnostic that Bash suppresses');
    };

    assert.throws(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          exec: failingExec,
          verify: () => true,
        }),
      (error: unknown) =>
        error instanceof IntegrationError
        && error.exitCode === 1
        && error.message === 'hydra: error: failed to create integration worktree',
    );
  });

  it('integrates candidates serially and returns the final HEAD', () => {
    const fixture = initRepoWithTasks('happy', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'happy', ['alpha', 'beta']);
    const verify = makeVerify({ smoke: true, combined: true });

    const head = integrate('happy', ['alpha', 'beta'], {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: verify.fn,
    });

    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(verify.calls.length, 3); // 2 smoke + 1 combined
    assert.equal(verify.calls[0].out, undefined);
    assert.equal(verify.calls[1].out, undefined);
    assert.equal(
      verify.calls[2].out,
      join(
        f.stateRoot,
        'runs',
        `run-${f.runId}`,
        'authoritative',
        'verification',
        'combined.json',
      ),
    );

    const wt = join(f.worktreeRoot, `run-${f.runId}-integration`);
    assert.ok(existsSync(join(wt, 'alpha.txt')));
    assert.ok(existsSync(join(wt, 'beta.txt')));

    const events = readLedger(f.stateRoot, f.runId);
    assert.ok(events.find((e) => e.event === 'integration_started'));
    assert.ok(
      events.find(
        (e) => e.event === 'candidate_integrated' && e.task_id === 'alpha',
      ),
    );
    assert.ok(
      events.find(
        (e) => e.event === 'candidate_integrated' && e.task_id === 'beta',
      ),
    );
    assert.ok(
      events.find(
        (e) => e.event === 'combined_verification' && e.status === 'passed',
      ),
    );
  });

  it('uses non-empty verify and smoke policy overrides', () => {
    const fixture = initRepoWithTasks('policy-overrides', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'policy-overrides', ['alpha']);
    const verify = makeVerify({ smoke: true, combined: true });

    process.env.HYDRA_VERIFY_POLICY = '/policy/full.yaml';
    process.env.HYDRA_SMOKE_POLICY = '/policy/smoke.yaml';
    try {
      integrate(f.runId, ['alpha'], {
        cwd: fixture.repoPath,
        stateRoot: f.stateRoot,
        worktreeRoot: f.worktreeRoot,
        verify: verify.fn,
      });
    } finally {
      delete process.env.HYDRA_VERIFY_POLICY;
      delete process.env.HYDRA_SMOKE_POLICY;
    }

    assert.equal(verify.calls[0].policy, '/policy/smoke.yaml');
    assert.equal(verify.calls[1].policy, '/policy/full.yaml');
  });

  it('treats empty policy overrides as unset, matching Bash :- expansion', () => {
    const fixture = initRepoWithTasks('empty-policy-overrides', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'empty-policy-overrides', ['alpha']);
    const verify = makeVerify({ smoke: true, combined: true });

    process.env.HYDRA_VERIFY_POLICY = '';
    process.env.HYDRA_SMOKE_POLICY = '';
    try {
      integrate(f.runId, ['alpha'], {
        cwd: fixture.repoPath,
        stateRoot: f.stateRoot,
        worktreeRoot: f.worktreeRoot,
        verify: verify.fn,
      });
    } finally {
      delete process.env.HYDRA_VERIFY_POLICY;
      delete process.env.HYDRA_SMOKE_POLICY;
    }

    const defaultPolicy = join(
      fixture.repoPath,
      'hydra',
      'policies',
      'verification.yaml',
    );
    assert.equal(verify.calls[0].policy, defaultPolicy);
    assert.equal(verify.calls[1].policy, defaultPolicy);
  });

  it('invokes the real verify.sh for smoke and combined verification', () => {
    const fixture = initRepoWithTasks('real-verify', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'real-verify', ['alpha']);
    const policy = join(TEST_TMP, 'real-verification.yaml');
    writeFileSync(
      policy,
      [
        'verification_policy:',
        '  commands:',
        '    - "test -f alpha.txt"',
        '  timeout_minutes: 1',
        '',
      ].join('\n'),
      'utf8',
    );

    process.env.HYDRA_VERIFY_POLICY = policy;
    process.env.HYDRA_SMOKE_POLICY = policy;
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithMapfileBash();
    try {
      integrate(f.runId, ['alpha'], {
        cwd: fixture.repoPath,
        stateRoot: f.stateRoot,
        worktreeRoot: f.worktreeRoot,
      });
    } finally {
      delete process.env.HYDRA_VERIFY_POLICY;
      delete process.env.HYDRA_SMOKE_POLICY;
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }

    const combined = JSON.parse(
      readFileSync(
        join(
          f.stateRoot,
          'runs',
          `run-${f.runId}`,
          'authoritative',
          'verification',
          'combined.json',
        ),
        'utf8',
      ),
    ) as Array<{ command: string; status: string }>;
    assert.deepEqual(combined, [
      { command: 'test -f alpha.txt', status: 'passed' },
    ]);
  });

  it('stops on textual conflict with exit code 6', () => {
    const fixture = initRepoWithTasks('conflict', [
      { id: 'first', files: { 'shared.txt': 'first\n' } },
      { id: 'second', files: { 'shared.txt': 'second\n' } },
    ]);
    const f = setupState(fixture, 'conflict', ['first', 'second']);
    const verify = makeVerify({ smoke: true, combined: true });

    assert.throws(
      () =>
        integrate('conflict', ['first', 'second'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: verify.fn,
        }),
      (err: Error) => {
        const ie = err as IntegrationError;
        return ie.exitCode === 6 && /textual conflict/.test(err.message);
      },
    );

    const events = readLedger(f.stateRoot, f.runId);
    assert.ok(
      events.find(
        (e) =>
          e.event === 'integration_conflict' &&
          e.task_id === 'second' &&
          e.conflict === 'textual',
      ),
    );
    assert.equal(verify.calls.length, 1); // smoke for first only
  });

  it('maps a textual conflict to process exit code 6 from the CLI', () => {
    const fixture = initRepoWithTasks('cli-conflict', [
      { id: 'first', files: { 'shared.txt': 'first\n' } },
      { id: 'second', files: { 'shared.txt': 'second\n' } },
    ]);
    const f = setupState(fixture, 'cli-conflict', ['first', 'second']);
    const policy = join(TEST_TMP, 'cli-verification.yaml');
    writeFileSync(
      policy,
      'commands:\n  - "test -f shared.txt"\ntimeout_minutes: 1\n',
      'utf8',
    );

    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve(import.meta.dirname, '../src/integrate.ts'),
        f.runId,
        'first',
        'second',
      ],
      {
        cwd: fixture.repoPath,
        encoding: 'utf8',
        env: {
          ...process.env,
          HYDRA_STATE_ROOT: f.stateRoot,
          HYDRA_WORKTREE_ROOT: f.worktreeRoot,
          HYDRA_VERIFY_POLICY: policy,
          HYDRA_SMOKE_POLICY: policy,
          PATH: pathWithMapfileBash(),
        },
      },
    );

    assert.equal(result.status, 6, result.stderr);
    assert.match(result.stderr, /TEXTUAL CONFLICT integrating second/);
  });

  it('fails with exit code 7 when per-candidate smoke fails', () => {
    const fixture = initRepoWithTasks('smoke-fail', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'smoke-fail', ['alpha']);
    const verify = makeVerify({ smoke: false, combined: true });

    assert.throws(
      () =>
        integrate('smoke-fail', ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: verify.fn,
        }),
      (err: Error) => {
        const ie = err as IntegrationError;
        return (
          ie.exitCode === 7 && /per-candidate verification failed/.test(err.message)
        );
      },
    );

    const events = readLedger(f.stateRoot, f.runId);
    assert.ok(
      events.find(
        (e) =>
          e.event === 'integration_candidate_verify_failed' &&
          e.task_id === 'alpha',
      ),
    );
  });

  it('fails with exit code 7 when combined verification fails', () => {
    const fixture = initRepoWithTasks('combined-fail', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'combined-fail', ['alpha', 'beta']);
    const verify = makeVerify({ smoke: true, combined: false });

    assert.throws(
      () =>
        integrate('combined-fail', ['alpha', 'beta'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: verify.fn,
        }),
      (err: Error) => {
        const ie = err as IntegrationError;
        return ie.exitCode === 7 && /combined verification failed/.test(err.message);
      },
    );

    const events = readLedger(f.stateRoot, f.runId);
    assert.ok(
      events.find(
        (e) => e.event === 'combined_verification' && e.status === 'failed',
      ),
    );
  });

  it('throws when a squash record is missing', () => {
    const fixture = initRepoWithTasks('missing-record', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'missing-record', []);

    assert.throws(
      () =>
        integrate('missing-record', ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: () => true,
        }),
      (error: unknown) => hasExitCode(error, 1, /no squash record for alpha/),
    );
  });

  it('reports malformed squash JSON with jq-compatible exit code 5', () => {
    const fixture = initRepoWithTasks('invalid-record', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'invalid-record', ['alpha']);
    writeFileSync(squashRecordPath(f, 'alpha'), '{not json\n', 'utf8');

    assert.throws(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: () => true,
        }),
      (error: unknown) => hasExitCode(error, 5, /malformed JSON/),
    );
  });

  it('treats a missing integration_commit key like jq output null', () => {
    const fixture = initRepoWithTasks('missing-commit-key', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'missing-commit-key', ['alpha']);
    writeFileSync(squashRecordPath(f, 'alpha'), '{}\n', 'utf8');

    assert.throws(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: () => true,
        }),
      (error: unknown) => hasExitCode(error, 6, /textual conflict/),
    );

    const events = readLedger(f.stateRoot, f.runId);
    assert.ok(
      events.find(
        (event) => event.event === 'integration_conflict'
          && event.task_id === 'alpha',
      ),
    );
  });
});
