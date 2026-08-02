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
  /**
   * Whether this vendor has a code-graph (symbol-index) tool configured on
   * this machine — see the code-graph probe section below. Best effort and
   * fail-open: `false` means "not detected", never "detection failed hard".
   *
   * Optional on the TYPE, always written by probeHeads. Absent means the
   * snapshot predates this field, which consumers must read as "unknown" and
   * act on exactly as they would with no snapshot at all (recordedCodeGraph).
   */
  code_graph?: boolean;
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

// ---------------------------------------------------------------------------
// Code-graph capability probe (run 0068, issue #28 E2).
//
// Measured in a live incident: an identical source-grounded review brief
// completed on codex in ~9 minutes with a 16.5 KB verdict, and failed TWICE
// on kimi (killed at the 15- and 45-minute caps, 531 and 734 bytes of pure
// forward-looking narration, no verdict). The difference confirmed on the
// machine that reproduced it: codex has a GitNexus MCP code-graph server
// configured; kimi has no MCP mechanism at all, so "find where X is
// enforced" degrades from one symbol lookup into re-reading every candidate
// file in full — kimi re-read dispatch.ts four times in a single attempt.
//
// This probe is DISCLOSURE ONLY. Nothing here routes, ranks, or substitutes
// vendors; allocate.ts is deliberately untouched. review-dispatch.ts reads
// the recorded value to add a reading-strategy preamble and warn, and that
// is all.
// ---------------------------------------------------------------------------

/**
 * MCP servers that actually provide a code-graph / symbol index.
 *
 * Granularity note: this is a NAME allow-list rather than "any MCP server is
 * configured at all". The field is `code_graph`, and an MCP server that
 * serves docs, mail or a browser does nothing for "where is X enforced?" —
 * the query whose absence caused the incident. Counting any MCP entry would
 * report a capability the reviewer does not have, which is worse than
 * reporting none. Add a name here when another code-graph server ships.
 */
export const CODE_GRAPH_MCP_SERVERS = ['gitnexus'] as const;

/** A per-vendor, read-only capability probe over the user's home dir. */
type CodeGraphProbe = (home: string) => boolean;

/**
 * codex: MCP servers are declared in ~/.codex/config.toml as TOML tables
 * named `[mcp_servers.<name>]` (bare or quoted key). This is exactly the
 * file and format the capability was confirmed against when the incident
 * was diagnosed — `[mcp_servers.gitnexus]` with `command = ".../gitnexus"`,
 * `args = ["mcp"]`.
 */
const codexCodeGraph: CodeGraphProbe = (home) => {
  const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  return CODE_GRAPH_MCP_SERVERS.some((name) =>
    new RegExp(String.raw`^[ \t]*\[mcp_servers\.["']?${name}["']?\][ \t]*$`, 'm').test(text));
};

/**
 * claude: user-scope MCP servers live in ~/.claude.json under `mcpServers`
 * (the same set `claude mcp list` reports at "User config" scope). We do not
 * shell out to `claude mcp list` because it performs a live network health
 * check per server; and we deliberately ignore project-scoped .mcp.json —
 * heads.json is a machine-global snapshot, so only machine-global capability
 * belongs in it.
 */
const claudeCodeGraph: CodeGraphProbe = (home) => {
  const parsed: unknown = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return false;
  return CODE_GRAPH_MCP_SERVERS.some((name) => name in (servers as Record<string, unknown>));
};

/**
 * opencode: an MCP mechanism does exist (`opencode mcp add|list`), with
 * servers declared under the `mcp` key of ~/.config/opencode/opencode.jsonc
 * (or .json). That config is JSONC — comments are legal — so we match the
 * declaration textually instead of parsing: a probe that must never throw
 * should not depend on a JSONC parser this kit does not ship. We do not run
 * `opencode mcp list` here because it renders an interactive TUI frame.
 */
const opencodeCodeGraph: CodeGraphProbe = (home) => {
  for (const file of ['opencode.jsonc', 'opencode.json']) {
    let text: string;
    try {
      text = readFileSync(join(home, '.config', 'opencode', file), 'utf8');
    } catch {
      continue;
    }
    if (!/"mcp"[ \t]*:/.test(text)) continue;
    if (CODE_GRAPH_MCP_SERVERS.some((name) => new RegExp(String.raw`"${name}"[ \t]*:`).test(text))) {
      return true;
    }
  }
  return false;
};

/**
 * kimi: honest constant false. Verified against the CLI's own `--help`
 * (kimi-code, 2026-08): there is no `--mcp` flag and no `mcp` subcommand —
 * no MCP configuration mechanism exists for this vendor at all today, so
 * its tools are Read/Grep/Glob/Bash only. Recorded as an explicit false
 * rather than left ambiguous; revisit if kimi ever ships MCP support.
 */
const kimiCodeGraph: CodeGraphProbe = () => false;

const CODE_GRAPH_PROBES: Record<KnownHead, CodeGraphProbe> = {
  claude: claudeCodeGraph,
  codex: codexCodeGraph,
  opencode: opencodeCodeGraph,
  kimi: kimiCodeGraph,
};

/**
 * Best-effort code-graph probe for one vendor. Read-only, and fail-open on
 * absolutely anything (no HOME, missing config, unreadable file, malformed
 * JSON/TOML) so it can never fail overall head detection. Injectable through
 * the same options bag every other probe here uses: `options.env.HOME`
 * redirects every config lookup, exactly as resolveActiveOpencodeModel's
 * stateDir does.
 */
function probeCodeGraph(head: KnownHead, options: DetectHeadsOptions): boolean {
  const home = (options.env ?? process.env).HOME ?? '';
  if (!home) return false;
  try {
    return CODE_GRAPH_PROBES[head](home) === true;
  } catch {
    return false;
  }
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
    code_graph: probeCodeGraph('opencode', options),
    models: opencodePath !== null ? listOpencodeModels(exec, timeoutMs) : [],
    active_model: resolveActiveOpencodeModel(options),
  };

  const kimi: KimiHeadEntry = {
    available: kimiPath !== null,
    path: kimiPath,
    code_graph: probeCodeGraph('kimi', options),
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
      claude: {
        available: claudePath !== null,
        path: claudePath,
        code_graph: probeCodeGraph('claude', options),
      },
      codex: {
        available: codexPath !== null,
        path: codexPath,
        code_graph: probeCodeGraph('codex', options),
      },
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

/**
 * The code-graph capability recorded for `vendor` in a snapshot, or `null`
 * when it cannot be determined (unknown vendor, or a snapshot written before
 * the field existed).
 *
 * `null` is emphatically NOT `false`: consumers must treat an undetermined
 * capability as "no signal" and change nothing, so a stale snapshot can
 * never silently alter a review.
 */
export function recordedCodeGraph(
  snapshot: HeadsSnapshot | null,
  vendor: string,
): boolean | null {
  if (snapshot === null) return null;
  if (!(KNOWN_HEADS as readonly string[]).includes(vendor)) return null;
  const entry = snapshot.heads[vendor as KnownHead] as HeadEntry | undefined;
  if (entry === undefined || entry === null || typeof entry !== 'object') return null;
  return typeof entry.code_graph === 'boolean' ? entry.code_graph : null;
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
        const details: string[] = [`code_graph=${head.code_graph ?? false}`];
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
