export interface LedgerEntry {
  time?: string;
  event?: string;
  run_id?: string;
  task_id?: string;
  agent_run_id?: string;
  dispatch_instance_id?: string;
  spec_version?: string | number;
  attempt_ordinal?: string | number;
  [key: string]: unknown;
}

export interface CurrentAttempt {
  agentRunId: string;
  attemptOrdinal: number;
  events: LedgerEntry[];
  startedEntry: LedgerEntry;
}

export function agentRunIdForAttempt(
  runId: string,
  taskId: string,
  specVersion: string,
  attemptOrdinal: number,
): string {
  const base = `${runId}-${taskId}-v${specVersion}`;
  return attemptOrdinal === 1 ? base : `${base}-a${attemptOrdinal}`;
}

export function attemptOrdinalFromAgentRunId(
  agentRunId: string,
  runId: string,
  taskId: string,
  specVersion: string,
): number | undefined {
  const base = `${runId}-${taskId}-v${specVersion}`;
  if (agentRunId === base) return 1;
  if (!agentRunId.startsWith(`${base}-a`)) return undefined;
  const suffix = agentRunId.slice(base.length + 2);
  if (!/^[1-9]\d*$/.test(suffix)) return undefined;
  const ordinal = Number(suffix);
  return Number.isSafeInteger(ordinal) && ordinal >= 2 ? ordinal : undefined;
}

function canonicalOrdinal(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) return undefined;
  const ordinal = Number(text);
  return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}

function startedOrdinal(
  entry: LedgerEntry,
  runId: string,
  taskId: string,
  specVersion: string,
): number | undefined {
  if (entry.event !== 'task_started' || typeof entry.agent_run_id !== 'string') return undefined;
  const parsed = attemptOrdinalFromAgentRunId(entry.agent_run_id, runId, taskId, specVersion);
  if (parsed === undefined) return undefined;

  const hasModernFields = entry.spec_version !== undefined || entry.attempt_ordinal !== undefined;
  if (!hasModernFields) return parsed;
  if (String(entry.spec_version) !== specVersion) return undefined;
  const recorded = canonicalOrdinal(entry.attempt_ordinal);
  if (recorded !== parsed) return undefined;
  return recorded;
}

/** Select the greatest validated attempt ordinal, independent of append order,
 * then isolate events belonging to that dispatch instance. Historical starts
 * without an instance ID use only their bounded append window and reject any
 * event carrying a different explicit identity. */
export function currentAttemptEvents(
  events: LedgerEntry[],
  agentRunId: string,
): { events: LedgerEntry[]; startedEntry: LedgerEntry | undefined };
export function currentAttemptEvents(
  events: LedgerEntry[],
  runId: string,
  taskId: string,
  specVersion: string,
): CurrentAttempt | undefined;
export function currentAttemptEvents(
  events: LedgerEntry[],
  runIdOrAgentRunId: string,
  taskId?: string,
  specVersion?: string,
): CurrentAttempt | { events: LedgerEntry[]; startedEntry: LedgerEntry | undefined } | undefined {
  // Compatibility surface for loop-detector.ts and historical callers that
  // already know their exact agent_run_id. Instance filtering still applies.
  if (taskId === undefined || specVersion === undefined) {
    let startIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].event === 'task_started'
        && events[index].agent_run_id === runIdOrAgentRunId) {
        startIndex = index;
        break;
      }
    }
    if (startIndex < 0) return { events: [], startedEntry: undefined };
    const startedEntry = events[startIndex];
    const instanceId = startedEntry.dispatch_instance_id;
    if (typeof instanceId === 'string' && instanceId !== '') {
      return {
        events: events.filter((entry) => entry.dispatch_instance_id === instanceId),
        startedEntry,
      };
    }
    let endIndex = events.length;
    for (let index = startIndex + 1; index < events.length; index += 1) {
      if (events[index].event === 'task_started') { endIndex = index; break; }
    }
    return {
      events: events.slice(startIndex, endIndex).filter((entry) =>
        entry.dispatch_instance_id === undefined
        && (entry.agent_run_id === undefined || entry.agent_run_id === runIdOrAgentRunId)),
      startedEntry,
    };
  }

  const runId = runIdOrAgentRunId;
  let selectedIndex = -1;
  let selectedOrdinal = -1;
  for (let index = 0; index < events.length; index += 1) {
    const ordinal = startedOrdinal(events[index], runId, taskId, specVersion);
    if (ordinal === undefined) continue;
    if (ordinal > selectedOrdinal || ordinal === selectedOrdinal) {
      selectedOrdinal = ordinal;
      selectedIndex = index;
    }
  }
  if (selectedIndex < 0) return undefined;

  const startedEntry = events[selectedIndex];
  const agentRunId = startedEntry.agent_run_id as string;
  const instanceId = startedEntry.dispatch_instance_id;
  let attemptEvents: LedgerEntry[];
  if (typeof instanceId === 'string' && instanceId !== '') {
    attemptEvents = events.filter((entry) => entry.dispatch_instance_id === instanceId);
  } else {
    let endIndex = events.length;
    for (let index = selectedIndex + 1; index < events.length; index += 1) {
      if (events[index].event === 'task_started') {
        endIndex = index;
        break;
      }
    }
    attemptEvents = events.slice(selectedIndex, endIndex).filter((entry) =>
      entry.dispatch_instance_id === undefined
      && (entry.agent_run_id === undefined || entry.agent_run_id === agentRunId));
  }

  return { agentRunId, attemptOrdinal: selectedOrdinal, events: attemptEvents, startedEntry };
}
