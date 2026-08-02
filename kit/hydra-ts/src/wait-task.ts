// hydra wait-task / wait-run — block until a task (or a set of tasks) reaches a
// terminal ledger state, then exit with a code that reflects the outcome.
//
// Why this exists (issue #41): leads previously hand-rolled completion watchers
// against the ledger. Those watchers failed SILENTLY — a wrong ledger path or a
// wrong terminal-event name produced a poll that could never match, and a wait
// that will never match is byte-identical to a wait that is working. One
// incident burned ~6h40m on exactly that. This module removes every place a
// caller could get it wrong:
//
//   * the ledger path and the terminal-event vocabulary are NOT re-derived here
//     — every observation goes through status.ts's exported status(), and the
//     event names come from status.ts's exported TERMINAL_EVENTS and
//     SUCCESS_TERMINAL_EVENT, so there is no second copy of either that could
//     drift from the real one;
//   * the outcome is read from status()'s authoritative terminal_* fields, which
//     status.ts derives from the full attempt window — never from its truncated
//     `ledger_events` display tail, where a genuine success can be pushed out of
//     view by later events and misread as a failure;
//   * success needs POSITIVE evidence (an agent_exited with exit_code "0"), so
//     a missing or non-zero exit_code never reads as a clean completion;
//   * a run/task that has no ledger entries at all fails loudly and IMMEDIATELY
//     instead of waiting forever on something that can never produce an event —
//     but a merely QUEUED task is waited on, never mistaken for an undispatched
//     one;
//   * a heartbeat line goes to stderr roughly once a minute, so "still working"
//     and "silently stuck" are visibly distinguishable within ~60 seconds.

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, stateRoot } from './lib.ts';
import {
  status,
  SUCCESS_TERMINAL_EVENT,
  TERMINAL_EVENTS,
  type StatusResult,
} from './status.ts';
import { isCompiledBinary } from './kit-assets.ts';

/** The subset of status.ts's state union that means "this attempt is over". */
type TerminalState = Exclude<StatusResult['state'], 'running' | 'unknown'>;

/**
 * The terminal-event vocabulary and the success-event identifier are both
 * IMPORTED from status.ts, never restated here. status.ts owns them; a second,
 * independently-maintained copy that could drift from the real list is exactly
 * the failure mode issue #41 exists to kill, so this module spells out no event
 * name of its own. The invariant they must jointly satisfy — the success event
 * is one of the terminal events — is asserted at load time, so a rename in
 * status.ts fails loudly here instead of degrading into a wait that can never
 * succeed.
 */
if (!new Set<string>(TERMINAL_EVENTS).has(SUCCESS_TERMINAL_EVENT)) {
  throw new Error(
    `hydra: wait-task: status.ts's TERMINAL_EVENTS no longer contains ${SUCCESS_TERMINAL_EVENT}`,
  );
}

function isTerminalState(state: StatusResult['state']): state is TerminalState {
  return state !== 'running' && state !== 'unknown';
}

/** Exit codes. Distinct so a caller can branch without parsing text. */
export const EXIT_SUCCESS = 0;
/** Usage error, or a run/task that does not resolve to a real ledger/task. */
export const EXIT_ERROR = 1;
/** The task reached a terminal state that is not a successful completion. */
export const EXIT_TASK_NOT_SUCCESSFUL = 2;
/** --timeout-seconds elapsed before any terminal event was observed. */
export const EXIT_WAIT_TIMED_OUT = 3;

export interface WaitTaskOptions {
  /** Override for the external state root (used by tests). */
  stateRoot?: string;
  /** Override for the current working directory. */
  cwd?: string;
  /** Give up waiting after this many seconds. Omitted/undefined waits forever. */
  timeoutSeconds?: number;
  /** Ledger poll interval in milliseconds (default 2000). */
  pollIntervalMs?: number;
  /** Seconds between heartbeat lines (default 60). 0 disables heartbeats. */
  heartbeatSeconds?: number;
  /** Override for the current time as a UNIX timestamp in ms (used by tests). */
  now?: () => number;
  /** Override for sleeping between polls (used by tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Override for heartbeat/progress output (used by tests). Defaults to stderr. */
  write?: (text: string) => void;
  /** Override for the status observation itself (used by tests). */
  observe?: (runId: string, taskId: string) => StatusResult;
}

export type WaitOutcome = 'succeeded' | 'failed' | 'wait_timed_out' | 'error';

