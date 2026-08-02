import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  die,
  log,
  warn,
  yamlScalar,
} from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';
import { buildWorkerPrompt } from './build-worker-prompt.ts';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** Result of running an external command via the injected runner. */
export interface RunResult {
  exitCode: number | null;
  signal: string | null;
}

/** Injectable synchronous command runner (git, build-worker-prompt). */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { encoding?: BufferEncoding; cwd?: string; stdio?: any },
) => string | Buffer;

/** Injectable long-running command runner (codex exec). */
export type SpawnLike = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdin?: 'ignore';
    stdout?: string;
    stderr?: string;
  },
) => RunResult | Promise<RunResult>;

export interface AdapterCodexOptions {
  /** Base directory used to resolve relative paths. */
  cwd?: string;
  /** Injectable synchronous runner for git. */
  exec?: ExecLike;
  /** Injectable runner for the codex CLI so tests never invoke it. */
  spawn?: SpawnLike;
  /** Explicit model override for injected callers and tests (outranks the spec pin). */
  model?: string;
  /** Explicit reasoning-effort override for injected callers and tests. */
  effort?: string;
  /** Directory containing the optional machine-local codex-model.json default. */
  stateRoot?: string;
  /** Injected vendor probe so tests never shell out to the real codex CLI. */
  probe?: VendorProbe;
}

// ---------------------------------------------------------------------------
// Model / effort provenance (issue #42).
//
// INVESTIGATION (codex-cli 0.144.6, verified against the installed CLI):
//
//   * The `--json` event stream this adapter ALREADY captures to
//     `<agent_run_id>.cli.jsonl` does NOT carry model provenance. The only
//     event types emitted by `codex exec --json` are `thread.started`
//     (thread_id), `turn.started`, `item.completed`, and `turn.completed`
//     (token usage). There is no `session_meta`-shaped record in-stream, and
//     `codex exec --help` exposes no verbosity knob that would add one.
//   * The vendor's PRIVATE per-user state does have it —
//     `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl` opens with a
//     `session_meta` payload (`cli_version`, `model_provider`) and later a
//     `turn_context` payload (`model`, `effort`). This adapter deliberately
//     does NOT read that: it is home-directory-relative, absent under
//     `--ephemeral`, and not guaranteed to exist for a sandboxed worker.
//   * `codex doctor --json` is the supported machine-readable config query and
//     needs none of that private state. It reports `.codexVersion` and, under
//     `.checks.config.load.details`, the `model` and `model provider` that a
//     bare `codex exec` would resolve to. That is the account default this
//     adapter records when no pin was supplied (~1s, once per attempt).
//   * Reasoning effort is NOT reported by `codex doctor --json`. When no
//     effort pin is supplied it is genuinely unrecoverable without reading the
//     vendor's private rollout, so it is recorded as an explicit `null`.
//
// Pinning is real for this vendor: `-m/--model` exists on BOTH `codex exec`
// and `codex exec resume`, and `-c model_reasoning_effort="<effort>"` is
// accepted by `--strict-config` (i.e. it is a recognized config key, not a
// silently-ignored override).
// ---------------------------------------------------------------------------

/** What a vendor CLI can tell us about itself without a task running. */
export interface VendorProbeResult {
  /** Account/config default model, or null when not determinable. */
  model: string | null;
  /** Upstream provider for that model, or null. */
  provider: string | null;
  /** Vendor CLI version, or null. */
  cliVersion: string | null;
}

export type VendorProbe = () => VendorProbeResult;

/**
 * How the recorded model was chosen.
 *
 *   pinned         - a task-spec `model:`/`effort:` pin or a HYDRA_* env
 *                    override selected it for this attempt.
 *   vendor_default - no per-task pin; the value is a machine-local default
 *                    (state file / adapter constant) or the vendor account's
 *                    own default, and is KNOWN exactly.
 *   unavailable    - no pin, and the value could not be determined at all.
 */
export type ModelSource = 'pinned' | 'vendor_default' | 'unavailable';

/** Per-attempt provenance mirrored into the session capture and the ledger. */
export interface ModelProvenance {
  model: string | null;
  provider: string | null;
  cli_version: string | null;
  effort: string | null;
  /**
   * Attempt-level summary: `pinned` when EITHER field was explicitly pinned and
   * honored. Kept for consumers that want one answer to "was anything chosen
   * deliberately here?"; the per-field keys below are the precise ones.
   */
  source: ModelSource;
  /** How `model` was chosen, independently of `effort`. */
  model_source: ModelSource;
  /** How `effort` was chosen, independently of `model`. */
  effort_source: ModelSource;
}

