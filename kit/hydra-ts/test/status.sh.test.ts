import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const TEST_TMP = join(tmpdir(), `hydra-status-sh-${process.pid}`);
const STATUS_SH = join(import.meta.dirname, '../../hydra/scripts/status.sh');

/**
 * Poll `ps` until the spawned child's command line is actually visible in the
 * process table (or until timeoutMs elapses). A freshly spawned process is not
 * guaranteed to be observable via `ps` the instant spawn() returns — without
 * this synchronization the live-process tests are timing-sensitive and can
 * assert against a snapshot that does not yet contain the child.
 */
function waitForProcessVisible(commandSubstring: string, timeoutMs = 2000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let listing = '';
    try {
      listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    } catch {
      return false;
    }
    if (listing.includes(commandSubstring)) return true;
    // Brief busy-wait avoidance without importing timers; 20ms is well below the
    // 2s budget and the typical ps visibility latency.
    const slept = Date.now() + 20;
    while (Date.now() < slept) { /* spin briefly */ }
  }
  return false;
}

interface Fixture {
  runId: string;
  stateRoot: string;
  taskSpecPath: string;
  ledgerPath: string;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fixture(
  id: string,
  overrides: {
    specVersion?: number;
  } = {},
): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDir = join(stateRoot, 'runs', `run-${id}`);
  const taskSpecPath = join(runDir, 'tasks', 'task-a.yaml');

  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  writeFileSync(taskSpecPath, [
    'task_id: task-a',
    `run_id: ${id}`,
    'assigned_vendor: claude',
    `worktree: ${join(TEST_TMP, id, 'worktree')}`,
    'timeout_minutes: 45',
    `spec_version: ${overrides.specVersion ?? 1}`,
    `branch: hydra/${id}/task-a`,
    'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    '',
  ].join('\n'));

  return {
    runId: id,
    stateRoot,
    taskSpecPath,
    ledgerPath: join(runDir, 'authoritative', 'ledger', 'events.jsonl'),
  };
}

function writeLedger(f: Fixture, lines: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(f.ledgerPath), { recursive: true });
  writeFileSync(
    f.ledgerPath,
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    'utf8',
  );
}

interface StatusJson {
  state: string;
  agent_run_id: string;
  disagreement: string | null;
  ledger_events: Array<Record<string, unknown>>;
}