export interface WaitTaskResult {
  run_id: string;
  task_id: string;
  /** succeeded | failed | wait_timed_out | error */
  outcome: WaitOutcome;
  /** The state status.ts reported at the moment the wait ended. */
  state: StatusResult['state'];
  /** The terminal ledger event that fired, or null if none did. */
  terminal_event: string | null;
  /** `reason` recorded on the terminal event (e.g. worker_disappeared). */
  reason: string | null;
  /** `exit_code` recorded on the terminal event, as a string. */
  exit_code: string | null;
  agent_run_id: string;
  vendor: string;
  waited_seconds: number;
  /** Populated only when outcome is 'error' (wait-run keeps per-task errors). */
  error: string | null;
}

export interface WaitRunResult {
  run_id: string;
  outcome: WaitOutcome;
  task_ids: string[];
  tasks: WaitTaskResult[];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const defaultWrite = (text: string): void => {
  // Heartbeats and per-task progress go to stderr so --json keeps stdout clean.
  process.stderr.write(text);
};

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

/**
 * The most recent event of any kind, used for heartbeat context ONLY. This one
 * reads the display tail on purpose: a heartbeat is a "what has this task done
 * lately" line, and the tail is exactly that. No outcome is ever decided here.
 */
function lastEvent(result: StatusResult): { event: string; time: string } {
  const entry = result.ledger_events[result.ledger_events.length - 1];
  return {
    event: asText(entry?.event) ?? '(none)',
    time: asText(entry?.time) ?? '(no timestamp)',
  };
}

/**
 * A terminal state alone does not mean success, and neither does the ABSENCE of
 * contrary evidence. status.ts already downgrades a vanished pane worker
 * (reason=worker_disappeared) from 'completed' to 'failed'; on top of that,
 * dispatch records agent_exited with a non-zero exit_code for adapter-outcome
 * failures, which status.ts still reports as 'completed'. Success therefore
 * requires POSITIVE evidence: a 'completed' state whose DETERMINING terminal
 * event is a SUCCESS_TERMINAL_EVENT carrying `exit_code` exactly "0". A
 * 'completed' state with no exit_code recorded is not proof of anything and must
 * not be reported as success — this fails closed, which is the whole point of a
 * primitive built to replace watchers that were confidently wrong.
 *
 * The evidence comes from status()'s terminal_* fields, which are derived from
 * the full attempt window. Searching `ledger_events` for it instead would report
 * a real success as a failure whenever later events (review_started, and so on)
 * push the agent_exited out of that truncated display tail.
 */
function isSuccessfulTerminal(state: TerminalState, result: StatusResult): boolean {
  if (state !== 'completed') return false;
  if (result.terminal_event !== SUCCESS_TERMINAL_EVENT) return false;
  return result.terminal_exit_code === '0';
}

function snapshot(
  runId: string,
  taskId: string,
  result: StatusResult,
  waitedSeconds: number,
): WaitTaskResult {
  const state = result.state;
  const outcome: WaitOutcome = isTerminalState(state)
    ? (isSuccessfulTerminal(state, result) ? 'succeeded' : 'failed')
    : 'wait_timed_out';
  return {
    run_id: runId,
    task_id: taskId,
    outcome,
    state,
    terminal_event: isTerminalState(state) ? result.terminal_event : null,
    reason: result.terminal_reason,
    exit_code: result.terminal_exit_code,
    agent_run_id: result.agent_run_id,
    vendor: result.vendor,
    waited_seconds: waitedSeconds,
    error: null,
  };
}

/**
 * Block until `taskId` in `runId` reaches a terminal ledger state.
 *
 * Throws (via die()) when the run or task does not resolve to a real ledger
 * entry at all — an unresolvable target must never turn into an unbounded wait.
 * A task that resolves but ends badly is NOT an exception: it comes back as a
 * result with outcome 'failed' so callers get the terminal event either way.
 */
export async function waitTask(
  runId: string,
  taskId: string,
  options: WaitTaskOptions = {},
): Promise<WaitTaskResult> {
  if (!runId || !taskId) die(WAIT_TASK_USAGE);

  const timeoutSeconds = options.timeoutSeconds;
  if (timeoutSeconds !== undefined
    && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0)) {
    die(WAIT_TASK_USAGE);
  }
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const heartbeatSeconds = options.heartbeatSeconds ?? 60;
  if (pollIntervalMs <= 0 || heartbeatSeconds < 0) {
    die('poll interval must be positive and heartbeat interval must be nonnegative');
  }

  const nowFn = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const write = options.write ?? defaultWrite;
  const observe = options.observe
    ?? ((run: string, task: string) =>
      status(run, task, { stateRoot: options.stateRoot, cwd: options.cwd }));

  const startedAt = nowFn();
  const elapsedSeconds = (): number => Math.max(0, Math.floor((nowFn() - startedAt) / 1000));
  const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000;

