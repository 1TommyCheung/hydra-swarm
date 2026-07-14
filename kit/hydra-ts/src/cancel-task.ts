import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, stateRoot, yamlScalar } from './lib.ts';
import { currentAttemptEvents, type LedgerEntry } from './current-attempt.ts';
import {
  defaultListProcesses,
  isDispatchCommand,
  processIsDispatch,
  safeProcessAlive,
  validatedDispatchMatches,
  type ProcessInfo,
} from './process-discovery.ts';

export type CancelSignal = 'SIGTERM' | 'SIGKILL';

export { isDispatchCommand, type ProcessInfo };

export interface CancelTaskOptions {
  /** Override for the external state root (used by tests). */
  stateRoot?: string;
  /** Override for the current working directory. */
  cwd?: string;
  /** Seconds to wait for a clean terminal event after SIGTERM (default 15). */
  waitSeconds?: number;
  /** Poll interval in milliseconds (default 500). */
  pollIntervalMs?: number;
  /** Grace period after escalation or dispatcher exit (default 2000ms). */
  killGraceMs?: number;
  /** Override for checking whether a PID is alive (used by tests). */
  processAlive?: (pid: number) => boolean;
  /** Override for signalling a process (used by tests). */
  signalProcess?: (pid: number, signal: CancelSignal) => void;
  /** Override for process discovery (used by tests). */
  listProcesses?: () => ProcessInfo[];
  /** Override for sleeping between ledger reads (used by tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Override for command output (used by tests). */
  write?: (text: string) => void;
}

export interface CancelTaskResult {
  outcome: 'already_terminal' | 'terminated' | 'terminated_after_kill';
  agent_run_id: string;
  dispatch_pid: number | null;
  terminal_event: Record<string, unknown>;
}

interface TaskSpec {
  specVersion: string;
}

interface AttemptSnapshot {
  events: LedgerEntry[];
  startedEntry: LedgerEntry | undefined;
  terminalEntry: LedgerEntry | undefined;
}

const TERMINAL_EVENTS = new Set(['agent_exited', 'agent_cancelled', 'agent_timed_out']);

const defaultProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const defaultSignalProcess = (pid: number, signal: CancelSignal): void => {
  process.kill(pid, signal);
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function isFile(path: string): boolean {
  try {
    return readFileSync(path) !== undefined;
  } catch {
    return false;
  }
}

function readTaskSpec(path: string): TaskSpec {
  if (!isFile(path)) die(`instantiated task spec not found: ${path}`);
  return { specVersion: yamlScalar(path, 'spec_version') || '1' };
}

function readLedger(path: string, runId: string): LedgerEntry[] {
  if (!isFile(path)) die(`no ledger for run ${runId}`);
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // A status/cancel read can race an append. Ignore malformed or partial
      // lines and wait for a later complete authoritative ledger record.
    }
  }
  return entries;
}

/**
 * Isolate the latest current-attempt window using the same boundary as
 * status.ts: scan backward for the newest task_started whose agent_run_id
 * matches the current task spec, then ignore everything before it.
 */
function currentAttemptSnapshot(
  ledgerPath: string,
  runId: string,
  taskId: string,
  agentRunId: string,
): AttemptSnapshot {
  const taskEvents = readLedger(ledgerPath, runId)
    .filter((entry) => entry.task_id === taskId);
  const { events, startedEntry } = currentAttemptEvents(taskEvents, agentRunId);
  if (startedEntry === undefined) {
    return { events: [], startedEntry: undefined, terminalEntry: undefined };
  }

  let terminalEntry: LedgerEntry | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (TERMINAL_EVENTS.has(events[index].event ?? '')) {
      terminalEntry = events[index];
      break;
    }
  }
  return { events, startedEntry, terminalEntry };
}

function readPidfile(path: string): number | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!/^\d+$/.test(value)) return undefined;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isLastEventConcurrencyWait(events: LedgerEntry[]): boolean {
  return events.length > 0 && events.at(-1)?.event === 'concurrency_wait';
}

function emitTerminal(write: (text: string) => void, entry: LedgerEntry): void {
  write(`${entry.event ?? 'terminal'}: ${JSON.stringify(entry)}\n`);
}

