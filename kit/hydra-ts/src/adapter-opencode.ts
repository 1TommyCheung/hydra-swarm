import {
  execFileSync,
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
  warn,
  yamlScalar,
} from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';
import { buildWorkerPrompt as buildSharedWorkerPrompt } from './build-worker-prompt.ts';
import {
  aggregateSource,
  classifyPinSource,
  resolveVendorPin,
  vendorProbeEnabled,
  vendorSpecPins,
  type ModelProvenance,
  type VendorProbe,
  type VendorProbeResult,
} from './adapter-codex.ts';

// ---------------------------------------------------------------------------
// OpenCode / GLM adapter (TypeScript port of hydra/adapters/opencode.sh).
//
// Verbs:
//   explore(cwd, prompt, outPrefix, agentRunId, options?)
//   review(cwd, prompt, outPrefix, agentRunId, options?)
//   start(taskSpec, worktree, inbox, sessions, agentRunId, options?)
//
// The side-effectful CLI is injectable via options.spawn so tests never invoke
// real vendor tooling.
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = 'zai-coding-plan/glm-5.2';

/** Injectable replacement for spawning the streaming opencode CLI. */
export type OpencodeSpawn = (
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcess;

/** Injectable replacement for deriving a result drop from git evidence. */
export type DeriveDropFromGit = (
  taskSpec: string,
  worktree: string,
  vendor: string,
  sessionId: string,
  outJson: string,
) => boolean;

export interface OpencodeRunOptions {
  /** Explicit model override for injected callers and tests. */
  model?: string;
  /** Task-spec model pin; start() fills this from the spec file. */
  taskSpecModel?: string;
  /** Explicit reasoning-effort ("variant") override for injected callers and tests. */
  effort?: string;
  /** Injected streaming opencode runner for tests. */
  spawn?: OpencodeSpawn;
  /** Injected git-derived drop helper for tests. */
  deriveDropFromGit?: DeriveDropFromGit;
  /** Base directory for relative paths (unused, kept for sibling compatibility). */
  cwd?: string;
  /** Directory containing the optional global opencode-model.json override. */
  stateRoot?: string;
  /** Injected vendor probe so tests never shell out to the real opencode CLI. */
  probe?: VendorProbe;
}

// ---------------------------------------------------------------------------
// Model / effort provenance (issue #42).
//
// INVESTIGATION (opencode 1.18.5, verified against the installed CLI):
//
//   * Unlike codex and kimi, this adapter has ALWAYS passed `--model` itself,
//     so the resolved model is known by construction — no stream parsing or
//     config query is needed to recover it, and it has been written into the
//     per-attempt session capture since before this change.
//   * `opencode --version` gives the CLI version.
//   * Reasoning effort IS pinnable here: `opencode run --variant <v>` is
//     documented as "model variant (provider-specific reasoning effort, e.g.,
//     high, max, minimal)". opencode is therefore the only one of the three
//     vendors that can honor BOTH halves of a `model:`/`effort:` pin.
//   * The model alias is `provider/model`, so the provider is recoverable by
//     splitting it rather than by querying anything.
// ---------------------------------------------------------------------------

/** `opencode --version` — the model needs no probe; this adapter chooses it. */
export function probeOpencode(): VendorProbeResult {
  if (!vendorProbeEnabled()) return { model: null, provider: null, cliVersion: null };
  try {
    const version = String(execFileSync('opencode', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    return { model: null, provider: null, cliVersion: version || null };
  } catch {
    return { model: null, provider: null, cliVersion: null };
  }
}

/** `zai-coding-plan/glm-5.2` -> `zai-coding-plan`. */
function providerOf(model: string): string | null {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

// Model precedence: options.model (explicit injection) > task-spec model: /
// opencode_model pin > HYDRA_OPENCODE_MODEL > opencode-model.json > default.
//
// `pinned` marks the first three rungs — the ones that express a per-task or
// per-invocation CHOICE. The state file and DEFAULT_MODEL are machine-local
// defaults: the model is still recorded exactly, but as `vendor_default`.
function resolveModelDetailed(options?: OpencodeRunOptions): { value: string; pinned: boolean } {
  if (options?.model !== undefined) return { value: options.model, pinned: true };

  if (options?.taskSpecModel) return { value: options.taskSpecModel, pinned: true };

  const envModel = process.env.HYDRA_OPENCODE_MODEL;
  if (envModel) return { value: envModel, pinned: true };

  const stateRoot = options?.stateRoot
    ?? join(process.env.HOME ?? '', '.local/state/hydra');
  const configPath = join(stateRoot, 'opencode-model.json');
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`invalid or unreadable OpenCode model config (${configPath}); using default`);
    }
    return { value: DEFAULT_MODEL, pinned: false };
  }

  if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
    const model = (config as Record<string, unknown>).model;
    if (typeof model === 'string' && model.length > 0) return { value: model, pinned: false };
  }

  warn(`invalid or unreadable OpenCode model config (${configPath}); using default`);
  return { value: DEFAULT_MODEL, pinned: false };
}

