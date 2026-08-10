import {
  spawn,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deriveDropFromGit as libDeriveDropFromGit,
  die,
  log,
  yamlScalar,
} from './lib.ts';
import {
  aggregateSource,
  classifyPinSource,
  resolveVendorPin,
  vendorSpecPins,
  type ModelProvenance,
} from './adapter-codex.ts';
import { buildWorkerPrompt as buildSharedWorkerPrompt } from './build-worker-prompt.ts';
import { isCompiledBinary } from './kit-assets.ts';

// ---------------------------------------------------------------------------
// Grok Build CLI adapter.
//
// The CLI is expected to be authenticated by the ambient environment, either
// through XAI_API_KEY or a prior `grok login`. The adapter deliberately never
// performs authentication or model discovery on the worker hot path.
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = 'grok-build-0.1';
const DEFAULT_TIMEOUT_MINUTES = 45;
const TIMEOUT_KILL_GRACE_MS = 1_000;

export type GrokSpawn = (
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcess;

export type DeriveDropFromGit = (
  taskSpec: string,
  worktree: string,
  vendor: string,
  sessionId: string,
  outJson: string,
) => boolean;

export interface GrokAdapterOptions {
  /** Base directory used to resolve relative paths. */
  cwd?: string;
  /** Explicit model override (outranks task-spec and environment pins). */
  model?: string;
  /** Explicit reasoning-effort override. */
  effort?: string;
  /** Environment consulted for HYDRA_GROK_MODEL / HYDRA_GROK_EFFORT. */
  env?: NodeJS.ProcessEnv;
  /** Injected CLI spawn so unit tests never invoke the real grok binary. */
  spawn?: GrokSpawn;
  /** Injected git-evidence bridge for tests. */
  deriveDropFromGit?: DeriveDropFromGit;
  /** Explicit subprocess timeout for tests or embedding callers. */
  timeoutMs?: number;
}

export interface GrokResolution {
  model: string;
  effort: string | null;
  provenance: ModelProvenance;
  pinArgs: string[];
}

/**
 * Resolve Grok pins with the same precedence used by adapter-opencode.ts:
 * explicit injection > vendor-neutral task-spec pin > environment > adapter
 * default. The adapter default is known by construction but is not a pin.
 */
export function resolveGrokModel(
  taskSpec: string,
  options: GrokAdapterOptions = {},
): GrokResolution {
  const pins = vendorSpecPins(taskSpec);
  const env = options.env ?? process.env;
  const model = resolveVendorPin(
    options.model,
    pins.model,
    env.HYDRA_GROK_MODEL,
    DEFAULT_MODEL,
  );
  const effort = resolveVendorPin(
    options.effort,
    pins.effort,
    env.HYDRA_GROK_EFFORT,
    null,
  );
  const resolvedModel = model.value ?? DEFAULT_MODEL;
  const resolvedEffort = effort.value;
  const modelSource = classifyPinSource(model, resolvedModel);
  const effortSource = classifyPinSource(effort, resolvedEffort);

  return {
    model: resolvedModel,
    effort: resolvedEffort,
    provenance: {
      model: resolvedModel,
      provider: 'xai',
      // `grok doctor` / `grok models` intentionally stay in detect-heads-style
      // probing rather than adding latency and failure modes to every dispatch.
      cli_version: null,
      effort: resolvedEffort,
      source: aggregateSource(modelSource, effortSource),
      model_source: modelSource,
      effort_source: effortSource,
    },
    pinArgs: [
      '-m', resolvedModel,
      ...(resolvedEffort ? ['--reasoning-effort', resolvedEffort] : []),
    ],
  };
}

/** Shared worker protocol / task-spec prompt assembly. */
export function buildWorkerPrompt(taskSpec: string): string {
  return buildSharedWorkerPrompt(taskSpec);
}

interface RunResult {
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Capture Grok's NDJSON incrementally so dispatch.ts can show live progress.
 * stdin is explicitly ignored (the subprocess equivalent of `</dev/null`).
 *
 * Users have reported Grok/ACP children hanging under harness-spawned stdio
 * even after useful output completed (source: xai-org/grok-build-plugin-cc#7,
 * https://github.com/xai-org/grok-build-plugin-cc/issues/7). Enforce a local
 * deadline in addition to the dispatcher's outer timeout, escalating from
 * SIGTERM to SIGKILL and closing captured streams so the adapter itself cannot
 * wait forever on a stuck child.
 */
function runStreaming(
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdoutPath: string;
    stderrPath: string;
    timeoutMs: number;
    spawn: GrokSpawn;
    env: NodeJS.ProcessEnv;
  },
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    mkdirSync(dirname(options.stdoutPath), { recursive: true });
    mkdirSync(dirname(options.stderrPath), { recursive: true });
    writeFileSync(options.stdoutPath, '', 'utf8');
    writeFileSync(options.stderrPath, '', 'utf8');

    let settled = false;
    let timedOut = false;
    let stdoutDone = false;
    let stderrDone = false;
    let exitCode: number | null | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ exitCode, timedOut });
    };

    const finishIfReady = (): void => {
      if (stdoutDone && stderrDone && exitCode !== undefined) finish(exitCode);
    };

    try {
      child = options.spawn(command, args, {
        cwd: options.cwd,
        env: { ...options.env, BUN_BE_BUN: undefined },
        // Close stdin exactly as Codex does. Grok otherwise has an opportunity
        // to wait for interactive input in a headless worker.
        stdio: ['ignore', 'pipe', 'pipe'] as unknown as SpawnOptionsWithoutStdio['stdio'],
      });
    } catch {
      resolvePromise({ exitCode: 127, timedOut: false });
      return;
    }

    if (child.stdout === null) {
      stdoutDone = true;
    } else {
      child.stdout.on('data', (chunk: Buffer | string) => {
        writeFileSync(options.stdoutPath, chunk, { flag: 'a' });
      });
      child.stdout.on('end', () => {
        stdoutDone = true;
        finishIfReady();
      });
    }
    if (child.stderr === null) {
      stderrDone = true;
    } else {
      child.stderr.on('data', (chunk: Buffer | string) => {
        writeFileSync(options.stderrPath, chunk, { flag: 'a' });
      });
      child.stderr.on('end', () => {
        stderrDone = true;
        finishIfReady();
      });
    }
    child.on('exit', (code) => {
      exitCode = code ?? null;
      finishIfReady();
    });
    child.on('error', () => {
      exitCode = 127;
      stdoutDone = true;
      stderrDone = true;
      finishIfReady();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* continue to forced cleanup */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* forced settlement below */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, TIMEOUT_KILL_GRACE_MS);
      killTimer.unref?.();
    }, options.timeoutMs);
    timeoutTimer.unref?.();
  });
}

