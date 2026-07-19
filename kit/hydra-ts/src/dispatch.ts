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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorkerPrompt } from './build-worker-prompt.ts';
import { type LedgerEntry } from './current-attempt.ts';
import { eligible } from './allocate.ts';
import {
  KNOWN_HEADS,
  availableHeadNames,
  headsFilePath,
  probeHeads,
  readHeadsFile,
  type DetectHeadsOptions,
  type HeadsSnapshot,
  type KnownHead,
} from './detect-heads.ts';
import {
  codexEventText,
  die,
  herdrState,
  herdrWorkspacePinEnabled,
  killTree,
  kimiEventText,
  log,
  now,
  pinnedHerdrWorkspace,
  pollJsonlFile,
  setPinnedHerdrWorkspace,
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
import { isCompiledBinary } from './kit-assets.ts';
import { resolveWorkerNodeBinDir } from './resolve-node.ts';

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
  /** Best-effort pane sizing (issue #18); optional so existing mocks stay valid. */
  paneResize?(paneId: string, direction: 'left' | 'right' | 'up' | 'down', amount: number): boolean | Promise<boolean>;
}

/**
 * Agent-pane height ratio relative to the lead console (issue #18). Agent
 * panes are split `down` from the lead console, so after `agent start` the
 * pane is shrunk with `herdr pane resize --direction down --amount <ratio>`
 * (resize adjusts the parent split's ratio; down moves the divider toward the
 * agent pane, shrinking it). HYDRA_HERDR_PANE_RATIO overrides the default
 * 0.25 (agent ~= 25% of the height, lead console >= 60%); anything that is
 * not a finite number strictly between 0 and 1 falls back to the default.
 */
