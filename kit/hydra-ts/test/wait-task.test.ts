import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  EXIT_ERROR,
  EXIT_SUCCESS,
  EXIT_TASK_NOT_SUCCESSFUL,
  EXIT_WAIT_TIMED_OUT,
  main,
  mainRun,
  waitRun,
  waitTask,
  type WaitTaskOptions,
} from '../src/wait-task.ts';
import { routes, usage } from '../src/cli.ts';
import { LEDGER_DISPLAY_TAIL, TERMINAL_EVENTS, type StatusResult } from '../src/status.ts';

const TEST_TMP = join(tmpdir(), `hydra-wait-task-${process.pid}`);
const WAIT_TASK_SH = join(import.meta.dirname, '../../hydra/scripts/wait-task.sh');
const WAIT_RUN_SH = join(import.meta.dirname, '../../hydra/scripts/wait-run.sh');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
}

function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Fake status observations. waitTask never parses the ledger itself — it goes
// through status.ts — so the unit tests drive it through the `observe` seam.
//
// The fake is built the way status.ts builds a real StatusResult: `window` is
// the FULL attempt window, the terminal_* fields come from a full-window
// backwards scan, and `ledger_events` carries only the trailing display slice.
// Deriving both from one window (instead of letting a fixture state them
// independently) is what makes a fixture with many post-terminal events
// reproduce the real truncation instead of papering over it.
// ---------------------------------------------------------------------------

function statusResult(
  state: StatusResult['state'],
  window: Array<Record<string, unknown>> = [],
): StatusResult {
  const terminal = [...window].reverse()
    .find((entry) => TERMINAL_EVENTS.includes(String(entry.event ?? '')));
  const text = (value: unknown): string | null =>
    (value === undefined || value === null || value === '' ? null : String(value));
  return {
    state,
    agent_run_id: 'run-task-v1',
    vendor: 'codex',
    elapsed_seconds: 1,
    timeout_minutes: 45,
    hard_cap_minutes: 270,
    dispatch_liveness: null,
    disagreement: null,
    loop_suspicion: null,
    amendment_noop: null,
    terminal_event: text(terminal?.event),
    terminal_exit_code: text(terminal?.exit_code),
    terminal_reason: text(terminal?.reason),
    attempt_event_count: window.length,
    progress_tail: [],
    progress_source: null,
    ledger_events: window.slice(-LEDGER_DISPLAY_TAIL),
  };
}

/** A clock + sleep pair where sleeping advances virtual time instantly. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let current = 1_000_000;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

/** Feed a scripted sequence of observations; the last one repeats forever. */
function scriptedObserve(sequence: StatusResult[]): {
  observe: () => StatusResult;
  calls: () => number;
} {
  let index = 0;
  return {
    observe: () => {
      const value = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return value;
    },
    calls: () => index,
  };
}

function harness(sequence: StatusResult[], extra: WaitTaskOptions = {}): {
  options: WaitTaskOptions;
  lines: string[];
} {
  const clock = fakeClock();
  const scripted = scriptedObserve(sequence);
  const lines: string[] = [];
  return {
    lines,
    options: {
      now: clock.now,
      sleep: clock.sleep,
      observe: scripted.observe,
      write: (text: string) => { lines.push(text); },
      pollIntervalMs: 1000,
      ...extra,
    },
  };
}

const RUNNING = statusResult('running', [
  { time: '2026-08-01T00:00:00Z', event: 'task_started', task_id: 'task-a' },
]);

function exited(exitCode: string, extra: Record<string, unknown> = {}): StatusResult {
  return statusResult('completed', [
    { time: '2026-08-01T00:00:00Z', event: 'task_started', task_id: 'task-a' },
    { time: '2026-08-01T00:05:00Z', event: 'agent_exited', task_id: 'task-a', exit_code: exitCode, ...extra },
  ]);
}

