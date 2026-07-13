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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  dispatch,
  kimiEventText,
  type ChildProcessLike,
  type Clock,
  type DispatchOptions,
  type HerdrClient,
  type SpawnLike,
} from '../src/dispatch.ts';

const TEST_TMP = join(tmpdir(), `hydra-ts-dispatch-${process.pid}`);
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
  bashAdapterDir: string;
  tsAdapterDir: string;
  adapterPath: string;
  tsAdapterPath: string;
  taskSpecPath: string;
}

function fixture(
  id: string,
  overrides: {
    vendor?: string;
    timeoutMinutes?: number;
    specVersion?: number | string;
    adapterContent?: string;
    tsAdapterContent?: string;
    worktree?: string;
  } = {},
): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDir = join(stateRoot, 'runs', `run-${id}`);
  const sessionsDir = join(runDir, 'sessions');
  const worktree = overrides.worktree ?? join(TEST_TMP, id, 'worktree');
  const repoRoot = join(TEST_TMP, id, 'repo');
  const bashAdapterDir = join(repoRoot, 'hydra', 'adapters');
  const tsAdapterDir = join(repoRoot, 'hydra-ts', 'src');
  const taskSpecPath = join(runDir, 'tasks', 'task-a.yaml');
  const vendor = overrides.vendor ?? 'claude';

  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(bashAdapterDir, { recursive: true });
  mkdirSync(tsAdapterDir, { recursive: true });
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
  const adapterPath = join(bashAdapterDir, `${vendor}.sh`);
  const tsAdapterPath = join(tsAdapterDir, `adapter-${vendor}.ts`);
  writeFileSync(adapterPath, overrides.adapterContent ?? '#!/usr/bin/env bash\necho ok\n');
  writeFileSync(tsAdapterPath, overrides.tsAdapterContent ?? 'export function start(): void {}\n');
  return {
    runId: id,
    stateRoot,
    runDir,
    sessionsDir,
    worktree,
    repoRoot,
    bashAdapterDir,
    tsAdapterDir,
    adapterPath,
    tsAdapterPath,
    taskSpecPath,
  };
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
  exited = false;
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
    this.exited = true;
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
  onClose?: (paneId: string) => boolean | Promise<boolean>;

  isLive(): boolean { return this.live; }
  focusedWorkspace(): string | undefined { return this.workspace; }
  agentStart(options: { label: string; cwd: string; workspace?: string; command: string }): string | undefined {
    this.starts.push(options);
    return this.paneId;
  }
  paneClose(paneId: string): boolean | Promise<boolean> {
    this.closes.push(paneId);
    return this.onClose?.(paneId) ?? true;
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
    tsAdapterDir: f.tsAdapterDir,
    bashAdapterDir: f.bashAdapterDir,
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
    await assert.rejects(dispatch(
      f.runId,
      'task-a',
      injectedOptions(f, spawn, { adapterRuntime: 'bash' }),
    ), /no adapter for vendor 'claude'/);
    mkdirSync(f.adapterPath);
    await assert.rejects(dispatch(
      f.runId,
      'task-a',
      injectedOptions(f, spawn, { adapterRuntime: 'bash' }),
    ), /no adapter for vendor 'claude'/);
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
    const options = injectedOptions(f, mock.spawn, { adapterRuntime: 'bash' });
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

  it('defaults to the TypeScript adapter when no runtime is configured', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { env: {} }));

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].command, process.execPath);
    assert.equal(mock.calls[0].args[1], f.tsAdapterPath);
  });

  it('runs TypeScript adapters through node with the original arguments for multiple vendors', async () => {
    for (const vendor of ['claude', 'opencode'] as const) {
      const f = fixture(runId(), { vendor });
      const mock = fakeSpawn();
      const handle = await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
        env: { HYDRA_ADAPTER_RUNTIME: 'ts' },
      }));

      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0].command, process.execPath);
      assert.deepEqual(mock.calls[0].args, [
        '--experimental-strip-types', f.tsAdapterPath,
        'start', f.taskSpecPath, f.worktree,
        join(f.runDir, 'inbox', handle.agentRunId),
        f.sessionsDir, handle.agentRunId, '',
      ]);
    }
  });

  it('uses the Bash adapter when HYDRA_HARNESS explicitly requests bash', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_HARNESS: 'bash' },
    }));

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].command, f.adapterPath);
    assert.equal(mock.calls[0].args[0], 'start');
  });

  it('prefers HYDRA_ADAPTER_RUNTIME over HYDRA_HARNESS for either runtime', async () => {
    const bash = fixture(runId());
    const bashMock = fakeSpawn();
    await dispatch(bash.runId, 'task-a', injectedOptions(bash, bashMock.spawn, {
      env: { HYDRA_HARNESS: 'ts', HYDRA_ADAPTER_RUNTIME: 'bash' },
    }));
    assert.equal(bashMock.calls[0].command, bash.adapterPath);

    const ts = fixture(runId());
    const tsMock = fakeSpawn();
    await dispatch(ts.runId, 'task-a', injectedOptions(ts, tsMock.spawn, {
      env: { HYDRA_HARNESS: 'bash', HYDRA_ADAPTER_RUNTIME: 'ts' },
    }));
    assert.equal(tsMock.calls[0].command, process.execPath);
    assert.equal(tsMock.calls[0].args[1], ts.tsAdapterPath);
  });

  it('prefers the adapterRuntime option over HYDRA_ADAPTER_RUNTIME', async () => {
    const bash = fixture(runId());
    const bashMock = fakeSpawn();
    await dispatch(bash.runId, 'task-a', injectedOptions(bash, bashMock.spawn, {
      adapterRuntime: 'bash',
      env: { HYDRA_ADAPTER_RUNTIME: 'ts' },
    }));
    assert.equal(bashMock.calls[0].command, bash.adapterPath);

    const ts = fixture(runId());
    const tsMock = fakeSpawn();
    await dispatch(ts.runId, 'task-a', injectedOptions(ts, tsMock.spawn, {
      adapterRuntime: 'ts',
      env: { HYDRA_ADAPTER_RUNTIME: 'bash' },
    }));
    assert.equal(tsMock.calls[0].command, process.execPath);
    assert.equal(tsMock.calls[0].args[1], ts.tsAdapterPath);
  });

  it('uses the injected current node executable for plain and herdr-hosted TypeScript adapters', async () => {
    const nodeExecutable = '/mock/current-node/bin/node';

    const plain = fixture(runId());
    const plainMock = fakeSpawn();
    await dispatch(plain.runId, 'task-a', injectedOptions(plain, plainMock.spawn, {
      adapterRuntime: 'ts',
      nodeExecutable,
    }));
    assert.equal(plainMock.calls[0].command, nodeExecutable);
    assert.notEqual(plainMock.calls[0].command, 'node');

    const hosted = fixture(runId());
    const herdr = new FakeHerdr();
    herdr.live = true;
    const expectedId = `${hosted.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(hosted.sessionsDir, `${expectedId}.exit`), '0');
    });
    await dispatch(hosted.runId, 'task-a', injectedOptions(hosted, () => {
      throw new Error('plain spawn must not run');
    }, {
      adapterRuntime: 'ts',
      nodeExecutable,
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
    }));

    assert.equal(herdr.starts.length, 1);
    assert.ok(herdr.starts[0].command.includes(
      `'${nodeExecutable}' '--experimental-strip-types' '${hosted.tsAdapterPath}'`,
    ));
    assert.equal(herdr.starts[0].command.includes("'node' '--experimental-strip-types'"), false);
  });

  it('records non-zero and signal-derived worker exit codes', async () => {
    const nonzero = fixture(runId());
    await dispatch(nonzero.runId, 'task-a', injectedOptions(nonzero, fakeSpawn({ autoExit: 42 }).spawn));
    assert.equal(ledger(nonzero).at(-1)?.exit_code, '42');
    assert.equal(readFileSync(join(nonzero.sessionsDir, `${nonzero.runId}-task-a-v1.exit`), 'utf8'), '42');

    const signalled = fixture(runId());
    await dispatch(signalled.runId, 'task-a', injectedOptions(
      signalled,
      fakeSpawn({ signal: 'SIGTERM' }).spawn,
    ));
    assert.equal(ledger(signalled).at(-1)?.exit_code, '143');
    assert.equal(readFileSync(join(signalled.sessionsDir, `${signalled.runId}-task-a-v1.exit`), 'utf8'), '143');
  });

  it('writes resolved exit and timeout sentinels for plain opencode workers', async () => {
    const exited = fixture(runId(), { vendor: 'opencode' });
    await dispatch(exited.runId, 'task-a', injectedOptions(
      exited,
      fakeSpawn({ autoExit: 23 }).spawn,
    ));
    assert.equal(readFileSync(join(exited.sessionsDir, `${exited.runId}-task-a-v1.exit`), 'utf8'), '23');

    const timedOut = fixture(runId(), { vendor: 'opencode', timeoutMinutes: 1 });
    await dispatch(timedOut.runId, 'task-a', injectedOptions(
      timedOut,
      fakeSpawn({ autoExit: false }).spawn,
      { clock: new StepClock(), pollIntervalMs: 20_000 },
    ));
    assert.equal(ledger(timedOut).at(-1)?.reason, 'stalled');
    assert.equal(readFileSync(join(timedOut.sessionsDir, `${timedOut.runId}-task-a-v1.exit`), 'utf8'), '124');
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
    assert.equal(readFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.exit`), 'utf8'), '130');
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
    const options = injectedOptions(f, mock.spawn, {
      adapterRuntime: 'bash',
      env: { HYDRA_DELIVERY: 'resume' },
    });
    await dispatch(f.runId, 'task-a', options);

    assert.equal(mock.calls[0].args[0], 'resume');
    assert.equal(mock.calls[0].args.at(-1), 'session-old');
    assert.equal(ledger(f)[0].delivery, 'resume');
  });

  it('cold-restarts while preserving a discovered prior session when a Bash adapter lacks resume', async () => {
    const f = fixture(runId(), { vendor: 'codex' });
    writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.json`), JSON.stringify({ session_id: 'session-1' }));
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      adapterRuntime: 'bash',
      env: { HYDRA_DELIVERY: 'resume' },
    }));
    assert.equal(mock.calls[0].args[0], 'start');
    assert.equal(mock.calls[0].args.at(-1), 'session-1');
  });

  it('detects resume support from TypeScript exports', async () => {
    const supported = fixture(runId(), {
      vendor: 'claude',
      tsAdapterContent: readFileSync(join(import.meta.dirname, '../src/adapter-claude.ts'), 'utf8'),
    });
    writeFileSync(
      join(supported.sessionsDir, `${supported.runId}-task-a-v1.json`),
      JSON.stringify({ session_id: 'session-ts' }),
    );
    const supportedMock = fakeSpawn();
    await dispatch(supported.runId, 'task-a', injectedOptions(supported, supportedMock.spawn, {
      env: { HYDRA_ADAPTER_RUNTIME: 'ts', HYDRA_DELIVERY: 'resume' },
    }));
    assert.equal(supportedMock.calls[0].args[2], 'resume');
    assert.equal(supportedMock.calls[0].args.at(-1), 'session-ts');

    const unsupported = fixture(runId(), {
      vendor: 'codex',
      tsAdapterContent: readFileSync(join(import.meta.dirname, '../src/adapter-codex.ts'), 'utf8'),
    });
    writeFileSync(
      join(unsupported.sessionsDir, `${unsupported.runId}-task-a-v1.json`),
      JSON.stringify({ session_id: 'session-ts' }),
    );
    const unsupportedMock = fakeSpawn();
    await dispatch(unsupported.runId, 'task-a', injectedOptions(unsupported, unsupportedMock.spawn, {
      env: { HYDRA_ADAPTER_RUNTIME: 'ts', HYDRA_DELIVERY: 'resume' },
    }));
    assert.equal(unsupportedMock.calls[0].args[2], 'start');
    assert.equal(unsupportedMock.calls[0].args.at(-1), 'session-ts');
  });

  it('keeps non-opencode vendors hosted in an injected herdr pane', async () => {
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

  it('records a hosted worker exit before a throwing pane close', async () => {
    const f = fixture(runId(), { vendor: 'codex' });
    const herdr = new FakeHerdr();
    herdr.live = true;
    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });
    let exitWasRecordedAtClose = false;
    herdr.onClose = () => {
      exitWasRecordedAtClose = ledger(f).at(-1)?.event === 'agent_exited';
      throw new Error('pane already gone');
    };

    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('plain spawn must not run'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
    }));

    assert.equal(exitWasRecordedAtClose, true);
    assert.deepEqual(herdr.closes, ['pane-1']);
    assert.equal(ledger(f).at(-1)?.exit_code, '0');
  });

  it('always runs opencode plainly and uses a decoupled event monitor pane', async () => {
    const f = fixture(runId(), { vendor: 'opencode' });
    const expectedId = `${f.runId}-task-a-v1`;
    const eventsPath = join(f.sessionsDir, `${expectedId}.events.jsonl`);
    const mock = fakeSpawn({
      onSpawn: () => writeFileSync(eventsPath, [
        JSON.stringify({ part: { type: 'text', text: 'Working through it' } }),
        JSON.stringify({ part: { type: 'tool', tool: 'read', state: { title: 'Inspect dispatch' } } }),
        JSON.stringify({ part: { type: 'tool', tool: 'bash', state: {} } }),
      ].join('\n')),
    });
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = 'workspace-monitor';
    const liveness: boolean[] = [];
    let exitWasRecordedAtClose = false;
    herdr.onClose = async () => {
      exitWasRecordedAtClose = ledger(f).at(-1)?.event === 'agent_exited';
      throw new Error('monitor pane already closed itself');
    };

    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      adapterRuntime: 'bash',
      env: { HYDRA_HERDR_PANES: '1', HYDRA_OPENCODE_MODEL: 'test/glm' },
      herdr,
      buildWorkerPrompt: () => 'the rendered worker prompt',
      processAlive: () => {
        const alive = !(mock.calls[0]?.child.exited ?? false);
        liveness.push(alive);
        return alive;
      },
    }));

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].command, f.adapterPath);
    assert.equal(herdr.starts.length, 1);
    assert.equal(herdr.starts[0].workspace, 'workspace-monitor');
    assert.match(herdr.starts[0].command, /tail -n \+1 -f/);
    assert.doesNotMatch(herdr.starts[0].command, /opencode\.sh/);
    assert.equal(exitWasRecordedAtClose, true);
    assert.deepEqual(herdr.closes, ['pane-1']);
    assert.equal(liveness.includes(true), true);
    assert.equal(liveness.at(-1), false);

    const monitor = readFileSync(join(f.sessionsDir, `${expectedId}.monitor.txt`), 'utf8');
    assert.match(monitor, new RegExp(`OpenCode \\(test/glm\\) starting — run ${f.runId} task task-a`));
    assert.match(monitor, new RegExp(`worktree: ${f.worktree}`));
    assert.match(monitor, /the rendered worker prompt/);
    assert.match(monitor, /Working through it/);
    assert.match(monitor, /\[tool\] read: Inspect dispatch/);
    assert.match(monitor, /\[tool\] bash/);
    assert.deepEqual(ledger(f).map(({ event }) => event), [
      'task_started',
      'herdr_pane_started',
      'agent_exited',
    ]);
    assert.equal(ledger(f)[1].mode, 'monitor_only');
    assert.equal(readFileSync(join(f.sessionsDir, `${expectedId}.exit`), 'utf8'), '0');
  });

  it('records an opencode exit when monitor banner setup fails', async () => {
    const f = fixture(runId(), { vendor: 'opencode' });
    const expectedId = `${f.runId}-task-a-v1`;
    mkdirSync(join(f.sessionsDir, `${expectedId}.monitor.txt`));
    const herdr = new FakeHerdr();
    herdr.live = true;
    const mock = fakeSpawn();

    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
    }));

    assert.equal(mock.calls.length, 1);
    assert.deepEqual(herdr.starts, []);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'agent_exited']);
    assert.equal(ledger(f).at(-1)?.exit_code, '0');
  });

  it('runs opencode plainly without a monitor when panes are disabled', async () => {
    const f = fixture(runId(), { vendor: 'opencode' });
    const herdr = new FakeHerdr();
    herdr.live = true;
    const mock = fakeSpawn();

    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { herdr }));

    assert.equal(mock.calls.length, 1);
    assert.deepEqual(herdr.starts, []);
    assert.deepEqual(herdr.closes, []);
    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'agent_exited']);
    assert.equal(readFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.exit`), 'utf8'), '0');
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
    assert.equal(readFileSync(join(stalled.sessionsDir, `${stalled.runId}-task-a-v1.exit`), 'utf8'), '124');

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
    assert.equal(readFileSync(join(hard.sessionsDir, `${hard.runId}-task-a-v1.exit`), 'utf8'), '124');
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

  it('writes the starting banner and dispatches via herdr pane for claude, codex, and kimi', async () => {
    for (const vendor of ['claude', 'codex', 'kimi'] as const) {
      const f = fixture(runId(), { vendor });
      const herdr = new FakeHerdr();
      herdr.live = true;
      herdr.workspace = `ws-${vendor}`;
      const expectedId = `${f.runId}-task-a-v1`;
      const clock = new StepClock(() => {
        writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
      });
      let spawnCalled = false;
      await dispatch(f.runId, 'task-a', injectedOptions(f, () => { spawnCalled = true; throw new Error('no spawn'); }, {
        adapterRuntime: 'bash',
        env: { HYDRA_HERDR_PANES: '1' },
        herdr,
        clock,
        buildWorkerPrompt: () => `the ${vendor} worker prompt`,
      }));

      assert.equal(spawnCalled, false, `${vendor} should use herdr pane, not plain spawn`);
      assert.equal(herdr.starts.length, 1, `${vendor} should start one pane`);

      const banner = readFileSync(join(f.sessionsDir, `${expectedId}.pane-banner.txt`), 'utf8');
      const vlabel = vendor === 'claude' ? 'Claude' : vendor === 'codex' ? 'Codex' : 'Kimi';
      assert.match(banner, new RegExp(`^${vlabel} starting — run ${f.runId} task task-a`), `${vendor} banner has vendor label and run/task ids`);
      assert.match(banner, new RegExp(`worktree: ${f.worktree}`), `${vendor} banner has worktree`);
      assert.match(banner, new RegExp(`the ${vendor} worker prompt`), `${vendor} banner has rendered prompt`);

      const command = herdr.starts[0].command;
      const bannerPath = join(f.sessionsDir, `${expectedId}.pane-banner.txt`);
      assert.ok(command.indexOf(`cat '${bannerPath}'`) < command.indexOf(`'${f.adapterPath}'`), `${vendor} banner is printed before the adapter`);
      assert.match(command, /echo \$\$ > '.*\.pid'/, `${vendor} inner writes pidfile`);
      assert.match(command, /printf '%s'.*> '.*\.exit'/, `${vendor} inner writes sentinel`);
      assert.equal(ledger(f).at(-1)?.event, 'agent_exited');
    }
  });

  it('live-tails codex progress events from cli.jsonl into the pane', async () => {
    const f = fixture(runId(), { vendor: 'codex' });
    const herdr = new FakeHerdr();
    herdr.live = true;
    const expectedId = `${f.runId}-task-a-v1`;
    const cliJsonlPath = join(f.sessionsDir, `${expectedId}.cli.jsonl`);
    const progressPath = join(f.sessionsDir, `${expectedId}.pane-progress.txt`);
    const sentinelPath = join(f.sessionsDir, `${expectedId}.exit`);
    const command = `npm run test\n${'x'.repeat(160)}`;
    const displayedCommand = command.replaceAll('\n', ' ').slice(0, 140);

    const clock = new StepClock((_ms, count) => {
      if (count === 1) {
        writeFileSync(cliJsonlPath, [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Analyzing the codebase' } }),
          JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command } }),
          JSON.stringify({ type: 'item.started', item: { type: 'file_change', changes: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }] } }),
          JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'fs', tool: 'read' } }),
          JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: 'ignored event' } }),
          '{malformed',
          '',
        ].join('\n'));
      } else {
        writeFileSync(sentinelPath, '0');
      }
    });

    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
      buildWorkerPrompt: () => 'the codex prompt',
    }));

    assert.match(herdr.starts[0].command, /tail -n \+1 -f/);
    assert.match(herdr.starts[0].command, /TPID=/);
    assert.match(herdr.starts[0].command, /kill \$TPID/);

    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /Analyzing the codebase/);
    assert.ok(progress.includes(`[cmd] ${displayedCommand}`));
    assert.equal(progress.includes(`[cmd] ${command.replaceAll('\n', ' ')}`), false, 'command display is capped at 140 characters');
    assert.match(progress, /\[edit\] foo\.ts, bar\.ts/);
    assert.match(progress, /\[tool\] fs\.read/);
    assert.doesNotMatch(progress, /ignored event|malformed/);
  });

  it('live-tails kimi progress events from cli.jsonl into the pane', async () => {
    const f = fixture(runId(), { vendor: 'kimi' });
    const herdr = new FakeHerdr();
    herdr.live = true;
    const expectedId = `${f.runId}-task-a-v1`;
    const cliJsonlPath = join(f.sessionsDir, `${expectedId}.cli.jsonl`);
    const progressPath = join(f.sessionsDir, `${expectedId}.pane-progress.txt`);
    const sentinelPath = join(f.sessionsDir, `${expectedId}.exit`);

    const clock = new StepClock((_ms, count) => {
      if (count === 1) {
        writeFileSync(cliJsonlPath, [
          JSON.stringify({ role: 'assistant', content: 'Inspecting the codebase' }),
          JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'sid-1', command: 'resume', content: 'hint' }),
          JSON.stringify({ role: 'assistant', content: 'Planning the fix' }),
          JSON.stringify({ role: 'assistant', content: '', tool_calls: [{ type: 'function', id: 'tool-1', function: { name: 'Read' } }] }),
          JSON.stringify({ role: 'tool', tool_call_id: 'tool-1', content: 'tool result' }),
          '{malformed',
          '',
        ].join('\n'));
      } else {
        writeFileSync(sentinelPath, '0');
      }
    });

    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
      buildWorkerPrompt: () => 'the kimi prompt',
    }));

    assert.match(herdr.starts[0].command, /tail -n \+1 -f/);
    assert.match(herdr.starts[0].command, /TPID=/);
    assert.match(herdr.starts[0].command, /kill \$TPID/);

    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /Inspecting the codebase/);
    assert.match(progress, /Planning the fix/);
    assert.doesNotMatch(progress, /hint|tool result|malformed/);
  });

  it('advances kimi live progress past a bare null JSON line', async () => {
    const f = fixture(runId(), { vendor: 'kimi' });
    const herdr = new FakeHerdr();
    herdr.live = true;
    const expectedId = `${f.runId}-task-a-v1`;
    const cliJsonlPath = join(f.sessionsDir, `${expectedId}.cli.jsonl`);
    const progressPath = join(f.sessionsDir, `${expectedId}.pane-progress.txt`);
    const sentinelPath = join(f.sessionsDir, `${expectedId}.exit`);

    const clock = new StepClock((_ms, count) => {
      if (count === 1) {
        writeFileSync(cliJsonlPath, [
          'null',
          JSON.stringify({ role: 'assistant', content: 'Recovered after bare null' }),
          '',
        ].join('\n'));
      } else {
        writeFileSync(sentinelPath, '0');
      }
    });

    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
      buildWorkerPrompt: () => 'the kimi prompt',
    }));

    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /Recovered after bare null/);
  });

  it('kimiEventText extracts assistant content and ignores other events', () => {
    assert.equal(kimiEventText(JSON.stringify({ role: 'assistant', content: 'hello world' })), 'hello world');
    assert.equal(kimiEventText(JSON.stringify({ role: 'assistant', content: '' })), undefined);
    assert.equal(kimiEventText(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 's', command: 'c', content: 'hint' })), undefined);
    assert.equal(kimiEventText(JSON.stringify({ role: 'tool', tool_call_id: 'tool-1', content: 'tool result' })), undefined);
    assert.equal(kimiEventText('{malformed'), undefined);
    assert.equal(kimiEventText(''), undefined);
    assert.equal(kimiEventText('null'), undefined);
    assert.equal(kimiEventText(JSON.stringify([1, 2, 3])), undefined);
    assert.equal(kimiEventText('"bare string"'), undefined);
    assert.equal(kimiEventText('42'), undefined);
    assert.equal(kimiEventText('true'), undefined);
  });

  it('does not create a live progress tail for claude panes', async () => {
    const f = fixture(runId(), { vendor: 'claude' });
    const herdr = new FakeHerdr();
    herdr.live = true;
    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });
    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
      buildWorkerPrompt: () => 'prompt',
    }));

    const progressPath = join(f.sessionsDir, `${expectedId}.pane-progress.txt`);
    assert.equal(existsSync(progressPath), false, 'claude should not have a progress file');
    assert.doesNotMatch(herdr.starts[0].command, /tail -n \+1 -f/);
    assert.doesNotMatch(herdr.starts[0].command, /TPID/);
  });

  it('records a hosted worker exit even when the banner prompt build fails', async () => {
    const f = fixture(runId());
    const herdr = new FakeHerdr();
    herdr.live = true;
    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });

    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
      buildWorkerPrompt: () => { throw new Error('prompt build unavailable'); },
    }));

    assert.deepEqual(ledger(f).map(({ event }) => event), ['task_started', 'herdr_pane_started', 'agent_exited']);
    assert.equal(ledger(f).at(-1)?.exit_code, '0');
    const banner = readFileSync(join(f.sessionsDir, `${expectedId}.pane-banner.txt`), 'utf8');
    assert.match(banner, /\(prompt unavailable\)/);
  });

  it('records hosted codex exits and timeouts when banner and tail files cannot be written', async () => {
    const exited = fixture(runId(), { vendor: 'codex' });
    const exitedHerdr = new FakeHerdr();
    exitedHerdr.live = true;
    const exitedId = `${exited.runId}-task-a-v1`;
    mkdirSync(join(exited.sessionsDir, `${exitedId}.pane-banner.txt`));
    mkdirSync(join(exited.sessionsDir, `${exitedId}.pane-progress.txt`));
    const exitClock = new StepClock((_ms, count) => {
      if (count === 1) {
        writeFileSync(join(exited.sessionsDir, `${exitedId}.cli.jsonl`), `${JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'cannot append this progress' },
        })}\n`);
      } else {
        writeFileSync(join(exited.sessionsDir, `${exitedId}.exit`), '7');
      }
    });

    await dispatch(exited.runId, 'task-a', injectedOptions(exited, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr: exitedHerdr,
      clock: exitClock,
    }));

    assert.equal(ledger(exited).at(-1)?.event, 'agent_exited');
    assert.equal(ledger(exited).at(-1)?.exit_code, '7');

    const timedOut = fixture(runId(), { vendor: 'codex', timeoutMinutes: 1 });
    const timedOutHerdr = new FakeHerdr();
    timedOutHerdr.live = true;
    const timedOutId = `${timedOut.runId}-task-a-v1`;
    mkdirSync(join(timedOut.sessionsDir, `${timedOutId}.pane-banner.txt`));
    mkdirSync(join(timedOut.sessionsDir, `${timedOutId}.pane-progress.txt`));

    await dispatch(timedOut.runId, 'task-a', injectedOptions(timedOut, () => { throw new Error('no spawn'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr: timedOutHerdr,
      clock: new StepClock(),
      pollIntervalMs: 20_000,
    }));

    assert.equal(ledger(timedOut).at(-1)?.event, 'agent_timed_out');
    assert.equal(ledger(timedOut).at(-1)?.reason, 'stalled');
  });
});
