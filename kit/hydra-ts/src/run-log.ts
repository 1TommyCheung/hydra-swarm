import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateUsageByVendor, type UsageEvent } from './aggregate-usage.ts';
import type { LedgerEntry } from './current-attempt.ts';
import { isCompiledBinary } from './kit-assets.ts';
import { log, stateRoot as defaultStateRoot, yamlScalar } from './lib.ts';
import { isSafeId, isTaskId, SAFE_ID_PATTERN } from './task-id.ts';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** Shape of a git/execFileSync call that tests can override. */
export type ExecFunction = (
  file: string,
  args: string[],
  options?: { encoding?: BufferEncoding; cwd?: string; stdio?: any },
) => string;

/** Testable options for runLog(), mirroring sibling modules. */
export interface RunLogOptions {
  /** Base directory used to resolve relative paths; defaults to process.cwd(). */
  cwd?: string;
  /** Hydra state root; defaults to HYDRA_STATE_ROOT or lib.ts stateRoot(). */
  stateRoot?: string;
  /** Injected exec implementation (only used to resolve the repo root). */
  exec?: ExecFunction;
  /** Output directory override; wins over HYDRA_DEV_LOG_DIR and the default. */
  outDir?: string;
  /** Emit structured JSON to stdout instead of writing the markdown file. */
  json?: boolean;
}

export interface SpecAmendment {
  time: string | null;
  from: string;
  to: string;
  delivery: string;
  reason: string;
}

export interface DispatchAttempt {
  started: string | null;
  agent_run_id: string | null;
  dispatch_instance_id: string | null;
  delivery: string | null;
  ended: string | null;
  /** Terminal outcome phrase ("exit 0", "timed out (reason=…)", "cancelled"); null while in flight. */
  exit: string | null;
}

export interface TaskSignal {
  time: string | null;
  event: string;
  detail: string;
}

export interface Rejection {
  time: string | null;
  reason: string;
  detail: string;
}

export interface PromoteOutcome {
  promoted: boolean;
  head: string | null;
  divergence: string | null;
  time: string | null;
  rejections: Rejection[];
}

export interface ReviewSummary {
  verdict: string;
  reviewer: string;
  risk: string;
}

/**
 * One reviewer process completion attributed to a task by an EXPLICIT task_id
 * on a review_completed ledger event. A completion — even a clean exit 0 with
 * glowing free-text output — is process telemetry, never a verdict (issue #32).
 */
export interface ReviewCompletion {
  time: string | null;
  review_id: string | null;
  vendor: string | null;
  exit_code: string | null;
}

/**
 * The per-task review state, split into the three facts a reader must never
 * conflate (issue #32):
 * - completions: reviewer PROCESSES that ended for this task (oldest first);
 * - verdict: the AUTHORITATIVE verdict record (ledger review_verdict, or the
 *   latest valid append-only generation at
 *   authoritative/reviews/<task>/<seq>-<reviewed_head>.json, which wins) —
 *   the only acceptance gate;
 * - accepted: true ONLY when that recorded verdict is exactly 'accept'.
 * Legacy review events carrying no task_id never land here: they stay in the
 * flat timeline and are never guessed onto a task row from review_id naming.
 */
export interface ReviewActivity {
  completions: ReviewCompletion[];
  verdict: ReviewSummary | null;
  accepted: boolean;
}

export interface SquashSummary {
  integration_commit: string;
  candidate_head: string | null;
}

export interface TaskLifecycle {
  task_id: string;
  vendor: string | null;
  spec_version: string | null;
  amendments: SpecAmendment[];
  attempts: DispatchAttempt[];
  signals: TaskSignal[];
  promote: PromoteOutcome;
  review: ReviewActivity;
  squash: SquashSummary | null;
  integrated_head: string | null;
  worktree_reaped: TaskSignal | null;
}

export interface TimelineEntry {
  time: string | null;
  event: string;
  task_id: string | null;
  detail: string;
}

export interface VendorUsage {
  n_dispatch: number;
  total_cost_usd: number;
  median_cost_usd: number;
  total_tokens_out: number;
}

export interface DivergenceFlag {
  task_id: string;
  head: string | null;
  time: string | null;
}

/** A malformed ledger line: 1-based line number plus why it was rejected. */
export interface LedgerAnomaly {
  line: number;
  reason: string;
}

/**
 * A mismatch between the authoritative result tree and the ledger's promotion
 * record. Rendered as an explicit DIVERGENCE line — neither side is silently
 * trusted.
 */
export interface ReconciliationFlag {
  task_id: string;
  /** 'ledger_without_file': promotion in the ledger but no result file; 'file_without_ledger': the reverse. */
  kind: 'ledger_without_file' | 'file_without_ledger';
  detail: string;
}

/** The structured run summary — exactly what --json prints. */
export interface RunLogData {
  run_id: string;
  base_commit: string | null;
  run_started: string | null;
  last_event: string | null;
  wall_clock_seconds: number | null;
  heads_detected: { available: string[]; count: number } | null;
  tasks: TaskLifecycle[];
  timeline: TimelineEntry[];
  /** null when agents/usage.jsonl does not exist or has no rows for this run. */
  usage: Record<string, VendorUsage> | null;
  divergences: DivergenceFlag[];
  /** Malformed ledger lines (invalid JSON or valid-JSON non-objects), counted never skipped silently. */
  ledger_anomalies: LedgerAnomaly[];
  /** Ledger-vs-tree promotion mismatches, rendered as explicit DIVERGENCE lines. */
  reconciliation: ReconciliationFlag[];
}