describe('waitTask terminal detection', () => {
  it('resolves succeeded as soon as a zero-exit agent_exited is observed', async () => {
    const h = harness([RUNNING, RUNNING, exited('0')]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.state, 'completed');
    assert.equal(result.terminal_event, 'agent_exited');
    assert.equal(result.exit_code, '0');
  });

  it('treats an agent_exited with a non-zero exit_code as NOT a success', async () => {
    // The exact trap from issue #41: status.ts reports state 'completed' for an
    // adapter-outcome failure, but the ledger's exit_code says otherwise.
    const h = harness([RUNNING, exited('1', { reason: 'adapter_outcome_malformed' })]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.state, 'completed');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.exit_code, '1');
    assert.equal(result.reason, 'adapter_outcome_malformed');
  });

  for (const [state, event] of [
    ['failed', 'agent_exited'],
    ['cancelled', 'agent_cancelled'],
    ['timed_out', 'agent_timed_out'],
    ['usage_limited', 'agent_usage_limited'],
  ] as const) {
    it(`reports the ${event} terminal event for state ${state} and fails`, async () => {
      const terminal = statusResult(state, [
        { time: '2026-08-01T00:00:00Z', event: 'task_started', task_id: 'task-a' },
        { time: '2026-08-01T00:05:00Z', event, task_id: 'task-a' },
      ]);
      const h = harness([RUNNING, terminal]);
      const result = await waitTask('0068', 'task-a', h.options);

      assert.equal(result.outcome, 'failed');
      assert.equal(result.state, state);
      assert.equal(result.terminal_event, event);
    });
  }

  it('never reports success for a completed state with no exit_code recorded', async () => {
    // Absence of an exit_code is not positive evidence of a clean exit. A
    // watcher that reads "no contrary evidence" as success is exactly the
    // confidently-wrong watcher issue #41 replaces, so this must fail closed.
    const noExitCode = statusResult('completed', [
      { time: '2026-08-01T00:00:00Z', event: 'task_started', task_id: 'task-a' },
      { time: '2026-08-01T00:05:00Z', event: 'agent_exited', task_id: 'task-a' },
    ]);
    const h = harness([RUNNING, noExitCode]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.state, 'completed');
    assert.equal(result.outcome, 'failed', 'a missing exit_code must not read as success');
    assert.equal(result.exit_code, null);
    assert.equal(result.terminal_event, 'agent_exited');
  });

  it('never reports success when the terminal event is not an agent_exited', async () => {
    // Issue #40's amendment_noop is appended after agent_exited and is the last
    // word on the attempt; status.ts reports it as 'failed'. Belt and braces:
    // even a mislabelled 'completed' must not be promoted to success by it.
    const noop = statusResult('completed', [
      { time: '2026-08-01T00:00:00Z', event: 'task_started', task_id: 'task-a' },
      { time: '2026-08-01T00:05:00Z', event: 'agent_exited', task_id: 'task-a', exit_code: '0' },
      { time: '2026-08-01T00:05:01Z', event: 'amendment_noop', task_id: 'task-a', exit_code: '0' },
    ]);
    const h = harness([noop]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'failed');
    assert.equal(result.terminal_event, 'amendment_noop');
  });

  it('reports success when later events displace agent_exited from the display tail', async () => {
    // Regression: waitTask used to hunt for the exit_code inside status()'s
    // `ledger_events`, which is only the last LEDGER_DISPLAY_TAIL events of the
    // attempt — a display aid, not the record. A task that genuinely succeeded
    // and then accumulated more than that many follow-on lifecycle events
    // (review_started/review_completed, ...) still reports state 'completed',
    // but its agent_exited is no longer in the tail, so the old lookup found no
    // exit_code and called a clean success a failure. The outcome must come
    // from the full-window terminal_* fields instead.
    const laterEvents = [
      'review_started', 'review_completed', 'review_started',
      'review_completed', 'promotion_started', 'promotion_completed',
    ].map((event, index) => ({
      time: `2026-08-01T00:1${index}:00Z`,
      event,
      task_id: 'task-a',
    }));
    const displaced = statusResult('completed', [
      { time: '2026-08-01T00:00:00Z', event: 'task_started', task_id: 'task-a' },
      { time: '2026-08-01T00:05:00Z', event: 'agent_exited', task_id: 'task-a', exit_code: '0' },
      ...laterEvents,
    ]);

    // The fixture must actually reproduce the trap, not merely resemble it.
    assert.ok(laterEvents.length > LEDGER_DISPLAY_TAIL, 'must overflow the display tail');
    assert.equal(
      displaced.ledger_events.some((entry) => entry.event === 'agent_exited'),
      false,
      'the display tail must no longer contain the agent_exited being tested',
    );

    const h = harness([RUNNING, displaced]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'succeeded', 'a displaced success is still a success');
    assert.equal(result.terminal_event, 'agent_exited');
    assert.equal(result.exit_code, '0');
  });

  it('returns immediately when the task is already terminal on the first poll', async () => {
    const h = harness([exited('0')]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.waited_seconds, 0, 'an already-terminal task must not sleep');
  });
});

