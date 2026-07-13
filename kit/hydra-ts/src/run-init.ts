import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, die, runDir, repoId, repoRoot, now, ledgerAppend } from './lib.ts';

/**
 * Create the external state layout for a run.
 *
 * Creates the run directory tree under the external state root, writes the
 * run.yaml descriptor, emits the `run_started` ledger event, and returns the
 * absolute path to the run directory.
 *
 * @param runId - required run identifier
 * @param baseCommit - optional base commit; defaults to current HEAD
 * @returns absolute path to the run directory
 */
export function runInit(runId: string, baseCommit?: string): string {
  if (!runId) {
    die('usage: runInit(runId, baseCommit?)');
  }

  const resolvedBase =
    baseCommit ||
    execFileSync('git', ['-C', repoRoot(), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

  const dir = runDir(runId);
  if (existsSync(dir)) {
    die(`run already exists: ${dir}`);
  }

  const dirs = [
    `${dir}/tasks`,
    `${dir}/inbox`,
    `${dir}/authoritative/ledger`,
    `${dir}/authoritative/results`,
    `${dir}/authoritative/reviews`,
    `${dir}/authoritative/verification`,
    `${dir}/sessions`,
  ];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }

  // Lock down the authoritative tree so accidental non-harness writes are at
  // least inconvenient (defense in depth).
  chmodSync(`${dir}/authoritative`, 0o755);

  const yaml = `run_id: "${runId}"
base_commit: ${resolvedBase}
repo_id: ${repoId()}
created: ${now()}
state: planning
tasks: []
`;
  writeFileSync(`${dir}/run.yaml`, yaml, 'utf8');

  ledgerAppend(runId, 'run_started', 'base_commit', resolvedBase);

  log(`run ${runId} initialized at ${dir} (base ${resolvedBase})`);
  process.stdout.write(`${dir}\n`);
  return dir;
}

export default runInit;

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    if (!args[0]) die('usage: run-init.sh <run_id> [base_commit]');
    runInit(args[0], args[1]);
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