function resolveModel(options?: OpencodeRunOptions): string {
  return resolveModelDetailed(options).value;
}

/**
 * Resolve the task-spec model pin, honoring `opencode_model:` as a
 * backward-compatible alias for the vendor-neutral `model:`.
 *
 * Absent-or-equal is the silent, unchanged path. Genuinely conflicting values
 * are a spec-authoring bug: warn loudly and take the vendor-neutral field
 * rather than silently picking one and leaving the operator to wonder which
 * model actually ran.
 */
export function resolveOpencodeSpecPin(taskSpec: string): string {
  const neutral = vendorSpecPins(taskSpec).model;
  const legacy = yamlScalar(taskSpec, 'opencode_model');

  if (neutral && legacy && neutral !== legacy) {
    warn(
      `task spec pins BOTH model: '${neutral}' AND opencode_model: '${legacy}' to different `
      + `values — using the vendor-neutral model: '${neutral}'. Remove the stale opencode_model: `
      + 'line (it is only an alias) so the pin is unambiguous.',
    );
    return neutral;
  }
  return neutral || legacy;
}

interface OpencodeResolution {
  model: string;
  provenance: ModelProvenance;
  /** Extra argv the effort pin contributes. */
  pinArgs: string[];
}

function resolveOpencodeProvenance(
  options: OpencodeRunOptions | undefined,
  effortPin: string,
): OpencodeResolution {
  const model = resolveModelDetailed(options);
  const effort = resolveVendorPin(
    options?.effort,
    effortPin,
    process.env.HYDRA_OPENCODE_EFFORT,
    null,
  );
  const probe = (options?.probe ?? probeOpencode)();

  // Per-field: `--variant` genuinely honors an effort pin, so an effort-only
  // pin (model left to the state file / adapter default) must read `pinned`
  // for effort and `vendor_default` for model — not one shared verdict.
  const modelSource = classifyPinSource(model, model.value);
  const effortSource = classifyPinSource(effort, effort.value);

  return {
    model: model.value,
    provenance: {
      model: model.value,
      provider: providerOf(model.value),
      cli_version: probe.cliVersion,
      effort: effort.value,
      source: aggregateSource(modelSource, effortSource),
      model_source: modelSource,
      effort_source: effortSource,
    },
    // `--variant` is opencode's provider-specific reasoning-effort knob.
    pinArgs: effort.value ? ['--variant', effort.value] : [],
  };
}

interface RunResult {
  exitCode: number | null;
}

