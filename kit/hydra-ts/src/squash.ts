import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  authDir,
  die,
  ledgerAppend,
  log,
  now,
  runDir,
  yamlScalar,
} from './lib.ts';

export interface SquashRecord {
  candidate_head: string;
  integration_commit: string;
  source_commits: string[];
}

export interface SquashResult {
  integrationCommit: string;
  recordPath: string;
}

function git(worktree: string, args: string[]): string {
  return execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Create a harness-authored squashed commit of an accepted candidate branch.
 *
 * Ports hydra/scripts/squash.sh. The result applies the whole base->head diff
 * as one commit and touches no existing branch or worktree. The original
 * candidate branch is preserved for forensics.
 *
 * @param runId  Run identifier.
 * @param taskId Task identifier.
 * @returns Object containing the integration commit SHA and the record path.
 */
export function squash(runId: string, taskId: string): SquashResult {
  const rDir = runDir(runId);
  const taskSpec = join(rDir, 'tasks', `${taskId}.yaml`);
  const promoted = join(authDir(runId), 'results', `${taskId}.json`);

  if (!existsSync(taskSpec)) {
    die(`task spec not found: ${taskSpec}`);
  }
  if (!existsSync(promoted)) {
    die(`cannot squash a non-promoted candidate: ${promoted}`);
  }

  const worktree = yamlScalar(taskSpec, 'worktree');
  const baseCommit = yamlScalar(taskSpec, 'base_commit');
  const promotedClaims = readJson<{ claims: { head_commit: string } }>(promoted).claims;
  const candidateHead = promotedClaims.head_commit;

  // Verify the candidate head exists as a commit object.
  try {
    git(worktree, ['cat-file', '-e', `${candidateHead}^{commit}`]);
  } catch {
    die(`candidate head missing: ${candidateHead}`);
  }

  const tree = git(worktree, ['rev-parse', `${candidateHead}^{tree}`]);
  const baseFull = git(worktree, ['rev-parse', baseCommit]);
  const msg = `hydra(integration): squash ${taskId} (run ${runId})`;

  const integrationCommit = git(worktree, [
    'commit-tree',
    tree,
    '-p',
    baseFull,
    '-m',
    msg,
  ]);

  const sourceCommits = git(worktree, [
    'rev-list',
    '--reverse',
    `${baseFull}..${candidateHead}`,
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const candidateHeadFull = git(worktree, ['rev-parse', candidateHead]);

  const record: SquashRecord = {
    candidate_head: candidateHeadFull,
    integration_commit: integrationCommit,
    source_commits: sourceCommits,
  };

  const recordPath = join(authDir(runId), 'results', `${taskId}.squash.json`);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`);

  ledgerAppend(
    runId,
    'squash_created',
    'task_id',
    taskId,
    'integration_commit',
    integrationCommit,
  );

  log(`squash for ${taskId} -> ${integrationCommit} (${sourceCommits.length} source commits)`);

  return { integrationCommit, recordPath };
}

export default {
  squash,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, taskId] = args;
    if (!runId || !taskId) die('usage: squash.sh <run_id> <task_id>');
    process.stdout.write(`${squash(runId, taskId).integrationCommit}\n`);
    return 0;
  } catch (error) {
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
