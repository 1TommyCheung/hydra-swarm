import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Logging helpers.
// ---------------------------------------------------------------------------

export function die(message: string): never {
  throw new Error(`hydra: error: ${message}`);
}

export function warn(message: string): void {
  process.stderr.write(`hydra: warn: ${message}\n`);
}

export function log(message: string): void {
  process.stderr.write(`hydra: ${message}\n`);
}

// ---------------------------------------------------------------------------
// Repository + state locations.
// ---------------------------------------------------------------------------

export function repoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    die('not inside a git repository');
  }
}

export function repoId(): string {
  const override = process.env.HYDRA_REPO_ID;
  if (override) return override;
  return basename(repoRoot());
}

export function stateRoot(): string {
  const override = process.env.HYDRA_STATE_ROOT;
  if (override) return override;
  const base = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? '', '.local/state');
  return join(base, `${repoId()}-hydra`);
}

export function worktreeRoot(): string {
  const override = process.env.HYDRA_WORKTREE_ROOT;
  if (override) return override;
  return join(process.env.HOME ?? '', 'worktrees', repoId());
}

export function indexesRoot(): string {
  return join(stateRoot(), 'indexes');
}

export function gitnexusDir(commit: string): string {
  return join(indexesRoot(), 'gitnexus', repoId(), commit);
}

export function graphifyDir(runId: string): string {
  return join(indexesRoot(), 'graphify', repoId(), `run-${runId}`);
}

export function runDir(runId: string): string {
  return join(stateRoot(), 'runs', `run-${runId}`);
}

export function authDir(runId: string): string {
  return join(runDir(runId), 'authoritative');
}

export function inboxDir(runId: string): string {
  return join(runDir(runId), 'inbox');
}

export function ledger(runId: string): string {
  return join(authDir(runId), 'ledger', 'events.jsonl');
}

// ---------------------------------------------------------------------------
// Time.
// ---------------------------------------------------------------------------

export function now(): string {
  const iso = new Date().toISOString(); // 2024-01-01T00:00:00.000Z
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Ledger.
// ---------------------------------------------------------------------------

export function ledgerAppend(
  runId: string,
  event: string,
  ...kvs: string[]
): void {
  const ledgerPath = ledger(runId);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const entry: Record<string, string> = {
    time: now(),
    event,
    run_id: runId,
  };
  for (let i = 0; i + 1 < kvs.length; i += 2) {
    entry[kvs[i]] = kvs[i + 1];
  }
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Derive a result drop from git evidence.
// ---------------------------------------------------------------------------

export function deriveDropFromGit(
  taskSpec: string,
  worktree: string,
  vendor: string,
  sessionId: string,
  outJson: string,
): boolean {
  const base = yamlScalar(taskSpec, 'base_commit');
  let head: string;
  try {
    head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return false;
  }
  if (!head) return false;

  let baseHead = '';
  try {
    baseHead = execFileSync('git', ['-C', worktree, 'rev-parse', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    baseHead = '';
  }
  if (baseHead === head) return false;

  let files: string[] = [];
  try {
    const diff = execFileSync(
      'git',
      ['-C', worktree, 'diff', '--name-only', `${base}...HEAD`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    files = diff
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    files = [];
  }

  const result = {
    task_id: yamlScalar(taskSpec, 'task_id'),
    run_id: yamlScalar(taskSpec, 'run_id'),
    spec_version: Number(yamlScalar(taskSpec, 'spec_version')),
    vendor,
    session_id: sessionId,
    status: 'completed',
    branch: yamlScalar(taskSpec, 'branch'),
    base_commit: base,
    head_commit: head,
    summary: 'harness-derived from git (worker committed without a self-report)',
    files_changed: files,
    verification_claims: [],
    risks: ['no worker self-report; drop derived from git evidence'],
    unresolved_questions: [],
    suggested_additional_checks: [],
  };
  writeFileSync(outJson, `${JSON.stringify(result)}\n`);
  return true;
}

// ---------------------------------------------------------------------------
// Process control.
// ---------------------------------------------------------------------------

export function killTree(pid: number): void {
  let children: number[] = [];
  try {
    const output = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    children = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    // No children or pgrep failed.
  }

  for (const child of children) {
    killTree(child);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Ignore.
  }

  // Best-effort SIGKILL after a short delay; do not await.
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore.
    }
  }, 2000);
}

export interface TimeoutResult {
  exitCode: number | null;
  signal: string | null;
}

export function withTimeout(
  seconds: number,
  command: string,
  args: string[] = [],
): Promise<TimeoutResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child.pid!);
      resolve({ exitCode: 124, signal: null });
    }, seconds * 1000);

    child.on('exit', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? null, signal: signal ?? null });
    });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, signal: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Path normalization + hygiene.
// ---------------------------------------------------------------------------

