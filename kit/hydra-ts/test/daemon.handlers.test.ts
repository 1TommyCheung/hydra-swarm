import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_OPERATION_HANDLERS, type DaemonOperationDeps } from '../src/daemon/handlers.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-daemon-handlers');
const ORIGINAL_HYDRA_STATE_ROOT = process.env.HYDRA_STATE_ROOT;

function clean(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

describe('daemon handlers', () => {
  before(() => {
    clean();
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });

  after(() => {
    clean();
    if (ORIGINAL_HYDRA_STATE_ROOT === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = ORIGINAL_HYDRA_STATE_ROOT;
    }
  });

  function deps(): DaemonOperationDeps {
    return {
      runInit: (runId: string) => {
        const dir = join(TEST_TMP, 'runs', `run-${runId}`);
        mkdirSync(join(dir, 'tasks'), { recursive: true });
        mkdirSync(join(dir, 'authoritative', 'verification'), { recursive: true });
        writeFileSync(join(dir, 'run.yaml'), `run_id: "${runId}"\nstate: planning\n`, 'utf8');
        return dir;
      },
      dispatch: async () => ({ agentRunId: 'agent-1', finished: Promise.resolve() }),
      promote: async () => ({ promoted: '/tmp/promoted.json', divergence: false }),
      verify: async (_worktree, _policy, out) => {
        if (out) writeFileSync(out, '[{"command":"test","status":"passed"}]\n', 'utf8');
        return [{ command: 'test', status: 'passed' }];
      },
      recordReview: () => '/tmp/review.json',
      ledgerAppend: () => undefined,
      now: () => '2026-01-01T00:00:00Z',
    };
  }

  it('registers task specs and records task_registered metadata', async () => {
    await DAEMON_OPERATION_HANDLERS['create-run'](
      { payload: { run_id: '0042' }, env: process.env },
      deps(),
    );
    const result = await DAEMON_OPERATION_HANDLERS['register-task'](
      {
        payload: {
          run_id: '0042',
          task_id: 'my-task',
          spec_yaml: 'task_id: my-task\nrun_id: 0042\nspec_version: 7\n',
        },
        env: process.env,
      },
      deps(),
    );
    assert.equal(result.spec_version, '7');
    const taskSpecPath = join(TEST_TMP, 'runs', 'run-0042', 'tasks', 'my-task.yaml');
    assert.ok(existsSync(taskSpecPath));
    assert.match(readFileSync(taskSpecPath, 'utf8'), /spec_version: 7/);
  });

  it('records dispatch with background flag', async () => {
    const result = await DAEMON_OPERATION_HANDLERS['record-dispatch'](
      {
        payload: {
          run_id: '0042',
          task_id: 'my-task',
          background: true,
        },
        env: process.env,
      },
      deps(),
    );
    assert.equal(result.agent_run_id, 'agent-1');
    assert.equal(result.background, true);
  });

  it('records verification output into authoritative location', async () => {
    const result = await DAEMON_OPERATION_HANDLERS['record-verification'](
      {
        payload: {
          run_id: '0042',
          task_id: 'my-task',
          worktree: '.',
          policy: 'kit/hydra/policies/verification.yaml',
        },
        env: process.env,
      },
      deps(),
    );
    const outPath = String(result.out_path);
    assert.ok(existsSync(outPath));
    assert.equal(result.status, 'passed');
  });

  it('records promote, review, and close operations', async () => {
    const promoted = await DAEMON_OPERATION_HANDLERS['promote-result'](
      {
        payload: {
          run_id: '0042',
          task_id: 'my-task',
          drop_path: '/tmp/drop.json',
        },
        env: process.env,
      },
      deps(),
    );
    assert.equal(promoted.promoted_path, '/tmp/promoted.json');

    const review = await DAEMON_OPERATION_HANDLERS['record-review'](
      {
        payload: {
          run_id: '0042',
          task_id: 'my-task',
          verdict_path: '/tmp/verdict.json',
        },
        env: process.env,
      },
      deps(),
    );
    assert.equal(review.review_path, '/tmp/review.json');

    const closed = await DAEMON_OPERATION_HANDLERS['close-run'](
      {
        payload: {
          run_id: '0042',
          status: 'completed',
          reason: 'done',
        },
        env: process.env,
      },
      deps(),
    );
    assert.equal(closed.status, 'completed');
    const runYaml = readFileSync(join(TEST_TMP, 'runs', 'run-0042', 'run.yaml'), 'utf8');
    assert.match(runYaml, /state: completed/);
  });
});