describe('waitTask loud failure on an unresolvable target', () => {
  it('fails immediately (does not hang) when the task has no ledger events at all', async () => {
    const h = harness([statusResult('unknown', [])]);
    await assert.rejects(
      () => waitTask('0068', 'ghost-task', h.options),
      /no ledger events for 0068\/ghost-task/,
    );
  });

  // The shape dispatch actually writes for a task parked in acquireSlot():
  // task_started is appended BEFORE the slot is acquired, so a queued attempt
  // window is task_started followed by a trailing concurrency_wait, and
  // status.ts reports it as 'running'. Regression: waitTask used to die on any
  // window without a terminal event, which is a false "never dispatched" claim
  // for a task that is merely queued. The fail-loud trigger is an EMPTY attempt
  // window, nothing else.
  const QUEUED = statusResult('running', [
    { time: '2026-08-01T00:00:00Z', event: 'task_started', task_id: 'task-a' },
    { time: '2026-08-01T00:00:01Z', event: 'concurrency_wait', task_id: 'task-a', cap: '3', active: '3' },
  ]);

  it('keeps waiting on a queued task whose window trails with concurrency_wait', async () => {
    const h = harness([QUEUED, QUEUED, QUEUED, RUNNING, exited('0')]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.terminal_event, 'agent_exited');
  });

  it('keeps waiting on an unknown state that still has attempt events', async () => {
    // Defensive: status.ts also reports 'unknown' for an attempt window it
    // cannot resolve to a task_started. That is an observation gap, not proof
    // that nothing was dispatched, so it must be waited on rather than killed.
    const murky = statusResult('unknown', [
      { time: '2026-08-01T00:00:00Z', event: 'concurrency_wait', task_id: 'task-a', cap: '3', active: '3' },
    ]);
    const h = harness([murky, murky, RUNNING, exited('0')]);
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'succeeded');
  });

  it('names concurrency_wait in the heartbeat instead of erroring while queued', async () => {
    const queued = QUEUED;
    const h = harness([...Array(100).fill(queued), exited('0')], { heartbeatSeconds: 60 });
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'succeeded');
    const heartbeats = h.lines.filter((line) => line.includes('still waiting'));
    assert.ok(heartbeats.length >= 1, 'a queued wait must still be visibly alive');
    assert.match(heartbeats[0], /last observed event concurrency_wait/);
  });

  it('wait-run does not turn a queued batch into per-task errors', async () => {
    // The headline fan-out scenario: a batch larger than the concurrency cap.
    // Every queued task used to come back as an instant 'error' entry.
    const queued = QUEUED;
    const clock = fakeClock();
    const cursors = new Map<string, number>();
    const byTask: Record<string, StatusResult[]> = {
      'task-a': [RUNNING, exited('0')],
      'task-b': [queued, queued, RUNNING, exited('0')],
      'task-c': [queued, queued, queued, RUNNING, exited('0')],
    };
    const result = await waitRun('0068', ['task-a', 'task-b', 'task-c'], {
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 1000,
      write: () => {},
      observe: (_runId: string, taskId: string) => {
        const sequence = byTask[taskId];
        const index = cursors.get(taskId) ?? 0;
        cursors.set(taskId, index + 1);
        return sequence[Math.min(index, sequence.length - 1)];
      },
    });

    assert.equal(result.outcome, 'succeeded');
    assert.deepEqual(result.tasks.map((task) => task.outcome), ['succeeded', 'succeeded', 'succeeded']);
  });

  it('propagates the status.ts failure when the run/task does not resolve', async () => {
    const h = harness([RUNNING], {
      observe: () => { throw new Error('hydra: error: no ledger for run 9999'); },
    });
    await assert.rejects(() => waitTask('9999', 'task-a', h.options), /no ledger for run 9999/);
  });

  it('exits non-zero from main() for an unresolvable target', async () => {
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(['--json']);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(code, EXIT_ERROR);
    assert.match(stderr.join(''), /usage: wait-task/);
  });
});

