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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, deriveDropFromGit, log, warn, yamlList, yamlScalar } from './lib.ts';
import {
  aggregateSource,
  classifyPinSource,
  providerForModel,
  readVendorStateDefault,
  resolveVendorPin,
  vendorProbeEnabled,
  vendorSpecPins,
  type ModelProvenance,
  type VendorProbe,
  type VendorProbeResult,
} from './adapter-codex.ts';
import { buildWorkerPrompt as buildSharedWorkerPrompt } from './build-worker-prompt.ts';
import { isCompiledBinary } from './kit-assets.ts';
import { deriveEnvironmentDomainsDetailed, formatDerivedDomainsLog, persistDerivedDomains } from './env-domains.ts';
import { prepareWorkerEnv } from './worker-devenv.ts';

// ---------------------------------------------------------------------------
// Kimi CLI adapter (TypeScript port of hydra/adapters/kimi.sh).
//
// Supports three verbs:
//   visual  - read-only multimodal analysis
//   start   - sandboxed write role
//   resume  - sandboxed write role continuing a prior Kimi session (-S <id>)
//
// External CLIs are injectable via the options bag so tests never invoke real
// vendor binaries.
// ---------------------------------------------------------------------------

export type SpawnLike = (
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcess;

export type CommandExists = (command: string) => boolean;

export type SrtSettingsFactory = (
  settingsPath: string,
  roots: string[],
  allowedDomains: string[],
) => string;

export interface KimiAdapterOptions {
  /** Working directory used to resolve relative paths (tests). */
  cwd?: string;
  /** Directory containing the optional machine-local kimi-model.json default. */
  stateRoot?: string;
  /** Injected exec implementation for git and synchronous CLIs. */
  exec?: typeof execFileSync;
  /** Injected spawn implementation for streaming CLI invocations. */
  spawn?: SpawnLike;
  /** Injected command lookup so tests never probe real vendor/tool CLIs. */
  commandExists?: CommandExists;
  /** Override the production baseline-domain file (tests). */
  sandboxDomainsPath?: string;
  /** Injected settings factory for exercising the hard refusal gate. */
  makeSrtSettings?: SrtSettingsFactory;
  /** Injected worker dev-environment preflight (tests). */
  prepareWorkerEnv?: typeof prepareWorkerEnv;
  /** Explicit model override for injected callers and tests (outranks the spec pin). */
  model?: string;
  /** Explicit effort override; recorded but NOT honorable — see resolveKimiModel. */
  effort?: string;
  /** Injected vendor probe so tests never shell out to the real kimi CLI. */
  probe?: VendorProbe;
}

// ---------------------------------------------------------------------------
// Model / effort provenance (issue #42).
//
// INVESTIGATION (kimi 0.29.1, verified against the installed CLI):
//
//   * The `--output-format stream-json` NDJSON this adapter already captures to
//     `<agent_run_id>.cli.jsonl` carries NO model information. A full run emits
//     only `{"role":"assistant","content":...}` records plus the single
//     `{"role":"meta","type":"session.resume_hint",...}` event the resume path
//     already consumes — that meta event has session_id/command/content and no
//     model-shaped field, so the existing meta-event pattern cannot be
//     extended to carry it without a vendor change.
//   * `kimi doctor` only validates config-file syntax; it reports no model.
//   * `kimi provider list` DOES print the resolved account default as a
//     `Default model: <alias>` line, and `kimi provider list --json` emits the
//     alias -> {provider, model} map. Both are supported non-interactive
//     config queries — no private session state is read. (The `--json` form
//     omits the default alias, hence the two-call probe below.)
//   * `kimi --version` gives the CLI version.
//
// Pinning: `-m/--model <alias>` is real ("LLM model alias to use for this
// invocation. Defaults to default_model in config.toml"). There is NO
// reasoning-effort flag anywhere in `kimi --help` or its subcommands, so an
// `effort:` pin CANNOT be honored for this vendor and is warned about loudly
// rather than silently dropped.
// ---------------------------------------------------------------------------

const KIMI_DEFAULT_MODEL_RE = /^\s*Default model:\s*(\S+)\s*$/m;

/** `kimi provider list [--json]` — supported config queries, not session state. */
export function probeKimi(): VendorProbeResult {
  if (!vendorProbeEnabled()) return { model: null, provider: null, cliVersion: null };

  const run = (args: string[]): string | null => {
    try {
      return String(execFileSync('kimi', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch {
      return null;
    }
  };

  const version = run(['--version']);
  const listing = run(['provider', 'list']);
  const model = listing ? (KIMI_DEFAULT_MODEL_RE.exec(listing)?.[1] ?? null) : null;

  let provider: string | null = null;
  if (model !== null) {
    const raw = run(['provider', 'list', '--json']);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Record<string, any>;
        const entry = parsed?.models?.[model];
        if (entry && typeof entry.provider === 'string') provider = entry.provider;
      } catch {
        // A shape change must degrade to null, never break the dispatch.
      }
    }
  }

  return { model, provider, cliVersion: version ? version.trim() : null };
}

interface KimiResolution {
  provenance: ModelProvenance;
  /** Extra argv the pin contributes. */
  pinArgs: string[];
}

/**
 * Same precedence shape as adapter-opencode's resolveModel(): explicit
 * injection > task-spec `model:` pin > HYDRA_KIMI_MODEL > machine-local
 * kimi-model.json > the vendor's own default.
 */
function resolveKimiModel(taskSpec: string, options: KimiAdapterOptions): KimiResolution {
  const pins = vendorSpecPins(taskSpec);
  const model = resolveVendorPin(
    options.model,
    pins.model,
    process.env.HYDRA_KIMI_MODEL,
    readVendorStateDefault(options.stateRoot, 'kimi-model.json', 'model'),
  );
  const effort = resolveVendorPin(
    options.effort,
    pins.effort,
    process.env.HYDRA_KIMI_EFFORT,
    readVendorStateDefault(options.stateRoot, 'kimi-model.json', 'effort'),
  );

  // A pin that cannot take effect must be loud, never silently ignored.
  if (effort.value) {
    warn(
      `kimi adapter cannot pin reasoning effort ('${effort.value}' requested): the kimi CLI `
      + 'exposes no effort/reasoning flag — inheriting the account default. '
      + 'Recorded as effort=null so the ledger does not claim an effort that never applied.',
    );
  }

  const pinArgs = model.value ? ['-m', model.value] : [];
  const probe = (options.probe ?? probeKimi)();
  const resolvedModel = model.value ?? probe.model;

  const modelSource = classifyPinSource(model, resolvedModel);
  // Structurally unrecoverable for this vendor: no flag to set it, and nothing
  // in the stream or any config query reports it. An effort pin that could not
  // be honored is therefore NOT `pinned` — classifyPinSource sees the recorded
  // null and says `unavailable`, matching the warning emitted above.
  const effortSource = classifyPinSource(effort, null);

  return {
    provenance: {
      model: resolvedModel,
      // `provider list` reports the provider of the DEFAULT alias. A pin OR a
      // machine-local kimi-model.json default can select a different alias
      // backed by a different provider, so the probed provider is recorded only
      // when the alias we run is the one the probe described.
      provider: providerForModel(resolvedModel, probe),
      cli_version: probe.cliVersion,
      effort: null,
      source: aggregateSource(modelSource, effortSource),
      model_source: modelSource,
      effort_source: effortSource,
    },
    pinArgs,
  };
}

function defaultCommandExists(command: string): boolean {
  try {
    execFileSync('/bin/sh', [
      '-c',
      'command -v "$1" >/dev/null 2>&1',
      'hydra-command-exists',
      command,
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function requireKimi(commandExists: CommandExists): void {
  if (!commandExists('kimi')) {
    die('kimi CLI not found (Wave 2 dependency)');
  }
}

// ---------------------------------------------------------------------------
// Prompt builder (port of hydra/adapters/build-worker-prompt.sh).
// ---------------------------------------------------------------------------

/**
 * Compile the worker protocol + task spec into the prompt the worker receives.
 *
 * Delegates to the SHARED builder (build-worker-prompt.ts): amendment_reason,
 * amendment_check, and the compact revision-evidence manifest summary render
 * identically for kimi and every other vendor adapter. The legacy options bag
 * is kept for call-site compatibility.
 */
export function buildWorkerPrompt(
  taskSpec: string,
  _options: Pick<KimiAdapterOptions, 'exec'> = {},
): string {
  return buildSharedWorkerPrompt(taskSpec);
}

// ---------------------------------------------------------------------------
// srt settings generation.
// ---------------------------------------------------------------------------

export interface SrtSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
  };
}

/**
 * Kimi CLI provider endpoints that must always be reachable from inside the
 * sandbox for the CLI to function at all. Used as the baseline fallback when
 * the operator's kimi-sandbox-domains.json is missing or invalid.
 */
export const KIMI_PROVIDER_DOMAINS = ['api.kimi.com', 'api.moonshot.ai', 'api.moonshot.cn'];

/**
 * Write an srt settings file that permits network access only to the merged
 * domain allowlist and writes only beneath the supplied roots.
 *
 * NOTE on git-metadata protection: srt (@anthropic-ai/sandbox-runtime)
 * unconditionally blocks writes to `.git/config` and `.git/hooks/*` under
 * ANY `.git` directory nested inside an allowed write root ("Mandatory Deny
 * Paths" in srt's README) — sound in intent (a writable git hook/config is a
 * code-execution escape once the host later runs git), but there is no
 * settings-file knob to scope it to only the worktree's real `.git` dir; it
 * is filename-scoped, not path-scoped, so it also fires on ephemeral `.git`
 * dirs a package manager creates while cloning a git-hosted dependency
 * (e.g. pnpm's `.pnpm-store/v11/tmp/<x>/.git/`). We do not attempt to work
 * around it here — see kimiStart's `npm_config_store_dir` override, which
 * keeps pnpm's store (and its ephemeral clones) out of any `.git`-adjacent
 * path entirely.
 */
export function makeSrtSettings(
  settingsPath: string,
  roots: string[],
  allowedDomains: string[],
): string {
  const allowWrite: string[] = [];

  // The herdr status hook connects to herdr's unix socket to report
  // working/idle/blocked. Without this the pane shows a stale "idle".
  const herdrSocketDir = process.env.HERDR_SOCKET_DIR;
  if (herdrSocketDir) {
    allowWrite.push(herdrSocketDir);
  } else if (existsSync(join(process.env.HOME ?? '', '.config/herdr'))) {
    allowWrite.push(`${process.env.HOME}/.config/herdr`);
  }

  for (const root of roots) {
    if (!root) continue;
    if (!allowWrite.includes(root)) allowWrite.push(root);
  }

  const settings: SrtSettings = {
    network: { allowedDomains: [...new Set(allowedDomains)], deniedDomains: [] },
    filesystem: { allowWrite, denyWrite: [], denyRead: [] },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

function validStringArray(value: unknown, requireNonEmpty = false): value is string[] {
  return Array.isArray(value)
    && (!requireNonEmpty || value.length > 0)
    && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isValidAllowedDomain(value: string): boolean {
  if (value.includes('://') || value.includes('/') || value.includes(':')) return false;
  if (value === 'localhost') return true;
  if (value.startsWith('*.')) {
    const domain = value.slice(2);
    const parts = domain.split('.');
    return domain.includes('.')
      && !domain.startsWith('.')
      && !domain.endsWith('.')
      && parts.length >= 2
      && parts.every((part) => part.length > 0);
  }
  if (value.includes('*')) return false;
  return value.includes('.') && !value.startsWith('.') && !value.endsWith('.');
}

function isValidSrtSettings(value: unknown): value is SrtSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.network !== 'object' || record.network === null) return false;
  if (typeof record.filesystem !== 'object' || record.filesystem === null) return false;
  const network = record.network as Record<string, unknown>;
  const filesystem = record.filesystem as Record<string, unknown>;
  return validStringArray(network.allowedDomains, true)
    && network.allowedDomains.every(isValidAllowedDomain)
    && validStringArray(network.deniedDomains)
    && validStringArray(filesystem.allowWrite, true)
    && validStringArray(filesystem.denyWrite)
    && validStringArray(filesystem.denyRead);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// JSONL parsing helpers (replacements for jq).
// ---------------------------------------------------------------------------

function parseJsonLines(jsonlPath: string): unknown[] | undefined {
  if (!existsSync(jsonlPath)) return undefined;
  const lines = readFileSync(jsonlPath, 'utf8').split('\n');
  const values: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // jq -s rejects the complete stream when any input value is malformed.
      return undefined;
    }
  }
  return values;
}

function jqRawString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null || value === false) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseLastSessionId(jsonlPath: string): string {
  const values = parseJsonLines(jsonlPath);
  if (!values) return '';
  let sessionId: unknown;
  for (const data of values) {
    if (typeof data === 'object' && data !== null) {
      const sid = (data as Record<string, unknown>).session_id;
      if (sid !== undefined && sid !== null && sid !== false && sid !== '') sessionId = sid;
    }
  }
  return jqRawString(sessionId);
}

function parseLastAssistantText(jsonlPath: string): string {
  const values = parseJsonLines(jsonlPath);
  if (!values) return '';
  let lastContent: unknown;
  for (const data of values) {
    if (typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      if (record.role === 'assistant') lastContent = record.content;
    }
  }
  return jqRawString(lastContent);
}

// ---------------------------------------------------------------------------
// Streaming CLI runner.
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number | null;
}

/**
 * Run a streaming CLI, capturing stdout/stderr to files. When teeStderr is true,
 * stderr is also passed through to process.stderr so a hosting pane shows live
 * progress. Errors and non-zero exits are swallowed to match the bash `|| true`.
 */
function runStreaming(
  command: string,
  args: string[],
  options: {
    cwd: string;
    stdoutPath: string;
    stderrPath: string;
    teeStderr: boolean;
    spawn: SpawnLike;
    /** Extra env vars merged over process.env for the spawned child (e.g. per-task package-manager store/cache dirs from worker-devenv.ts). Values are always concrete strings — permitting undefined here would ambiguously set-or-drop the var depending on spawn's env stringification. */
    envOverrides?: Record<string, string>;
  },
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    mkdirSync(dirname(options.stdoutPath), { recursive: true });
    mkdirSync(dirname(options.stderrPath), { recursive: true });
    writeFileSync(options.stdoutPath, '');
    writeFileSync(options.stderrPath, '');

    let stdoutDone = false;
    let stderrDone = false;
    let exitCode: number | null | undefined = undefined;
    let settled = false;

    function finish(): void {
      if (settled || stdoutDone === false || stderrDone === false || exitCode === undefined) {
        return;
      }
      settled = true;
      resolvePromise({ exitCode });
    }

    let child: ChildProcess;
    try {
      child = options.spawn(command, args, {
        cwd: options.cwd,
        // Strip BUN_BE_BUN so a leaked BUN_BE_BUN=1 cannot hijack a Bun-compiled
        // child (spike: docs/bun-migration-spike-results.md); Bun omits env keys
        // whose value is undefined.
        env: { ...process.env, BUN_BE_BUN: undefined, ...options.envOverrides },
        // `SpawnOptionsWithoutStdio['stdio']` (the injected SpawnLike's option
        // type) is typed as StdioPipeNamed | StdioPipe[], which excludes
        // "ignore" even though it's a valid StdioOptions value at runtime.
        stdio: ['ignore', 'pipe', 'pipe'] as unknown as SpawnOptionsWithoutStdio['stdio'],
      });
    } catch {
      resolvePromise({ exitCode: null });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      writeFileSync(options.stdoutPath, chunk, { flag: 'a' });
    });
    child.stdout?.on('end', () => {
      stdoutDone = true;
      finish();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      writeFileSync(options.stderrPath, chunk, { flag: 'a' });
      if (options.teeStderr) process.stderr.write(chunk);
    });
    child.stderr?.on('end', () => {
      stderrDone = true;
      finish();
    });

    child.on('exit', (code) => {
      exitCode = code ?? null;
      finish();
    });

    child.on('error', () => {
      exitCode = null;
      stdoutDone = true;
      stderrDone = true;
      finish();
    });
  });
}

