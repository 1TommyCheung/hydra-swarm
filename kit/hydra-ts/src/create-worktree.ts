import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  die,
  ledgerAppend,
  log,
  repoRoot,
  stateRoot,
  worktreeRoot,
  yamlList,
  yamlScalar,
} from './lib.ts';
import { isCompiledBinary, kitAssetPath } from './kit-assets.ts';

// ---------------------------------------------------------------------------
// Worktree bootstrap (TypeScript port of hydra/scripts/create-worktree.sh).
//
// Creates the task worktree + branch from base_commit, bootstraps it under the
// bootstrap network policy, allocates a deterministic PORT, and stamps
// worktree/branch/base_commit back into the instantiated task spec.
// ---------------------------------------------------------------------------

export interface CreateWorktreeOptions {
  /** Override for the repository root (used by tests). */
  repoRoot?: string;
  /** Override for the external state root (used by tests). */
  stateRoot?: string;
  /** Override for the worktree parent directory (used by tests). */
  worktreeRoot?: string;
  /** Override for the path to the hydra/WAVE file (used by tests). */
  wavePath?: string;
  /** Optional exec injection for tests. Defaults to child_process.execFileSync. */
  exec?: typeof execFileSync;
  /** Additional environment variables for bootstrap steps. */
  env?: Record<string, string>;
}

interface ResolvedRoots {
  repoRoot: string;
  stateRoot: string;
  worktreeRoot: string;
}

/** POSIX cksum(1) used by the bash harness for deterministic port allocation. */
function posixCksum(input: string): number {
  // Bash pipes the bytes emitted by `printf '%s'` into cksum. Use the UTF-8
  // bytes here as well, rather than iterating JavaScript's UTF-16 code units.
  const bytes = Buffer.from(input, 'utf8');
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04c11db7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
  }
  // POSIX cksum appends the input length as little-endian bytes before
  // producing the final complemented CRC.
  let length = bytes.length;
  while (true) {
    crc ^= (length & 0xff) << 24;
    for (let j = 0; j < 8; j += 1) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04c11db7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
    length >>>= 8;
    if (length === 0) break;
  }
  return ~crc >>> 0;
}

/** Deterministic port derived from run+task (no RNG allowed). */
function allocatePort(runId: string, taskId: string): number {
  const checksum = posixCksum(`${runId}/${taskId}`);
  return 20000 + (checksum % 20000);
}

function resolveRoots(options: CreateWorktreeOptions): ResolvedRoots {
  // Use lib.ts helpers for the defaults so env overrides are honoured, but allow
  // explicit options to take precedence for test injection.
  return {
    repoRoot: options.repoRoot ?? repoRoot(),
    stateRoot: options.stateRoot ?? stateRoot(),
    worktreeRoot: options.worktreeRoot ?? worktreeRoot(),
  };
}

/** Lockfile whose presence makes the bootstrap policy's install step run. */
const PNPM_LOCKFILE = 'pnpm-lock.yaml';

/**
 * Path to the bootstrap policy.
 *
 * Previously hardcoded to `<repoRoot>/kit/hydra/policies/bootstrap.yaml`, which
 * only ever resolves in a dev checkout: in the installed-plugin layout the kit
 * lives at `<repoRoot>/hydra/...` (packaging.md §2), the file was never found,
 * and bootstrap silently became a total no-op — the likely root cause of the
 * two same-run worktrees in issue #38 bootstrapping inconsistently.
 *
 * The candidates and their order are exactly kitAssetPath()'s (installed
 * layout first, then this dev checkout), which is what promote.ts relies on for
 * policies/verification.yaml. They are tried under the repo the worktree is
 * being created FROM — callers (and tests) inject that root via
 * options.repoRoot, whereas kitAssetPath() always anchors on cwd's repo; in
 * production the two are the same repo, so this is kitAssetPath() semantics.
 * kitAssetPath() itself is the fallback, so an installed plugin whose kit sits
 * outside the target repo still finds its policy.
 */