describe('waitTask heartbeat', () => {
  it('emits a heartbeat naming the last observed event roughly every 60s', async () => {
    // 200 polls at 1s each => >60s of virtual time with no terminal event.
    const h = harness([...Array(200).fill(RUNNING), exited('0')], { heartbeatSeconds: 60 });
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'succeeded');
    const heartbeats = h.lines.filter((line) => line.includes('still waiting'));
    assert.ok(heartbeats.length >= 3, `expected >=3 heartbeats, got ${heartbeats.length}`);
    assert.match(heartbeats[0], /still waiting on 0068\/task-a/);
    assert.match(heartbeats[0], /last observed event task_started at 2026-08-01T00:00:00Z/);
  });

  it('emits no heartbeat before the interval elapses', async () => {
    const h = harness([RUNNING, RUNNING, exited('0')], { heartbeatSeconds: 60 });
    await waitTask('0068', 'task-a', h.options);
    assert.equal(h.lines.filter((line) => line.includes('still waiting')).length, 0);
  });
});

describe('waitTask --timeout-seconds', () => {
  it('gives up with wait_timed_out when no terminal event arrives in time', async () => {
    const h = harness(Array(500).fill(RUNNING), { timeoutSeconds: 30 });
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'wait_timed_out');
    assert.equal(result.state, 'running');
    assert.equal(result.terminal_event, null);
    assert.ok(result.waited_seconds >= 30, `waited ${result.waited_seconds}s`);
    assert.ok(h.lines.some((line) => line.includes('wait timed out')));
  });

  it('never sleeps past the deadline even with a long poll interval', async () => {
    const h = harness(Array(50).fill(RUNNING), { timeoutSeconds: 5, pollIntervalMs: 60_000 });
    const result = await waitTask('0068', 'task-a', h.options);

    assert.equal(result.outcome, 'wait_timed_out');
    assert.equal(result.waited_seconds, 5, 'must report exactly the requested deadline');
  });

  it('timeout 0 returns after a single observation without sleeping', async () => {
    const h = harness(Array(10).fill(RUNNING), { timeoutSeconds: 0 });
    const result = await waitTask('0068', 'task-a', h.options);
    assert.equal(result.outcome, 'wait_timed_out');
    assert.equal(result.waited_seconds, 0);
  });
});

