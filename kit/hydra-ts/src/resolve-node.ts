import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isCompiledBinary } from './kit-assets.ts';

// TypeScript mirror of the shell launcher's hydra_resolve_node() ladder
// (kit/hydra/scripts/lib.sh), for the worker-environment side: macOS
// login-shell initialization (path_helper) inside vendor-CLI tool shells
// rebuilds PATH with /usr/local/bin ahead of version managers, so a stale
// system node (v17 in the field incident, Jon_test_redcat run 0002) shadows
// the correct one for workers even though dispatch handed them a good PATH.

const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 6;

export type VersionExec = (file: string, args: string[]) => string | Buffer;

export interface ResolveNodeBinOptions {
  /** Injectable exec for `command -v node` / `node --version` probes. */
  exec?: VersionExec;
  /** Home directory for the nvm scan; defaults to $HOME. */
  homeDir?: string;
  /** Whether this process is the compiled hydra-cli binary; defaults to isCompiledBinary(). */
  compiled?: boolean;
  /** The current executable path; defaults to process.execPath. */
  execPath?: string;
}

/** True when a `node --version` string satisfies the harness's >=22.6 floor. */
export function nodeMeetsRequirement(version: string): boolean {
  const match = version.trim().match(/^v(\d+)\.(\d+)\./);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor >= REQUIRED_MINOR);
}

function versionOf(candidate: string, exec: VersionExec): string {
  try {
    return String(exec(candidate, ['--version'])).trim();
  } catch {
    return '';
  }
}

function parseVersionDir(name: string): [number, number, number] | null {
  const match = name.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Resolve the bin directory of a Node.js >=22.6 install for WORKER use,
 * exported to workers as HYDRA_NODE_BIN. Returns '' when none is found —
 * callers must treat that as "leave the env untouched", never as an error:
 * a target project may not need node at all.
 */
export function resolveWorkerNodeBinDir(options: ResolveNodeBinOptions = {}): string {
  const compiled = options.compiled ?? isCompiledBinary();
  const execPath = options.execPath ?? process.execPath;

  // Source lane: this process IS the launcher-resolved node (>=22.6 enforced
  // by hydra_resolve_node() before exec), so its own bin dir is the answer.
  if (!compiled) return dirname(execPath);

  // Compiled lane: process.execPath is the hydra-cli binary, not node.
  const exec = options.exec ?? ((file, args) => execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }));

  let pathCandidate = '';
  try {
    pathCandidate = String(exec('sh', ['-c', 'command -v node'])).trim();
  } catch {
    pathCandidate = '';
  }
  if (pathCandidate && nodeMeetsRequirement(versionOf(pathCandidate, exec))) {
    return dirname(pathCandidate);
  }

  const homeDir = options.homeDir ?? process.env.HOME ?? '';
  if (homeDir) {
    const nvmRoot = join(homeDir, '.nvm/versions/node');
    let entries: string[] = [];
    try {
      entries = readdirSync(nvmRoot);
    } catch {
      entries = [];
    }
    let best: [number, number, number] | null = null;
    let bestDir = '';
    for (const entry of entries) {
      const version = parseVersionDir(entry);
      if (!version) continue;
      if (version[0] < REQUIRED_MAJOR
        || (version[0] === REQUIRED_MAJOR && version[1] < REQUIRED_MINOR)) continue;
      const bin = join(nvmRoot, entry, 'bin', 'node');
      try {
        if (!statSync(bin).isFile()) continue;
      } catch {
        continue;
      }
      if (!best
        || version[0] > best[0]
        || (version[0] === best[0] && version[1] > best[1])
        || (version[0] === best[0] && version[1] === best[1] && version[2] > best[2])) {
        best = version;
        bestDir = join(nvmRoot, entry, 'bin');
      }
    }
    if (bestDir) return bestDir;
  }

  for (const candidate of [
    '/opt/homebrew/bin/node',
    '/opt/homebrew/opt/node/bin/node',
    '/usr/local/opt/node/bin/node',
  ]) {
    if (nodeMeetsRequirement(versionOf(candidate, exec))) return dirname(candidate);
  }

  return '';
}
