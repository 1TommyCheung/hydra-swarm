import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freshnessGate } from './freshness-gate.ts';
import { die, ledgerAppend, log, runDir, warn, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Graph impact (RISK INPUT — advisory, never blocking).
// Ported from hydra/scripts/graph-impact.sh.
// ---------------------------------------------------------------------------

export interface GraphImpactDeps {
  /**
   * Optional out-of-process freshness-gate script (test hook; also the shape
   * the frozen HYDRA_HARNESS=bash lane uses). When omitted, the gate runs
   * IN-PROCESS via freshness-gate.ts — the only mode that works inside a
   * compiled binary, where a child `bash` cannot see `/$bunfs/` paths (spike
   * §4 Test B5, exit 127; §9 verdict #3).
   */
  freshnessGatePath?: string;
  /** Path or name of the gitnexus CLI. Defaults to "gitnexus". */
  gitnexusPath?: string;
}

export class GraphImpactError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

const ANSI_RE = /\x1B\[[0-9;]*m/g;

function checkCommand(command: string): void {
  const result = spawnSync(
    'bash',
    ['-c', 'command -v -- "$1" >/dev/null 2>&1', 'bash', command],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  if (result.status !== 0) {
    die('gitnexus CLI not found (Wave 1 dependency)');
  }
}

/** Strip ANSI SGR escape sequences from a string. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

/** Count lines that mention flow-related keywords (case-insensitive). */
export function countFlows(reportContent: string): number {
  return reportContent
    .split('\n')
    .filter((line) => /flow|process|caller|affected/i.test(line)).length;
}

/** Map a flow count to an advisory signal. */
export function computeSignal(flows: number): 'low' | 'medium' | 'high' {
  if (flows >= 15) return 'high';
  if (flows >= 5) return 'medium';
  return 'low';
}

/**
 * Emit an advisory graph_impact risk input for a task.
 *
 * @returns Path to the generated report.
 * @throws {GraphImpactError} with exitCode 8 if the graph index is stale/missing.
 * @throws {Error} for usage errors, missing task specs, or missing gitnexus CLI.
 */
export function graphImpact(
  runId: string,
  taskId: string,
  deps: GraphImpactDeps = {},
): string {
  if (!runId || !taskId) {
    throw new Error('usage: graph-impact <run_id> <task_id>');
  }

  const gitnexusPath = deps.gitnexusPath ?? 'gitnexus';
  checkCommand(gitnexusPath);

  const rDir = runDir(runId);
  const taskSpec = join(rDir, 'tasks', `${taskId}.yaml`);
  if (!existsSync(taskSpec)) {
    die(`task spec not found: ${taskSpec}`);
  }

  // Freshness gate — a stale graph result must not participate in review.
  // Default: in-process call (compiled-binary safe — a spawned bash cannot see
  // `/$bunfs/` embedded paths, spike §4 Test B5). deps.freshnessGatePath keeps
  // the out-of-process script path for tests and the bash lane.
  let gateFresh: boolean;
  if (deps.freshnessGatePath !== undefined) {
    const freshResult = spawnSync('bash', [deps.freshnessGatePath, runId, taskId], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gateFresh = freshResult.status === 0;
  } else {
    try {
      gateFresh = freshnessGate(runId, taskId).fresh;
    } catch {
      // Gate errors (missing spec/worktree, git failures) mean the index is
      // unusable — same stale_omitted outcome as the script's non-zero exit.
      gateFresh = false;
    }
  }
  if (!gateFresh) {
    ledgerAppend(
      runId,
      'graph_impact',
      'task_id',
      taskId,
      'advisory',
      'true',
      'status',
      'stale_omitted',
    );
    warn(
      `graph index stale/missing for ${taskId} — omitting graph evidence (never a blocker)`,
    );
    throw new GraphImpactError('graph index stale/missing', 8);
  }

  const worktree = yamlScalar(taskSpec, 'worktree');
  const baseCommit = yamlScalar(taskSpec, 'base_commit');
  const indexName = `hydra-${runId}-${taskId}`;
  const report = join(rDir, 'authoritative', 'graph', `${taskId}.md`);
  mkdirSync(dirname(report), { recursive: true });

  let detectOutput: string;
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        'exec "$@" 2>&1',
        'bash',
        gitnexusPath,
        'detect-changes',
        '--repo',
        indexName,
        '--scope',
        'compare',
        '--base-ref',
        baseCommit,
      ],
      {
        cwd: worktree,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const mergedOutput = stripAnsi(result.stdout ?? '')
      .split('\n')
      .slice(0, 80)
      .join('\n')
      .replace(/\n$/, '');
    if (result.error || result.status !== 0) {
      detectOutput = mergedOutput
        ? `${mergedOutput}\n(detect-changes produced no output)`
        : '(detect-changes produced no output)';
    } else {
      detectOutput = mergedOutput;
    }
  } catch {
    detectOutput = '(detect-changes produced no output)';
  }

  const reportContent = [
    `# Graph impact (RISK INPUT — advisory, never blocking) — ${taskId}`,
    '',
    '_GitNexus static analysis. Coverage is incomplete for generated code,',
    'reflection, DI, dynamic imports, and external services. Absence of an edge',
    'is not proof of absence of a dependency (code-intelligence.md §2.4)._',
    '',
    `## Changed symbols & affected execution flows (base ${baseCommit} .. HEAD)`,
    '```',
    detectOutput,
    '```',
  ].join('\n');

  writeFileSync(report, `${reportContent}\n`, 'utf8');

  // Coarse advisory signal for the ledger (NOT a gate): count referenced flows.
  const flows = countFlows(reportContent);
  const signal = computeSignal(flows);

  ledgerAppend(
    runId,
    'graph_impact',
    'task_id',
    taskId,
    'advisory',
    'true',
    'status',
    'ok',
    'signal',
    signal,
  );
  log(
    `graph impact for ${taskId} -> advisory signal=${signal} (report: ${report})`,
  );
  return report;
}

// Backwards-compatible default export for consumers that import the module.
export default {
  graphImpact,
  stripAnsi,
  countFlows,
  computeSignal,
  GraphImpactError,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, taskId] = args;
    if (!runId || !taskId) die('usage: graph-impact.sh <run_id> <task_id>');
    process.stdout.write(`${graphImpact(runId, taskId)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof GraphImpactError) return error.exitCode;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
