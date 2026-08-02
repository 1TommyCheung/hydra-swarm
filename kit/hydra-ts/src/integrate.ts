import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCompiledBinary, kitAssetPath } from './kit-assets.ts';
import {
  ledgerAppend,
  log,
  repoRoot,
  runDir,
  warn,
  worktreeRoot,
  yamlScalar,
} from './lib.ts';
import { verify } from './verify.ts';

export type ExecFunction = (
  file: string,
  args: string[],
  options?: { encoding?: BufferEncoding; cwd?: string; stdio?: any },
) => string;

export type VerifyFunction = (
  worktree: string,
  policy: string,
  out?: string,
) => Promise<boolean>;

export interface IntegrateOptions {
  cwd?: string;
  stateRoot?: string;
  worktreeRoot?: string;
  exec?: ExecFunction;
  verify?: VerifyFunction;
  /**
   * Start the integration branch from this commit instead of run.yaml's frozen
   * `base_commit` — and instead of an existing integration branch's tip, which
   * is reset to it (issue #22). The supported form of the operator workaround
   * "cherry-pick straight onto the current target".
   */
  onto?: string;
}

/** How the integration branch's starting point was chosen. */
export type IntegrationBase = 'run-yaml-base' | 'existing-branch' | 'onto';

function defaultVerifyPolicyPath(): string {
  // Per-project active config — resolve checkout-relative (spike §9 verdict
  // #7). HYDRA_VERIFY_POLICY keeps precedence over this default.
  return kitAssetPath('policies/verification.yaml');
}

const USAGE = 'usage: integrate.ts [--onto <commit>] <run_id> <task_id_in_order>...';

export class IntegrationError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'IntegrationError';
    this.exitCode = exitCode;
  }
}

function fail(message: string, exitCode = 1): never {
  throw new IntegrationError(`hydra: error: ${message}`, exitCode);
}

function defaultExec(
  file: string,
  args: string[],
  options?: { encoding?: BufferEncoding; cwd?: string; stdio?: any },
): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  }) as string;
}

function defaultVerify(): VerifyFunction {
  return async (worktree: string, policy: string, out?: string): Promise<boolean> => {
    const originalExitCode = process.exitCode;
    try {
      const results = await verify(worktree, policy, out);
      return results.every((result) => result.status === 'passed');
    } catch {
      return false;
    } finally {
      process.exitCode = originalExitCode;
    }
  };
}

