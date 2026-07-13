import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ledgerAppend,
  log,
  repoRoot,
  runDir,
  warn,
  worktreeRoot,
  yamlScalar,
} from './lib.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFY_SH = resolve(__dirname, '../../hydra/scripts/verify.sh');

export type ExecFunction = (
  file: string,
  args: string[],
  options?: { encoding?: string; cwd?: string; stdio?: any },
) => string;

export type VerifyFunction = (
  worktree: string,
  policy: string,
  out?: string,
) => boolean;

export interface IntegrateOptions {
  cwd?: string;
  stateRoot?: string;
  worktreeRoot?: string;
  exec?: ExecFunction;
  verify?: VerifyFunction;
}

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
  options?: { encoding?: string; cwd?: string; stdio?: any },
): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  }) as string;
}

function defaultVerify(execFn: ExecFunction): VerifyFunction {
  return (worktree: string, policy: string, out?: string): boolean => {
    const args = [worktree, policy];
    if (out) args.push(out);
    try {
      execFn(VERIFY_SH, args, { encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
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

/**
 * Serialized convergence: cherry-pick accepted squashes onto an integration
 * branch with per-candidate smoke verification and a combined verification gate.
 *
 * Ports hydra/scripts/integrate.sh. Returns the integration branch HEAD on
 * success. Throws IntegrationError with exitCode 6 for textual conflicts and
 * exitCode 7 for verification failures.
 *
 * @param runId   Run identifier.
 * @param taskIds Task identifiers in dependency order.
 * @param options Optional overrides for testability.
 * @returns The final integration branch HEAD SHA.
 */
export function integrate(
  runId: string,
  taskIds: string[],
  options: IntegrateOptions = {},
): string {
  if (!runId) {
    fail('usage: integrate.ts <run_id> <task_id_in_order>...');
  }
  if (!taskIds || taskIds.length === 0) {
    fail('no tasks to integrate');
  }

  const repoRootPath = options.cwd ?? repoRoot();
  const worktreeRootPath = options.worktreeRoot ?? worktreeRoot();
  const execFn: ExecFunction = options.exec ?? defaultExec;
  const verifyFn: VerifyFunction = options.verify ?? defaultVerify(execFn);

  // Foundation state and ledger helpers read HYDRA_STATE_ROOT. Scope the test
  // override to this synchronous operation and restore it in finally below.
  const originalStateRoot = process.env.HYDRA_STATE_ROOT;
  if (options.stateRoot) {
    process.env.HYDRA_STATE_ROOT = options.stateRoot;
  }

  try {
    const rDir = runDir(runId);
    const runYaml = join(rDir, 'run.yaml');
    const baseCommit = yamlScalar(runYaml, 'base_commit');
    if (!baseCommit) {
      fail('run base_commit not recorded in run.yaml');
    }

    const verifyPolicy =
      process.env.HYDRA_VERIFY_POLICY ||
      join(repoRootPath, 'hydra/policies/verification.yaml');
    const smokePolicy = process.env.HYDRA_SMOKE_POLICY || verifyPolicy;

    const intBranch = `hydra-integration/${runId}`;
    const intWorktree = join(worktreeRootPath, `run-${runId}-integration`);

    if (existsSync(intWorktree)) {
      fail(`integration worktree already exists: ${intWorktree}`);
    }

    mkdirSync(dirname(intWorktree), { recursive: true });

    try {
      git(execFn, repoRootPath, [
        'worktree',
        'add',
        '--quiet',
        '-b',
        intBranch,
        intWorktree,
        baseCommit,
      ]);
    } catch {
      fail('failed to create integration worktree');
    }

    ledgerAppend(
      runId,
      'integration_started',
      'base_commit',
      baseCommit,
      'branch',
      intBranch,
    );

    for (const taskId of taskIds) {
      const recordPath = join(
        rDir,
        'authoritative',
        'results',
        `${taskId}.squash.json`,
      );
      if (!existsSync(recordPath)) {
        fail(`no squash record for ${taskId} (run squash.sh first)`);
      }
      let record: { integration_commit?: unknown };
      try {
        record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
          integration_commit?: unknown;
        };
      } catch {
        // jq exits 5 on malformed JSON, which set -e propagates in the Bash
        // implementation. Keep that observable exit while adding context.
        fail(`invalid squash record for ${taskId}: malformed JSON`, 5);
      }
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
        throw new IntegrationError(
          `textual conflict integrating ${taskId}`,
          6,
        );
      }

      if (!verifyFn(intWorktree, smokePolicy)) {
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
    }

    const combinedOut = join(
      rDir,
      'authoritative',
      'verification',
      'combined.json',
    );
    if (!verifyFn(intWorktree, verifyPolicy, combinedOut)) {
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
  } finally {
    if (options.stateRoot) {
      if (originalStateRoot === undefined) {
        delete process.env.HYDRA_STATE_ROOT;
      } else {
        process.env.HYDRA_STATE_ROOT = originalStateRoot;
      }
    }
  }
}

export default {
  integrate,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    integrate(args[0] ?? '', args.slice(1));
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

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
