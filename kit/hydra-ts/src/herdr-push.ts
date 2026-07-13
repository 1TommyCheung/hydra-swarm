import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ledger,
  ledgerAppend,
  log,
  now,
  runDir,
  warn,
  yamlScalar,
} from './lib.ts';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface HerdrPushOptions {
  /** Working directory for external commands (git, herdr). */
  cwd?: string;
  /** Override the Hydra state root. */
  stateRoot?: string;
  /** Override the repository root (otherwise discovered via git). */
  repoRoot?: string;
  /** Also raise a herdr notification for the latest significant event. */
  notify?: boolean;
  /** Inject command execution (used by tests to mock git/herdr). */
  exec?: (file: string, args: string[], options?: ExecFileSyncOptions) => string;
}

interface LedgerEntry {
  event?: string | null;
  task_id?: string | null;
  vendor?: string;
  status?: string;
  [key: string]: unknown;
}

export interface PaneState {
  task: string;
  vendor: string;
  last_event: string | null;
  promoted: boolean;
  rejected: boolean;
  running: boolean;
}

// ---------------------------------------------------------------------------
// Command execution.
// ---------------------------------------------------------------------------

function defaultExec(
  file: string,
  args: string[],
  options?: ExecFileSyncOptions,
): string {
  return execFileSync(file, args, { encoding: 'utf8', ...options }) as string;
}

// ---------------------------------------------------------------------------
// Ledger -> pane state derivation.
// ---------------------------------------------------------------------------

function derivePanes(events: LedgerEntry[]): PaneState[] {
  const vendorMap: Record<string, string> = {};
  for (const e of events) {
    if (
      e.event === 'task_started' &&
      e.task_id != null &&
      typeof e.vendor === 'string'
    ) {
      vendorMap[e.task_id] = e.vendor;
    }
  }

  const byTask = new Map<string, LedgerEntry[]>();
  for (const e of events) {
    const taskId = e.task_id ?? 'run';
    const taskEvents = byTask.get(taskId) ?? [];
    taskEvents.push(e);
    byTask.set(taskId, taskEvents);
  }

  const panes: PaneState[] = [];
  const taskGroups = [...byTask.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [, taskEvents] of taskGroups) {
    // jq's group key is `.task_id // "run"`, but its filter checks the first
    // entry's original task_id. This keeps a literal "run" task unless a
    // null-task event precedes it in the shared group.
    const task = taskEvents[0]?.task_id;
    if (task == null) continue;

    const started = taskEvents.filter((e) => e.event === 'task_started').length;
    const ended = taskEvents.filter(
      (e) =>
        e.event === 'agent_exited' ||
        e.event === 'agent_timed_out' ||
        e.event === 'agent_cancelled',
    ).length;

    panes.push({
      task,
      vendor: vendorMap[task] ?? '-',
      last_event: taskEvents.at(-1)?.event ?? null,
      promoted: taskEvents.some((e) => e.event === 'result_promoted'),
      rejected: taskEvents.some((e) => e.event === 'result_rejected'),
      running: started > ended,
    });
  }

  return panes;
}

