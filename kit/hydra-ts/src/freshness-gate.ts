import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { die, log, runDir, warn, yamlScalar } from './lib.ts';

/**
 * Result of a freshness gate check.
 */
export interface FreshnessGateResult {
  /** True when the index is fresh (HEAD == indexed_commit and tree clean). */
  fresh: boolean;
  /** The current HEAD commit at the time of the check. */
  head: string;
  /** The commit recorded in the index manifest. */
  indexedCommit: string;
  /** Human-readable reason when the index is stale. */
  reason?: string;
}

/**
 * Gate a graph index as usable only if indexed_commit == HEAD and the working
 * tree is clean. This is a TypeScript port of hydra/scripts/freshness-gate.sh.
 *
 * @param runId - The run identifier (e.g. "0017").
 * @param taskId - The task identifier (e.g. "freshness-gate").
 * @returns FreshnessGateResult with fresh=true when the gate passes.
 * @throws When required inputs are missing or git cannot be queried.
 */
export function freshnessGate(runId: string, taskId: string): FreshnessGateResult {
  const run_dir = runDir(runId);
  const taskSpec = join(run_dir, 'tasks', `${taskId}.yaml`);
  const manifest = join(run_dir, 'authoritative', 'graph', `${taskId}.manifest.yaml`);

  if (!existsSync(taskSpec)) {
    die(`task spec not found: ${taskSpec}`);
  }
  if (!existsSync(manifest)) {
    warn(`no index manifest for ${taskId} — stale`);
    return { fresh: false, head: '', indexedCommit: '', reason: 'no index manifest' };
  }

  const worktree = yamlScalar(taskSpec, 'worktree');
  if (!worktree || !statSync(worktree, { throwIfNoEntry: false })?.isDirectory()) {
    die(`worktree not found: ${worktree}`);
  }

  const indexedCommit = yamlScalar(manifest, 'indexed_commit');
  const currentHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  const dirty = execFileSync(
    'git',
    ['-C', worktree, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' },
  ).trim();

  if (indexedCommit !== currentHead) {
    warn(`STALE: indexed ${indexedCommit} != HEAD ${currentHead}`);
    return {
      fresh: false,
      head: currentHead,
      indexedCommit,
      reason: 'indexed_commit != HEAD',
    };
  }

  if (dirty.length > 0) {
    warn('STALE: working tree dirty since index');
    return {
      fresh: false,
      head: currentHead,
      indexedCommit,
      reason: 'working tree dirty',
    };
  }

  log(`fresh: index == HEAD (${currentHead}), tree clean`);
  return { fresh: true, head: currentHead, indexedCommit };
}

export default { freshnessGate };
