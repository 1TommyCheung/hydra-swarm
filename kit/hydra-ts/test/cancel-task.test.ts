import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  cancelTask,
  isDispatchCommand,
  type CancelSignal,
  type CancelTaskOptions,
} from '../src/cancel-task.ts';

const TEST_TMP = join(tmpdir(), `hydra-cancel-task-${process.pid}`);
let sequence = 0;

interface Fixture {
  runId: string;
  taskId: string;
  stateRoot: string;
  runDir: string;
  sessionsDir: string;
  ledgerPath: string;
  agentRunId: string;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
}

function fixture(overrides: { specVersion?: number } = {}): Fixture {
  sequence += 1;
  const runId = `cancel-${sequence}`;
  const taskId = 'task-a';
  const specVersion = overrides.specVersion ?? 1;
  const stateRoot = join(TEST_TMP, runId, 'state');
  const runDir = join(stateRoot, 'runs', `run-${runId}`);
  const sessionsDir = join(runDir, 'sessions');
  const ledgerPath = join(runDir, 'authoritative', 'ledger', 'events.jsonl');
  const agentRunId = `${runId}-${taskId}-v${specVersion}`;
  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(runDir, 'tasks', `${taskId}.yaml`), [
    `task_id: ${taskId}`,
    `run_id: ${runId}`,
    'assigned_vendor: codex',
    `worktree: ${join(TEST_TMP, runId, 'worktree')}`,
    'timeout_minutes: 45',
    `spec_version: ${specVersion}`,
    `branch: hydra/${runId}/${taskId}`,
    'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    '',
  ].join('\n'));
  return { runId, taskId, stateRoot, runDir, sessionsDir, ledgerPath, agentRunId };
}

function writeLedger(f: Fixture, entries: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(f.ledgerPath), { recursive: true });
  writeFileSync(
    f.ledgerPath,
    entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    'utf8',
  );
}

