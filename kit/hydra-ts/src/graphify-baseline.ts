import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  type Dirent,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  die,
  graphifyDir,
  ledgerAppend,
  log,
  repoRoot,
  warn,
} from './lib.ts';

// ---------------------------------------------------------------------------
// Graphify baseline — TypeScript port of hydra/scripts/graphify-baseline.sh.
//
// Run-scoped semantic baseline over code + docs. Selects a backend (kimi or
// claude), honours the Kimi coding-plan base-URL override, invokes graphify,
// extracts node/link statistics from the resulting graph.json, and appends a
// ledger event. When no API key is present the baseline is skipped (exit 8)
// but never treated as a failure.
// ---------------------------------------------------------------------------

/** Injected execFileSync replacement; mirrors child_process.execFileSync. */
export type ExecFileSyncLike = (
  command: string,
  args: string[],
  options?: {
    encoding?: BufferEncoding;
    stdio?: any;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
  },
) => string | Buffer;

/** Optional dependencies/overrides for testability. */
export interface GraphifyBaselineOptions {
  /** Base directory used to resolve a relative source path. */
  cwd?: string;
  /** Override for the external state root (HYDRA_STATE_ROOT equivalent). */
  stateRoot?: string;
  /** Environment used for API-key checks and the graphify invocation. */
  env?: NodeJS.ProcessEnv;
  /** Injected exec implementation for tests. */
  execFileSync?: ExecFileSyncLike;
}

/** Result describing what the baseline pass produced. */
export interface GraphifyBaselineResult {
  status: 'ok' | 'skipped_no_key';
  graphPath?: string;
  backend: string;
  nodes?: number;
  edges?: number;
  extracted?: number;
  inferred?: number;
}

/** Default real executor. */
function defaultExecFileSync(
  command: string,
  args: string[],
  options?: {
    encoding?: BufferEncoding;
    stdio?: any;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
  },
): string | Buffer {
  return execFileSync(command, args, {
    ...options,
    encoding: options?.encoding ?? 'utf8',
  });
}

/** Locate graphify through the injected command boundary. */
function locateGraphify(exec: ExecFileSyncLike): string {
  try {
    return String(
      exec('bash', ['-c', 'command -v -- "$1"', 'bash', 'graphify'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
  } catch {
    die('graphify CLI not found (Wave 2 dependency)');
  }
}

/** Run a block with HYDRA_STATE_ROOT temporarily overridden. */
function withStateRoot<T>(stateRoot: string | undefined, fn: () => T): T {
  if (!stateRoot) return fn();
  const previous = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = stateRoot;
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

/** Resolve the graphify output directory, honouring an optional state-root override. */
function resolveGraphifyDir(runId: string, options?: GraphifyBaselineOptions): string {
  return withStateRoot(options?.stateRoot, () => graphifyDir(runId));
}

/** Locate graph.json anywhere under outDir. */
function findGraphJson(outDir: string): string | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(outDir, { withFileTypes: true, recursive: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'graph.json') {
      return join(entry.parentPath, entry.name);
    }
    // node <22 uses path instead of parentPath on Dirent.
    if (!('parentPath' in entry)) {
      const legacyPath = (entry as unknown as { path?: string }).path;
      if (legacyPath) {
        return join(legacyPath, entry.name);
      }
    }
  }
  return undefined;
}

interface GraphStats {
  nodes: number;
  edges: number;
  extracted: number;
  inferred: number;
}

/** Match jq's `length`, returning the Bash fallback value for jq errors. */
function jqLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return Array.from(value).length;
  if (typeof value === 'object') return Object.keys(value).length;
  return 0;
}

/** Match jq's `//`: only null and false select the fallback operand. */
function jqAlternative(primary: unknown, fallback: unknown): unknown {
  return primary === null || primary === undefined || primary === false ? fallback : primary;
}

/** Match the Bash script's four best-effort jq queries. */
function graphStats(graph: string): GraphStats {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(graph, 'utf8'));
  } catch {
    return { nodes: 0, edges: 0, extracted: 0, inferred: 0 };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { nodes: 0, edges: 0, extracted: 0, inferred: 0 };
  }

  const record = data as Record<string, unknown>;
  const links = jqAlternative(record.links, record.edges);
  const values = Array.isArray(links)
    ? links
    : typeof links === 'object' && links !== null
      ? Object.values(links)
      : [];

  const countConfidence = (confidence: string): number => {
    if (
      values.some(
        (value) => value !== null && (typeof value !== 'object' || Array.isArray(value)),
      )
    ) {
      return 0;
    }
    return values.filter(
      (value) =>
        value !== null && (value as Record<string, unknown>).confidence === confidence,
    ).length;
  };

  return {
    nodes: jqLength(record.nodes),
    edges: jqLength(links),
    extracted: countConfidence('EXTRACTED'),
    inferred: countConfidence('INFERRED'),
  };
}

