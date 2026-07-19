import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, stateRoot, yamlScalar } from './lib.ts';
import { kimiEventText } from './dispatch.ts';
import { currentAttemptEvents, type LedgerEntry } from './current-attempt.ts';
import { isCompiledBinary } from './kit-assets.ts';
import {
  defaultListProcessesOrNull,
  validatedDispatchMatches,
  type ProcessInfo,
} from './process-discovery.ts';

export interface StatusOptions {
  /** Override for the external state root (used by tests). */
  stateRoot?: string;
  /** Override for the current working directory. */
  cwd?: string;
  /** Override for checking whether a PID is alive (used by tests). */
  processAlive?: (pid: number) => boolean;
  /** Override for process discovery (used by tests). Returns `null` when the
   * underlying process listing itself was unavailable (e.g. `ps` denied),
   * which is distinct from "ran and found zero matches" (`[]`). */
  listProcesses?: () => ProcessInfo[] | null;
  /** Override for the current time as a UNIX timestamp in milliseconds (used by tests). */
  now?: () => number;
  /** Number of progress lines to include (default 20). */
  lines?: number;
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
}

export interface LoopSuspicion {
  status: 'suspected' | 'confirmed';
  since: string;
  dominant_action_hash: string;
}

export interface StatusResult {
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'usage_limited' | 'unknown';
  agent_run_id: string;
  vendor: string;
  elapsed_seconds: number | null;
  timeout_minutes: number;
  hard_cap_minutes: number;
  dispatch_liveness: {
    pid: number | null;
    alive: boolean;
    advisory: true;
  } | null;
  disagreement: string | null;
  loop_suspicion: LoopSuspicion | null;
  progress_tail: string[];
  progress_source: string | null;
  ledger_events: Array<Record<string, unknown>>;
}

interface TaskSpec {
  vendor: string;
  timeoutMinutes: number;
  specVersion: string;
}

const TERMINAL_EVENTS = ['agent_exited', 'agent_cancelled', 'agent_timed_out', 'agent_usage_limited'];

// Grace window after task_started before we treat a missing dispatch pidfile as
// a disagreement. task_started is appended before the pidfile is written, and
// once a concurrency slot is acquired there is a brief mkdir/writeAtomic
// overhead before the pidfile appears. This constant covers that fast path;
// the still-queued case is covered by checking for a trailing concurrency_wait
// event in the current attempt window.
const DISPATCH_PIDFILE_GRACE_SECONDS = 3;

const defaultProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function isFile(path: string): boolean {
  try {
    return readFileSync(path) !== undefined;
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
    timeoutMinutes: timeout ? Number(timeout) : 45,
    specVersion: version || '1',
  };
}

function readLedger(ledgerPath: string, runId: string): LedgerEntry[] {
  if (!isFile(ledgerPath)) die(`no ledger for run ${runId}`);
  const content = readFileSync(ledgerPath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // Skip malformed or partial lines rather than aborting the whole read.
      // This is expected when status reads concurrently with a writer that
      // has appended data but not yet flushed the trailing newline.
    }
  }
  return entries;
}

function filterTaskEvents(events: LedgerEntry[], taskId: string): LedgerEntry[] {
  return events.filter((entry) => entry.task_id === taskId);
}

function isLastEventConcurrencyWait(events: LedgerEntry[]): boolean {
  if (events.length === 0) return false;
  return events[events.length - 1].event === 'concurrency_wait';
}

function determineState(events: LedgerEntry[]): StatusResult['state'] {
  if (events.length === 0) return 'unknown';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i].event;
    if (event === 'agent_exited') {
      // A pane worker that vanished without writing its exit sentinel is
      // recorded as agent_exited but must not be reported as a clean success.
      return events[i].reason === 'worker_disappeared' ? 'failed' : 'completed';
    }
    if (event === 'agent_cancelled') return 'cancelled';
    if (event === 'agent_timed_out') return 'timed_out';
    if (event === 'agent_usage_limited') return 'usage_limited';
  }
  const hasStarted = events.some((entry) => entry.event === 'task_started');
  return hasStarted ? 'running' : 'unknown';
}

const LOOP_TERMINAL_EVENTS = new Set([
  'agent_loop_suspected',
  'agent_loop_confirmed',
  'agent_loop_cleared',
  'agent_exited',
  'agent_cancelled',
  'agent_timed_out',
  'agent_usage_limited',
]);