function appendAnomaly(
  runId: string,
  ledgerPath: string,
  task: string,
  ledgerRunning: boolean,
  liveWorking: boolean,
): void {
  // Preserve the foundation helper on the standard path. An explicit
  // stateRoot has already been resolved and must not be installed globally.
  if (ledgerPath === ledger(runId)) {
    ledgerAppend(
      runId,
      'observability_anomaly',
      'task_id',
      task,
      'ledger_running',
      String(ledgerRunning),
      'live_working',
      String(liveWorking),
      'note',
      'live view disagrees with ledger; ledger is authoritative',
    );
    return;
  }

  appendFileSync(
    ledgerPath,
    `${JSON.stringify({
      time: now(),
      event: 'observability_anomaly',
      run_id: runId,
      task_id: task,
      ledger_running: String(ledgerRunning),
      live_working: String(liveWorking),
      note: 'live view disagrees with ledger; ledger is authoritative',
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Herdr push.
// ---------------------------------------------------------------------------

/**
 * Reconcile the ledger's running tasks against herdr's live pane view and push
 * state labels. TypeScript port of hydra/scripts/herdr-push.sh.
 *
 * @param runId   The run identifier.
 * @param options Optional overrides for cwd, state root, repo root, exec injection.
 * @returns The derived pane state array (also printed to stdout as compact JSON).
 */
export function herdrPush(
  runId: string,
  options: HerdrPushOptions = {},
): PaneState[] {
  if (!runId) {
    throw new Error('usage: herdrPush <run_id> [--notify]');
  }

  const exec = options.exec ?? defaultExec;
  const cwd = options.cwd;
  const resolvedRunDir = options.stateRoot
    ? join(options.stateRoot, 'runs', `run-${runId}`)
    : runDir(runId);

  const ledgerPath = options.stateRoot
    ? join(resolvedRunDir, 'authoritative', 'ledger', 'events.jsonl')
    : ledger(runId);
  if (!existsSync(ledgerPath)) {
    throw new Error(`hydra: error: no ledger for run ${runId}`);
  }

  const events: LedgerEntry[] = readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEntry);

  const panes = derivePanes(events);

  const nPromoted = panes.filter((p) => p.promoted).length;
  const nRunning = panes.filter((p) => p.running).length;
  const summary = `hydra ${runId} · ${nPromoted} promoted · ${nRunning} running`;

  // --- 1. Determine whether herdr is available. ---------------------------
  let herdrAvailable = false;
  try {
    exec('herdr', ['status'], { cwd, stdio: 'ignore' });
    herdrAvailable = true;
  } catch {
    herdrAvailable = false;
  }

  if (!herdrAvailable) {
    const fallback = join(resolvedRunDir, 'authoritative', 'herdr-panes.json');
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, `${JSON.stringify(panes)}\n`, 'utf8');
    warn(
      `herdr not running — pane state written to ${fallback} (advisory only)`,
    );
    process.stdout.write(`${JSON.stringify(panes)}\n`);
    return panes;
  }

  // --- 2. Push ledger-derived state into the live view. -------------------
  let repoRoot = options.repoRoot ?? '';
  if (!repoRoot) {
    try {
      repoRoot = exec('git', ['rev-parse', '--show-toplevel'], {
        cwd,
      }).trim();
    } catch {
      throw new Error('hydra: error: not inside a git repository');
    }
  }

  let leadPane = '';
  try {
    const paneListOutput = exec('herdr', ['pane', 'list'], { cwd });
    const paneList = JSON.parse(paneListOutput) as {
      result?: {
        panes?: Array<{
          agent?: unknown;
          cwd?: string;
          pane_id?: string;
        }>;
      };
    };
    leadPane =
      paneList.result?.panes?.find(
        (p) => p.agent != null && p.cwd === repoRoot,
      )?.pane_id ?? '';
  } catch {
    leadPane = '';
  }

  if (!leadPane) {
    leadPane = process.env.HYDRA_HERDR_PANE ?? '';
  }

  if (leadPane) {
    try {
      exec('herdr', ['pane', 'rename', leadPane, summary], { cwd });
      log(`pushed pane label -> ${leadPane}: ${summary}`);
    } catch {
      // Best-effort pane rename; ignore failures.
    }
  } else {
    warn(
      'no lead pane identified; skipping pane label (notification still sent)',
    );
  }

  if (options.notify) {
    const lastEntry = events.at(-1);
    const last = `${lastEntry?.event ?? null} ${lastEntry?.task_id ?? ''}`;
    let sound = 'done';
    if (
      lastEntry?.event === 'result_rejected' ||
      lastEntry?.status === 'failed'
    ) {
      sound = 'request';
    }
    try {
      exec(
        'herdr',
        [
          'notification',
          'show',
          `Hydra run ${runId}`,
          '--body',
          `${last} · ${summary}`,
          '--sound',
          sound,
        ],
        { cwd },
      );
      log(`pushed notification: ${last}`);
    } catch {
      // Best-effort notification; ignore failures.
    }
  }

  // --- 3. Reconcile live view vs ledger. ----------------------------------
  let live: Array<{ cwd: string; status: string }> = [];
  try {
    const agentListOutput = exec('herdr', ['agent', 'list'], { cwd });
    const agentList = JSON.parse(agentListOutput) as {
      result?: {
        agents?: Array<{ cwd?: string; agent_status?: string }>;
      };
    };
    live = (agentList.result?.agents ?? []).map((a) => ({
      cwd: a.cwd ?? '',
      status: a.agent_status ?? '',
    }));
  } catch {
    live = [];
  }

  let anomalies = 0;
  for (const t of panes) {
    const task = t.task;
    const ledgerRunning = t.running;
    const spec = join(resolvedRunDir, 'tasks', `${task}.yaml`);
    const wt = existsSync(spec) ? yamlScalar(spec, 'worktree') : '';
    if (!wt) continue;

    const liveWorking = live.some(
      (a) => a.cwd === wt && a.status === 'working',
    );
    if (ledgerRunning !== liveWorking) {
      appendAnomaly(runId, ledgerPath, task, ledgerRunning, liveWorking);
      warn(
        `ANOMALY [${task}]: ledger running=${ledgerRunning} but herdr working=${liveWorking} (ledger wins)`,
      );
      anomalies += 1;
    }
  }

  log(`herdr push complete (${summary}; ${anomalies} anomalies)`);
  process.stdout.write(`${JSON.stringify(panes)}\n`);
  return panes;
}

export default {
  herdrPush,
};

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const runId = process.argv[2] ?? '';
  const notify = process.argv[3] === '--notify';
  try {
    herdrPush(runId, { notify });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