function runStatusSh(f: Fixture, extraArgs: string[] = []): StatusJson {
  const result = spawnSync(
    'bash',
    [STATUS_SH, f.runId, 'task-a', '--json', ...extraArgs],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HYDRA_HARNESS: 'bash',
        HYDRA_STATE_ROOT: f.stateRoot,
        HYDRA_REPO_ID: `test-${f.runId}`,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `status.sh exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as StatusJson;
}

describe('status.sh bash fallback', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('reports a running task', () => {
    const f = fixture(uniqueRunId('running'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:01:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'claude' },
    ]);

    const result = runStatusSh(f);

    assert.equal(result.state, 'running');
    assert.equal(result.agent_run_id, `${f.runId}-task-a-v1`);
    assert.deepEqual(result.ledger_events.map(({ event }) => event), ['task_started', 'heartbeat']);
  });

  it('reports a disappeared worker as failed, not completed', () => {
    const f = fixture(uniqueRunId('disappeared'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:05:00Z', event: 'agent_exited', run_id: f.runId, task_id: 'task-a', vendor: 'claude', exit_code: '127', reason: 'worker_disappeared' },
    ]);

    const result = runStatusSh(f);

    assert.equal(result.state, 'failed');
    assert.equal(result.agent_run_id, `${f.runId}-task-a-v1`);
    assert.equal(result.ledger_events.at(-1)?.reason, 'worker_disappeared');
  });

  it('scopes ledger_events to the current attempt on a retry', () => {
    const f = fixture(uniqueRunId('retry'), { specVersion: 2 });
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:05:00Z', event: 'agent_timed_out', run_id: f.runId, task_id: 'task-a', vendor: 'claude' },
      { time: '2024-01-01T00:10:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${f.runId}-task-a-v2` },
      { time: '2024-01-01T00:11:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'claude' },
    ]);

    const result = runStatusSh(f);

    assert.equal(result.state, 'running');
    assert.equal(result.agent_run_id, `${f.runId}-task-a-v2`);
    assert.deepEqual(result.ledger_events.map(({ event }) => event), ['task_started', 'heartbeat']);
  });

  it('reports disagreement when a queued task has no live dispatch process (killed while queued)', () => {
    const f = fixture(uniqueRunId('queued-dead'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:00:01Z', event: 'concurrency_wait', run_id: f.runId, task_id: 'task-a', vendor: 'claude', cap: '2', active: '2' },
    ]);

    const result = runStatusSh(f);

    assert.equal(result.state, 'running');
    assert.match(result.disagreement ?? '', /no live dispatch process was found/);
    assert.match(result.disagreement ?? '', /killed while queued/);
  });

  it('does not report disagreement when a queued task has a live validated dispatch process', () => {
    const f = fixture(uniqueRunId('queued-alive'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:00:01Z', event: 'concurrency_wait', run_id: f.runId, task_id: 'task-a', vendor: 'claude', cap: '2', active: '2' },
    ]);

    // Spawn a real process whose command line validates as a dispatcher for
    // this exact run/task. The `wait` prevents bash from exec-ing sleep and
    // losing the script path + args from the ps-visible command line.
    const fakeScript = join(TEST_TMP, f.runId, 'dispatch.sh');
    mkdirSync(dirname(fakeScript), { recursive: true });
    writeFileSync(fakeScript, '#!/bin/bash\nsleep 60 &\nwait $!\n');
    chmodSync(fakeScript, 0o755);
    const child: ChildProcess = spawn(fakeScript, [f.runId, 'task-a'], {
      stdio: 'ignore',
    });

    try {
      // Wait until the child's command line is actually observable via ps
      // before asserting against it — immediate visibility is not guaranteed.
      assert.ok(child.pid !== undefined, 'child process should have a pid');
      assert.equal(
        waitForProcessVisible(`${fakeScript} ${f.runId} task-a`),
        true,
        'spawned dispatcher command should become visible via ps',
      );
      const result = runStatusSh(f);
      assert.equal(result.state, 'running');
      assert.equal(result.disagreement, null);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }
  });

  it('reports disagreement when a live process runs a dispatcher for the wrong run/task', () => {
    // This is the exact branch where the pre-fix bash validator diverged from
    // TypeScript: a real dispatch.sh invocation exists, but for a DIFFERENT
    // run_id/task_id than the one status is checking. A loose "tokens anywhere"
    // matcher would have suppressed the disagreement here; the positional
    // validation must reject it and report the queued-dead disagreement.
    const f = fixture(uniqueRunId('queued-wrong'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:00:01Z', event: 'concurrency_wait', run_id: f.runId, task_id: 'task-a', vendor: 'claude', cap: '2', active: '2' },
    ]);

    const fakeScript = join(TEST_TMP, f.runId, 'dispatch.sh');
    mkdirSync(dirname(fakeScript), { recursive: true });
    writeFileSync(fakeScript, '#!/bin/bash\nsleep 60 &\nwait $!\n');
    chmodSync(fakeScript, 0o755);
    // Dispatch for a deliberately wrong run/task.
    const wrongRun = `other-${f.runId}`;
    const wrongTask = 'other-task';
    const child: ChildProcess = spawn(fakeScript, [wrongRun, wrongTask], {
      stdio: 'ignore',
    });

    try {
      assert.ok(child.pid !== undefined, 'child process should have a pid');
      assert.equal(
        waitForProcessVisible(`${fakeScript} ${wrongRun} ${wrongTask}`),
        true,
        'spawned wrong-run/task dispatcher should become visible via ps',
      );
      const result = runStatusSh(f);
      assert.equal(result.state, 'running');
      assert.match(result.disagreement ?? '', /no live dispatch process was found/);
      assert.match(result.disagreement ?? '', /killed while queued/);
    } finally {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }
  });
});
