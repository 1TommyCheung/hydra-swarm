import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  dispatch,
  type ChildProcessLike,
  type Clock,
  type DispatchOptions,
  type HerdrClient,
  type SpawnLike,
} from '../src/dispatch.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-dispatch');
let sequence = 0;

function runId(): string {
  sequence += 1;
  return `dispatch-${sequence}`;
}

interface Fixture {
  runId: string;
  stateRoot: string;
  runDir: string;
  sessionsDir: string;
  worktree: string;
  repoRoot: string;
  adapterPath: string;
  taskSpecPath: string;
}

function fixture(
  id: string,
  overrides: {
    vendor?: string;
    timeoutMinutes?: number;
    specVersion?: number | string;
    adapterContent?: string;
    worktree?: string;
  } = {},
): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDir = join(stateRoot, 'runs', `run-${id}`);
  const sessionsDir = join(runDir, 'sessions');
  const worktree = overrides.worktree ?? join(TEST_TMP, id, 'worktree');
  const repoRoot = join(TEST_TMP, id, 'repo');
  const adapterDir = join(repoRoot, 'hydra', 'adapters');
  const taskSpecPath = join(runDir, 'tasks', 'task-a.yaml');
  const vendor = overrides.vendor ?? 'claude';

  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(taskSpecPath, [
    'task_id: task-a',
    `run_id: ${id}`,
    `assigned_vendor: ${vendor}`,
    `worktree: ${worktree}`,
    `timeout_minutes: ${overrides.timeoutMinutes ?? 45}`,
    `spec_version: ${overrides.specVersion ?? 1}`,
    `branch: hydra/${id}/task-a`,
    'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    '',
  ].join('\n'));
  const adapterPath = join(adapterDir, `${vendor}.sh`);
  writeFileSync(adapterPath, overrides.adapterContent ?? '#!/usr/bin/env bash\necho ok\n');
  return { runId: id, stateRoot, runDir, sessionsDir, worktree, repoRoot, adapterPath, taskSpecPath };
}

function ledger(f: Fixture): Array<Record<string, string>> {
  const path = join(f.runDir, 'authoritative', 'ledger', 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>);
}

class FakeChild extends EventEmitter implements ChildProcessLike {
  killed = false;
  readonly pid: number;

  constructor(pid = 10_000 + sequence) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Parameters<SpawnLike>[2];
  child: FakeChild;
}

function fakeSpawn(options: {
  autoExit?: number | false;
  signal?: NodeJS.Signals;
  onSpawn?: (call: SpawnCall) => void;
} = {}): { spawn: SpawnLike; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: SpawnLike = (command, args, spawnOptions) => {
    const child = new FakeChild(20_000 + sequence + calls.length);
    const call = { command, args, options: spawnOptions, child };
    calls.push(call);
    options.onSpawn?.(call);
    if (options.autoExit !== false) {
      queueMicrotask(() => child.exit(options.signal ? null : (options.autoExit ?? 0), options.signal ?? null));
    }
    return child;
  };
  return { spawn, calls };
}

class FakeHerdr implements HerdrClient {
  live = false;
  workspace: string | undefined;
  paneId: string | undefined = 'pane-1';
  starts: Array<{ label: string; cwd: string; workspace?: string; command: string }> = [];
  closes: string[] = [];

  isLive(): boolean { return this.live; }
  focusedWorkspace(): string | undefined { return this.workspace; }
  agentStart(options: { label: string; cwd: string; workspace?: string; command: string }): string | undefined {
    this.starts.push(options);
    return this.paneId;
  }
  paneClose(paneId: string): boolean {
    this.closes.push(paneId);
    return true;
  }
}

class StepClock implements Clock {
  current = 0;
  sleeps = 0;
  private readonly onSleep?: (ms: number, count: number) => void;

  constructor(onSleep?: (ms: number, count: number) => void) {
    this.onSleep = onSleep;
  }

  now(): number { return this.current; }
  async sleep(ms: number): Promise<void> {
    this.current += ms;
    this.sleeps += 1;
    this.onSleep?.(ms, this.sleeps);
  }
}

class GateClock implements Clock {
  current = 0;
  private waiters: Array<() => void> = [];

  now(): number { return this.current; }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.current += ms;
        resolve();
      });
    });
  }
  release(): void {
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }
}