function git(
  execFn: ExecFunction,
  cwd: string,
  args: string[],
): string {
  return execFn('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

/** Resolve a revision to a full commit SHA, or '' when it cannot be resolved. */
function resolveCommit(
  execFn: ExecFunction,
  cwd: string,
  rev: string,
): string {
  try {
    return git(execFn, cwd, ['rev-parse', '--verify', `${rev}^{commit}`]);
  } catch {
    return '';
  }
}

/**
 * Whether a pre-existing integration worktree can be picked up where the last
 * `integrate` call left it.
 *
 * `reason` is operator-facing: it is quoted verbatim in the refusal, so it must
 * say what is wrong, not merely that something is.
 */
interface IntegrationWorktreeState {
  status: 'absent' | 'reusable' | 'unusable';
  /** Current tip of the reusable worktree's branch. */
  head?: string;
  /** Why it is not reusable. */
  reason?: string;
}

/** Pseudo-refs git leaves behind while a sequencer operation is suspended. */
const IN_PROGRESS_REFS: Array<[ref: string, operation: string]> = [
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['MERGE_HEAD', 'merge'],
  ['REVERT_HEAD', 'revert'],
  ['REBASE_HEAD', 'rebase'],
];

/**
 * Classify an existing `hydra-integration/<runId>` worktree (issue #22).
 *
 * Integrating tasks as they individually clear review means calling
 * `integrate.sh` once per task, so the second call finds the worktree and
 * branch the first one created. That is the normal case, not an error — but
 * only when nothing is half-finished inside it. A suspended cherry-pick or an
 * uncommitted edit is somebody's in-flight state; cherry-picking on top of it
 * would either fail confusingly or bury it, so it is refused instead.
 *
 * The checks are deliberately conservative: anything that cannot be positively
 * confirmed as "on the integration branch, no sequencer in flight, tree clean"
 * is `unusable`, never `reusable`.
 */
function inspectIntegrationWorktree(
  execFn: ExecFunction,
  intWorktree: string,
  intBranch: string,
): IntegrationWorktreeState {
  if (!existsSync(intWorktree)) return { status: 'absent' };

  let checkedOut: string;
  try {
    checkedOut = git(execFn, intWorktree, ['symbolic-ref', '--quiet', 'HEAD']);
  } catch {
    return {
      status: 'unusable',
      reason: 'it is not a git worktree with a branch checked out'
        + ' (detached HEAD, or not a checkout at all)',
    };
  }
  if (checkedOut !== `refs/heads/${intBranch}`) {
    return {
      status: 'unusable',
      reason: `it has ${checkedOut || 'an unreadable ref'} checked out, not ${intBranch}`,
    };
  }

  for (const [ref, operation] of IN_PROGRESS_REFS) {
    if (resolveCommit(execFn, intWorktree, ref)) {
      return {
        status: 'unusable',
        reason: `a ${operation} is still in progress there (${ref} is set)`,
      };
    }
  }

  let dirty: string;
  try {
    dirty = git(execFn, intWorktree, [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
  } catch {
    return { status: 'unusable', reason: 'its git status could not be read' };
  }
  if (dirty) {
    return {
      status: 'unusable',
      reason: 'it has uncommitted changes to tracked files',
    };
  }

  const head = resolveCommit(execFn, intWorktree, 'HEAD');
  if (!head) {
    return { status: 'unusable', reason: 'its HEAD could not be resolved' };
  }
  return { status: 'reusable', head };
}

/**
 * Refuse to integrate a squash record that was produced from a promoted head
 * the authoritative result no longer names (issue #39, second half).
 *
 * A `<task>.squash.json` outlives an amendment just as the promoted result
 * does. If the lead amends, re-dispatches, and re-promotes but forgets to
 * re-squash, the stale record still cherry-picks cleanly and verifies green —
 * shipping the pre-amendment tree while every artifact says the amendment was
 * accepted. Comparing the record's `candidate_head` against the CURRENT
 * promoted `claims.head_commit` closes that window.
 *
 * Deliberately non-fatal when the comparison cannot be made (legacy record
 * without `candidate_head`, or no promoted result on disk): those are the
 * inputs of hand-assembled and historical runs, and turning them into a hard
 * failure would break integration paths that never had the field. They warn
 * instead, so the skipped check is visible.
 *
 * @param cwd Any checkout of the repository — used only to resolve revisions,
 *            which every worktree can do against the shared object store.
 */
function assertSquashRecordIsFresh(
  execFn: ExecFunction,
  cwd: string,
  rDir: string,
  taskId: string,
  recordedHead: unknown,
): void {
  if (typeof recordedHead !== 'string' || recordedHead.trim() === '') {
    warn(
      `squash record for ${taskId} has no candidate_head — cannot confirm it was`
      + ' produced from the current promoted head; integrating unchecked',
    );
    return;
  }

  const promotedPath = join(rDir, 'authoritative', 'results', `${taskId}.json`);
  if (!existsSync(promotedPath)) {
    warn(
      `no promoted result at ${promotedPath} — cannot confirm the squash record for`
      + ` ${taskId} is current; integrating unchecked`,
    );
    return;
  }

  let promotedHead: unknown;
  try {
    const promoted = JSON.parse(readFileSync(promotedPath, 'utf8')) as {
      claims?: { head_commit?: unknown };
    };
    promotedHead = promoted?.claims?.head_commit;
  } catch {
    fail(`invalid promoted result for ${taskId}: malformed JSON (${promotedPath})`, 5);
  }

  if (typeof promotedHead !== 'string' || promotedHead.trim() === '') {
    warn(
      `promoted result for ${taskId} records no claims.head_commit — cannot confirm`
      + ' the squash record is current; integrating unchecked',
    );
    return;
  }

  if (promotedHead === recordedHead) return;

  // The promoted result may carry an abbreviated SHA while squash.ts always
  // records the full one; resolve both through git before calling it a
  // mismatch. Every worktree of the repository shares one object store, so
  // the candidate commits are reachable from any of them.
  const resolvedPromoted = resolveCommit(execFn, cwd, promotedHead);
  const resolvedRecorded = resolveCommit(execFn, cwd, recordedHead);
  if (resolvedPromoted && resolvedPromoted === resolvedRecorded) return;

  fail(
    `stale squash record for ${taskId}: it was produced from candidate head`
    + ` ${recordedHead}, but the current promoted result names head`
    + ` ${promotedHead}. The candidate was re-promoted (typically after an`
    + ' amendment) without being re-squashed, so integrating this record would'
    + ' ship the pre-amendment tree. Re-run squash.sh for this task, then re-run'
    + ' integrate.',
  );
}

/**
 * Freshness precondition for the whole run, checked BEFORE the integration
 * worktree and branch exist.
 *
 * Running it up front is what makes the refusal message actionable: the
 * documented remedy is "re-run squash.sh, then re-run integrate", and a
 * refusal that had already created `hydra-integration/<runId>` would leave the
 * retry to start from that debris rather than from the intended base. Issue #22
 * since made a clean pre-existing integration branch reusable, which raises the
 * stakes of ordering rather than lowering them: a worktree created before the
 * refusal would silently become the next call's starting point. Refusing before
 * anything is created keeps that from happening.
 *
 * Records that are missing or unparseable are left alone here — integrateTask
 * owns those failures and their exit codes, and duplicating them would only
 * change which message an operator sees first.
 */
function assertSquashRecordsAreFresh(
  execFn: ExecFunction,
  cwd: string,
  rDir: string,
  taskIds: string[],
): void {
  for (const taskId of taskIds) {
    const recordPath = join(rDir, 'authoritative', 'results', `${taskId}.squash.json`);
    if (!existsSync(recordPath)) continue;
    let record: { candidate_head?: unknown };
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8')) as { candidate_head?: unknown };
    } catch {
      continue;
    }
    assertSquashRecordIsFresh(execFn, cwd, rDir, taskId, record.candidate_head);
  }
}

/**
 * Serialized convergence: cherry-pick accepted squashes onto an integration
 * branch with per-candidate smoke verification and a combined verification gate.
 *
 * Ports the historical integration harness. Returns the integration branch HEAD on
 * success. Throws IntegrationError with exitCode 6 for textual conflicts and
 * exitCode 7 for verification failures.
 *
 * The branch starts from, in order of precedence (issue #22):
 *   1. `options.onto`, when given — created fresh at that commit, or an
 *      existing integration branch reset onto it;
 *   2. an existing `hydra-integration/<runId>`, when it is clean and idle — so
 *      tasks can be integrated one call at a time as they clear review;
 *   3. run.yaml's `base_commit`, frozen at run-init — the first call's base.
 *
 * @param runId   Run identifier.
 * @param taskIds Task identifiers in dependency order.
 * @param options Optional overrides for testability, plus `onto`.
 * @returns The final integration branch HEAD SHA.
 */
export function integrate(
  runId: string,
  taskIds: string[],
  options: IntegrateOptions = {},
): Promise<string> {
  const originalStateRoot = process.env.HYDRA_STATE_ROOT;
  const restoreStateRoot = (): void => {
    if (!options.stateRoot) return;
    if (originalStateRoot === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = originalStateRoot;
    }
  };

  const isPromiseLike = <T>(value: T | PromiseLike<T>): value is PromiseLike<T> =>
    typeof (value as PromiseLike<T>)?.then === 'function';

  const runIntegration = (): string | Promise<string> => {
    if (!runId) {
      fail(USAGE);
    }
    if (!taskIds || taskIds.length === 0) {
      fail('no tasks to integrate');
    }

    const repoRootPath = options.cwd ?? repoRoot();
    const worktreeRootPath = options.worktreeRoot ?? worktreeRoot();
    const execFn: ExecFunction = options.exec ?? defaultExec;
    const verifyFn: VerifyFunction = options.verify ?? defaultVerify();

    const rDir = runDir(runId);
    const runYaml = join(rDir, 'run.yaml');
    const baseCommit = yamlScalar(runYaml, 'base_commit');
    if (!baseCommit) {
      fail('run base_commit not recorded in run.yaml');
    }

    const verifyPolicy =
      process.env.HYDRA_VERIFY_POLICY ||
      defaultVerifyPolicyPath();
    const smokePolicy = process.env.HYDRA_SMOKE_POLICY || verifyPolicy;

    // Precondition, not a mid-flight discovery: a stale squash record must be
    // rejected while the run has created nothing, so the "re-squash, re-run
    // integrate" remedy works on the next invocation without hand-removing a
    // stranded integration worktree/branch.
    assertSquashRecordsAreFresh(execFn, repoRootPath, rDir, taskIds);

    const intBranch = `hydra-integration/${runId}`;
    const intWorktree = join(worktreeRootPath, `run-${runId}-integration`);

    // An explicit target overrides every other choice of starting point: the
    // frozen run.yaml base AND a reusable branch tip (which is reset to it).
    const ontoRequested = (options.onto ?? '').trim();
    let ontoCommit = '';
    if (ontoRequested) {
      ontoCommit = resolveCommit(execFn, repoRootPath, ontoRequested);
      if (!ontoCommit) {
        fail(`--onto commit cannot be resolved in ${repoRootPath}: ${ontoRequested}`);
      }
    }

    const state = inspectIntegrationWorktree(execFn, intWorktree, intBranch);
    if (state.status === 'unusable') {
      // Distinct from both the plain "already exists" of a first-call collision
      // and from a real conflict: something is half-finished in there, and only
      // a human can say whether it matters.
      fail(
        `integration worktree already exists and is NOT safely reusable:`
        + ` ${intWorktree} — ${state.reason}. Nothing was integrated. Inspect it and`
        + ' finish or abort whatever is in flight (e.g. `git -C'
        + ` ${intWorktree} cherry-pick --abort\`), or remove it by hand (\`git worktree`
        + ` remove ${intWorktree}\`), then re-run integrate. This is NOT a content`
        + ' conflict between candidates.',
      );
    }

    const branchExists = Boolean(
      resolveCommit(execFn, repoRootPath, `refs/heads/${intBranch}`),
    );

    // Which starting point won, for the ledger and for the conflict hint: a
    // conflict against the frozen run.yaml base is very often a base/target
    // mismatch, while one against an explicit target or an already-integrated
    // tip is much more likely to be a genuine content clash.
    const baseMode: IntegrationBase = ontoCommit
      ? 'onto'
      : state.status === 'reusable' || branchExists
        ? 'existing-branch'
        : 'run-yaml-base';

    let startCommit: string;
    if (state.status === 'reusable') {
      if (ontoCommit) {
        try {
          git(execFn, intWorktree, ['reset', '--hard', '--quiet', ontoCommit]);
        } catch {
          fail(`failed to reset ${intBranch} onto ${ontoRequested} in ${intWorktree}`);
        }
        startCommit = ontoCommit;
        log(`reset ${intBranch} onto ${ontoCommit} (--onto ${ontoRequested})`);
      } else {
        startCommit = state.head as string;
        log(
          `reusing integration worktree ${intWorktree} at ${startCommit}`
          + ` (branch ${intBranch})`,
        );
      }
    } else {
      mkdirSync(dirname(intWorktree), { recursive: true });
      startCommit = ontoCommit || (branchExists ? '' : baseCommit);

      // `-B` when a starting commit is given: it creates the branch, or resets
      // an orphaned one from a worktree the operator removed by hand. With no
      // starting commit the existing branch is checked out at its own tip.
      const addArgs = startCommit
        ? ['worktree', 'add', '--quiet', '-B', intBranch, intWorktree, startCommit]
        : ['worktree', 'add', '--quiet', intWorktree, intBranch];
      try {
        git(execFn, repoRootPath, addArgs);
      } catch {
        fail('failed to create integration worktree');
      }
      if (!startCommit) {
        startCommit = git(execFn, intWorktree, ['rev-parse', 'HEAD']);
        log(`reusing existing integration branch ${intBranch} at ${startCommit}`);
      }
    }

    ledgerAppend(
      runId,
      'integration_started',
      'base_commit',
      startCommit,
      'branch',
      intBranch,
      'base_mode',
      baseMode,
    );

    const finishCombinedVerification = (passed: boolean): string => {
      if (!passed) {
        ledgerAppend(runId, 'combined_verification', 'status', 'failed');
        warn(
          'COMBINED VERIFICATION FAILED — candidates individually clean, jointly broken',
        );
        warn(
          'this is the gate catching a semantic conflict; NOT proposing for merge',
        );
        throw new IntegrationError('combined verification failed', 7);
      }

      const head = git(execFn, intWorktree, ['rev-parse', 'HEAD']);
      ledgerAppend(
        runId,
        'combined_verification',
        'status',
        'passed',
        'head',
        head,
      );
      log(`combined verification PASSED at ${head} (branch ${intBranch})`);
      process.stdout.write(`${head}\n`);
      return head;
    };

    const verifyCombined = (): string | Promise<string> => {
      const combinedOut = join(
        rDir,
        'authoritative',
        'verification',
        'combined.json',
      );
      const result = verifyFn(intWorktree, verifyPolicy, combinedOut) as
        | boolean
        | Promise<boolean>;
      return isPromiseLike(result)
        ? Promise.resolve(result).then(finishCombinedVerification)
        : finishCombinedVerification(result);
    };

    const integrateTask = (index: number): string | Promise<string> => {
      if (index >= taskIds.length) return verifyCombined();
      const taskId = taskIds[index];
      const recordPath = join(
        rDir,
        'authoritative',
        'results',
        `${taskId}.squash.json`,
      );
      if (!existsSync(recordPath)) {
        fail(`no squash record for ${taskId} (run squash.sh first)`);
      }
      let record: { integration_commit?: unknown; candidate_head?: unknown };
      try {
        record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
          integration_commit?: unknown;
          candidate_head?: unknown;
        };
      } catch {
        // jq exits 5 on malformed JSON, which set -e propagates in the Bash
        // implementation. Keep that observable exit while adding context.
        fail(`invalid squash record for ${taskId}: malformed JSON`, 5);
      }

      // Freshness was asserted for every task before the worktree existed.

      // `jq -r '.integration_commit'` prints "null" for an absent or null key.
      // Preserve that value so git follows Bash's textual-conflict path.
      const integrationCommit =
        record?.integration_commit == null
          ? 'null'
          : String(record.integration_commit);

      const before = git(execFn, intWorktree, ['rev-parse', 'HEAD']);

      try {
        git(execFn, intWorktree, ['cherry-pick', integrationCommit]);
      } catch (error) {
        try {
          git(execFn, intWorktree, ['cherry-pick', '--abort']);
        } catch {
          // Best-effort abort; the conflict is the real failure.
        }
        ledgerAppend(
          runId,
          'integration_conflict',
          'task_id',
          taskId,
          'conflict',
          'textual',
          'at_head',
          before,
        );
        warn(`TEXTUAL CONFLICT integrating ${taskId} onto ${before} — stopped`);
        if (baseMode === 'run-yaml-base') {
          // The run's base_commit is frozen at run-init and never advances, so
          // it can be many merges behind whatever this work is actually meant
          // to land on. That mis-targeting produces the same message a genuine
          // content clash does — say so, and give the one-line way out.
          warn(
            `this integration started from run.yaml's frozen base_commit ${baseCommit},`
            + ' which may predate work already merged into the current target — the'
            + ' conflict may be a BASE/TARGET MISMATCH rather than a real content'
            + ' conflict. To retry against the current target:'
            + ` integrate.sh ${runId} --onto <current-target> ${taskIds.join(' ')}`,
          );
        }
        throw new IntegrationError(
          `textual conflict integrating ${taskId}`,
          6,
        );
      }

      const finishCandidateVerification = (
        passed: boolean,
      ): string | Promise<string> => {
        if (!passed) {
          const afterFail = git(execFn, intWorktree, ['rev-parse', 'HEAD']);
          ledgerAppend(
            runId,
            'integration_candidate_verify_failed',
            'task_id',
            taskId,
            'head',
            afterFail,
          );
          warn(`per-candidate verification failed for ${taskId}`);
          throw new IntegrationError(
            `per-candidate verification failed for ${taskId}`,
            7,
          );
        }

        const after = git(execFn, intWorktree, ['rev-parse', 'HEAD']);
        ledgerAppend(
          runId,
          'candidate_integrated',
          'task_id',
          taskId,
          'head',
          after,
        );
        log(`integrated ${taskId}: ${before} -> ${after}`);
        return integrateTask(index + 1);
      };

      const result = verifyFn(intWorktree, smokePolicy) as
        | boolean
        | Promise<boolean>;
      return isPromiseLike(result)
        ? Promise.resolve(result).then(finishCandidateVerification)
        : finishCandidateVerification(result);
    };

    return integrateTask(0);
  };

  if (options.stateRoot) {
    process.env.HYDRA_STATE_ROOT = options.stateRoot;
  }

  try {
    const result = runIntegration();
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(restoreStateRoot);
    }
    restoreStateRoot();
    // Runtime compatibility for legacy synchronous test doubles. The typed
    // VerifyFunction and the default native verifier are promise-based.
    return result as unknown as Promise<string>;
  } catch (error) {
    restoreStateRoot();
    return Promise.reject(error);
  }
}

export default {
  integrate,
};

/**
 * Split `--onto <commit>` out of the argument list before anything positional
 * is read, matching the minimal flag handling used by the other harness CLIs
 * (wait-task, run-log, status): a flag consumes its value, an unknown
 * dash-prefixed token is a usage error, everything else stays positional.
 */
export function parseIntegrateArgs(args: string[]): {
  onto?: string;
  positionals: string[];
} {
  const positionals: string[] = [];
  let onto: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--onto') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        fail(`--onto requires a commit argument. ${USAGE}`);
      }
      onto = value;
      index += 1;
    } else if (arg.startsWith('-')) {
      fail(`unknown option ${arg}. ${USAGE}`);
    } else {
      positionals.push(arg);
    }
  }
  return { onto, positionals };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { onto, positionals } = parseIntegrateArgs(args);
    await integrate(positionals[0] ?? '', positionals.slice(1), onto ? { onto } : {});
    return 0;
  } catch (error) {
    const exitCode = error instanceof IntegrationError ? error.exitCode : 1;
    // Exit 6/7 paths already emit the same warnings as integrate.sh. Other
    // failures need their error surfaced by the CLI.
    if (!(error instanceof IntegrationError && (exitCode === 6 || exitCode === 7))) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
    }
    return exitCode;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await main();
}