describe('waitRun fan-out', () => {
  function runHarness(byTask: Record<string, StatusResult[]>, extra: WaitTaskOptions = {}) {
    const clock = fakeClock();
    const cursors = new Map<string, number>();
    const lines: string[] = [];
    return {
      lines,
      options: {
        now: clock.now,
        sleep: clock.sleep,
        pollIntervalMs: 1000,
        write: (text: string) => { lines.push(text); },
        observe: (_runId: string, taskId: string) => {
          const sequence = byTask[taskId];
          if (sequence === undefined) throw new Error(`hydra: error: instantiated task spec not found: ${taskId}`);
          const index = cursors.get(taskId) ?? 0;
          cursors.set(taskId, index + 1);
          return sequence[Math.min(index, sequence.length - 1)];
        },
        ...extra,
      },
    };
  }

  it('succeeds only when every named task lands successfully', async () => {
    const h = runHarness({
      'task-a': [RUNNING, exited('0')],
      'task-b': [RUNNING, RUNNING, exited('0')],
    });
    const result = await waitRun('0068', ['task-a', 'task-b'], h.options);

    assert.equal(result.outcome, 'succeeded');
    assert.deepEqual(result.task_ids, ['task-a', 'task-b']);
    assert.deepEqual(result.tasks.map((task) => task.outcome), ['succeeded', 'succeeded']);
  });

  it('fails the run when any one task ends in a non-success terminal state', async () => {
    const h = runHarness({
      'task-a': [exited('0')],
      'task-b': [statusResult('cancelled', [{ event: 'agent_cancelled', time: 't' }])],
    });
    const result = await waitRun('0068', ['task-a', 'task-b'], h.options);

    assert.equal(result.outcome, 'failed');
    assert.equal(result.tasks[0].outcome, 'succeeded');
    assert.equal(result.tasks[1].outcome, 'failed');
    assert.equal(result.tasks[1].terminal_event, 'agent_cancelled');
  });

  it('reports per-task status as each one lands', async () => {
    const h = runHarness({
      'task-a': [exited('0')],
      'task-b': [statusResult('timed_out', [{ event: 'agent_timed_out', time: 't' }])],
    });
    await waitRun('0068', ['task-a', 'task-b'], h.options);

    assert.ok(h.lines.some((line) => /0068\/task-a: succeeded \(agent_exited/.test(line)));
    assert.ok(h.lines.some((line) => /0068\/task-b: failed \(agent_timed_out\)/.test(line)));
  });

  it('records an unresolvable task as an error without aborting the other waits', async () => {
    const h = runHarness({ 'task-a': [exited('0')] });
    const result = await waitRun('0068', ['task-a', 'ghost'], h.options);

    assert.equal(result.outcome, 'error');
    assert.equal(result.tasks[0].outcome, 'succeeded');
    assert.equal(result.tasks[1].outcome, 'error');
    assert.match(result.tasks[1].error ?? '', /instantiated task spec not found/);
  });

  it('defaults to every task in the run when no task_ids are named', async () => {
    const h = runHarness({ 'task-a': [exited('0')], 'task-b': [exited('0')] });
    const result = await waitRun('0068', [], {
      ...h.options,
      listTasks: () => ['task-a', 'task-b'],
    });

    assert.deepEqual(result.task_ids, ['task-a', 'task-b']);
    assert.equal(result.outcome, 'succeeded');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real ledger on disk, through the real status.ts, through the
// real launcher scripts. Nothing here stubs the ledger path or the event names.
// ---------------------------------------------------------------------------

interface Fixture {
  runId: string;
  stateRoot: string;
}

function fixture(id: string, ledgerLines: Array<Record<string, unknown>>, taskIds: string[]): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDir = join(stateRoot, 'runs', `run-${id}`);
  const ledgerPath = join(runDir, 'authoritative', 'ledger', 'events.jsonl');
  const worktree = join(TEST_TMP, id, 'worktree');

  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  for (const taskId of taskIds) {
    writeFileSync(join(runDir, 'tasks', `${taskId}.yaml`), [
      `task_id: ${taskId}`,
      `run_id: ${id}`,
      'assigned_vendor: codex',
      `worktree: ${worktree}`,
      'timeout_minutes: 45',
      'spec_version: 1',
      `branch: hydra/${id}/${taskId}`,
      'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
      '',
    ].join('\n'));
  }
  writeFileSync(ledgerPath, ledgerLines.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  return { runId: id, stateRoot };
}

function started(id: string, taskId: string): Record<string, unknown> {
  return {
    time: '2026-08-01T00:00:00Z',
    event: 'task_started',
    run_id: id,
    task_id: taskId,
    vendor: 'codex',
    agent_run_id: `${id}-${taskId}-v1`,
  };
}

function runSh(script: string, args: string[], f: Fixture, env: Record<string, string> = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HYDRA_HARNESS: 'ts',
      HYDRA_STATE_ROOT: f.stateRoot,
      HYDRA_REPO_ID: `test-${f.runId}`,
      ...env,
    },
  });
}

describe('wait-task.sh / wait-run.sh end to end', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('wait-task.sh exits 0 promptly on a successful terminal event, with --json output', () => {
    const id = uniqueRunId('ok');
    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:01:00Z', event: 'agent_exited', run_id: id, task_id: 'task-a', vendor: 'codex', exit_code: '0' },
    ], ['task-a']);

    const result = runSh(WAIT_TASK_SH, [id, 'task-a', '--json'], f);
    assert.equal(result.status, EXIT_SUCCESS, `exited ${result.status}\n${result.stderr}`);
    const doc = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(doc.outcome, 'succeeded');
    assert.equal(doc.terminal_event, 'agent_exited');
    assert.equal(doc.exit_code, '0');
    assert.equal(doc.task_id, 'task-a');
  });

  it('wait-task.sh still reports success when later ledger events bury the agent_exited', () => {
    // Live reproduction of the display-tail defect, with a real ledger read by
    // the real status.ts: a task that exited 0 and then accumulated more than
    // LEDGER_DISPLAY_TAIL further lifecycle events. status() reports
    // state=completed from the full attempt window, but its `ledger_events`
    // tail no longer contains the agent_exited. Reading the exit_code from that
    // tail called this genuine success a failure.
    const id = uniqueRunId('buried');
    const later = ['review_started', 'review_completed', 'review_started',
      'review_completed', 'promotion_started', 'promotion_completed']
      .map((event, index) => ({
        time: `2026-08-01T00:1${index}:00Z`,
        event,
        run_id: id,
        task_id: 'task-a',
      }));
    assert.ok(later.length > LEDGER_DISPLAY_TAIL, 'fixture must overflow the display tail');

    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:01:00Z', event: 'agent_exited', run_id: id, task_id: 'task-a', vendor: 'codex', exit_code: '0' },
      ...later,
    ], ['task-a']);

    const result = runSh(WAIT_TASK_SH, [id, 'task-a', '--json'], f);
    assert.equal(result.status, EXIT_SUCCESS, `exited ${result.status}\n${result.stdout}\n${result.stderr}`);
    const doc = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(doc.outcome, 'succeeded');
    assert.equal(doc.terminal_event, 'agent_exited');
    assert.equal(doc.exit_code, '0');
  });

  it('wait-task.sh exits non-zero and names the terminal event on a cancelled task', () => {
    const id = uniqueRunId('cancel');
    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:01:00Z', event: 'agent_cancelled', run_id: id, task_id: 'task-a', vendor: 'codex' },
    ], ['task-a']);

    const result = runSh(WAIT_TASK_SH, [id, 'task-a'], f);
    assert.equal(result.status, EXIT_TASK_NOT_SUCCESSFUL, `exited ${result.status}\n${result.stderr}`);
    assert.match(result.stdout, /terminal_event: agent_cancelled/);
    assert.match(result.stdout, /outcome: failed/);
  });

  it('wait-task.sh fails loudly and immediately for a task with no ledger entries', () => {
    const id = uniqueRunId('ghost');
    const f = fixture(id, [started(id, 'task-a')], ['task-a', 'task-b']);

    const startedAt = Date.now();
    const result = runSh(WAIT_TASK_SH, [id, 'task-b', '--timeout-seconds', '600'], f);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, EXIT_ERROR, `exited ${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /no ledger events for .*\/task-b/);
    assert.ok(elapsedMs < 30_000, `must not hang; took ${elapsedMs}ms`);
  });

  it('wait-task.sh exits with the wait-timeout code when the task is still running', () => {
    const id = uniqueRunId('slow');
    const f = fixture(id, [started(id, 'task-a')], ['task-a']);

    const result = runSh(
      WAIT_TASK_SH,
      [id, 'task-a', '--timeout-seconds', '1', '--poll-interval-ms', '200', '--heartbeat-seconds', '0'],
      f,
    );
    assert.equal(result.status, EXIT_WAIT_TIMED_OUT, `exited ${result.status}\n${result.stderr}`);
    assert.match(result.stdout, /outcome: wait_timed_out/);
  });

  it('wait-task.sh keeps waiting on a real queued (concurrency_wait) ledger instead of erroring', () => {
    // The shape dispatch actually writes while parked in acquireSlot(): the
    // attempt window exists and trails with concurrency_wait, no terminal event
    // yet. This must behave like any other non-terminal wait (exit 3 on the
    // deadline), NOT fail loud with "the task was never dispatched".
    const id = uniqueRunId('queued');
    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:00:01Z', event: 'concurrency_wait', run_id: id, task_id: 'task-a', cap: '3', active: '3' },
    ], ['task-a']);

    const result = runSh(
      WAIT_TASK_SH,
      [id, 'task-a', '--timeout-seconds', '1', '--poll-interval-ms', '200', '--heartbeat-seconds', '0'],
      f,
    );

    assert.notEqual(result.status, EXIT_ERROR, `must not fail loud on a queued task\n${result.stderr}`);
    assert.equal(result.status, EXIT_WAIT_TIMED_OUT, `exited ${result.status}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /never dispatched/);
    assert.match(result.stdout, /outcome: wait_timed_out/);
  });

  it('wait-run.sh keeps waiting on a queued batch rather than erroring per task', () => {
    const id = uniqueRunId('queuedfan');
    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:00:01Z', event: 'agent_exited', run_id: id, task_id: 'task-a', vendor: 'codex', exit_code: '0' },
      started(id, 'task-b'),
      { time: '2026-08-01T00:00:02Z', event: 'concurrency_wait', run_id: id, task_id: 'task-b', cap: '1', active: '1' },
    ], ['task-a', 'task-b']);

    const result = runSh(
      WAIT_RUN_SH,
      [id, '--timeout-seconds', '1', '--poll-interval-ms', '200', '--heartbeat-seconds', '0', '--json'],
      f,
    );

    assert.equal(result.status, EXIT_WAIT_TIMED_OUT, `exited ${result.status}\n${result.stderr}`);
    const doc = JSON.parse(result.stdout) as { outcome: string; tasks: Array<Record<string, unknown>> };
    assert.equal(doc.outcome, 'wait_timed_out');
    assert.equal(doc.tasks[0].outcome, 'succeeded');
    assert.equal(doc.tasks[1].outcome, 'wait_timed_out', 'a queued task is waited on, not errored');
    assert.equal(doc.tasks[1].error, null);
  });

  it('wait-task.sh does not report success when the ledger records no exit_code', () => {
    const id = uniqueRunId('noexit');
    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:01:00Z', event: 'agent_exited', run_id: id, task_id: 'task-a', vendor: 'codex' },
    ], ['task-a']);

    const result = runSh(WAIT_TASK_SH, [id, 'task-a', '--json'], f);
    assert.equal(result.status, EXIT_TASK_NOT_SUCCESSFUL, `exited ${result.status}\n${result.stderr}`);
    const doc = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(doc.state, 'completed');
    assert.equal(doc.outcome, 'failed');
    assert.equal(doc.exit_code, null);
  });

  it('wait-run.sh waits on all tasks in the run when none are named', () => {
    const id = uniqueRunId('fanout');
    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:01:00Z', event: 'agent_exited', run_id: id, task_id: 'task-a', vendor: 'codex', exit_code: '0' },
      started(id, 'task-b'),
      { time: '2026-08-01T00:02:00Z', event: 'agent_exited', run_id: id, task_id: 'task-b', vendor: 'codex', exit_code: '2' },
    ], ['task-a', 'task-b']);

    const result = runSh(WAIT_RUN_SH, [id, '--json'], f);
    assert.equal(result.status, EXIT_TASK_NOT_SUCCESSFUL, `exited ${result.status}\n${result.stderr}`);
    const doc = JSON.parse(result.stdout) as { outcome: string; task_ids: string[]; tasks: Array<Record<string, unknown>> };
    assert.deepEqual(doc.task_ids, ['task-a', 'task-b']);
    assert.equal(doc.outcome, 'failed');
    assert.equal(doc.tasks[0].outcome, 'succeeded');
    assert.equal(doc.tasks[1].outcome, 'failed');
    assert.equal(doc.tasks[1].exit_code, '2');
  });

  it('wait-run.sh succeeds for an explicitly named subset that all passed', () => {
    const id = uniqueRunId('subset');
    const f = fixture(id, [
      started(id, 'task-a'),
      { time: '2026-08-01T00:01:00Z', event: 'agent_exited', run_id: id, task_id: 'task-a', vendor: 'codex', exit_code: '0' },
      started(id, 'task-b'),
    ], ['task-a', 'task-b']);

    const result = runSh(WAIT_RUN_SH, [id, 'task-a'], f);
    assert.equal(result.status, EXIT_SUCCESS, `exited ${result.status}\n${result.stderr}`);
    assert.match(result.stdout, /task-a: succeeded/);
  });

  it('routes the bin lane to a pinned HYDRA_BIN with the wait-task subcommand and original argv', () => {
    const id = uniqueRunId('bin');
    const f = fixture(id, [started(id, 'task-a')], ['task-a']);
    const dir = join(TEST_TMP, id);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'fake-hydra-cli');
    const record = join(dir, 'fake-bin.record');
    writeFileSync(bin, [
      '#!/usr/bin/env bash',
      '{',
      '  printf \'argv:\';',
      '  for a in "$@"; do printf \' %s\' "$a"; done',
      '  printf \'\\n\'',
      '  if [ -n "${BUN_BE_BUN+x}" ]; then printf \'BUN_BE_BUN=set\\n\';',
      '  else printf \'BUN_BE_BUN=unset\\n\'; fi',
      '} >"$HYDRA_FAKE_BIN_RECORD"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });

    for (const [script, subcommand, args] of [
      [WAIT_TASK_SH, 'wait-task', [id, 'task-a', '--timeout-seconds', '30']],
      [WAIT_RUN_SH, 'wait-run', [id, 'task-a', 'task-b', '--json']],
    ] as const) {
      const result = runSh(script, [...args], f, {
        HYDRA_HARNESS: 'bin',
        HYDRA_BIN: bin,
        HYDRA_FAKE_BIN_RECORD: record,
        BUN_BE_BUN: '1',
      });
      assert.equal(result.status, 0, `bin route exited ${result.status}\n${result.stderr}`);
      const captured = readFileSync(record, 'utf8');
      assert.ok(
        captured.includes(`argv: ${subcommand} ${args.join(' ')}`),
        `bin argv mismatch for ${subcommand}: ${captured}`,
      );
      assert.ok(captured.includes('BUN_BE_BUN=unset'), `BUN_BE_BUN must be stripped: ${captured}`);
    }
  });
});

describe('cli wiring', () => {
  it('does not pollute the pinned Stage-1 routes table', () => {
    assert.equal(Object.hasOwn(routes, 'wait-task'), false);
    assert.equal(Object.hasOwn(routes, 'wait-run'), false);
  });

  it('lists both subcommands with their signatures in usage()', () => {
    const text = usage();
    assert.match(text, /\n {2}wait-task\n {6}<run_id> <task_id> \[--timeout-seconds N\]/);
    assert.match(text, /\n {2}wait-run\n {6}<run_id> \[task_id\.\.\.\] \[--timeout-seconds N\]/);
  });

  it('mainRun rejects a missing run_id with the wait-run usage string', async () => {
    const stderr: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await mainRun([]);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(code, EXIT_ERROR);
    assert.match(stderr.join(''), /usage: wait-run/);
  });
});