export function normalizeRelpath(p: string): string {
  if (p.startsWith('/')) die(`absolute path not allowed: ${p}`);
  if (p === '..' || p.startsWith('../') || p.endsWith('/..') || p.includes('/../')) {
    die(`path traversal not allowed: ${p}`);
  }
  let cleaned = p;
  if (cleaned.startsWith('./')) cleaned = cleaned.slice(2);
  while (cleaned.includes('//')) {
    cleaned = cleaned.replace(/\/\//g, '/');
  }
  return cleaned;
}

export function pathInGlobs(path: string, globs: string[]): boolean {
  for (const g of globs) {
    if (!g) continue;
    let re = g.replace(/\./g, '\\.');
    const sentinel = '\x1f';
    re = re.replace(/\*\*/g, sentinel);
    re = re.replace(/\*/g, '[^/]*');
    re = re.replace(new RegExp(sentinel, 'g'), '.*');
    if (new RegExp(`^(?:${re})$`).test(path)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// YAML-ish accessors.
// ---------------------------------------------------------------------------

function readLines(file: string): string[] {
  const content = readFileSync(file, 'utf8');
  if (content === '') return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

export function yamlList(file: string, key: string): string[] {
  const lines = readLines(file);
  const items: string[] = [];
  let grab = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (new RegExp(`^${key}:[\\s]*$`).test(line)) {
      grab = true;
      continue;
    }
    if (grab) {
      const match = line.match(/^\s*-\s*(.*)$/);
      if (match) {
        let value = match[1];
        value = value.replace(/^"|"$/g, '');
        items.push(value);
        continue;
      }
      if (/^\S/.test(line)) {
        grab = false;
      }
    }
  }
  return items;
}

// Any valid YAML block-scalar header: `|`/`>`, optionally followed by a
// chomping indicator (`-`/`+`) and/or a single explicit indentation digit
// (1-9), in EITHER order -- YAML permits both `|2-` and `|-2`.
//
// Known accepted gap: an explicit indentation digit (`|2`, `>1-`, etc.) is
// recognized as a header but NOT honored -- yamlBlock still infers the base
// indent from the first content line rather than using the declared number,
// so a body whose first line is indented deeper than the declared digit
// reads incorrectly. This harness's own writer (amend-task.ts's
// rewriteTaskSpec) never emits an explicit indentation digit -- it always
// writes a bare `|` and lets the reader infer the base -- so this gap is
// unreachable via any value the harness itself generates; it only matters
// for a hand-authored task spec using that specific YAML feature.
export const YAML_BLOCK_HEADER = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

export function yamlBlock(file: string, key: string): string {
  const lines = readLines(file);
  const collected: string[] = [];
  let grab = false;
  let baseIndent: number | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const headerMatch = line.match(new RegExp(`^${key}:[\\s]*(.*)$`));
    if (headerMatch && !grab) {
      const rest = headerMatch[1].trim();
      if (rest && !YAML_BLOCK_HEADER.test(rest)) {
        // Inline scalar on the header line -- strip a trailing comment and
        // surrounding quotes the same way yamlScalar does, so a single-line
        // value behaves identically regardless of which reader is used.
        return rest.replace(/\s+#.*$/, '').replace(/^"|"$/g, '').trim();
      }
      grab = true;
      continue;
    }
    if (grab) {
      if (/^\S/.test(line)) break;
      // Strip only the block's own base indentation (set by the first
      // non-blank continuation line), not all leading whitespace -- content
      // indented further than the base (nested lists, code) must survive.
      if (line !== '' && baseIndent === null) {
        baseIndent = line.match(/^\s*/)?.[0].length ?? 0;
      }
      const stripped = baseIndent !== null && line.length >= baseIndent
        ? line.slice(baseIndent)
        : line.replace(/^\s+/, '');
      collected.push(stripped.replace(/\s+$/, ''));
    }
  }
  while (collected[0] === '') collected.shift();
  return collected.join('\n');
}

export function yamlScalar(file: string, key: string): string {
  const lines = readLines(file);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const match = line.match(new RegExp(`^${key}:[\\s]*`));
    if (match) {
      let value = line.slice(match[0].length);
      value = value.replace(/\s+#.*$/, '');
      const wasQuoted = /^".*"$/.test(value.trim());
      value = value.replace(/^"|"$/g, '');
      value = value.replace(/\s+$/, '');
      // A bare, UNQUOTED block-scalar header (e.g. from an empty/whitespace-
      // only block body, or a caller that mistakenly used the scalar reader
      // on a block field) is never legitimate plain-scalar content -- treat
      // it as absent rather than returning the literal marker text. A
      // quoted value like `key: "|"` is real content (the string "|") and
      // must NOT be swallowed by this check.
      if (!wasQuoted && YAML_BLOCK_HEADER.test(value)) return '';
      return value;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Herdr integration.
// ---------------------------------------------------------------------------

export function herdrState(
  pane: string,
  vendor: string,
  state: string,
): void {
  if (!pane || !vendor || !state) return;
  const sock = process.env.HERDR_SOCKET_PATH ?? join(process.env.HOME ?? '', '.config/herdr/herdr.sock');
  if (!existsSync(sock)) return;

  const req = {
    id: `herdr:hydra:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0')}`,
    method: 'pane.report_agent',
    params: {
      pane_id: pane,
      source: 'herdr:hydra',
      agent: vendor,
      state,
      seq: Date.now() * 1_000_000 + Math.floor(Math.random() * 1_000_000),
    },
  };

  const client = createConnection(sock);
  client.setTimeout(500);
  client.once('connect', () => {
    client.write(`${JSON.stringify(req)}\n`);
    client.once('data', () => client.end());
    client.once('timeout', () => client.end());
  });
  client.on('error', () => {
    // Best-effort; ignore errors.
  });
}

// Backwards-compatible default export for consumers that import the module.
export default {
  die,
  warn,
  log,
  repoRoot,
  repoId,
  stateRoot,
  worktreeRoot,
  indexesRoot,
  gitnexusDir,
  graphifyDir,
  runDir,
  authDir,
  inboxDir,
  ledger,
  now,
  ledgerAppend,
  deriveDropFromGit,
  herdrState,
  killTree,
  withTimeout,
  normalizeRelpath,
  pathInGlobs,
  yamlList,
  yamlBlock,
  yamlScalar,
};
