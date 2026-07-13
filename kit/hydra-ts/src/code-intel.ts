import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die } from './lib.ts';

// ---------------------------------------------------------------------------
// Code intel — TypeScript port of hydra/scripts/code-intel.sh.
//
// Combined GitNexus + Graphify query tool. Each half is labelled with its
// source and authority, and degrades gracefully when either tool is absent.
// ---------------------------------------------------------------------------

/** Testable exec injection; mirrors the shape of child_process.execFileSync. */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { encoding?: string; stdio?: any; cwd?: string },
) => string | Buffer;

/** Options that make the side-effectful code-intel functions testable. */
export interface CodeIntelOptions {
  /** Base directory used to resolve relative paths. */
  cwd?: string;
  /** Unused by this module, kept for compatibility with sibling options bags. */
  stateRoot?: string;
  /** Injected exec implementation for tests. */
  exec?: ExecLike;
  /** Path or name of the gitnexus CLI. Defaults to "gitnexus". */
  gitnexusPath?: string;
  /** Path or name of the graphify CLI. Defaults to "graphify". */
  graphifyPath?: string;
  /** Path to the standing Graphify graph. Defaults to ${repoRoot}/graphify-out/graph.json. */
  graphPath?: string;
  /** Injected stdout writer for error paths that emit before exiting. */
  stdout?: (output: string) => void;
}

interface GraphNode {
  id: string;
  source_file?: string;
  file_type?: string;
}

interface GraphEdge {
  relation: string;
  confidence: string;
  confidence_score?: number;
  source: string;
  target: string;
  source_file?: string;
}

interface Graph {
  nodes?: GraphNode[];
  links?: GraphEdge[];
  edges?: GraphEdge[];
}

interface EnrichedEdge {
  rel: string;
  conf: string;
  score?: number;
  src: string;
  tgt: string;
  src_file: string;
  tgt_file: string;
}

