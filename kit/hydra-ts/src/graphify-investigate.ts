import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  die,
  graphifyDir,
  ledgerAppend,
  log,
  runDir,
  warn,
  yamlScalar,
} from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';

// ---------------------------------------------------------------------------
// Graphify investigation — TypeScript port of hydra/scripts/graphify-investigate.sh.
//
// Maps Graphify edges touching a candidate diff into EXTRACTED investigations /
// INFERRED questions.  Advisory only — never a verdict (code-intelligence §3).
// ---------------------------------------------------------------------------

/** Testable exec injection; mirrors the shape of child_process.execFileSync. */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { encoding?: string; cwd?: string; stdio?: any },
) => string | Buffer;

export interface GraphifyInvestigateOptions {
  /** Optional working directory passed to the command executor. */
  cwd?: string;
  /** Override for the state-root lookup in lib.ts. */
  stateRoot?: string;
  /** Injected exec implementation for tests. */
  exec?: ExecLike;
}

export class GraphifyInvestigateError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface GraphEdge {
  source?: unknown;
  target?: unknown;
  relation?: unknown;
  confidence?: unknown;
  confidence_score?: unknown;
  source_file?: unknown;
}

export interface GraphNode {
  id?: unknown;
  source_file?: unknown;
}

export interface GraphDocument {
  nodes?: unknown;
  links?: unknown;
  edges?: unknown;
}

/** Resolve the task-id / changed-files label for the report path. */
function reportPath(runId: string, taskId: string, filesMode: boolean): string {
  const filename = filesMode
    ? 'graphify-doc-conflict.md'
    : `${taskId}.graphify.md`;
  return join(runDir(runId), 'authoritative', 'graph', filename);
}

/**
 * Read the Graphify document. Both jq filters in the shell source fall back to
 * an empty array when parsing fails, so malformed JSON is represented as null.
 */
function readGraph(graphPath: string): GraphDocument | null {
  try {
    const data = JSON.parse(readFileSync(graphPath, 'utf8')) as unknown;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return null;
    }
    return data as GraphDocument;
  } catch {
    return null;
  }
}

/** Extract the basename from a path string, matching the jq suffix rule. */
function basenameOnly(path: string): string {
  if (!path) return '';
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** jq's `value // ""` selects the empty string for null and false. */
function valueOrEmpty(value: unknown): unknown {
  return value === null || value === undefined || value === false
    ? ''
    : value;
}

/** Build a map from node id to its source_file, or null on a jq-equivalent error. */
function buildNodeFileMap(graph: GraphDocument): Record<string, unknown> | null {
  if (!Array.isArray(graph.nodes)) return null;
  const map: Record<string, unknown> = {};
  for (const value of graph.nodes) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const node = value as GraphNode;
    if (typeof node.id !== 'string') return null;
    map[node.id] = valueOrEmpty(node.source_file);
  }
  return map;
}

/** Resolve `.links // .edges // []`, including jq's false-as-absent rule. */
function edgeValues(graph: GraphDocument): GraphEdge[] | null {
  const links = graph.links === null || graph.links === undefined || graph.links === false
    ? undefined
    : graph.links;
  const edges = graph.edges === null || graph.edges === undefined || graph.edges === false
    ? undefined
    : graph.edges;
  const selected = links ?? edges ?? [];
  const values = Array.isArray(selected)
    ? selected
    : typeof selected === 'object' && selected !== null
      ? Object.values(selected)
      : null;
  if (!values) return null;
  if (values.some((value) => typeof value !== 'object' || value === null || Array.isArray(value))) {
    return null;
  }
  return values as GraphEdge[];
}

/**
 * Filter edges whose source_file or endpoint-node source_files relate to a
 * changed file.  Matching is by basename only, robust to Graphify's path-prefix
 * normalization.
 */
function filterEdges(
  graph: GraphDocument | null,
  changed: string[],
  confidences: string[],
): GraphEdge[] {
  if (!graph) return [];
  const nodeFiles = buildNodeFileMap(graph);
  const edges = edgeValues(graph);
  if (!nodeFiles || !edges) return [];
  const changedSet = new Set(changed.map(basenameOnly).filter((f) => f.length > 0));
  const result: GraphEdge[] = [];

  for (const edge of edges) {
    if (typeof edge.confidence !== 'string' || !confidences.includes(edge.confidence)) continue;

    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      return [];
    }
    const fileValues = [
      valueOrEmpty(edge.source_file),
      valueOrEmpty(nodeFiles[edge.source]),
      valueOrEmpty(nodeFiles[edge.target]),
    ];
    if (fileValues.some((value) => typeof value !== 'string')) return [];

    const files = (fileValues as string[]).map(basenameOnly);

    const touchesChanged = files.some(
      (f) => f.length > 0 && changedSet.has(f),
    );
    if (touchesChanged) {
      result.push(edge);
    }
  }

  return result;
}

