import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';

export interface ProcessInfo {
  pid: number;
  command: string;
}

function parseProcessTable(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), command: match[2] });
  }
  return processes;
}

/**
 * Run process discovery. Returns `null` when the underlying `ps` invocation
 * itself failed (denied permission, binary missing, transient error) — which
 * MUST be distinguished from "ran and found zero matches" (`[]`). Returning an
 * empty array on a `ps` failure would let callers mistake "discovery was
 * unavailable this tick" for "the dispatcher is genuinely gone," producing a
 * false-positive death report for a task that is merely still queued.
 */
export function defaultListProcessesOrNull(): ProcessInfo[] | null {
  let output: string;
  try {
    output = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    } as ExecFileSyncOptionsWithStringEncoding);
  } catch {
    return null;
  }
  return parseProcessTable(output);
}

/**
 * Process discovery that collapses an unavailable `ps` into an empty list.
 * Preserved for callers (cancel-task.ts) whose existing contract treats any
 * discovery failure as "no matches found." New liveness callers that must
 * distinguish the two outcomes should use `defaultListProcessesOrNull`.
 */
export function defaultListProcesses(): ProcessInfo[] {
  return defaultListProcessesOrNull() ?? [];
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Validate that a discovered command is a dispatcher for this exact run/task. */
export function isDispatchCommand(command: string, runId: string, taskId: string): boolean {
  const tokens = command
    .trim()
    .split(/\s+/)
    .map(stripOuterQuotes);
  const dispatchIndex = tokens.findIndex((token) => {
    const basename = token.split('/').at(-1);
    return basename === 'dispatch.ts' || basename === 'dispatch.sh';
  });
  if (dispatchIndex < 0) return false;
  const args = tokens.slice(dispatchIndex + 1);
  return args.includes(runId) && args.includes(taskId);
}

export function safeProcessAlive(
  processAlive: (pid: number) => boolean,
  pid: number,
): boolean {
  try {
    return processAlive(pid);
  } catch {
    return false;
  }
}

/** Return processes that are alive AND validate as dispatchers for run/task. */
export function validatedDispatchMatches(
  processes: ProcessInfo[],
  processAlive: (pid: number) => boolean,
  runId: string,
  taskId: string,
): ProcessInfo[] {
  return processes.filter(({ pid, command }) =>
    pid > 0
    && safeProcessAlive(processAlive, pid)
    && isDispatchCommand(command, runId, taskId));
}

/** Does any process with this PID have a validated dispatch command? */
export function processIsDispatch(
  processes: ProcessInfo[],
  pid: number,
  runId: string,
  taskId: string,
): boolean {
  return processes.some((process) =>
    process.pid === pid && isDispatchCommand(process.command, runId, taskId));
}