/** Build the Python override script used for the Kimi coding-plan endpoint. */
function buildKimiOverrideScript(): string {
  return `import sys, runpy, os
import graphify.llm as L
L.BACKENDS["kimi"]["base_url"] = os.environ["GRAPHIFY_KIMI_BASE_URL"]
L.BACKENDS["kimi"]["default_model"] = os.environ.get("GRAPHIFY_KIMI_MODEL", "kimi-for-coding")
_UA = os.environ.get("GRAPHIFY_KIMI_USER_AGENT", "kimi-code-cli/0.23.6")
import openai as _oai
_Orig = _oai.OpenAI
def _Patched(*a, **k):
    h = dict(k.get("default_headers") or {})
    h.setdefault("User-Agent", _UA)
    k["default_headers"] = h
    return _Orig(*a, **k)
_oai.OpenAI = _Patched
src, out = sys.argv[1], sys.argv[2]
sys.argv = ["graphify", "extract", src, "--backend", "kimi", "--out", out]
runpy.run_module("graphify", run_name="__main__")
`;
}

/**
 * Run a Graphify semantic baseline for the given run.
 *
 * @param runId - required run identifier
 * @param src - source path to analyse; defaults to the repository root
 * @param backend - 'kimi' (default) or 'claude'
 * @param options - testability overrides
 * @returns baseline result, including the path to the stable graph.json pointer
 */
export function graphifyBaseline(
  runId: string,
  src?: string,
  backend: 'kimi' | 'claude' = 'kimi',
  options: GraphifyBaselineOptions = {},
): GraphifyBaselineResult {
  const exec = options.execFileSync ?? defaultExecFileSync;

  // The Bash entrypoint checks its Wave 2 dependency before parsing arguments.
  locateGraphify(exec);

  if (!runId) {
    die('usage: graphifyBaseline(runId, src?, backend?, options?)');
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  // Resolve source path; default to repository root.
  const source = src ? resolve(cwd, src) : repoRoot();

  const outDir = resolveGraphifyDir(runId, options);
  mkdirSync(outDir, { recursive: true });

  // Backend key check.
  let keyPresent = false;
  if (backend === 'claude' && env.ANTHROPIC_API_KEY) {
    keyPresent = true;
  } else if (backend === 'kimi' && env.MOONSHOT_API_KEY) {
    keyPresent = true;
  }

  if (!keyPresent) {
    withStateRoot(options.stateRoot, () =>
      ledgerAppend(runId, 'graphify_baseline', 'status', 'skipped_no_key', 'backend', backend),
    );
    warn(
      `no LLM key for graphify --backend ${backend}; Graphify baseline omitted (never a blocker)`,
    );
    process.exitCode = 8;
    return { status: 'skipped_no_key', backend };
  }

  log(`building Graphify baseline over ${source} (backend ${backend})`);

  if (backend === 'kimi' && env.GRAPHIFY_KIMI_BASE_URL) {
    // In-memory backend override for a coding-plan key; installed package untouched.
    let gpy = 'python3';
    try {
      const graphifyPath = locateGraphify(exec);
      const candidate = join(dirname(graphifyPath), 'python3');
      accessSync(candidate, constants.X_OK);
      gpy = candidate;
    } catch {
      // Fall back to python3.
    }

    try {
      exec(gpy, ['-', source, outDir], {
        cwd: source,
        env,
        input: buildKimiOverrideScript(),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      die('graphify extract (override) failed');
    }
  } else {
    try {
      exec('graphify', ['extract', source, '--backend', backend, '--out', outDir], {
        cwd: source,
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      die('graphify extract failed');
    }
  }

  const graph = findGraphJson(outDir);
  if (!graph || !existsSync(graph)) {
    die(`graphify produced no graph.json under ${outDir}`);
  }

  const { nodes, edges, extracted, inferred } = graphStats(graph);

  // Stable pointer for consumers.
  const stablePointer = join(outDir, 'graph.json');
  if (graph !== stablePointer) {
    try {
      rmSync(stablePointer, { force: true });
      symlinkSync(graph, stablePointer);
    } catch {
      cpSync(graph, stablePointer);
    }
  }

  withStateRoot(options.stateRoot, () =>
    ledgerAppend(
      runId,
      'graphify_baseline',
      'status',
      'ok',
      'backend',
      backend,
      'nodes',
      String(nodes),
      'edges',
      String(edges),
      'extracted',
      String(extracted),
      'inferred',
      String(inferred),
    ),
  );

  log(
    `Graphify baseline: ${nodes} nodes, ${edges} edges (${extracted} EXTRACTED / ${inferred} INFERRED)`,
  );
  process.stdout.write(`${stablePointer}\n`);

  return {
    status: 'ok',
    graphPath: stablePointer,
    backend,
    nodes,
    edges,
    extracted,
    inferred,
  };
}

export default { graphifyBaseline };