/** Append both child streams as they arrive, then resolve after exit and EOF. */
function runStreaming(
  command: string,
  args: string[],
  options: {
    stdoutPath: string;
    stderrPath: string;
    spawn: OpencodeSpawn;
  },
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    mkdirSync(dirname(options.stdoutPath), { recursive: true });
    mkdirSync(dirname(options.stderrPath), { recursive: true });
    writeFileSync(options.stdoutPath, '', 'utf8');
    writeFileSync(options.stderrPath, '', 'utf8');

    let stdoutDone = false;
    let stderrDone = false;
    let exitCode: number | null | undefined;
    let settled = false;

    function finish(): void {
      if (settled || !stdoutDone || !stderrDone || exitCode === undefined) return;
      settled = true;
      resolvePromise({ exitCode });
    }

    let child: ChildProcess;
    try {
      child = options.spawn(command, args, {
        // Strip BUN_BE_BUN so a leaked BUN_BE_BUN=1 cannot hijack a Bun-compiled
        // child (spike: docs/bun-migration-spike-results.md); Bun omits env keys
        // whose value is undefined.
        env: { ...process.env, BUN_BE_BUN: undefined },
        // `SpawnOptionsWithoutStdio['stdio']` (the injected OpencodeSpawn's
        // option type) is typed as StdioPipeNamed | StdioPipe[], which
        // excludes "ignore" even though it's a valid StdioOptions value at
        // runtime.
        stdio: ['ignore', 'pipe', 'pipe'] as unknown as SpawnOptionsWithoutStdio['stdio'],
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        rejectPromise(new Error(`${command} CLI not found (Wave 1 dependency)`));
      } else {
        resolvePromise({ exitCode: 1 });
      }
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
        finish();
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
        finish();
      });
    }

    child.on('exit', (code) => {
      exitCode = code ?? null;
      finish();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (error.code === 'ENOENT') {
        settled = true;
        rejectPromise(new Error(`${command} CLI not found (Wave 1 dependency)`));
        return;
      }
      exitCode = 1;
      stdoutDone = true;
      stderrDone = true;
      finish();
    });
  });
}

function parseEvents(stdout: string): Record<string, unknown>[] | null {
  const events: unknown[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Each bash jq invocation fails as a whole when any JSONL record is bad.
      return null;
    }
  }
  if (
    events.some(
      (event) => event !== null && (typeof event !== 'object' || Array.isArray(event)),
    )
  ) {
    // jq property access fails on scalar and array stream values.
    return null;
  }
  return events.filter((event): event is Record<string, unknown> => event !== null);
}

function jqCoalesce<T>(value: T | null | false, fallback: T): T {
  return value === null || value === false ? fallback : value;
}

function jqRaw(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

function extractSessionId(events: Record<string, unknown>[] | null): string {
  if (events === null) return '';
  let last: unknown;
  for (const event of events) {
    const sid = event.sessionID;
    if (sid !== null && sid !== undefined && sid !== false && sid !== '') last = sid;
  }
  return last === undefined || last === null || last === false ? '' : jqRaw(last);
}

function extractFinalText(events: Record<string, unknown>[] | null): string {
  if (events === null) return '';
  let last: unknown;
  for (const event of events) {
    const part = event.part;
    const invalidPart =
      part !== null && part !== undefined && (typeof part !== 'object' || Array.isArray(part));
    const partRecord =
      part && typeof part === 'object' && !Array.isArray(part)
        ? (part as Record<string, unknown>)
        : undefined;
    if (event.type !== 'text') {
      if (invalidPart) return '';
      if (partRecord?.type !== 'text') continue;
    }
    let text = event.text;
    if (text === null || text === undefined || text === false) {
      if (invalidPart) return '';
      text = partRecord?.text;
    }
    if (text !== null && text !== undefined && text !== false) last = text;
  }
  return last === undefined || last === null || last === false ? '' : `${jqRaw(last)}\n`;
}

interface UsageSummary {
  tokens: unknown;
  cost: unknown;
}

function jqAdd(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left + right;
  if (typeof left === 'string' && typeof right === 'string') return left + right;
  if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    return { ...(left as Record<string, unknown>), ...(right as Record<string, unknown>) };
  }
  throw new TypeError('jq-incompatible addition');
}