export interface RunLogResult {
  data: RunLogData;
  markdown: string;
  /** Where the markdown was written; null in --json mode. */
  outPath: string | null;
}

// ---------------------------------------------------------------------------
// Id validation — every id that ends up inside a filesystem path is checked
// BEFORE the path is constructed. Both grammars are the SHARED contracts from
// task-id.ts: run ids follow the bounded safe-id grammar; task ids follow the
// canonical task-id grammar that review-store and review-dispatch enforce, so
// the reader can never construct a path the store could not have written.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Markdown escaping — every value from the ledger/state tree is DATA.
// ---------------------------------------------------------------------------

/**
 * Escape text for safe inclusion in the markdown run log.
 *
 * Order matters: ANSI/OSC escape sequences are removed FIRST (their brackets
 * would otherwise be escaped into visible-but-harmless litter), then HTML is
 * neutralized (&, <, > become entities — `&` first so entities are never
 * double-escaped), then markdown metacharacters. Backticks are REPLACED with
 * an apostrophe, never backslash-escaped: inside a code span a backslash is
 * rendered literally, so `\`` still terminates the span — only removal or
 * replacement actually neutralizes a backtick. Finally every remaining C0/C1
 * control byte (including any stray ESC) is stripped and CR/LF/TAB runs
 * collapse to a single space so a hostile value cannot break a table row or
 * list item. Values from the ledger and state tree are data: they are never
 * executed and must never render as markup.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … terminated by BEL or ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences (colors, cursor, …)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '') // remaining C0/C1 control bytes
    .replace(/[\r\n\t]+/g, ' ');
}

const NONE = '(none recorded)';

/** Escape a data value for a table cell; render the explicit gap when absent. */
function cell(value: string | null): string {
  return value === null || value === '' ? NONE : escapeMarkdown(value);
}

/** Escape a data value and wrap it in a code span; explicit gap when absent. */
function cellCode(value: string | null): string {
  return value === null || value === '' ? NONE : `\`${escapeMarkdown(value)}\``;
}

// ---------------------------------------------------------------------------
// Data extraction helpers.
// ---------------------------------------------------------------------------

/** Coerce a ledger JSON value to a display string; objects/absent -> null. */
function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function detailValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

/** "key=value  key=value" for every field except the row's own coordinates. */
function detailOf(entry: LedgerEntry): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'time' || key === 'event' || key === 'run_id' || key === 'task_id') continue;
    parts.push(`${key}=${detailValue(value)}`);
  }
  return parts.join('  ');
}

/**
 * Parse the ledger. Malformed lines are never silently dropped: every
 * unparseable line — and every valid-JSON line that is not an object
 * (numbers, strings, null, arrays) — is counted as a LedgerAnomaly with its
 * 1-based line number and rendered in the log's "Ledger anomalies" section.
 */
function readLedgerEntries(ledgerPath: string, runId: string): { entries: LedgerEntry[]; anomalies: LedgerAnomaly[] } {
  if (!existsSync(ledgerPath)) {
    throw new Error(`hydra: error: no ledger for run ${runId}`);
  }
  const content = readFileSync(ledgerPath, 'utf8');
  const entries: LedgerEntry[] = [];
  const anomalies: LedgerAnomaly[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      anomalies.push({ line: index + 1, reason: `invalid JSON: ${message.slice(0, 160)}` });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      anomalies.push({ line: index + 1, reason: 'not a JSON object' });
      continue;
    }
    entries.push(parsed as LedgerEntry);
  }
  return { entries, anomalies };
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const entries: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Tolerate partial lines in an append-only file.
    }
  }
  return entries;
}

/** Union of task ids from the spec dir, the ledger, and the authoritative tree. */
function discoverTaskIds(runPath: string, events: LedgerEntry[]): string[] {
  const ids = new Set<string>();
  const tasksDir = join(runPath, 'tasks');
  if (existsSync(tasksDir)) {
    for (const name of readdirSync(tasksDir)) {
      if (name.endsWith('.yaml')) ids.add(name.slice(0, -'.yaml'.length));
    }
  }
  const resultsDir = join(runPath, 'authoritative', 'results');
  if (existsSync(resultsDir)) {
    for (const name of readdirSync(resultsDir)) {
      if (name.endsWith('.squash.json')) ids.add(name.slice(0, -'.squash.json'.length));
      else if (name.endsWith('.json')) ids.add(name.slice(0, -'.json'.length));
    }
  }
  // The append-only review store keeps one DIRECTORY per task
  // (authoritative/reviews/<task>/<seq>-<reviewed_head>.json). Only a real,
  // non-symlink directory whose name is a canonical task id counts; stray
  // files (including legacy flat <task>.json files), symlinks, and
  // non-conforming names are never treated as task ids.
  const reviewsDir = join(runPath, 'authoritative', 'reviews');
  if (existsSync(reviewsDir)) {
    for (const name of readdirSync(reviewsDir)) {
      if (!isTaskId(name)) continue;
      try {
        const stats = lstatSync(join(reviewsDir, name));
        if (stats.isDirectory() && !stats.isSymbolicLink()) ids.add(name);
      } catch {
        // Raced away — a vanished entry is simply not a task.
      }
    }
  }
  for (const entry of events) {
    const taskId = str(entry.task_id);
    if (taskId) ids.add(taskId);
  }
  return [...ids].sort();
}

