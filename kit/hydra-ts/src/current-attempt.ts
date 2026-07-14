export interface LedgerEntry {
  time?: string;
  event?: string;
  run_id?: string;
  task_id?: string;
  agent_run_id?: string;
  dispatch_instance_id?: string;
  [key: string]: unknown;
}

/**
 * Isolate the event window for the current attempt. A task_id can be retried
 * with a new spec_version, leaving terminal events from earlier attempts in the
 * ledger. Only events at or after the task_started entry whose agent_run_id
 * matches the current agentRunId are considered. Terminal events from prior
 * attempts are ignored.
 *
 * The caller must supply ledger entries already filtered to the relevant task
 * (and run, if the ledger contains multiple runs).
 */
export function currentAttemptEvents(
  events: LedgerEntry[],
  agentRunId: string,
): { events: LedgerEntry[]; startedEntry: LedgerEntry | undefined } {
  // Scan backward so a duplicate task_started for the same agent_run_id uses
  // the most recent one as the window boundary.
  let startIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = events[i];
    if (entry.event === 'task_started' && entry.agent_run_id === agentRunId) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return { events: [], startedEntry: undefined };
  return { events: events.slice(startIndex), startedEntry: events[startIndex] };
}
