import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonRequest, daemonSocketPath } from './daemon/client.ts';
import { log, die, warn, runDir, repoId, repoRoot, now, ledgerAppend } from './lib.ts';
import { availableHeadNames, detectHeads, type HeadsSnapshot } from './detect-heads.ts';
import { isCompiledBinary } from './kit-assets.ts';

export interface RunInitOptions {
  /**
   * Injectable head detector (run 0047). When provided, run-init probes the
   * vendor heads, refreshes the machine-global heads.json, and appends a
   * heads_detected ledger event summarizing the available heads. Detection is
   * wired at the CLI boundary (main below); library callers that omit it get
   * no detection and no event, keeping run-init composition in tests hermetic.
   */
  detectHeads?: () => HeadsSnapshot | null;
}

/**
 * Create the external state layout for a run.
 *
 * Creates the run directory tree under the external state root, writes the
 * run.yaml descriptor, emits the `run_started` ledger event, and returns the
 * absolute path to the run directory.
 *
 * @param runId - required run identifier
 * @param baseCommit - optional base commit; defaults to current HEAD
 * @param options - optional injectables (head detection)
 * @returns absolute path to the run directory
 */
export function runInit(runId: string, baseCommit?: string, options: RunInitOptions = {}): string {
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

  // Vendor-head detection (run 0047): refresh the machine-global heads.json
  // and summarize the available heads in the ledger. Detection is best effort
  // — a probe failure must never block run initialization.
  if (options.detectHeads) {
    try {
      const snapshot = options.detectHeads();
      if (snapshot) {
        const available = availableHeadNames(snapshot);
        ledgerAppend(
          runId,
          'heads_detected',
          'available', available.length > 0 ? available.join(',') : 'none',
          'count', String(available.length),
        );
      }
    } catch (error) {
      warn(`head detection failed at run init; continuing: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  log(`run ${runId} initialized at ${dir} (base ${resolvedBase})`);
  process.stdout.write(`${dir}\n`);
  return dir;
}

export default runInit;

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (!args[0]) die('usage: run-init.sh <run_id> [base_commit]');
    const socket = daemonSocketPath();
    if (socket) {
      const payload: Record<string, unknown> = { run_id: args[0] };
      if (args[1]) payload.base_commit = args[1];
      const response = await daemonRequest('create-run', payload, { socketPath: socket });
      process.stdout.write(`${String(response.run_dir ?? '')}\n`);
      return 0;
    }
    runInit(args[0], args[1], { detectHeads: () => detectHeads() });
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
  process.exitCode = await main();
}
