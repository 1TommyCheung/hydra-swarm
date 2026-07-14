import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { status, main, type StatusOptions } from '../src/status.ts';

const TEST_TMP = join(tmpdir(), `hydra-ts-status-${process.pid}`);

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface Fixture {
  runId: string;
  stateRoot: string;
  runDir: string;
  sessionsDir: string;
  taskSpecPath: string;
  ledgerPath: string;
}

function fixture(
  id: string,
  overrides: {
    vendor?: string;
    timeoutMinutes?: number;
    specVersion?: number | string;
  } = {},
): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDirPath = join(stateRoot, 'runs', `run-${id}`);
  const sessionsDir = join(runDirPath, 'sessions');
  const taskSpecPath = join(runDirPath, 'tasks', 'task-a.yaml');
  const vendor = overrides.vendor ?? 'kimi';

  mkdirSync(join(runDirPath, 'tasks'), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(taskSpecPath, [
    'task_id: task-a',
    `run_id: ${id}`,
    `assigned_vendor: ${vendor}`,
    `worktree: ${join(TEST_TMP, id, 'worktree')}`,
    `timeout_minutes: ${overrides.timeoutMinutes ?? 45}`,
    `spec_version: ${overrides.specVersion ?? 1}`,
    `branch: hydra/${id}/task-a`,
    'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    '',
  ].join('\n'));

  return {
    runId: id,
    stateRoot,
    runDir: runDirPath,
    sessionsDir,
    taskSpecPath,
    ledgerPath: join(runDirPath, 'authoritative', 'ledger', 'events.jsonl'),
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

function writeDispatchPidfile(f: Fixture, pid: number): void {
  const supervisorDir = join(f.sessionsDir, 'supervisor');
  mkdirSync(supervisorDir, { recursive: true });
  writeFileSync(join(supervisorDir, `${f.runId}-task-a-v1.dispatch.pid`), `${pid}\n`, 'utf8');
}

function baseOptions(f: Fixture, extras: StatusOptions = {}): StatusOptions {
  return { stateRoot: f.stateRoot, ...extras };
}

describe('status', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('rejects missing arguments before performing I/O', () => {
    assert.throws(() => status('', 'task-a'), /usage: status/);
    assert.throws(() => status('run', ''), /usage: status/);
  });

  it('reports a running task with a live dispatch process', () => {
    const f = fixture(uniqueRunId('running'));
    const startedTime = '2024-01-01T00:00:00Z';
    const nowMs = Date.parse(startedTime) + 3 * 60 * 1000 + 12 * 1000;
    writeLedger(f, [
      { time: startedTime, event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:01:00Z', event: 'herdr_pane_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
    ]);
    writeDispatchPidfile(f, 12345);

    const result = status(f.runId, 'task-a', baseOptions(f, {
      now: () => nowMs,
      processAlive: (pid) => pid === 12345,
    }));

    assert.equal(result.state, 'running');
    assert.equal(result.agent_run_id, `${f.runId}-task-a-v1`);
    assert.equal(result.vendor, 'kimi');
    assert.equal(result.elapsed_seconds, 192);
    assert.equal(result.timeout_minutes, 45);
    assert.equal(result.hard_cap_minutes, 270);
    assert.deepEqual(result.dispatch_liveness, { pid: 12345, alive: true, advisory: true });
    assert.equal(result.disagreement, null);
    assert.deepEqual(result.ledger_events.map(({ event }) => event), ['task_started', 'herdr_pane_started']);
  });

  it('ignores stale terminal events from a previous spec_version retry', () => {
    const f = fixture(uniqueRunId('retry'), { specVersion: 2 });
    const oldStarted = '2024-01-01T00:00:00Z';
    const newStarted = '2024-01-01T00:10:00Z';
    const nowMs = Date.parse(newStarted) + 2 * 60 * 1000;
    writeLedger(f, [
      { time: oldStarted, event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:05:00Z', event: 'agent_timed_out', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
      { time: newStarted, event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v2` },
      { time: '2024-01-01T00:11:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
    ]);
    const supervisorDir = join(f.sessionsDir, 'supervisor');
    mkdirSync(supervisorDir, { recursive: true });
    writeFileSync(join(supervisorDir, `${f.runId}-task-a-v2.dispatch.pid`), '12345\n', 'utf8');

    const result = status(f.runId, 'task-a', baseOptions(f, {
      now: () => nowMs,
      processAlive: (pid) => pid === 12345,
    }));

    assert.equal(result.state, 'running');
    assert.equal(result.agent_run_id, `${f.runId}-task-a-v2`);
    assert.equal(result.elapsed_seconds, 120);
    assert.equal(result.disagreement, null);
  });

  it('reports a completed task when agent_exited is present', () => {
    const f = fixture(uniqueRunId('completed'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:05:00Z', event: 'agent_exited', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', exit_code: '0' },
    ]);

    const result = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse('2024-01-01T00:06:00Z'),
    }));

    assert.equal(result.state, 'completed');
    assert.equal(result.elapsed_seconds, 360);
    assert.equal(result.disagreement, null);
    assert.equal(result.dispatch_liveness, null);
    assert.deepEqual(result.ledger_events.at(-1)?.event, 'agent_exited');
  });

  it('surfaces disagreement when the ledger says running but the pidfile is missing', () => {
    const f = fixture(uniqueRunId('missing-pidfile'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
    ]);

    const result = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse('2024-01-01T00:01:00Z'),
    }));

    assert.equal(result.state, 'running');
    assert.equal(result.dispatch_liveness, null);
    assert.match(result.disagreement ?? '', /no dispatch pidfile exists/);
  });

  it('does not report a missing pidfile disagreement within the grace window', () => {
    const f = fixture(uniqueRunId('grace-window'));
    const startedTime = '2024-01-01T00:00:00Z';
    writeLedger(f, [
      { time: startedTime, event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
    ]);

    const justStarted = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse(startedTime) + 1000,
    }));
    assert.equal(justStarted.state, 'running');
    assert.equal(justStarted.disagreement, null);

    const afterGrace = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse(startedTime) + 10 * 1000,
    }));
    assert.equal(afterGrace.state, 'running');
    assert.match(afterGrace.disagreement ?? '', /no dispatch pidfile exists/);
  });

  it('does not report disagreement when the task is still queued on concurrency_wait', () => {
    const f = fixture(uniqueRunId('queued'));
    const startedTime = '2024-01-01T00:00:00Z';
    writeLedger(f, [
      { time: startedTime, event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:00:01Z', event: 'concurrency_wait', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', cap: '2', active: '2' },
    ]);

    const queued = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse(startedTime) + 30 * 1000,
    }));

    assert.equal(queued.state, 'running');
    assert.equal(queued.dispatch_liveness, null);
    assert.equal(queued.disagreement, null);
  });

  it('reports disagreement once the task progresses past concurrency_wait without a pidfile', () => {
    const f = fixture(uniqueRunId('queued-then-started'));
    const startedTime = '2024-01-01T00:00:00Z';
    writeLedger(f, [
      { time: startedTime, event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:00:01Z', event: 'concurrency_wait', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', cap: '2', active: '2' },
      { time: '2024-01-01T00:00:02Z', event: 'herdr_pane_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
    ]);

    const started = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse(startedTime) + 30 * 1000,
    }));

    assert.equal(started.state, 'running');
    assert.equal(started.dispatch_liveness, null);
    assert.match(started.disagreement ?? '', /no dispatch pidfile exists/);
  });

  it('surfaces disagreement when the ledger says running but the dispatch process is dead', () => {
    const f = fixture(uniqueRunId('dead-dispatch'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
    ]);
    writeDispatchPidfile(f, 99999);

    const result = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse('2024-01-01T00:01:00Z'),
      processAlive: () => false,
    }));

    assert.equal(result.state, 'running');
    assert.deepEqual(result.dispatch_liveness, { pid: 99999, alive: false, advisory: true });
    assert.match(result.disagreement ?? '', /dispatch process is not alive/);
  });

  it('surfaces disagreement when the ledger says completed but a process is still alive', () => {
    const f = fixture(uniqueRunId('zombie'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:05:00Z', event: 'agent_exited', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', exit_code: '0' },
    ]);
    writeDispatchPidfile(f, 12345);

    const result = status(f.runId, 'task-a', baseOptions(f, {
      now: () => Date.parse('2024-01-01T00:06:00Z'),
      processAlive: () => true,
    }));

    assert.equal(result.state, 'completed');
    assert.match(result.disagreement ?? '', /dispatch process is still alive/);
  });

  it('reports cancelled and timed_out terminal states', () => {
    const cancelled = fixture(uniqueRunId('cancelled'));
    writeLedger(cancelled, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: cancelled.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${cancelled.runId}-task-a-v1` },
      { time: '2024-01-01T00:02:00Z', event: 'agent_cancelled', run_id: cancelled.runId, task_id: 'task-a', vendor: 'kimi' },
    ]);
    assert.equal(status(cancelled.runId, 'task-a', baseOptions(cancelled)).state, 'cancelled');

    const timedOut = fixture(uniqueRunId('timed-out'));
    writeLedger(timedOut, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: timedOut.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${timedOut.runId}-task-a-v1` },
      { time: '2024-01-01T00:02:00Z', event: 'agent_timed_out', run_id: timedOut.runId, task_id: 'task-a', vendor: 'kimi', reason: 'stalled' },
    ]);
    assert.equal(status(timedOut.runId, 'task-a', baseOptions(timedOut)).state, 'timed_out');
  });

  it('returns unknown when no task events exist', () => {
    const f = fixture(uniqueRunId('unknown'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: f.runId },
    ]);

    const result = status(f.runId, 'task-a', baseOptions(f));

    assert.equal(result.state, 'unknown');
    assert.equal(result.elapsed_seconds, null);
  });

  it('respects HYDRA_HARD_CAP_MIN for the hard cap', () => {
    const f = fixture(uniqueRunId('hard-cap'));
    process.env.HYDRA_HARD_CAP_MIN = '90';
    try {
      writeLedger(f, [
        { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      ]);
      const result = status(f.runId, 'task-a', baseOptions(f));
      assert.equal(result.hard_cap_minutes, 90);
    } finally {
      delete process.env.HYDRA_HARD_CAP_MIN;
    }
  });

  it('tails the last N progress lines from cli.jsonl and parses kimi events', () => {
    const f = fixture(uniqueRunId('progress'), { vendor: 'kimi' });
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
    ]);
    writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.cli.jsonl`), [
      JSON.stringify({ role: 'assistant', content: 'line one' }),
      JSON.stringify({ role: 'assistant', content: 'line two' }),
      JSON.stringify({ role: 'assistant', content: 'line three' }),
      JSON.stringify({ role: 'assistant', content: 'line four' }),
      '',
    ].join('\n'), 'utf8');

    const result = status(f.runId, 'task-a', baseOptions(f, { lines: 2 }));

    assert.equal(result.progress_source, 'cli.jsonl');
    assert.deepEqual(result.progress_tail, ['line three', 'line four']);
  });

  it('falls back to events.jsonl and stderr in preference order', () => {
    const events = fixture(uniqueRunId('events'));
    writeLedger(events, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: events.runId, task_id: 'task-a', vendor: 'opencode', agent_run_id: `${events.runId}-task-a-v1` },
    ]);
    writeFileSync(join(events.sessionsDir, `${events.runId}-task-a-v1.events.jsonl`), 'event-one\nevent-two\n', 'utf8');
    const eventsResult = status(events.runId, 'task-a', baseOptions(events, { lines: 5 }));
    assert.equal(eventsResult.progress_source, 'events.jsonl');
    assert.deepEqual(eventsResult.progress_tail, ['event-one', 'event-two']);

    const stderr = fixture(uniqueRunId('stderr'));
    writeLedger(stderr, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: stderr.runId, task_id: 'task-a', vendor: 'claude', agent_run_id: `${stderr.runId}-task-a-v1` },
    ]);
    writeFileSync(join(stderr.sessionsDir, `${stderr.runId}-task-a-v1.stderr`), 'err-one\nerr-two\n', 'utf8');
    const stderrResult = status(stderr.runId, 'task-a', baseOptions(stderr, { lines: 5 }));
    assert.equal(stderrResult.progress_source, 'stderr');
    assert.deepEqual(stderrResult.progress_tail, ['err-one', 'err-two']);
  });

  it('returns the last 5 ledger events for the task', () => {
    const f = fixture(uniqueRunId('last-five'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
      { time: '2024-01-01T00:01:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
      { time: '2024-01-01T00:02:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
      { time: '2024-01-01T00:03:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
      { time: '2024-01-01T00:04:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
      { time: '2024-01-01T00:05:00Z', event: 'heartbeat', run_id: f.runId, task_id: 'task-a', vendor: 'kimi' },
      { time: '2024-01-01T00:06:00Z', event: 'agent_exited', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', exit_code: '0' },
      { time: '2024-01-01T00:07:00Z', event: 'other_task_event', run_id: f.runId, task_id: 'task-b', vendor: 'kimi' },
    ]);

    const result = status(f.runId, 'task-a', baseOptions(f));

    assert.equal(result.ledger_events.length, 5);
    assert.deepEqual(result.ledger_events.map(({ event }) => event), [
      'heartbeat',
      'heartbeat',
      'heartbeat',
      'heartbeat',
      'agent_exited',
    ]);
  });

  it('emits a valid JSON object from main with --json', () => {
    const f = fixture(uniqueRunId('json'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
    ]);

    const previous = process.env.HYDRA_STATE_ROOT;
    process.env.HYDRA_STATE_ROOT = f.stateRoot;
    let stdout = '';
    try {
      stdout = captureStdout(() => main([f.runId, 'task-a', '--json']));
    } finally {
      if (previous === undefined) delete process.env.HYDRA_STATE_ROOT;
      else process.env.HYDRA_STATE_ROOT = previous;
    }

    const parsed = JSON.parse(stdout) as ReturnType<typeof status>;

    assert.equal(parsed.state, 'running');
    assert.equal(parsed.agent_run_id, `${f.runId}-task-a-v1`);
    assert.equal(parsed.vendor, 'kimi');
    assert.equal(typeof parsed.elapsed_seconds, 'number');
    assert.equal(parsed.timeout_minutes, 45);
    assert.equal(parsed.hard_cap_minutes, 270);
    assert.equal(parsed.dispatch_liveness, null);
    assert.match(parsed.disagreement ?? '', /no dispatch pidfile/);
    assert.ok(Array.isArray(parsed.progress_tail));
    assert.ok(Array.isArray(parsed.ledger_events));
  });

  it('CLI usage errors exit 1 without reading state', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../src/status.ts'),
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: status/);
  });

  it('human output includes key fields and a disagreement warning', () => {
    const f = fixture(uniqueRunId('human'));
    writeLedger(f, [
      { time: '2024-01-01T00:00:00Z', event: 'task_started', run_id: f.runId, task_id: 'task-a', vendor: 'kimi', agent_run_id: `${f.runId}-task-a-v1` },
    ]);

    const previous = process.env.HYDRA_STATE_ROOT;
    process.env.HYDRA_STATE_ROOT = f.stateRoot;
    let stdout = '';
    try {
      stdout = captureStdout(() => main([f.runId, 'task-a']));
    } finally {
      if (previous === undefined) delete process.env.HYDRA_STATE_ROOT;
      else process.env.HYDRA_STATE_ROOT = previous;
    }

    assert.match(stdout, /state: running/);
    assert.match(stdout, new RegExp(`agent_run_id: ${f.runId}-task-a-v1`));
    assert.match(stdout, /vendor: kimi/);
    assert.match(stdout, /dispatch_pid: none \(advisory\)/);
    assert.match(stdout, /disagreement:/);
  });
});

function captureStdout(callback: () => unknown): string {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    callback();
    return chunks.join('');
  } finally {
    process.stdout.write = original;
  }
}