const ANSI_RE = /\x1B\[[0-9;]*m/g;

/** Strip ANSI SGR escape sequences from a string. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

function defaultExec(): ExecLike {
  return execFileSync;
}

function runCommand(
  exec: ExecLike,
  command: string,
  args: string[],
  options?: { encoding?: string; stdio?: any; cwd?: string },
): string {
  return String(exec(command, args, options));
}

function commandAvailable(command: string, exec: ExecLike): boolean {
  try {
    runCommand(
      exec,
      'bash',
      ['-c', 'command -v -- "$1" >/dev/null 2>&1', 'bash', command],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

function repoRoot(options: CodeIntelOptions): string {
  const exec = options.exec ?? defaultExec();
  return runCommand(exec, 'git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd: options.cwd,
  }).trim();
}

function gitnexusRepoId(options: CodeIntelOptions): string {
  const gitnexusOverride = process.env.HYDRA_GITNEXUS_REPO;
  if (gitnexusOverride) return gitnexusOverride;
  const repoOverride = process.env.HYDRA_REPO_ID;
  if (repoOverride) return repoOverride;
  return basename(repoRoot(options));
}

function gitnexusCommand(options: CodeIntelOptions): string {
  return options.gitnexusPath ?? 'gitnexus';
}

function graphifyCommand(options: CodeIntelOptions): string {
  return options.graphifyPath ?? 'graphify';
}

function graphPath(options: CodeIntelOptions): string {
  if (options.graphPath) return options.graphPath;
  return `${repoRoot(options)}/graphify-out/graph.json`;
}

function haveGraph(options: CodeIntelOptions): boolean {
  return existsSync(graphPath(options));
}

function readGraph(options: CodeIntelOptions): Graph {
  return JSON.parse(readFileSync(graphPath(options), 'utf8')) as Graph;
}

function readGraphForEdges(options: CodeIntelOptions): Graph {
  try {
    const graph = readGraph(options);
    return graph && typeof graph === 'object' ? graph : {};
  } catch {
    // _gf_edges_touching emits [] when jq cannot read the standing graph.
    return {};
  }
}

/** node id → source_file map. */
function nodeFileMap(graph: Graph): Record<string, string> {
  const map: Record<string, string> = {};
  for (const node of graph.nodes ?? []) {
    map[node.id] = node.source_file ?? '';
  }
  return map;
}

/** node id → {file, type} map. */
function nodeInfoMap(graph: Graph): Record<string, { f: string; t: string }> {
  const map: Record<string, { f: string; t: string }> = {};
  for (const node of graph.nodes ?? []) {
    map[node.id] = { f: node.source_file ?? '', t: node.file_type ?? '' };
  }
  return map;
}

/** Edges (with endpoint files) touching any of the given path fragments. */
function edgesTouching(graph: Graph, frags: string[]): EnrichedEdge[] {
  const nf = nodeFileMap(graph);
  const edges = graph.links ?? graph.edges ?? [];
  return edges
    .map((e) => ({
      rel: e.relation,
      conf: e.confidence,
      score: e.confidence_score,
      src: e.source,
      tgt: e.target,
      src_file: nf[e.source] ?? e.source_file ?? '',
      tgt_file: nf[e.target] ?? '',
    }))
    .filter(
      (e) =>
        frags.some(
          (f) =>
            (e.src_file.includes(f) ||
              e.tgt_file.includes(f)),
        ),
    );
}

function gitChangedFiles(base: string, options: CodeIntelOptions): string[] {
  const exec = options.exec ?? defaultExec();
  const root = repoRoot(options);
  try {
    const output = runCommand(
      exec,
      'git',
      ['-C', root, 'diff', '--name-only', `${base}...HEAD`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gitnexusOutput(
  options: CodeIntelOptions,
  args: string[],
  headLimit: number,
  repo: string,
  stripColors = true,
): string {
  const exec = options.exec ?? defaultExec();
  const command = gitnexusCommand(options);
  const output = runCommand(
    exec,
    command,
    [...args, '--repo', repo],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
  );
  return (stripColors ? stripAnsi(output) : output)
    .split('\n')
    .slice(0, headLimit)
    .join('\n')
    .replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// Subcommands.
// ---------------------------------------------------------------------------

/** changed: what changed structurally + which design intent it touches. */
export function changed(base: string, options: CodeIntelOptions = {}): string {
  const exec = options.exec ?? defaultExec();
  const gitnexusAvailable = commandAvailable(gitnexusCommand(options), exec);

  let structure = '';
  if (gitnexusAvailable) {
    const repo = gitnexusRepoId(options);
    structure = gitnexusOutput(
      options,
      ['detect-changes', '--scope', 'compare', '--base-ref', base],
      40,
      repo,
    );
  }

  const graphAvailable = haveGraph(options);
  let designIntent = '';
  if (graphAvailable) {
    const graph = readGraphForEdges(options);
    let files = gitChangedFiles(base, options);
    if (files.length === 0) files = ['HEAD'];
    const edges = edgesTouching(graph, files);
    const inv = edges.filter((e) => e.conf === 'EXTRACTED');
    const q = edges.filter((e) => e.conf === 'INFERRED' || e.conf === 'AMBIGUOUS');
    designIntent = [
      `EXTRACTED investigations (confirm against source/diff/tests): ${inv.length}`,
      ...inv.map((e) => `  - ${e.rel}: ${e.src} → ${e.tgt}  [${e.src_file}]`),
      `INFERRED questions (never a gate): ${q.length}`,
      ...q.map((e) => `  - ${e.rel}: ${e.src} → ${e.tgt}`),
    ].join('\n');
  }

  return [
    `# code-intel: changed  (base ${base})`,
    '',
    '## Structure — GitNexus (RISK INPUT; JS symbol-level, bash file-level)',
    gitnexusAvailable ? structure : '  (gitnexus not available)',
    '',
    '## Design intent touched — Graphify (INVESTIGATION-NOT-VERDICT)',
    graphAvailable ? designIntent : '  (no standing graph — run: graphify-repo.sh build)',
    '',
  ].join('\n');
}

/** impact: blast-radius (GitNexus) + semantic neighbours (Graphify). */
export function impact(symbol: string, options: CodeIntelOptions = {}): string {
  const exec = options.exec ?? defaultExec();
  const gitnexusAvailable = commandAvailable(gitnexusCommand(options), exec);

  let blast = '';
  if (gitnexusAvailable) {
    const repo = gitnexusRepoId(options);
    try {
      blast = gitnexusOutput(options, ['impact', '--target', symbol], 30, repo);
    } catch {
      blast = gitnexusOutput(options, ['context', symbol], 20, repo, false);
    }
  }

  const graphAvailable = haveGraph(options);
  let neighbours = '';
  if (graphAvailable) {
    const graph = readGraphForEdges(options);
    neighbours = edgesTouching(graph, [symbol])
      .map((e) => `  - ${e.conf} ${e.rel}: ${e.src} → ${e.tgt}  [${e.src_file}]`)
      .slice(0, 20)
      .join('\n');
  }

  return [
    `# code-intel: impact  (${symbol})`,
    '',
    '## Blast radius — GitNexus (RISK INPUT; JS only)',
    gitnexusAvailable ? blast : '  (gitnexus not available)',
    '',
    '## Semantic neighbours — Graphify (all langs + docs)',
    graphAvailable ? neighbours : '  (no standing graph)',
    '',
  ].join('\n');
}

/** query: execution flows (GitNexus) + semantic hits (Graphify). */
export function query(question: string, options: CodeIntelOptions = {}): string {
  const exec = options.exec ?? defaultExec();
  const gitnexusAvailable = commandAvailable(gitnexusCommand(options), exec);

  let flows = '';
  if (gitnexusAvailable) {
    const repo = gitnexusRepoId(options);
    flows = gitnexusOutput(options, ['query', question], 25, repo);
  }

  const graphAvailable = haveGraph(options);
  let semantic = '';
  if (graphAvailable) {
    const command = graphifyCommand(options);
    const root = repoRoot(options);
    semantic = runCommand(exec, command, ['query', question], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
      .split('\n')
      .slice(0, 25)
      .join('\n')
      .replace(/\n$/, '');
  }

  return [
    `# code-intel: query  (${question})`,
    '',
    '## Execution flows — GitNexus',
    gitnexusAvailable ? flows : '  (gitnexus not available)',
    '',
    '## Semantic — Graphify',
    graphAvailable ? semantic : '  (no standing graph)',
    '',
  ].join('\n');
}

/** drift: docs-vs-code design→implementation edges to confirm. */
export function drift(options: CodeIntelOptions = {}): string {
  const header = '# code-intel: docs-vs-code drift  (Graphify design→implementation edges)';
  const stdout = options.stdout ?? ((output: string) => process.stdout.write(output));
  if (!haveGraph(options)) {
    stdout(`${header}\n\n`);
    die('no standing graph — run: graphify-repo.sh build');
  }

  let graph: Graph;
  try {
    graph = readGraph(options);
  } catch (error) {
    stdout(`${header}\n\n`);
    throw error;
  }

  const nf = nodeInfoMap(graph);
  const edges = graph.links ?? graph.edges ?? [];
  const designImpl = edges
    .filter((e) => e.confidence === 'EXTRACTED')
    .map((e) => {
      const sf = nf[e.source]?.f ?? '';
      const tf = nf[e.target]?.f ?? '';
      const docFile = sf.startsWith('docs/') ? sf : tf.startsWith('docs/') ? tf : '';
      const codeFile =
        sf.startsWith('docs/') ? tf : tf.startsWith('docs/') ? sf : '';
      return {
        doc: docFile,
        code: codeFile,
        rel: e.relation,
        sf,
        tf,
      };
    })
    .filter(
      (e) =>
        e.doc &&
        e.code &&
        ((e.sf.startsWith('docs/') &&
          (e.tf.startsWith('hydra/') || e.tf.startsWith('src/'))) ||
          (e.tf.startsWith('docs/') &&
            (e.sf.startsWith('hydra/') || e.sf.startsWith('src/')))),
    );

  const lines = [
    header,
    '',
    `Design→implementation edges to confirm (EXTRACTED, advisory): ${designImpl.length}`,
    ...designImpl.map((e) => `  - ${e.doc}  —${e.rel}→  ${e.code}`),
    '',
    '_These are where a doc explicitly references code. Confirm the code still',
    "matches the doc's claim (source/diff/tests) — Graphify says WHERE to look,",
    'it never independently declares a conflict (code-intelligence.md §3)._',
    '',
  ].join('\n');

  return lines;
}

/** CLI-style dispatcher. Returns the rendered report. */
export function codeIntel(args: string[], options: CodeIntelOptions = {}): string {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'changed': {
      let base = 'main';
      if (rest[0] === '--base') base = rest[1] ?? 'main';
      return changed(base, options);
    }
    case 'impact': {
      const symbol = rest[0];
      if (!symbol) die('usage: code-intel impact <symbol>');
      return impact(symbol, options);
    }
    case 'query': {
      const question = rest[0];
      if (!question) die('usage: code-intel query "<q>"');
      return query(question, options);
    }
    case 'drift':
      return drift(options);
    default:
      die('usage: code-intel changed [--base <ref>] | impact <symbol> | query "<q>" | drift');
  }
}

// Backwards-compatible default export for consumers that import the module.
export default {
  codeIntel,
  changed,
  impact,
  query,
  drift,
  stripAnsi,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const output = codeIntel(args);
    process.stdout.write(`${output}\n`);
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