/** Fetch changed files from git diff in the candidate worktree. */
function gitChangedFiles(
  worktree: string,
  base: string,
  exec: ExecLike,
  cwd?: string,
): string[] {
  let output = '';
  try {
    output = String(
      exec('git', ['-C', worktree, 'diff', '--name-only', `${base}...HEAD`], {
        encoding: 'utf8',
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
    );
  } catch {
    output = '';
  }
  return output
    .split('\n')
    .filter(Boolean);
}

/** Render a value as jq string interpolation does. */
function jqInterpolation(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Render the advisory markdown report. */
function renderReport(
  taskId: string,
  investigations: GraphEdge[],
  questions: GraphEdge[],
): string {
  const lines: string[] = [
    `# Graphify investigation (${taskId}) — NOT a verdict (code-intelligence §3)`,
    '',
    '_EXTRACTED edges open a blocking INVESTIGATION (integration pauses pending a',
    'check). INFERRED/AMBIGUOUS edges are review QUESTIONS only. A real blocking',
    'verdict requires confirmation from source, diff, tests, or behavior — the',
    'graph says only WHERE to look. Graph evidence never blocks or approves on its own._',
    '',
    `## Blocking investigations (EXTRACTED, require confirmation) — ${investigations.length}`,
  ];

  for (const edge of investigations) {
    lines.push(
      `- **${jqInterpolation(edge.relation)}**: ${jqInterpolation(edge.source)} → ${jqInterpolation(edge.target)}  _(${jqInterpolation(edge.source_file)}, score ${jqInterpolation(edge.confidence_score)})_ — confirm against source/diff/tests before it can block.`,
    );
  }

  lines.push('');
  lines.push(
    `## Review questions (INFERRED/AMBIGUOUS, never blocking) — ${questions.length}`,
  );

  for (const edge of questions) {
    lines.push(
      `- ${jqInterpolation(edge.relation)}: ${jqInterpolation(edge.source)} → ${jqInterpolation(edge.target)}  _(score ${jqInterpolation(edge.confidence_score)})_ — worth a look; not a gate.`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function withStateRoot<T>(override: string | undefined, fn: () => T): T {
  if (!override) return fn();
  const previous = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = override;
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
 * Investigate Graphify edges touching a candidate diff.
 *
 * @param runId - The run identifier.
 * @param taskOrFiles - Either a task_id string, or an object describing an
 *   explicit file list (doc-conflict / design-intent scan).
 * @param options - Optional overrides for testability.
 * @returns Path to the generated report.
 * @throws {GraphifyInvestigateError} with exitCode 8 when no Graphify baseline exists.
 * @throws {Error} for usage errors or missing task specs.
 */
export function graphifyInvestigate(
  runId: string,
  taskOrFiles: string | { files: string[] },
  options: GraphifyInvestigateOptions = {},
): string {
  if (!runId) {
    throw new Error('usage: graphifyInvestigate <run_id> <task_id> | <run_id> { files: [...] }');
  }

  return withStateRoot(options.stateRoot, () => graphifyInvestigateAtRoot(
    runId,
    taskOrFiles,
    options,
  ));
}

function graphifyInvestigateAtRoot(
  runId: string,
  taskOrFiles: string | { files: string[] },
  options: GraphifyInvestigateOptions,
): string {
  const exec = options.exec ?? execFileSync;
  const rDir = runDir(runId);
  const graphPath = join(graphifyDir(runId), 'graph.json');

  if (!existsSync(graphPath)) {
    ledgerAppend(
      runId,
      'graphify_investigation',
      'status',
      'no_baseline',
      'advisory',
      'true',
    );
    warn(`no Graphify baseline for run ${runId} — omitted (never a blocker)`);
    throw new GraphifyInvestigateError('no Graphify baseline', 8);
  }

  const filesMode = typeof taskOrFiles === 'object' && taskOrFiles !== null;
  const taskId = filesMode ? 'doc-conflict' : taskOrFiles;
  if (!taskId) {
    die('task_id required');
  }

  let changed: string[];
  if (filesMode) {
    changed = taskOrFiles.files;
  } else {
    const taskSpec = join(rDir, 'tasks', `${taskId}.yaml`);
    if (!existsSync(taskSpec)) {
      die(`task spec not found: ${taskSpec}`);
    }
    const worktree = yamlScalar(taskSpec, 'worktree');
    const base = yamlScalar(taskSpec, 'base_commit');
    changed = gitChangedFiles(worktree, base, exec, options.cwd);
  }

  const report = reportPath(runId, taskId, filesMode);
  mkdirSync(dirname(report), { recursive: true });

  if (changed.length === 0) {
    warn('no changed files to investigate');
  }

  const graph = readGraph(graphPath);

  const investigations = filterEdges(graph, changed, ['EXTRACTED']);
  const questions = filterEdges(graph, changed, ['INFERRED', 'AMBIGUOUS']);

  writeFileSync(report, renderReport(taskId, investigations, questions), 'utf8');

  ledgerAppend(
    runId,
    'graphify_investigation',
    'task_id',
    taskId,
    'advisory',
    'true',
    'investigations',
    String(investigations.length),
    'questions',
    String(questions.length),
    'requires_confirmation',
    'true',
  );

  log(
    `graphify investigation (${taskId}): ${investigations.length} EXTRACTED investigations, ${questions.length} INFERRED questions (advisory)`,
  );

  return report;
}

// Backwards-compatible default export for consumers that import the module.
export default {
  graphifyInvestigate,
  GraphifyInvestigateError,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, taskOrFlag] = args;
    if (!runId) {
      die('usage: graphify-investigate.sh <run_id> <task_id> | <run_id> --files <f>...');
    }
    const taskOrFiles = taskOrFlag === '--files'
      ? { files: args.slice(2) }
      : taskOrFlag;
    if (!taskOrFiles) die('task_id required');
    process.stdout.write(`${graphifyInvestigate(runId, taskOrFiles)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof GraphifyInvestigateError) return error.exitCode;
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
