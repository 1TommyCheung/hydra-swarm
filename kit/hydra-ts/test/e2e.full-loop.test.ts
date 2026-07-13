// End-to-end full-loop test: REAL dispatch -> promote -> squash -> integrate
// with a STUB offline vendor adapter. Zero real vendor API calls.
//
// Modeled on e2e.smoke.test.ts (one shared state root + scratch git repo, no
// mocks) but goes further: dispatch() spawns the REAL hydra/adapters/stub.sh as
// a child process (legitimate — stub.sh is offline and fast, so dispatch's
// process-launch, keep-alive timeout, and exit-sentinel machinery gets real
// coverage). The resulting inbox drop is then promoted, squashed, and integrated
// through the real TS modules, verifying a byte-for-byte identical tree to the
// stub's commit. Negative cases exercise distinct no_commit and not_completed
// rejection gates using drops whose Git fields came from the scratch repo.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dispatch } from '../src/dispatch.ts';
import { promote, PromoteError } from '../src/promote.ts';
import { squash } from '../src/squash.ts';
import { integrate } from '../src/integrate.ts';
import { runInit } from '../src/run-init.ts';

const REAL_REPO = join(import.meta.dirname, '..', '..');
const STUB_ADAPTER = join(REAL_REPO, 'hydra', 'adapters', 'stub.sh');
const E2E_ROOT = join(tmpdir(), `hydra-fullloop-${process.pid}`);
const STATE = join(E2E_ROOT, 'state');
const INT_WT_ROOT = join(E2E_ROOT, 'int-worktrees');

const RUN_HAPPY = 'fl01';
const RUN_NO_COMMIT = 'fl02';
const RUN_FAIL = 'fl03';
const RUN_HAPPY_TS = 'flt01';
const RUN_NO_COMMIT_TS = 'flt02';
const RUN_FAIL_TS = 'flt03';
const TASK = 'stubtask';

let saved: Record<string, string | undefined> = {};
let schemaPath: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

interface RunCtx {
  runId: string;
  taskId: string;
  worktree: string;
  base: string;
  branch: string;
  agentRunId: string;
  dropPath: string;
  sessionPath: string;
  slotPath: string;
}

interface StubDrop {
  status: 'completed' | 'failed';
  vendor: string;
  branch: string;
  base_commit: string;
  head_commit: string;
  files_changed: string[];
}

function setupRun(label: string, runId: string): RunCtx {
  const worktree = join(E2E_ROOT, label, 'repo');
  mkdirSync(worktree, { recursive: true });
  git(['init', '-q', '-b', 'main'], worktree);
  git(['config', 'user.email', 'fullloop@hydra.test'], worktree);
  git(['config', 'user.name', 'Full Loop E2E'], worktree);
  writeFileSync(join(worktree, 'base.txt'), 'base\n');
  git(['add', '.'], worktree);
  git(['commit', '-qm', 'base'], worktree);
  const base = git(['rev-parse', 'HEAD'], worktree);

  const branch = `hydra/full-loop/${label}`;
  git(['checkout', '-qb', branch], worktree);

  const runDirPath = runInit(runId, base);
  const taskSpec = join(runDirPath, 'tasks', `${TASK}.yaml`);
  writeFileSync(
    taskSpec,
    [
      `task_id: ${TASK}`,
      `run_id: ${runId}`,
      'spec_version: 1',
      `base_commit: ${base}`,
      `worktree: ${worktree}`,
      `branch: ${branch}`,
      'assigned_vendor: stub',
      'timeout_minutes: 1',
      'writable_paths:',
      '  - stub-output.txt',
      'objective: >',
      `  Full-loop e2e (${label}).`,
      '',
    ].join('\n'),
  );

  const agentRunId = `${runId}-${TASK}-v1`;
  const dropPath = join(runDirPath, 'inbox', agentRunId, 'result.json');
  const sessionPath = join(runDirPath, 'sessions', `${agentRunId}.json`);
  const slotPath = join(runDirPath, '.slots', agentRunId);
  return {
    runId,
    taskId: TASK,
    worktree,
    base,
    branch,
    agentRunId,
    dropPath,
    sessionPath,
    slotPath,
  };
}

function dispatchEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C',
    ...extra,
  };
}