const EMPTY_PROBE: VendorProbeResult = { model: null, provider: null, cliVersion: null };

/**
 * Vendor probes shell out to the real CLI, so they are skipped whenever
 * `HYDRA_VENDOR_PROBE=0` — the same opt-out shape as HYDRA_USAGE_DETECTOR and
 * HYDRA_HERDR_PANES. Adapter tests set it so a unit run never invokes a vendor.
 */
export function vendorProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HYDRA_VENDOR_PROBE !== '0';
}

/** `codex doctor --json` — the supported config query; never the private rollout. */
export function probeCodex(): VendorProbeResult {
  if (!vendorProbeEnabled()) return EMPTY_PROBE;
  let raw: string;
  try {
    raw = String(execFileSync('codex', ['doctor', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    // A missing/failing codex CLI must never break a dispatch; null is honest.
    return EMPTY_PROBE;
  }
  try {
    const report = JSON.parse(raw) as Record<string, any>;
    // `checks` is keyed by FLAT dotted check ids ("config.load"), not nested
    // objects — verified against codex-cli 0.144.6's schemaVersion 1 report.
    const details = report?.checks?.['config.load']?.details ?? {};
    return {
      model: typeof details.model === 'string' && details.model ? details.model : null,
      // The key really is spelled with a space in the doctor report.
      provider: typeof details['model provider'] === 'string' && details['model provider']
        ? details['model provider']
        : null,
      cliVersion: typeof report.codexVersion === 'string' && report.codexVersion
        ? report.codexVersion
        : null,
    };
  } catch {
    return EMPTY_PROBE;
  }
}

/**
 * One rung of a precedence chain: the value plus whether it was a real pin.
 *
 * NOTE ON PLACEMENT: the pin/probe/provenance helpers below are vendor-neutral
 * and are imported by adapter-kimi.ts and adapter-opencode.ts. They would
 * belong in a dedicated model-provenance.ts, but this change's writable-path
 * budget covers only the existing adapter/dispatch/promote files, so
 * adapter-codex.ts is their module of record.
 */
export interface PinResolution {
  value: string | null;
  pinned: boolean;
}

/** Read a `{ model, effort }` machine-local default file, mirroring opencode's. */
export function readVendorStateDefault(
  stateRoot: string | undefined,
  file: string,
  key: string,
): string | null {
  const root = stateRoot ?? join(process.env.HOME ?? '', '.local/state/hydra');
  const configPath = join(root, file);
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`invalid or unreadable model config (${configPath}); ignoring`);
    }
    return null;
  }
  if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
    const value = (config as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Precedence chain, deliberately the SAME SHAPE as adapter-opencode's
 * resolveModel(): explicit injection > task-spec pin > env override >
 * machine-local state file > none. Only the first three count as `pinned`.
 */
export function resolveVendorPin(
  explicit: string | undefined,
  taskSpecPin: string,
  envValue: string | undefined,
  stateValue: string | null,
): PinResolution {
  if (explicit !== undefined && explicit !== '') return { value: explicit, pinned: true };
  if (taskSpecPin) return { value: taskSpecPin, pinned: true };
  if (envValue) return { value: envValue, pinned: true };
  if (stateValue) return { value: stateValue, pinned: false };
  return { value: null, pinned: false };
}

/**
 * Classify ONE field's provenance. Deliberately per-field: a task that pins
 * `effort:` and leaves `model:` unset has still made an explicit choice, and
 * labelling that effort `vendor_default` would erase exactly the distinction
 * this field exists to record. Callers pass the value that actually ended up
 * recorded, so a pin the adapter could not honor (and therefore recorded as
 * null) never counts as `pinned`.
 */
export function classifyPinSource(pin: PinResolution, recorded: string | null): ModelSource {
  if (pin.pinned && pin.value && recorded !== null) return 'pinned';
  return recorded === null ? 'unavailable' : 'vendor_default';
}

/**
 * Pair a probed provider with the recorded model ONLY when the two describe the
 * same model.
 *
 * `probe.provider` is the provider of the ACCOUNT DEFAULT model the probe
 * reported — it is a fact about that model, not about whatever model this
 * attempt ended up running. The selected model may instead come from a
 * task-spec/env pin OR from a machine-local state file (codex-model.json /
 * kimi-model.json), and either can name a model belonging to a COMPLETELY
 * DIFFERENT provider than the account default. Attaching `probe.provider` to
 * such a model records a provider that may not even be valid for it. So the
 * probe's provider travels only with the probe's own model; anything else is
 * honestly null.
 */
export function providerForModel(
  resolvedModel: string | null,
  probe: VendorProbeResult,
): string | null {
  // Equality also covers the unpinned path (resolvedModel IS probe.model). The
  // non-null guard handles the both-null case: the probe parser reads `model`
  // and `provider` independently, so a partial/malformed doctor report can
  // report `model: null` alongside a non-null provider. `null === null` would
  // otherwise attach that ORPHAN provider to an attempt that has no resolved
  // model to attach it to — no model means no provider, honestly null.
  return resolvedModel !== null && resolvedModel === probe.model ? probe.provider : null;
}

/**
 * Attempt-level summary of the two per-field classifications. An explicit pin
 * anywhere makes the attempt `pinned`; otherwise the model's classification
 * carries, since it is the field a cross-vendor comparison hinges on.
 */
export function aggregateSource(model: ModelSource, effort: ModelSource): ModelSource {
  return model === 'pinned' || effort === 'pinned' ? 'pinned' : model;
}

/**
 * Read the vendor-neutral `model:` / `effort:` task-spec pins.
 *
 * `yamlScalar` needs a real file; a spec path that does not exist yields ''.
 */
export function vendorSpecPins(taskSpec: string): { model: string; effort: string } {
  return {
    model: yamlScalar(taskSpec, 'model'),
    effort: yamlScalar(taskSpec, 'effort'),
  };
}

interface CodexResolution {
  provenance: ModelProvenance;
  /** Extra argv the pin contributes, inserted before the positional args. */
  pinArgs: string[];
}

function resolveCodexModel(taskSpec: string, options: AdapterCodexOptions): CodexResolution {
  const pins = vendorSpecPins(taskSpec);
  const model = resolveVendorPin(
    options.model,
    pins.model,
    process.env.HYDRA_CODEX_MODEL,
    readVendorStateDefault(options.stateRoot, 'codex-model.json', 'model'),
  );
  const effort = resolveVendorPin(
    options.effort,
    pins.effort,
    process.env.HYDRA_CODEX_EFFORT,
    readVendorStateDefault(options.stateRoot, 'codex-model.json', 'effort'),
  );

  const pinArgs: string[] = [];
  if (model.value) pinArgs.push('-m', model.value);
  // `--strict-config` accepts model_reasoning_effort, so this is a recognized
  // key rather than an override codex would silently drop.
  if (effort.value) pinArgs.push('-c', `model_reasoning_effort="${effort.value}"`);

  // Only probe when we actually need the account default; a pinned run already
  // knows its model and the probe costs a ~1s subprocess.
  const probe = (options.probe ?? probeCodex)();

  const resolvedModel = model.value ?? probe.model;
  // Recoverable only from the vendor's private rollout when unpinned, so an
  // unpinned run records null rather than guessing codex's built-in default.
  const resolvedEffort = effort.value;
  // Both pins are genuinely honored here (`-m` and `-c model_reasoning_effort`),
  // so each field is classified on its own pin, not on the model's.
  const modelSource = classifyPinSource(model, resolvedModel);
  const effortSource = classifyPinSource(effort, resolvedEffort);

  return {
    provenance: {
      model: resolvedModel,
      // The doctor report's provider describes the ACCOUNT DEFAULT model. It is
      // attached only when the model we actually run IS that model — a pin OR a
      // machine-local codex-model.json default can select a model from an
      // entirely different provider, and claiming the account's provider for it
      // would be a fabrication.
      provider: providerForModel(resolvedModel, probe),
      cli_version: probe.cliVersion,
      effort: resolvedEffort,
      source: aggregateSource(modelSource, effortSource),
      model_source: modelSource,
      effort_source: effortSource,
    },
    pinArgs,
  };
}

// ---------------------------------------------------------------------------
// Prompt builder — the SHARED builder (build-worker-prompt.ts) so codex
// receives the same amendment_reason / amendment_check / revision-evidence
// manifest contract as every other vendor adapter.
// ---------------------------------------------------------------------------
export { buildWorkerPrompt };

// ---------------------------------------------------------------------------
// Default command runners.
// ---------------------------------------------------------------------------

export function defaultExec(
  command: string,
  args: string[],
  options?: { encoding?: BufferEncoding; cwd?: string; stdio?: any },
): string {
  return String(execFileSync(command, args, options));
}

export function defaultSpawn(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdin?: 'ignore';
    stdout?: string;
    stderr?: string;
  },
): RunResult {
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;

  try {
    stdoutFd = options.stdout ? openSync(options.stdout, 'w') : undefined;
    stderrFd = options.stderr ? openSync(options.stderr, 'w') : undefined;
    const stdio: [NodeStdio, NodeStdio, NodeStdio] = [
      options.stdin ?? 'ignore',
      stdoutFd ?? 'pipe',
      stderrFd ?? 'pipe',
    ];
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      // Strip BUN_BE_BUN so a leaked BUN_BE_BUN=1 cannot hijack a Bun-compiled
      // child (spike: docs/bun-migration-spike-results.md); Bun omits env keys
      // whose value is undefined.
      env: { ...process.env, BUN_BE_BUN: undefined },
      stdio,
    });

    let exitCode: number | null;
    // Loose `!= null`: Bun reports `status: undefined` (not null) on spawn
    // error; strict `!== null` would misbranch there. Node behavior (null on
    // error) is unchanged.
    if (result.status != null) {
      exitCode = result.status;
    } else if (result.signal) {
      exitCode = null;
    } else if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      exitCode = code === 'EACCES' ? 126 : 127;
    } else {
      exitCode = 1;
    }

    return { exitCode, signal: result.signal ?? null };
  } catch {
    return { exitCode: 127, signal: null };
  } finally {
    if (stderrFd !== undefined) {
      try {
        closeSync(stderrFd);
      } catch {
        // The command result remains authoritative; still attempt the other close.
      }
    }
    if (stdoutFd !== undefined) {
      try {
        closeSync(stdoutFd);
      } catch {
        // Match the adapter's best-effort `codex ... || true` execution path.
      }
    }
  }
}