// ---------------------------------------------------------------------------
// Verbs.
// ---------------------------------------------------------------------------

/**
 * Read-only multimodal analysis. No sandbox is needed because no writes are
 * requested. The output prefix receives .jsonl, .stderr, .txt, and .session.json.
 *
 * @returns path to the generated <outPrefix>.txt file
 */
export async function kimiVisual(
  cwd: string,
  prompt: string,
  outPrefix: string,
  agentRunId: string,
  image?: string,
  options: KimiAdapterOptions = {},
): Promise<string> {
  const commandExists = options.commandExists ?? defaultCommandExists;
  requireKimi(commandExists);

  if (!cwd || !prompt || !outPrefix || !agentRunId) {
    die('usage: kimiVisual(cwd, prompt, outPrefix, agentRunId, [image])');
  }

  const spawnFn = options.spawn ?? spawn;
  const cwdAbs = resolve(options.cwd ?? process.cwd(), cwd);

  mkdirSync(dirname(outPrefix), { recursive: true });

  // Attach an image by referencing its path in the prompt; video/screenshots are
  // supported the same way.
  let fullPrompt = prompt;
  if (image) {
    fullPrompt = `${prompt}\n\nImage to analyze: ${image}`;
  }

  const args = [
    '-p', fullPrompt,
    '--output-format', 'stream-json',
    '--add-dir', cwd,
  ];
  if (image) {
    args.push('--add-dir', dirname(image));
  }

  const jsonlPath = `${outPrefix}.jsonl`;
  const stderrPath = `${outPrefix}.stderr`;

  // Block until kimi finishes, ignoring failures (`|| true`).
  await runStreaming('kimi', args, {
    cwd: cwdAbs,
    stdoutPath: jsonlPath,
    stderrPath,
    teeStderr: false,
    spawn: spawnFn,
  });

  const lastText = parseLastAssistantText(jsonlPath);
  writeFileSync(`${outPrefix}.txt`, lastText, 'utf8');

  const sessionId = parseLastSessionId(jsonlPath);
  writeFileSync(
    `${outPrefix}.session.json`,
    `${JSON.stringify({
      agent_run_id: agentRunId,
      vendor: 'kimi',
      role: 'visual_debugging',
      session_id: sessionId,
    })}\n`,
  );

  log(`kimi visual_debugging done (session=${sessionId})`);
  return `${outPrefix}.txt`;
}

