import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, log, repoRoot as defaultRepoRoot } from './lib.ts';

/** Result from one injected external command. */
export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Combined stdout/stderr in arrival order, used for the update pipe. */
  output?: string;
}

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

/** Injectable command boundary; tests must use this instead of vendor CLIs. */
export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => CommandResult | Promise<CommandResult>;

export interface GraphifyRepoOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  exec?: CommandRunner;
  /** Resolved graphify executable. Useful with an injected runner. */
  graphifyPath?: string;
  /** Override graphify's sibling interpreter for the Kimi adapter path. */
  pythonPath?: string;
  /** Wall-clock cap for build; defaults to GRAPHIFY_TIMEOUT_SEC or 600. */
  timeoutSec?: number;
  /** Grace before SIGKILL in the real runner. */
  killGraceMs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  logger?: (message: string) => void;
}

const KIMI_ADAPTER = String.raw`import sys, runpy, os
import graphify.llm as L
L.BACKENDS["kimi"]["base_url"] = os.environ["GRAPHIFY_KIMI_BASE_URL"]
L.BACKENDS["kimi"]["default_model"] = os.environ.get("GRAPHIFY_KIMI_MODEL", "kimi-for-coding")
import openai as _oai
_UA = os.environ.get("GRAPHIFY_KIMI_USER_AGENT", "kimi-code-cli/0.23.6")
_Orig = _oai.OpenAI
def _P(*a, **k):
    h = dict(k.get("default_headers") or {}); h.setdefault("User-Agent", _UA); k["default_headers"] = h
    return _Orig(*a, **k)
_oai.OpenAI = _P
src = sys.argv[1]
sys.argv = ["graphify", "extract", src, "--backend", "kimi", "--out", src]
runpy.run_module("graphify", run_name="__main__")
`;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate an executable without invoking a shell. */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (command.includes('/')) return executable(command) ? command : undefined;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

/** Real command runner used outside tests. */
export function defaultRunCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let output = '';
    let settled = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      output += chunk;
    });

    const finish = (result: Pick<CommandResult, 'exitCode' | 'signal'>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stdout, stderr, output });
    };

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (child.pid === undefined || settled) return;
          signalGroup(child.pid, 'SIGTERM');
          const killer = setTimeout(
            () => signalGroup(child.pid!, 'SIGKILL'),
            options.killGraceMs ?? 2_000,
          );
          killer.unref();
          finish({ exitCode: 124, signal: null });
        }, options.timeoutMs);

    child.once('error', () => finish({ exitCode: 127, signal: null }));
    child.once('close', (exitCode, signal) =>
      finish({ exitCode: exitCode ?? null, signal: signal ?? null }));

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function graphCounts(graphPath: string, strict: boolean): {
  nodes: number;
  edges: number;
  extracted: number;
} {
  try {
    const parsed = JSON.parse(readFileSync(graphPath, 'utf8')) as {
      nodes?: unknown;
      links?: unknown;
      edges?: unknown;
    };
    const edgesValue = parsed.links === null
      || parsed.links === undefined
      || parsed.links === false
      ? parsed.edges
      : parsed.links;
    const edges = Array.isArray(edgesValue) ? edgesValue : [];
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
      edges: edges.length,
      extracted: edges.filter(
        (edge) => typeof edge === 'object'
          && edge !== null
          && (edge as { confidence?: unknown }).confidence === 'EXTRACTED',
      ).length,
    };
  } catch (error) {
    if (strict) throw error;
    return { nodes: 0, edges: 0, extracted: 0 };
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findGraph(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const direct = join(root, 'graph.json');
  if (isFile(direct)) return direct;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.shift()!;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (entry === 'graph.json' && isFile(path)) return path;
      if (stat.isDirectory()) pending.push(path);
    }
  }
  return undefined;
}

function tail(text: string, lines: number): string {
  if (!text) return '';
  const hasFinalNewline = text.endsWith('\n');
  const parts = text.split('\n');
  if (hasFinalNewline) parts.pop();
  const result = parts.slice(-lines).join('\n');
  return hasFinalNewline ? `${result}\n` : result;
}

function commandFailed(result: CommandResult): boolean {
  return result.exitCode !== 0;
}

/**
 * Maintain the persistent repository-wide Graphify graph.
 *
 * This is the ES module port of hydra/scripts/graphify-repo.sh. All process
 * execution is routed through `options.exec` so tests can remain hermetic.
 */