  // First observation. status() itself dies loudly on a missing run ledger or a
  // missing instantiated task spec.
  //
  // Beyond those, the only condition that can NEVER terminate is an attempt
  // window with no events whatsoever: nothing was ever dispatched, so no event
  // will ever arrive and waiting would hang forever. That — not the reported
  // state — is the fail-loud trigger.
  //
  // Keying off the reported state instead would be wrong. A task parked in
  // acquireSlot() waiting for a concurrency slot has ALREADY been dispatched:
  // dispatch appends task_started before it ever tries to acquire a slot, so a
  // queued attempt window is task_started followed by a trailing
  // concurrency_wait, and status.ts reports it as 'running'. It is a perfectly
  // normal non-terminal state that WILL produce terminal events, and must be
  // waited on like any other. Treating "no terminal event yet" as fatal would
  // make `wait-run <run>` over a batch larger than the concurrency limit report
  // instant errors for every queued task while everything was in fact fine —
  // the same confidently-wrong answer this primitive exists to eliminate.
  //
  // 'unknown' with a non-empty window is likewise waited on rather than treated
  // as fatal: it means status.ts saw attempt events but could not resolve a
  // task_started among them, which is an observation gap, not proof that
  // nothing was dispatched. Anything with events is waitable.
  let result = observe(runId, taskId);
  if (result.attempt_event_count === 0) {
    die(
      `no ledger events for ${runId}/${taskId} (agent_run_id ${result.agent_run_id}); `
      + 'the task was never dispatched, so waiting on it could never terminate — '
      + 'check the run_id/task_id, or dispatch the task first',
    );
  }

  let lastHeartbeatAt = startedAt;
  while (!isTerminalState(result.state)) {
    if (timeoutMs !== undefined && nowFn() - startedAt >= timeoutMs) {
      const timedOut = snapshot(runId, taskId, result, elapsedSeconds());
      write(
        `hydra: wait timed out on ${runId}/${taskId} after ${formatDuration(timedOut.waited_seconds)}`
        + ` (state ${timedOut.state}; no terminal event observed)\n`,
      );
      return timedOut;
    }

    if (heartbeatSeconds > 0 && nowFn() - lastHeartbeatAt >= heartbeatSeconds * 1000) {
      const seen = lastEvent(result);
      write(
        `hydra: still waiting on ${runId}/${taskId}: last observed event ${seen.event}`
        + ` at ${seen.time} (state ${result.state}, waited ${formatDuration(elapsedSeconds())})\n`,
      );
      lastHeartbeatAt = nowFn();
    }

    // Never sleep past the deadline: a long poll interval must not delay the
    // timeout report (the loop-top check above already handled remaining <= 0).
    const remainingMs = timeoutMs === undefined
      ? pollIntervalMs
      : Math.max(1, timeoutMs - (nowFn() - startedAt));
    await sleep(Math.min(pollIntervalMs, remainingMs));
    result = observe(runId, taskId);
  }

  return snapshot(runId, taskId, result, elapsedSeconds());
}

export interface WaitRunOptions extends WaitTaskOptions {
  /** Override for enumerating a run's task ids (used by tests). */
  listTasks?: (runId: string) => string[];
}

/** Every instantiated task spec in a run, by task_id, in stable order. */
function listRunTasks(runId: string, options: WaitRunOptions): string[] {
  const cwd = options.cwd ?? process.cwd();
  // stateRoot resolution mirrors status.ts line-for-line so both commands agree
  // on which run directory a given state root refers to.
  const root = options.stateRoot ? resolve(cwd, options.stateRoot) : stateRoot();
  const tasksDir = join(root, 'runs', `run-${runId}`, 'tasks');
  let names: string[];
  try {
    names = readdirSync(tasksDir);
  } catch {
    die(`no task specs for run ${runId} (looked in ${tasksDir})`);
  }
  const taskIds = names
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => name.slice(0, -'.yaml'.length))
    .sort();
  if (taskIds.length === 0) die(`run ${runId} has no instantiated task specs in ${tasksDir}`);
  return taskIds;
}

/**
 * Wait on several tasks at once. Every named task is waited on concurrently and
 * each one's outcome is reported to stderr the moment it lands, so a fan-out
 * wait never goes quiet either. The run succeeds only if every task does; a
 * task that cannot even be resolved is recorded as an 'error' entry rather than
 * aborting the other waits, so one bad task_id still yields a full report.
 */
