import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, pathInGlobs } from './lib.ts';

// ---------------------------------------------------------------------------
// Ownership audit — TypeScript port of hydra/scripts/audit-ownership.sh.
//
// Verifies that every file touched between base..head (tracked, untracked, or
// symlink target) falls inside the supplied writable_paths globs. Returns the
// list of violations so callers can decide how to report them.
// ---------------------------------------------------------------------------

/** Testable exec injection; mirrors the shape of child_process.execFileSync. */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { encoding?: string; stdio?: any },
) => string | Buffer;

export interface AuditOwnershipOptions {
  /** Base directory used to resolve a relative worktree path. */
  cwd?: string;
  /** Unused by this module, kept for compatibility with sibling options bags. */
  stateRoot?: string;
  /** Injected exec implementation for tests. */
  exec?: ExecLike;
}

export interface AuditOwnershipResult {
  /** True when no ownership violations were found. */
  clean: boolean;
  /** Violation reasons (without the "VIOLATION: " prefix). */
  violations: string[];
}

/** Parse NUL-delimited `git diff --name-status -z` output. */
function parseNameStatus(output: string): Array<
  | { status: string; old: string; new: string }
  | { status: string; path: string }
> {
  const parts = output.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  const results: ReturnType<typeof parseNameStatus> = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldp = parts[i++];
      const newp = parts[i++];
      results.push({ status, old: oldp, new: newp });
    } else {
      const p = parts[i++];
      results.push({ status, path: p });
    }
  }
  return results;
}

/** Parse NUL-delimited `git diff --name-only -z` / `git ls-files -z` output. */
function parseNullDelimited(output: string): string[] {
  const parts = output.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.filter((p) => p !== '');
}

/**
 * Audit a candidate worktree for ownership violations.
 *
 * @param worktree - Path to the git worktree to audit.
 * @param base - Base commit / ref.
 * @param head - Head commit / ref.
 * @param writable - Array of repo-relative glob patterns (e.g. ["src/**"]).
 * @param options - Optional overrides for testability.
 * @returns Object describing whether the audit is clean and any violations.
 */
export function auditOwnership(
  worktree: string,
  base: string,
  head: string,
  writable: string[],
  options: AuditOwnershipOptions = {},
): AuditOwnershipResult {
  const violations: string[] = [];
  const flag = (reason: string) => violations.push(reason);

  const run = options.exec ?? execFileSync;
  const cwd = options.cwd ?? process.cwd();
  const worktreeAbs = resolve(cwd, worktree);

  if (!statSync(worktreeAbs, { throwIfNoEntry: false })?.isDirectory()) {
    die(`worktree not found: ${worktree}`);
  }

  try {
    run('git', ['-C', worktreeAbs, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    die(`not a git worktree: ${worktree}`);
  }

  // --- helper: single-path hygiene + glob check --------------------------------
  function checkPath(path: string, origin: string): void {
    if (path.startsWith('/')) {
      flag(`absolute path (${origin}): ${path}`);
      return;
    }
    if (path.includes('/../') || path === '..' || path.startsWith('../') || path.endsWith('/..')) {
      flag(`path traversal (${origin}): ${path}`);
      return;
    }
    if (!pathInGlobs(path, writable)) {
      flag(`${origin} outside writable_paths: ${path}`);
    }
  }

  // --- 1. tracked changes ------------------------------------------------------
  let nameStatusOutput = '';
  try {
    nameStatusOutput = String(
      run('git', ['-C', worktreeAbs, 'diff', '--name-status', '-z', '-M', '-C', `${base}...${head}`], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );
  } catch {
    nameStatusOutput = '';
  }

  const changedPaths: string[] = [];
  for (const entry of parseNameStatus(nameStatusOutput)) {
    if ('old' in entry && 'new' in entry) {
      checkPath(entry.old, 'renamed-from');
      checkPath(entry.new, 'renamed-to');
      changedPaths.push(entry.old, entry.new);
    } else {
      const p = (entry as { path: string }).path;
      checkPath(p, 'changed');
      changedPaths.push(p);

      // Submodule pointer change: gitlink mode 160000 at head.
      try {
        const lsTree = String(
          run('git', ['-C', worktreeAbs, 'ls-tree', head, '--', p], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore'],
          }),
        );
        if (lsTree.split('\n').some((line) => line.startsWith('160000 '))) {
          if (!pathInGlobs(p, writable)) {
            flag(`submodule pointer change outside writable_paths: ${p}`);
          }
        }
      } catch {
        // Ignore ls-tree failures; treat as non-submodule.
      }
    }
  }

  // --- 2. untracked files ------------------------------------------------------
  let untrackedOutput = '';
  try {
    untrackedOutput = String(
      run('git', ['-C', worktreeAbs, 'ls-files', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );
  } catch {
    untrackedOutput = '';
  }

  const untrackedPaths = parseNullDelimited(untrackedOutput);
  for (const u of untrackedPaths) {
    checkPath(u, 'untracked');
  }

  // --- 3. symlink-escape guard -------------------------------------------------
  let diffNameOnlyOutput = '';
  try {
    diffNameOnlyOutput = String(
      run('git', ['-C', worktreeAbs, 'diff', '--name-only', '-z', `${base}...${head}`], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );
  } catch {
    diffNameOnlyOutput = '';
  }

  const candidatePaths = new Set<string>([
    ...parseNullDelimited(diffNameOnlyOutput),
    ...untrackedPaths,
  ]);

  for (const link of candidatePaths) {
    const linkAbs = resolve(worktreeAbs, link);
    let isLink = false;
    try {
      isLink = lstatSync(linkAbs).isSymbolicLink();
    } catch {
      isLink = false;
    }
    if (!isLink) continue;

    let target: string;
    try {
      target = readlinkSync(linkAbs, 'utf8');
    } catch {
      continue;
    }

    const linkdir = dirname(link);
    const resolvedAbs = target.startsWith('/')
      ? target
      : resolve(worktreeAbs, linkdir, target);

    const insideWorktree =
      resolvedAbs === worktreeAbs || resolvedAbs.startsWith(worktreeAbs + sep);
    if (insideWorktree) {
      const rel = relative(worktreeAbs, resolvedAbs).replace(/\\/g, '/');
      if (!pathInGlobs(rel, writable)) {
        flag(`symlink target outside writable_paths: ${link} -> ${target}`);
      }
    } else {
      flag(`symlink escapes worktree: ${link} -> ${target}`);
    }
  }

  return { clean: violations.length === 0, violations };
}

export default { auditOwnership };

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    if (args.length < 4) {
      die('usage: audit-ownership.sh <worktree> <base> <head> <writable_glob>...');
    }
    const result = auditOwnership(args[0], args[1], args[2], args.slice(3));
    for (const violation of result.violations) {
      process.stdout.write(`VIOLATION: ${violation}\n`);
    }
    return result.clean ? 0 : 3;
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
