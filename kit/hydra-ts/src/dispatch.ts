import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { constants, cpus } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorkerPrompt } from './build-worker-prompt.ts';
import { type LedgerEntry } from './current-attempt.ts';
import {
  codexEventText,
  die,
  herdrState,
  killTree,
  kimiEventText,
  log,
  now,
  pollJsonlFile,
  stateRoot,
  type JsonlTailState,
  warn,
  yamlScalar,
} from './lib.ts';
import { recordUsage } from './record-usage.ts';
import {
  createLoopDetectorState,
  loopDetectorTick,
  type LoopDetectorState,
} from './loop-detector.ts';

export type ExecFileSyncLike = (
  file: string,
  args: string[],
  options?: { encoding?: string; cwd?: string; stdio?: unknown; env?: NodeJS.ProcessEnv },
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
  paneClose(paneId: string): boolean | Promise<boolean>;
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
  adapterRuntime?: 'bash' | 'ts';
  /** Override directory for TypeScript adapters (used by tests). */
  tsAdapterDir?: string;
  /** Override directory for Bash adapters (used by tests). */
  bashAdapterDir?: string;
  nodeExecutable?: string;
  execFileSync?: ExecFileSyncLike;
  spawn?: SpawnLike;
  herdr?: HerdrClient;
  herdrState?: (paneId: string, vendor: string, state: string) => void;
  killTree?: (pid: number) => void;
  recordUsage?: (runId: string, taskId: string, vendor: string, agentRunId: string) => void;
  buildWorkerPrompt?: (taskSpecPath: string) => string;
  processAlive?: (pid: number) => boolean;
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

const defaultProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

function readPidfile(path: string): number | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim();
    const pid = text ? Number(text) : NaN;
    return Number.isNaN(pid) || pid <= 0 ? undefined : pid;
  } catch {
    return undefined;
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
    die(`not inside a git repository (cwd: ${cwd}) — hydra resolves its state dir from the repo root; cd into the target repo (or one of its worktrees) and re-run`);
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
  recordExit(event: string, rc?: string, ...extraKvs: string[]): void;
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
  dispatchInstanceId: string;
  worktree: string;
  inbox: string;
  sessionsDir: string;
  slotsDir: string;
  taskSpecPath: string;
  adapterPath: string;
  adapterRuntime: 'bash' | 'ts';
  nodeExecutable: string;
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
  buildWorkerPrompt: (taskSpecPath: string) => string;
  processAlive: (pid: number) => boolean;
  appendLedger: LedgerAppender;
  readLedger: () => LedgerEntry[];
  loopDetectorState: LoopDetectorState;
  execFileSync: ExecFileSyncLike;
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
  const sentinel = join(ctx.sessionsDir, `${ctx.agentRunId}.exit`);
  rmSync(sentinel, { force: true });

  const unregister = (): void => {
    while (cleanups.length > 0) cleanups.pop()?.();
  };

  const finish = (event: string, kvs: string[], exitCode: string): void => {
    if (recorded) return;
    recorded = true;
    ctx.appendLedger(ctx.runId, event, 'task_id', ctx.taskId, 'vendor', ctx.vendor, ...kvs);
    try { writeFileSync(sentinel, exitCode, 'utf8'); } catch { /* ledger and slot cleanup remain authoritative */ }
    releaseSlot(ctx.slotsDir, ctx.agentRunId);
    unregister();
  };

  const cancel = (): void => {
    if (recorded) return;
    wasCancelled = true;
    if (workerPid !== undefined) {
      try { ctx.killTree(workerPid); } catch { /* best effort */ }
    }
    finish('agent_cancelled', [], '130');
    resolveCancelled();
    if (paneId && ctx.env.HYDRA_HERDR_KEEP_PANE !== '1') {
      try {
        void Promise.resolve(ctx.herdr.paneClose(paneId)).catch(() => undefined);
      } catch {
        // Pane cleanup is best effort and always follows the ledger write.
      }
    }
  };

  return {
    cancelled,
    isRecorded: () => recorded,
    isCancelled: () => wasCancelled,
    setWorkerPid: (pid) => { workerPid = pid; },
    setPaneId: (id) => { paneId = id; },
    recordExit: (event, rc, ...extraKvs) => finish(
      event,
      rc === undefined ? extraKvs : ['exit_code', rc, ...extraKvs],
      rc ?? '0',
    ),
    recordTimeout: (reason, metric) => {
      const extra = ['reason', reason];
      if (metric) extra.push(metric[0], metric[1]);
      finish('agent_timed_out', extra, '124');
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
    const source = readFileSync(adapterPath, 'utf8');
    if (extname(adapterPath) === '.ts') {
      supportsResume = /^\s*export\s+(?:(?:async\s+)?function|(?:const|let|var))\s+resume\b/m.test(source)
        || /^\s*export\s*\{[^}]*\bresume\b[^}]*\}/m.test(source);
    } else {
      supportsResume = source.includes('start|resume');
    }
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

function dispatchPidfilePath(sessionsDir: string, agentRunId: string): string {
  return join(sessionsDir, 'supervisor', `${agentRunId}.dispatch.pid`);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } finally {
    // Remove the temp file even if the rename fails (full disk, permissions,
    // cross-device state root) so no orphan accumulates.
    rmSync(tmp, { force: true });
  }
}

