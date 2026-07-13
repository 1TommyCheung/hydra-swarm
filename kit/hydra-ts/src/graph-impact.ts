import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, ledgerAppend, log, runDir, warn, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Graph impact (RISK INPUT — advisory, never blocking).
// Ported from hydra/scripts/graph-impact.sh.
// ---------------------------------------------------------------------------

export interface GraphImpactDeps {
  /** Path to the freshness-gate.sh script. Defaults to the bash script in hydra/scripts. */
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

function defaultFreshnessGatePath(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return join(selfDir, '..', '..', 'hydra', 'scripts', 'freshness-gate.sh');
}

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
  const freshnessGatePath = deps.freshnessGatePath ?? defaultFreshnessGatePath();
  const freshResult = spawnSync('bash', [freshnessGatePath, runId, taskId], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (freshResult.status !== 0) {
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