function appendLedger(f: Fixture, entry: Record<string, unknown>): void {
  appendFileSync(f.ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function started(f: Fixture, agentRunId = f.agentRunId): Record<string, unknown> {
  return {
    time: '2026-07-14T00:00:00Z',
    event: 'task_started',
    run_id: f.runId,
    task_id: f.taskId,
    vendor: 'codex',
    agent_run_id: agentRunId,
  };
}

function terminal(f: Fixture, event = 'agent_cancelled'): Record<string, unknown> {
  return {
    time: '2026-07-14T00:00:01Z',
    event,
    run_id: f.runId,
    task_id: f.taskId,
    vendor: 'codex',
    reason: 'test dispatcher response',
  };
}

function writePidfile(f: Fixture, pid: number): void {
  const path = join(f.sessionsDir, 'supervisor', `${f.agentRunId}.dispatch.pid`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`, 'utf8');
}

function dispatchProcess(f: Fixture, pid: number): { pid: number; command: string } {
  return {
    pid,
    command: `/usr/bin/node --experimental-strip-types /repo/kit/hydra-ts/src/dispatch.ts ${f.runId} ${f.taskId}`,
  };
}

function options(f: Fixture, overrides: CancelTaskOptions = {}): CancelTaskOptions {
  return {
    stateRoot: f.stateRoot,
    waitSeconds: 0,
    killGraceMs: 0,
    sleep: async () => {},
    write: () => {},
    ...overrides,
  };
}

function ledger(f: Fixture): Array<Record<string, unknown>> {
  return readFileSync(f.ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('cancelTask', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('is an idempotent no-op when the current attempt is already terminal', async () => {
    const f = fixture({ specVersion: 2 });
    writeLedger(f, [
      started(f, `${f.runId}-${f.taskId}-v1`),
      terminal(f, 'agent_timed_out'),
      started(f),
      terminal(f, 'agent_exited'),
    ]);
    const signals: Array<[number, CancelSignal]> = [];
    let output = '';

    const result = await cancelTask(f.runId, f.taskId, options(f, {
      signalProcess: (pid, signal) => { signals.push([pid, signal]); },
      write: (text) => { output += text; },
    }));

    assert.equal(result.outcome, 'already_terminal');
    assert.equal(result.terminal_event.event, 'agent_exited');
    assert.deepEqual(signals, []);
    assert.match(output, /agent_exited/);
    assert.match(output, /test dispatcher response/);
  });

  it('rejects a missing current task attempt', async () => {
    const f = fixture({ specVersion: 2 });
    writeLedger(f, [
      started(f, `${f.runId}-${f.taskId}-v1`),
      terminal(f, 'agent_exited'),
    ]);

    await assert.rejects(
      cancelTask(f.runId, f.taskId, options(f)),
      /no such task\/attempt/,
    );
  });

  it('cancels the dispatch PID from the supervisor pidfile', async () => {
    const f = fixture();
    const dispatchPid = 43210;
    writeLedger(f, [started(f)]);
    writePidfile(f, dispatchPid);
    const signals: Array<[number, CancelSignal]> = [];

    const result = await cancelTask(f.runId, f.taskId, options(f, {
      processAlive: (pid) => pid === dispatchPid,
      listProcesses: () => [dispatchProcess(f, dispatchPid)],
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM') appendLedger(f, terminal(f));
      },
    }));

    assert.equal(result.outcome, 'terminated');
    assert.equal(result.dispatch_pid, dispatchPid);
    assert.equal(result.terminal_event.event, 'agent_cancelled');
    assert.deepEqual(signals, [[dispatchPid, 'SIGTERM']]);
  });

  it('rejects a stale live pidfile PID and falls through to validated discovery', async () => {
    const f = fixture();
    const stalePid = 43211;
    const dispatchPid = 43212;
    writeLedger(f, [started(f)]);
    writePidfile(f, stalePid);
    const signals: Array<[number, CancelSignal]> = [];

    const result = await cancelTask(f.runId, f.taskId, options(f, {
      processAlive: (pid) => pid === stalePid || pid === dispatchPid,
      listProcesses: () => [
        { pid: stalePid, command: 'sleep 300' },
        dispatchProcess(f, dispatchPid),
      ],
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        appendLedger(f, terminal(f));
      },
    }));

    assert.equal(result.dispatch_pid, dispatchPid);
    assert.deepEqual(signals, [[dispatchPid, 'SIGTERM']]);
    assert.equal(signals.some(([pid]) => pid === stalePid), false);
  });

  it('uses only a validated dispatcher match while queued without a pidfile', async () => {
    const f = fixture();
    const dispatchPid = 54321;
    writeLedger(f, [
      started(f),
      {
        time: '2026-07-14T00:00:00Z',
        event: 'concurrency_wait',
        run_id: f.runId,
        task_id: f.taskId,
      },
    ]);
    const signals: Array<[number, CancelSignal]> = [];

    const result = await cancelTask(f.runId, f.taskId, options(f, {
      processAlive: () => true,
      listProcesses: () => [
        { pid: 111, command: `node cancel-task.ts ${f.runId} ${f.taskId}` },
        { pid: 222, command: `node dispatch.ts ${f.runId} different-task` },
        { pid: dispatchPid, command: `/usr/bin/node --experimental-strip-types /repo/kit/hydra-ts/src/dispatch.ts ${f.runId} ${f.taskId}` },
      ],
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        appendLedger(f, terminal(f));
      },
    }));

    assert.equal(result.dispatch_pid, dispatchPid);
    assert.deepEqual(signals, [[dispatchPid, 'SIGTERM']]);
  });

  it('escalates to SIGKILL on the dispatcher when SIGTERM produces no event', async () => {
    const f = fixture();
    const dispatchPid = 65432;
    writeLedger(f, [started(f)]);
    writePidfile(f, dispatchPid);
    const signals: Array<[number, CancelSignal]> = [];

    const result = await cancelTask(f.runId, f.taskId, options(f, {
      processAlive: () => true,
      listProcesses: () => [dispatchProcess(f, dispatchPid)],
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGKILL') appendLedger(f, terminal(f));
      },
    }));

    assert.equal(result.outcome, 'terminated_after_kill');
    assert.deepEqual(signals, [
      [dispatchPid, 'SIGTERM'],
      [dispatchPid, 'SIGKILL'],
    ]);
  });

  it('reports an orphan and never fabricates a terminal ledger event', async () => {
    const f = fixture();
    const dispatchPid = 76543;
    writeLedger(f, [started(f)]);
    writePidfile(f, dispatchPid);
    const before = readFileSync(f.ledgerPath, 'utf8');
    const signals: Array<[number, CancelSignal]> = [];

    await assert.rejects(
      cancelTask(f.runId, f.taskId, options(f, {
        processAlive: () => true,
        listProcesses: () => [dispatchProcess(f, dispatchPid)],
        signalProcess: (pid, signal) => { signals.push([pid, signal]); },
      })),
      /ORPHAN.*manual investigation.*no ledger event was fabricated/,
    );

    assert.deepEqual(signals, [
      [dispatchPid, 'SIGTERM'],
      [dispatchPid, 'SIGKILL'],
    ]);
    assert.equal(readFileSync(f.ledgerPath, 'utf8'), before);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started']);
  });

  it('does not send SIGKILL after SIGTERM when the dispatcher is already dead', async () => {
    const f = fixture();
    const dispatchPid = 87654;
    writeLedger(f, [started(f)]);
    writePidfile(f, dispatchPid);
    const signals: Array<[number, CancelSignal]> = [];
    let livenessChecks = 0;

    await assert.rejects(
      cancelTask(f.runId, f.taskId, options(f, {
        processAlive: () => {
          livenessChecks += 1;
          return livenessChecks <= 2;
        },
        listProcesses: () => [dispatchProcess(f, dispatchPid)],
        signalProcess: (pid, signal) => { signals.push([pid, signal]); },
      })),
      /ORPHAN/,
    );

    assert.deepEqual(signals, [[dispatchPid, 'SIGTERM']]);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started']);
  });

  it('skips SIGKILL when the PID no longer has dispatcher identity', async () => {
    const f = fixture();
    const dispatchPid = 87655;
    writeLedger(f, [started(f)]);
    writePidfile(f, dispatchPid);
    const signals: Array<[number, CancelSignal]> = [];
    let processLists = 0;

    await assert.rejects(
      cancelTask(f.runId, f.taskId, options(f, {
        processAlive: () => true,
        listProcesses: () => {
          processLists += 1;
          return processLists === 1
            ? [dispatchProcess(f, dispatchPid)]
            : [{ pid: dispatchPid, command: 'sleep 300' }];
        },
        signalProcess: (pid, signal) => { signals.push([pid, signal]); },
      })),
      /ORPHAN/,
    );

    assert.deepEqual(signals, [[dispatchPid, 'SIGTERM']]);
    assert.ok(processLists >= 2);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started']);
  });

  it('ignores agent_loop_suspected when resolving the current attempt and PID', async () => {
    const f = fixture();
    const dispatchPid = 43210;
    writeLedger(f, [
      started(f),
      {
        time: '2026-07-14T00:00:30Z',
        event: 'agent_loop_suspected',
        run_id: f.runId,
        task_id: f.taskId,
        vendor: 'codex',
        agent_run_id: f.agentRunId,
        dominant_action_hash: 'abc123',
        repeat_count: '8',
        failure_count: '6',
      },
    ]);
    writePidfile(f, dispatchPid);
    const signals: Array<[number, CancelSignal]> = [];

    const result = await cancelTask(f.runId, f.taskId, options(f, {
      processAlive: (pid) => pid === dispatchPid,
      listProcesses: () => [dispatchProcess(f, dispatchPid)],
      signalProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM') appendLedger(f, terminal(f));
      },
    }));

    assert.equal(result.outcome, 'terminated');
    assert.equal(result.dispatch_pid, dispatchPid);
    assert.equal(result.terminal_event.event, 'agent_cancelled');
    assert.deepEqual(signals, [[dispatchPid, 'SIGTERM']]);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'agent_loop_suspected', 'agent_cancelled']);
  });

  it('requires exact dispatcher and run/task command tokens', () => {
    assert.equal(
      isDispatchCommand('node /repo/dispatch.ts run-1 task-a', 'run-1', 'task-a'),
      true,
    );
    assert.equal(
      isDispatchCommand('node /repo/not-dispatch.ts run-1 task-a', 'run-1', 'task-a'),
      false,
    );
    assert.equal(
      isDispatchCommand('node /repo/dispatch.ts run-10 task-a', 'run-1', 'task-a'),
      false,
    );
  });
});