type NodeStdio = 'pipe' | 'ignore' | 'inherit' | number;

// ---------------------------------------------------------------------------
// JSONL session-id extraction.
// ---------------------------------------------------------------------------

function extractSessionId(jsonlPath: string): string {
  if (!existsSync(jsonlPath)) return '';
  const lines = readFileSync(jsonlPath, 'utf8').split('\n');
  const ids: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return '';
    }
    if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
      return '';
    }
    const obj = data === null ? {} : (data as Record<string, unknown>);
    let candidate = obj.thread_id;
    if (candidate === undefined || candidate === null || candidate === false) {
      if (
        obj.msg !== undefined &&
        obj.msg !== null &&
        (typeof obj.msg !== 'object' || Array.isArray(obj.msg))
      ) {
        return '';
      }
      const msg = (obj.msg ?? {}) as Record<string, unknown>;
      candidate = jqAlternative(msg.session_id, obj.session_id);
    }
    if (candidate !== undefined && candidate !== null && candidate !== false && candidate !== '') {
      ids.push(jqRawString(candidate));
    }
  }
  return ids.at(-1) ?? '';
}

/** jq's `//` falls through only for null, false, or a missing value. */
function jqAlternative(value: unknown, fallback: unknown): unknown {
  return value === undefined || value === null || value === false ? fallback : value;
}