/**
 * Close the open attempt whose dispatch identity matches the terminal event.
 * Correlation is by dispatch identity, never recency: overlapping attempts
 * each close on their own terminal event. When the terminal event carries a
 * dispatch_instance_id, that id ALONE decides — agent_run_id is ignored, so
 * two overlapping dispatches sharing one agent_run_id still close only on
 * their own instance id. agent_run_id is a fallback ONLY for terminal events
 * with no dispatch_instance_id at all (legacy ledgers). A terminal event
 * carrying no dispatch ids — or one that matches no open attempt — closes
 * nothing, and the attempt stays "in flight".
 */
function closeAttempt(attempts: DispatchAttempt[], entry: LedgerEntry, time: string | null, exit: string): void {
  const instanceId = str(entry.dispatch_instance_id);
  const agentRunId = str(entry.agent_run_id);
  if (instanceId !== null) {
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      if (attempt.ended !== null) continue;
      if (attempt.dispatch_instance_id !== null && attempt.dispatch_instance_id === instanceId) {
        attempt.ended = time;
        attempt.exit = exit;
        return;
      }
    }
    return;
  }
  if (agentRunId === null) return;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt.ended !== null) continue;
    if (attempt.agent_run_id !== null && attempt.agent_run_id === agentRunId) {
      attempt.ended = time;
      attempt.exit = exit;
      return;
    }
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A published verdict generation's filename: at-least-4-digit sequence,
 * hyphen, 40-hex reviewed head, `.json` — exactly what review-store's
 * reviewFileName() emits (its own discovery scan matches `\d+`, so sequences
 * past 9999 stay visible here too).
 */
const REVIEW_GENERATION_RE = /^(\d+)-[0-9a-f]{40}\.json$/;

/**
 * Read the AUTHORITATIVE review verdict for a task from the append-only store
 * layout: authoritative/reviews/<task>/<seq>-<reviewed_head>.json.
 *
 * Trust rules:
 * - the per-task entry must be a real directory (lstat; a symlink or plain
 *   file — including a legacy flat <task>.json — is never followed);
 * - only entries whose NAME matches the published-generation grammar count,
 *   and each must be a regular non-symlink file;
 * - generations are ordered deterministically by numeric sequence descending,
 *   then by filename descending (byte order) so two hostile same-sequence
 *   spellings still pick one defined winner;
 * - a generation's parsed document must self-identify: its `task_id` must
 *   exist and equal the task directory being read (record-review rejects
 *   mismatches at publish time, so every legitimate generation carries it).
 *   A missing or mismatched identity — e.g. a verdict misfiled under another
 *   task's directory — is skipped and can never alter this task's verdict;
 * - the HIGHEST VALID generation wins: an unparseable, non-object or
 *   wrong-identity document at the top is skipped, never allowed to mask an
 *   older valid verdict.
 * The caller lets this record override conflicting ledger telemetry — a
 * durable file-only generation (published but crash-lost before its ledger
 * append) is still the authoritative verdict.
 */
function readAuthoritativeVerdict(runPath: string, taskId: string): ReviewSummary | null {
  const dir = join(runPath, 'authoritative', 'reviews', taskId);
  let dirStats;
  try {
    dirStats = lstatSync(dir);
  } catch {
    return null;
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) return null;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const generations: Array<{ seq: number; name: string }> = [];
  for (const name of names) {
    const match = REVIEW_GENERATION_RE.exec(name);
    if (match === null) continue;
    generations.push({ seq: Number(match[1]), name });
  }
  generations.sort((a, b) => (b.seq - a.seq) || (b.name > a.name ? 1 : b.name < a.name ? -1 : 0));

  for (const generation of generations) {
    const path = join(dir, generation.name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    const doc = readJsonFile(path);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) continue;
    // Identity gate: the stored verdict must claim exactly this task. A
    // missing or mismatched task_id skips THIS generation only — the scan
    // falls back to the next (lower) valid generation.
    if (doc.task_id !== taskId) continue;
    return {
      verdict: str(doc.verdict) ?? '',
      reviewer: str(doc.reviewer) ?? 'unknown',
      risk: str(doc.risk) ?? 'unknown',
    };
  }
  return null;
}

/**
 * Build the lifecycle for one task from its (pre-grouped) ledger events plus
 * the authoritative tree. A task id comes from the ledger or from directory
 * listings — it is DATA, so no read path is ever constructed from an id that
 * fails the strict pattern; such tasks render with explicit gaps instead.
 */