function injectedOptions(
  f: Fixture,
  spawn: SpawnLike,
  overrides: DispatchOptions = {},
): DispatchOptions & { killed: number[]; usage: string[][]; states: string[][] } {
  const killed: number[] = [];
  const usage: string[][] = [];
  const states: string[][] = [];
  return {
    stateRoot: f.stateRoot,
    repoRoot: f.repoRoot,
    env: {},
    noSignals: true,
    spawn,
    herdr: new FakeHerdr(),
    herdrState: (...args) => { states.push(args); },
    killTree: (pid) => { killed.push(pid); },
    recordUsage: (...args) => { usage.push(args); },
    execFileSync: () => { throw new Error('external command execution was not expected'); },
    clock: new StepClock(),
    ...overrides,
    killed,
    usage,
    states,
  };
}

async function captureStdout<T>(callback: () => Promise<T>): Promise<{ output: string; value: T }> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = await callback();
    return { output: chunks.join(''), value };
  } finally {
    process.stdout.write = original;
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('dispatch Bash parity', () => {
  before(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => rmSync(TEST_TMP, { recursive: true, force: true }));

  it('rejects missing arguments before performing I/O', async () => {
    await assert.rejects(dispatch('', 'task-a'), /usage: dispatch/);
    await assert.rejects(dispatch('run', ''), /usage: dispatch/);
  });

  it('rejects a missing or non-file instantiated task spec', async () => {
    const id = runId();
    await assert.rejects(dispatch(id, 'task-a', {
      stateRoot: join(TEST_TMP, id, 'state'),
      repoRoot: join(TEST_TMP, id, 'repo'),
      noSignals: true,
    }), /instantiated task spec not found/);

    const f = fixture(runId());
    rmSync(f.taskSpecPath);
    mkdirSync(f.taskSpecPath);
    await assert.rejects(dispatch(f.runId, 'task-a', {
      stateRoot: f.stateRoot,
      repoRoot: f.repoRoot,
      noSignals: true,
    }), /instantiated task spec not found/);
  });

  it('rejects a missing or non-file vendor adapter', async () => {
    const f = fixture(runId());
    rmSync(f.adapterPath);
    const { spawn } = fakeSpawn();
    await assert.rejects(dispatch(f.runId, 'task-a', injectedOptions(f, spawn)), /no adapter for vendor 'claude'/);
    mkdirSync(f.adapterPath);
    await assert.rejects(dispatch(f.runId, 'task-a', injectedOptions(f, spawn)), /no adapter for vendor 'claude'/);
  });

  it('rejects a missing or non-directory worktree', async () => {
    const f = fixture(runId());
    rmSync(f.worktree, { recursive: true });
    writeFileSync(f.worktree, 'not a directory');
    const { spawn } = fakeSpawn();
    await assert.rejects(dispatch(f.runId, 'task-a', injectedOptions(f, spawn)), /worktree not created yet/);
  });

  it('dispatches the selected adapter and closes task_started with agent_exited', async () => {
    const f = fixture(runId(), { specVersion: '03' });
    const mock = fakeSpawn();
    const options = injectedOptions(f, mock.spawn);
    const { output, value } = await captureStdout(() => dispatch(f.runId, 'task-a', options));

    assert.equal(value.agentRunId, `${f.runId}-task-a-v03`);
    assert.equal(output.trim(), value.agentRunId);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].command, f.adapterPath);
    assert.deepEqual(mock.calls[0].args, [
      'start', f.taskSpecPath, f.worktree,
      join(f.runDir, 'inbox', value.agentRunId),
      f.sessionsDir, value.agentRunId, '',
    ]);
    assert.equal(mock.calls[0].options?.env, options.env);
    assert.equal(mock.calls[0].options?.cwd, process.cwd());
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'agent_exited']);
    assert.equal(ledger(f)[1].exit_code, '0');
    assert.deepEqual(options.usage, [[f.runId, 'task-a', 'claude', value.agentRunId]]);
  });

  it('records non-zero and signal-derived worker exit codes', async () => {
    const nonzero = fixture(runId());
    await dispatch(nonzero.runId, 'task-a', injectedOptions(nonzero, fakeSpawn({ autoExit: 42 }).spawn));
    assert.equal(ledger(nonzero).at(-1)?.exit_code, '42');

    const signalled = fixture(runId());
    await dispatch(signalled.runId, 'task-a', injectedOptions(
      signalled,
      fakeSpawn({ signal: 'SIGTERM' }).spawn,
    ));
    assert.equal(ledger(signalled).at(-1)?.exit_code, '143');
  });

  it('times out after the exact inactivity window without a false first-poll reset', async () => {
    const f = fixture(runId(), { timeoutMinutes: 1 });
    const mock = fakeSpawn({ autoExit: false });
    const clock = new StepClock();
    const options = injectedOptions(f, mock.spawn, { clock, pollIntervalMs: 20_000 });
    await dispatch(f.runId, 'task-a', options);

    assert.equal(clock.sleeps, 3);
    assert.deepEqual(options.killed, [mock.calls[0].child.pid]);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'agent_timed_out']);
    assert.equal(ledger(f)[1].reason, 'stalled');
  });

  it('renews inactivity only when capture-file output changes', async () => {
    const f = fixture(runId(), { timeoutMinutes: 1 });
    const mock = fakeSpawn({ autoExit: false });
    let capture = '';
    const clock = new StepClock((_ms, count) => {
      if (count === 2) {
        capture = join(f.sessionsDir, `${f.runId}-task-a-v1.stderr`);
        writeFileSync(capture, 'activity');
      }
    });
    const options = injectedOptions(f, mock.spawn, { clock, pollIntervalMs: 20_000 });
    await dispatch(f.runId, 'task-a', options);

    assert.equal(existsSync(capture), true);
    assert.equal(clock.sleeps, 5);
    assert.equal(ledger(f).at(-1)?.reason, 'stalled');
  });

  it('enforces the hard cap even while capture output keeps growing', async () => {
    const f = fixture(runId(), { timeoutMinutes: 10 });
    const mock = fakeSpawn({ autoExit: false });
    const capture = join(f.sessionsDir, `${f.runId}-task-a-v1.cli.jsonl`);
    const clock = new StepClock((_ms, count) => writeFileSync(capture, 'x'.repeat(count)));
    const options = injectedOptions(f, mock.spawn, {
      clock,
      pollIntervalMs: 20_000,
      env: { HYDRA_HARD_CAP_MIN: '1' },
    });
    await dispatch(f.runId, 'task-a', options);

    assert.equal(clock.sleeps, 3);
    assert.equal(ledger(f).at(-1)?.reason, 'hard_cap');
  });

  it('cancels an active worker exactly once through an injected abort signal', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn({ autoExit: false });
    const controller = new AbortController();
    const gate = new GateClock();
    const options = injectedOptions(f, mock.spawn, {
      background: true,
      clock: gate,
      signal: controller.signal,
    });
    const handle = await dispatch(f.runId, 'task-a', options);
    controller.abort();
    await handle.finished;

    assert.deepEqual(options.killed, [mock.calls[0].child.pid]);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'agent_cancelled']);
    assert.deepEqual(options.usage, []);
  });

  it('counts nested slot files, records one concurrency_wait, then proceeds', async () => {
    const f = fixture(runId());
    const nested = join(f.runDir, '.slots', 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'occupied'), '');
    const gate = new GateClock();
    const mock = fakeSpawn();
    const options = injectedOptions(f, mock.spawn, {
      background: true,
      maxConcurrency: 1,
      clock: gate,
    });
    const pending = dispatch(f.runId, 'task-a', options);
    await flush();

    assert.equal(mock.calls.length, 0);
    assert.equal(ledger(f).filter(({ event }) => event === 'concurrency_wait').length, 1);
    rmSync(join(nested, 'occupied'));
    gate.release();
    const handle = await pending;
    await handle.finished;
    assert.equal(mock.calls.length, 1);
  });

  it('uses the newest non-empty session only when resume is requested and supported', async () => {
    const f = fixture(runId(), { adapterContent: 'case "$1" in start|resume) ;; esac\n' });
    const oldPath = join(f.sessionsDir, `${f.runId}-task-a-v1.json`);
    const newEmptyPath = join(f.sessionsDir, `${f.runId}-task-a-v2.json`);
    writeFileSync(oldPath, JSON.stringify({ session_id: 'session-old' }));
    writeFileSync(newEmptyPath, JSON.stringify({ session_id: '' }));
    const old = new Date(1_000_000);
    const recent = new Date(2_000_000);
    utimesSync(oldPath, old, old);
    utimesSync(newEmptyPath, recent, recent);
    const mock = fakeSpawn();
    const options = injectedOptions(f, mock.spawn, { env: { HYDRA_DELIVERY: 'resume' } });
    await dispatch(f.runId, 'task-a', options);

    assert.equal(mock.calls[0].args[0], 'resume');
    assert.equal(mock.calls[0].args.at(-1), 'session-old');
    assert.equal(ledger(f)[0].delivery, 'resume');
  });

  it('cold-restarts while preserving a discovered prior session when resume is unsupported', async () => {
    const f = fixture(runId());
    writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.json`), JSON.stringify({ session_id: 'session-1' }));
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_DELIVERY: 'resume' },
    }));
    assert.equal(mock.calls[0].args[0], 'start');
    assert.equal(mock.calls[0].args.at(-1), 'session-1');
  });

  it('hosts in an injected herdr pane, captures its sentinel, and reports states', async () => {
    const f = fixture(runId());
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = 'workspace-1';
    const states: string[][] = [];
    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '7');
    });
    const options = injectedOptions(f, () => { throw new Error('plain spawn must not run'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
      background: true,
      herdrState: (...args) => { states.push(args); },
    });
    const handle = await dispatch(f.runId, 'task-a', options);
    await handle.finished;

    assert.equal(herdr.starts.length, 1);
    assert.equal(herdr.starts[0].workspace, 'workspace-1');
    assert.match(herdr.starts[0].command, /printf '%s' \$\?/);
    assert.deepEqual(herdr.closes, ['pane-1']);
    assert.deepEqual(states, [
      ['pane-1', 'claude', 'working'],
      ['pane-1', 'claude', 'idle'],
    ]);
    assert.equal(ledger(f).at(-1)?.exit_code, '7');
  });

  it('records herdr stalled and hard-cap metrics with Bash precedence', async () => {
    const stalled = fixture(runId(), { timeoutMinutes: 1 });
    const stalledHerdr = new FakeHerdr();
    stalledHerdr.live = true;
    const stalledOptions = injectedOptions(stalled, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr: stalledHerdr,
      clock: new StepClock(),
      pollIntervalMs: 20_000,
    });
    await dispatch(stalled.runId, 'task-a', stalledOptions);
    assert.equal(ledger(stalled).at(-1)?.reason, 'stalled');
    assert.equal(ledger(stalled).at(-1)?.idle_sec, '60');

    const hard = fixture(runId(), { timeoutMinutes: 1 });
    const hardHerdr = new FakeHerdr();
    hardHerdr.live = true;
    const hardOptions = injectedOptions(hard, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1', HYDRA_HARD_CAP_MIN: '1' },
      herdr: hardHerdr,
      clock: new StepClock(),
      pollIntervalMs: 20_000,
    });
    await dispatch(hard.runId, 'task-a', hardOptions);
    assert.equal(ledger(hard).at(-1)?.reason, 'hard_cap');
    assert.equal(ledger(hard).at(-1)?.elapsed_sec, '60');
  });

  it('falls back to the injected subprocess only when pane launch fails', async () => {
    const f = fixture(runId());
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.paneId = undefined;
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
    }));
    assert.equal(herdr.starts.length, 1);
    assert.equal(mock.calls.length, 1);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'agent_exited']);
  });

  it('keeps a herdr pane when configured', async () => {
    const f = fixture(runId());
    const herdr = new FakeHerdr();
    herdr.live = true;
    const id = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => writeFileSync(join(f.sessionsDir, `${id}.exit`), '0'));
    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1', HYDRA_HERDR_KEEP_PANE: '1' },
      herdr,
      clock,
    }));
    assert.deepEqual(herdr.closes, []);
  });

  it('returns a live completion handle in background mode', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn({ autoExit: false });
    const options = injectedOptions(f, mock.spawn, { background: true, clock: new GateClock() });
    const handle = await dispatch(f.runId, 'task-a', options);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started']);
    mock.calls[0].child.exit(0);
    await handle.finished;
    assert.equal(ledger(f).at(-1)?.event, 'agent_exited');
  });

  it('CLI usage errors exit 1 without invoking an adapter or vendor tool', () => {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      join(import.meta.dirname, '../src/dispatch.ts'),
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: dispatch/);
  });
});