async function dispatchStub(
  ctx: RunCtx,
  extraEnv: Record<string, string> = {},
): Promise<StubDrop> {
  // Deliberately do not pass DispatchOptions.spawn: this must use dispatch.ts's
  // real node:child_process spawn implementation and executable adapter path.
  const handle = await dispatch(ctx.runId, ctx.taskId, {
    stateRoot: STATE,
    repoRoot: REAL_REPO,
    cwd: REAL_REPO,
    env: dispatchEnv(extraEnv),
    noSignals: true,
    pollIntervalMs: 50,
  });
  await handle.finished;

  assert.equal(handle.agentRunId, ctx.agentRunId);
  assert.ok(existsSync(ctx.dropPath), 'real stub child must produce an inbox drop');
  assert.ok(existsSync(ctx.sessionPath), 'real stub child must produce a session record');
  assert.equal(existsSync(ctx.slotPath), false, 'dispatch slot must be released after child exit');
  return JSON.parse(readFileSync(ctx.dropPath, 'utf8')) as StubDrop;
}

async function dispatchStubTs(
  ctx: RunCtx,
  extraEnv: Record<string, string> = {},
): Promise<StubDrop> {
  // TS-native path: dispatch must spawn `node --experimental-strip-types
  // adapter-stub.ts` (ZERO bash processes for the adapter step). The recorder
  // asserts that contract while still delegating to the real child_process
  // spawn so the actual adapter runs end to end.
  const spawned: Array<{ command: string; args: string[] }> = [];
  const handle = await dispatch(ctx.runId, ctx.taskId, {
    stateRoot: STATE,
    repoRoot: REAL_REPO,
    cwd: REAL_REPO,
    env: {
      ...dispatchEnv(extraEnv),
      HYDRA_ADAPTER_RUNTIME: 'ts',
    },
    noSignals: true,
    pollIntervalMs: 50,
    spawn: (command, args, options) => {
      spawned.push({ command, args });
      return spawn(command, args, options as Parameters<typeof spawn>[2]);
    },
  });
  await handle.finished;

  assert.ok(spawned.length >= 1, 'TS dispatch must spawn the adapter child process');
  for (const entry of spawned) {
    assert.equal(
      entry.command,
      'node',
      `TS adapter step must spawn only node, got: ${entry.command}`,
    );
    const argv = entry.args.join(' ');
    assert.match(argv, /adapter-stub\.ts/, 'TS adapter step must spawn adapter-stub.ts');
    assert.doesNotMatch(
      argv,
      /adapters[\\/]stub\.sh/,
      'TS adapter step must not reference the bash stub.sh',
    );
  }

  assert.equal(handle.agentRunId, ctx.agentRunId);
  assert.ok(existsSync(ctx.dropPath), 'TS stub child must produce an inbox drop');
  assert.ok(existsSync(ctx.sessionPath), 'TS stub child must produce a session record');
  assert.equal(existsSync(ctx.slotPath), false, 'dispatch slot must be released after child exit');
  return JSON.parse(readFileSync(ctx.dropPath, 'utf8')) as StubDrop;
}

async function assertPromoteRejected(
  ctx: RunCtx,
  reason: 'no_commit' | 'not_completed',
): Promise<void> {
  let verificationCalls = 0;
  await assert.rejects(
    promote(ctx.runId, ctx.taskId, ctx.dropPath, {
      cwd: REAL_REPO,
      stateRoot: STATE,
      schema: schemaPath,
      verify: async () => {
        verificationCalls += 1;
        return [{ command: 'must not run', status: 'passed' as const }];
      },
    }),
    (err: unknown) => err instanceof PromoteError && err.reason === reason,
  );
  assert.equal(verificationCalls, 0, `${reason} must reject before verification`);
}

