import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  codexEventText,
  die,
  herdrState,
  herdrWorkspacePinEnabled,
  killTree,
  kimiEventText,
  ledgerAppend,
  log,
  pinnedHerdrWorkspace,
  pollJsonlFile,
  repoRoot,
  runDir,
  setPinnedHerdrWorkspace,
  stateRoot,
  warn,
  type JsonlTailState,
} from './lib.ts';
import { herdrAgentPaneRatio, monitorEventText } from './dispatch.ts';
import { headsFilePath, readHeadsFile, recordedCodeGraph } from './detect-heads.ts';
import { isCompiledBinary } from './kit-assets.ts';
import { isSafeId, isTaskId, SAFE_ID_PATTERN, TASK_ID_GRAMMAR } from './task-id.ts';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => ExecResult;

export interface ReviewDispatchOptions {
  /** Explicit repository root; otherwise resolved with git. */
  cwd?: string;
  /** Explicit state root; otherwise resolved from the environment. */
  stateRoot?: string;
  /**
   * Explicit task linkage (REQUIRED — issue #32): recorded as task_id on the
   * review_started/review_completed lifecycle events. Task identity is never
   * inferred from the review_id naming; a missing or unsafe value dies BEFORE
   * any dispatch, ledger write, or state-tree mutation.
   */
  taskId?: string;
  /** Injectable command runner for tests. */
  exec?: ExecFn;
  /** Injectable pane-state reporter for tests. */
  herdrState?: typeof herdrState;
  /** Optional image path (kimi only). */
  image?: string;
  /** Injectable process-tree killer for tests. */
  killTree?: typeof killTree;
  /** Injectable poll sleeper for tests. */
  sleep?: (ms: number) => void;
  /**
   * Explicit heads.json path for the code-graph capability lookup; defaults
   * to the machine-global snapshot (detect-heads headsFilePath()). A missing
   * or unreadable file means "capability unknown" — the review prompt is
   * then left byte-for-byte alone.
   */
  headsFile?: string;
}

// ---------------------------------------------------------------------------
// Default command runner.
// ---------------------------------------------------------------------------

export function defaultExec(
  file: string,
  args: string[],
  options?: { cwd?: string },
): ExecResult {
  const result = spawnSync(file, args, {
    cwd: options?.cwd,
    // Strip BUN_BE_BUN so a leaked BUN_BE_BUN=1 cannot hijack a Bun-compiled
    // child (vendor CLIs via `bash -lc`, or herdr itself — spike:
    // docs/bun-migration-spike-results.md); Bun omits undefined env keys.
    env: { ...process.env, BUN_BE_BUN: undefined },
    encoding: 'utf8',
    stdio: 'pipe',
  });

  let exitCode: number;
  // Tolerate Bun's spawn-error shape: Node reports `status: null` while Bun
  // reports `status: undefined`; loose `!= null` covers both.
  if (result.status != null) {
    exitCode = result.status;
  } else if (result.signal) {
    const signalNumber = osConstants.signals[result.signal] ?? 0;
    exitCode = 128 + signalNumber;
  } else if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    exitCode = code === 'EACCES' ? 126 : 127;
  } else {
    exitCode = 1;
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// State-root-aware ledger append. lib.ledgerAppend derives the ledger path
// from the environment, so we temporarily redirect HYDRA_STATE_ROOT when an
// explicit state root was supplied without re-implementing the helper.
// ---------------------------------------------------------------------------

function appendLedger(
  stateRootPath: string,
  runId: string,
  event: string,
  ...kvs: string[]
): void {
  const previous = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = stateRootPath;
  try {
    ledgerAppend(runId, event, ...kvs);
  } finally {
    if (previous === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = previous;
    }
  }
}

// ---------------------------------------------------------------------------
// Vendor command construction.
// ---------------------------------------------------------------------------

function vendorCommand(
  vendor: string,
  prompt: string,
  repoRootPath: string,
  image?: string,
): { file: string; args: string[] } {
  switch (vendor) {
    case 'codex':
      return {
        file: 'codex',
        args: ['exec', '--json', '-s', 'read-only', '-C', repoRootPath, prompt],
      };
    case 'kimi': {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--add-dir',
        repoRootPath,
      ];
      if (image) {
        args.push('--add-dir', dirname(image));
      }
      return { file: 'kimi', args };
    }
    case 'claude':
      return {
        file: 'claude',
        args: ['-p', prompt, '--output-format', 'json', '--add-dir', repoRootPath],
      };
    case 'opencode': {
      const model =
        process.env.HYDRA_OPENCODE_MODEL ?? 'zai-coding-plan/glm-5.2';
      return {
        file: 'opencode',
        args: [
          'run',
          '--model',
          model,
          '--agent',
          'hydra-reviewer',
          '--format',
          'json',
          '--auto',
          '--dir',
          repoRootPath,
          prompt,
        ],
      };
    }
    default:
      die(`unknown vendor: ${vendor}`);
  }
}

// ---------------------------------------------------------------------------
// Raw vendor output hygiene (issue #37).
// ---------------------------------------------------------------------------

