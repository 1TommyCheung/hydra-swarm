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
import { join, resolve } from 'node:path';
import {
  integrate,
  IntegrationError,
  main,
  parseIntegrateArgs,
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
  const fn: VerifyFunction = async (worktree: string, policy: string, out?: string) => {
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

/** Collect what warn()/log() write, so operator-facing hints can be asserted. */
function captureStderr(): { text: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  process.stderr.write = ((chunk: unknown) => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => buffer,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

function hasExitCode(error: unknown, exitCode: number, message: RegExp): boolean {
  return error instanceof IntegrationError
    && error.exitCode === exitCode
    && message.test(error.message);
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

  it('throws when runId is empty', async () => {
    await assert.rejects(
      () => integrate('', ['a']),
      (error: unknown) => hasExitCode(error, 1, /usage: integrate/),
    );
  });

  it('throws when no tasks are given', async () => {
    await assert.rejects(
      () => integrate('0018', []),
      (error: unknown) => hasExitCode(error, 1, /no tasks to integrate/),
    );
  });

  it('throws when run.yaml is missing base_commit', async () => {
    const fixture = initRepoWithTasks('no-base', []);
    const f = setupState(fixture, 'no-base', []);
    const rDir = join(f.stateRoot, 'runs', `run-${f.runId}`);
    writeFileSync(join(rDir, 'run.yaml'), 'run_id: no-base\n', 'utf8');

    await assert.rejects(
      () =>
        integrate('no-base', ['a'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: async () => true,
        }),
      (error: unknown) => hasExitCode(error, 1, /base_commit not recorded/),
    );
  });

  it('throws when integration worktree already exists', async () => {
    const fixture = initRepoWithTasks('existing-wt', [
      { id: 'a', files: { 'a.txt': 'a\n' } },
    ]);
    const f = setupState(fixture, 'existing-wt', ['a']);
    mkdirSync(join(f.worktreeRoot, 'run-existing-wt-integration'), {
      recursive: true,
    });

    await assert.rejects(
      () =>
        integrate('existing-wt', ['a'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: async () => true,
        }),
      (error: unknown) =>
        hasExitCode(error, 1, /integration worktree already exists/),
    );
  });

  it('reports a bare structured error when worktree add fails', async () => {
    const fixture = initRepoWithTasks('worktree-add-fail', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'worktree-add-fail', ['alpha']);
    const failingExec: ExecFunction = (file, args) => {
      assert.equal(file, 'git');
      assert.ok(args.includes('worktree'));
      throw new Error('git diagnostic that Bash suppresses');
    };

    await assert.rejects(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          exec: failingExec,
          verify: async () => true,
        }),
      (error: unknown) =>
        error instanceof IntegrationError
        && error.exitCode === 1
        && error.message === 'hydra: error: failed to create integration worktree',
    );
  });

  it('integrates candidates serially and returns the final HEAD', async () => {
    const fixture = initRepoWithTasks('happy', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'happy', ['alpha', 'beta']);
    const verify = makeVerify({ smoke: true, combined: true });

    const head = await integrate('happy', ['alpha', 'beta'], {
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

  it('uses non-empty verify and smoke policy overrides', async () => {
    const fixture = initRepoWithTasks('policy-overrides', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'policy-overrides', ['alpha']);
    const verify = makeVerify({ smoke: true, combined: true });

    process.env.HYDRA_VERIFY_POLICY = '/policy/full.yaml';
    process.env.HYDRA_SMOKE_POLICY = '/policy/smoke.yaml';
    try {
      await integrate(f.runId, ['alpha'], {
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

  it('treats empty policy overrides as unset, matching Bash :- expansion', async () => {
    const fixture = initRepoWithTasks('empty-policy-overrides', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'empty-policy-overrides', ['alpha']);
    const verify = makeVerify({ smoke: true, combined: true });

    process.env.HYDRA_VERIFY_POLICY = '';
    process.env.HYDRA_SMOKE_POLICY = '';
    try {
      await integrate(f.runId, ['alpha'], {
        cwd: fixture.repoPath,
        stateRoot: f.stateRoot,
        worktreeRoot: f.worktreeRoot,
        verify: verify.fn,
      });
    } finally {
      delete process.env.HYDRA_VERIFY_POLICY;
      delete process.env.HYDRA_SMOKE_POLICY;
    }

    const defaultPolicy = resolve(
      import.meta.dirname,
      '..',
      '..',
      'hydra',
      'policies',
      'verification.yaml',
    );
    assert.equal(verify.calls[0].policy, defaultPolicy);
    assert.equal(verify.calls[1].policy, defaultPolicy);
  });

  it('invokes the native TS verify for smoke and combined verification', async () => {
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
    try {
      await integrate(f.runId, ['alpha'], {
        cwd: fixture.repoPath,
        stateRoot: f.stateRoot,
        worktreeRoot: f.worktreeRoot,
      });
    } finally {
      delete process.env.HYDRA_VERIFY_POLICY;
      delete process.env.HYDRA_SMOKE_POLICY;
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

  it('stops on textual conflict with exit code 6', async () => {
    const fixture = initRepoWithTasks('conflict', [
      { id: 'first', files: { 'shared.txt': 'first\n' } },
      { id: 'second', files: { 'shared.txt': 'second\n' } },
    ]);
    const f = setupState(fixture, 'conflict', ['first', 'second']);
    const verify = makeVerify({ smoke: true, combined: true });

    await assert.rejects(
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

  it('hints at a base/target mismatch when conflicting on the frozen base', async () => {
    const fixture = initRepoWithTasks('conflict-hint', [
      { id: 'first', files: { 'shared.txt': 'first\n' } },
      { id: 'second', files: { 'shared.txt': 'second\n' } },
    ]);
    const f = setupState(fixture, 'conflict-hint', ['first', 'second']);
    const stderr = captureStderr();

    try {
      await assert.rejects(
        () =>
          integrate(f.runId, ['first', 'second'], {
            cwd: fixture.repoPath,
            stateRoot: f.stateRoot,
            worktreeRoot: f.worktreeRoot,
            verify: async () => true,
          }),
        (error: unknown) => hasExitCode(error, 6, /textual conflict/),
      );
    } finally {
      stderr.restore();
    }

    assert.match(stderr.text(), /TEXTUAL CONFLICT integrating second/);
    assert.match(stderr.text(), /BASE\/TARGET MISMATCH/);
    assert.match(stderr.text(), new RegExp(`frozen base_commit ${f.baseCommit}`));
    assert.match(
      stderr.text(),
      new RegExp(`integrate\\.sh ${f.runId} --onto <current-target> first second`),
    );
  });

  it('omits the base/target hint when an explicit --onto was given', async () => {
    const fixture = initRepoWithTasks('conflict-hint-onto', [
      { id: 'first', files: { 'shared.txt': 'first\n' } },
      { id: 'second', files: { 'shared.txt': 'second\n' } },
    ]);
    const f = setupState(fixture, 'conflict-hint-onto', ['first', 'second']);
    const stderr = captureStderr();

    try {
      await assert.rejects(
        () =>
          integrate(f.runId, ['first', 'second'], {
            cwd: fixture.repoPath,
            stateRoot: f.stateRoot,
            worktreeRoot: f.worktreeRoot,
            onto: f.baseCommit,
            verify: async () => true,
          }),
        (error: unknown) => hasExitCode(error, 6, /textual conflict/),
      );
    } finally {
      stderr.restore();
    }

    // The operator already chose the target: a conflict here is a content
    // clash, and repeating the retry advice would send them in a circle.
    assert.match(stderr.text(), /TEXTUAL CONFLICT integrating second/);
    assert.doesNotMatch(stderr.text(), /BASE\/TARGET MISMATCH/);
  });

  it('maps a textual conflict to process exit code 6 from the CLI', async () => {
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
        },
      },
    );

    assert.equal(result.status, 6, result.stderr);
    assert.match(result.stderr, /TEXTUAL CONFLICT integrating second/);
    assert.match(result.stderr, /BASE\/TARGET MISMATCH/);
    assert.match(result.stderr, /--onto <current-target>/);
  });

  it('accepts --onto from the CLI, before the positional run_id', async () => {
    const fixture = initRepoWithTasks('cli-onto', [
      { id: 'first', files: { 'shared.txt': 'first\n' } },
      { id: 'second', files: { 'shared.txt': 'second\n' } },
    ]);
    const f = setupState(fixture, 'cli-onto', ['first', 'second']);
    const policy = join(TEST_TMP, 'cli-onto-verification.yaml');
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
        '--onto',
        f.baseCommit,
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
        },
      },
    );

    // The flag was consumed, so 'first'/'second' were still read as task ids
    // (a mis-parse would have made the run id 'first' and failed differently).
    assert.equal(result.status, 6, result.stderr);
    assert.match(result.stderr, /TEXTUAL CONFLICT integrating second/);
    assert.doesNotMatch(result.stderr, /BASE\/TARGET MISMATCH/);
  });

  it('fails with exit code 7 when per-candidate smoke fails', async () => {
    const fixture = initRepoWithTasks('smoke-fail', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'smoke-fail', ['alpha']);
    const verify = makeVerify({ smoke: false, combined: true });

    await assert.rejects(
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

  it('fails with exit code 7 when combined verification fails', async () => {
    const fixture = initRepoWithTasks('combined-fail', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'combined-fail', ['alpha', 'beta']);
    const verify = makeVerify({ smoke: true, combined: false });

    await assert.rejects(
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

  it('throws when a squash record is missing', async () => {
    const fixture = initRepoWithTasks('missing-record', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'missing-record', []);

    await assert.rejects(
      () =>
        integrate('missing-record', ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: async () => true,
        }),
      (error: unknown) => hasExitCode(error, 1, /no squash record for alpha/),
    );
  });

  it('reports malformed squash JSON with jq-compatible exit code 5', async () => {
    const fixture = initRepoWithTasks('invalid-record', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'invalid-record', ['alpha']);
    writeFileSync(squashRecordPath(f, 'alpha'), '{not json\n', 'utf8');

    await assert.rejects(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: async () => true,
        }),
      (error: unknown) => hasExitCode(error, 5, /malformed JSON/),
    );
  });

  it('treats a missing integration_commit key like jq output null', async () => {
    const fixture = initRepoWithTasks('missing-commit-key', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'missing-commit-key', ['alpha']);
    writeFileSync(squashRecordPath(f, 'alpha'), '{}\n', 'utf8');

    await assert.rejects(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: async () => true,
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

  // --- issue #39: squash record produced from a superseded promoted head ----

  function promotedResultPath(f: Fixture, taskId: string): string {
    return join(
      f.stateRoot,
      'runs',
      `run-${f.runId}`,
      'authoritative',
      'results',
      `${taskId}.json`,
    );
  }

  function writePromotedHead(f: Fixture, taskId: string, headCommit: string): void {
    writeFileSync(
      promotedResultPath(f, taskId),
      `${JSON.stringify({ claims: { head_commit: headCommit } })}\n`,
      'utf8',
    );
  }

  function writeSquashRecord(
    f: Fixture,
    taskId: string,
    integrationCommit: string,
    candidateHead: string,
  ): void {
    writeFileSync(
      squashRecordPath(f, taskId),
      `${JSON.stringify({
        candidate_head: candidateHead,
        integration_commit: integrationCommit,
        source_commits: [candidateHead],
      })}\n`,
      'utf8',
    );
  }

  it('refuses a squash record whose candidate_head is not the promoted head', async () => {
    const fixture = initRepoWithTasks('stale-squash-record', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'stale-squash-record', ['alpha']);
    const staleHead = fixture.taskCommits.alpha;
    writeSquashRecord(f, 'alpha', staleHead, staleHead);
    // The task was re-promoted after an amendment: the authoritative result
    // now names a head the squash record knows nothing about.
    const amendedHead = 'a'.repeat(40);
    writePromotedHead(f, 'alpha', amendedHead);

    await assert.rejects(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: async () => true,
        }),
      (error: unknown) => {
        assert.ok(hasExitCode(error, 1, /stale squash record for alpha/));
        const message = (error as IntegrationError).message;
        assert.ok(message.includes(staleHead), 'names the recorded candidate head');
        assert.ok(message.includes(amendedHead), 'names the current promoted head');
        assert.match(message, /re-run squash/i);
        return true;
      },
    );

    // Refused as a precondition: the integration worktree and branch were
    // never created, so the remedy the message gives (re-squash, re-run
    // integrate) works as written instead of tripping over its own debris.
    const wt = join(f.worktreeRoot, `run-${f.runId}-integration`);
    assert.equal(existsSync(wt), false, 'leaves no integration worktree behind');
    assert.equal(
      git(fixture.repoPath, ['branch', '--list', `hydra-integration/${f.runId}`]),
      '',
      'leaves no integration branch behind',
    );
    assert.equal(existsSync(join(wt, 'alpha.txt')), false);
    const events = readLedger(f.stateRoot, f.runId);
    assert.equal(
      events.some((event) => event.event === 'candidate_integrated'),
      false,
    );
    assert.equal(
      events.some((event) => event.event === 'integration_started'),
      false,
      'refuses before the run is marked started',
    );
  });

  it('integrates on the retry after the refused record is re-squashed', async () => {
    const fixture = initRepoWithTasks('stale-then-resquash', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'stale-then-resquash', ['alpha']);
    const head = fixture.taskCommits.alpha;
    writeSquashRecord(f, 'alpha', head, 'c'.repeat(40));
    writePromotedHead(f, 'alpha', head);

    await assert.rejects(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          verify: async () => true,
        }),
      (error: unknown) => hasExitCode(error, 1, /stale squash record for alpha/),
    );

    // The operator does exactly what the message says — re-squash — and
    // re-runs integrate. No manual worktree/branch cleanup in between.
    writeSquashRecord(f, 'alpha', head, head);

    const integrated = await integrate(f.runId, ['alpha'], {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    });

    assert.match(integrated, /^[0-9a-f]{40}$/);
    assert.ok(existsSync(join(f.worktreeRoot, `run-${f.runId}-integration`, 'alpha.txt')));
  });

  it('integrates when the squash record matches the current promoted head', async () => {
    const fixture = initRepoWithTasks('fresh-squash-record', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'fresh-squash-record', ['alpha']);
    const head = fixture.taskCommits.alpha;
    writeSquashRecord(f, 'alpha', head, head);
    writePromotedHead(f, 'alpha', head);

    const integrated = await integrate(f.runId, ['alpha'], {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    });

    assert.match(integrated, /^[0-9a-f]{40}$/);
    assert.ok(existsSync(join(f.worktreeRoot, `run-${f.runId}-integration`, 'alpha.txt')));
  });

  it('accepts an abbreviated promoted head that resolves to the recorded head', async () => {
    const fixture = initRepoWithTasks('abbrev-promoted-head', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'abbrev-promoted-head', ['alpha']);
    const head = fixture.taskCommits.alpha;
    writeSquashRecord(f, 'alpha', head, head);
    writePromotedHead(f, 'alpha', head.slice(0, 12));

    await integrate(f.runId, ['alpha'], {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    });

    assert.ok(existsSync(join(f.worktreeRoot, `run-${f.runId}-integration`, 'alpha.txt')));
  });

  it('integrates a legacy record with no candidate_head, unchecked', async () => {
    const fixture = initRepoWithTasks('legacy-squash-record', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    // setupState writes the historical record shape: integration_commit only.
    const f = setupState(fixture, 'legacy-squash-record', ['alpha']);
    writePromotedHead(f, 'alpha', 'b'.repeat(40));

    await integrate(f.runId, ['alpha'], {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    });

    assert.ok(existsSync(join(f.worktreeRoot, `run-${f.runId}-integration`, 'alpha.txt')));
  });

  // --- issue #22: one integrate call per task, and an explicit target --------

  function intWorktreeOf(f: Fixture): string {
    return join(f.worktreeRoot, `run-${f.runId}-integration`);
  }

  function startEvents(f: Fixture): Record<string, unknown>[] {
    return readLedger(f.stateRoot, f.runId)
      .filter((event) => event.event === 'integration_started');
  }

  it('reuses a clean integration worktree on a second call for the same run', async () => {
    const fixture = initRepoWithTasks('incremental', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'incremental', ['alpha', 'beta']);
    const options = {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    };

    // The real pattern: alpha clears review and is integrated; beta clears
    // review later and is integrated by a second, separate call.
    const first = await integrate(f.runId, ['alpha'], options);
    const second = await integrate(f.runId, ['beta'], options);

    assert.notEqual(first, second);
    assert.equal(
      git(fixture.repoPath, ['rev-parse', `${second}^`]),
      first,
      'the second call built on the first call\'s tip, not on the frozen base',
    );

    const wt = intWorktreeOf(f);
    assert.ok(existsSync(join(wt, 'alpha.txt')), 'keeps the first call\'s work');
    assert.ok(existsSync(join(wt, 'beta.txt')));

    const starts = startEvents(f);
    assert.equal(starts.length, 2);
    assert.equal(starts[0].base_mode, 'run-yaml-base');
    assert.equal(starts[0].base_commit, f.baseCommit);
    assert.equal(starts[1].base_mode, 'existing-branch');
    assert.equal(starts[1].base_commit, first);
  });

  it('reuses the integration branch when its worktree was removed by hand', async () => {
    const fixture = initRepoWithTasks('branch-without-worktree', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'branch-without-worktree', ['alpha', 'beta']);
    const options = {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    };

    const first = await integrate(f.runId, ['alpha'], options);
    // The historical workaround left the branch but no worktree.
    git(fixture.repoPath, ['worktree', 'remove', '--force', intWorktreeOf(f)]);
    assert.equal(existsSync(intWorktreeOf(f)), false);

    const second = await integrate(f.runId, ['beta'], options);

    assert.equal(git(fixture.repoPath, ['rev-parse', `${second}^`]), first);
    assert.ok(existsSync(join(intWorktreeOf(f), 'alpha.txt')));
    assert.ok(existsSync(join(intWorktreeOf(f), 'beta.txt')));
    assert.equal(startEvents(f)[1].base_mode, 'existing-branch');
  });

  it('refuses to reuse a worktree with a suspended cherry-pick', async () => {
    const fixture = initRepoWithTasks('stuck-cherry-pick', [
      { id: 'first', files: { 'shared.txt': 'first\n' } },
      { id: 'second', files: { 'shared.txt': 'second\n' } },
    ]);
    const f = setupState(fixture, 'stuck-cherry-pick', ['first', 'second']);
    const options = {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    };
    await integrate(f.runId, ['first'], options);

    const wt = intWorktreeOf(f);
    let conflicted = false;
    try {
      git(wt, ['cherry-pick', fixture.taskCommits.second]);
    } catch {
      conflicted = true;
    }
    assert.ok(conflicted, 'setup: the hand-run cherry-pick must have conflicted');

    await assert.rejects(
      () => integrate(f.runId, ['second'], options),
      (error: unknown) => {
        assert.ok(hasExitCode(error, 1, /NOT safely reusable/));
        const message = (error as IntegrationError).message;
        assert.ok(message.includes(wt), 'names the worktree to inspect');
        assert.match(message, /cherry-pick is still in progress/);
        assert.match(message, /CHERRY_PICK_HEAD/);
        assert.match(message, /NOT a content conflict/);
        return true;
      },
    );

    // The operator's suspended state is untouched, and nothing was integrated.
    assert.ok(existsSync(join(wt, '.git')));
    assert.equal(
      readLedger(f.stateRoot, f.runId).some(
        (event) => event.event === 'candidate_integrated' && event.task_id === 'second',
      ),
      false,
    );
    assert.equal(startEvents(f).length, 1, 'the refused call never started');
    git(wt, ['cherry-pick', '--abort']);
  });

  it('refuses to reuse a worktree with uncommitted changes', async () => {
    const fixture = initRepoWithTasks('dirty-integration-wt', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'dirty-integration-wt', ['alpha', 'beta']);
    const options = {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    };
    await integrate(f.runId, ['alpha'], options);

    const wt = intWorktreeOf(f);
    writeFileSync(join(wt, 'alpha.txt'), 'hand-edited\n', 'utf8');

    await assert.rejects(
      () => integrate(f.runId, ['beta'], options),
      (error: unknown) => {
        assert.ok(hasExitCode(error, 1, /NOT safely reusable/));
        assert.match(
          (error as IntegrationError).message,
          /uncommitted changes to tracked files/,
        );
        return true;
      },
    );

    assert.equal(
      readFileSync(join(wt, 'alpha.txt'), 'utf8'),
      'hand-edited\n',
      'never discards the operator\'s edit',
    );
    assert.equal(existsSync(join(wt, 'beta.txt')), false);
  });

  it('refuses a stale squash record before inspecting an unusable worktree', async () => {
    const fixture = initRepoWithTasks('freshness-first', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'freshness-first', ['alpha']);
    writeSquashRecord(f, 'alpha', fixture.taskCommits.alpha, fixture.taskCommits.alpha);
    writePromotedHead(f, 'alpha', 'a'.repeat(40));
    mkdirSync(intWorktreeOf(f), { recursive: true });

    // Freshness is still the first precondition in every path — the worktree
    // decision (reuse, refuse, or --onto) never runs ahead of it.
    await assert.rejects(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          onto: f.baseCommit,
          verify: async () => true,
        }),
      (error: unknown) => hasExitCode(error, 1, /stale squash record for alpha/),
    );
  });

  it('starts from --onto instead of the frozen run.yaml base', async () => {
    const fixture = initRepoWithTasks('onto-fresh', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    // The target advanced past the base the run froze at run-init time.
    git(fixture.repoPath, ['checkout', '-b', 'advanced', fixture.baseCommit]);
    writeFileSync(join(fixture.repoPath, 'advanced.txt'), 'advanced\n', 'utf8');
    git(fixture.repoPath, ['add', 'advanced.txt']);
    git(fixture.repoPath, ['commit', '-m', 'work merged after run-init']);
    const advanced = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    git(fixture.repoPath, ['checkout', fixture.baseCommit]);

    const f = setupState(fixture, 'onto-fresh', ['alpha']);
    const head = await integrate(f.runId, ['alpha'], {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      onto: advanced,
      verify: async () => true,
    });

    assert.equal(git(fixture.repoPath, ['rev-parse', `${head}^`]), advanced);
    const wt = intWorktreeOf(f);
    assert.ok(existsSync(join(wt, 'advanced.txt')), 'carries the newer target');
    assert.ok(existsSync(join(wt, 'alpha.txt')));
    assert.equal(startEvents(f)[0].base_mode, 'onto');
    assert.equal(startEvents(f)[0].base_commit, advanced);
  });

  it('resets an otherwise reusable integration branch onto --onto', async () => {
    const fixture = initRepoWithTasks('onto-reset', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
      { id: 'beta', files: { 'beta.txt': 'beta\n' } },
    ]);
    const f = setupState(fixture, 'onto-reset', ['alpha', 'beta']);
    const options = {
      cwd: fixture.repoPath,
      stateRoot: f.stateRoot,
      worktreeRoot: f.worktreeRoot,
      verify: async () => true,
    };
    await integrate(f.runId, ['alpha'], options);

    const head = await integrate(f.runId, ['beta'], {
      ...options,
      onto: f.baseCommit,
    });

    // --onto outranks reuse: the branch restarts from the given commit.
    assert.equal(git(fixture.repoPath, ['rev-parse', `${head}^`]), f.baseCommit);
    assert.equal(
      git(fixture.repoPath, ['rev-parse', `hydra-integration/${f.runId}`]),
      head,
      'the reset moved the branch, not just the worktree',
    );
    const wt = intWorktreeOf(f);
    assert.equal(existsSync(join(wt, 'alpha.txt')), false);
    assert.ok(existsSync(join(wt, 'beta.txt')));
    assert.equal(startEvents(f)[1].base_mode, 'onto');
  });

  it('refuses an --onto commit that cannot be resolved', async () => {
    const fixture = initRepoWithTasks('onto-unresolvable', [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    const f = setupState(fixture, 'onto-unresolvable', ['alpha']);

    await assert.rejects(
      () =>
        integrate(f.runId, ['alpha'], {
          cwd: fixture.repoPath,
          stateRoot: f.stateRoot,
          worktreeRoot: f.worktreeRoot,
          onto: 'no-such-ref',
          verify: async () => true,
        }),
      (error: unknown) =>
        hasExitCode(error, 1, /--onto commit cannot be resolved.*no-such-ref/),
    );

    assert.equal(existsSync(intWorktreeOf(f)), false);
    assert.equal(
      git(fixture.repoPath, ['branch', '--list', `hydra-integration/${f.runId}`]),
      '',
    );
  });

  it('parses --onto out of the argument list before the positionals', () => {
    assert.deepEqual(parseIntegrateArgs(['0068', 'alpha', 'beta']), {
      onto: undefined,
      positionals: ['0068', 'alpha', 'beta'],
    });
    assert.deepEqual(parseIntegrateArgs(['--onto', 'abc123', '0068', 'alpha']), {
      onto: 'abc123',
      positionals: ['0068', 'alpha'],
    });
    assert.deepEqual(parseIntegrateArgs(['0068', '--onto', 'abc123', 'alpha']), {
      onto: 'abc123',
      positionals: ['0068', 'alpha'],
    });
  });

  it('rejects a valueless --onto and unknown options', () => {
    assert.throws(
      () => parseIntegrateArgs(['0068', 'alpha', '--onto']),
      (error: unknown) => hasExitCode(error, 1, /--onto requires a commit argument/),
    );
    assert.throws(
      () => parseIntegrateArgs(['--onto', '--json', '0068', 'alpha']),
      (error: unknown) => hasExitCode(error, 1, /--onto requires a commit argument/),
    );
    assert.throws(
      () => parseIntegrateArgs(['--nope', '0068', 'alpha']),
      (error: unknown) => hasExitCode(error, 1, /unknown option --nope/),
    );
  });

  // --- CLI entry point -----------------------------------------------------
  //
  // These exercise main() with raw argv, which is the only thing integrate.sh
  // ever calls. Testing parseIntegrateArgs() in isolation and integrate() with
  // an `{ onto }` options object — as everything above does — leaves the wiring
  // BETWEEN them uncovered: a main() that never called the parser would pass
  // every one of those tests while `integrate.sh <run> --onto <sha> <task>`
  // died with "no squash record for --onto", the literal flag having been read
  // as a task id. That is the gap these close.

  /** A verification policy that passes in any worktree. */
  function trivialPolicy(name: string): string {
    const policy = join(TEST_TMP, `${name}-verification.yaml`);
    writeFileSync(policy, 'commands:\n  - "true"\ntimeout_minutes: 1\n', 'utf8');
    return policy;
  }

  /**
   * Call the CLI entry point the way integrate.sh does: raw argv in, exit code
   * out, no injected options. main() resolves the repository from the process
   * cwd and its roots from the environment, so both are pointed at the fixture
   * and restored afterwards.
   */
  async function runMain(f: Fixture, argv: string[]): Promise<number> {
    const originalCwd = process.cwd();
    const saved = {
      state: process.env.HYDRA_STATE_ROOT,
      worktrees: process.env.HYDRA_WORKTREE_ROOT,
      verify: process.env.HYDRA_VERIFY_POLICY,
      smoke: process.env.HYDRA_SMOKE_POLICY,
    };
    const policy = trivialPolicy(f.runId);
    process.chdir(f.repoPath);
    process.env.HYDRA_STATE_ROOT = f.stateRoot;
    process.env.HYDRA_WORKTREE_ROOT = f.worktreeRoot;
    process.env.HYDRA_VERIFY_POLICY = policy;
    process.env.HYDRA_SMOKE_POLICY = policy;
    try {
      return await main(argv);
    } finally {
      process.chdir(originalCwd);
      for (const [key, value] of [
        ['HYDRA_STATE_ROOT', saved.state],
        ['HYDRA_WORKTREE_ROOT', saved.worktrees],
        ['HYDRA_VERIFY_POLICY', saved.verify],
        ['HYDRA_SMOKE_POLICY', saved.smoke],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  /** A fixture whose real target has moved past the run's frozen base. */
  function fixtureWithAdvancedTarget(
    name: string,
  ): { fixture: ReturnType<typeof initRepoWithTasks>; advanced: string } {
    const fixture = initRepoWithTasks(name, [
      { id: 'alpha', files: { 'alpha.txt': 'alpha\n' } },
    ]);
    git(fixture.repoPath, ['checkout', '-b', 'advanced', fixture.baseCommit]);
    writeFileSync(join(fixture.repoPath, 'advanced.txt'), 'advanced\n', 'utf8');
    git(fixture.repoPath, ['add', 'advanced.txt']);
    git(fixture.repoPath, ['commit', '-m', 'work merged after run-init']);
    const advanced = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    git(fixture.repoPath, ['checkout', fixture.baseCommit]);
    return { fixture, advanced };
  }

  function assertIntegratedOnto(f: Fixture, advanced: string): void {
    const head = git(f.repoPath, ['rev-parse', `hydra-integration/${f.runId}`]);
    assert.equal(
      git(f.repoPath, ['rev-parse', `${head}^`]),
      advanced,
      'the task was cherry-picked onto the --onto commit',
    );
    assert.equal(startEvents(f)[0].base_mode, 'onto');
    assert.equal(startEvents(f)[0].base_commit, advanced);
    const wt = intWorktreeOf(f);
    assert.ok(existsSync(join(wt, 'advanced.txt')), 'carries the newer target');
    assert.ok(existsSync(join(wt, 'alpha.txt')), 'carries the integrated task');
  }

  it('integrates through main() with --onto BETWEEN the run_id and the task_id', async () => {
    // The exact shape the operator typed when this surfaced:
    //   integrate.sh <run_id> --onto <commit> <task_id>
    const { fixture, advanced } = fixtureWithAdvancedTarget('main-onto-between');
    const f = setupState(fixture, 'main-onto-between', ['alpha']);

    const code = await runMain(f, [f.runId, '--onto', advanced, 'alpha']);

    // Before main() consulted parseIntegrateArgs this was exit 1 with
    // "no squash record for --onto (run squash.sh first)".
    assert.equal(code, 0);
    assertIntegratedOnto(f, advanced);
  });

  it('integrates through main() with --onto BEFORE the run_id', async () => {
    // parseIntegrateArgs is order-independent; main() must not put an ordering
    // assumption back in front of it.
    const { fixture, advanced } = fixtureWithAdvancedTarget('main-onto-before');
    const f = setupState(fixture, 'main-onto-before', ['alpha']);

    const code = await runMain(f, ['--onto', advanced, f.runId, 'alpha']);

    assert.equal(code, 0);
    assertIntegratedOnto(f, advanced);
  });

  it('integrates through main() with --onto AFTER the task_ids', async () => {
    const { fixture, advanced } = fixtureWithAdvancedTarget('main-onto-after');
    const f = setupState(fixture, 'main-onto-after', ['alpha']);

    const code = await runMain(f, [f.runId, 'alpha', '--onto', advanced]);

    assert.equal(code, 0);
    assertIntegratedOnto(f, advanced);
  });

  it('leaves the default main() path on run.yaml\'s frozen base', async () => {
    // The flagless invocation must keep behaving exactly as it always did.
    const { fixture } = fixtureWithAdvancedTarget('main-no-onto');
    const f = setupState(fixture, 'main-no-onto', ['alpha']);

    const code = await runMain(f, [f.runId, 'alpha']);

    assert.equal(code, 0);
    const head = git(f.repoPath, ['rev-parse', `hydra-integration/${f.runId}`]);
    assert.equal(git(f.repoPath, ['rev-parse', `${head}^`]), f.baseCommit);
    assert.equal(startEvents(f)[0].base_mode, 'run-yaml-base');
    assert.equal(
      existsSync(join(intWorktreeOf(f), 'advanced.txt')),
      false,
      'the frozen base predates the advanced target',
    );
  });

  it('surfaces a bad --onto from main() as an exit code, not a bogus task id', async () => {
    const { fixture } = fixtureWithAdvancedTarget('main-onto-bad');
    const f = setupState(fixture, 'main-onto-bad', ['alpha']);

    assert.equal(await runMain(f, [f.runId, '--onto', 'no-such-ref', 'alpha']), 1);
    assert.equal(existsSync(intWorktreeOf(f)), false);

    // A valueless --onto is a usage error from the parser, never a task id.
    assert.equal(await runMain(f, [f.runId, 'alpha', '--onto']), 1);
    assert.equal(await runMain(f, ['--nope', f.runId, 'alpha']), 1);
  });
});
