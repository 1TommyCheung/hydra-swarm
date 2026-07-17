import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MODEL } from './adapter-opencode.ts';
import { die, log, now } from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';

// ---------------------------------------------------------------------------
// Vendor-head auto-detection (run 0047).
//
// Probes each vendor CLI with `command -v` and writes a machine-global
// snapshot to ~/.local/state/hydra/heads.json (the same machine-global state
// dir adapter-kimi.ts uses for kimi-sandbox-domains.json — deliberately NOT
// the per-repo stateRoot()). Consumers:
//   - run-init.ts  refreshes the snapshot and appends heads_detected
//   - allocate.ts  drops unavailable vendors before ranking (live-probe
//     fallback when the file is absent)
//   - dispatch.ts  refuses to dispatch an unavailable assigned_vendor and
//     warns on a stale opencode_model pin
//
// Every probe goes through the injectable ProbeExec so tests never invoke
// real vendor tooling, matching the repo's options-bag pattern.
// ---------------------------------------------------------------------------

/** Vendor CLIs covered by head detection, in stable output order. */
export const KNOWN_HEADS = ['claude', 'codex', 'opencode', 'kimi'] as const;
export type KnownHead = (typeof KNOWN_HEADS)[number];

/** Injectable exec for CLI probes (`command -v <cli>`, `opencode models`). */
export type ProbeExec = (
  file: string,
  args: string[],
  options?: { timeoutMs?: number },
) => string | Buffer;

export interface HeadEntry {
  available: boolean;
  path: string | null;
}

export interface OpencodeHeadEntry extends HeadEntry {
  models: string[];
  active_model: string;
}

export interface KimiHeadEntry extends HeadEntry {
  srt_available: boolean;
  write_capable: boolean;
  /** Present only when write_capable is false. */
  reason?: string;
}

export interface HeadsSnapshot {
  detected_at: string;
  heads: {
    claude: HeadEntry;
    codex: HeadEntry;
    opencode: OpencodeHeadEntry;
    kimi: KimiHeadEntry;
  };
}

export interface DetectHeadsOptions {
  /** Injectable exec for every probe; defaults to execFileSync. */
  exec?: ProbeExec;
  /** Machine-global hydra state dir; defaults to ~/.local/state/hydra. */
  stateDir?: string;
  /** Environment for HYDRA_OPENCODE_MODEL / HOME; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Timeout for the `opencode models` enumeration; default 10s. */
  modelsTimeoutMs?: number;
}

const DEFAULT_MODELS_TIMEOUT_MS = 10_000;

const defaultProbeExec: ProbeExec = (file, args, options) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: options?.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS,
  });

/** The machine-global hydra state dir (deliberately NOT per-repo). */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? '', '.local/state/hydra');
}

/**
 * Resolve the heads.json path: an explicit stateDir wins, then the
 * HYDRA_HEADS_FILE override (tests/ops), then the machine-global default.
 */
export function headsFilePath(
  options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  if (options.stateDir !== undefined) return join(options.stateDir, 'heads.json');
  if (env.HYDRA_HEADS_FILE) return env.HYDRA_HEADS_FILE;
  return join(defaultStateDir(env), 'heads.json');
}

/** Resolve a CLI's PATH location, or null when `command -v` fails. */
function commandPath(name: string, exec: ProbeExec): string | null {
  try {
    const output = String(exec('sh', ['-c', `command -v ${name}`]));
    const firstLine = output.split('\n')[0]?.trim() ?? '';
    return firstLine || null;
  } catch {
    return null;
  }
}

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Enumerate configured opencode models; tolerant of any probe failure. */
function listOpencodeModels(exec: ProbeExec, timeoutMs: number): string[] {
  let output: string;
  try {
    output = String(exec('opencode', ['models'], { timeoutMs }));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  for (const rawLine of output.split('\n')) {
    const model = stripAnsi(rawLine).trim();
    if (model) seen.add(model);
  }
  return [...seen];
}

/**
 * The active opencode model, using the same precedence adapter-opencode.ts
 * uses: HYDRA_OPENCODE_MODEL, then <stateDir>/opencode-model.json, then the
 * adapter default. Unlike the adapter this is a detection snapshot, so an
 * invalid config falls through silently instead of warning.
 */
function resolveActiveOpencodeModel(options: DetectHeadsOptions): string {
  const env = options.env ?? process.env;
  const envModel = env.HYDRA_OPENCODE_MODEL;
  if (envModel) return envModel;

  const stateDir = options.stateDir ?? defaultStateDir(env);
  try {
    const config: unknown = JSON.parse(readFileSync(join(stateDir, 'opencode-model.json'), 'utf8'));
    if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
      const model = (config as Record<string, unknown>).model;
      if (typeof model === 'string' && model.length > 0) return model;
    }
  } catch {
    // Missing or unreadable config falls through to the adapter default.
  }
  return DEFAULT_MODEL;
}