function parseJsonLines(path: string): Record<string, unknown>[] | null {
  if (!existsSync(path)) return null;
  const events: Record<string, unknown>[] = [];
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Match jq's all-or-nothing treatment of a malformed/partial JSONL file.
      return null;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    events.push(value as Record<string, unknown>);
  }
  return events;
}

function rawString(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/** Extract the last session id from Grok json/streaming-json output. */
export function parseGrokSessionId(path: string): string {
  const events = parseJsonLines(path);
  if (events === null) return '';
  let last: unknown;
  for (const event of events) {
    // Installed CLI v1.0.0 emits sessionId on the final `end` event. Accept
    // snake_case as a compatibility bridge for older ACP-derived payloads.
    const candidate = event.sessionId ?? event.session_id;
    if (candidate !== undefined && candidate !== null && candidate !== false && candidate !== '') {
      last = candidate;
    }
  }
  return last === undefined ? '' : rawString(last);
}

function timeoutFor(taskSpec: string, options: GrokAdapterOptions): number {
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) return options.timeoutMs;
  const minutes = Number(yamlScalar(taskSpec, 'timeout_minutes'));
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TIMEOUT_MINUTES) * 60_000;
}

function buildGrokArgs(
  verb: 'start' | 'resume',
  worktree: string,
  prompt: string,
  priorSessionId: string,
  pinArgs: string[],
): string[] {
  const args = [
    ...pinArgs,
    '--cwd', worktree,
    '--sandbox', 'workspace',
    '--permission-mode', 'acceptEdits',
    '--output-format', 'streaming-json',
  ];
  if (verb === 'resume') {
    args.push('--resume');
    if (priorSessionId) args.push(priorSessionId);
  }
  args.push('-p', prompt);
  // Future structured-output option: `--json-schema <SCHEMA>` also implies
  // `--output-format json`; it is intentionally not part of the base adapter.
  // `--fork-session` is deliberately unused: amendments continue the reviewed
  // session rather than branching away from it.
  return args;
}

function stampWorkerDrop(workerResult: string, resultPath: string, sessionId: string): boolean {
  if (!existsSync(workerResult)) return false;
  let workerData: unknown;
  try {
    workerData = JSON.parse(readFileSync(workerResult, 'utf8'));
  } catch {
    return false;
  }
  if (workerData && typeof workerData === 'object' && !Array.isArray(workerData)) {
    const data = workerData as Record<string, unknown>;
    writeFileSync(resultPath, `${JSON.stringify({
      ...data,
      vendor: 'grok',
      session_id: data.session_id === undefined || data.session_id === null || data.session_id === false
        ? sessionId
        : data.session_id,
    })}\n`);
    return true;
  }
  if (workerData !== null && workerData !== false) {
    throw new TypeError('worker result must be a JSON object');
  }
  return false;
}