function extractUsage(events: Record<string, unknown>[] | null): UsageSummary {
  if (events === null) return { tokens: {}, cost: 0 };
  const tokenValues: unknown[] = [];
  const costValues: unknown[] = [];

  try {
    for (const event of events) {
      if (event.type !== 'step_finish') continue;

      const part = event.part;
      if (part === null || part === undefined) continue;
      if (typeof part !== 'object' || Array.isArray(part)) {
        throw new TypeError('jq cannot index step_finish part');
      }
      const record = part as Record<string, unknown>;
      if (record.tokens !== null && record.tokens !== undefined) tokenValues.push(record.tokens);
      if (record.cost !== null && record.cost !== undefined) costValues.push(record.cost);
    }

    const lastTokens = tokenValues.at(-1);
    const tokens = lastTokens === undefined ? {} : jqCoalesce(lastTokens, {});
    let cost: unknown = costValues[0] ?? null;
    for (const value of costValues.slice(1)) cost = jqAdd(cost, value);
    cost = jqCoalesce(cost, 0);
    return { tokens, cost };
  } catch {
    // Mirrors `usage="$(jq ... || true)"` followed by the default value.
    return { tokens: {}, cost: 0 };
  }
}

function writeSessionJson(
  path: string,
  agentRunId: string,
  provenance: ModelProvenance,
  sessionId: string,
  usage: UsageSummary,
): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      agent_run_id: agentRunId,
      vendor: 'opencode',
      // `model` keeps its historical position/meaning; provider/cli_version/
      // effort/source are the issue #42 additions and are always present.
      ...provenance,
      session_id: sessionId,
      tokens: jqCoalesce(usage.tokens, {}),
      cost: jqCoalesce(usage.cost, 0),
    })}\n`,
    'utf8',
  );
}

async function runReadOnly(
  verb: 'explore' | 'review',
  cwd: string,
  prompt: string,
  outPrefix: string,
  agentRunId: string,
  options?: OpencodeRunOptions,
): Promise<string> {
  if (!cwd) die(`usage: opencode.ts ${verb} <cwd> <prompt> <out_prefix> <agent_run_id>`);
  if (!prompt) die(`usage: opencode.ts ${verb} <cwd> <prompt> <out_prefix> <agent_run_id>`);
  if (!outPrefix) die(`usage: opencode.ts ${verb} <cwd> <prompt> <out_prefix> <agent_run_id>`);
  if (!agentRunId) die(`usage: opencode.ts ${verb} <cwd> <prompt> <out_prefix> <agent_run_id>`);

  const { model, provenance, pinArgs } = resolveOpencodeProvenance(options, '');
  const spawnFn = options?.spawn ?? spawn;
  const eventsPath = `${outPrefix}.events.jsonl`;
  const stderrPath = `${outPrefix}.stderr`;

  mkdirSync(dirname(outPrefix), { recursive: true });

  const { exitCode } = await runStreaming(
    'opencode',
    [
      'run',
      '--model',
      model,
      ...pinArgs,
      '--agent',
      'hydra-reviewer',
      '--format',
      'json',
      '--auto',
      '--dir',
      cwd,
      prompt,
    ],
    { stdoutPath: eventsPath, stderrPath, spawn: spawnFn },
  );

  // The bash adapter tolerates opencode failures because the event stream still
  // contains the partial output.
  void exitCode;

  const stdout = readFileSync(eventsPath, 'utf8');
  const events = parseEvents(stdout);
  const sessionId = extractSessionId(events);
  const finalText = extractFinalText(events);
  const usage = extractUsage(events);

  writeFileSync(`${outPrefix}.txt`, finalText, 'utf8');
  writeSessionJson(`${outPrefix}.session.json`, agentRunId, provenance, sessionId, usage);

  log(`opencode ${verb} done (${model}) session=${sessionId}`);
  process.stdout.write(`${outPrefix}.txt\n`);
  return `${outPrefix}.txt`;
}

/** Read-only exploration role. */
export async function explore(
  cwd: string,
  prompt: string,
  outPrefix: string,
  agentRunId: string,
  options?: OpencodeRunOptions,
): Promise<string> {
  return runReadOnly('explore', cwd, prompt, outPrefix, agentRunId, options);
}

/** Read-only review role. */
export async function review(
  cwd: string,
  prompt: string,
  outPrefix: string,
  agentRunId: string,
  options?: OpencodeRunOptions,
): Promise<string> {
  return runReadOnly('review', cwd, prompt, outPrefix, agentRunId, options);
}

/**
 * Compile the worker protocol + task spec into a single prompt.
 *
 * Delegates to the SHARED builder (build-worker-prompt.ts): amendment_reason,
 * amendment_check, and the compact revision-evidence manifest summary render
 * identically for opencode and every other vendor adapter.
 */
export function buildWorkerPrompt(taskSpec: string): string {
  return buildSharedWorkerPrompt(taskSpec);
}

/**
 * Implementer role: run a worker in its own worktree and bridge the result
 * drop. Shared by both write verbs — only the resume flag differs:
 *   start  <task_spec> <worktree> <inbox> <sessions> <agent_run_id>
 *   resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> <prior_session_id>
 */
async function runImplementer(
  verb: 'start' | 'resume',
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId?: string,
  options?: OpencodeRunOptions,
): Promise<string> {
  const usage = `usage: opencode.ts ${verb} <task_spec> <worktree> <inbox> <sessions> <agent_run_id>`;
  if (!taskSpec) die(usage);
  if (!worktree) die(usage);
  if (!inbox) die(usage);
  if (!sessions) die(usage);
  if (!agentRunId) die(usage);

  // The task-spec model pin travels with the spec file itself: dispatch hands
  // this adapter the spec path, and the pin outranks HYDRA_OPENCODE_MODEL here
  // in resolveModel. An explicit options.model (tests/callers) still wins.
  // `opencode_model:` remains a backward-compatible alias for `model:`.
  const specPin = options?.taskSpecModel || resolveOpencodeSpecPin(taskSpec);
  const { model, provenance, pinArgs } = resolveOpencodeProvenance(
    specPin ? { ...options, taskSpecModel: specPin } : options,
    vendorSpecPins(taskSpec).effort,
  );
  const spawnFn = options?.spawn ?? spawn;
  const derive = options?.deriveDropFromGit ?? libDeriveDropFromGit;

  const resultPath = join(inbox, 'result.json');
  const workerResult = join(worktree, '.hydra-result.json');
  const eventsPath = join(sessions, `${agentRunId}.events.jsonl`);
  const stderrPath = join(sessions, `${agentRunId}.stderr`);

  mkdirSync(inbox, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  rmSync(workerResult, { force: true });

  const prompt = buildWorkerPrompt(taskSpec);

  const opencodeArgs = [
    'run',
    '--model',
    model,
    ...pinArgs,
    '--agent',
    'hydra-implementer',
    '--format',
    'json',
    '--auto',
    // Global flags: surface the vendor CLI's own diagnostics (e.g. "stream
    // error" usage-limit records) on stderr, where the .stderr capture file
    // already tails them for the usage detector. ERROR level keeps the
    // stream sparse enough to not disturb stall detection.
    '--print-logs',
    '--log-level',
    'ERROR',
  ];
  if (verb === 'resume' && priorSessionId) {
    // OpenCode's resume flag is `-s, --session <id>` (verified against the
    // installed CLI's `opencode run --help`; docs/vendor-adapters.md §3).
    // Deliberately NOT `--fork`: forking branches away from the session the
    // reviewer actually read, while an amendment must continue the reviewed
    // history in place. Inserted ahead of --dir, where adapter-kimi.ts
    // appends its own -S.
    opencodeArgs.push('-s', priorSessionId);
    log(`opencode resume from session ${priorSessionId}`);
  }
  opencodeArgs.push('--dir', worktree, prompt);

  const { exitCode } = await runStreaming(
    'opencode',
    opencodeArgs,
    { stdoutPath: eventsPath, stderrPath, spawn: spawnFn },
  );

  void exitCode;

  const stdout = readFileSync(eventsPath, 'utf8');
  const events = parseEvents(stdout);
  const sessionId = extractSessionId(events);

  writeFileSync(
    join(sessions, `${agentRunId}.json`),
    `${JSON.stringify({
      agent_run_id: agentRunId,
      vendor: 'opencode',
      ...provenance,
      session_id: sessionId,
    })}\n`,
    'utf8',
  );

  let resultWritten = false;

  if (existsSync(workerResult)) {
    let parsed: unknown;
    try {
      const raw = readFileSync(workerResult, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    // `jq -e .` rejects false/null but accepts every other JSON value. The
    // following field update then fails for truthy non-objects and arrays.
    if (parsed !== undefined && parsed !== null && parsed !== false) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        writeFileSync(resultPath, '', 'utf8');
        die('cannot stamp vendor/session_id on non-object worker result');
      }
      const drop = parsed as Record<string, unknown>;
      drop.vendor = 'opencode';
      drop.session_id = jqCoalesce(drop.session_id ?? null, sessionId);
      writeFileSync(resultPath, `${JSON.stringify(drop)}\n`, 'utf8');
      resultWritten = true;
    }
  }

  if (!resultWritten) {
    if (derive(taskSpec, worktree, 'opencode', sessionId, resultPath)) {
      log('opencode committed without a self-report; drop derived from git evidence');
      resultWritten = true;
    }
  }

  if (!resultWritten) {
    const rawSpecVersion = yamlScalar(taskSpec, 'spec_version');
    let specVersion: unknown;
    try {
      specVersion = JSON.parse(rawSpecVersion);
    } catch {
      writeFileSync(resultPath, '', 'utf8');
      die(`invalid JSON spec_version: ${rawSpecVersion}`);
    }
    const drop = {
      task_id: yamlScalar(taskSpec, 'task_id'),
      run_id: yamlScalar(taskSpec, 'run_id'),
      spec_version: specVersion,
      vendor: 'opencode',
      session_id: sessionId,
      status: 'failed',
      branch: yamlScalar(taskSpec, 'branch'),
      base_commit: yamlScalar(taskSpec, 'base_commit'),
      head_commit: yamlScalar(taskSpec, 'base_commit'),
      summary: 'worker produced no result drop and no commit',
      files_changed: [] as string[],
      verification_claims: [] as Record<string, string>[],
      risks: ['adapter synthesized a failed drop'],
      unresolved_questions: [] as string[],
      suggested_additional_checks: [] as string[],
    };
    writeFileSync(resultPath, `${JSON.stringify(drop)}\n`, 'utf8');
  }

  process.stdout.write(`${agentRunId}\n`);
  return agentRunId;
}

/** Implementer role, cold start. */
export async function start(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  options?: OpencodeRunOptions,
): Promise<string> {
  return runImplementer('start', taskSpec, worktree, inbox, sessions, agentRunId, undefined, options);
}

/**
 * Implementer role, continuing a prior opencode session in place instead of
 * cold-restarting it (issue #33).
 */
export async function resume(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId: string,
  options?: OpencodeRunOptions,
): Promise<string> {
  return runImplementer(
    'resume',
    taskSpec,
    worktree,
    inbox,
    sessions,
    agentRunId,
    priorSessionId,
    options,
  );
}

export default { explore, review, start, resume, buildWorkerPrompt };

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const [verb, ...rest] = args;
    if (!verb) die('usage: opencode.sh explore|review|start|resume ...');

    if (verb === 'start' || verb === 'resume') {
      const [taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId] = rest;
      if (!taskSpec) die('task_spec required');
      if (!worktree) die('worktree required');
      if (!inbox) die('inbox required');
      if (!sessions) die('sessions required');
      if (!agentRunId) die('agent_run_id required');
      await runImplementer(verb, taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId);
      return 0;
    }

    if (verb === 'explore' || verb === 'review') {
      const [cwd, prompt, outPrefix, agentRunId] = rest;
      if (!cwd) die('cwd required');
      if (!prompt) die('prompt required');
      if (!outPrefix) die('out_prefix required');
      if (!agentRunId) die('agent_run_id required');
      await (verb === 'explore' ? explore : review)(cwd, prompt, outPrefix, agentRunId);
      return 0;
    }

    die(`opencode.sh: unknown verb '${verb}'`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