export async function waitRun(
  runId: string,
  taskIds: string[] = [],
  options: WaitRunOptions = {},
): Promise<WaitRunResult> {
  if (!runId) die(WAIT_RUN_USAGE);
  const listTasks = options.listTasks ?? ((id: string) => listRunTasks(id, options));
  const targets = taskIds.length > 0 ? taskIds : listTasks(runId);
  const write = options.write ?? defaultWrite;

  const tasks = await Promise.all(targets.map(async (taskId): Promise<WaitTaskResult> => {
    try {
      const result = await waitTask(runId, taskId, options);
      write(
        `hydra: ${runId}/${taskId}: ${result.outcome}`
        + ` (${result.terminal_event ?? 'no terminal event'}`
        + `${result.exit_code === null ? '' : `, exit_code=${result.exit_code}`}`
        + `${result.reason === null ? '' : `, reason=${result.reason}`})\n`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(`hydra: ${runId}/${taskId}: error (${message})\n`);
      return {
        run_id: runId,
        task_id: taskId,
        outcome: 'error',
        state: 'unknown',
        terminal_event: null,
        reason: null,
        exit_code: null,
        agent_run_id: '',
        vendor: '',
        waited_seconds: 0,
        error: message,
      };
    }
  }));

  let outcome: WaitOutcome = 'succeeded';
  if (tasks.some((task) => task.outcome === 'error')) outcome = 'error';
  else if (tasks.some((task) => task.outcome === 'wait_timed_out')) outcome = 'wait_timed_out';
  else if (tasks.some((task) => task.outcome !== 'succeeded')) outcome = 'failed';

  return { run_id: runId, outcome, task_ids: targets, tasks };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const WAIT_TASK_USAGE =
  'usage: wait-task <run_id> <task_id> [--timeout-seconds N] [--poll-interval-ms N] [--heartbeat-seconds N] [--json]';
const WAIT_RUN_USAGE =
  'usage: wait-run <run_id> [task_id...] [--timeout-seconds N] [--poll-interval-ms N] [--heartbeat-seconds N] [--json]';

interface ParsedArgs {
  positionals: string[];
  json: boolean;
  options: WaitTaskOptions;
}

function parseArgs(args: string[], usage: string): ParsedArgs {
  const positionals: string[] = [];
  const options: WaitTaskOptions = {};
  let json = false;

  const numeric = (raw: string | undefined): number => {
    if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`hydra: error: ${usage}`);
    return Number(raw);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--timeout-seconds') {
      options.timeoutSeconds = numeric(args[index + 1]);
      index += 1;
    } else if (arg === '--poll-interval-ms') {
      options.pollIntervalMs = numeric(args[index + 1]);
      index += 1;
    } else if (arg === '--heartbeat-seconds') {
      options.heartbeatSeconds = numeric(args[index + 1]);
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    } else {
      throw new Error(`hydra: error: ${usage}`);
    }
  }
  return { positionals, json, options };
}

function renderTaskHuman(result: WaitTaskResult): string {
  const lines = [
    `run_id: ${result.run_id}`,
    `task_id: ${result.task_id}`,
    `outcome: ${result.outcome}`,
    `state: ${result.state}`,
    `terminal_event: ${result.terminal_event ?? 'none'}`,
  ];
  if (result.exit_code !== null) lines.push(`exit_code: ${result.exit_code}`);
  if (result.reason !== null) lines.push(`reason: ${result.reason}`);
  lines.push(`agent_run_id: ${result.agent_run_id}`);
  lines.push(`waited: ${formatDuration(result.waited_seconds)}`);
  if (result.error !== null) lines.push(`error: ${result.error}`);
  return `${lines.join('\n')}\n`;
}

function renderRunHuman(result: WaitRunResult): string {
  const lines = [`run_id: ${result.run_id}`, `outcome: ${result.outcome}`, 'tasks:'];
  for (const task of result.tasks) {
    const detail = task.error !== null
      ? task.error
      : `${task.terminal_event ?? 'no terminal event'}`
        + `${task.exit_code === null ? '' : `, exit_code=${task.exit_code}`}`
        + `${task.reason === null ? '' : `, reason=${task.reason}`}`;
    lines.push(`  ${task.task_id}: ${task.outcome} (${detail})`);
  }
  return `${lines.join('\n')}\n`;
}

function exitCodeFor(outcome: WaitOutcome): number {
  if (outcome === 'succeeded') return EXIT_SUCCESS;
  if (outcome === 'wait_timed_out') return EXIT_WAIT_TIMED_OUT;
  if (outcome === 'error') return EXIT_ERROR;
  return EXIT_TASK_NOT_SUCCESSFUL;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { positionals, json, options } = parseArgs(args, WAIT_TASK_USAGE);
    if (positionals.length !== 2) throw new Error(`hydra: error: ${WAIT_TASK_USAGE}`);
    const result = await waitTask(positionals[0], positionals[1], options);
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderTaskHuman(result));
    return exitCodeFor(result.outcome);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
}

export async function mainRun(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { positionals, json, options } = parseArgs(args, WAIT_RUN_USAGE);
    if (positionals.length < 1) throw new Error(`hydra: error: ${WAIT_RUN_USAGE}`);
    const result = await waitRun(positionals[0], positionals.slice(1), options);
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderRunHuman(result));
    return exitCodeFor(result.outcome);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