function jqRawString(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

function parseArgJson(value: string): unknown {
  return JSON.parse(value);
}

function deriveDropFromGitWithExec(
  taskSpec: string,
  worktree: string,
  vendor: string,
  sessionId: string,
  outJson: string,
  runExec: ExecLike,
): boolean {
  const base = yamlScalar(taskSpec, 'base_commit');
  let head: string;
  try {
    head = runExec('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return false;
  }
  if (!head) return false;

  let baseHead: string;
  try {
    baseHead = runExec('git', ['-C', worktree, 'rev-parse', base], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return false;
  }
  if (baseHead === head) return false;

  let files: string[] = [];
  try {
    files = runExec('git', ['-C', worktree, 'diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    files = [];
  }

  const result = {
    task_id: yamlScalar(taskSpec, 'task_id'),
    run_id: yamlScalar(taskSpec, 'run_id'),
    spec_version: parseArgJson(yamlScalar(taskSpec, 'spec_version')),
    vendor,
    session_id: sessionId,
    status: 'completed',
    branch: yamlScalar(taskSpec, 'branch'),
    base_commit: base,
    head_commit: head,
    summary: 'harness-derived from git (worker committed without a self-report)',
    files_changed: files,
    verification_claims: [],
    risks: ['no worker self-report; drop derived from git evidence'],
    unresolved_questions: [],
    suggested_additional_checks: [],
  };
  writeFileSync(outJson, `${JSON.stringify(result)}\n`);
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

/**
 * Build the codex argv for one dispatch.
 *
 * The cold-start form is `codex exec --json -C <worktree> -s workspace-write`.
 * The resume form is the vendor's own `codex exec resume [SESSION_ID] [PROMPT]`
 * subcommand (verified against the installed CLI's `codex exec resume --help`;
 * `codex resume` without `exec` is the INTERACTIVE picker/TUI, which would
 * never terminate in a headless worker). That subcommand accepts neither `-C`
 * nor `-s`, so their config-file equivalents travel through the `-c` overrides
 * it does accept (`sandbox_mode`; both keys confirmed against
 * `--strict-config`, which rejects unknown fields), and the working directory
 * comes from the spawn's own `cwd` — which is already the worktree on both
 * paths.
 */
function buildCodexArgs(
  verb: 'start' | 'resume',
  worktree: string,
  gitCommon: string,
  prompt: string,
  priorSessionId: string,
  pinArgs: string[] = [],
): string[] {
  const writableRoots = `sandbox_workspace_write.writable_roots=["${gitCommon}"]`;
  // `-m/--model` and `-c model_reasoning_effort=...` are accepted by BOTH the
  // cold-start form and the `exec resume` subcommand (verified against
  // `codex exec --help` and `codex exec resume --help` on codex-cli 0.144.6),
  // so a pin survives an amendment resume instead of silently reverting.
  if (verb === 'resume' && priorSessionId) {
    return [
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      writableRoots,
      ...pinArgs,
      priorSessionId,
      prompt,
    ];
  }
  return [
    'exec',
    '--json',
    '-C',
    worktree,
    '-s',
    'workspace-write',
    '-c',
    writableRoots,
    ...pinArgs,
    prompt,
  ];
}

/**
 * Codex CLI worker adapter — TypeScript port of hydra/adapters/codex.sh.
 *
 * Runs the codex CLI in JSONL mode in the assigned worktree with a
 * workspace-write sandbox, adds the git-common-dir as a writable root,
 * captures the thread_id from the JSONL event stream, and bridges the worker's
 * `.hydra-result.json` into the run inbox. Everything except the vendor argv
 * is shared between the two verbs:
 *   start  <task_spec> <worktree> <inbox> <sessions> <agent_run_id>
 *   resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> <prior_session_id>
 *
 * @param verb - "start" or "resume"
 * @param taskSpec - path to the task specification YAML
 * @param worktree - path to the assigned worktree
 * @param inbox - path to the adapter-owned inbox directory
 * @param sessions - path to the session capture directory
 * @param agentRunId - unique id for this agent run
 * @param priorSessionId - session to resume (resume verb only)
 * @param options - optional overrides for cwd/exec/spawn
 * @returns the agent_run_id
 */
export async function adapterCodex(
  verb: string,
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId?: string,
  options: AdapterCodexOptions = {},
): Promise<string> {
  if (!verb) {
    die('usage: codex.sh start|resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session_id]');
  }
  if (verb !== 'start' && verb !== 'resume') {
    die(`codex.sh: unknown verb '${verb}'`);
  }
  if (!taskSpec) die('task_spec required');
  if (!worktree) die('worktree required');
  if (!inbox) die('inbox required');
  if (!sessions) die('sessions required');
  if (!agentRunId) die('agent_run_id required');

  const cwd = options.cwd ?? process.cwd();
  const resolvedTaskSpec = resolve(cwd, taskSpec);
  const resolvedWorktree = resolve(cwd, worktree);
  const resolvedInbox = resolve(cwd, inbox);
  const resolvedSessions = resolve(cwd, sessions);

  const resultPath = resolve(resolvedInbox, 'result.json');
  const workerResult = resolve(resolvedWorktree, '.hydra-result.json');

  mkdirSync(resolvedInbox, { recursive: true });
  mkdirSync(resolvedSessions, { recursive: true });
  rmSync(workerResult, { force: true });

  const prompt = buildWorkerPrompt(resolvedTaskSpec);

  const runExec = options.exec ?? defaultExec;
  const runSpawn = options.spawn ?? defaultSpawn;

  const gitCommon = runExec(
    'git',
    ['-C', resolvedWorktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
  )
    .toString()
    .trim();

  const cliJsonl = resolve(resolvedSessions, `${agentRunId}.cli.jsonl`);
  const cliStderr = resolve(resolvedSessions, `${agentRunId}.stderr`);

  const { provenance, pinArgs } = resolveCodexModel(resolvedTaskSpec, options);
  const codexArgs = buildCodexArgs(
    verb, resolvedWorktree, gitCommon, prompt, priorSessionId ?? '', pinArgs,
  );
  if (verb === 'resume' && priorSessionId) {
    log(`codex resume from session ${priorSessionId}`);
  }
  if (provenance.model_source === 'pinned') {
    log(`codex model pin honored: ${provenance.model}`
      + `${provenance.effort_source === 'pinned' ? ` effort=${provenance.effort}` : ''}`);
  } else if (provenance.effort_source === 'pinned') {
    // An effort-only pin is still a pin; it must not be silent just because
    // the model came from the account default.
    log(`codex effort pin honored: ${provenance.effort} (model: account default)`);
  }

  try {
    await runSpawn(
      'codex',
      codexArgs,
      {
        cwd: resolvedWorktree,
        stdin: 'ignore',
        stdout: cliJsonl,
        stderr: cliStderr,
      },
    );
  } catch {
    // Bash runs codex with `|| true`; failures are handled by the fallback
    // result synthesis below.
  }

  const sessionId = extractSessionId(cliJsonl);

  // Provenance keys are ALWAYS present (explicit null when unrecoverable) so a
  // consumer can distinguish "this vendor cannot report it" from "nobody
  // looked" — dispatch.ts reads this file back to emit worker_model_resolved.
  writeFileSync(
    resolve(resolvedSessions, `${agentRunId}.json`),
    `${JSON.stringify({
      agent_run_id: agentRunId,
      vendor: 'codex',
      session_id: sessionId,
      ...provenance,
    })}\n`,
  );

  if (existsSync(workerResult)) {
    let workerData: unknown;
    try {
      workerData = JSON.parse(readFileSync(workerResult, 'utf8'));
    } catch {
      workerData = null;
    }
    if (workerData && typeof workerData === 'object' && !Array.isArray(workerData)) {
      const data = workerData as Record<string, unknown>;
      const result = {
        ...data,
        vendor: 'codex',
        session_id: jqAlternative(data.session_id, sessionId),
      };
      writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
      process.stdout.write(`${agentRunId}\n`);
      return agentRunId;
    }
    if (workerData !== null && workerData !== false) {
      throw new TypeError('worker result must be a JSON object');
    }
  }

  if (
    deriveDropFromGitWithExec(
      resolvedTaskSpec,
      resolvedWorktree,
      'codex',
      sessionId,
      resultPath,
      runExec,
    )
  ) {
    log('codex committed without a self-report; drop derived from git evidence');
    process.stdout.write(`${agentRunId}\n`);
    return agentRunId;
  }

  const taskId = yamlScalar(resolvedTaskSpec, 'task_id');
  const runId = yamlScalar(resolvedTaskSpec, 'run_id');
  const specVersion = parseArgJson(yamlScalar(resolvedTaskSpec, 'spec_version') || '1');
  const branch = yamlScalar(resolvedTaskSpec, 'branch');
  const baseCommit = yamlScalar(resolvedTaskSpec, 'base_commit');

  const failedResult = {
    task_id: taskId,
    run_id: runId,
    spec_version: specVersion,
    vendor: 'codex',
    session_id: sessionId,
    status: 'failed',
    branch,
    base_commit: baseCommit,
    head_commit: baseCommit,
    summary: 'worker produced no result drop',
    files_changed: [] as string[],
    verification_claims: [] as Array<{ command: string; status: string }>,
    risks: ['adapter synthesized a failed drop'],
    unresolved_questions: [] as string[],
    suggested_additional_checks: [] as string[],
  };
  writeFileSync(resultPath, `${JSON.stringify(failedResult)}\n`);

  process.stdout.write(`${agentRunId}\n`);
  return agentRunId;
}

/** Convenience wrapper for the `start` verb. */
export async function start(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  options: AdapterCodexOptions = {},
): Promise<string> {
  return adapterCodex('start', taskSpec, worktree, inbox, sessions, agentRunId, undefined, options);
}

/** Convenience wrapper for the `resume` verb (mirrors adapter-kimi.ts's `resume()`). */
export async function resume(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId: string,
  options: AdapterCodexOptions = {},
): Promise<string> {
  return adapterCodex(
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

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const [verb, taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId] = args;
    await adapterCodex(verb, taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain =
  !isCompiledBinary() &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await main();
}