export function herdrAgentPaneRatio(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0.25;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return 0.25;
  return parsed;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Adapter runtime. The shell-adapter lane ('bash') was retired in run 0045
 * (docs/bash-lane-retirement-plan.md): requesting it now fails loudly rather
 * than coercing to 'ts'. The two live runtimes are:
 *   - 'ts'        — runs `adapter-<vendor>.ts` through a Node interpreter;
 *   - 'compiled'  — self-reexecs this process's own executable through
 *     cli.ts's `adapter-<vendor>` route. 'compiled' is the ONLY runtime
 *     available inside a `bun build --compile` binary: there is no Node
 *     interpreter to spawn and no adapter .ts file to point one at (Stage 4
 *     review bug #1, docs/bun-migration-stage4-fixes-runtime.md). The
 *     no-Node rollback is a pinned compiled binary selected by the wrapper
 *     launcher via HYDRA_HARNESS=bin / HYDRA_BIN, not an adapter runtime.
 */
export type AdapterRuntime = 'ts' | 'compiled';

/**
 * Static adapter capability registry for the 'compiled' runtime. A compiled
 * binary cannot stat or read an adapter source file, so vendor validity and
 * resume capability are compile-time constants. The key set mirrors cli.ts's
 * `adapter-<vendor>` routes 1:1 (docs/bun-migration-stage1-cli.md);
 * `resume` mirrors each adapter's verb parser (adapter-claude/adapter-kimi/
 * adapter-stub implement start|resume; adapter-codex/adapter-opencode do
 * not). Keep in sync with the routing table and the adapters.
 */
export const COMPILED_ADAPTERS: Readonly<Record<string, { resume: boolean }>> = {
  claude: { resume: true },
  codex: { resume: false },
  kimi: { resume: true },
  opencode: { resume: false },
  stub: { resume: true },
};

/**
 * Resolve the adapter runtime from the option/env overrides and the current
 * process shape. Precedence:
 *   1. 'bash' is a RETIRED value (run 0045): whether it arrives via the
 *      adapter-runtime override or HYDRA_HARNESS, it fails loudly with a
 *      retirement error and does NOT coerce to 'ts' — including inside a
 *      compiled binary, where it previously won over the compiled runtime.
 *      Any other unrecognized non-empty override value is likewise rejected
 *      (accepted override values are exactly 'ts' and 'compiled'); an empty
 *      override string is treated as unset.
 *   2. a real compiled binary (`compiled`) or an explicit 'compiled'
 *      override selects the self-reexec runtime — inside a compiled binary
 *      'ts' can never work, regardless of HYDRA_HARNESS/HYDRA_ADAPTER_RUNTIME;
 *   3. otherwise the runtime is 'ts' (the source default; HYDRA_HARNESS=bin
 *      is resolved by the wrapper launcher before dispatch runs, so a non-
 *      compiled process always takes the 'ts' adapter path).
 */
export function resolveAdapterRuntime(
  override: string | undefined,
  harness: string | undefined,
  compiled: boolean,
): AdapterRuntime {
  if (override === 'bash' || harness === 'bash') {
    die(
      "HYDRA_ADAPTER_RUNTIME=bash / HYDRA_HARNESS=bash was retired (run 0045); the shell adapter lane has been removed. "
        + "Use 'ts' (the default); for a no-Node rollback use HYDRA_HARNESS=bin with a pinned HYDRA_BIN "
        + "(~/.local/share/hydra-pinned-binaries/v1/hydra-cli-v1-darwin-arm64). It does not silently coerce to 'ts'.",
    );
  }
  if (override !== undefined && override !== '' && override !== 'ts' && override !== 'compiled') {
    die(
      `unrecognized HYDRA_ADAPTER_RUNTIME='${override}': accepted values are 'ts' (default) and 'compiled'; 'bash' was retired (run 0045). `
        + "For the no-Node rollback use HYDRA_HARNESS=bin with a pinned HYDRA_BIN.",
    );
  }
  if (override === 'compiled' || compiled) return 'compiled';
  return 'ts';
}

export interface DispatchOptions {
  cwd?: string;
  stateRoot?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  adapterRuntime?: AdapterRuntime;
  /** Override directory for TypeScript adapters (used by tests). */
  tsAdapterDir?: string;
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
  /** Injectable HYDRA_NODE_BIN resolver (used by tests). */
  resolveNodeBinDir?: () => string;
  /** Injectable head availability probe for the assigned-vendor gate (used by tests). */
  probeHeads?: (options?: DetectHeadsOptions) => HeadsSnapshot;
  /** Override path to heads.json for the opencode_model stale-list check (used by tests). */
  headsFile?: string;
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
      // Strip BUN_BE_BUN from herdr children: herdr is hydra's own tooling and
      // a leaked BUN_BE_BUN=1 hijacks Bun-compiled binaries (spike:
      // docs/bun-migration-spike-results.md); Bun omits undefined env keys.
      this.run('herdr', ['status'], {
        encoding: 'utf8',
        stdio: 'ignore',
        env: { ...process.env, BUN_BE_BUN: undefined },
      });
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
        env: { ...process.env, BUN_BE_BUN: undefined },
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
        env: { ...process.env, BUN_BE_BUN: undefined },
      }));
      const parsed = JSON.parse(output) as { result?: { agent?: { pane_id?: string } } };
      return parsed.result?.agent?.pane_id;
    } catch {
      return undefined;
    }
  }

  paneClose(paneId: string): boolean {
    try {
      this.run('herdr', ['pane', 'close', paneId], {
        encoding: 'utf8',
        stdio: 'ignore',
        env: { ...process.env, BUN_BE_BUN: undefined },
      });
      return true;
    } catch {
      return false;
    }
  }

  paneResize(paneId: string, direction: 'left' | 'right' | 'up' | 'down', amount: number): boolean {
    try {
      this.run('herdr', ['pane', 'resize', '--direction', direction, '--amount', String(amount), '--pane', paneId], {
        encoding: 'utf8',
        stdio: 'ignore',
        env: { ...process.env, BUN_BE_BUN: undefined },
      });
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

/**
 * Vendor-head availability gate (run 0047): when the task spec's
 * assigned_vendor CLI is not on PATH at dispatch time, die with a
 * fail-with-suggestions message naming the heads that ARE available and the
 * best eligible substitute for the role (allocate's eligible() ordering).
 * Hydra NEVER auto-substitutes — re-pinning is a human decision.
 *
 * The gate covers exactly the detected head set (claude/codex/opencode/kimi);
 * test adapters like 'stub' bypass it. It fails open when the probe itself
 * errors so detection trouble can never wedge dispatch; a probe that answers
 * "not on PATH" fails closed for exactly that vendor, which is the signal
 * this gate exists for.
 */
function enforceHeadAvailability(spec: TaskSpec, taskSpecPath: string, options: DispatchOptions): void {
  if (!(KNOWN_HEADS as readonly string[]).includes(spec.vendor)) return;

  const probe = options.probeHeads ?? (() => probeHeads());
  let snapshot: HeadsSnapshot | null = null;
  try {
    snapshot = probe();
  } catch (error) {
    warn(`head availability probe failed; skipping the gate: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const head = snapshot.heads[spec.vendor as KnownHead];
  if (head.available) return;

  const role = yamlScalar(taskSpecPath, 'role') || 'implementer';
  const available = availableHeadNames(snapshot);
  const substitute = eligible(role).find(
    (vendor) => vendor !== spec.vendor
      && snapshot.heads[vendor as KnownHead]?.available === true,
  ) ?? null;
  die(
    `assigned vendor '${spec.vendor}' is not on PATH at dispatch time. `
      + `Available heads: ${available.length > 0 ? available.join(', ') : 'none'}. `
      + `Best eligible substitute for role '${role}': ${substitute ?? 'none'}. `
      + `Re-pin assigned_vendor in the task spec or install the ${spec.vendor} CLI, then re-dispatch — hydra never auto-substitutes.`,
  );
}

/**
 * Task-spec opencode_model pin (run 0047): dispatch reads the pin and the
 * opencode adapter receives it through the spec file itself (adapter-opencode
 * resolveModel gives it precedence over HYDRA_OPENCODE_MODEL). When the pin
 * is absent from the detected opencode model list in heads.json, warn but
 * proceed — the snapshot may simply be stale.
 */
function warnOnStaleOpencodeModelPin(spec: TaskSpec, taskSpecPath: string, options: DispatchOptions): void {
  if (spec.vendor !== 'opencode') return;
  const pinnedModel = yamlScalar(taskSpecPath, 'opencode_model');
  if (!pinnedModel) return;
  const headsFile = options.headsFile ?? headsFilePath();
  const models: unknown = readHeadsFile(headsFile)?.heads.opencode.models;
  if (Array.isArray(models) && models.length > 0 && !models.includes(pinnedModel)) {
    warn(`opencode_model '${pinnedModel}' is not in the detected opencode model list (${models.length} models in ${headsFile}); proceeding anyway`);
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
  runYamlPath: string;
  adapterPath: string;
  adapterRuntime: AdapterRuntime;
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
  adapter: { vendor: string; path: string; runtime: AdapterRuntime },
  env: NodeJS.ProcessEnv,
  timeoutMinutes: number,
): { verb: 'start' | 'resume'; priorSession: string } {
  if (env.HYDRA_DELIVERY !== 'resume') return { verb: 'start', priorSession: '' };
  const priorSession = findPriorSession(runId, taskId, sessionsDir);
  let supportsResume = false;
  if (adapter.runtime === 'compiled') {
    // There is no adapter source file to inspect inside a compiled binary;
    // resume capability is a compile-time constant (see COMPILED_ADAPTERS).
    supportsResume = COMPILED_ADAPTERS[adapter.vendor]?.resume ?? false;
  } else {
    try {
      const source = readFileSync(adapter.path, 'utf8');
      // The shell-adapter lane was retired (run 0045); the only non-compiled
      // runtime is 'ts', whose adapter source is always a .ts file. Resume
      // support is detected from its exported start|resume surface.
      supportsResume = /^\s*export\s+(?:(?:async\s+)?function|(?:const|let|var))\s+resume\b/m.test(source)
        || /^\s*export\s*\{[^}]*\bresume\b[^}]*\}/m.test(source);
    } catch {
      // The adapter existence gate already ran; treat a later read failure as no resume support.
    }
  }
  if (priorSession && supportsResume) return { verb: 'resume', priorSession };
  // Issue #20 (run 0052): when an operator amends a task with delivery=resume
  // but the cold-restart fallback fires, the SINGLE generic warn() line below
  // used to be easy to miss in a scrolling pane, and gave no indication of the
  // cost about to be incurred. The two distinct reasons for the fallback now
  // get distinct, loud, specific messages — both make plain that a FULL re-run
  // (not a quick incremental continuation) is about to start in the same
  // worktree. The dispatch BEHAVIOR (verb='start', priorSession preserved) is
  // unchanged; this is a message-clarity fix only.
  const timeoutHint = ` A FULL COLD RESTART of the task will now run from scratch in the same worktree — this is NOT a quick incremental continuation or verification pass; expect time and cost comparable to the original dispatch (task timeout_minutes=${timeoutMinutes}).`;
  if (!priorSession) {
    warn(
      `HYDRA_DELIVERY=resume was requested for ${adapter.vendor} task '${taskId}', but NO PRIOR SESSION was found for this task under ${sessionsDir} (the session file may be missing, e.g. the prior run was cleaned up or never wrote one).`
      + timeoutHint,
    );
  } else {
    warn(
      `HYDRA_DELIVERY=resume was requested for ${adapter.vendor} task '${taskId}', but the ${adapter.vendor} ADAPTER HAS NO REAL RESUME SUPPORT — the prior session was found but this vendor's adapter cannot consume it.`
      + timeoutHint,
    );
  }
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

/**
 * Resolve the lead's herdr workspace id for a pane spawn within this run
 * (issue #19). The persisted workspace id is read from run.yaml FIRST; only
 * when no value has been persisted yet (or the pin is disabled, or run.yaml
 * is missing/corrupt) does this fall back to a live focusedWorkspace() query
 * — the live query itself is skipped entirely once a pin exists, so a later
 * pane spawn does not shell out to "what is focused right now" even if the
 * operator has since moved macOS Spaces/terminal tabs. The FIRST successful
 * live query in a run is persisted into run.yaml; subsequent spawns reuse
 * it. HYDRA_HERDR_WORKSPACE_PIN=0 disables the pin and restores the legacy
 * always-live-query behavior. All persistence errors degrade safely to a
 * live query and never throw or block a dispatch.
 */
function resolvePaneWorkspace(ctx: WorkerContext): string | undefined {
  if (herdrWorkspacePinEnabled(ctx.env)) {
    try {
      const pinned = pinnedHerdrWorkspace(ctx.runYamlPath);
      if (pinned) return pinned;
    } catch {
      // Corrupt/missing run.yaml — fall through to a live query below.
    }
  }
  let live: string | undefined;
  try { live = ctx.herdr.focusedWorkspace(); } catch { /* launch without workspace affinity */ }
  if (live && herdrWorkspacePinEnabled(ctx.env)) {
    try { setPinnedHerdrWorkspace(ctx.runYamlPath, live); } catch { /* best effort */ }
  }
  return live;
}

/**
 * Shrink a freshly started agent pane so the lead console keeps the majority
 * of the terminal height (issue #18). Purely cosmetic: any failure (older
 * herdr without pane.resize, closed pane, mock without paneResize) is ignored.
 */
function shrinkAgentPane(ctx: WorkerContext, paneId: string): void {
  try {
    // Fire-and-forget, but rejection-safe: a synchronous try/catch cannot
    // capture a rejected promise, so route the result through
    // Promise.resolve().catch() — a sync throw AND an async rejection are
    // both swallowed (cross-vendor review, spec v4 fix 1).
    void Promise.resolve(
      ctx.herdr.paneResize?.(paneId, 'down', herdrAgentPaneRatio(ctx.env.HYDRA_HERDR_PANE_RATIO)),
    ).catch(() => undefined);
  } catch {
    // Pane sizing is best effort and must never affect the worker lifecycle.
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

/**
 * Parses one opencode NDJSON event line into display text for a live-progress
 * pane. Shared with review-dispatch.ts (the review lane reuses the worker
 * lane's event-line parsing for its in-pane `tail -f` progress file).
 */
export function monitorEventText(line: string): string | undefined {
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
    workspace = resolvePaneWorkspace(ctx);
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
  shrinkAgentPane(ctx, paneId);
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
  // 'compiled' self-reexecs this very executable through cli.ts's
  // `adapter-<vendor>` route — the same premise bin-cli.ts's selfReexec
  // already relies on (inside a compiled binary process.execPath IS the
  // hydra-cli binary). The verb/task-spec/... argument sequence is identical
  // across runtimes; only the command and its leading args differ. The spawn
  // passes `env: ctx.env` for every runtime, so the in-place BUN_BE_BUN
  // strip above covers the self-reexec too — leaking BUN_BE_BUN=1 to a
  // re-exec'd self would hijack the child into Bun's own CLI. The shell-
  // adapter lane was retired (run 0045), so the only non-compiled runtime
  // is 'ts' (node --experimental-strip-types adapter-<vendor>.ts).
  const command = ctx.adapterRuntime === 'compiled'
    ? process.execPath
    : ctx.nodeExecutable;
  const args = ctx.adapterRuntime === 'compiled'
    ? [`adapter-${ctx.vendor}`, ...adapterArgs]
    : ['--experimental-strip-types', ctx.adapterPath, ...adapterArgs];
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
  try { workspace = resolvePaneWorkspace(ctx); } catch { /* launch without workspace affinity */ }
  const label = `hydra:${ctx.runId}:${ctx.taskId}:${ctx.vendor}`;

  const bannerPath = writePaneBanner(ctx, vendorLabel(ctx.vendor));

  // Codex and kimi stream NDJSON that pollJsonlFile re-parses into event
  // text; claude emits one JSON document at exit (`--output-format json`), so
  // its pane gets a supervisor-written heartbeat on every poll instead
  // (issue #18) — either way the pane is never silent while the head runs.
  // The heartbeat lands in pane-progress.txt, which herdrActivity does NOT
  // watch, so heartbeats never reset the stall detector's activity signature.
  const streamsVendorEvents = ctx.vendor === 'codex' || ctx.vendor === 'kimi';
  const usesHeartbeat = ctx.vendor === 'claude';
  const usesLiveProgressPane = streamsVendorEvents || usesHeartbeat;
  const progressPath = join(ctx.sessionsDir, `${ctx.agentRunId}.pane-progress.txt`);
  const cliJsonlPath = join(ctx.sessionsDir, `${ctx.agentRunId}.cli.jsonl`);
  if (usesLiveProgressPane) {
    try {
      writeFileSync(progressPath, `[hydra] ${ctx.vendor} started — waiting for output...\n`, 'utf8');
    } catch { /* best effort — pane uses touch */ }
  }
  const liveProgressTailState: JsonlTailState = { offset: 0 };
  const parseLiveProgress = ctx.vendor === 'kimi' ? kimiEventText : codexEventText;
  const paneStartedAt = ctx.clock.now();
  const pollLiveProgress = (final = false): void => {
    if (streamsVendorEvents) {
      pollJsonlFile(cliJsonlPath, progressPath, parseLiveProgress, liveProgressTailState, final);
      return;
    }
    if (usesHeartbeat && !final) {
      const elapsedSec = Math.floor((ctx.clock.now() - paneStartedAt) / 1000);
      try {
        appendFileSync(progressPath, `[hydra] claude working... elapsed ${elapsedSec}s\n`, 'utf8');
      } catch { /* best effort — the heartbeat is cosmetic */ }
    }
  };

  // 'compiled' substitutes the self-reexec form `<self> adapter-<vendor>` for
  // the adapter file path; the verb/task-spec/... sequence after it and the
  // surrounding pidfile/banner/sentinel protocol are unchanged (plan-codex:
  // "Only the adapter command changes"). The shell-adapter lane was retired
  // (run 0045), so the only non-compiled runtime is 'ts'.
  const adapterCommand = ctx.adapterRuntime === 'compiled'
    ? [process.execPath, `adapter-${ctx.vendor}`]
    : [ctx.nodeExecutable, '--experimental-strip-types', ctx.adapterPath];
  const adapterArgs = [
    ...adapterCommand,
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
  shrinkAgentPane(ctx, paneId);
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
  enforceHeadAvailability(spec, taskSpecPath, options);
  warnOnStaleOpencodeModelPin(spec, taskSpecPath, options);
  const env = options.env ?? process.env;
  // Strip BUN_BE_BUN in place so the worker spawn (runWorkerPlain passes
  // `env: ctx.env` explicitly, by reference — see dispatch.test.ts's identity
  // assertion) can never leak a hijacking BUN_BE_BUN=1 to a Bun-compiled
  // adapter binary (spike: docs/bun-migration-spike-results.md). Mirrors
  // bin-cli.ts's startup delete; safe under Node, effective under Bun because
  // the env object is passed explicitly.
  delete env.BUN_BE_BUN;
  // Vendor-CLI tool shells rebuild PATH via login-shell init (macOS
  // path_helper puts /usr/local/bin ahead of version managers), so a stale
  // system node can shadow the harness-resolved one for WORKERS even though
  // this env's PATH is correct. Export the known-good bin dir so the worker
  // prompt can direct workers to it. An operator-set value always wins; a
  // failed resolution leaves the env untouched (the target project may not
  // need node at all).
  if (!env.HYDRA_NODE_BIN) {
    const nodeBinDir = (options.resolveNodeBinDir ?? resolveWorkerNodeBinDir)();
    if (nodeBinDir) env.HYDRA_NODE_BIN = nodeBinDir;
  }
  // A real compiled binary resolves to the self-reexec runtime no matter what
  // HYDRA_HARNESS/HYDRA_ADAPTER_RUNTIME say: 'bash' is now rejected upstream
  // (resolveAdapterRuntime) rather than selected. The 'compiled' runtime
  // self-reexecs this executable through cli.ts's `adapter-<vendor>` route
  // (inside a compiled binary process.execPath IS the hydra-cli binary).
  const adapterRuntime = resolveAdapterRuntime(
    options.adapterRuntime ?? env.HYDRA_ADAPTER_RUNTIME,
    env.HYDRA_HARNESS,
    isCompiledBinary(),
  );
  // Adapters are kit-owned assets: resolve self-relative to this file's own
  // location, not via the target repo root (repo is for git/worktree/state
  // operations on the TARGET project, which is a different concern).
  // Tests may override the TypeScript adapter directory with a fixture location.
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const tsAdapterDir = options.tsAdapterDir ? resolve(cwd, options.tsAdapterDir) : selfDir;
  let adapterPath: string;
  if (adapterRuntime === 'compiled') {
    // No adapter file exists to check inside a compiled binary — vendor
    // validity is cli.ts's fixed compile-time `adapter-<vendor>` route set,
    // not a file-existence probe (selfDir is the synthetic /$bunfs/root
    // there, so isFile() could never find a real adapter anyway).
    if (COMPILED_ADAPTERS[spec.vendor] === undefined) {
      die(`no adapter for vendor '${spec.vendor}': the compiled binary only routes ${Object.keys(COMPILED_ADAPTERS).map((v) => `adapter-${v}`).join(', ')}`);
    }
    adapterPath = `adapter-${spec.vendor}`;
  } else {
    adapterPath = join(tsAdapterDir, `adapter-${spec.vendor}.ts`);
    if (!isFile(adapterPath)) die(`no adapter for vendor '${spec.vendor}': ${adapterPath}`);
  }

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

  const delivery = determineDelivery(runId, taskId, sessionsDir, { vendor: spec.vendor, path: adapterPath, runtime: adapterRuntime }, env, spec.timeoutMinutes);
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
    runYamlPath: join(runPath, 'run.yaml'),
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

const isMain = !isCompiledBinary() && process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await main();
}