async function waitForTerminal(
  ledgerPath: string,
  runId: string,
  taskId: string,
  agentRunId: string,
  waitMs: number,
  pollIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<LedgerEntry | undefined> {
  let elapsed = 0;
  while (true) {
    const terminal = currentAttemptSnapshot(ledgerPath, runId, taskId, agentRunId).terminalEntry;
    if (terminal) return terminal;
    if (elapsed >= waitMs) return undefined;
    const delay = Math.min(pollIntervalMs, waitMs - elapsed);
    await sleep(delay);
    elapsed += delay;
  }
}

function orphanError(pid: number): Error {
  return new Error(
    `hydra: error: ORPHAN: dispatch process ${pid} stopped without a terminal ledger event; manual investigation required (no ledger event was fabricated)`,
  );
}

export async function cancelTask(
  runId: string,
  taskId: string,
  options: CancelTaskOptions = {},
): Promise<CancelTaskResult> {
  if (!runId || !taskId) {
    die('usage: cancel-task <run_id> <task_id> [--wait-seconds N]');
  }

  const waitSeconds = options.waitSeconds ?? 15;
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0) {
    die('usage: cancel-task <run_id> <task_id> [--wait-seconds N]');
  }
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const killGraceMs = options.killGraceMs ?? 2000;
  if (pollIntervalMs <= 0 || killGraceMs < 0) {
    die('poll interval must be positive and kill grace must be nonnegative');
  }

  const cwd = options.cwd ?? process.cwd();
  const root = options.stateRoot ? resolve(cwd, options.stateRoot) : stateRoot();
  const runPath = join(root, 'runs', `run-${runId}`);
  const spec = readTaskSpec(join(runPath, 'tasks', `${taskId}.yaml`));
  const agentRunId = `${runId}-${taskId}-v${spec.specVersion}`;
  const ledgerPath = join(runPath, 'authoritative', 'ledger', 'events.jsonl');
  let snapshot = currentAttemptSnapshot(ledgerPath, runId, taskId, agentRunId);

  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (snapshot.terminalEntry) {
    emitTerminal(write, snapshot.terminalEntry);
    return {
      outcome: 'already_terminal',
      agent_run_id: agentRunId,
      dispatch_pid: null,
      terminal_event: snapshot.terminalEntry,
    };
  }
  if (!snapshot.startedEntry) {
    die(`no such task/attempt: ${runId}/${taskId} (${agentRunId})`);
  }

  const processAlive = options.processAlive ?? defaultProcessAlive;
  const signalProcess = options.signalProcess ?? defaultSignalProcess;
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  const pidfilePath = join(
    runPath,
    'sessions',
    'supervisor',
    `${agentRunId}.dispatch.pid`,
  );
  let dispatchPid: number | undefined;
  let discoveryProcesses: ProcessInfo[] | undefined;

  let shouldDiscover = isLastEventConcurrencyWait(snapshot.events);
  if (existsSync(pidfilePath)) {
    const pid = readPidfile(pidfilePath);
    if (pid !== undefined && safeProcessAlive(processAlive, pid)) {
      const processes = listProcesses();
      if (processIsDispatch(processes, pid, runId, taskId)) {
        dispatchPid = pid;
      } else {
        // SIGKILL can leave a stale pidfile behind. Never trust a live, reused
        // PID; search the same process snapshot for the real dispatcher.
        shouldDiscover = true;
        discoveryProcesses = processes;
      }
    }
  }

  if (dispatchPid === undefined && shouldDiscover) {
    const matches = validatedDispatchMatches(
      discoveryProcesses ?? listProcesses(),
      processAlive,
      runId,
      taskId,
    );
    if (matches.length > 1) {
      die(`multiple validated dispatch processes found for ${runId}/${taskId}; refusing to guess`);
    }
    dispatchPid = matches[0]?.pid;
  }

  if (dispatchPid === undefined) {
    die(`dispatch process not found for ${runId}/${taskId}`);
  }

  // Close the race with another cancel invocation or normal worker exit before
  // delivering a signal. The command never mutates the ledger itself.
  snapshot = currentAttemptSnapshot(ledgerPath, runId, taskId, agentRunId);
  if (snapshot.terminalEntry) {
    emitTerminal(write, snapshot.terminalEntry);
    return {
      outcome: 'already_terminal',
      agent_run_id: agentRunId,
      dispatch_pid: dispatchPid,
      terminal_event: snapshot.terminalEntry,
    };
  }
  if (!safeProcessAlive(processAlive, dispatchPid)) {
    die(`dispatch process not found for ${runId}/${taskId}`);
  }

  try {
    signalProcess(dispatchPid, 'SIGTERM');
  } catch {
    const terminal = currentAttemptSnapshot(ledgerPath, runId, taskId, agentRunId).terminalEntry;
    if (terminal) {
      emitTerminal(write, terminal);
      return {
        outcome: 'terminated',
        agent_run_id: agentRunId,
        dispatch_pid: dispatchPid,
        terminal_event: terminal,
      };
    }
    die(`dispatch process not found for ${runId}/${taskId}`);
  }

  const sleep = options.sleep ?? defaultSleep;
  let terminal = await waitForTerminal(
    ledgerPath,
    runId,
    taskId,
    agentRunId,
    waitSeconds * 1000,
    pollIntervalMs,
    sleep,
  );
  if (terminal) {
    emitTerminal(write, terminal);
    return {
      outcome: 'terminated',
      agent_run_id: agentRunId,
      dispatch_pid: dispatchPid,
      terminal_event: terminal,
    };
  }

  // Re-read both sources immediately before escalation. If SIGTERM is still
  // completing, a terminal event or a dead PID turns escalation into a no-op.
  terminal = currentAttemptSnapshot(ledgerPath, runId, taskId, agentRunId).terminalEntry;
  if (terminal) {
    emitTerminal(write, terminal);
    return {
      outcome: 'terminated',
      agent_run_id: agentRunId,
      dispatch_pid: dispatchPid,
      terminal_event: terminal,
    };
  }

  let escalated = false;
  if (safeProcessAlive(processAlive, dispatchPid)) {
    // One final ledger read narrows the cancel-vs-escalate race without adding
    // any lock or state mutation to this observer-only command.
    terminal = currentAttemptSnapshot(ledgerPath, runId, taskId, agentRunId).terminalEntry;
    if (terminal) {
      emitTerminal(write, terminal);
      return {
        outcome: 'terminated',
        agent_run_id: agentRunId,
        dispatch_pid: dispatchPid,
        terminal_event: terminal,
      };
    }
    if (
      safeProcessAlive(processAlive, dispatchPid)
      && processIsDispatch(listProcesses(), dispatchPid, runId, taskId)
    ) {
      try {
        signalProcess(dispatchPid, 'SIGKILL');
        escalated = true;
      } catch {
        // ESRCH here means the dispatcher died between the liveness probe and
        // signal delivery. The final ledger grace/read below decides outcome.
      }
    }
  }

  if (killGraceMs > 0) await sleep(killGraceMs);
  terminal = currentAttemptSnapshot(ledgerPath, runId, taskId, agentRunId).terminalEntry;
  if (terminal) {
    emitTerminal(write, terminal);
    return {
      outcome: escalated ? 'terminated_after_kill' : 'terminated',
      agent_run_id: agentRunId,
      dispatch_pid: dispatchPid,
      terminal_event: terminal,
    };
  }

  throw orphanError(dispatchPid);
}

function usageError(): Error {
  return new Error('hydra: error: usage: cancel-task <run_id> <task_id> [--wait-seconds N]');
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    let runId = '';
    let taskId = '';
    let waitSeconds: number | undefined;

    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--wait-seconds') {
        const next = args[index + 1];
        if (next === undefined || !/^\d+$/.test(next)) throw usageError();
        waitSeconds = Number(next);
        index += 1;
      } else if (!arg.startsWith('-') && runId === '') {
        runId = arg;
      } else if (!arg.startsWith('-') && taskId === '') {
        taskId = arg;
      } else {
        throw usageError();
      }
    }

    if (!runId || !taskId) throw usageError();
    await cancelTask(runId, taskId, { waitSeconds });
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