/**
 * Probe every vendor head WITHOUT persisting anything. Never throws: each
 * per-CLI probe fails closed (that CLI is simply unavailable), which is the
 * signal consumers want.
 */
export function probeHeads(options: DetectHeadsOptions = {}): HeadsSnapshot {
  const exec = options.exec ?? defaultProbeExec;
  const timeoutMs = options.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS;

  const claudePath = commandPath('claude', exec);
  const codexPath = commandPath('codex', exec);
  const opencodePath = commandPath('opencode', exec);
  const kimiPath = commandPath('kimi', exec);
  const srtPath = commandPath('srt', exec);

  const opencode: OpencodeHeadEntry = {
    available: opencodePath !== null,
    path: opencodePath,
    models: opencodePath !== null ? listOpencodeModels(exec, timeoutMs) : [],
    active_model: resolveActiveOpencodeModel(options),
  };

  const kimi: KimiHeadEntry = {
    available: kimiPath !== null,
    path: kimiPath,
    srt_available: srtPath !== null,
    write_capable: kimiPath !== null && srtPath !== null,
  };
  if (!kimi.write_capable) {
    kimi.reason = kimiPath === null
      ? 'kimi CLI not found on PATH'
      : 'srt (OS sandbox) not found on PATH — kimi cannot take write roles unsandboxed';
  }

  return {
    detected_at: now(),
    heads: {
      claude: { available: claudePath !== null, path: claudePath },
      codex: { available: codexPath !== null, path: codexPath },
      opencode,
      kimi,
    },
  };
}

/** Write the snapshot atomically so concurrent readers never see a torn file. */
function writeSnapshotAtomic(path: string, snapshot: HeadsSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Probe every vendor head and persist the snapshot to heads.json. */
export function detectHeads(options: DetectHeadsOptions = {}): HeadsSnapshot {
  const snapshot = probeHeads(options);
  writeSnapshotAtomic(headsFilePath({ stateDir: options.stateDir, env: options.env }), snapshot);
  return snapshot;
}

/** Read a persisted heads.json; null when missing, unparsable, or misshapen. */
export function readHeadsFile(path: string): HeadsSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const heads = (parsed as Record<string, unknown>).heads;
  if (heads === null || typeof heads !== 'object' || Array.isArray(heads)) return null;
  return parsed as HeadsSnapshot;
}

/** Names of the available heads, in stable KNOWN_HEADS order. */
export function availableHeadNames(snapshot: HeadsSnapshot): string[] {
  return KNOWN_HEADS.filter((name) => snapshot.heads[name].available);
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    let json = false;
    for (const arg of args) {
      if (arg === '--json') json = true;
      else die('usage: detect-heads [--json]');
    }

    const snapshot = detectHeads();
    if (json) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else {
      for (const name of KNOWN_HEADS) {
        const head = snapshot.heads[name];
        if (!head.available) {
          process.stdout.write(`${name}: unavailable\n`);
          continue;
        }
        const details: string[] = [];
        if (name === 'opencode') {
          const opencode = snapshot.heads.opencode;
          details.push(`active_model=${opencode.active_model}`, `models=${opencode.models.length}`);
        }
        if (name === 'kimi') {
          const kimi = snapshot.heads.kimi;
          details.push(`srt=${kimi.srt_available ? 'available' : 'missing'}`, `write_capable=${kimi.write_capable}`);
        }
        process.stdout.write(`${name}: available (${head.path})${details.length ? ` ${details.join(' ')}` : ''}\n`);
      }
    }
    log(`heads snapshot written to ${headsFilePath()}`);
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