/** Grok Build start/resume implementation and inbox result bridge. */
export async function adapterGrok(
  verb: string,
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId = '',
  options: GrokAdapterOptions = {},
): Promise<string> {
  if (!verb) {
    die('usage: adapter-grok.ts start|resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session_id]');
  }
  if (verb !== 'start' && verb !== 'resume') die(`adapter-grok.ts: unknown verb '${verb}'`);
  if (!taskSpec) die('task_spec required');
  if (!worktree) die('worktree required');
  if (!inbox) die('inbox required');
  if (!sessions) die('sessions required');
  if (!agentRunId) die('agent_run_id required');

  const cwd = options.cwd ?? process.cwd();
  const taskSpecAbs = resolve(cwd, taskSpec);
  const worktreeAbs = resolve(cwd, worktree);
  const inboxAbs = resolve(cwd, inbox);
  const sessionsAbs = resolve(cwd, sessions);
  const resultPath = join(inboxAbs, 'result.json');
  const workerResult = join(worktreeAbs, '.hydra-result.json');
  mkdirSync(inboxAbs, { recursive: true });
  mkdirSync(sessionsAbs, { recursive: true });
  rmSync(workerResult, { force: true });

  const prompt = buildWorkerPrompt(taskSpecAbs);
  const resolution = resolveGrokModel(taskSpecAbs, options);
  const args = buildGrokArgs(
    verb,
    worktreeAbs,
    prompt,
    priorSessionId,
    resolution.pinArgs,
  );
  if (verb === 'resume') log(`grok resume from session ${priorSessionId || '(most recent)'}`);
  if (resolution.provenance.source === 'pinned') {
    log(`grok pin honored: model=${resolution.model}`
      + `${resolution.effort ? ` effort=${resolution.effort}` : ''}`);
  }

  const cliJsonl = join(sessionsAbs, `${agentRunId}.cli.jsonl`);
  const cliStderr = join(sessionsAbs, `${agentRunId}.stderr`);
  const runResult = await runStreaming('grok', args, {
    cwd: worktreeAbs,
    stdoutPath: cliJsonl,
    stderrPath: cliStderr,
    timeoutMs: timeoutFor(taskSpecAbs, options),
    spawn: options.spawn ?? spawn,
    env: options.env ?? process.env,
  });
  if (runResult.timedOut) log('grok subprocess exceeded its adapter deadline and was terminated');

  const sessionId = parseGrokSessionId(cliJsonl);
  writeFileSync(
    join(sessionsAbs, `${agentRunId}.json`),
    `${JSON.stringify({
      agent_run_id: agentRunId,
      vendor: 'grok',
      session_id: sessionId,
      ...resolution.provenance,
    })}\n`,
  );

  if (stampWorkerDrop(workerResult, resultPath, sessionId)) {
    process.stdout.write(`${agentRunId}\n`);
    return agentRunId;
  }

  const deriveDrop = options.deriveDropFromGit ?? libDeriveDropFromGit;
  if (deriveDrop(taskSpecAbs, worktreeAbs, 'grok', sessionId, resultPath)) {
    log('grok committed without a self-report; drop derived from git evidence');
    process.stdout.write(`${agentRunId}\n`);
    return agentRunId;
  }

  const baseCommit = yamlScalar(taskSpecAbs, 'base_commit');
  writeFileSync(resultPath, `${JSON.stringify({
    task_id: yamlScalar(taskSpecAbs, 'task_id'),
    run_id: yamlScalar(taskSpecAbs, 'run_id'),
    spec_version: Number(yamlScalar(taskSpecAbs, 'spec_version')),
    vendor: 'grok',
    session_id: sessionId,
    status: 'failed',
    branch: yamlScalar(taskSpecAbs, 'branch'),
    base_commit: baseCommit,
    head_commit: baseCommit,
    summary: 'worker produced no result drop and no commit',
    files_changed: [],
    verification_claims: [],
    risks: ['adapter synthesized a failed drop'],
    unresolved_questions: [],
    suggested_additional_checks: [],
  })}\n`);

  process.stdout.write(`${agentRunId}\n`);
  return agentRunId;
}

export async function start(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  options: GrokAdapterOptions = {},
): Promise<string> {
  return adapterGrok('start', taskSpec, worktree, inbox, sessions, agentRunId, '', options);
}

export async function resume(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId: string,
  options: GrokAdapterOptions = {},
): Promise<string> {
  return adapterGrok(
    'resume', taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId, options,
  );
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const [verb, taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId] = args;
    await adapterGrok(verb, taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) process.exitCode = await main();