export async function graphifyRepo(
  argv: string[] = [],
  options: GraphifyRepoOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const runner = options.exec ?? defaultRunCommand;
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const logger = options.logger ?? log;

  // Bash performs this dependency gate before parsing the verb.
  const graphifyPath = options.graphifyPath
    ?? (options.exec ? 'graphify' : findExecutable('graphify', env));
  if (!graphifyPath) die('graphify CLI not found (Wave 2 dependency)');

  let root: string;
  if (options.repoRoot) {
    root = options.repoRoot;
  } else if (options.exec) {
    const discovered = await runner('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      env,
      killGraceMs: options.killGraceMs,
    });
    if (commandFailed(discovered) || !discovered.stdout.trim()) {
      die(`not inside a git repository (cwd: ${process.cwd()}) — hydra resolves its state dir from the repo root; cd into the target repo (or one of its worktrees) and re-run`);
    }
    root = discovered.stdout.trim();
  } else {
    root = defaultRepoRoot();
  }
  const outDir = join(root, 'graphify-out');
  let graph = join(outDir, 'graph.json');
  const stamp = join(outDir, '.hydra_indexed_commit');
  const [verb = 'status', ...args] = argv;

  const run = (command: string, commandArgs: string[], extra: Partial<CommandOptions> = {}) =>
    runner(command, commandArgs, {
      cwd: root,
      env,
      killGraceMs: options.killGraceMs,
      ...extra,
    });

  const head = async (): Promise<string> => {
    const result = await run('git', ['-C', root, 'rev-parse', 'HEAD']);
    if (commandFailed(result)) {
      if (result.stderr) writeErr(result.stderr);
      die('git rev-parse HEAD failed');
    }
    return result.stdout.trim();
  };

  if (verb === 'build') {
    const backend = args[0] ?? 'kimi';
    const keyOk = backend === 'claude'
      ? Boolean(env.ANTHROPIC_API_KEY)
      : backend === 'kimi' && Boolean(env.MOONSHOT_API_KEY);
    if (!keyOk) {
      die(`no LLM key for graphify --backend ${backend} (set ANTHROPIC_API_KEY / MOONSHOT_API_KEY)`);
    }

    logger(`building standing repo graph over code + docs (backend ${backend})…`);
    const cap = options.timeoutSec ?? Number(env.GRAPHIFY_TIMEOUT_SEC ?? '600');
    const timeoutMs = Number.isFinite(cap) && cap > 0 ? cap * 1_000 : undefined;
    let result: CommandResult;
    let override = false;
    if (backend === 'kimi' && env.GRAPHIFY_KIMI_BASE_URL) {
      override = true;
      let python = options.pythonPath;
      if (!python) {
        const sibling = join(dirname(graphifyPath), 'python3');
        python = executable(sibling) ? sibling : 'python3';
      }
      result = await run(python, ['-', root], {
        input: KIMI_ADAPTER,
        timeoutMs,
      });
    } else {
      result = await run(
        graphifyPath,
        ['extract', root, '--backend', backend, '--out', root],
        { timeoutMs },
      );
    }
    if (commandFailed(result)) {
      die(
        `graphify extract${override ? ' (override)' : ''} failed or timed out after ${cap}s`,
      );
    }

    graph = findGraph(outDir) ?? graph;
    if (!isFile(graph)) die('graphify produced no graph.json');
    writeFileSync(stamp, `${await head()}\n`, 'utf8');

    const counts = graphCounts(graph, false);
    logger(
      `standing repo graph: ${counts.nodes} nodes, ${counts.edges} edges (${counts.extracted} EXTRACTED) -> ${graph}`,
    );
    writeOut(`${graph}\n`);
    return graph;
  }

  if (verb === 'update') {
    if (!isFile(graph)) {
      die('no standing graph yet; run: graphify-repo.sh build');
    }
    const result = await run(graphifyPath, ['update', root]);
    const merged = result.output ?? `${result.stdout}${result.stderr}`;
    const lastLines = tail(merged, 3);
    if (lastLines) writeOut(lastLines);
    if (commandFailed(result)) die('graphify update failed');
    writeFileSync(stamp, `${await head()}\n`, 'utf8');
    return lastLines;
  }

  if (verb === 'query') {
    if (!isFile(graph)) {
      die('no standing graph yet; run: graphify-repo.sh build');
    }
    const question = args[0];
    if (!question) die('usage: graphify-repo.sh query "<question>"');
    const result = await run(graphifyPath, ['query', question]);
    if (result.stdout) writeOut(result.stdout);
    if (result.stderr) writeErr(result.stderr);
    if (commandFailed(result)) die('graphify query failed');
    return result.stdout;
  }

  if (verb === 'status') {
    let status: string;
    if (isFile(graph)) {
      let indexed = 'unknown';
      try {
        indexed = readFileSync(stamp, 'utf8').trim() || 'unknown';
      } catch {
        // Bash suppresses a missing/unreadable stamp and substitutes "unknown".
      }
      const currentHead = await head();
      const freshness = indexed === currentHead
        ? 'up-to-date'
        : `STALE (indexed ${indexed.slice(0, 8)}, HEAD ${currentHead.slice(0, 8)})`;
      const counts = graphCounts(graph, true);
      status = `standing repo graph: ${counts.nodes} nodes, ${counts.edges} edges — ${freshness}`;
    } else {
      status = 'no standing repo graph yet — run: graphify-repo.sh build';
    }
    writeOut(`${status}\n`);
    return status;
  }

  die('usage: graphify-repo.sh build|update|query "<q>"|status');
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    await graphifyRepo(args);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await main();
}

export default graphifyRepo;