function resolveBootstrapPolicy(repoRootPath: string): string {
  for (const base of ['hydra', 'kit/hydra']) {
    const candidate = join(repoRootPath, base, 'policies', 'bootstrap.yaml');
    if (existsSync(candidate)) return candidate;
  }
  return kitAssetPath('policies/bootstrap.yaml');
}

function defaultWavePath(): string {
  // WAVE is per-install state written by the installer — resolve it
  // checkout-relative (spike §9 verdict #2). HYDRA_WAVE and options.wavePath
  // keep precedence over this default.
  return kitAssetPath('WAVE');
}

function resolvedRunDir(runId: string, roots: ResolvedRoots): string {
  // runDir() uses the process-wide state root; this local equivalent preserves
  // the explicit options.stateRoot override used by callers and tests.
  return join(roots.stateRoot, 'runs', `run-${runId}`);
}

/** Outcome of one bootstrap phase: which step failed, and why. */
type BootstrapStepResult =
  | { ok: true }
  | { ok: false; phase: string; step: string; error: string };

/** Human-readable cause of an execFileSync rejection, for the failure detail. */
function describeExecFailure(error: unknown): string {
  // Steps run with stdio 'inherit' so a long install streams live to the lead's
  // terminal; that means there is no captured stderr on the exception and the
  // message + exit status are the diagnostics we can carry forward. Both are
  // still far more actionable than the boolean this used to collapse to.
  if (error instanceof Error) {
    const status = (error as { status?: number | null }).status;
    const signal = (error as { signal?: string | null }).signal;
    const stderr = (error as { stderr?: Buffer | string | null }).stderr;
    const parts = [error.message.trim() || String(error)];
    if (typeof status === 'number') parts.push(`exit status ${status}`);
    if (signal) parts.push(`signal ${signal}`);
    const stderrText = stderr === null || stderr === undefined ? '' : String(stderr).trim();
    if (stderrText) parts.push(`stderr: ${stderrText}`);
    return parts.join('; ');
  }
  return String(error);
}

function runBootstrapSteps(
  worktree: string,
  runId: string,
  taskId: string,
  key: string,
  bootstrapPolicy: string,
  exec: typeof execFileSync,
  env: Record<string, string> | undefined,
): BootstrapStepResult {
  const steps = yamlList(bootstrapPolicy, `  ${key}`);
  for (const step of steps) {
    if (!step) continue;
    try {
      exec('bash', ['-c', step], {
        cwd: worktree,
        env: {
          ...process.env,
          HYDRA_TASK_ID: taskId,
          HYDRA_RUN_ID: runId,
          ...env,
        },
        timeout: 600_000,
        stdio: 'inherit',
      } as ExecFileSyncOptions);
    } catch (error) {
      // Preserve the diagnostics instead of reducing every failure mode to
      // `false`: the caller threads these into bootstrapDetail, the ledger
      // event and the die() message, so a genuine command failure is as
      // specific as the lockfile-present-but-no-node_modules case.
      return { ok: false, phase: key, step, error: describeExecFailure(error) };
    }
  }
  return { ok: true };
}

