import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { constants, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, herdrState, killTree, log, now, stateRoot, warn, yamlScalar } from './lib.ts';
import { recordUsage } from './record-usage.ts';

export type ExecFileSyncLike = (
  file: string,
  args: string[],
  options?: { encoding?: string; cwd?: string; stdio?: unknown },
) => string | Buffer;

export interface ChildProcessLike {
  pid?: number;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options?: { detached?: boolean; stdio?: unknown; cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessLike;

export interface HerdrClient {
  isLive(): boolean;
  focusedWorkspace(): string | undefined;
  agentStart(options: {
    label: string;
    cwd: string;
    workspace?: string;
    command: string;
  }): string | undefined;
  paneClose(paneId: string): boolean;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DispatchOptions {
  cwd?: string;
  stateRoot?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  execFileSync?: ExecFileSyncLike;
  spawn?: SpawnLike;
  herdr?: HerdrClient;
  herdrState?: (paneId: string, vendor: string, state: string) => void;
  killTree?: (pid: number) => void;
  recordUsage?: (runId: string, taskId: string, vendor: string, agentRunId: string) => void;
  signal?: AbortSignal;
  background?: boolean;
  maxConcurrency?: number;
  pollIntervalMs?: number;
  clock?: Clock;
  noSignals?: boolean;
}

export interface DispatchHandle {
  agentRunId: string;
  finished: Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
};

const defaultExecFileSync: ExecFileSyncLike = (file, args, options) =>
  execFileSync(file, args, options as Parameters<typeof execFileSync>[2]) as string | Buffer;

const defaultSpawn: SpawnLike = (command, args, options) =>
  spawn(command, args, options as Parameters<typeof spawn>[2]) as unknown as ChildProcessLike;

class RealHerdrClient implements HerdrClient {
  private readonly run: ExecFileSyncLike;

  constructor(run: ExecFileSyncLike) {
    this.run = run;
  }

  isLive(): boolean {
    try {
      this.run('herdr', ['status'], { encoding: 'utf8', stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  focusedWorkspace(): string | undefined {
    try {
      const output = String(this.run('herdr', ['pane', 'list'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }));
      const parsed = JSON.parse(output) as {
        result?: { panes?: Array<{ focused?: boolean; workspace_id?: string }> };
      };
      return parsed.result?.panes?.find((pane) => pane.focused)?.workspace_id;
    } catch {
      return undefined;
    }
  }

  agentStart(options: {
    label: string;
    cwd: string;
    workspace?: string;
    command: string;
  }): string | undefined {
    const args = ['agent', 'start', options.label, '--cwd', options.cwd];
    if (options.workspace) args.push('--workspace', options.workspace);
    args.push('--split', 'down', '--no-focus', '--', 'bash', '-lc', options.command);
    try {
      const output = String(this.run('herdr', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }));
      const parsed = JSON.parse(output) as { result?: { agent?: { pane_id?: string } } };
      return parsed.result?.agent?.pane_id;
    } catch {
      return undefined;
    }
  }

  paneClose(paneId: string): boolean {
    try {
      this.run('herdr', ['pane', 'close', paneId], { encoding: 'utf8', stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

interface TaskSpec {
  vendor: string;
  worktree: string;
  timeoutMinutes: number;
  specVersion: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readTaskSpec(path: string): TaskSpec {
  if (!isFile(path)) die(`instantiated task spec not found: ${path}`);
  const timeout = yamlScalar(path, 'timeout_minutes');
  const version = yamlScalar(path, 'spec_version');
  return {
    vendor: yamlScalar(path, 'assigned_vendor'),
    worktree: yamlScalar(path, 'worktree'),
    timeoutMinutes: timeout ? Number(timeout) : 45,
    specVersion: version || '1',
  };
}

function discoverRepoRoot(options: DispatchOptions, cwd: string): string {
  if (options.repoRoot) return resolve(cwd, options.repoRoot);
  const run = options.execFileSync ?? defaultExecFileSync;
  try {
    return String(run('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })).trim();
  } catch {
    die('not inside a git repository');
  }
}

function computeConcurrencyCap(options: DispatchOptions, env: NodeJS.ProcessEnv): number {
  if (options.maxConcurrency !== undefined) return options.maxConcurrency;
  if (env.HYDRA_MAX_CONCURRENCY) return Number(env.HYDRA_MAX_CONCURRENCY);
  const cores = cpus().length || 4;
  return cores > 2 ? Math.min(cores - 2, 16) : 1;
}

function countFilesRecursively(path: string): number {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const name of readdirSync(path)) {
    const entry = join(path, name);
    try {
      const info = lstatSync(entry);
      if (info.isFile()) count += 1;
      else if (info.isDirectory()) count += countFilesRecursively(entry);
    } catch {
      // `find` also tolerates entries disappearing while it walks the slot dir.
    }
  }
  return count;
}

interface LedgerAppender {
  (runId: string, event: string, ...kvs: string[]): void;
}

interface ExitRecorder {
  readonly cancelled: Promise<void>;
  isRecorded(): boolean;
  isCancelled(): boolean;
  setWorkerPid(pid: number): void;
  setPaneId(paneId: string): void;
  recordExit(event: string, rc?: string): void;
  recordTimeout(reason: 'stalled' | 'hard_cap', metric?: [string, string]): void;
  cancel(): void;
  register(signal: AbortSignal | undefined, noSignals: boolean | undefined): void;
  unregister(): void;
}

interface WorkerContext {
  runId: string;
  taskId: string;
  vendor: string;
  agentRunId: string;
  worktree: string;
  inbox: string;
  sessionsDir: string;
  slotsDir: string;
  taskSpecPath: string;
  adapterPath: string;
  verb: 'start' | 'resume';
  priorSession: string;
  timeoutMinutes: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  pollIntervalMs: number;
  spawn: SpawnLike;
  herdr: HerdrClient;
  herdrState: (paneId: string, vendor: string, state: string) => void;
  killTree: (pid: number) => void;
  recordUsage: (runId: string, taskId: string, vendor: string, agentRunId: string) => void;
  appendLedger: LedgerAppender;
}

function releaseSlot(slotsDir: string, agentRunId: string): void {
  rmSync(join(slotsDir, agentRunId), { force: true });
}

function makeExitRecorder(ctx: WorkerContext): ExitRecorder {
  let recorded = false;
  let wasCancelled = false;
  let workerPid: number | undefined;
  let paneId: string | undefined;
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolvePromise) => { resolveCancelled = resolvePromise; });
  const cleanups: Array<() => void> = [];

  const unregister = (): void => {
    while (cleanups.length > 0) cleanups.pop()?.();
  };

  const finish = (event: string, kvs: string[]): void => {
    if (recorded) return;
    recorded = true;
    ctx.appendLedger(ctx.runId, event, 'task_id', ctx.taskId, 'vendor', ctx.vendor, ...kvs);
    releaseSlot(ctx.slotsDir, ctx.agentRunId);
    unregister();
  };

  const cancel = (): void => {
    if (recorded) return;
    wasCancelled = true;
    if (workerPid !== undefined) ctx.killTree(workerPid);
    if (paneId && ctx.env.HYDRA_HERDR_KEEP_PANE !== '1') ctx.herdr.paneClose(paneId);
    finish('agent_cancelled', []);
    resolveCancelled();
  };

  return {
    cancelled,
    isRecorded: () => recorded,
    isCancelled: () => wasCancelled,
    setWorkerPid: (pid) => { workerPid = pid; },
    setPaneId: (id) => { paneId = id; },
    recordExit: (event, rc) => finish(event, rc === undefined ? [] : ['exit_code', rc]),
    recordTimeout: (reason, metric) => {
      const extra = ['reason', reason];
      if (metric) extra.push(metric[0], metric[1]);
      finish('agent_timed_out', extra);
    },
    cancel,
    register: (signal, noSignals) => {
      if (signal) {
        const onAbort = (): void => cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', onAbort));
        if (signal.aborted) cancel();
      }
      if (!noSignals) {
        const onSignal = (): void => {
          cancel();
          warn('dispatch cancelled — agent_cancelled recorded (no dangling running task)');
          process.exit(130);
        };
        for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
          process.on(name, onSignal);
          cleanups.push(() => process.removeListener(name, onSignal));
        }
      }
    },
    unregister,
  };
}

async function acquireSlot(
  ctx: WorkerContext,
  recorder: ExitRecorder,
  cap: number,
): Promise<boolean> {
  mkdirSync(ctx.slotsDir, { recursive: true });
  let waited = false;
  while (countFilesRecursively(ctx.slotsDir) >= cap) {
    if (!waited) {
      ctx.appendLedger(
        ctx.runId,
        'concurrency_wait',
        'task_id', ctx.taskId,
        'cap', String(cap),
        'active', String(countFilesRecursively(ctx.slotsDir)),
      );
      waited = true;
    }
    const outcome = await Promise.race([
      ctx.clock.sleep(1000).then(() => 'tick' as const),
      recorder.cancelled.then(() => 'cancel' as const),
    ]);
    if (outcome === 'cancel') return false;
  }
  if (recorder.isRecorded()) return false;
  writeFileSync(join(ctx.slotsDir, ctx.agentRunId), '', 'utf8');
  return true;
}

function sessionValue(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function findPriorSession(runId: string, taskId: string, sessionsDir: string): string {
  if (!isDirectory(sessionsDir)) return '';
  const prefix = `${runId}-${taskId}-v`;
  const candidates = readdirSync(sessionsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => {
      const path = join(sessionsDir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return { path, mtime: -1 };
      }
    })
    .filter(({ mtime }) => mtime >= 0)
    .sort((a, b) => b.mtime - a.mtime);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate.path, 'utf8')) as { session_id?: unknown };
      const id = sessionValue(parsed.session_id);
      if (id) return id;
    } catch {
      // jq failures are ignored for individual candidate files by the shell loop.
    }
  }
  return '';
}

function determineDelivery(
  runId: string,
  taskId: string,
  sessionsDir: string,
  adapterPath: string,
  env: NodeJS.ProcessEnv,
): { verb: 'start' | 'resume'; priorSession: string } {
  if (env.HYDRA_DELIVERY !== 'resume') return { verb: 'start', priorSession: '' };
  const priorSession = findPriorSession(runId, taskId, sessionsDir);
  let supportsResume = false;
  try {
    supportsResume = readFileSync(adapterPath, 'utf8').includes('start|resume');
  } catch {
    // The adapter existence gate already ran; treat a later read failure as no resume support.
  }
  if (priorSession && supportsResume) return { verb: 'resume', priorSession };
  warn('resume requested but unavailable (no session / adapter lacks resume) — cold restart');
  return { verb: 'start', priorSession };
}

function activitySignature(paths: string[]): string {
  const values: Array<{ path: string; size: number }> = [];
  for (const path of paths) {
    try {
      const info = statSync(path);
      if (info.isFile()) values.push({ path, size: info.size });
    } catch {
      // Missing capture files produce no wc output in the Bash implementation.
    }
  }
  if (values.length === 0) return '';
  if (values.length === 1) return `${values[0].size} ${values[0].path}`;
  return `${values.reduce((total, value) => total + value.size, 0)} total`;
}

function plainActivity(sessionsDir: string, agentRunId: string): string {
  if (!isDirectory(sessionsDir)) return '';
  const prefix = `${agentRunId}.`;
  return activitySignature(
    readdirSync(sessionsDir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(sessionsDir, name)),
  );
}

function herdrActivity(sessionsDir: string, agentRunId: string): string {
  return activitySignature([
    join(sessionsDir, `${agentRunId}.cli.jsonl`),
    join(sessionsDir, `${agentRunId}.stderr`),
  ]);
}

function signalExitCode(signal: NodeJS.Signals | null): string {
  const signalNumbers = constants.signals as Partial<Record<NodeJS.Signals, number>>;
  const number = signal ? signalNumbers[signal] : undefined;
  return number === undefined ? '130' : String(128 + number);
}

async function runWorkerPlain(ctx: WorkerContext, recorder: ExitRecorder): Promise<void> {
  const child = ctx.spawn(ctx.adapterPath, [
    ctx.verb,
    ctx.taskSpecPath,
    ctx.worktree,
    ctx.inbox,
    ctx.sessionsDir,
    ctx.agentRunId,
    ctx.priorSession,
  ], {
    detached: false,
    stdio: 'ignore',
    cwd: ctx.cwd,
    env: ctx.env,
  });
  if (child.pid === undefined) throw new Error('spawned worker has no pid');
  const workerPid = child.pid;
  recorder.setWorkerPid(workerPid);

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const exitedPromise = new Promise<void>((resolveExit) => {
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      resolveExit();
    });
    child.on('error', () => {
      exited = true;
      exitCode = 127;
      resolveExit();
    });
  });

  const limit = ctx.timeoutMinutes * 60_000;
  const hardCap = Number(ctx.env.HYDRA_HARD_CAP_MIN || ctx.timeoutMinutes * 6) * 60_000;
  let waited = 0;
  let elapsed = 0;
  let previousActivity = '';
  let timeout: 'stalled' | 'hard_cap' | undefined;

  while (!exited && !recorder.isRecorded()) {
    if (waited >= limit) {
      timeout = 'stalled';
      break;
    }
    if (elapsed >= hardCap) {
      timeout = 'hard_cap';
      break;
    }
    const outcome = await Promise.race([
      exitedPromise.then(() => 'exit' as const),
      recorder.cancelled.then(() => 'cancel' as const),
      ctx.clock.sleep(ctx.pollIntervalMs).then(() => 'tick' as const),
    ]);
    if (outcome !== 'tick') break;
    waited += ctx.pollIntervalMs;
    elapsed += ctx.pollIntervalMs;
    const activity = plainActivity(ctx.sessionsDir, ctx.agentRunId);
    if (activity !== previousActivity) {
      previousActivity = activity;
      waited = 0;
    }
  }

  if (recorder.isRecorded()) return;
  if (timeout) {
    ctx.killTree(workerPid);
    recorder.recordTimeout(timeout);
    return;
  }
  recorder.recordExit('agent_exited', exitSignal ? signalExitCode(exitSignal) : String(exitCode ?? 0));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runWorkerInHerdrPane(ctx: WorkerContext, recorder: ExitRecorder): Promise<boolean> {
  const sentinel = join(ctx.sessionsDir, `${ctx.agentRunId}.exit`);
  const pidfile = join(ctx.sessionsDir, `${ctx.agentRunId}.pid`);
  rmSync(sentinel, { force: true });
  rmSync(pidfile, { force: true });

  const workspace = ctx.herdr.focusedWorkspace();
  const label = `hydra:${ctx.runId}:${ctx.taskId}:${ctx.vendor}`;
  const adapterArgs = [
    ctx.adapterPath,
    ctx.verb,
    ctx.taskSpecPath,
    ctx.worktree,
    ctx.inbox,
    ctx.sessionsDir,
    ctx.agentRunId,
    ctx.priorSession,
  ].map(shellQuote).join(' ');
  const inner = `echo $$ > ${shellQuote(pidfile)}; ${adapterArgs}; printf '%s' $? > ${shellQuote(sentinel)}`;
  const paneId = ctx.herdr.agentStart({ label, cwd: ctx.worktree, workspace, command: inner });
  if (!paneId) return false;

  recorder.setPaneId(paneId);
  ctx.appendLedger(
    ctx.runId,
    'herdr_pane_started',
    'task_id', ctx.taskId,
    'vendor', ctx.vendor,
    'label', label,
    'pane', paneId,
  );
  log(`worker hosted in herdr pane ${paneId}: ${label} (lead workspace ${workspace ?? '?'})`);
  try { ctx.herdrState(paneId, ctx.vendor, 'working'); } catch { /* best effort */ }

  const closePane = (): void => {
    try { ctx.herdrState(paneId, ctx.vendor, 'idle'); } catch { /* best effort */ }
    if (ctx.env.HYDRA_HERDR_KEEP_PANE === '1') {
      log(`keeping herdr pane ${paneId} (state=idle)`);
      return;
    }
    if (ctx.herdr.paneClose(paneId)) log(`closed herdr pane ${paneId} (${label})`);
  };

  const limit = ctx.timeoutMinutes * 60_000;
  const hardCap = Number(ctx.env.HYDRA_HARD_CAP_MIN || ctx.timeoutMinutes * 6) * 60_000;
  let waited = 0;
  let elapsed = 0;
  let previousActivity = '';

  while (
    !existsSync(sentinel) &&
    waited < limit &&
    elapsed < hardCap &&
    !recorder.isRecorded()
  ) {
    const outcome = await Promise.race([
      recorder.cancelled.then(() => 'cancel' as const),
      ctx.clock.sleep(ctx.pollIntervalMs).then(() => 'tick' as const),
    ]);
    if (outcome === 'cancel') return true;
    waited += ctx.pollIntervalMs;
    elapsed += ctx.pollIntervalMs;
    const activity = herdrActivity(ctx.sessionsDir, ctx.agentRunId);
    if (activity !== previousActivity) {
      previousActivity = activity;
      waited = 0;
    }
  }

  if (recorder.isRecorded()) return true;
  if (!existsSync(sentinel)) {
    if (isFile(pidfile)) {
      const pid = Number(readFileSync(pidfile, 'utf8').trim());
      if (pid) ctx.killTree(pid);
    }
    if (elapsed >= hardCap) {
      recorder.recordTimeout('hard_cap', ['elapsed_sec', String(Math.floor(elapsed / 1000))]);
    } else {
      recorder.recordTimeout('stalled', ['idle_sec', String(Math.floor(waited / 1000))]);
    }
    closePane();
    return true;
  }

  recorder.recordExit('agent_exited', readFileSync(sentinel, 'utf8').trim());
  closePane();
  return true;
}

function safeRecordUsage(ctx: WorkerContext): void {
  try {
    ctx.recordUsage(ctx.runId, ctx.taskId, ctx.vendor, ctx.agentRunId);
  } catch {
    // record-usage.sh is explicitly best effort in dispatch.sh.
  }
}

async function runWorker(ctx: WorkerContext, recorder: ExitRecorder): Promise<void> {
  if (ctx.env.HYDRA_HERDR_PANES === '1' && ctx.herdr.isLive()) {
    const hosted = await runWorkerInHerdrPane(ctx, recorder);
    if (hosted) {
      if (!recorder.isCancelled()) safeRecordUsage(ctx);
      return;
    }
    warn('herdr pane launch failed — falling back to a plain subprocess');
  }
  await runWorkerPlain(ctx, recorder);
  if (!recorder.isCancelled()) safeRecordUsage(ctx);
}

export async function dispatch(
  runId: string,
  taskId: string,
  options: DispatchOptions = {},
): Promise<DispatchHandle> {
  if (!runId || !taskId) die('usage: dispatch <run_id> <task_id> [--background]');

  const cwd = options.cwd ?? process.cwd();
  const root = options.stateRoot ? resolve(cwd, options.stateRoot) : stateRoot();
  const runPath = join(root, 'runs', `run-${runId}`);
  const taskSpecPath = join(runPath, 'tasks', `${taskId}.yaml`);
  const spec = readTaskSpec(taskSpecPath);
  const repo = discoverRepoRoot(options, cwd);
  const adapterPath = join(repo, 'hydra', 'adapters', `${spec.vendor}.sh`);
  if (!isFile(adapterPath)) die(`no adapter for vendor '${spec.vendor}': ${adapterPath}`);

  const resolvedWorktree = spec.worktree ? resolve(cwd, spec.worktree) : '';
  if (!resolvedWorktree || !isDirectory(resolvedWorktree)) {
    die(`worktree not created yet (run create-worktree.sh): ${spec.worktree}`);
  }

  const agentRunId = `${runId}-${taskId}-v${spec.specVersion}`;
  const inbox = join(runPath, 'inbox', agentRunId);
  const sessionsDir = join(runPath, 'sessions');
  const slotsDir = join(runPath, '.slots');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  const env = options.env ?? process.env;
  const delivery = determineDelivery(runId, taskId, sessionsDir, adapterPath, env);
  const ledgerPath = join(runPath, 'authoritative', 'ledger', 'events.jsonl');
  const appendLedger: LedgerAppender = (id, event, ...kvs) => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const entry: Record<string, string> = { time: now(), event, run_id: id };
    for (let index = 0; index + 1 < kvs.length; index += 2) entry[kvs[index]] = kvs[index + 1];
    appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  };

  appendLedger(
    runId,
    'task_started',
    'task_id', taskId,
    'vendor', spec.vendor,
    'agent_run_id', agentRunId,
    'delivery', env.HYDRA_DELIVERY || 'start',
  );

  const baseRecordUsage = options.recordUsage ?? recordUsage;
  const recordUsageForRoot = (r: string, t: string, v: string, a: string): void => {
    if (!options.stateRoot || options.recordUsage) {
      baseRecordUsage(r, t, v, a);
      return;
    }
    const previous = process.env.HYDRA_STATE_ROOT;
    process.env.HYDRA_STATE_ROOT = root;
    try {
      baseRecordUsage(r, t, v, a);
    } finally {
      if (previous === undefined) delete process.env.HYDRA_STATE_ROOT;
      else process.env.HYDRA_STATE_ROOT = previous;
    }
  };

  const commandRunner = options.execFileSync ?? defaultExecFileSync;
  const ctx: WorkerContext = {
    runId,
    taskId,
    vendor: spec.vendor,
    agentRunId,
    worktree: spec.worktree,
    inbox,
    sessionsDir,
    slotsDir,
    taskSpecPath,
    adapterPath,
    verb: delivery.verb,
    priorSession: delivery.priorSession,
    timeoutMinutes: spec.timeoutMinutes,
    cwd,
    env,
    clock: options.clock ?? realClock,
    pollIntervalMs: options.pollIntervalMs ?? 2000,
    spawn: options.spawn ?? defaultSpawn,
    herdr: options.herdr ?? new RealHerdrClient(commandRunner),
    herdrState: options.herdrState ?? herdrState,
    killTree: options.killTree ?? killTree,
    recordUsage: recordUsageForRoot,
    appendLedger,
  };
  const recorder = makeExitRecorder(ctx);
  recorder.register(options.signal, options.noSignals);

  const releaseOnExit = (): void => releaseSlot(slotsDir, agentRunId);
  process.once('exit', releaseOnExit);

  try {
    const acquired = await acquireSlot(ctx, recorder, computeConcurrencyCap(options, env));
    const rawWork = acquired && !recorder.isRecorded() ? runWorker(ctx, recorder) : Promise.resolve();
    const work = rawWork.finally(() => {
      recorder.unregister();
      process.removeListener('exit', releaseOnExit);
      releaseSlot(slotsDir, agentRunId);
    });
    const finished = options.background
      ? work.catch((error) => {
          recorder.cancel();
          warn(error instanceof Error ? error.message : String(error));
        })
      : work;

    if (!options.background) {
      try {
        await finished;
      } catch (error) {
        recorder.cancel();
        throw error;
      }
    }
    process.stdout.write(`${agentRunId}\n`);
    return { agentRunId, finished };
  } catch (error) {
    process.removeListener('exit', releaseOnExit);
    recorder.unregister();
    releaseSlot(slotsDir, agentRunId);
    if (!recorder.isRecorded()) recorder.cancel();
    throw error;
  }
}

export default { dispatch };

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  dispatch(process.argv[2] ?? '', process.argv[3] ?? '', {
    background: process.argv[4] === '--background',
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