/**
 * ANSI/VT control sequences a terminal-aware vendor CLI writes even when it
 * has been asked for machine-readable output (opencode colors its warnings
 * before the JSON stream begins). Stripped BEFORE any JSON-line parsing and
 * again before anything reaches the `.md`, so neither the distilled path nor
 * the raw-copy fallback can leak escape bytes into a reviewer-facing file.
 *
 * Coverage follows ECMA-48 by BYTE RANGE rather than by enumerating the
 * sequences seen in the wild, so a vendor emitting some other short escape
 * does not reopen this hole. An earlier revision matched only a final byte in
 * `[@-Z\-_]`, which silently let `ESC 7`/`ESC 8` (DECSC/DECRC), `ESC c`
 * (RIS) and the 8-bit C1 form of CSI (0x9B) through.
 *
 * Alternation order is load-bearing: the structured multi-byte forms must be
 * tried before the single-final-byte escape, because `[` (0x5B) and `]`
 * (0x5D) are themselves inside the Fe range.
 */
const ANSI_PATTERN = new RegExp(
  [
    // CSI: params (0x30-0x3F) intermediates (0x20-0x2F) final (0x40-0x7E).
    // Both the 7-bit `ESC [` opener and the 8-bit C1 single byte 0x9B.
    '(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]',
    // Control strings — OSC (`ESC ]`), DCS (`ESC P`), SOS, PM, APC — and
    // their 8-bit C1 openers, terminated by BEL, ST (`ESC \\`) or 0x9C.
    // The body also stops at a newline: real control-string payloads are
    // single-line, so bounding there keeps an UNterminated one (a truncated
    // capture file) from swallowing the rest of the transcript on the
    // raw-copy fallback path.
    '(?:\\u001B[\\]P^_X]|[\\u0090\\u0098\\u009D\\u009E\\u009F])' +
      '[^\\u0007\\u001B\\u009C\\n\\r]*(?:\\u0007|\\u001B\\\\|\\u009C)?',
    // nF sequences: ESC + one or more intermediates (0x20-0x2F) + a final
    // byte (0x30-0x7E) — charset selection (`ESC ( B`), DECALN (`ESC # 8`).
    '\\u001B[ -/]+[0-~]',
    // Single-character escapes: ESC + one byte in Fp (0x30-0x3F, DECSC
    // `ESC 7` / DECRC `ESC 8`), Fe (0x40-0x5F, NEL `ESC E`) or Fs
    // (0x60-0x7E, RIS `ESC c`) — i.e. the whole 0x30-0x7E range.
    '\\u001B[0-~]',
    // Any remaining bare C1 control byte (0x80-0x9F): the ones with their
    // own openers above are consumed there, this catches the rest.
    '[\\u0080-\\u009F]',
    // A dangling ESC with nothing after it (truncated capture file) — last
    // so it only fires when no structured form matched.
    '\\u001B',
  ].join('|'),
  'g',
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/**
 * Vendor CLIs that cannot resolve a requested agent silently downgrade to
 * their built-in default and keep going — the review still "succeeds", but
 * it was produced by a different agent than the one the lane asked for
 * (issue #37). opencode prints
 * `agent "hydra-reviewer" not found. Falling back to default agent`.
 * Detection is observability only: it never gates or alters the review.
 */
const AGENT_FALLBACK_PATTERN =
  /agent\s+["'`]?([^"'`\n]*?)["'`]?\s+not found[.,]?\s*falling back to\s+(?:the\s+)?([\w.:@/-]+)\s+agent/i;
const AGENT_FALLBACK_LOOSE = /\bnot found\b[.,]?\s*falling back to\b/i;

export interface AgentFallback {
  requested: string;
  used: string;
}

/**
 * `rawText` must already be ANSI-stripped — the warning is emitted in color,
 * so escape bytes can sit between the very words being matched.
 */
export function detectAgentFallback(rawText: string): AgentFallback | undefined {
  const match = AGENT_FALLBACK_PATTERN.exec(rawText);
  if (match) {
    return { requested: match[1]?.trim() || '?', used: match[2]?.trim() || '?' };
  }
  // A reworded variant still deserves the event; the names are just unknown.
  if (AGENT_FALLBACK_LOOSE.test(rawText)) return { requested: '?', used: '?' };
  return undefined;
}

// ---------------------------------------------------------------------------
// Extract the final assistant message per vendor stream format.
// ---------------------------------------------------------------------------

/** `raw` is the ANSI-stripped raw transcript text (empty when absent). */
function extractFinalMessage(vendor: string, raw: string): string {
  if (!raw) return '';

  try {
    // Per-line tolerant (issue #37): each line is parsed independently and a
    // line that is not valid JSON is SKIPPED, not thrown. The previous eager
    // `.map(JSON.parse)` aborted the whole transcript on the first non-JSON
    // line — one vendor warning ahead of the stream discarded an entire
    // review and forced the raw-copy fallback.
    const jsonLines = (): Record<string, unknown>[] => {
      const objects: Record<string, unknown>[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          objects.push(parsed as Record<string, unknown>);
        }
      }
      return objects;
    };

    switch (vendor) {
      case 'codex': {
        const messages: string[] = [];
        for (const obj of jsonLines()) {
          const msg = obj.msg as Record<string, unknown> | undefined;
          const item = obj.item as Record<string, unknown> | undefined;
          if (msg?.type === 'agent_message' || obj.type === 'item.completed') {
            messages.push(
              String(msg?.message ?? item?.text ?? ''),
            );
          }
        }
        return messages.at(-1) ?? '';
      }
      case 'kimi': {
        const contents: string[] = [];
        for (const obj of jsonLines()) {
          if (obj.role === 'assistant') {
            contents.push(String(obj.content ?? ''));
          }
        }
        return contents.at(-1) ?? '';
      }
      case 'claude': {
        // `--output-format json` is a single document, so the whole-file
        // parse is the fast path. A vendor warning printed ahead of it used
        // to poison that parse too; fall back to scanning the file line by
        // line for the last object carrying a `result`.
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          return String(obj.result ?? '');
        } catch {
          const results = jsonLines().filter((obj) => obj.result !== undefined);
          return String(results.at(-1)?.result ?? '');
        }
      }
      case 'opencode': {
        const texts: string[] = [];
        for (const obj of jsonLines()) {
          const part = obj.part as Record<string, unknown> | undefined;
          if (obj.type === 'text' || part?.type === 'text') {
            texts.push(String(obj.text ?? part?.text ?? ''));
          }
        }
        return texts.at(-1) ?? '';
      }
      default:
        return '';
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Herdr pane helpers.
// ---------------------------------------------------------------------------

function findHerdrWorkspace(
  repoRootPath: string,
  exec: ExecFn,
): string | undefined {
  const result = exec('herdr', ['pane', 'list'], { cwd: repoRootPath });
  if (result.exitCode !== 0) return undefined;
  try {
    const data = JSON.parse(result.stdout) as {
      result?: { panes?: Array<{ agent?: unknown; cwd?: string; workspace_id?: string }> };
    };
    const pane = data.result?.panes?.find(
      (p) => p.agent != null && p.cwd === repoRootPath,
    );
    return pane?.workspace_id;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the lead's herdr workspace id for a reviewer pane spawn within this
 * run (issue #19). The persisted workspace id is read from run.yaml FIRST;
 * only when no value has been persisted yet (or the pin is disabled, or
 * run.yaml is missing/corrupt) does this fall back to a live
 * findHerdrWorkspace() query — the live `herdr pane list` shell-out itself
 * is skipped entirely once a pin exists, so a later reviewer pane spawn does
 * not re-query the operator's current terminal focus. The FIRST successful
 * live query in a run is persisted into run.yaml; subsequent spawns reuse
 * it. HYDRA_HERDR_WORKSPACE_PIN=0 disables the pin and restores the legacy
 * always-live-query behavior. All persistence errors degrade safely to a
 * live query and never throw or block a dispatch.
 */
function resolveReviewPaneWorkspace(
  runYamlPath: string,
  repoRootPath: string,
  exec: ExecFn,
): string | undefined {
  if (herdrWorkspacePinEnabled(process.env)) {
    let pinned: string | undefined;
    try { pinned = pinnedHerdrWorkspace(runYamlPath); } catch { /* not pinned */ }
    if (pinned) return pinned;
  }
  const live = findHerdrWorkspace(repoRootPath, exec);
  if (live && herdrWorkspacePinEnabled(process.env)) {
    try { setPinnedHerdrWorkspace(runYamlPath, live); } catch { /* best effort */ }
  }
  return live;
}

function launchInPane(
  runId: string,
  reviewId: string,
  vendor: string,
  repoRootPath: string,
  runYamlPath: string,
  wrapped: string,
  exec: ExecFn,
): { pane?: string } | undefined {
  const status = exec('herdr', ['status'], { cwd: repoRootPath });
  if (status.exitCode !== 0) return undefined;

  const ws = resolveReviewPaneWorkspace(runYamlPath, repoRootPath, exec);
  const label = `hydra:${runId}:${reviewId}:${vendor}`;
  const args = [
    'agent',
    'start',
    label,
    '--cwd',
    repoRootPath,
    ...(ws ? ['--workspace', ws] : []),
    '--split',
    'down',
    '--no-focus',
    '--',
    'bash',
    '-lc',
    wrapped,
  ];

  const started = exec('herdr', args, { cwd: repoRootPath });
  if (started.exitCode !== 0) return undefined;

  try {
    const data = JSON.parse(started.stdout) as {
      result?: { agent?: { pane_id?: string } };
    };
    return { pane: data.result?.agent?.pane_id };
  } catch {
    // The command did start successfully. Bash's jq failure leaves an empty
    // pane id but does not turn the successful launch into an inline fallback.
    return { pane: undefined };
  }
}

function sleepMs(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)], { encoding: 'utf8', stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// Inactivity watchdog (issue #36 / issue #28 E1).
// ---------------------------------------------------------------------------

/** Supervisor poll cadence for a pane-hosted review. */
const REVIEW_POLL_INTERVAL_MS = 3000;

/**
 * Wall-clock backstop, in minutes. Raised from 15 to 30 (issue #28): real
 * reviews of a large diff legitimately ran past 15 minutes and were killed
 * mid-answer, and a killed review was indistinguishable from a completed
 * one in the ledger. The inactivity watchdog below now catches a genuinely
 * hung provider in minutes, so this cap only has to be generous enough for a
 * slow-but-live reviewer — it stays a hard backstop for the case where
 * output never stops but never finishes either. Overridable, unchanged, via
 * HYDRA_REVIEW_TIMEOUT_MIN.
 */
const REVIEW_TIMEOUT_MIN_DEFAULT = 30;

/**
 * Minutes of complete byte-silence in a review's own capture file before the
 * supervisor calls it stalled. 3 minutes ≈ 60 poll ticks: comfortably longer
 * than any single tool call or model turn a streaming vendor puts between
 * two emitted events, and far shorter than the wall-clock backstop, so a hung
 * provider is caught in minutes instead of burning the full cap in silence.
 * HYDRA_REVIEW_STALL_MIN=0 disables the watchdog and restores the pure
 * wall-clock behavior.
 */
const REVIEW_STALL_MIN_DEFAULT = 3;

/**
 * Byte-size signature over a review's capture files, mirroring the worker
 * lane's activitySignature()/plainActivity() pattern in dispatch.ts: an
 * unchanged signature across consecutive polls means genuine silence, a
 * changed one means the vendor is still producing output. Deliberately
 * re-implemented here rather than imported — the review lane owns its own
 * capture layout, and dispatch.ts is not touched by this change.
 */
function reviewActivitySignature(paths: string[]): string {
  const values: Array<{ path: string; size: number }> = [];
  for (const path of paths) {
    try {
      const info = statSync(path);
      if (info.isFile()) values.push({ path, size: info.size });
    } catch {
      // A capture file that does not exist yet contributes nothing — the
      // empty signature is itself a valid "no output at all" state.
    }
  }
  if (values.length === 0) return '';
  if (values.length === 1) return `${values[0].size} ${values[0].path}`;
  return `${values.reduce((total, value) => total + value.size, 0)} total`;
}

/** Minute count from an env override, else the supplied default. */
function minutesFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Wall-clock cap in minutes; HYDRA_REVIEW_TIMEOUT_MIN overrides the default. */
export function reviewTimeoutMinutes(
  raw: string | undefined = process.env.HYDRA_REVIEW_TIMEOUT_MIN,
): number {
  return minutesFromEnv(raw, REVIEW_TIMEOUT_MIN_DEFAULT);
}

/** Silence window in minutes; HYDRA_REVIEW_STALL_MIN overrides the default. */
export function reviewStallMinutes(
  raw: string | undefined = process.env.HYDRA_REVIEW_STALL_MIN,
): number {
  return minutesFromEnv(raw, REVIEW_STALL_MIN_DEFAULT);
}

export type ReviewTimeoutReason = 'stalled' | 'wall_clock';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shrink a freshly started reviewer pane so the lead console keeps the
 * majority of the terminal height (issue #18). The pane was split `down`
 * from the lead console, so `pane resize --direction down` moves the divider
 * toward the reviewer pane, leaving it at roughly HYDRA_HERDR_PANE_RATIO of
 * the height. Purely cosmetic: any failure is ignored.
 */
function shrinkAgentPane(exec: ExecFn, repoRootPath: string, pane: string): void {
  try {
    exec('herdr', [
      'pane',
      'resize',
      '--direction',
      'down',
      '--amount',
      String(herdrAgentPaneRatio(process.env.HYDRA_HERDR_PANE_RATIO)),
      '--pane',
      pane,
    ], { cwd: repoRootPath });
  } catch {
    // Pane sizing is best effort and must never fail the review.
  }
}

// ---------------------------------------------------------------------------
// Code-graph reading strategy (run 0068, issue #28 E2).
//
// A reviewer with no code-graph (symbol-index) tool cannot answer "where is
// X enforced?" with a single lookup; it falls back to reading candidate
// files whole. Measured in a live incident, that is exactly how an identical
// review brief that codex finished in ~9 minutes with a 16.5 KB verdict
// failed twice on kimi — killed at both the 15- and 45-minute caps having
// produced 531 and 734 bytes of forward-looking narration, never beginning
// synthesis, after re-reading the same large file four times in one attempt.
//
// So when heads.json records `code_graph: false` for the target vendor we
// prepend a reading-strategy block to the operator's brief and warn on the
// dispatch log. This is DISCLOSURE plus a prompt hint, never routing: the
// dispatch always proceeds to the vendor the operator chose, and allocate.ts
// is untouched. Its real-world effectiveness is unmeasured — it is a
// hypothesis derived from one reproduced incident, and should be evaluated
// against real reviews before anyone leans on it.
// ---------------------------------------------------------------------------

/**
 * Files the reviewer may inspect before it MUST write a draft verdict.
 *
 * Eight is chosen to sit just above the widest brief this project actually
 * issues: a hydra review brief names the task's writable paths plus its
 * read-only context, which has run 2-6 files. So the checkpoint never fires
 * before the reviewer has seen its actual subject matter, while still firing
 * long before context growth becomes unrecoverable (the failed attempts were
 * tens of whole-file reads deep with nothing written).
 */
export const REVIEW_FILE_BUDGET = 8;

/**
 * The reading-strategy block prepended to a capability-lacking vendor's
 * review prompt. The operator's own brief follows this verbatim — nothing
 * here replaces or edits it.
 */
export function readingStrategyPreamble(vendor: string): string {
  return [
    '## Reading strategy (inserted by hydra — no code-graph tool available)',
    '',
    `This machine has no code-graph / symbol-index tool configured for ${vendor},`,
    'so a question like "where is X enforced?" cannot be answered with one',
    'lookup. Reviews on this vendor have run out of time reading files and',
    'never written a verdict. Follow this strategy:',
    '',
    '1. Batch and line-range your reads. Once you know what you are looking',
    '   for, use grep -n to locate the ranges worth extracting, then pull',
    '   them from SEVERAL files in ONE shell call instead of reading whole',
    '   files:',
    "     nl -ba src/a.ts | sed -n '40,90p;220,260p'; nl -ba src/b.ts | sed -n '1,60p'",
    '',
    '2. Never re-read a file you have already read in this session. Quote',
    '   from the earlier result instead. Repeatedly re-reading the same large',
    '   file is the single failure mode this block exists to prevent.',
    '',
    `3. Hard synthesis checkpoint: after inspecting at most ${REVIEW_FILE_BUDGET} files, STOP`,
    '   reading and write your verdict. Only read further if a specific claim',
    '   in that draft verdict cannot be settled without it — and then read',
    '   only the line range that settles it.',
    '',
    `A verdict grounded in ${REVIEW_FILE_BUDGET} files is worth far more than an unfinished`,
    'survey of thirty. Write the verdict.',
    '',
    '--- operator review brief follows ---',
    '',
  ].join('\n');
}

/**
 * The code-graph capability recorded for `vendor`, or null when it cannot be
 * determined. Never throws: any read/parse failure is "unknown", which
 * leaves the prompt untouched.
 */
function lookupCodeGraph(vendor: string, headsFile: string): boolean | null {
  try {
    return recordedCodeGraph(readHeadsFile(headsFile), vendor);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export function reviewDispatch(
  runId: string,
  reviewId: string,
  vendor: string,
  promptFile: string,
  options: ReviewDispatchOptions = {},
): string {
  // EVERY id is validated BEFORE any path construction, ledger append, or
  // filesystem mutation. run_id and review_id follow the bounded safe-id
  // grammar (task-id.ts SAFE_ID_PATTERN): review_id names every session
  // artifact (sessions/<review_id>.<vendor>.{md,raw,exit,pid,
  // pane-progress.txt}), so traversal, separators, dot segments, control
  // bytes, whitespace and over-long values are all rejected here — a value
  // that passes cannot escape the run's sessions directory.
  if (!runId) die('usage: reviewDispatch <run_id> <review_id> <vendor> <prompt_file> --task <task_id> [--image PATH] (run_id required)');
  if (!isSafeId(runId)) die(`invalid run_id ${JSON.stringify(runId)}: must match ${SAFE_ID_PATTERN}`);
  if (!reviewId) die('review_id required');
  if (!isSafeId(reviewId)) die(`invalid review_id ${JSON.stringify(reviewId)}: must match ${SAFE_ID_PATTERN}`);
  if (!vendor) die('vendor required');
  if (!promptFile) die('prompt_file required');
  // Explicit task provenance (issue #32): the task being reviewed is passed
  // via --task and validated against the canonical task-id grammar BEFORE
  // anything is dispatched or recorded. A review_id is an opaque session
  // label — task identity is never inferred from its naming.
  const taskId = options.taskId ?? '';
  if (!taskId) die('task_id required: pass --task <task_id> (task identity is never inferred from review_id)');
  if (!isTaskId(taskId)) die(`invalid task_id ${JSON.stringify(taskId)}: expected ${TASK_ID_GRAMMAR}`);
  if (!existsSync(promptFile)) die(`prompt file not found: ${promptFile}`);

  const exec = options.exec ?? defaultExec;
  const reportHerdrState = options.herdrState ?? herdrState;
  const terminateTree = options.killTree ?? killTree;
  const sleep = options.sleep ?? sleepMs;
  const repoRootPath = options.cwd ?? repoRoot();
  const stateRootPath = options.stateRoot ?? stateRoot();
  const rd = options.stateRoot
    ? join(stateRootPath, 'runs', `run-${runId}`)
    : runDir(runId);

  const sessions = join(rd, 'sessions');
  mkdirSync(sessions, { recursive: true });

  const outMd = join(sessions, `${reviewId}.${vendor}.md`);
  const raw = join(sessions, `${reviewId}.${vendor}.raw`);
  const sentinel = join(sessions, `${reviewId}.${vendor}.exit`);
  const pidfile = join(sessions, `${reviewId}.${vendor}.pid`);
  const progressPath = join(sessions, `${reviewId}.${vendor}.pane-progress.txt`);

  rmSync(sentinel, { force: true });
  rmSync(pidfile, { force: true });

  const prompt = readFileSync(promptFile, 'utf8');

  // Code-graph disclosure (issue #28 E2). ONLY a recorded `false` changes
  // anything: a capable vendor, an unknown vendor, a missing/stale/unreadable
  // heads.json all leave `codeGraph` null and the prompt byte-for-byte as the
  // operator wrote it. The warning is advisory — the dispatch proceeds to the
  // operator's chosen vendor either way, and nothing here re-routes it.
  let headsFile: string;
  try {
    headsFile = options.headsFile ?? headsFilePath();
  } catch {
    headsFile = '';
  }
  const codeGraph = headsFile ? lookupCodeGraph(vendor, headsFile) : null;
  let reviewPrompt = prompt;
  if (codeGraph === false) {
    warn(
      `${vendor} has no code-graph (MCP symbol index) configured on this machine `
      + `(heads.json: code_graph=false) — prepending a reading-strategy preamble to the `
      + `review prompt. The review proceeds on ${vendor} as dispatched; hydra never `
      + `substitutes a vendor. Route future reviews elsewhere if you prefer.`,
    );
    reviewPrompt = readingStrategyPreamble(vendor) + prompt;
  }

  const { file, args } = vendorCommand(vendor, reviewPrompt, repoRootPath, options.image);

  // Live pane feedback (issue #18): codex/kimi/opencode stream NDJSON that
  // pollJsonlFile re-parses into event text for the pane's `tail -f` progress
  // file (opencode reuses the worker lane's monitorEventText parser from
  // dispatch.ts). Claude emits a single JSON document at exit
  // (`--output-format json`), so its pane gets a supervisor-written heartbeat
  // on every poll instead — either way no vendor shows a blank pane while
  // the reviewer is running.
  const streamsVendorEvents = vendor === 'codex' || vendor === 'kimi' || vendor === 'opencode';
  const usesHeartbeat = vendor === 'claude';
  const usesLiveProgressPane = streamsVendorEvents || usesHeartbeat;
  const liveProgressTailState: JsonlTailState = { offset: 0 };
  const parseLiveProgress =
    vendor === 'kimi' ? kimiEventText :
    vendor === 'opencode' ? monitorEventText :
    codexEventText;
  let paneStartedAt = 0;
  const pollLiveProgress = (final = false): void => {
    if (streamsVendorEvents) {
      pollJsonlFile(raw, progressPath, parseLiveProgress, liveProgressTailState, final);
      return;
    }
    if (usesHeartbeat && !final && paneStartedAt > 0) {
      const elapsedSec = Math.floor((Date.now() - paneStartedAt) / 1000);
      try {
        appendFileSync(progressPath, `[hydra] claude working... elapsed ${elapsedSec}s\n`, 'utf8');
      } catch { /* best effort — the heartbeat is cosmetic */ }
    }
  };

  // The plain wrapper writes its own pid, runs the vendor, and records the
  // exit code -- no live tail. This is what the inline/fallback path always
  // uses (herdr disabled, or pane launch fails): nothing polls the progress
  // file in that path (the supervisor's poll loop only runs while a pane is
  // actually hosting the run), so giving a live-feedback vendor the live
  // wrapper there would spawn a pointless background tail process for no
  // observer.
  const plainWrapped = `echo $$ > '${pidfile}'; ${file} ${args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ')} > '${raw}' 2>&1; printf '%s' $? > '${sentinel}'`;

  // The live wrapper additionally tails a progress file into the pane's own
  // terminal while the vendor command runs (streamed vendor events, or the
  // claude heartbeat) -- used ONLY for an actual pane-launch attempt.
  let wrapped = plainWrapped;
  if (usesLiveProgressPane) {
    const inner = `${shellQuote(file)} ${args.map(shellQuote).join(' ')} > ${shellQuote(raw)} 2>&1`;
    wrapped = [
      `echo $$ > ${shellQuote(pidfile)}`,
      `set +e`,
      `touch ${shellQuote(progressPath)} 2>/dev/null`,
      `tail -n +1 -f ${shellQuote(progressPath)} 2>/dev/null & TPID=$!`,
      `${inner}`,
      `RC=$?`,
      `kill $TPID 2>/dev/null`,
      `printf '%s' $RC > ${shellQuote(sentinel)}`,
    ].join('; ');
  }

  appendLedger(stateRootPath, runId, 'review_started', 'review_id', reviewId, 'task_id', taskId, 'vendor', vendor);

  let launchedInPane = false;
  let pane: string | undefined;
  // Set ONLY when the supervisor gave up on a pane-hosted review; a review
  // that produced its sentinel leaves this undefined and keeps the untouched
  // review_completed path below.
  let reviewTimeout: { reason: ReviewTimeoutReason; kvs: string[] } | undefined;

  if (process.env.HYDRA_HERDR_PANES !== '0') {
    // Seed the progress file BEFORE launching the pane, matching the worker
    // lane in dispatch.ts: a fast-exiting vendor can end the pane's
    // `tail -f` before a post-launch write ever lands, leaving a blank pane
    // -- exactly the failure this file's live feedback exists to prevent
    // (cross-vendor review, spec v4 fix 2).
    if (usesLiveProgressPane) {
      try {
        writeFileSync(progressPath, `[hydra] ${vendor} started — waiting for output...\n`, 'utf8');
      } catch { /* best effort — pane uses touch */ }
    }
    const launched = launchInPane(
      runId,
      reviewId,
      vendor,
      repoRootPath,
      join(rd, 'run.yaml'),
      wrapped,
      exec,
    );
    if (launched) {
      launchedInPane = true;
      pane = launched.pane;
      paneStartedAt = Date.now();
      appendLedger(
        stateRootPath,
        runId,
        'herdr_pane_started',
        'review_id',
        reviewId,
        'vendor',
        vendor,
        'label',
        `hydra:${runId}:${reviewId}:${vendor}`,
        'pane',
        pane ?? '?',
      );
      log(`reviewer hosted in herdr pane ${pane ?? '?'}: hydra:${runId}:${reviewId}:${vendor}`);
      if (pane) shrinkAgentPane(exec, repoRootPath, pane);
      if (pane) reportHerdrState(pane, vendor, 'working');

      const limitMinutes = reviewTimeoutMinutes();
      const limitSeconds = limitMinutes * 60;
      const stallMinutes = reviewStallMinutes();
      const stallPolls = Math.max(
        1,
        Math.ceil((stallMinutes * 60 * 1000) / REVIEW_POLL_INTERVAL_MS),
      );
      // Only a vendor that streams incremental output can be judged by
      // capture growth. `claude` is invoked with --output-format json and
      // writes its whole document at exit, so a perfectly healthy claude
      // review is legitimately byte-silent for its entire duration — it keeps
      // the wall-clock backstop alone rather than being killed as "stalled".
      const stallWatchEnabled = streamsVendorEvents && stallMinutes > 0;

      const start = Date.now();
      let lastSignature = reviewActivitySignature([raw]);
      let idlePolls = 0;
      while (!existsSync(sentinel)) {
        if ((Date.now() - start) / 1000 >= limitSeconds) {
          reviewTimeout = {
            reason: 'wall_clock',
            kvs: ['timeout_min', String(limitMinutes)],
          };
          break;
        }
        sleep(REVIEW_POLL_INTERVAL_MS);
        pollLiveProgress();
        if (existsSync(sentinel)) break;
        if (!stallWatchEnabled) continue;
        const signature = reviewActivitySignature([raw]);
        if (signature !== lastSignature) {
          lastSignature = signature;
          idlePolls = 0;
          continue;
        }
        idlePolls += 1;
        if (idlePolls >= stallPolls) {
          reviewTimeout = {
            reason: 'stalled',
            kvs: [
              'stall_min', String(stallMinutes),
              'idle_polls', String(idlePolls),
              'elapsed_sec', String(Math.floor((Date.now() - start) / 1000)),
              'timeout_min', String(limitMinutes),
            ],
          };
          break;
        }
      }
      pollLiveProgress(true);

      // The sentinel can still land between the loop break and here (the
      // vendor finished in the same instant we gave up); a review that
      // actually produced an exit code is a completion, not a timeout.
      if (reviewTimeout && existsSync(sentinel)) reviewTimeout = undefined;

      if (reviewTimeout) {
        warn(
          `review ${reviewId} (${vendor}) timed out: ${reviewTimeout.reason}` +
            ` — terminating (limit ${limitMinutes}m, stall window ${stallMinutes}m)`,
        );
      }

      if (!existsSync(sentinel) && existsSync(pidfile)) {
        const pid = Number(readFileSync(pidfile, 'utf8').trim());
        if (!Number.isNaN(pid)) terminateTree(pid);
      }

      if (pane) reportHerdrState(pane, vendor, 'idle');
      if (pane && process.env.HYDRA_HERDR_KEEP_PANE !== '1') {
        const closed = exec('herdr', ['pane', 'close', pane], {
          cwd: repoRootPath,
        });
        if (closed.exitCode === 0) log(`closed reviewer pane ${pane}`);
      }
    }
  }

  // Fallback: run inline when herdr is disabled or unavailable. Always the
  // PLAIN wrapper -- no pane means no progress-file observer.
  if (!launchedInPane) {
    const result = exec('bash', ['-lc', plainWrapped], { cwd: repoRootPath });
    // A real shell writes these files from wrapped. Preserve useful command
    // errors for injected runners or a shell that fails before redirection.
    if (!existsSync(raw)) {
      writeFileSync(raw, result.stderr || result.stdout, 'utf8');
    }
    if (!existsSync(sentinel)) {
      writeFileSync(sentinel, String(result.exitCode), 'utf8');
    }
  }

  // Read the transcript ONCE and strip ANSI up front: every downstream
  // consumer (distillation, the raw-copy fallback, agent-fallback detection)
  // works from the same escape-free text, so no path can leak control bytes
  // into the reviewer-facing .md (issue #37).
  const rawText = existsSync(raw) ? stripAnsi(readFileSync(raw, 'utf8')) : '';

  const message = stripAnsi(extractFinalMessage(vendor, rawText));
  if (message) {
    writeFileSync(outMd, `${message}\n`, 'utf8');
  } else if (existsSync(raw)) {
    writeFileSync(outMd, rawText, 'utf8');
  }

  // Observability only (issue #37): a vendor that silently downgraded to its
  // built-in agent still produced a review, so this neither gates nor
  // reshapes the flow — it just stops the substitution from being invisible.
  try {
    const fallback = detectAgentFallback(rawText);
    if (fallback) {
      appendLedger(
        stateRootPath,
        runId,
        'review_agent_fallback',
        'review_id',
        reviewId,
        'task_id',
        taskId,
        'vendor',
        vendor,
        'requested_agent',
        fallback.requested,
        'used_agent',
        fallback.used,
      );
      warn(
        `review ${reviewId} (${vendor}): requested agent '${fallback.requested}' not found;` +
          ` vendor fell back to '${fallback.used}'`,
      );
    }
  } catch {
    // Detection must never be able to fail a review.
  }

  const exitCode = existsSync(sentinel)
    ? readFileSync(sentinel, 'utf8').trim()
    : '?';
  if (reviewTimeout) {
    // A killed review is NOT a completion (issue #28 E1): today's
    // `review_completed exit_code:"?"` made a timeout indistinguishable from
    // a real finish, so a genuine timeout gets its own event with the reason
    // that triggered it. The normal path below is untouched.
    appendLedger(
      stateRootPath,
      runId,
      'review_timed_out',
      'review_id',
      reviewId,
      'task_id',
      taskId,
      'vendor',
      vendor,
      'reason',
      reviewTimeout.reason,
      'exit_code',
      exitCode,
      ...reviewTimeout.kvs,
    );
  } else {
    appendLedger(
      stateRootPath,
      runId,
      'review_completed',
      'review_id',
      reviewId,
      'task_id',
      taskId,
      'vendor',
      vendor,
      'exit_code',
      exitCode,
    );
  }
  log(`review ${reviewId} (${vendor}) -> ${outMd}`);
  process.stdout.write(`${outMd}\n`);
  return outMd;
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const USAGE =
  'usage: reviewDispatch <run_id> <review_id> <vendor> <prompt_file> --task <task_id> [--image PATH]';

/** Parsed CLI arguments; produced only after the whole argv validated. */
export interface ParsedReviewDispatchArgs {
  runId: string;
  reviewId: string;
  vendor: string;
  promptFile: string;
  taskId: string;
  image?: string;
}

/**
 * Strict CLI parsing (issue #32). The contract: exactly four positional
 * operands (<run_id> <review_id> <vendor> <prompt_file>), exactly one
 * `--task <task_id>`, at most one `--image PATH`; the two flags may appear
 * anywhere among the operands and in either order. Everything else is a
 * loud error — unknown flags, extra operands, duplicated flags, a flag with
 * no value, and a flag whose "value" is itself another option. Parsing
 * happens BEFORE reviewDispatch() runs, so every argv error fails without
 * touching the ledger, a session file, or any other state.
 */
export function parseReviewDispatchArgs(args: string[]): ParsedReviewDispatchArgs {
  const positionals: string[] = [];
  let taskId: string | undefined;
  let image: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--task' || arg === '--image') {
      const already = arg === '--task' ? taskId : image;
      if (already !== undefined) die(`duplicate ${arg} option\n${USAGE}`);
      const value = args[i + 1];
      if (value === undefined) die(`missing value for ${arg}\n${USAGE}`);
      if (value.startsWith('-')) {
        die(`missing value for ${arg}: ${JSON.stringify(value)} is another option, not a value\n${USAGE}`);
      }
      if (arg === '--task') taskId = value;
      else image = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      die(`unknown option ${JSON.stringify(arg)}\n${USAGE}`);
    } else if (positionals.length < 4) {
      positionals.push(arg);
    } else {
      die(`unexpected extra operand ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }

  if (positionals.length < 4) {
    die(`${USAGE} (expected 4 positional arguments, got ${positionals.length})`);
  }
  if (taskId === undefined) {
    die(`task_id required: pass --task <task_id> (task identity is never inferred from review_id)\n${USAGE}`);
  }
  const [runId, reviewId, vendor, promptFile] = positionals;
  return { runId, reviewId, vendor, promptFile, taskId, image };
}

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const parsed = parseReviewDispatchArgs(args);
    reviewDispatch(parsed.runId, parsed.reviewId, parsed.vendor, parsed.promptFile, {
      image: parsed.image,
      taskId: parsed.taskId,
    });
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
  process.exitCode = main();
}
