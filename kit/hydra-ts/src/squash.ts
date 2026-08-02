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
  warn,
  yamlScalar,
} from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';

export interface SquashRecord {
  candidate_head: string;
  integration_commit: string;
  source_commits: string[];
}

export interface SquashResult {
  integrationCommit: string;
  recordPath: string;
}

export interface SquashOptions {
  /**
   * Opt-in override for the "task branch advanced past the promoted head"
   * refusal (issue #39). It does NOT squash the newer commits — those were
   * never promoted, so squashing them would push unreviewed, unverified work
   * straight through the trust boundary. It squashes the PROMOTED head
   * exactly as before and merely acknowledges, in writing, that the newer
   * commits are being excluded on purpose.
   *
   * The one legitimate use: the worker (or an operator) landed commits on the
   * candidate branch AFTER promotion that must not ship — scratch debugging
   * commits, an experiment, a revert-me spike — and the lead deliberately
   * wants the promoted prefix only. In every other case the correct remedy is
   * to re-run promote.sh and then re-run squash.sh.
   */
  acceptNewCommits?: boolean;
}

function git(worktree: string, args: string[]): string {
  return execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Run a git command purely for its exit status. */
function gitSucceeds(worktree: string, args: string[]): boolean {
  try {
    git(worktree, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the commit the task branch actually points at right now.
 *
 * create-worktree.ts creates the task worktree with
 * `git worktree add -b <branch> <worktree> <base>`, so the worktree has the
 * task branch checked out and its HEAD *is* the branch tip. Prefer the
 * spec-declared branch ref (that is the ref promote.ts validates against, so
 * the two gates agree on what "the branch" means) and fall back to the
 * worktree's own HEAD when the spec declares no branch or the ref no longer
 * resolves — the worktree HEAD is where a re-dispatched worker's amendment
 * commits land either way.
 */
function resolveBranchHead(worktree: string, branch: string): string {
  if (branch) {
    try {
      return git(worktree, ['rev-parse', '--verify', `${branch}^{commit}`]);
    } catch {
      // Fall through to the worktree HEAD below.
    }
  }
  try {
    return git(worktree, ['rev-parse', 'HEAD']);
  } catch {
    return die(
      `cannot resolve the task branch HEAD in ${worktree}`
      + ' (needed to detect commits landed after promotion)',
    );
  }
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
 * Refuses when the task branch has moved past the promoted head — the
 * post-amendment case from issue #39, where squashing the promoted snapshot
 * silently discards the reviewed fix that was committed after promotion.
 *
 * @param runId  Run identifier.
 * @param taskId Task identifier.
 * @param options Optional overrides (see SquashOptions).
 * @returns Object containing the integration commit SHA and the record path.
 */
export function squash(
  runId: string,
  taskId: string,
  options: SquashOptions = {},
): SquashResult {
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

  const candidateHeadFull = git(worktree, ['rev-parse', candidateHead]);

  // --- Staleness gate (issue #39) -------------------------------------------
  // The promoted result is a SNAPSHOT taken at promotion time. It survives an
  // amendment untouched, so after `amend-task` + re-dispatch the task branch
  // can carry reviewed, committed fixes that the promoted head knows nothing
  // about. Squashing the promoted head then ships exactly the code the review
  // rejected, with nothing in the output hinting that anything was dropped.
  // Compare the promoted head against the branch's real current tip and
  // refuse unless they agree.
  const branch = yamlScalar(taskSpec, 'branch');
  const branchHead = resolveBranchHead(worktree, branch);
  const branchLabel = branch || 'HEAD';

  if (branchHead !== candidateHeadFull) {
    if (!gitSucceeds(worktree, ['merge-base', '--is-ancestor', candidateHeadFull, branchHead])) {
      // History was rewritten (force-push, rebase, reset): the promoted head
      // is not even reachable from the branch, so there is no "prefix" to
      // squash and no amount of re-promotion makes the two views agree
      // without a human deciding which history is correct.
      die(
        `task branch DIVERGED from the promoted head for ${taskId}: promoted head`
        + ` ${candidateHeadFull} is not an ancestor of branch ${branchLabel} head ${branchHead}`
        + ' — the branch history was rewritten (force-push, rebase, or reset) after promotion.'
        + ' Refusing to squash. Reconcile the branch by hand, re-run promote.sh on the'
        + ' resulting result, then re-run squash.sh (--accept-new-commits does NOT apply'
        + ' to a diverged history).',
      );
    }

    // Strict descendant: the post-amendment case.
    const newCommits = git(worktree, [
      'rev-list',
      '--count',
      `${candidateHeadFull}..${branchHead}`,
    ]);

    if (!options.acceptNewCommits) {
      die(
        `task branch ${branchLabel} has advanced past the promoted head for ${taskId}:`
        + ` promoted head ${candidateHeadFull}, branch head ${branchHead}`
        + ` (${newCommits} commit(s) landed after promotion).`
        + ' Those commits were never promoted, so squashing the promoted head would'
        + ' silently discard them (issue #39). Re-run promote.sh on the current result,'
        + ' then re-run squash.sh. If you really do want the promoted prefix only and'
        + ' intend to drop the newer commits, re-run with --accept-new-commits.',
      );
    }

    warn(
      `--accept-new-commits: squashing the promoted head ${candidateHeadFull} for ${taskId}`
      + ` and EXCLUDING ${newCommits} commit(s) up to branch ${branchLabel} head ${branchHead}`,
    );
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

  // Name the promoted head the squash was taken from: the artifact is then
  // self-describing, and an operator reading the log can tell at a glance
  // which snapshot shipped without re-deriving it from the state tree.
  log(
    `squash for ${taskId} -> ${integrationCommit}`
    + ` (from promoted head ${candidateHeadFull}, ${sourceCommits.length} source commits)`,
  );

  return { integrationCommit, recordPath };
}

export default {
  squash,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const acceptNewCommits = args.includes('--accept-new-commits');
    const [runId, taskId] = args.filter((arg) => arg !== '--accept-new-commits');
    if (!runId || !taskId) {
      die('usage: squash.sh <run_id> <task_id> [--accept-new-commits]');
    }
    process.stdout.write(
      `${squash(runId, taskId, { acceptNewCommits }).integrationCommit}\n`,
    );
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
