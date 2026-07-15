import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { die, ledgerAppend, log, now, repoId, stateRoot, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Harness-generated, post-freeze GitNexus index (TypeScript port of
// hydra/scripts/index-candidate.sh).
//
// The index is built AFTER the candidate is frozen:
//   1. confirm clean worktree + expected HEAD
//   2. delete any worker-created graph artifacts
//   3. build a fresh index (--skip-agents-md --skip-skills, registered by name)
//   4. copy to external custody keyed by commit + write the manifest
//   5. mark the in-worktree index read-only for the review phase
// ---------------------------------------------------------------------------

/** Function shape used to inject external command execution in tests. */
export type ExecFn = (command: string, args: string[], options?: { cwd?: string }) => string;

/** Optional dependencies/overrides for testability. */
export interface IndexCandidateOptions {
  /** Override for the external state root (HYDRA_STATE_ROOT equivalent). */
  stateRoot?: string;
  /** Optional working directory passed through to injected exec calls. */
  cwd?: string;
  /** Optional command executor; defaults to real child_process execFileSync. */
  exec?: ExecFn;
}

function defaultExec(command: string, args: string[], options?: { cwd?: string }): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    cwd: options?.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function resolveStateRoot(options?: IndexCandidateOptions): string {
  return options?.stateRoot ?? stateRoot();
}

function resolveRunDir(runId: string, options?: IndexCandidateOptions): string {
  return join(resolveStateRoot(options), 'runs', `run-${runId}`);
}

function resolveGitnexusDir(head: string, options?: IndexCandidateOptions): string {
  return join(resolveStateRoot(options), 'indexes', 'gitnexus', repoId(), head);
}

function git(worktree: string, args: string[], exec?: ExecFn): string {
  const runner = exec ?? defaultExec;
  return runner('git', ['-C', worktree, ...args]);
}

function gitnexus(args: string[], exec?: ExecFn, cwd?: string): string {
  const runner = exec ?? defaultExec;
  return runner('gitnexus', args, { cwd });
}

function checkGitnexus(exec?: ExecFn): void {
  // When an executor is injected (tests), trust the injection.
  if (exec) return;
  try {
    execFileSync('bash', ['-c', 'command -v -- "$1"', 'bash', 'gitnexus'], {
      stdio: 'ignore',
    });
  } catch {
    die('gitnexus CLI not found (Wave 1 dependency)');
  }
}

function copyDirContents(src: string, dest: string): void {
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    cpSync(srcPath, destPath, { recursive: true, force: true });
  }
}

function removeWritePermissions(root: string): void {
  if (!existsSync(root)) return;
  const st = statSync(root);
  chmodSync(root, st.mode & ~0o222);
  if (st.isDirectory()) {
    for (const entry of readdirSync(root)) {
      removeWritePermissions(join(root, entry));
    }
  }
}

function ensureGitExclude(worktree: string, pattern: string, exec?: ExecFn): void {
  const excludePathRelative = git(worktree, ['rev-parse', '--git-path', 'info/exclude'], exec);
  const excludePath = excludePathRelative.startsWith('/')
    ? excludePathRelative
    : join(worktree, excludePathRelative);

  mkdirSync(dirname(excludePath), { recursive: true });
  const alreadyExcluded = existsSync(excludePath)
    && readFileSync(excludePath, 'utf8').split('\n').some((line) => line === pattern);
  if (!alreadyExcluded) {
    writeFileSync(excludePath, `${pattern}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
  }
}

function runWithStateRoot<T>(root: string | undefined, fn: () => T): T {
  if (!root) return fn();
  const previous = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = previous;
    }
  }
}

/**
 * Build the harness-custody GitNexus index of a frozen candidate.
 *
 * @param runId - The run identifier (e.g. "0018").
 * @param taskId - The task identifier (e.g. "index-candidate").
 * @param logicalLabel - Optional logical index label; defaults to
 *   `candidate/<taskId>/<head-sha>`.
 * @param options - Optional overrides for state root, cwd, and command execution.
 * @returns The registered index name.
 */
export function indexCandidate(
  runId: string,
  taskId: string,
  logicalLabel?: string,
  options: IndexCandidateOptions = {},
): string {
  if (!runId || !taskId) {
    die('usage: index-candidate.ts <run_id> <task_id> [logical_label]');
  }

  return runWithStateRoot(options.stateRoot, () => {
    checkGitnexus(options.exec);

    const rDir = resolveRunDir(runId, options);
    const taskSpec = join(rDir, 'tasks', `${taskId}.yaml`);
    if (!existsSync(taskSpec)) {
      die(`task spec not found: ${taskSpec}`);
    }

    const worktree = yamlScalar(taskSpec, 'worktree');
    if (!worktree || !statSync(worktree, { throwIfNoEntry: false })?.isDirectory()) {
      die(`worktree not found: ${worktree}`);
    }

    const headSha = git(worktree, ['rev-parse', 'HEAD'], options.exec);
    const logical = logicalLabel ?? `candidate/${taskId}/${headSha}`;

    // --- Freeze verification: clean tracked tree ---------------------------
    const dirty = git(worktree, ['status', '--porcelain', '--untracked-files=no'], options.exec);
    if (dirty.length > 0) {
      die(`worktree has uncommitted tracked changes; not frozen: ${worktree}`);
    }

    // --- Delete any worker-created graph artifacts -------------------------
    rmSync(join(worktree, '.gitnexus'), { recursive: true, force: true });

    // Ensure the index can never dirty the worktree.
    ensureGitExclude(worktree, '.gitnexus/', options.exec);

    // --- Build a fresh index -----------------------------------------------
    const indexName = `hydra-${runId}-${taskId}`;
    log(`indexing ${taskId} @ ${headSha} as '${indexName}'`);
    try {
      gitnexus(
        ['analyze', '--skip-agents-md', '--skip-skills', '--name', indexName, '--allow-duplicate-name', worktree],
        options.exec,
        options.cwd,
      );
    } catch {
      die(`gitnexus analyze failed for ${taskId}`);
    }

    let indexerVersion: string;
    try {
      indexerVersion = gitnexus(['--version'], options.exec, options.cwd).split('\n')[0];
    } catch {
      indexerVersion = 'unknown';
    }

    // --- External custody keyed by commit + manifest -----------------------
    const custody = resolveGitnexusDir(headSha, options);
    mkdirSync(custody, { recursive: true });

    const worktreeGitnexus = join(worktree, '.gitnexus');
    if (existsSync(worktreeGitnexus) && statSync(worktreeGitnexus).isDirectory()) {
      copyDirContents(worktreeGitnexus, custody);
    }

    const manifest = join(custody, 'manifest.yaml');
    const manifestBody = [
      `worktree: ${basename(worktree)}`,
      `logical_index: ${logical}`,
      `index_name: ${indexName}`,
      `indexed_commit: ${headSha}`,
      'working_tree_dirty_at_index: false',
      `indexer_version: ${indexerVersion || 'unknown'}`,
      `created_at: ${now()}`,
      '',
    ].join('\n');
    writeFileSync(manifest, manifestBody, 'utf8');

    // Also record the manifest under the run's authoritative tree.
    const authGraphDir = join(rDir, 'authoritative', 'graph');
    mkdirSync(authGraphDir, { recursive: true });
    cpSync(manifest, join(authGraphDir, `${taskId}.manifest.yaml`), { force: true });

    // --- Read-only for the review phase ------------------------------------
    if (existsSync(worktreeGitnexus)) {
      removeWritePermissions(worktreeGitnexus);
    }

    ledgerAppend(
      runId,
      'index_built',
      'task_id', taskId,
      'index_name', indexName,
      'indexed_commit', headSha,
      'logical', logical,
    );

    log(`index custody: ${custody}`);
    return indexName;
  });
}

// CLI entrypoint for parity with hydra/scripts/index-candidate.sh.
export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, taskId, logicalLabel] = args;
    const indexName = indexCandidate(runId, taskId, logicalLabel);
    process.stdout.write(`${indexName}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = main();
}

// Backwards-compatible default export for consumers that import the module.
export default { indexCandidate };