function readWaveLevel(waveFile: string, env: Record<string, string> | undefined): number {
  const waveEnv = env?.HYDRA_WAVE ?? process.env.HYDRA_WAVE;
  if (waveEnv !== undefined) {
    const parsed = Number.parseInt(waveEnv, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (existsSync(waveFile)) {
    const parsed = Number.parseInt(readFileSync(waveFile, 'utf8').trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Update the instantiated task spec with operational fields.
 *
 * Mirrors the awk + grep logic in create-worktree.sh: replace existing
 * worktree/branch/base_commit lines if present, ensure worktree and branch are
 * present, and write the result back.
 */
function stampTaskSpec(
  taskSpec: string,
  worktree: string,
  branch: string,
  baseCommit: string,
): void {
  const content = readFileSync(taskSpec, 'utf8');
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const out: string[] = [];
  for (const line of lines) {
    if (/^worktree:\s*/.test(line)) {
      out.push(`worktree: ${worktree}`);
    } else if (/^branch:\s*/.test(line)) {
      out.push(`branch: ${branch}`);
    } else if (/^base_commit:\s*/.test(line)) {
      out.push(`base_commit: ${baseCommit}`);
    } else {
      out.push(line);
    }
  }

  if (!out.some((l) => l.startsWith('worktree:'))) {
    out.push(`worktree: ${worktree}`);
  }
  if (!out.some((l) => l.startsWith('branch:'))) {
    out.push(`branch: ${branch}`);
  }

  writeFileSync(taskSpec, `${out.join('\n')}\n`, 'utf8');
}

/**
 * Create the task worktree + branch from base_commit, bootstrap it, allocate a
 * PORT, and stamp worktree/branch/base_commit into the task spec.
 *
 * @param runId - required run identifier
 * @param taskId - required task identifier
 * @param baseCommit - optional base commit; defaults to task spec base_commit, then HEAD
 * @returns absolute path to the worktree
 */
export function createWorktree(
  runId: string,
  taskId: string,
  baseCommit?: string,
  options: CreateWorktreeOptions = {},
): string {
  if (!runId) {
    die('usage: create-worktree.ts <run_id> <task_id> [base_commit]');
  }
  if (!taskId) {
    die('usage: create-worktree.ts <run_id> <task_id> [base_commit]');
  }

  const exec = options.exec ?? execFileSync;
  const roots = resolveRoots(options);
  const taskSpec = join(resolvedRunDir(runId, roots), 'tasks', `${taskId}.yaml`);

  if (!existsSync(taskSpec)) {
    die(`instantiated task spec not found: ${taskSpec}`);
  }

  let resolvedBase = baseCommit || yamlScalar(taskSpec, 'base_commit');
  if (!resolvedBase) {
    resolvedBase = exec('git', ['-C', roots.repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  }

  const branch = `hydra/${runId}/${taskId}`;
  const worktree = join(roots.worktreeRoot, `run-${runId}-${taskId}`);

  if (existsSync(worktree)) {
    die(`worktree path already exists: ${worktree}`);
  }

  mkdirSync(dirname(worktree), { recursive: true });

  try {
    exec(
      'git',
      ['-C', roots.repoRoot, 'worktree', 'add', '--quiet', '-b', branch, worktree, resolvedBase],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    die('git worktree add failed');
  }

  // Exclude harness-injected files from Git so they never appear as untracked
  // in the ownership audit. Per-worktree exclude file.
  const excludeFile = exec(
    'git',
    ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'],
    { encoding: 'utf8' },
  ).trim();
  mkdirSync(dirname(excludeFile), { recursive: true });
  const excludes = ['.hydra-task.yaml', '.env.worktree', '.hydra-result.json', '.gitnexus/'];
  for (const pattern of excludes) {
    writeFileSync(excludeFile, `${pattern}\n`, { flag: 'a' });
  }

  // Read-only copy of the task spec for the worker.
  copyFileSync(taskSpec, join(worktree, '.hydra-task.yaml'));
  chmodSync(join(worktree, '.hydra-task.yaml'), 0o444);

  // Unique PORT derived deterministically from run+task.
  const port = allocatePort(runId, taskId);
  writeFileSync(join(worktree, '.env.worktree'), `PORT=${port}\n`, 'utf8');

  // Bootstrap phase.
  let bootstrapStatus = 'ok';
  let bootstrapDetail = '';
  const bootstrapPolicy = resolveBootstrapPolicy(roots.repoRoot);
  const waveFile = options.wavePath ?? defaultWavePath();
  const waveLevel = readWaveLevel(waveFile, options.env);

  // Detail for the "a step exited nonzero" failure mode specifically, kept
  // apart from bootstrapDetail so the two failure modes get distinct messages.
  let stepFailureDetail = '';
  const describeStepFailure = (result: BootstrapStepResult): string => (
    result.ok
      ? ''
      : `bootstrap step failed (${result.phase}): \`${result.step}\` — ${result.error}`
  );

  if (existsSync(bootstrapPolicy)) {
    const common = runBootstrapSteps(
      worktree,
      runId,
      taskId,
      'common',
      bootstrapPolicy,
      exec,
      options.env,
    );
    if (!common.ok) {
      bootstrapStatus = 'failed';
      stepFailureDetail = describeStepFailure(common);
      bootstrapDetail = stepFailureDetail;
    }
    if (bootstrapStatus === 'ok' && waveLevel >= 1) {
      const wave1 = runBootstrapSteps(
        worktree,
        runId,
        taskId,
        'wave_1',
        bootstrapPolicy,
        exec,
        options.env,
      );
      if (!wave1.ok) {
        bootstrapStatus = 'failed';
        stepFailureDetail = describeStepFailure(wave1);
        bootstrapDetail = stepFailureDetail;
      }
      log(`wave_1 bootstrap steps executed (wave level ${waveLevel})`);
    }
  }

  // Post-bootstrap determinism check (issue #38). Every bootstrap step can exit
  // 0 and still leave the worktree without its dependencies — that is exactly
  // how two worktrees from the same run ended up bootstrapped differently, one
  // of them silently substituting a weaker check for its mandated verification.
  // A lockfile in the worktree means the policy's install step was supposed to
  // run, so node_modules must exist afterwards. Fail here rather than letting a
  // lead discover it mid-dispatch. No lockfile => nothing was ever going to be
  // installed, so the pre-existing no-op behaviour is unchanged.
  if (
    bootstrapStatus === 'ok'
    && existsSync(join(worktree, PNPM_LOCKFILE))
    && !existsSync(join(worktree, 'node_modules'))
  ) {
    bootstrapStatus = 'failed';
    bootstrapDetail = `${PNPM_LOCKFILE} is present but node_modules is missing after bootstrap`;
  }

  // Persist operational fields back into the instantiated task spec.
  stampTaskSpec(taskSpec, worktree, branch, resolvedBase);

  ledgerAppend(
    runId,
    'worktree_bootstrapped',
    'task_id', taskId,
    'status', bootstrapStatus,
    'worktree', worktree,
    'port', String(port),
    'detail', bootstrapDetail,
  );

  if (bootstrapStatus !== 'ok') {
    // Both failure modes name the worktree, the underlying cause and the policy
    // that produced it. `bootstrap incomplete` is the steps-all-exited-0 case
    // (the install claimed success but left no node_modules); `bootstrap failed`
    // is a step that genuinely exited nonzero. The generic fallback only fires
    // if a failure ever reaches here without a captured detail.
    if (stepFailureDetail) {
      die(
        `bootstrap failed for ${taskId}: worktree ${worktree} — ${stepFailureDetail}`
        + ` (policy ${bootstrapPolicy}). The worktree is NOT usable: a worker`
        + ' dispatched into it cannot run the project\'s real verification'
        + ' commands. Fix the failing step and recreate the worktree.',
      );
    }
    if (bootstrapDetail) {
      die(
        `bootstrap incomplete for ${taskId}: worktree ${worktree} — ${bootstrapDetail}`
        + ` (policy ${bootstrapPolicy}). The worktree is NOT usable: a worker`
        + ' dispatched into it cannot run the project\'s real verification'
        + ' commands. Fix the install and recreate the worktree.',
      );
    }
    die(`bootstrap failed for ${taskId}`);
  }

  log(`worktree ready: ${worktree} (branch ${branch}, PORT ${port})`);
  process.stdout.write(`${worktree}\n`);
  return worktree;
}

// Backwards-compatible default export for consumers that import the module.
export default { createWorktree };

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    createWorktree(args[0], args[1], args[2]);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = main();
}