function buildTask(runPath: string, taskId: string, taskEvents: LedgerEntry[]): TaskLifecycle {
  // Task ids follow the SHARED canonical grammar (task-id.ts): no read path
  // is ever constructed from a non-canonical id; such tasks render from
  // ledger data alone, with explicit gaps for the file-backed pieces.
  const pathsSafe = isTaskId(taskId);

  const specPath = join(runPath, 'tasks', `${taskId}.yaml`);
  let vendor: string | null = null;
  let specVersion: string | null = null;
  if (pathsSafe && existsSync(specPath)) {
    try {
      vendor = yamlScalar(specPath, 'assigned_vendor') || null;
      specVersion = yamlScalar(specPath, 'spec_version') || null;
    } catch {
      // Unreadable spec — fall through to ledger-derived values.
    }
  }
  if (vendor === null) {
    const withVendor = taskEvents.find((entry) => typeof entry.vendor === 'string');
    vendor = withVendor ? str(withVendor.vendor) : null;
  }

  const amendments: SpecAmendment[] = [];
  const attempts: DispatchAttempt[] = [];
  const signals: TaskSignal[] = [];
  const rejections: Rejection[] = [];
  const promote: PromoteOutcome = {
    promoted: false,
    head: null,
    divergence: null,
    time: null,
    rejections,
  };
  let reviewFromLedger: ReviewSummary | null = null;
  const reviewCompletions: ReviewCompletion[] = [];
  let squashFromLedger: string | null = null;
  let integratedHead: string | null = null;
  let reaped: TaskSignal | null = null;

  for (const entry of taskEvents) {
    const time = str(entry.time);
    switch (entry.event) {
      case 'task_started':
        attempts.push({
          started: time,
          agent_run_id: str(entry.agent_run_id),
          dispatch_instance_id: str(entry.dispatch_instance_id),
          delivery: str(entry.delivery),
          ended: null,
          exit: null,
        });
        break;
      case 'agent_exited': {
        const code = str(entry.exit_code);
        const reason = str(entry.reason);
        closeAttempt(attempts, entry, time, `exit ${code ?? '?'}${reason ? ` (${reason})` : ''}`);
        break;
      }
      case 'agent_timed_out': {
        const reason = str(entry.reason);
        closeAttempt(attempts, entry, time, `timed out${reason ? ` (reason=${reason})` : ''}`);
        signals.push({ time, event: entry.event, detail: detailOf(entry) });
        break;
      }
      case 'agent_cancelled':
        closeAttempt(attempts, entry, time, 'cancelled');
        signals.push({ time, event: entry.event, detail: detailOf(entry) });
        break;
      case 'agent_loop_suspected':
      case 'agent_loop_confirmed':
      case 'agent_loop_cleared':
        signals.push({ time, event: entry.event, detail: detailOf(entry) });
        break;
      case 'task_spec_amended':
        amendments.push({
          time,
          from: str(entry.from) ?? '?',
          to: str(entry.to) ?? '?',
          delivery: str(entry.delivery) ?? '',
          reason: str(entry.reason) ?? '',
        });
        break;
      case 'result_rejected':
        rejections.push({
          time,
          reason: str(entry.reason) ?? 'unknown',
          detail: str(entry.detail) ?? '',
        });
        break;
      case 'result_promoted':
        promote.promoted = true;
        promote.head = str(entry.head);
        promote.divergence = str(entry.divergence);
        promote.time = time;
        break;
      case 'review_completed':
        // Reached ONLY via an explicit task_id on the event (the grouping in
        // buildRunLogData keys on entry.task_id alone) — never via review_id
        // pattern-matching. Records process completion, not a verdict.
        reviewCompletions.push({
          time,
          review_id: str(entry.review_id),
          vendor: str(entry.vendor),
          exit_code: str(entry.exit_code),
        });
        break;
      case 'review_verdict':
        reviewFromLedger = {
          verdict: str(entry.verdict) ?? '',
          reviewer: str(entry.reviewer) ?? 'unknown',
          risk: str(entry.risk) ?? 'unknown',
        };
        break;
      case 'squash_created':
        squashFromLedger = str(entry.integration_commit);
        break;
      case 'candidate_integrated':
        integratedHead = str(entry.head);
        break;
      case 'worktree_reaped':
        reaped = { time, event: entry.event, detail: detailOf(entry) };
        break;
      default:
        break;
    }
  }

  if (specVersion === null && amendments.length > 0) {
    specVersion = amendments[amendments.length - 1].to.replace(/^v/, '');
  }

  // The authoritative tree wins over the ledger for review + squash records.
  // The verdict — and ONLY the verdict — is the acceptance gate: a recorded
  // 'accept' accepts the candidate; anything else (revise/reject/blocked, or
  // no verdict at all) does not, no matter how the reviewer process exited.
  let verdict: ReviewSummary | null = reviewFromLedger;
  const authoritativeVerdict = pathsSafe ? readAuthoritativeVerdict(runPath, taskId) : null;
  if (authoritativeVerdict !== null) {
    verdict = authoritativeVerdict;
  }
  const review: ReviewActivity = {
    completions: reviewCompletions,
    verdict,
    accepted: verdict !== null && verdict.verdict === 'accept',
  };

  let squash: SquashSummary | null = null;
  const squashDoc = pathsSafe
    ? readJsonFile(join(runPath, 'authoritative', 'results', `${taskId}.squash.json`))
    : null;
  if (squashDoc !== null) {
    const integrationCommit = str(squashDoc.integration_commit);
    if (integrationCommit !== null) {
      squash = { integration_commit: integrationCommit, candidate_head: str(squashDoc.candidate_head) };
    }
  }
  if (squash === null && squashFromLedger !== null) {
    squash = { integration_commit: squashFromLedger, candidate_head: null };
  }

  return {
    task_id: taskId,
    vendor,
    spec_version: specVersion,
    amendments,
    attempts,
    signals,
    promote,
    review,
    squash,
    integrated_head: integratedHead,
    worktree_reaped: reaped,
  };
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function vendorName(value: unknown): string {
  const s = str(value)?.trim();
  return s ? s : 'unknown';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Aggregate agents/usage.jsonl per vendor — but only the rows tagged with
 * this run's run_id. Rows for other runs, and untagged legacy rows, never
 * leak into this run's summary. Returns null when the file is missing or no
 * row matches, so the section renders the explicit "(none recorded)" gap.
 */
function buildUsage(root: string, runId: string): Record<string, VendorUsage> | null {
  const usagePath = join(root, 'agents', 'usage.jsonl');
  if (!existsSync(usagePath)) return null;
  const events = (readJsonl(usagePath) as UsageEvent[]).filter((entry) => entry.run_id === runId);
  if (events.length === 0) return null;

  const measurements = aggregateUsageByVendor(events);
  const tokensByVendor = new Map<string, number>();
  for (const entry of events) {
    const vendor = vendorName(entry.vendor);
    tokensByVendor.set(vendor, (tokensByVendor.get(vendor) ?? 0) + toNumber(entry.tokens_out));
  }

  const usage: Record<string, VendorUsage> = {};
  for (const [vendor, measurement] of Object.entries(measurements)) {
    usage[vendor] = {
      n_dispatch: measurement.n_dispatch,
      total_cost_usd: measurement.total_cost_usd,
      median_cost_usd: measurement.median_cost_usd,
      total_tokens_out: tokensByVendor.get(vendor) ?? 0,
    };
  }
  return usage;
}

/**
 * What lives at authoritative/results/<task>.json:
 * - 'absent': nothing there;
 * - 'invalid': an entry that must NOT be treated as a result record — a
 *   symlink (lstat, never followed), a non-regular file such as a directory,
 *   unparseable JSON, a non-object document, or a record whose task identity
 *   contradicts the task or is absent entirely (see inspectResultFile);
 * - 'valid': a regular file of parseable JSON carrying this task's identity.
 */
type ResultEntryState =
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }
  | { state: 'valid' };

/**
 * Validate the authoritative result record for a task BEFORE treating it as
 * present. Never follows a symlink at the path: lstat decides the kind of
 * entry first. The record must carry the task's identity: the production
 * promoted-record envelope written by the promote lane ({ claims,
 * harness_observed, divergence, promoted_at }) keeps it at claims.task_id —
 * a top-level task_id is accepted only as the legacy fallback. A record whose
 * identity mismatches the task — or that carries no identity at all — is NOT
 * this task's record: mismatch-or-absent must render DIVERGENCE downstream,
 * never a silent pass.
 */
function inspectResultFile(path: string, taskId: string): ResultEntryState {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  if (stats.isSymbolicLink()) return { state: 'invalid', reason: 'symlink (never followed)' };
  if (!stats.isFile()) return { state: 'invalid', reason: 'not a regular file' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { state: 'invalid', reason: 'unparseable JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'invalid', reason: 'not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  const claims = record.claims;
  const envelopeTaskId = typeof claims === 'object' && claims !== null && !Array.isArray(claims)
    ? (claims as Record<string, unknown>).task_id
    : undefined;
  const recordTaskId = envelopeTaskId !== undefined ? envelopeTaskId : record.task_id;
  if (recordTaskId === undefined) {
    return { state: 'invalid', reason: 'no task identity: neither claims.task_id nor a legacy top-level task_id' };
  }
  if (recordTaskId !== taskId) {
    return { state: 'invalid', reason: `task_id mismatch: record carries ${JSON.stringify(recordTaskId)}` };
  }
  return { state: 'valid' };
}

/**
 * Reconcile the authoritative result tree with the ledger's promotion record
 * per task. A result file counts as present ONLY after passing
 * inspectResultFile; a directory, symlink, unparseable file, or a record
 * whose task identity mismatches or is absent at the result path must render
 * DIVERGENCE, never suppress it —
 * so an invalid entry flags against the ledger in both directions (a claimed
 * promotion has no valid record; a silent ledger has an unexplained entry).
 * Neither side is silently trusted. No path is constructed from a task id
 * that fails the strict pattern (such a task can never match a file).
 */
function reconcilePromotions(runPath: string, tasks: TaskLifecycle[]): ReconciliationFlag[] {
  const flags: ReconciliationFlag[] = [];
  for (const task of tasks) {
    const entry: ResultEntryState = isTaskId(task.task_id)
      ? inspectResultFile(join(runPath, 'authoritative', 'results', `${task.task_id}.json`), task.task_id)
      : { state: 'absent' };
    if (task.promote.promoted && entry.state !== 'valid') {
      flags.push({
        task_id: task.task_id,
        kind: 'ledger_without_file',
        detail: entry.state === 'invalid'
          ? `ledger records result_promoted but the authoritative result file is not a valid record: ${entry.reason}`
          : 'ledger records result_promoted but no authoritative result file exists',
      });
    } else if (!task.promote.promoted && entry.state === 'valid') {
      flags.push({
        task_id: task.task_id,
        kind: 'file_without_ledger',
        detail: 'an authoritative result file exists but the ledger records no result_promoted',
      });
    } else if (!task.promote.promoted && entry.state === 'invalid') {
      flags.push({
        task_id: task.task_id,
        kind: 'file_without_ledger',
        detail: `the entry at the authoritative result path is not a valid record (${entry.reason}) and the ledger records no result_promoted`,
      });
    }
  }
  return flags;
}

function buildRunLogData(
  runId: string,
  root: string,
  runPath: string,
  events: LedgerEntry[],
  anomalies: LedgerAnomaly[],
): RunLogData {
  const runStartedEntry = events.find((entry) => entry.event === 'run_started');
  const runStarted = runStartedEntry ? str(runStartedEntry.time) : null;

  let lastEvent: string | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const time = str(events[i].time);
    if (time !== null && parseTime(time) !== null) {
      lastEvent = time;
      break;
    }
  }

  let wallClockSeconds: number | null = null;
  const startedMs = parseTime(runStarted);
  const lastMs = parseTime(lastEvent);
  if (startedMs !== null && lastMs !== null) {
    wallClockSeconds = Math.max(0, Math.floor((lastMs - startedMs) / 1000));
  }

  let baseCommit: string | null = null;
  try {
    baseCommit = yamlScalar(join(runPath, 'run.yaml'), 'base_commit') || null;
  } catch {
    baseCommit = null;
  }
  if (baseCommit === null && runStartedEntry) {
    baseCommit = str(runStartedEntry.base_commit);
  }

  let headsDetected: RunLogData['heads_detected'] = null;
  const headsEntry = events.find((entry) => entry.event === 'heads_detected');
  if (headsEntry) {
    const available = (str(headsEntry.available) ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '' && name !== 'none');
    const countRaw = Number(str(headsEntry.count) ?? '');
    headsDetected = {
      available,
      count: Number.isFinite(countRaw) && countRaw > 0 ? countRaw : available.length,
    };
  }

  // Group events per task in one pass (not one filter scan per task).
  const eventsByTask = new Map<string, LedgerEntry[]>();
  for (const entry of events) {
    const taskId = str(entry.task_id);
    if (taskId === null) continue;
    const list = eventsByTask.get(taskId) ?? [];
    list.push(entry);
    eventsByTask.set(taskId, list);
  }
  const tasks = discoverTaskIds(runPath, events)
    .map((taskId) => buildTask(runPath, taskId, eventsByTask.get(taskId) ?? []));

  const timeline: TimelineEntry[] = events.map((entry) => ({
    time: str(entry.time),
    event: str(entry.event) ?? '(unknown event)',
    task_id: str(entry.task_id),
    detail: detailOf(entry),
  }));

  const divergences: DivergenceFlag[] = [];
  for (const entry of events) {
    if (entry.event === 'result_promoted' && (entry.divergence === 'true' || entry.divergence === true)) {
      divergences.push({
        task_id: str(entry.task_id) ?? 'unknown',
        head: str(entry.head),
        time: str(entry.time),
      });
    }
  }

  return {
    run_id: runId,
    base_commit: baseCommit,
    run_started: runStarted,
    last_event: lastEvent,
    wall_clock_seconds: wallClockSeconds,
    heads_detected: headsDetected,
    tasks,
    timeline,
    usage: buildUsage(root, runId),
    divergences,
    ledger_anomalies: anomalies,
    reconciliation: reconcilePromotions(runPath, tasks),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------

function formatSpan(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

/** Trim a float for display: 0.3500 -> "0.35", 2 -> "2". */
function formatCost(value: number): string {
  return value.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function renderSpecCell(task: TaskLifecycle): string {
  const parts: string[] = [];
  parts.push(task.spec_version === null || task.spec_version === '' ? NONE : `v${escapeMarkdown(task.spec_version)}`);
  for (const amendment of task.amendments) {
    const delivery = amendment.delivery === '' ? '' : ` (${escapeMarkdown(amendment.delivery)})`;
    const reason = amendment.reason === '' ? '' : `: ${escapeMarkdown(amendment.reason)}`;
    parts.push(`amended ${escapeMarkdown(amendment.from)} → ${escapeMarkdown(amendment.to)}${delivery}${reason}`);
  }
  return parts.join('<br>');
}

function renderAttemptsCell(attempts: DispatchAttempt[]): string {
  if (attempts.length === 0) return NONE;
  return attempts
    .map((attempt, index) => {
      const started = `started ${escapeMarkdown(attempt.started ?? '?')}`;
      if (attempt.ended === null) return `${index + 1}. ${started} — in flight`;
      return `${index + 1}. ${started} — ended ${escapeMarkdown(attempt.ended)} — ${escapeMarkdown(attempt.exit ?? '?')}`;
    })
    .join('<br>');
}

function renderSignalsCell(signals: TaskSignal[]): string {
  if (signals.length === 0) return NONE;
  return signals
    .map((signal) => {
      const detail = signal.detail === '' ? '' : ` (${escapeMarkdown(signal.detail)})`;
      return `${escapeMarkdown(signal.time ?? '?')} ${escapeMarkdown(signal.event)}${detail}`;
    })
    .join('<br>');
}

/** Short promote-cell phrase per reconciliation mismatch (our own constants). */
const RECON_CELL: Record<ReconciliationFlag['kind'], string> = {
  ledger_without_file: 'result file missing for ledger promotion',
  file_without_ledger: 'result file present without ledger promotion',
};

function renderPromoteCell(promote: PromoteOutcome, recon: ReconciliationFlag | undefined): string {
  const parts: string[] = [];
  for (const rejection of promote.rejections) {
    const detail = rejection.detail === '' ? '' : ` — ${escapeMarkdown(rejection.detail)}`;
    const time = rejection.time === null ? '' : ` (${escapeMarkdown(rejection.time)})`;
    parts.push(`rejected ${escapeMarkdown(rejection.reason)}${detail}${time}`);
  }
  if (promote.promoted) {
    const divergence = promote.divergence === null ? '' : ` (divergence=${escapeMarkdown(promote.divergence)})`;
    const time = promote.time === null ? '' : ` (${escapeMarkdown(promote.time)})`;
    parts.push(`promoted head=${cellCode(promote.head)}${divergence}${time}`);
  }
  // A ledger/tree mismatch is surfaced right where the promotion is claimed,
  // so the table never silently trusts either side.
  if (recon !== undefined) {
    parts.push(`DIVERGENCE: ${RECON_CELL[recon.kind]}`);
  }
  return parts.length === 0 ? NONE : parts.join('<br>');
}

/**
 * Render the three-state Review cell (issue #32). Each reviewer completion is
 * shown as process telemetry; the authoritative verdict — when recorded — is
 * shown separately; and only a recorded 'accept' verdict renders as accepted.
 * A completed review without a verdict reads "verdict pending", never
 * "(none recorded)" and NEVER accepted.
 */
function renderReviewCell(review: ReviewActivity): string {
  const parts: string[] = [];
  for (const completion of review.completions) {
    const meta = [
      completion.review_id === null ? '' : `review_id=${escapeMarkdown(completion.review_id)}`,
      completion.vendor === null ? '' : `vendor=${escapeMarkdown(completion.vendor)}`,
      completion.exit_code === null ? '' : `exit=${escapeMarkdown(completion.exit_code)}`,
      completion.time === null ? '' : escapeMarkdown(completion.time),
    ]
      .filter((part) => part !== '')
      .join(', ');
    parts.push(`reviewer completed${meta === '' ? '' : ` (${meta})`}`);
  }
  if (review.verdict !== null) {
    const summary = `${escapeMarkdown(review.verdict.verdict)} (reviewer=${escapeMarkdown(review.verdict.reviewer)}, risk=${escapeMarkdown(review.verdict.risk)})`;
    parts.push(review.accepted ? `accepted — verdict ${summary}` : `verdict ${summary} — not accepted`);
  } else if (review.completions.length > 0) {
    parts.push('verdict pending — a completed review is not a verdict');
  }
  return parts.length === 0 ? NONE : parts.join('<br>');
}

function renderTaskRow(task: TaskLifecycle, recon: ReconciliationFlag | undefined): string {
  const review = renderReviewCell(task.review);
  const squash = task.squash === null ? NONE : `integration_commit=${cellCode(task.squash.integration_commit)}`;
  const reaped = task.worktree_reaped === null
    ? NONE
    : `${escapeMarkdown(task.worktree_reaped.time ?? '?')}${task.worktree_reaped.detail === '' ? '' : ` (${escapeMarkdown(task.worktree_reaped.detail)})`}`;
  const cells = [
    `\`${escapeMarkdown(task.task_id)}\``,
    cell(task.vendor),
    renderSpecCell(task),
    renderAttemptsCell(task.attempts),
    renderSignalsCell(task.signals),
    renderPromoteCell(task.promote, recon),
    review,
    squash,
    cellCode(task.integrated_head),
    reaped,
  ];
  return `| ${cells.join(' | ')} |`;
}

function renderMarkdown(data: RunLogData): string {
  const lines: string[] = [];
  const reconByTask = new Map(data.reconciliation.map((flag) => [flag.task_id, flag]));
  lines.push(`# Hydra-Swarm run log — run \`${escapeMarkdown(data.run_id)}\``);
  lines.push('');
  lines.push('> Rendered from the authoritative ledger and state tree only. Every value is data, escaped for markdown; nothing from state is executed.');
  lines.push('');
  lines.push('## Run header');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Run ID | \`${escapeMarkdown(data.run_id)}\` |`);
  lines.push(`| Base commit | ${cellCode(data.base_commit)} |`);
  lines.push(`| Run started | ${cell(data.run_started)} |`);
  lines.push(`| Last event | ${cell(data.last_event)} |`);
  lines.push(`| Wall-clock span | ${data.wall_clock_seconds === null ? NONE : escapeMarkdown(formatSpan(data.wall_clock_seconds))} |`);
  const heads = data.heads_detected === null
    ? NONE
    : escapeMarkdown(`${data.heads_detected.available.join(',')} (${data.heads_detected.count})`);
  lines.push(`| Heads detected | ${heads} |`);
  lines.push('');

  lines.push('## Task lifecycle');
  lines.push('');
  if (data.tasks.length === 0) {
    lines.push(NONE);
  } else {
    lines.push('| Task | Vendor | Spec | Dispatch attempts | Timeout / cancel / loop | Promote | Review | Squash | Candidate integrated | Worktree reaped |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const task of data.tasks) {
      lines.push(renderTaskRow(task, reconByTask.get(task.task_id)));
    }
  }
  lines.push('');

  lines.push('## Event timeline');
  lines.push('');
  if (data.timeline.length === 0) {
    lines.push(NONE);
  } else {
    for (const entry of data.timeline) {
      const task = entry.task_id === null ? '' : ` (task \`${escapeMarkdown(entry.task_id)}\`)`;
      const detail = entry.detail === '' ? '' : ` — ${escapeMarkdown(entry.detail)}`;
      lines.push(`- \`${escapeMarkdown(entry.time ?? '(no time)')}\` **${escapeMarkdown(entry.event)}**${task}${detail}`);
    }
  }
  lines.push('');

  lines.push('## Ledger anomalies');
  lines.push('');
  if (data.ledger_anomalies.length === 0) {
    lines.push(NONE);
  } else {
    const count = data.ledger_anomalies.length;
    lines.push(`${count} malformed ledger ${count === 1 ? 'line' : 'lines'} skipped:`);
    for (const anomaly of data.ledger_anomalies) {
      lines.push(`- line ${anomaly.line}: ${escapeMarkdown(anomaly.reason)}`);
    }
  }
  lines.push('');

  lines.push('## Usage');
  lines.push('');
  if (data.usage === null || Object.keys(data.usage).length === 0) {
    lines.push(NONE);
  } else {
    lines.push('| Vendor | Dispatches | Total cost (USD) | Median cost (USD) | Tokens out |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const vendor of Object.keys(data.usage).sort()) {
      const usage = data.usage[vendor];
      lines.push(`| ${escapeMarkdown(vendor)} | ${usage.n_dispatch} | ${formatCost(usage.total_cost_usd)} | ${formatCost(usage.median_cost_usd)} | ${usage.total_tokens_out} |`);
    }
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  if (data.divergences.length === 0) {
    lines.push(`- Unresolved divergence flags: ${NONE}`);
  } else {
    lines.push('- Unresolved divergence flags:');
    for (const flag of data.divergences) {
      const head = flag.head === null ? '' : ` head=${cellCode(flag.head)}`;
      const time = flag.time === null ? '' : ` (${escapeMarkdown(flag.time)})`;
      lines.push(`  - task \`${escapeMarkdown(flag.task_id)}\` — promoted${head} flagged divergence${time}`);
    }
  }
  if (data.reconciliation.length === 0) {
    lines.push(`- Ledger/tree reconciliation: ${NONE}`);
  } else {
    lines.push('- Ledger/tree reconciliation:');
    for (const flag of data.reconciliation) {
      lines.push(`  - DIVERGENCE: task \`${escapeMarkdown(flag.task_id)}\` — ${escapeMarkdown(flag.detail)}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`.replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Output path resolution + entry points.
// ---------------------------------------------------------------------------

const defaultExec: ExecFunction = (file, args, options) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe', ...options }) as string;

/**
 * Output directory precedence: explicit --out option, then HYDRA_DEV_LOG_DIR,
 * then docs/hydra-dev-logs under the repo root (resolved via git; falls back
 * to cwd when the repo root cannot be determined).
 */
function resolveOutDir(options: RunLogOptions, cwd: string): string {
  if (options.outDir) return resolve(cwd, options.outDir);
  const envDir = process.env.HYDRA_DEV_LOG_DIR;
  if (envDir) return resolve(cwd, envDir);
  const execFn = options.exec ?? defaultExec;
  let repo = '';
  try {
    repo = execFn('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    repo = '';
  }
  return join(repo === '' ? cwd : repo, 'docs', 'hydra-dev-logs');
}

/** Write flags: create/truncate, and never follow a symlink at the final component. */
const WRITE_NOFOLLOW = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

/**
 * Resolve the output file safely: create the directory, canonicalize it with
 * realpath (so symlinked --out/HYDRA_DEV_LOG_DIR values resolve to their real
 * location), require the final path to stay underneath the canonical
 * directory, and refuse to follow a symlink planted at the output path.
 */
function prepareOutputPath(options: RunLogOptions, cwd: string, runId: string): string {
  const candidate = resolveOutDir(options, cwd);
  mkdirSync(candidate, { recursive: true });
  const canonical = realpathSync(candidate);
  // runId passed the strict id pattern, so the filename is a single safe segment.
  const outPath = join(canonical, `run-${runId}.md`);
  const rel = relative(canonical, outPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`hydra: error: output path escapes the canonical output directory: ${outPath}`);
  }
  try {
    if (lstatSync(outPath).isSymbolicLink()) {
      throw new Error(`hydra: error: refusing to follow symlink at output path: ${outPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return outPath;
}

/**
 * Generate the per-run lifecycle summary: a markdown audit record built from
 * the authoritative ledger (runs/run-<id>/authoritative/ledger/events.jsonl,
 * via readLines-style line splitting + JSON.parse per line), the authoritative
 * tree (results/, reviews/, results/<task>.squash.json) and the task specs.
 * Missing pieces render as explicit "(none recorded)" gaps so a partial log
 * is still a faithful snapshot. Writes docs/hydra-dev-logs/run-<id>.md
 * (idempotent overwrite) unless options.json is set.
 *
 * @param runId   Run identifier; must match the strict id pattern before any
 *                path is constructed from it.
 * @param options Injectable options bag (cwd, stateRoot, exec, outDir, json).
 * @returns The structured data, the rendered markdown, and the output path.
 */
export function runLog(runId: string, options: RunLogOptions = {}): RunLogResult {
  if (!runId) {
    throw new Error('hydra: error: usage: run-log <run_id> [--out <dir>] [--json]');
  }
  if (!isSafeId(runId)) {
    throw new Error(`hydra: error: invalid run_id ${JSON.stringify(runId)}: must match ${SAFE_ID_PATTERN}`);
  }
  const cwd = options.cwd ?? process.cwd();
  const root = options.stateRoot ? resolve(cwd, options.stateRoot) : defaultStateRoot();
  const runPath = join(root, 'runs', `run-${runId}`);
  const { entries, anomalies } = readLedgerEntries(join(runPath, 'authoritative', 'ledger', 'events.jsonl'), runId);

  const data = buildRunLogData(runId, root, runPath, entries, anomalies);
  const markdown = renderMarkdown(data);

  if (options.json) {
    return { data, markdown, outPath: null };
  }

  const outPath = prepareOutputPath(options, cwd, runId);
  // Open with O_NOFOLLOW (numeric flags do not fit writeFileSync's options
  // type): even against a TOCTOU swap after the lstat check, a symlink at the
  // output path makes the open fail with ELOOP instead of writing through.
  const fd = openSync(outPath, WRITE_NOFOLLOW);
  try {
    writeFileSync(fd, markdown, 'utf8');
  } finally {
    closeSync(fd);
  }
  log(`run log -> ${outPath}`);
  return { data, markdown, outPath };
}

export default {
  runLog,
  escapeMarkdown,
};

export function main(args: string[] = process.argv.slice(2), options: RunLogOptions = {}): number {
  const usage = 'hydra: error: usage: run-log <run_id> [--out <dir>] [--json]';
  try {
    let runId = '';
    let outDir: string | undefined;
    let json = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--out') {
        const next = args[i + 1];
        if (next === undefined) throw new Error(usage);
        outDir = next;
        i += 1;
      } else if (arg === '--json') {
        json = true;
      } else if (!arg.startsWith('-') && runId === '') {
        runId = arg;
      } else {
        throw new Error(usage);
      }
    }
    if (!runId) throw new Error(usage);

    const result = runLog(runId, { ...options, outDir: outDir ?? options.outDir, json });
    if (json) {
      process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.outPath}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