function deriveLoopSuspicion(events: LedgerEntry[]): LoopSuspicion | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i].event;
    if (event === undefined || !LOOP_TERMINAL_EVENTS.has(event)) continue;
    if (event === 'agent_loop_suspected' || event === 'agent_loop_confirmed') {
      const hash = events[i].dominant_action_hash;
      if (typeof hash !== 'string' || hash === '') return null;
      return {
        status: event === 'agent_loop_suspected' ? 'suspected' : 'confirmed',
        since: events[i].time ?? '',
        dominant_action_hash: hash,
      };
    }
    return null;
  }
  return null;
}

function parseEventTime(time: string | undefined): Date | null {
  if (!time) return null;
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function formatElapsed(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0 || hrs > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

function tailLines(path: string, n: number): string[] {
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  // Drop a trailing empty line so it doesn't count against the limit.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

function codexEventText(line: string): string | undefined {
  let event: {
    type?: string;
    item?: {
      type?: string;
      text?: string;
      command?: string;
      changes?: Array<{ path?: string }>;
      server?: string;
      tool?: string;
    };
  };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return undefined;
  }
  const type = event.type;
  const item = event.item;
  if (!item) return undefined;

  if (type === 'item.completed' && item.type === 'agent_message' && item.text) {
    return item.text;
  }
  if (type === 'item.started' && item.type === 'command_execution' && item.command) {
    const cmd = item.command.split('\n').join(' ').slice(0, 140);
    return `\n[cmd] ${cmd}`;
  }
  if (type === 'item.started' && item.type === 'file_change') {
    const paths = (item.changes ?? [])
      .map((change) => {
        const parts = (change.path ?? '').split('/');
        return parts[parts.length - 1] ?? '';
      })
      .filter((segment) => segment !== '')
      .join(', ');
    return `\n[edit] ${paths}`;
  }
  if (type === 'item.started' && item.type === 'mcp_tool_call') {
    return `\n[tool] ${item.server ?? ''}.${item.tool ?? ''}`;
  }
  return undefined;
}

function extractProgressLine(line: string, vendor: string): string | undefined {
  if (vendor === 'kimi') return kimiEventText(line);
  if (vendor === 'codex') return codexEventText(line);
  return undefined;
}

function gatherProgressTail(
  sessionsDir: string,
  agentRunId: string,
  vendor: string,
  lines: number,
): { tail: string[]; source: string | null } {
  const cliJsonl = join(sessionsDir, `${agentRunId}.cli.jsonl`);
  if (isFile(cliJsonl)) {
    const raw = tailLines(cliJsonl, lines);
    const extracted = raw
      .map((line) => extractProgressLine(line, vendor))
      .filter((text): text is string => text !== undefined);
    return {
      tail: extracted.length > 0 ? extracted : raw,
      source: 'cli.jsonl',
    };
  }

  const eventsJsonl = join(sessionsDir, `${agentRunId}.events.jsonl`);
  if (isFile(eventsJsonl)) {
    return { tail: tailLines(eventsJsonl, lines), source: 'events.jsonl' };
  }

  const stderr = join(sessionsDir, `${agentRunId}.stderr`);
  if (isFile(stderr)) {
    return { tail: tailLines(stderr, lines), source: 'stderr' };
  }

  return { tail: [], source: null };
}

/** Outcome of the queued (no-pidfile, concurrency_wait) liveness discovery. */
type QueuedDiscovery =
  // A live, validated dispatcher was found — the task is genuinely healthy.
  | 'alive'
  // Discovery ran and found NO validated live dispatcher — the dispatcher may
  // have been killed while queued (the real blind-spot Task #33 closes).
  | 'dead'
  // Discovery itself could not run (e.g. `ps` denied). MUST NOT be reported as
  // a death — that would open the exact false-positive gap Task #33 avoids.
  | 'unavailable';

function detectDisagreement(
  state: StatusResult['state'],
  liveness: StatusResult['dispatch_liveness'],
  elapsedSeconds: number | null,
  attemptEvents: LedgerEntry[],
  queuedDiscovery: QueuedDiscovery,
): string | null {
  const alive = liveness?.alive ?? false;
  const hasPidfile = liveness !== null;

  if (state === 'running') {
    if (!hasPidfile) {
      // task_started is written before the pidfile. Suppress the missing-
      // pidfile disagreement when either (a) the task just started and the
      // brief mkdir/writeAtomic overhead has not elapsed yet, or (b) the task
      // is still queued waiting for a concurrency slot. In the queued case the
      // last event in the current attempt window is concurrency_wait and no
      // pidfile can exist yet. Unlike the old blind-trust suppression, we now
      // verify the dispatch process is genuinely alive via process discovery —
      // if the dispatcher was SIGKILLed while queued (OOM-killer, kill -9, host
      // reboot), no further ledger event is ever appended and the blind
      // suppression would hide the death forever. However, when discovery
      // itself was unavailable this tick we must NOT assert dispatcher death —
      // that would convert a degraded-observability condition into a spurious
      // disagreement, the precise false positive Task #33 forbids.
      if (elapsedSeconds === null || elapsedSeconds < DISPATCH_PIDFILE_GRACE_SECONDS) {
        return null;
      }
      if (isLastEventConcurrencyWait(attemptEvents)) {
        if (queuedDiscovery === 'alive') return null;
        if (queuedDiscovery === 'unavailable') return null;
        return 'ledger reports queued (concurrency_wait) but no live dispatch process was found; the dispatcher may have been killed while queued';
      }
      return 'ledger reports running but no dispatch pidfile exists';
    }
    if (!alive) {
      return 'ledger reports running but the dispatch process is not alive';
    }
  } else if (state !== 'unknown' && hasPidfile && alive) {
    return `ledger reports ${state} but the dispatch process is still alive`;
  }

  return null;
}

function renderHuman(result: StatusResult): string {
  const lines: string[] = [];
  lines.push(`state: ${result.state}`);
  lines.push(`agent_run_id: ${result.agent_run_id}`);
  lines.push(`vendor: ${result.vendor}`);
  lines.push(`elapsed: ${result.elapsed_seconds !== null ? formatElapsed(result.elapsed_seconds) : 'n/a'}`);
  lines.push(`timeout_minutes: ${result.timeout_minutes}`);
  lines.push(`hard_cap_minutes: ${result.hard_cap_minutes}`);

  if (result.dispatch_liveness) {
    const { pid, alive } = result.dispatch_liveness;
    lines.push(`dispatch_pid: ${pid ?? 'none'} (${alive ? 'alive' : 'dead'}, advisory)`);
  } else {
    lines.push('dispatch_pid: none (advisory)');
  }

  if (result.disagreement) {
    lines.push(`disagreement: ${result.disagreement}`);
  }

  if (result.loop_suspicion) {
    const { status, since, dominant_action_hash } = result.loop_suspicion;
    lines.push(`loop_suspicion: ${status} since ${since} (hash=${dominant_action_hash})`);
  }

  if (result.state === 'usage_limited') {
    const terminal = [...result.ledger_events].reverse()
      .find((entry) => entry.event === 'agent_usage_limited');
    if (terminal) {
      for (const key of ['vendor', 'provider', 'model', 'limit_kind', 'retry_at', 'raw_error']) {
        const value = terminal[key];
        if (value !== undefined && value !== null && value !== '') {
          lines.push(`usage_limit_${key}: ${String(value)}`);
        }
      }
    }
  }

  lines.push(`progress_tail (${result.progress_source ?? 'none'}):`);
  if (result.progress_tail.length === 0) {
    lines.push('  (no progress capture files found)');
  } else {
    for (const line of result.progress_tail) {
      lines.push(`  ${line}`);
    }
  }

  lines.push('ledger_events:');
  if (result.ledger_events.length === 0) {
    lines.push('  (no ledger events for this task)');
  } else {
    for (const entry of result.ledger_events) {
      const time = entry.time ?? '?';
      const event = entry.event ?? '?';
      const detail = Object.entries(entry)
        .filter(([key]) => key !== 'time' && key !== 'event' && key !== 'run_id' && key !== 'task_id')
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join('  ');
      lines.push(`  ${time}  ${event}${detail ? `  ${detail}` : ''}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function status(
  runId: string,
  taskId: string,
  options: StatusOptions = {},
): StatusResult {
  if (!runId || !taskId) die('usage: status <run_id> <task_id> [--lines N] [--json]');

  const cwd = options.cwd ?? process.cwd();
  const root = options.stateRoot ? resolve(cwd, options.stateRoot) : stateRoot();
  const runPath = join(root, 'runs', `run-${runId}`);
  const taskSpecPath = join(runPath, 'tasks', `${taskId}.yaml`);
  const spec = readTaskSpec(taskSpecPath);

  const agentRunId = `${runId}-${taskId}-v${spec.specVersion}`;
  const timeoutMinutes = spec.timeoutMinutes;
  const hardCapMinutes = Number(process.env.HYDRA_HARD_CAP_MIN || timeoutMinutes * 6);

  const ledgerPath = join(runPath, 'authoritative', 'ledger', 'events.jsonl');
  const allEvents = readLedger(ledgerPath, runId);
  const taskEvents = filterTaskEvents(allEvents, taskId);
  const { events: attemptEvents, startedEntry } = currentAttemptEvents(
    taskEvents,
    agentRunId,
  );
  const state = determineState(attemptEvents);

  const startedTime = parseEventTime(startedEntry?.time);
  const nowFn = options.now ?? (() => Date.now());
  const elapsedSeconds = startedTime !== null
    ? Math.max(0, Math.floor((nowFn() - startedTime.getTime()) / 1000))
    : null;

  const sessionsDir = join(runPath, 'sessions');
  const pidfilePath = join(sessionsDir, 'supervisor', `${agentRunId}.dispatch.pid`);
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const listProcesses = options.listProcesses ?? defaultListProcessesOrNull;
  let liveness: StatusResult['dispatch_liveness'] = null;
  if (isFile(pidfilePath)) {
    const pidText = readFileSync(pidfilePath, 'utf8').trim();
    const pid = pidText ? Number(pidText) : NaN;
    if (!Number.isNaN(pid) && pid > 0) {
      liveness = { pid, alive: processAlive(pid), advisory: true };
    }
  }

  // Real liveness check for the queued (no-pidfile, concurrency_wait) case.
  // If the dispatch process was SIGKILLed while parked in acquireSlot(), no
  // further ledger event is ever appended — scan live processes for a validated
  // dispatcher instead of blindly trusting the trailing concurrency_wait event.
  // Discovery has three distinct outcomes (see QueuedDiscovery): a validated
  // live dispatcher, a genuine "ran and found nothing" (which IS the death
  // signal), or discovery itself being unavailable (which is NOT a death
  // signal and must not produce a false-positive disagreement).
  let queuedDiscovery: QueuedDiscovery = 'dead';
  if (
    state === 'running'
    && liveness === null
    && elapsedSeconds !== null
    && elapsedSeconds >= DISPATCH_PIDFILE_GRACE_SECONDS
    && isLastEventConcurrencyWait(attemptEvents)
  ) {
    const processes = listProcesses();
    if (processes === null) {
      queuedDiscovery = 'unavailable';
    } else {
      const matches = validatedDispatchMatches(processes, processAlive, runId, taskId);
      queuedDiscovery = matches.length > 0 ? 'alive' : 'dead';
    }
  }

  const disagreement = detectDisagreement(
    state,
    liveness,
    elapsedSeconds,
    attemptEvents,
    queuedDiscovery,
  );
  const loopSuspicion = deriveLoopSuspicion(attemptEvents);

  const lines = options.lines ?? 20;
  const { tail: progressTail, source: progressSource } = gatherProgressTail(
    sessionsDir,
    agentRunId,
    spec.vendor,
    lines,
  );

  const lastEvents = attemptEvents.slice(-5);

  return {
    state,
    agent_run_id: agentRunId,
    vendor: spec.vendor,
    elapsed_seconds: elapsedSeconds,
    timeout_minutes: timeoutMinutes,
    hard_cap_minutes: hardCapMinutes,
    dispatch_liveness: liveness,
    disagreement,
    loop_suspicion: loopSuspicion,
    progress_tail: progressTail,
    progress_source: progressSource,
    ledger_events: lastEvents as Array<Record<string, unknown>>,
  };
}

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    let runId = '';
    let taskId = '';
    let lines: number | undefined;
    let json = false;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--lines') {
        const next = args[i + 1];
        if (next === undefined || !/^\d+$/.test(next)) {
          throw new Error('hydra: error: usage: status <run_id> <task_id> [--lines N] [--json]');
        }
        lines = Number(next);
        i += 1;
      } else if (arg === '--json') {
        json = true;
      } else if (!arg.startsWith('-') && runId === '') {
        runId = arg;
      } else if (!arg.startsWith('-') && taskId === '') {
        taskId = arg;
      } else {
        throw new Error('hydra: error: usage: status <run_id> <task_id> [--lines N] [--json]');
      }
    }

    const result = status(runId, taskId, { lines, json });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(renderHuman(result));
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