/**
 * Run the Kimi adapter for the given verb (mirrors adapter-claude.ts's
 * `claude()`):
 *   start  <task_spec> <worktree> <inbox_dir> <sessions_dir> <agent_run_id>
 *   resume <task_spec> <worktree> <inbox_dir> <sessions_dir> <agent_run_id> <prior_session_id>
 *
 * Sandboxed write role. Confines kimi with srt to the worktree,
 * git-common-dir, and a handful of system paths, then bridges the worker's
 * in-worktree result into the inbox. On `resume` the SAME full worker prompt
 * is re-sent together with `-S <prior_session_id>` (the Kimi CLI's
 * `--session` flag): the vendor's own session history provides continuity
 * while the full boilerplate re-anchors guardrails against context drift —
 * the same design as adapter-claude.ts's `--resume` path.
 *
 * @returns the agent_run_id
 */
export async function kimi(
  verb: 'start' | 'resume',
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId?: string,
  options: KimiAdapterOptions = {},
): Promise<string> {
  const commandExists = options.commandExists ?? defaultCommandExists;
  requireKimi(commandExists);
  if (!commandExists('srt')) {
    die('no OS sandbox (srt) — refusing Kimi write role (auto-approves tools)');
  }

  if (!taskSpec || !worktree || !inbox || !sessions || !agentRunId) {
    die('usage: kimi(verb, taskSpec, worktree, inbox, sessions, agentRunId, [priorSessionId])');
  }
  if (verb !== 'start' && verb !== 'resume') {
    die(`kimi: unknown verb '${verb}'`);
  }

  const exec = options.exec ?? execFileSync;
  const spawnFn = options.spawn ?? spawn;
  const cwd = options.cwd ?? process.cwd();

  const worktreeAbs = resolve(cwd, worktree);
  const inboxAbs = resolve(cwd, inbox);
  const sessionsAbs = resolve(cwd, sessions);
  const resultPath = join(inboxAbs, 'result.json');
  const workerResult = join(worktreeAbs, '.hydra-result.json');

  mkdirSync(inboxAbs, { recursive: true });
  mkdirSync(sessionsAbs, { recursive: true });
  if (existsSync(workerResult)) rmSync(workerResult);

  const prompt = buildWorkerPrompt(taskSpec, { exec });

  // Physical paths so srt allowWrite matching works (/var -> /private/var).
  const wtAbs = realpathSync(worktreeAbs);
  const gitCommonRaw = exec('git', ['-C', worktreeAbs, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  const gitCommon = realpathSync(gitCommonRaw);

  // Worker dev-environment preflight: verify git/node/the repo's declared
  // package manager (+ 'kimi' itself) resolve on the same PATH the pane
  // shell gets, and compute per-task package-manager store/cache dirs under
  // TMPDIR — fails fast here, at dispatch, rather than mid-task. See
  // worker-devenv.ts for the field evidence this preflight is built from.
  const prepareEnv = options.prepareWorkerEnv ?? prepareWorkerEnv;
  const devenv = await prepareEnv(wtAbs, taskSpec, { agentRunId, vendorBin: 'kimi' });

  const baselinePath = options.sandboxDomainsPath
    ?? join(process.env.HOME ?? '', '.local/state/hydra/kimi-sandbox-domains.json');
  let baselineDomains: unknown;
  try {
    baselineDomains = (JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>)
      .allowedDomains;
  } catch {
    baselineDomains = undefined;
  }
  const taskDomains = yamlList(taskSpec, 'network_domains');
  let baseline: string[];
  if (validStringArray(baselineDomains, true)) {
    baseline = baselineDomains;
  } else {
    // A machine without the operator baseline must not produce an empty
    // allowlist: that blocks the Kimi CLI's own provider endpoints and every
    // dispatch dies with provider.connection_error after its retry budget.
    log(`kimi: sandbox baseline missing or invalid at ${baselinePath}; falling back to provider domains (${KIMI_PROVIDER_DOMAINS.join(', ')})`);
    baseline = KIMI_PROVIDER_DOMAINS;
  }

  // Dispatch-time derivation: the worktree's own manifests (package.json,
  // lockfiles, .npmrc, Python project files) tell us which package-registry
  // / git-hosting hosts its dev environment needs, so the operator doesn't
  // have to hand-edit the baseline file for every new dependency shape.
  // Merge order: baseline (operator-curated) ∪ derived (this worktree) ∪
  // task-spec (this task's explicit asks) — derived domains only ever ADD
  // well-known registry hosts, never arbitrary URLs from file contents.
  const derived = deriveEnvironmentDomainsDetailed(wtAbs);
  const derivedLog = formatDerivedDomainsLog(derived);
  if (derivedLog) log(derivedLog);
  const derivedDomains = derived.map((d) => d.domain);
  const allowedDomains = [...new Set([...baseline, ...derivedDomains, ...taskDomains])];

  if (derivedDomains.length > 0) {
    // Persist `baseline` too, not just `derivedDomains`: when the baseline
    // file was missing/invalid, `baseline` is the KIMI_PROVIDER_DOMAINS
    // fallback (in-memory only, per the branch above). Persisting only the
    // derived domains would write a *first* baseline file containing e.g.
    // registry.npmjs.org but omitting api.kimi.com/api.moonshot.*  — the
    // next dispatch would then read that file as "valid" (non-empty),
    // skip the fallback entirely, and silently drop Kimi's own provider
    // domains from the allowlist, reintroducing the exact
    // provider.connection_error regression this fallback exists to fix.
    persistDerivedDomains(baselinePath, [...baseline, ...derivedDomains]);
  }

  // TMPDIR routinely contains a symlink component (/var -> /private/var on
  // macOS), and srt allowWrite matching works on physical paths (see the
  // realpathSync calls for wtAbs/gitCommon above) — so canonicalize the tmp
  // base before using it as an allowWrite root or as the base of the per-task
  // pnpm store below. Create it first so realpathSync has something to
  // resolve even when the TMPDIR directory does not exist yet.
  const tmpBaseRaw = process.env.TMPDIR ?? '/tmp';
  mkdirSync(tmpBaseRaw, { recursive: true });
  const tmpBase = realpathSync(tmpBaseRaw);

  const settingsPath = join(sessionsAbs, `${agentRunId}.srt-settings.json`);
  const settingsFactory = options.makeSrtSettings ?? makeSrtSettings;
  let generatedSettingsPath = '';
  try {
    generatedSettingsPath = settingsFactory(settingsPath, [
      wtAbs,
      gitCommon,
      tmpBase,
      '/private/tmp',
      `${process.env.HOME ?? ''}/.kimi-code`,
    ], allowedDomains);
  } catch {
    generatedSettingsPath = '';
  }

  // HARD GUARD: never invoke an auto-approving agent without valid settings.
  let settingsReady = false;
  try {
    settingsReady = generatedSettingsPath === settingsPath
      && existsSync(settingsPath)
      && readFileSync(settingsPath).length > 0
      && isValidSrtSettings(JSON.parse(readFileSync(settingsPath, 'utf8')));
  } catch {
    settingsReady = false;
  }
  if (!settingsReady) {
    die('failed to build valid srt settings — refusing to run Kimi (auto-approves tools) unsandboxed');
  }

  log('kimi write role under srt (writes confined to worktree + git-common-dir)');

  // srt's mandatory-deny protection blocks writes to `.git/config` and
  // `.git/hooks/*` under ANY `.git` directory found inside an allowed write
  // root — including pnpm's ephemeral tmp clones of git-hosted dependencies
  // (e.g. `.pnpm-store/v11/tmp/<x>/.git/`). That protection is not
  // configurable (no opt-out/scoping knob in srt's settings schema — see
  // README §"Mandatory Deny Paths"), so `pnpm install` on a task with any
  // git-hosted dependency fails with EPERM inside the worktree, and the
  // global pnpm store is correctly outside allowWrite so there is no
  // sandbox-side fallback either. The per-task store/cache dirs that fix
  // this now come from prepareWorkerEnv() (worker-devenv.ts, computed under
  // the same canonicalized tmp base and passed via devenv.envOverrides
  // below) — this used to be an inline pnpm-only computation here.

  // `kimi -p` (print mode) ALREADY auto-approves tools — that is exactly why the
  // OS sandbox is mandatory. stdout receives the NDJSON event stream and is
  // captured to cliJsonl; dispatch.ts polls that file and writes a human-readable
  // progress feed to the pane. stderr is empty in stream-json mode.
  const cliJsonl = join(sessionsAbs, `${agentRunId}.cli.jsonl`);
  const stderrPath = join(sessionsAbs, `${agentRunId}.stderr`);

  const { provenance, pinArgs } = resolveKimiModel(taskSpec, options);
  const kimiArgs = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    // `-m <alias>` applies to this invocation on both start and resume.
    ...pinArgs,
  ];
  if (provenance.source === 'pinned') {
    log(`kimi model pin honored: ${provenance.model}`);
  }
  if (verb === 'resume' && priorSessionId) {
    // Kimi's resume flag is `-S, --session <id>` (verified against the
    // installed CLI's `kimi --help`; docs/vendor-adapters.md §3). Inserted
    // ahead of --add-dir, exactly where adapter-claude.ts appends --resume.
    // Each token is individually shell-quoted below, so the srt -c command
    // string stays valid.
    kimiArgs.push('-S', priorSessionId);
    log(`kimi resume from session ${priorSessionId}`);
  }
  kimiArgs.push('--add-dir', worktree);
  const kimiCommand = ['kimi', ...kimiArgs].map(shellQuote).join(' ');
  await runStreaming('srt', ['-s', settingsPath, '-c', kimiCommand], {
    cwd: wtAbs,
    stdoutPath: cliJsonl,
    stderrPath,
    teeStderr: true,
    spawn: spawnFn,
    envOverrides: devenv.envOverrides,
  });

  // The sessions directory is ephemeral, but remove settings after consumption
  // so domain and filesystem policy do not linger longer than the worker run.
  try {
    rmSync(settingsPath, { force: true });
  } catch {
    // Best-effort cleanup.
  }

  // The store/cache dirs are per-attempt: nothing references them once the
  // run ends (pnpm hardlinks keep any worktree node_modules they populated
  // alive), so remove them rather than letting per-task dirs pile up in
  // TMPDIR until the OS tmp janitor runs.
  for (const dir of Object.values(devenv.envOverrides)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  const sessionId = parseLastSessionId(cliJsonl);
  // Provenance keys are always present (explicit null where unrecoverable);
  // dispatch.ts reads this back to emit worker_model_resolved.
  writeFileSync(
    join(sessionsAbs, `${agentRunId}.json`),
    `${JSON.stringify({
      agent_run_id: agentRunId,
      vendor: 'kimi',
      session_id: sessionId,
      ...provenance,
    })}\n`,
  );

  if (existsSync(workerResult)) {
    let workerData: unknown;
    try {
      workerData = JSON.parse(readFileSync(workerResult, 'utf8'));
    } catch {
      workerData = undefined;
    }
    if (typeof workerData === 'object' && workerData !== null && !Array.isArray(workerData)) {
      const workerRecord = workerData as Record<string, unknown>;
      workerRecord.vendor = 'kimi';
      workerRecord.session_id = workerRecord.session_id === undefined
        || workerRecord.session_id === null
        || workerRecord.session_id === false
        ? sessionId
        : workerRecord.session_id;
      writeFileSync(resultPath, `${JSON.stringify(workerRecord)}\n`);
      return agentRunId;
    }
    if (workerData !== undefined && workerData !== null && workerData !== false) {
      // jq -e accepts truthy scalar/array JSON, but the subsequent object-field
      // assignment fails under `set -e`; preserve that signal rather than
      // silently synthesizing or accepting a drop.
      die('worker result drop is valid JSON but is not an object');
    }
  }

  if (deriveDropFromGit(taskSpec, worktreeAbs, 'kimi', sessionId, resultPath)) {
    log('kimi committed without a self-report; drop derived from git evidence');
  } else {
    const result = {
      task_id: yamlScalar(taskSpec, 'task_id'),
      run_id: yamlScalar(taskSpec, 'run_id'),
      spec_version: Number(yamlScalar(taskSpec, 'spec_version')),
      vendor: 'kimi',
      session_id: sessionId,
      status: 'failed',
      branch: yamlScalar(taskSpec, 'branch'),
      base_commit: yamlScalar(taskSpec, 'base_commit'),
      head_commit: yamlScalar(taskSpec, 'base_commit'),
      summary: 'worker produced no result drop and no commit',
      files_changed: [],
      verification_claims: [],
      risks: ['adapter synthesized a failed drop'],
      unresolved_questions: [],
      suggested_additional_checks: [],
    };
    writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  }

  return agentRunId;
}

/**
 * Sandboxed write role (the `start` verb). Backwards-compatible wrapper kept
 * for existing importers; delegates to `kimi('start', ...)`.
 *
 * @returns the agent_run_id
 */
export async function kimiStart(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  options: KimiAdapterOptions = {},
): Promise<string> {
  return kimi('start', taskSpec, worktree, inbox, sessions, agentRunId, undefined, options);
}

/** Convenience wrapper for the `resume` verb (mirrors adapter-claude.ts's `resume()`). */
export async function resume(
  taskSpec: string,
  worktree: string,
  inbox: string,
  sessions: string,
  agentRunId: string,
  priorSessionId: string,
  options: KimiAdapterOptions = {},
): Promise<string> {
  return kimi('resume', taskSpec, worktree, inbox, sessions, agentRunId, priorSessionId, options);
}

// Backwards-compatible default export for consumers that import the module.
export default {
  buildWorkerPrompt,
  makeSrtSettings,
  kimiVisual,
  kimi,
  kimiStart,
  resume,
};

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const verb = args[0];
    if (verb === 'visual') {
      const outputPath = await kimiVisual(
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
      );
      process.stdout.write(`${outputPath}\n`);
    } else if (verb === 'start') {
      const agentRunId = await kimiStart(
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
      );
      process.stdout.write(`${agentRunId}\n`);
    } else if (verb === 'resume') {
      const agentRunId = await resume(
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
      );
      process.stdout.write(`${agentRunId}\n`);
    } else {
      requireKimi(defaultCommandExists);
      die('usage: adapter-kimi.ts visual|start|resume ...');
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await main();
}
