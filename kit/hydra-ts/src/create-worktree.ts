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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function defaultWavePath(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return join(selfDir, '..', '..', 'hydra', 'WAVE');
}

function resolvedRunDir(runId: string, roots: ResolvedRoots): string {
  // runDir() uses the process-wide state root; this local equivalent preserves
  // the explicit options.stateRoot override used by callers and tests.
  return join(roots.stateRoot, 'runs', `run-${runId}`);
}

function runBootstrapSteps(
  worktree: string,
  runId: string,
  taskId: string,
  key: string,
  bootstrapPolicy: string,
  exec: typeof execFileSync,
  env: Record<string, string> | undefined,
): boolean {
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
    } catch {
      return false;
    }
  }
  return true;
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
  const bootstrapPolicy = join(roots.repoRoot, 'hydra', 'policies', 'bootstrap.yaml');
  const waveFile = options.wavePath ?? defaultWavePath();
  const waveLevel = readWaveLevel(waveFile, options.env);

  if (existsSync(bootstrapPolicy)) {
    if (!runBootstrapSteps(worktree, runId, taskId, 'common', bootstrapPolicy, exec, options.env)) {
      bootstrapStatus = 'failed';
    }
    if (bootstrapStatus === 'ok' && waveLevel >= 1) {
      if (!runBootstrapSteps(
        worktree,
        runId,
        taskId,
        'wave_1',
        bootstrapPolicy,
        exec,
        options.env,
      )) {
        bootstrapStatus = 'failed';
      }
      log(`wave_1 bootstrap steps executed (wave level ${waveLevel})`);
    }
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
  );

  if (bootstrapStatus !== 'ok') {
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

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    createWorktree(process.argv[2], process.argv[3], process.argv[4]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