function removeDispatchPidfile(path: string): void {
  rmSync(path, { force: true });
}

function signalExitCode(signal: NodeJS.Signals | null): string {
  const signalNumbers = constants.signals as Partial<Record<NodeJS.Signals, number>>;
  const number = signal ? signalNumbers[signal] : undefined;
  return number === undefined ? '130' : String(128 + number);
}

interface WorkerMonitor {
  poll(final?: boolean): boolean;
  close(): Promise<void>;
}

function runDetectorTick(ctx: WorkerContext, recorder: ExitRecorder): boolean {
  if (ctx.env.HYDRA_LOOP_DETECTOR === '0') return false;
  if (recorder.isRecorded()) return false;
  try {
    const { result } = loopDetectorTick(ctx.loopDetectorState, {
      runId: ctx.runId,
      taskId: ctx.taskId,
      worktree: resolve(ctx.cwd, ctx.worktree),
      sessionsDir: ctx.sessionsDir,
      agentRunId: ctx.agentRunId,
      vendor: ctx.vendor,
      dispatchInstanceId: ctx.dispatchInstanceId,
      pollIntervalMs: ctx.pollIntervalMs,
      clock: ctx.clock,
      appendLedger: (event, ...kvs) => ctx.appendLedger(ctx.runId, event, 'task_id', ctx.taskId, 'vendor', ctx.vendor, 'agent_run_id', ctx.agentRunId, ...kvs),
      readLedger: ctx.readLedger,
      execGit: ctx.execFileSync,
      env: ctx.env,
    });
    if (result.verdict === 'confirmed') {
      recorder.cancel();
      return true;
    }
    return false;
  } catch (error) {
    // Detector/parser/Git failures must fail open and never block worker exit.
    warn(`loop detector tick failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function safeHerdrLive(herdr: HerdrClient): boolean {
  try {
    return herdr.isLive();
  } catch {
    return false;
  }
}

function vendorLabel(vendor: string): string {
  switch (vendor) {
    case 'codex': return 'Codex';
    case 'claude': return 'Claude';
    case 'kimi': return 'Kimi';
    case 'opencode': return 'OpenCode';
    default: return vendor;
  }
}

function buildPaneBanner(ctx: WorkerContext, label: string): string {
  let prompt: string;
  try {
    prompt = ctx.buildWorkerPrompt(ctx.taskSpecPath);
  } catch {
    prompt = '(prompt unavailable)\n';
  }
  return [
    `${label} starting — run ${ctx.runId} task ${ctx.taskId}`,
    `worktree: ${ctx.worktree}`,
    '--- prompt ---',
    prompt.replace(/\n$/, ''),
    '--------------',
    '',
    '',
  ].join('\n');
}

function writePaneBanner(ctx: WorkerContext, label: string): string {
  const bannerPath = join(ctx.sessionsDir, `${ctx.agentRunId}.pane-banner.txt`);
  try {
    writeFileSync(bannerPath, buildPaneBanner(ctx, label), 'utf8');
  } catch {
    // Best effort — the pane command uses `cat ... 2>/dev/null`.
  }
  return bannerPath;
}

export { codexEventText, kimiEventText, type JsonlTailState, pollJsonlFile } from './lib.ts';

function monitorEventText(line: string): string | undefined {
  let event: { part?: { type?: unknown; text?: unknown; tool?: unknown; state?: { title?: unknown } } };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return undefined;
  }
  const part = event.part;
  if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') return part.text;
  if (part?.type !== 'tool') return undefined;
  const tool = typeof part.tool === 'string' && part.tool !== '' ? part.tool : 'tool';
  const title = typeof part.state?.title === 'string' ? part.state.title : '';
  return `\n[tool] ${tool}${title ? `: ${title}` : ''}`;
}

function openOpencodeMonitor(ctx: WorkerContext, workerPid: number): WorkerMonitor | undefined {
  const eventsPath = join(ctx.sessionsDir, `${ctx.agentRunId}.events.jsonl`);
  const outputPath = join(ctx.sessionsDir, `${ctx.agentRunId}.monitor.txt`);
  const model = ctx.env.HYDRA_OPENCODE_MODEL || 'zai-coding-plan/glm-5.2';
  try {
    writeFileSync(outputPath, buildPaneBanner(ctx, `OpenCode (${model})`), 'utf8');
  } catch {
    // Display setup is best effort and must not interrupt worker exit recording.
    return undefined;
  }

  let workspace: string | undefined;
  let paneId: string | undefined;
  const label = `hydra:${ctx.runId}:${ctx.taskId}:${ctx.vendor}`;
  try {
    workspace = ctx.herdr.focusedWorkspace();
    paneId = ctx.herdr.agentStart({
      label,
      cwd: ctx.worktree,
      workspace,
      command: `touch ${shellQuote(outputPath)}; tail -n +1 -f ${shellQuote(outputPath)}`,
    });
  } catch {
    return undefined;
  }
  if (!paneId) return undefined;

  ctx.appendLedger(
    ctx.runId,
    'herdr_pane_started',
    'task_id', ctx.taskId,
    'vendor', ctx.vendor,
    'label', label,
    'pane', paneId,
    'mode', 'monitor_only',
  );
  log(`opencode monitor pane ${paneId}: ${label} (worker pid ${workerPid}, lead workspace ${workspace ?? '?'})`);
  try { ctx.herdrState(paneId, ctx.vendor, 'working'); } catch { /* best effort */ }

  const tailState: JsonlTailState = { offset: 0 };
  let closed = false;
  const poll = (final = false): boolean => {
    let alive = false;
    try { alive = ctx.processAlive(workerPid); } catch { /* treat a failed probe as exited */ }
    pollJsonlFile(eventsPath, outputPath, monitorEventText, tailState, final);
    return alive;
  };

  return {
    poll,
    close: async () => {
      if (closed) return;
      closed = true;
      poll(true);
      try { ctx.herdrState(paneId, ctx.vendor, 'idle'); } catch { /* best effort */ }
      if (ctx.env.HYDRA_HERDR_KEEP_PANE === '1') {
        log(`keeping opencode monitor pane ${paneId} (state=idle)`);
        return;
      }
      try {
        if (await ctx.herdr.paneClose(paneId)) log(`closed opencode monitor pane ${paneId}`);
      } catch {
        // Pane cleanup must never invalidate the already-recorded worker exit.
      }
    },
  };
}

async function runWorkerPlain(
  ctx: WorkerContext,
  recorder: ExitRecorder,
  monitorEnabled = false,
): Promise<void> {
  const adapterArgs = [
    ctx.verb,
    ctx.taskSpecPath,
    ctx.worktree,
    ctx.inbox,
    ctx.sessionsDir,
    ctx.agentRunId,
    ctx.priorSession,
  ];
  const command = ctx.adapterRuntime === 'ts' ? ctx.nodeExecutable : ctx.adapterPath;
  const args = ctx.adapterRuntime === 'ts'
    ? ['--experimental-strip-types', ctx.adapterPath, ...adapterArgs]
    : adapterArgs;
  const child = ctx.spawn(command, args, {
    detached: false,
    stdio: 'ignore',
    cwd: ctx.cwd,
    env: ctx.env,
  });
  if (child.pid === undefined) throw new Error('spawned worker has no pid');
  const workerPid = child.pid;
  recorder.setWorkerPid(workerPid);
  const monitor = monitorEnabled ? openOpencodeMonitor(ctx, workerPid) : undefined;

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

  try {
    const limit = ctx.timeoutMinutes * 60_000;
    const hardCap = Number(ctx.env.HYDRA_HARD_CAP_MIN || ctx.timeoutMinutes * 6) * 60_000;
    let waited = 0;
    let elapsed = 0;
    let previousActivity = '';
    let timeout: 'stalled' | 'hard_cap' | undefined;

    monitor?.poll();
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
      monitor?.poll(outcome === 'exit');
      if (outcome !== 'tick') break;
      waited += ctx.pollIntervalMs;
      elapsed += ctx.pollIntervalMs;
      const activity = plainActivity(ctx.sessionsDir, ctx.agentRunId);
      if (activity !== previousActivity) {
        previousActivity = activity;
        waited = 0;
      }
      if (runDetectorTick(ctx, recorder)) return;
    }

    if (recorder.isRecorded()) return;
    if (timeout) {
      ctx.killTree(workerPid);
      recorder.recordTimeout(timeout);
      return;
    }
    recorder.recordExit('agent_exited', exitSignal ? signalExitCode(exitSignal) : String(exitCode ?? 0));
  } catch (error) {
    recorder.cancel();
    throw error;
  } finally {
    await monitor?.close();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runWorkerInHerdrPane(ctx: WorkerContext, recorder: ExitRecorder): Promise<boolean> {
  const sentinel = join(ctx.sessionsDir, `${ctx.agentRunId}.exit`);
  const pidfile = join(ctx.sessionsDir, `${ctx.agentRunId}.pid`);
  rmSync(sentinel, { force: true });
  rmSync(pidfile, { force: true });

  let workspace: string | undefined;
  try { workspace = ctx.herdr.focusedWorkspace(); } catch { /* launch without workspace affinity */ }
  const label = `hydra:${ctx.runId}:${ctx.taskId}:${ctx.vendor}`;

  const bannerPath = writePaneBanner(ctx, vendorLabel(ctx.vendor));

  const usesLiveProgressPane = ctx.vendor === 'codex' || ctx.vendor === 'kimi';
  const progressPath = join(ctx.sessionsDir, `${ctx.agentRunId}.pane-progress.txt`);
  const cliJsonlPath = join(ctx.sessionsDir, `${ctx.agentRunId}.cli.jsonl`);
  if (usesLiveProgressPane) {
    try { writeFileSync(progressPath, '', 'utf8'); } catch { /* best effort — pane uses touch */ }
  }
  const liveProgressTailState: JsonlTailState = { offset: 0 };
  const parseLiveProgress = ctx.vendor === 'kimi' ? kimiEventText : codexEventText;
  const pollLiveProgress = (final = false): void => {
    if (!usesLiveProgressPane) return;
    pollJsonlFile(cliJsonlPath, progressPath, parseLiveProgress, liveProgressTailState, final);
  };

  const adapterArgs = [
    ...(ctx.adapterRuntime === 'ts' ? [ctx.nodeExecutable, '--experimental-strip-types'] : []),
    ctx.adapterPath,
    ctx.verb,
    ctx.taskSpecPath,
    ctx.worktree,
    ctx.inbox,
    ctx.sessionsDir,
    ctx.agentRunId,
    ctx.priorSession,
  ].map(shellQuote).join(' ');

  let inner: string;
  if (usesLiveProgressPane) {
    inner = [
      `echo $$ > ${shellQuote(pidfile)}`,
      `set +e`,
      `cat ${shellQuote(bannerPath)} 2>/dev/null`,
      `touch ${shellQuote(progressPath)} 2>/dev/null`,
      `tail -n +1 -f ${shellQuote(progressPath)} 2>/dev/null & TPID=$!`,
      `${adapterArgs}`,
      `RC=$?`,
      `kill $TPID 2>/dev/null`,
      `printf '%s' $RC > ${shellQuote(sentinel)}`,
    ].join('; ');
  } else {
    inner = [
      `echo $$ > ${shellQuote(pidfile)}`,
      `cat ${shellQuote(bannerPath)} 2>/dev/null`,
      `${adapterArgs}`,
      `printf '%s' $? > ${shellQuote(sentinel)}`,
    ].join('; ');
  }

  let paneId: string | undefined;
  try {
    paneId = ctx.herdr.agentStart({ label, cwd: ctx.worktree, workspace, command: inner });
  } catch {
    return false;
  }
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

  const closePane = async (): Promise<void> => {
    try { ctx.herdrState(paneId, ctx.vendor, 'idle'); } catch { /* best effort */ }
    if (ctx.env.HYDRA_HERDR_KEEP_PANE === '1') {
      log(`keeping herdr pane ${paneId} (state=idle)`);
      return;
    }
    try {
      if (await ctx.herdr.paneClose(paneId)) log(`closed herdr pane ${paneId} (${label})`);
    } catch {
      // Pane cleanup must never invalidate the already-recorded worker exit.
    }
  };

  const limit = ctx.timeoutMinutes * 60_000;
  const hardCap = Number(ctx.env.HYDRA_HARD_CAP_MIN || ctx.timeoutMinutes * 6) * 60_000;
  let waited = 0;
  let elapsed = 0;
  let previousActivity = '';

  async function workerDisappeared(): Promise<boolean> {
    if (existsSync(sentinel)) return false;
    if (!isFile(pidfile)) return false;
    const pid = readPidfile(pidfile);
    if (!pid) return false;
    let alive = false;
    try { alive = ctx.processAlive(pid); } catch { alive = false; }
    if (alive) return false;
    await Promise.race([ctx.clock.sleep(1000), recorder.cancelled]);
    if (recorder.isRecorded()) return false;
    if (existsSync(sentinel)) return false;
    try { alive = ctx.processAlive(pid); } catch { alive = false; }
    return !alive;
  }

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
    pollLiveProgress();
    const activity = herdrActivity(ctx.sessionsDir, ctx.agentRunId);
    if (activity !== previousActivity) {
      previousActivity = activity;
      waited = 0;
    }
    if (runDetectorTick(ctx, recorder)) return true;
    if (await workerDisappeared()) {
      const pid = readPidfile(pidfile);
      if (pid) ctx.killTree(pid);
      recorder.recordExit('agent_exited', '127', 'reason', 'worker_disappeared');
      await closePane();
      return true;
    }
  }

  pollLiveProgress(true);

  if (recorder.isRecorded()) return true;
  if (!existsSync(sentinel)) {
    const pid = readPidfile(pidfile);
    if (pid) ctx.killTree(pid);
    if (elapsed >= hardCap) {
      recorder.recordTimeout('hard_cap', ['elapsed_sec', String(Math.floor(elapsed / 1000))]);
    } else {
      recorder.recordTimeout('stalled', ['idle_sec', String(Math.floor(waited / 1000))]);
    }
    await closePane();
    return true;
  }

  let exitCode = '0';
  try { exitCode = readFileSync(sentinel, 'utf8').trim(); } catch { /* sentinel exists but unreadable; use conservative fallback */ }
  recorder.recordExit('agent_exited', exitCode);
  await closePane();
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
  const panesEnabled = ctx.env.HYDRA_HERDR_PANES !== '0';
  const herdrLive = panesEnabled && safeHerdrLive(ctx.herdr);
  if (ctx.vendor === 'opencode') {
    await runWorkerPlain(ctx, recorder, herdrLive);
    if (!recorder.isCancelled()) safeRecordUsage(ctx);
    return;
  }
  if (herdrLive) {
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
  const env = options.env ?? process.env;
  const adapterRuntime = (
    options.adapterRuntime
    ?? env.HYDRA_ADAPTER_RUNTIME
    ?? (env.HYDRA_HARNESS === 'bash' ? 'bash' : 'ts')
  ) === 'bash' ? 'bash' : 'ts';
  // Adapters are kit-owned assets: resolve self-relative to this file's own
  // location, not via the target repo root (repo is for git/worktree/state
  // operations on the TARGET project, which is a different concern).
  // Tests may override the adapter directories with fixture locations.
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const defaultTsAdapterDir = selfDir;
  const defaultBashAdapterDir = join(selfDir, '..', '..', 'hydra', 'adapters');
  const tsAdapterDir = options.tsAdapterDir ? resolve(cwd, options.tsAdapterDir) : defaultTsAdapterDir;
  const bashAdapterDir = options.bashAdapterDir ? resolve(cwd, options.bashAdapterDir) : defaultBashAdapterDir;
  const adapterPath = adapterRuntime === 'ts'
    ? join(tsAdapterDir, `adapter-${spec.vendor}.ts`)
    : join(bashAdapterDir, `${spec.vendor}.sh`);
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

  const delivery = determineDelivery(runId, taskId, sessionsDir, adapterPath, env);
  const dispatchInstanceId = randomBytes(8).toString('hex');

  const ledgerPath = join(runPath, 'authoritative', 'ledger', 'events.jsonl');
  const readLedger = (): LedgerEntry[] => {
    try {
      const content = readFileSync(ledgerPath, 'utf8');
      const entries: LedgerEntry[] = [];
      for (const line of content.split('\n')) {
        if (line.trim() === '') continue;
        try {
          entries.push(JSON.parse(line) as LedgerEntry);
        } catch {
          // Ignore malformed or partial lines; the ledger may be mid-write.
        }
      }
      return entries;
    } catch {
      return [];
    }
  };
  const appendLedger: LedgerAppender = (id, event, ...kvs) => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const entry: Record<string, string> = {
      time: now(), event, run_id: id, dispatch_instance_id: dispatchInstanceId,
    };
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
    dispatchInstanceId,
    worktree: spec.worktree,
    inbox,
    sessionsDir,
    slotsDir,
    taskSpecPath,
    adapterPath,
    adapterRuntime,
    nodeExecutable: options.nodeExecutable ?? process.execPath,
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
    buildWorkerPrompt: options.buildWorkerPrompt ?? buildWorkerPrompt,
    processAlive: options.processAlive ?? defaultProcessAlive,
    appendLedger,
    readLedger,
    loopDetectorState: createLoopDetectorState(),
    execFileSync: commandRunner,
  };
  const recorder = makeExitRecorder(ctx);
  recorder.register(options.signal, options.noSignals);

  const dispatchPidfile = dispatchPidfilePath(sessionsDir, agentRunId);
  const releaseOnExit = (): void => {
    removeDispatchPidfile(dispatchPidfile);
    releaseSlot(slotsDir, agentRunId);
  };
  process.once('exit', releaseOnExit);

  try {
    const acquired = await acquireSlot(ctx, recorder, computeConcurrencyCap(options, env));
    if (acquired && !recorder.isRecorded()) {
      writeAtomic(dispatchPidfile, String(process.pid));
      ctx.loopDetectorState.lastGitChangeAt = ctx.clock.now();
    }
    const rawWork = acquired && !recorder.isRecorded() ? runWorker(ctx, recorder) : Promise.resolve();
    const work = rawWork.finally(() => {
      removeDispatchPidfile(dispatchPidfile);
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
    removeDispatchPidfile(dispatchPidfile);
    process.removeListener('exit', releaseOnExit);
    recorder.unregister();
    releaseSlot(slotsDir, agentRunId);
    if (!recorder.isRecorded()) recorder.cancel();
    throw error;
  }
}

export default { dispatch };

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    await dispatch(args[0] ?? '', args[1] ?? '', {
      background: args[2] === '--background',
    });
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await main();
}