describe('e2e full-loop: dispatch -> promote -> squash -> integrate (stub adapter)', { concurrency: 1 }, () => {
  before(() => {
    saved = {
      HYDRA_STATE_ROOT: process.env.HYDRA_STATE_ROOT,
      HYDRA_REPO_ID: process.env.HYDRA_REPO_ID,
    };
    process.env.HYDRA_STATE_ROOT = STATE;
    process.env.HYDRA_REPO_ID = 'fullloop-e2e';
    rmSync(E2E_ROOT, { recursive: true, force: true });
    mkdirSync(STATE, { recursive: true });
    mkdirSync(INT_WT_ROOT, { recursive: true });

    const realSchema = JSON.parse(
      readFileSync(join(REAL_REPO, 'hydra', 'schemas', 'result.schema.json'), 'utf8'),
    );
    realSchema.properties.vendor.enum.push('stub');
    schemaPath = join(E2E_ROOT, 'result.schema.json');
    writeFileSync(schemaPath, JSON.stringify(realSchema), 'utf8');

    assert.ok(existsSync(STUB_ADAPTER), `stub.sh must exist at ${STUB_ADAPTER}`);
    assert.notEqual(statSync(STUB_ADAPTER).mode & 0o111, 0, 'stub.sh must be executable');
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(E2E_ROOT, { recursive: true, force: true });
  });

  it('happy path: real stub spawn -> promote -> squash -> integrate with identical tree', async () => {
    const ctx = setupRun('happy', RUN_HAPPY);
    const drop = await dispatchStub(ctx);
    assert.equal(drop.status, 'completed');
    assert.equal(drop.vendor, 'stub');
    const stubHead = drop.head_commit;
    assert.notEqual(stubHead, ctx.base, 'stub must have committed past base');
    assert.equal(stubHead, git(['rev-parse', 'HEAD'], ctx.worktree));
    assert.equal(drop.base_commit, git(['rev-parse', ctx.base], ctx.worktree));
    assert.equal(drop.branch, git(['branch', '--show-current'], ctx.worktree));
    assert.deepEqual(drop.files_changed, ['stub-output.txt']);
    const marker = `stub worker marker for ${ctx.agentRunId}\n`;
    assert.equal(git(['show', `${stubHead}:stub-output.txt`], ctx.worktree) + '\n', marker);

    const promoted = await promote(ctx.runId, ctx.taskId, ctx.dropPath, {
      cwd: REAL_REPO,
      stateRoot: STATE,
      schema: schemaPath,
      verify: async (wt, _policy, out) => {
        assert.equal(wt, ctx.worktree);
        assert.equal(readFileSync(join(wt, 'stub-output.txt'), 'utf8'), marker);
        const observed = [{ command: 'test -f stub-output.txt', status: 'passed' as const }];
        if (out) writeFileSync(out, `${JSON.stringify(observed)}\n`, 'utf8');
        return observed;
      },
    });
    assert.ok(existsSync(promoted.promoted));

    const sq = squash(ctx.runId, ctx.taskId);
    assert.match(sq.integrationCommit, /^[0-9a-f]{40}$/);
    assert.equal(
      git(['rev-parse', `${sq.integrationCommit}^{tree}`], ctx.worktree),
      git(['rev-parse', `${stubHead}^{tree}`], ctx.worktree),
      'squash tree must match stub commit tree',
    );

    const verifiedWorktrees: string[] = [];
    const intHead = integrate(ctx.runId, [ctx.taskId], {
      cwd: ctx.worktree,
      stateRoot: STATE,
      worktreeRoot: INT_WT_ROOT,
      verify: (wt) => {
        verifiedWorktrees.push(wt);
        return readFileSync(join(wt, 'stub-output.txt'), 'utf8') === marker;
      },
    });
    assert.match(intHead, /^[0-9a-f]{40}$/);
    const intWorktree = join(INT_WT_ROOT, `run-${ctx.runId}-integration`);
    assert.deepEqual(verifiedWorktrees, [intWorktree, intWorktree]);
    assert.equal(git(['rev-parse', 'HEAD'], intWorktree), intHead);
    assert.equal(git(['status', '--porcelain'], intWorktree), '');
    assert.equal(readFileSync(join(intWorktree, 'stub-output.txt'), 'utf8'), marker);
    assert.equal(
      git(['rev-parse', 'HEAD^{tree}'], intWorktree),
      git(['rev-parse', `${stubHead}^{tree}`], ctx.worktree),
      'checked-out integration HEAD tree must match the real stub commit tree',
    );
  });

  it('negative paths: real no-commit and committed failure hit distinct rejection gates', async () => {
    const noCommit = setupRun('no-commit', RUN_NO_COMMIT);
    const noCommitDrop = await dispatchStub(noCommit, { STUB_MODE: 'no_commit' });
    assert.equal(noCommitDrop.status, 'completed');
    assert.equal(noCommitDrop.head_commit, git(['rev-parse', 'HEAD'], noCommit.worktree));
    assert.equal(noCommitDrop.head_commit, noCommit.base);
    assert.deepEqual(noCommitDrop.files_changed, []);
    await assertPromoteRejected(noCommit, 'no_commit');

    const failed = setupRun('failed-after-commit', RUN_FAIL);
    const failedDrop = await dispatchStub(failed, { STUB_MODE: 'fail' });
    assert.equal(failedDrop.status, 'failed');
    assert.notEqual(failedDrop.head_commit, failed.base, 'failed worker must still make a real commit');
    assert.equal(failedDrop.head_commit, git(['rev-parse', 'HEAD'], failed.worktree));
    assert.deepEqual(failedDrop.files_changed, ['stub-output.txt']);
    await assertPromoteRejected(failed, 'not_completed');
  });

  it('TS-native happy path: node-spawned adapter-stub.ts -> promote -> squash -> integrate (zero bash)', async () => {
    const ctx = setupRun('happy-ts', RUN_HAPPY_TS);
    const drop = await dispatchStubTs(ctx);
    assert.equal(drop.status, 'completed');
    assert.equal(drop.vendor, 'stub');
    const stubHead = drop.head_commit;
    assert.notEqual(stubHead, ctx.base, 'stub must have committed past base');
    assert.equal(stubHead, git(['rev-parse', 'HEAD'], ctx.worktree));
    assert.equal(drop.base_commit, git(['rev-parse', ctx.base], ctx.worktree));
    assert.equal(drop.branch, git(['branch', '--show-current'], ctx.worktree));
    assert.deepEqual(drop.files_changed, ['stub-output.txt']);
    const marker = `stub worker marker for ${ctx.agentRunId}\n`;
    assert.equal(git(['show', `${stubHead}:stub-output.txt`], ctx.worktree) + '\n', marker);

    const promoted = await promote(ctx.runId, ctx.taskId, ctx.dropPath, {
      cwd: REAL_REPO,
      stateRoot: STATE,
      schema: schemaPath,
      verify: async (wt, _policy, out) => {
        assert.equal(wt, ctx.worktree);
        assert.equal(readFileSync(join(wt, 'stub-output.txt'), 'utf8'), marker);
        const observed = [{ command: 'test -f stub-output.txt', status: 'passed' as const }];
        if (out) writeFileSync(out, `${JSON.stringify(observed)}\n`, 'utf8');
        return observed;
      },
    });
    assert.ok(existsSync(promoted.promoted));

    const sq = squash(ctx.runId, ctx.taskId);
    assert.match(sq.integrationCommit, /^[0-9a-f]{40}$/);
    assert.equal(
      git(['rev-parse', `${sq.integrationCommit}^{tree}`], ctx.worktree),
      git(['rev-parse', `${stubHead}^{tree}`], ctx.worktree),
      'squash tree must match stub commit tree',
    );

    const verifiedWorktrees: string[] = [];
    const intHead = integrate(ctx.runId, [ctx.taskId], {
      cwd: ctx.worktree,
      stateRoot: STATE,
      worktreeRoot: INT_WT_ROOT,
      verify: (wt) => {
        verifiedWorktrees.push(wt);
        return readFileSync(join(wt, 'stub-output.txt'), 'utf8') === marker;
      },
    });
    assert.match(intHead, /^[0-9a-f]{40}$/);
    const intWorktree = join(INT_WT_ROOT, `run-${ctx.runId}-integration`);
    assert.deepEqual(verifiedWorktrees, [intWorktree, intWorktree]);
    assert.equal(git(['rev-parse', 'HEAD'], intWorktree), intHead);
    assert.equal(git(['status', '--porcelain'], intWorktree), '');
    assert.equal(readFileSync(join(intWorktree, 'stub-output.txt'), 'utf8'), marker);
    assert.equal(
      git(['rev-parse', 'HEAD^{tree}'], intWorktree),
      git(['rev-parse', `${stubHead}^{tree}`], ctx.worktree),
      'checked-out integration HEAD tree must match the real stub commit tree',
    );
  });

  it('TS-native negative paths: node-spawned no_commit and fail hit distinct rejection gates', async () => {
    const noCommit = setupRun('no-commit-ts', RUN_NO_COMMIT_TS);
    const noCommitDrop = await dispatchStubTs(noCommit, { STUB_MODE: 'no_commit' });
    assert.equal(noCommitDrop.status, 'completed');
    assert.equal(noCommitDrop.head_commit, git(['rev-parse', 'HEAD'], noCommit.worktree));
    assert.equal(noCommitDrop.head_commit, noCommit.base);
    assert.deepEqual(noCommitDrop.files_changed, []);
    await assertPromoteRejected(noCommit, 'no_commit');

    const failed = setupRun('failed-after-commit-ts', RUN_FAIL_TS);
    const failedDrop = await dispatchStubTs(failed, { STUB_MODE: 'fail' });
    assert.equal(failedDrop.status, 'failed');
    assert.notEqual(failedDrop.head_commit, failed.base, 'failed worker must still make a real commit');
    assert.equal(failedDrop.head_commit, git(['rev-parse', 'HEAD'], failed.worktree));
    assert.deepEqual(failedDrop.files_changed, ['stub-output.txt']);
    await assertPromoteRejected(failed, 'not_completed');
  });
});
