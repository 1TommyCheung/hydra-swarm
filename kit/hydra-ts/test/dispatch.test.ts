import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  dispatch,
  herdrAgentPaneRatio,
  kimiEventText,
  resolveAdapterRuntime,
  type ChildProcessLike,
  type Clock,
  type DispatchOptions,
  type ExecFileSyncLike,
  type HerdrClient,
  type SpawnLike,
} from '../src/dispatch.ts';
import type { HeadsSnapshot } from '../src/detect-heads.ts';

function headsSnapshot(
  availability: Partial<Record<string, boolean>> = {},
  models: string[] = [],
): HeadsSnapshot {
  const head = (name: string) => {
    const available = availability[name] ?? true;
    return { available, path: available ? `/usr/bin/${name}` : null };
  };
  return {
    detected_at: '2026-01-01T00:00:00Z',
    heads: {
      claude: head('claude'),
      codex: head('codex'),
      opencode: { ...head('opencode'), models, active_model: 'zai-coding-plan/glm-5.2' },
      kimi: { ...head('kimi'), srt_available: true, write_capable: true },
    },
  };
}

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
  tsAdapterDir: string;
  tsAdapterPath: string;
  taskSpecPath: string;
}

function fixture(
  id: string,
  overrides: {
    vendor?: string;
    timeoutMinutes?: number;
    specVersion?: number | string;
    tsAdapterContent?: string;
    worktree?: string;
  } = {},
): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDir = join(stateRoot, 'runs', `run-${id}`);
  const sessionsDir = join(runDir, 'sessions');
  const worktree = overrides.worktree ?? join(TEST_TMP, id, 'worktree');
  const repoRoot = join(TEST_TMP, id, 'repo');
  const tsAdapterDir = join(repoRoot, 'hydra-ts', 'src');
  const taskSpecPath = join(runDir, 'tasks', 'task-a.yaml');
  const vendor = overrides.vendor ?? 'claude';

  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
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
  const tsAdapterPath = join(tsAdapterDir, `adapter-${vendor}.ts`);
  writeFileSync(tsAdapterPath, overrides.tsAdapterContent ?? 'export function start(): void {}\n');
  return {
    runId: id,
    stateRoot,
    runDir,
    sessionsDir,
    worktree,
    repoRoot,
    tsAdapterDir,
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
    const autoExitCode = options.autoExit === false ? 0 : (options.autoExit ?? 0);
    if (options.autoExit !== false) {
      queueMicrotask(() => child.exit(options.signal ? null : autoExitCode, options.signal ?? null));
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
  resizes: Array<{ paneId: string; direction: string; amount: number }> = [];
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
  paneResize(paneId: string, direction: 'left' | 'right' | 'up' | 'down', amount: number): boolean | Promise<boolean> {
    this.resizes.push({ paneId, direction, amount });
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
    tsAdapterDir: f.tsAdapterDir,
    env: {},
    noSignals: true,
    spawn,
    herdr: new FakeHerdr(),
    herdrState: (...args) => { states.push(args); },
    killTree: (pid) => { killed.push(pid); },
    recordUsage: (...args) => { usage.push(args); },
    execFileSync: () => { throw new Error('external command execution was not expected'); },
    probeHeads: () => headsSnapshot(),
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

async function captureStderr<T>(callback: () => Promise<T>): Promise<{ output: string; value: T }> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await callback();
    return { output: chunks.join(''), value };
  } finally {
    process.stderr.write = original;
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, { timeout = 5000, interval = 50 } = {}): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error('Timeout waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
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
    rmSync(f.tsAdapterPath);
    const { spawn } = fakeSpawn();
    await assert.rejects(dispatch(
      f.runId,
      'task-a',
      injectedOptions(f, spawn),
    ), /no adapter for vendor 'claude'/);
    mkdirSync(f.tsAdapterPath);
    await assert.rejects(dispatch(
      f.runId,
      'task-a',
      injectedOptions(f, spawn),
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
    const options = injectedOptions(f, mock.spawn, { adapterRuntime: 'ts' });
    const { output, value } = await captureStdout(() => dispatch(f.runId, 'task-a', options));

    assert.equal(value.agentRunId, `${f.runId}-task-a-v03`);
    assert.equal(output.trim(), value.agentRunId);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].command, process.execPath);
    assert.deepEqual(mock.calls[0].args, [
      '--experimental-strip-types', f.tsAdapterPath,
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

  it('rejects HYDRA_HARNESS=bash as a retired runtime (no silent coercion to ts)', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn();
    await assert.rejects(dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_HARNESS: 'bash' },
    })), /HYDRA_HARNESS=bash.*was retired/);
    assert.equal(mock.calls.length, 0, 'a retired runtime must never spawn an adapter');
  });

  it('rejects HYDRA_ADAPTER_RUNTIME=bash as a retired runtime (no silent coercion to ts)', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn();
    await assert.rejects(dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_ADAPTER_RUNTIME: 'bash' },
    })), /HYDRA_ADAPTER_RUNTIME=bash.*was retired/);
    assert.equal(mock.calls.length, 0, 'a retired runtime must never spawn an adapter');
  });

  it('rejects an unrecognized HYDRA_ADAPTER_RUNTIME value instead of coercing to ts', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn();
    await assert.rejects(dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_ADAPTER_RUNTIME: 'nonsense' },
    })), /unrecognized HYDRA_ADAPTER_RUNTIME='nonsense'/);
    assert.equal(mock.calls.length, 0);
  });

  it('prefers HYDRA_ADAPTER_RUNTIME=ts even when HYDRA_HARNESS requests bin', async () => {
    const ts = fixture(runId());
    const tsMock = fakeSpawn();
    await dispatch(ts.runId, 'task-a', injectedOptions(ts, tsMock.spawn, {
      env: { HYDRA_HARNESS: 'bin', HYDRA_ADAPTER_RUNTIME: 'ts' },
    }));
    assert.equal(tsMock.calls[0].command, process.execPath);
    assert.equal(tsMock.calls[0].args[1], ts.tsAdapterPath);

    const def = fixture(runId());
    const defMock = fakeSpawn();
    await dispatch(def.runId, 'task-a', injectedOptions(def, defMock.spawn, {
      env: { HYDRA_HARNESS: 'bin' },
    }));
    assert.equal(defMock.calls[0].command, process.execPath);
    assert.equal(defMock.calls[0].args[1], def.tsAdapterPath);
  });

  it('prefers the adapterRuntime option over HYDRA_ADAPTER_RUNTIME', async () => {
    const compiled = fixture(runId());
    const compiledMock = fakeSpawn();
    await dispatch(compiled.runId, 'task-a', injectedOptions(compiled, compiledMock.spawn, {
      adapterRuntime: 'compiled',
      env: { HYDRA_ADAPTER_RUNTIME: 'ts' },
    }));
    assert.equal(compiledMock.calls[0].command, process.execPath);
    assert.equal(compiledMock.calls[0].args[0], 'adapter-claude');

    const ts = fixture(runId());
    const tsMock = fakeSpawn();
    await dispatch(ts.runId, 'task-a', injectedOptions(ts, tsMock.spawn, {
      adapterRuntime: 'ts',
      env: { HYDRA_ADAPTER_RUNTIME: 'compiled' },
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

  it('exports HYDRA_NODE_BIN into the worker env, without clobbering an operator preset', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn();
    const options = injectedOptions(f, mock.spawn, {
      resolveNodeBinDir: () => '/resolved/node22/bin',
    });
    await dispatch(f.runId, 'task-a', options);
    assert.equal(mock.calls[0].options?.env?.HYDRA_NODE_BIN, '/resolved/node22/bin');

    const f2 = fixture(runId());
    const mock2 = fakeSpawn();
    const options2 = injectedOptions(f2, mock2.spawn, {
      env: { HYDRA_NODE_BIN: '/operator/pinned/bin' },
      resolveNodeBinDir: () => '/resolved/node22/bin',
    });
    await dispatch(f2.runId, 'task-a', options2);
    assert.equal(mock2.calls[0].options?.env?.HYDRA_NODE_BIN, '/operator/pinned/bin');

    // Resolution failure leaves the env untouched — a target project may not
    // need node at all.
    const f3 = fixture(runId());
    const mock3 = fakeSpawn();
    const options3 = injectedOptions(f3, mock3.spawn, {
      resolveNodeBinDir: () => '',
    });
    await dispatch(f3.runId, 'task-a', options3);
    assert.equal('HYDRA_NODE_BIN' in (mock3.calls[0].options?.env ?? {}), false);
  });

  it('resolves the adapter runtime with compiled-binary precedence (resolveAdapterRuntime)', () => {
    // Inside a compiled binary the runtime is 'compiled' regardless of
    // HYDRA_HARNESS / HYDRA_ADAPTER_RUNTIME — 'ts' can never work there (no
    // Node, no adapter .ts file). 'bash' is now RETIRED and fails even inside
    // a compiled binary (it must not silently win or coerce to ts).
    assert.equal(resolveAdapterRuntime(undefined, 'bin', true), 'compiled');
    assert.equal(resolveAdapterRuntime(undefined, 'ts', true), 'compiled');
    assert.equal(resolveAdapterRuntime('ts', 'bin', true), 'compiled');
    assert.throws(() => resolveAdapterRuntime('bash', 'bin', true), /was retired/);
    assert.throws(() => resolveAdapterRuntime(undefined, 'bash', true), /was retired/);
    assert.throws(() => resolveAdapterRuntime('bash', undefined, true), /was retired/);
    // An explicit 'compiled' override selects the self-reexec runtime even
    // under plain Node (this is how the tests below exercise the branch
    // without a bun-built binary).
    assert.equal(resolveAdapterRuntime('compiled', undefined, false), 'compiled');
    assert.equal(resolveAdapterRuntime('compiled', 'ts', false), 'compiled');
    // The source-lane default is 'ts'; HYDRA_HARNESS=bin is resolved by the
    // wrapper launcher before dispatch, so a non-compiled process takes 'ts'.
    assert.equal(resolveAdapterRuntime(undefined, undefined, false), 'ts');
    assert.equal(resolveAdapterRuntime(undefined, 'bin', false), 'ts');
    assert.equal(resolveAdapterRuntime(undefined, 'ts', false), 'ts');
    assert.equal(resolveAdapterRuntime('ts', 'ts', false), 'ts');
    assert.equal(resolveAdapterRuntime('', 'ts', false), 'ts');
    // 'bash' is retired under plain Node too (no coercion to 'ts') ...
    assert.throws(() => resolveAdapterRuntime(undefined, 'bash', false), /was retired/);
    assert.throws(() => resolveAdapterRuntime('bash', 'ts', false), /was retired/);
    assert.throws(() => resolveAdapterRuntime('', 'bash', false), /was retired/);
    // ... and any other unrecognized override value is rejected.
    assert.throws(() => resolveAdapterRuntime('nonsense', undefined, false), /unrecognized/);
  });

  it('compiled runtime self-reexecs process.execPath through the adapter-<vendor> route', async () => {
    const f = fixture(runId());
    const mock = fakeSpawn();
    const options = injectedOptions(f, mock.spawn, {
      adapterRuntime: 'compiled',
      env: { BUN_BE_BUN: '1' },
    });
    const handle = await dispatch(f.runId, 'task-a', options);

    assert.equal(mock.calls.length, 1);
    // The command is the current executable itself — inside a compiled binary
    // that IS the hydra-cli binary — never a Node interpreter, never a .ts
    // adapter path, and never --experimental-strip-types (cli.ts's router
    // would reject that as an unknown subcommand).
    assert.equal(mock.calls[0].command, process.execPath);
    assert.deepEqual(mock.calls[0].args, [
      'adapter-claude',
      'start', f.taskSpecPath, f.worktree,
      join(f.runDir, 'inbox', handle.agentRunId),
      f.sessionsDir, handle.agentRunId, '',
    ]);
    // The self-reexec spawn gets the same env object every runtime gets, with
    // BUN_BE_BUN stripped in place — a leaked BUN_BE_BUN=1 would hijack the
    // re-exec'd binary into Bun's own CLI instead of Hydra.
    assert.equal(mock.calls[0].options?.env, options.env);
    assert.equal('BUN_BE_BUN' in (mock.calls[0].options?.env ?? {}), false);
  });

  it('compiled runtime routes each vendor via HYDRA_ADAPTER_RUNTIME=compiled', async () => {
    for (const vendor of ['codex', 'stub'] as const) {
      const f = fixture(runId(), { vendor });
      const mock = fakeSpawn();
      const handle = await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
        env: { HYDRA_ADAPTER_RUNTIME: 'compiled' },
      }));

      assert.equal(mock.calls.length, 1);
      assert.equal(mock.calls[0].command, process.execPath);
      assert.equal(mock.calls[0].args[0], `adapter-${vendor}`);
      assert.equal(mock.calls[0].args[1], 'start');
      assert.equal(mock.calls[0].args[2], f.taskSpecPath);
      assert.equal(mock.calls[0].args.at(-1), '');
    }
  });

  it('compiled runtime rejects an unknown vendor against the fixed route set, with no file probe', async () => {
    // The fixture DOES write bash/ts adapter files for 'nosuch' — proving the
    // compiled gate never stats adapter files; validity is cli.ts's fixed
    // compile-time adapter-<vendor> route set.
    const f = fixture(runId(), { vendor: 'nosuch' });
    const mock = fakeSpawn();
    await assert.rejects(
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { adapterRuntime: 'compiled' })),
      /no adapter for vendor 'nosuch': the compiled binary only routes adapter-claude, adapter-codex, adapter-kimi, adapter-opencode, adapter-stub/,
    );
    assert.equal(mock.calls.length, 0);
  });

  it('compiled runtime takes resume capability from the static registry, not a source file', async () => {
    // adapter-claude implements start|resume, so a prior session plus
    // HYDRA_DELIVERY=resume reaches the child as the resume verb even though
    // there is no adapter .ts file for the compiled runtime to grep.
    const capable = fixture(runId(), { vendor: 'claude' });
    writeFileSync(
      join(capable.sessionsDir, `${capable.runId}-task-a-v1.json`),
      JSON.stringify({ session_id: 'session-compiled' }),
    );
    const capableMock = fakeSpawn();
    await dispatch(capable.runId, 'task-a', injectedOptions(capable, capableMock.spawn, {
      adapterRuntime: 'compiled',
      env: { HYDRA_DELIVERY: 'resume' },
    }));
    assert.equal(capableMock.calls[0].args[0], 'adapter-claude');
    assert.equal(capableMock.calls[0].args[1], 'resume');
    assert.equal(capableMock.calls[0].args.at(-1), 'session-compiled');

    // adapter-codex has no resume verb: cold restart with start (prior
    // session still forwarded, exactly like the ts/bash runtimes).
    const incapable = fixture(runId(), { vendor: 'codex' });
    writeFileSync(
      join(incapable.sessionsDir, `${incapable.runId}-task-a-v1.json`),
      JSON.stringify({ session_id: 'session-compiled' }),
    );
    const incapableMock = fakeSpawn();
    await dispatch(incapable.runId, 'task-a', injectedOptions(incapable, incapableMock.spawn, {
      adapterRuntime: 'compiled',
      env: { HYDRA_DELIVERY: 'resume' },
    }));
    assert.equal(incapableMock.calls[0].args[0], 'adapter-codex');
    assert.equal(incapableMock.calls[0].args[1], 'start');
    assert.equal(incapableMock.calls[0].args.at(-1), 'session-compiled');
  });

  it('compiled runtime builds the self-reexec pane command when herdr-hosted', async () => {
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
      adapterRuntime: 'compiled',
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
    }));

    assert.equal(herdr.starts.length, 1);
    // `<self> adapter-claude start ...` shell-quoted in the adapter's slot —
    // and crucially NOT `<self> --experimental-strip-types ...`.
    assert.ok(herdr.starts[0].command.includes(
      `'${process.execPath}' 'adapter-claude' 'start'`,
    ));
    assert.equal(herdr.starts[0].command.includes('--experimental-strip-types'), false);
  });

  // -------------------------------------------------------------------------
  // Compiled-binary end-to-end dispatch (Stage 3 black-box shape, deferred).
  //
  // Stage 4 review bug #1 follow-up: a REAL checkout-free dispatch through
  // the compiled binary (`hydra-cli dispatch <run> <task>` for vendor stub,
  // asserting the self-reexec argv reaches adapter-stub and agent_exited is
  // recorded) needs `bun build --compile` output, which this task cannot
  // produce (bun is unavailable in the sandbox — noted, not faked). The test
  // below IS that fixture, written against the Stage 3 harness's invocation
  // style (scripts/blackbox-compiled.ts): it runs when a compiled binary is
  // reachable (HYDRA_COMPILED_BINARY, or dist/hydra-cli from `npm run
  // build:bin`) and skips loudly otherwise, so a follow-up task with bun
  // access only has to build the binary — no test changes needed.
  // -------------------------------------------------------------------------

  const COMPILED_BINARY = process.env.HYDRA_COMPILED_BINARY
    ?? join(import.meta.dirname, '..', 'dist', 'hydra-cli');

  it('compiled binary dispatches through adapter-stub end-to-end (requires a bun-built binary)', {
    skip: existsSync(COMPILED_BINARY)
      ? false
      : `no compiled binary at ${COMPILED_BINARY} — run \`npm run build:bin\` (requires bun) or set HYDRA_COMPILED_BINARY`,
  }, async () => {
    const id = runId();
    const root = join(TEST_TMP, id, 'e2e');
    const stateRoot = join(root, 'state');
    const runDir = join(stateRoot, 'runs', `run-${id}`);
    const worktree = join(root, 'worktree');
    mkdirSync(join(runDir, 'tasks'), { recursive: true });
    mkdirSync(worktree, { recursive: true });

    // The stub adapter observes Git state from the worktree, so the worktree
    // must be a real repository with a branch and a base commit.
    const git = (args: string[]): void => {
      const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    };
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    writeFileSync(join(worktree, 'README.md'), '# fixture\n', 'utf8');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' })
      .stdout.trim();

    writeFileSync(join(runDir, 'tasks', 'task-a.yaml'), [
      'task_id: task-a',
      `run_id: ${id}`,
      'assigned_vendor: stub',
      `worktree: ${worktree}`,
      'timeout_minutes: 45',
      'spec_version: 1',
      `branch: hydra/${id}/task-a`,
      `base_commit: ${base}`,
      '',
    ].join('\n'));

    // The review's exact failing scenario: HYDRA_HARNESS=bin with the
    // compiled binary. herdr is deliberately absent from PATH so dispatch
    // takes the plain self-reexec spawn path.
    const result = spawnSync(COMPILED_BINARY, ['dispatch', id, 'task-a'], {
      cwd: worktree,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: root,
        HYDRA_STATE_ROOT: stateRoot,
        HYDRA_HARNESS: 'bin',
        HYDRA_HERDR_PANES: '0',
        TERM: 'dumb',
      },
    });

    const agentRunId = `${id}-task-a-v1`;
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(result.stdout.includes(agentRunId), `stdout missing agent run id: ${result.stdout}`);
    const events = readFileSync(join(runDir, 'authoritative', 'ledger', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>);
    const exited = events.find((e) => e.event === 'agent_exited');
    assert.equal(exited?.exit_code, '0', `ledger: ${JSON.stringify(events)}`);
    const drop = JSON.parse(
      readFileSync(join(runDir, 'inbox', agentRunId, 'result.json'), 'utf8'),
    ) as { vendor?: string; status?: string };
    assert.equal(drop.vendor, 'stub');
    assert.equal(drop.status, 'completed');
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
    const f = fixture(runId(), { tsAdapterContent: 'export function start(): void {}\nexport function resume(): void {}\n' });
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
      env: { HYDRA_DELIVERY: 'resume' },
    });
    await dispatch(f.runId, 'task-a', options);

    assert.equal(mock.calls[0].args[2], 'resume');
    assert.equal(mock.calls[0].args.at(-1), 'session-old');
    assert.equal(ledger(f)[0].delivery, 'resume');
  });

  it('cold-restarts while preserving a discovered prior session when a TypeScript adapter lacks resume', async () => {
    const f = fixture(runId(), { vendor: 'codex' });
    writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.json`), JSON.stringify({ session_id: 'session-1' }));
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_DELIVERY: 'resume' },
    }));
    assert.equal(mock.calls[0].args[2], 'start');
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
    assert.match(herdr.starts[0].command, /printf '%s' \$(\?|RC)/);
    assert.deepEqual(herdr.resizes, [{ paneId: 'pane-1', direction: 'down', amount: 0.25 }]);
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
    assert.equal(mock.calls[0].command, process.execPath);
    assert.match(mock.calls[0].args.join(' '), /adapter-opencode\.ts/);
    assert.equal(herdr.starts.length, 1);
    assert.equal(herdr.starts[0].workspace, 'workspace-monitor');
    assert.deepEqual(herdr.resizes, [{ paneId: 'pane-1', direction: 'down', amount: 0.25 }]);
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

    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_HERDR_PANES: '0' },
      herdr,
    }));

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
      assert.ok(command.indexOf(`cat '${bannerPath}'`) < command.indexOf(`'${f.tsAdapterPath}'`), `${vendor} banner is printed before the adapter`);
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

  it('keeps claude panes live with a supervisor heartbeat on every poll', async () => {
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

    const command = herdr.starts[0].command;
    assert.match(command, /tail -n \+1 -f/, 'claude pane tails the progress file');
    assert.match(command, /TPID=/);
    assert.match(command, /kill \$TPID/);

    const progressPath = join(f.sessionsDir, `${expectedId}.pane-progress.txt`);
    const progress = readFileSync(progressPath, 'utf8');
    assert.match(progress, /\[hydra\] claude started — waiting for output\.\.\./, 'seed line shows within the first poll interval');
    assert.match(progress, /\[hydra\] claude working\.\.\. elapsed \d+s/, 'heartbeat line is refreshed on each supervisor poll');
  });

  it('shrinks agent panes to HYDRA_HERDR_PANE_RATIO and defaults to 0.25', async () => {
    const cases: Array<[string | undefined, number]> = [
      ['0.4', 0.4],
      ['0.30', 0.3],
      ['bogus', 0.25],
      ['0', 0.25],
      ['1.5', 0.25],
      [undefined, 0.25],
    ];
    for (const [raw, expected] of cases) {
      const f = fixture(runId(), { vendor: 'claude' });
      const herdr = new FakeHerdr();
      herdr.live = true;
      const expectedId = `${f.runId}-task-a-v1`;
      const clock = new StepClock(() => {
        writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
      });
      const env: NodeJS.ProcessEnv = { HYDRA_HERDR_PANES: '1' };
      if (raw !== undefined) env.HYDRA_HERDR_PANE_RATIO = raw;
      await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
        env,
        herdr,
        clock,
      }));
      assert.deepEqual(
        herdr.resizes,
        [{ paneId: 'pane-1', direction: 'down', amount: expected }],
        `HYDRA_HERDR_PANE_RATIO=${raw} must resize to ${expected}`,
      );
    }
  });

  it('herdrAgentPaneRatio rejects non-finite and out-of-range values', () => {
    assert.equal(herdrAgentPaneRatio(undefined), 0.25);
    assert.equal(herdrAgentPaneRatio(''), 0.25);
    assert.equal(herdrAgentPaneRatio('  '), 0.25);
    assert.equal(herdrAgentPaneRatio('abc'), 0.25);
    assert.equal(herdrAgentPaneRatio('NaN'), 0.25);
    assert.equal(herdrAgentPaneRatio('-0.5'), 0.25);
    assert.equal(herdrAgentPaneRatio('0'), 0.25);
    assert.equal(herdrAgentPaneRatio('1'), 0.25);
    assert.equal(herdrAgentPaneRatio('0.25'), 0.25);
    assert.equal(herdrAgentPaneRatio('0.3'), 0.3);
  });

  it('swallows an async paneResize rejection without failing the worker', async () => {
    const f = fixture(runId(), { vendor: 'claude' });
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.paneResize = () => Promise.reject(new Error('resize boom'));
    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
        env: { HYDRA_HERDR_PANES: '1' },
        herdr,
        clock,
      }));
      // Flush the microtask queue so a stray fire-and-forget rejection would
      // surface on the listener before we detach it.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
    assert.deepEqual(rejections, [], 'a rejected paneResize promise must not become an unhandled rejection');
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

  describe('async foundation', () => {
    it('generates a dispatch_instance_id and includes it in task_started and the terminal event', async () => {
      const f = fixture(runId());
      const mock = fakeSpawn({ autoExit: 5 });
      await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn));

      const events = ledger(f);
      assert.equal(events[0].event, 'task_started');
      assert.match(events[0].dispatch_instance_id, /^[0-9a-f]{16}$/);
      assert.equal(events.at(-1)?.event, 'agent_exited');
      assert.equal(events.at(-1)?.dispatch_instance_id, events[0].dispatch_instance_id);
    });

    it('writes the dispatch pidfile under sessions/supervisor and removes it on completion', async () => {
      const f = fixture(runId());
      const gate = new GateClock();
      const mock = fakeSpawn({ autoExit: false });
      const options = injectedOptions(f, mock.spawn, { background: true, clock: gate });
      const handle = await dispatch(f.runId, 'task-a', options);

      const pidfile = join(f.sessionsDir, 'supervisor', `${f.runId}-task-a-v1.dispatch.pid`);
      assert.equal(existsSync(pidfile), true, 'dispatch pidfile should exist while running');
      assert.equal(readFileSync(pidfile, 'utf8'), String(process.pid));
      assert.equal(existsSync(`${pidfile}.tmp.${process.pid}`), false, 'no leftover temp file');

      mock.calls[0].child.exit(0);
      gate.release();
      await handle.finished;

      assert.equal(existsSync(pidfile), false, 'dispatch pidfile should be removed after completion');
    });

    it('cleans up the temp file when atomic write fails to rename', async () => {
      const f = fixture(runId());
      const pidfile = join(f.sessionsDir, 'supervisor', `${f.runId}-task-a-v1.dispatch.pid`);
      mkdirSync(dirname(pidfile), { recursive: true });
      mkdirSync(pidfile); // destination exists as directory, so rename will fail
      const mock = fakeSpawn();

      await assert.rejects(
        dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { background: true })),
        /cross-device|ENOTEMPTY|EISDIR|ENAMETOOLONG/i,
      );

      assert.equal(existsSync(`${pidfile}.tmp.${process.pid}`), false, 'temp file should be removed after rename failure');
    });

    it('does not let supervisor metadata interfere with the plain-activity timeout', async () => {
      const f = fixture(runId(), { timeoutMinutes: 1 });
      const id = `${f.runId}-task-a-v1`;
      const supervisorDir = join(f.sessionsDir, 'supervisor');
      mkdirSync(supervisorDir, { recursive: true });
      writeFileSync(join(supervisorDir, `${id}.dispatch.pid`), String(process.pid));

      const mock = fakeSpawn({ autoExit: false });
      const clock = new StepClock();
      await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { clock, pollIntervalMs: 20_000 }));

      assert.equal(clock.sleeps, 3);
      assert.equal(ledger(f).at(-1)?.event, 'agent_timed_out');
      assert.equal(ledger(f).at(-1)?.reason, 'stalled');
    });

    it('detects a pane worker that disappears before writing the exit sentinel', async () => {
      const f = fixture(runId());
      const herdr = new FakeHerdr();
      herdr.live = true;
      const id = `${f.runId}-task-a-v1`;
      let aliveCalls = 0;
      const clock = new StepClock((_ms, count) => {
        if (count === 1) {
          writeFileSync(join(f.sessionsDir, `${id}.pid`), '12345');
        }
      });
      const options = injectedOptions(f, () => { throw new Error('no spawn'); }, {
        env: { HYDRA_HERDR_PANES: '1' },
        herdr,
        clock,
        processAlive: () => { aliveCalls += 1; return false; },
      });

      await dispatch(f.runId, 'task-a', options);

      assert.equal(ledger(f).at(-1)?.event, 'agent_exited');
      assert.equal(ledger(f).at(-1)?.exit_code, '127');
      assert.equal(ledger(f).at(-1)?.reason, 'worker_disappeared');
      assert.equal(ledger(f).at(-1)?.dispatch_instance_id, ledger(f)[0].dispatch_instance_id);
      assert.ok(aliveCalls >= 2, 'processAlive should be probed at least twice');
      assert.deepEqual(options.killed, [12345], 'worker tree should be killed when worker disappears');
      assert.deepEqual(herdr.closes, ['pane-1']);
    });

    it('does not crash when the exit sentinel exists but cannot be read', async () => {
      const f = fixture(runId());
      const herdr = new FakeHerdr();
      herdr.live = true;
      const id = `${f.runId}-task-a-v1`;
      const sentinel = join(f.sessionsDir, `${id}.exit`);
      let sentinelCreated = false;
      const clock = new StepClock((_ms, count) => {
        if (count === 1) {
          // Create an unreadable sentinel so existsSync succeeds but readFileSync throws.
          writeFileSync(sentinel, '42\n', 'utf8');
          chmodSync(sentinel, 0o000);
          sentinelCreated = true;
        }
      });

      try {
        await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
          env: { HYDRA_HERDR_PANES: '1' },
          herdr,
          clock,
        }));
      } finally {
        if (sentinelCreated && existsSync(sentinel)) {
          chmodSync(sentinel, 0o600);
          rmSync(sentinel, { force: true });
        }
      }

      assert.equal(ledger(f).at(-1)?.event, 'agent_exited');
      assert.equal(ledger(f).at(-1)?.exit_code, '0');
      assert.deepEqual(herdr.closes, ['pane-1']);
    });

    it('does not crash when the pane pidfile cannot be read at timeout', async () => {
      const f = fixture(runId(), { timeoutMinutes: 1 });
      const herdr = new FakeHerdr();
      herdr.live = true;
      const id = `${f.runId}-task-a-v1`;
      const pidfile = join(f.sessionsDir, `${id}.pid`);
      let pidfileCreated = false;
      const clock = new StepClock((_ms, count) => {
        if (count === 1) {
          // runWorkerInHerdrPane removes the pidfile at startup, so create it
          // unreadable after the first loop tick so the timeout branch must
          // handle a readFileSync failure.
          writeFileSync(pidfile, '12345\n', 'utf8');
          chmodSync(pidfile, 0o000);
          pidfileCreated = true;
        }
      });

      try {
        await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
          env: { HYDRA_HERDR_PANES: '1' },
          herdr,
          clock,
        }));
      } finally {
        if (pidfileCreated && existsSync(pidfile)) {
          chmodSync(pidfile, 0o600);
          rmSync(pidfile, { force: true });
        }
      }

      assert.equal(ledger(f).at(-1)?.event, 'agent_timed_out');
      assert.deepEqual(herdr.closes, ['pane-1']);
    });

    it('prefers the exit sentinel when the worker disappears after writing it', async () => {
      const f = fixture(runId());
      const herdr = new FakeHerdr();
      herdr.live = true;
      const id = `${f.runId}-task-a-v1`;
      let aliveCalls = 0;
      const clock = new StepClock((_ms, count) => {
        if (count === 1) {
          writeFileSync(join(f.sessionsDir, `${id}.pid`), '12345');
        } else if (count === 2) {
          writeFileSync(join(f.sessionsDir, `${id}.exit`), '42');
        }
      });

      await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
        env: { HYDRA_HERDR_PANES: '1' },
        herdr,
        clock,
        processAlive: () => { aliveCalls += 1; return false; },
      }));

      assert.equal(ledger(f).at(-1)?.event, 'agent_exited');
      assert.equal(ledger(f).at(-1)?.exit_code, '42');
      assert.notEqual(ledger(f).at(-1)?.reason, 'worker_disappeared');
      assert.deepEqual(herdr.closes, ['pane-1']);
    });

    it('does not treat a transient processAlive false-negative as worker disappearance', async () => {
      const f = fixture(runId());
      const herdr = new FakeHerdr();
      herdr.live = true;
      const id = `${f.runId}-task-a-v1`;
      let aliveCalls = 0;
      const clock = new StepClock((_ms, count) => {
        if (count === 1) {
          writeFileSync(join(f.sessionsDir, `${id}.pid`), '12345');
        } else if (count === 3) {
          writeFileSync(join(f.sessionsDir, `${id}.exit`), '0');
        }
      });

      await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('no spawn'); }, {
        env: { HYDRA_HERDR_PANES: '1' },
        herdr,
        clock,
        processAlive: () => {
          aliveCalls += 1;
          return aliveCalls !== 1;
        },
      }));

      assert.equal(ledger(f).at(-1)?.event, 'agent_exited');
      assert.equal(ledger(f).at(-1)?.exit_code, '0');
      assert.notEqual(ledger(f).at(-1)?.reason, 'worker_disappeared');
      assert.deepEqual(herdr.closes, ['pane-1']);
    });

    it('removes the dispatch pidfile when a cancelling signal fires', async () => {
      // A long-running TS stub adapter keeps the worker alive until SIGINT so
      // the pidfile is observably written and then removed by the signal path.
      const tsAdapterDir = join(TEST_TMP, `signal-ts-${runId()}`, 'src');
      mkdirSync(tsAdapterDir, { recursive: true });
      writeFileSync(join(tsAdapterDir, 'adapter-claude.ts'), 'export function start(): void { setInterval(() => {}, 60000); }\n');
      const dispatchSrc = fileURLToPath(new URL('../src/dispatch.ts', import.meta.url));
      const helperPath = join(TEST_TMP, `signal-helper-${runId()}.mjs`);
      writeFileSync(helperPath, [
        `import { dispatch } from ${JSON.stringify(pathToFileURL(dispatchSrc).href)};`,
        'const [runId, taskId, stateRoot, repoRoot, tsAdapterDir] = process.argv.slice(2);',
        'await dispatch(runId, taskId, { stateRoot, repoRoot, tsAdapterDir });',
        '',
      ].join('\n'), 'utf8');

      const f = fixture(runId());
      const child = spawn(process.execPath, ['--experimental-strip-types', helperPath, f.runId, 'task-a', f.stateRoot, f.repoRoot, tsAdapterDir], { stdio: 'ignore' });
      const pidfile = join(f.sessionsDir, 'supervisor', `${f.runId}-task-a-v1.dispatch.pid`);

      try {
        await waitFor(() => existsSync(pidfile), { timeout: 5000 });
        child.kill('SIGINT');
        await new Promise<void>((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', () => resolve());
        });
        assert.equal(existsSync(pidfile), false, 'dispatch pidfile should be removed after signal cancellation');
      } finally {
        child.kill('SIGTERM');
        rmSync(helperPath, { force: true });
      }
    });
  });

  describe('loop detector integration', () => {
    function codexCommand(cmd: string, exitCode?: number): string {
      if (exitCode !== undefined) {
        return JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: cmd }, exit_code: exitCode });
      }
      return JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: cmd } });
    }

    function codexText(text: string): string {
      return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
    }

    function writeRepeatedFailureCapture(f: Fixture, count = 12, textCount = 8): void {
      const lines: string[] = [];
      for (let i = 0; i < count; i += 1) lines.push(codexCommand('npm test', 1));
      for (let i = 0; i < textCount; i += 1) lines.push(codexText(`msg ${i}`));
      writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.cli.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    }

    function stableGitExec(): ExecFileSyncLike {
      return (file, args) => {
        if (file !== 'git') throw new Error(`unexpected command: ${file}`);
        if (args.includes('rev-parse')) return 'HEAD\n';
        if (args.includes('diff')) return '';
        if (args.includes('status')) return '';
        if (args.includes('ls-files')) return '';
        return '';
      };
    }

    it('never triggers detection for a healthy diverse-action task', async () => {
      const f = fixture(runId(), { vendor: 'codex', timeoutMinutes: 30 });
      const lines: string[] = [];
      for (let i = 0; i < 20; i += 1) lines.push(codexCommand(`cmd-${i % 10}`, i % 3 === 0 ? 1 : 0));
      writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.cli.jsonl`), `${lines.join('\n')}\n`, 'utf8');
      const mock = fakeSpawn({ autoExit: false });
      const clock = new StepClock((_, count) => {
        if (count === 8) mock.calls[0]?.child.exit(0);
      });
      const options = injectedOptions(f, mock.spawn, {
        clock,
        pollIntervalMs: 60_000,
        execFileSync: stableGitExec(),
      });
      await dispatch(f.runId, 'task-a', options);
      const events = ledger(f).map(({ event }) => event);
      assert.deepEqual(events, ['task_started', 'agent_exited']);
    });

    it('detects repeated failure, emits suspected then confirmed, and cancels via recorder.cancel()', async () => {
      const f = fixture(runId(), { vendor: 'codex', timeoutMinutes: 30 });
      writeRepeatedFailureCapture(f);
      const mock = fakeSpawn({ autoExit: false });
      const capturePath = join(f.sessionsDir, `${f.runId}-task-a-v1.cli.jsonl`);
      const clock = new StepClock((_, count) => {
        // Stage 2 requires ongoing fresh evidence during the confirmation
        // window, not just elapsed wall-clock time. Append fresh matching
        // failures throughout the run so confirmation can fire.
        if (count >= 10) {
          appendFileSync(capturePath, `${codexCommand('npm test', 1)}\n`, 'utf8');
        }
        if (count >= 25) mock.calls[0]?.child.exit(0);
      });
      const options = injectedOptions(f, mock.spawn, {
        clock,
        pollIntervalMs: 60_000,
        execFileSync: stableGitExec(),
      });
      await dispatch(f.runId, 'task-a', options);
      const events = ledger(f).map(({ event }) => event);
      assert.ok(events.includes('agent_loop_suspected'), `expected agent_loop_suspected in ${events.join(', ')}`);
      assert.ok(events.includes('agent_loop_confirmed'), `expected agent_loop_confirmed in ${events.join(', ')}`);
      assert.equal(events.at(-1), 'agent_cancelled');
      assert.deepEqual(options.killed, [mock.calls[0].child.pid]);
      const suspected = ledger(f).find((e) => e.event === 'agent_loop_suspected');
      assert.ok(suspected?.dominant_action_hash);
      assert.ok(suspected?.dispatch_instance_id);
    });

    it('clears suspicion when the Git signature changes', async () => {
      const f = fixture(runId(), { vendor: 'codex', timeoutMinutes: 30 });
      writeRepeatedFailureCapture(f);
      const mock = fakeSpawn({ autoExit: false });
      let gitCall = 0;
      const execGit: ExecFileSyncLike = (file, args) => {
        if (file !== 'git') throw new Error(`unexpected command: ${file}`);
        if (args.includes('rev-parse')) return 'HEAD\n';
        if (args.includes('diff')) {
          gitCall += 1;
          // Keep the baseline stable long enough for Rule A to fire, then change
          // the diff before the Stage 2 confirmation window elapses.
          return gitCall < 12 ? '' : '+changed\n';
        }
        if (args.includes('status')) return '';
        if (args.includes('ls-files')) return '';
        return '';
      };
      const clock = new StepClock((_, count) => {
        if (count === 13) mock.calls[0]?.child.exit(0);
      });
      const options = injectedOptions(f, mock.spawn, {
        clock,
        pollIntervalMs: 60_000,
        execFileSync: execGit,
      });
      await dispatch(f.runId, 'task-a', options);
      const events = ledger(f).map(({ event }) => event);
      assert.ok(events.includes('agent_loop_suspected'));
      assert.ok(events.includes('agent_loop_cleared'));
      assert.equal(events.at(-1), 'agent_exited');
    });

    it('does not trigger Rule A on repeated successful actions', async () => {
      const f = fixture(runId(), { vendor: 'codex', timeoutMinutes: 30 });
      const lines: string[] = [];
      for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 0));
      for (let i = 0; i < 8; i += 1) lines.push(codexText(`msg ${i}`));
      writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.cli.jsonl`), `${lines.join('\n')}\n`, 'utf8');
      const mock = fakeSpawn({ autoExit: false });
      const clock = new StepClock((_, count) => {
        if (count === 8) mock.calls[0]?.child.exit(0);
      });
      const options = injectedOptions(f, mock.spawn, {
        clock,
        pollIntervalMs: 60_000,
        execFileSync: stableGitExec(),
      });
      await dispatch(f.runId, 'task-a', options);
      const events = ledger(f).map(({ event }) => event);
      assert.deepEqual(events, ['task_started', 'agent_exited']);
    });

    it('never reaches Stage 2 for Claude/non-streaming vendor', async () => {
      const f = fixture(runId(), { vendor: 'claude', timeoutMinutes: 30 });
      const lines: string[] = [];
      for (let i = 0; i < 30; i += 1) lines.push(codexCommand('npm test', 1));
      writeFileSync(join(f.sessionsDir, `${f.runId}-task-a-v1.cli.jsonl`), `${lines.join('\n')}\n`, 'utf8');
      const mock = fakeSpawn({ autoExit: false });
      const clock = new StepClock((_, count) => {
        if (count === 8) mock.calls[0]?.child.exit(0);
      });
      const options = injectedOptions(f, mock.spawn, {
        clock,
        pollIntervalMs: 60_000,
        execFileSync: stableGitExec(),
      });
      await dispatch(f.runId, 'task-a', options);
      const events = ledger(f).map(({ event }) => event);
      assert.deepEqual(events, ['task_started', 'agent_exited']);
    });

    it('is fully disabled when HYDRA_LOOP_DETECTOR=0', async () => {
      const f = fixture(runId(), { vendor: 'codex', timeoutMinutes: 30 });
      writeRepeatedFailureCapture(f);
      const mock = fakeSpawn({ autoExit: false });
      let gitCalls = 0;
      const execGit: ExecFileSyncLike = (file) => {
        gitCalls += 1;
        throw new Error(`git should not be called when disabled: ${file}`);
      };
      const clock = new StepClock((_, count) => {
        if (count === 8) mock.calls[0]?.child.exit(0);
      });
      const options = injectedOptions(f, mock.spawn, {
        clock,
        pollIntervalMs: 60_000,
        execFileSync: execGit,
        env: { HYDRA_LOOP_DETECTOR: '0' },
      });
      await dispatch(f.runId, 'task-a', options);
      const events = ledger(f).map(({ event }) => event);
      assert.deepEqual(events, ['task_started', 'agent_exited']);
      assert.equal(gitCalls, 0);
    });

    it('detects untracked-file content rewrite as Git progress', async () => {
      const f = fixture(runId(), { vendor: 'codex', timeoutMinutes: 30 });
      const untracked = join(f.worktree, 'untracked.log');
      writeFileSync(untracked, 'first', 'utf8');
      writeRepeatedFailureCapture(f);
      const mock = fakeSpawn({ autoExit: false });
      let lsCall = 0;
      const execGit: ExecFileSyncLike = (file, args) => {
        if (file !== 'git') throw new Error(`unexpected command: ${file}`);
        if (args.includes('rev-parse')) return 'HEAD\n';
        if (args.includes('diff')) return '';
        if (args.includes('status')) return '';
        if (args.includes('ls-files')) {
          lsCall += 1;
          // Keep the untracked file content stable long enough for Rule A to
          // fire, then rewrite it before the Stage 2 confirmation window elapses.
          if (lsCall >= 12) writeFileSync(untracked, 'second', 'utf8');
          return 'untracked.log\0';
        }
        return '';
      };
      const clock = new StepClock((_, count) => {
        if (count === 13) mock.calls[0]?.child.exit(0);
      });
      const options = injectedOptions(f, mock.spawn, {
        clock,
        pollIntervalMs: 60_000,
        execFileSync: execGit,
      });
      await dispatch(f.runId, 'task-a', options);
      const events = ledger(f).map(({ event }) => event);
      assert.ok(events.includes('agent_loop_suspected'));
      assert.ok(events.includes('agent_loop_cleared'));
      assert.equal(events.at(-1), 'agent_exited');
    });
  });
});

describe('dispatch head availability gate', () => {
  before(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => rmSync(TEST_TMP, { recursive: true, force: true }));

  it('dies with suggestions when the assigned vendor CLI is not on PATH', async () => {
    const f = fixture(runId(), { vendor: 'claude' });
    const mock = fakeSpawn();
    await assert.rejects(
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
        probeHeads: () => headsSnapshot({ claude: false }),
      })),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /assigned vendor 'claude' is not on PATH at dispatch time/);
        assert.match(message, /Available heads: codex, opencode, kimi/);
        assert.match(message, /Best eligible substitute for role 'implementer': codex/);
        assert.match(message, /never auto-substitute/);
        return true;
      },
    );
    assert.equal(mock.calls.length, 0, 'the worker must never be spawned');
    assert.deepEqual(ledger(f).map(({ event }) => event), [], 'the gate fires before task_started');
  });

  it('orders the substitute by the eligible() ordering of the spec role', async () => {
    const f = fixture(runId(), { vendor: 'codex' });
    appendFileSync(f.taskSpecPath, 'role: reviewer\n', 'utf8');
    const mock = fakeSpawn();
    await assert.rejects(
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
        probeHeads: () => headsSnapshot({ codex: false }),
      })),
      /Best eligible substitute for role 'reviewer': opencode/,
    );
  });

  it('reports no substitute when no eligible head is available', async () => {
    const f = fixture(runId(), { vendor: 'kimi' });
    const mock = fakeSpawn();
    await assert.rejects(
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
        probeHeads: () => headsSnapshot({ claude: false, codex: false, opencode: false, kimi: false }),
      })),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /Available heads: none/);
        assert.match(message, /Best eligible substitute for role 'implementer': none/);
        return true;
      },
    );
  });

  it('skips the gate for vendors outside the detected head set', async () => {
    const f = fixture(runId(), { vendor: 'stub' });
    let called = false;
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      probeHeads: () => {
        called = true;
        return headsSnapshot();
      },
    }));
    assert.equal(called, false, 'stub is not a detected head; no probe expected');
    assert.equal(mock.calls.length, 1);
  });

  it('fails open when the availability probe throws', async () => {
    const f = fixture(runId(), { vendor: 'claude' });
    const mock = fakeSpawn();
    const { output } = await captureStderr(() =>
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
        probeHeads: () => {
          throw new Error('probe exploded');
        },
      })),
    );
    assert.equal(mock.calls.length, 1, 'a probe failure must not block dispatch');
    assert.match(output, /head availability probe failed/);
  });
});

describe('dispatch opencode_model pin', () => {
  before(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => rmSync(TEST_TMP, { recursive: true, force: true }));

  function writeHeadsFile(f: Fixture, models: string[]): string {
    const headsFile = join(f.runDir, 'heads.json');
    writeFileSync(headsFile, JSON.stringify(headsSnapshot({}, models)), 'utf8');
    return headsFile;
  }

  it('warns but proceeds when the pinned model is absent from the detected list', async () => {
    const f = fixture(runId(), { vendor: 'opencode' });
    appendFileSync(f.taskSpecPath, 'opencode_model: acme/model-x\n', 'utf8');
    const headsFile = writeHeadsFile(f, ['zai-coding-plan/glm-5.2']);
    const mock = fakeSpawn();

    const { output } = await captureStderr(() =>
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { headsFile })),
    );

    assert.match(output, /opencode_model 'acme\/model-x' is not in the detected opencode model list/);
    assert.match(output, /proceeding anyway/);
    assert.equal(mock.calls.length, 1, 'dispatch proceeds despite the stale model list');
  });

  it('stays silent when the pinned model is in the detected list', async () => {
    const f = fixture(runId(), { vendor: 'opencode' });
    appendFileSync(f.taskSpecPath, 'opencode_model: acme/model-x\n', 'utf8');
    const headsFile = writeHeadsFile(f, ['acme/model-x', 'zai-coding-plan/glm-5.2']);
    const mock = fakeSpawn();

    const { output } = await captureStderr(() =>
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { headsFile })),
    );

    assert.doesNotMatch(output, /not in the detected opencode model list/);
    assert.equal(mock.calls.length, 1);
  });

  it('stays silent when heads.json is missing or lists no models', async () => {
    const missing = fixture(runId(), { vendor: 'opencode' });
    appendFileSync(missing.taskSpecPath, 'opencode_model: acme/model-x\n', 'utf8');
    const mockMissing = fakeSpawn();
    const { output: missingOutput } = await captureStderr(() =>
      dispatch(missing.runId, 'task-a', injectedOptions(missing, mockMissing.spawn, {
        headsFile: join(missing.runDir, 'absent-heads.json'),
      })),
    );
    assert.doesNotMatch(missingOutput, /not in the detected opencode model list/);
    assert.equal(mockMissing.calls.length, 1);

    const empty = fixture(runId(), { vendor: 'opencode' });
    appendFileSync(empty.taskSpecPath, 'opencode_model: acme/model-x\n', 'utf8');
    const headsFile = writeHeadsFile(empty, []);
    const mockEmpty = fakeSpawn();
    const { output: emptyOutput } = await captureStderr(() =>
      dispatch(empty.runId, 'task-a', injectedOptions(empty, mockEmpty.spawn, { headsFile })),
    );
    assert.doesNotMatch(emptyOutput, /not in the detected opencode model list/);
    assert.equal(mockEmpty.calls.length, 1);
  });

  it('ignores opencode_model for non-opencode vendors', async () => {
    const f = fixture(runId(), { vendor: 'claude' });
    appendFileSync(f.taskSpecPath, 'opencode_model: acme/model-x\n', 'utf8');
    const headsFile = writeHeadsFile(f, ['zai-coding-plan/glm-5.2']);
    const mock = fakeSpawn();

    const { output } = await captureStderr(() =>
      dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, { headsFile })),
    );

    assert.doesNotMatch(output, /not in the detected opencode model list/);
    assert.equal(mock.calls.length, 1);
  });
});

describe('dispatch herdr workspace pin (issue #19)', () => {
  before(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => rmSync(TEST_TMP, { recursive: true, force: true }));

  function herdrFixture(): Fixture {
    const f = fixture(runId());
    // dispatch reads herdr_workspace from <runDir>/run.yaml — the test fixture
    // doesn't create one, so simulate a real run-init by writing an empty one
    // each test can extend.
    writeFileSync(join(f.runDir, 'run.yaml'), `run_id: "${f.runId}"\nbase_commit: abc\nstate: planning\ntasks: []\n`);
    return f;
  }

  async function dispatchHerdrClaude(f: Fixture, workspace: string, env: NodeJS.ProcessEnv = {}): Promise<{ started: { workspace?: string }; runYamlContent: string | undefined }> {
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = workspace;
    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });
    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('plain spawn must not run'); }, {
      env: { HYDRA_HERDR_PANES: '1', ...env },
      herdr,
      clock,
    }));
    let runYamlContent: string | undefined;
    try {
      runYamlContent = readFileSync(join(f.runDir, 'run.yaml'), 'utf8');
    } catch {
      // The corrupt-run.yaml test deliberately makes run.yaml unreadable.
      runYamlContent = undefined;
    }
    return { started: herdr.starts[0], runYamlContent };
  }

  it('persists the workspace id on the first pane spawn when run.yaml has no pin yet', async () => {
    const f = herdrFixture();
    // run.yaml exists but has no herdr_workspace field.
    const { started, runYamlContent } = await dispatchHerdrClaude(f, 'ws-initial');
    assert.equal(started.workspace, 'ws-initial');
    assert.match(runYamlContent ?? '', /^herdr_workspace: ws-initial$/m);
  });

  it('creates run.yaml with the pin when the file did not exist before the first spawn', async () => {
    // A run whose run.yaml is missing (e.g. run-init skipped) must still
    // capture and persist the workspace on the first pane spawn.
    const f = fixture(runId());
    rmSync(join(f.runDir, 'run.yaml'), { force: true });
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = 'ws-no-preexisting-yaml';
    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });
    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('plain spawn must not run'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
    }));
    const runYamlPath = join(f.runDir, 'run.yaml');
    assert.equal(existsSync(runYamlPath), true, 'run.yaml should be created on first capture');
    assert.match(readFileSync(runYamlPath, 'utf8'), /^herdr_workspace: ws-no-preexisting-yaml$/m);
    assert.equal(herdr.starts[0].workspace, 'ws-no-preexisting-yaml');
  });

  it('reuses the persisted workspace id on a later spawn even when the live focus differs', async () => {
    const f = herdrFixture();
    // The first dispatch in this run captured ws-initial.
    await dispatchHerdrClaude(f, 'ws-initial');
    // A second task in the same run, with the operator's focus now elsewhere.
    // Write task-b.yaml under the SAME run so this is genuinely a second
    // dispatch within the same run, not a re-run of task-a.
    const taskBSpec = join(f.runDir, 'tasks', 'task-b.yaml');
    writeFileSync(
      taskBSpec,
      readFileSync(f.taskSpecPath, 'utf8').replace('task_id: task-a', 'task_id: task-b'),
    );

    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = 'ws-focus-moved';
    const expectedId = `${f.runId}-task-b-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });
    await dispatch(f.runId, 'task-b', injectedOptions(f, () => { throw new Error('plain spawn must not run'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
    }));
    assert.equal(herdr.starts[0].workspace, 'ws-initial', 'second spawn must reuse the pinned value, not the live focus');
  });

  it('does not invoke focusedWorkspace() at all on a subsequent spawn when a pin exists', async () => {
    // Spec contract (issue #19, step 2): the persisted workspace id is read
    // FIRST; the live focusedWorkspace() shell-out is SKIPPED entirely once a
    // pin exists, not merely have its result discarded. The operator's focus
    // having moved is one symptom; the more fundamental contract is that the
    // live query itself must not happen on every pane-spawn call site.
    const f = herdrFixture();
    writeFileSync(join(f.runDir, 'run.yaml'), `run_id: "${f.runId}"\nherdr_workspace: ws-pinned\n`);

    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = 'ws-focus-moved';
    let focusedCalls = 0;
    const realFocused = herdr.focusedWorkspace.bind(herdr);
    herdr.focusedWorkspace = (): string | undefined => {
      focusedCalls += 1;
      return realFocused();
    };

    const expectedId = `${f.runId}-task-a-v1`;
    const clock = new StepClock(() => {
      writeFileSync(join(f.sessionsDir, `${expectedId}.exit`), '0');
    });
    await dispatch(f.runId, 'task-a', injectedOptions(f, () => { throw new Error('plain spawn must not run'); }, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
      clock,
    }));

    assert.equal(focusedCalls, 0, 'live focusedWorkspace() must not be called once a pin exists');
    assert.equal(herdr.starts[0].workspace, 'ws-pinned');
  });

  it('HYDRA_HERDR_WORKSPACE_PIN=0 disables the pin and restores the live-query behavior', async () => {
    const f = herdrFixture();
    // Pre-pin run.yaml with ws-initial so the disabled path has something to skip.
    writeFileSync(join(f.runDir, 'run.yaml'), `run_id: "${f.runId}"\nherdr_workspace: ws-initial\n`);
    const { started } = await dispatchHerdrClaude(f, 'ws-focus-live', { HYDRA_HERDR_WORKSPACE_PIN: '0' });
    assert.equal(started.workspace, 'ws-focus-live', 'escape hatch must live-query rather than reuse the pin');
  });

  it('falls back to the live workspace when run.yaml cannot be read', async () => {
    const f = herdrFixture();
    const yamlPath = join(f.runDir, 'run.yaml');
    // Replace run.yaml with a directory so yamlScalar's readFileSync throws
    // (EISDIR). The dispatch must not crash and must use the live value.
    rmSync(yamlPath, { force: true });
    mkdirSync(yamlPath, { recursive: true });
    const { started } = await dispatchHerdrClaude(f, 'ws-corrupt-fallback');
    assert.equal(started.workspace, 'ws-corrupt-fallback', 'an unreadable run.yaml must fall back to a live query');
  });

  it('pins the opencode monitor pane to the same workspace as the rest of the run', async () => {
    // The OpenCode monitor pane is launched through openOpencodeMonitor and
    // also goes through resolvePaneWorkspace. Verify the pin applies there too:
    // seed run.yaml with a captured workspace, simulate the operator's focus
    // having moved, and assert the monitor pane is launched on the pinned one.
    const f = fixture(runId(), { vendor: 'opencode' });
    writeFileSync(join(f.runDir, 'run.yaml'), `run_id: "${f.runId}"\nherdr_workspace: ws-opencode-pin\n`);
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = 'ws-opencode-live-changed';
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_HERDR_PANES: '1' },
      herdr,
    }));
    assert.equal(herdr.starts.length, 1);
    assert.equal(herdr.starts[0].workspace, 'ws-opencode-pin', 'monitor pane must reuse the pinned workspace');
  });

  it('HYDRA_HERDR_WORKSPACE_PIN=0 lets the opencode monitor pane follow the live focus', async () => {
    const f = fixture(runId(), { vendor: 'opencode' });
    writeFileSync(join(f.runDir, 'run.yaml'), `run_id: "${f.runId}"\nherdr_workspace: ws-opencode-pin\n`);
    const herdr = new FakeHerdr();
    herdr.live = true;
    herdr.workspace = 'ws-opencode-live';
    const mock = fakeSpawn();
    await dispatch(f.runId, 'task-a', injectedOptions(f, mock.spawn, {
      env: { HYDRA_HERDR_PANES: '1', HYDRA_HERDR_WORKSPACE_PIN: '0' },
      herdr,
    }));
    assert.equal(herdr.starts.length, 1);
    assert.equal(herdr.starts[0].workspace, 'ws-opencode-live');
  });
});
