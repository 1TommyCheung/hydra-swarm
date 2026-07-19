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
    die(`not inside a git repository (cwd: ${process.cwd()}) — hydra resolves its state dir from the repo root; cd into the target repo (or one of its worktrees) and re-run`);
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

// Minimal unescape for the double-quoted YAML scalars these hand-rolled
// readers accept: only `\"` and `\\` are produced by the quoting the harness
// templates use, and both must collapse before the value is executed or
// compared.
export function unescapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

// Parse an inline scalar that may be double-quoted and/or followed by a
// trailing `# comment`. A quoted scalar can itself contain a literal `#`
// (e.g. a shell command's own comment marker); stripping `\s+#.*$` before
// checking for quotes truncates the value at that inner `#` and never
// reaches the closing quote. Detect and extract the quoted body FIRST, so
// comment-stripping only ever applies to unquoted material.
function parseInlineScalar(raw: string): { value: string; wasQuoted: boolean } {
  const quoted = raw.trim().match(/^"((?:\\.|[^"\\])*)"/);
  if (quoted) {
    return { value: unescapeYamlDoubleQuoted(quoted[1]), wasQuoted: true };
  }
  const stripped = raw.replace(/\s+#.*$/, '');
  return { value: stripped.replace(/^"|"$/g, ''), wasQuoted: false };
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
        // Quoted-body extraction, unescaping, and comment-stripping all live
        // in parseInlineScalar so a list item behaves exactly like an inline
        // scalar. A hand-rolled /^".*"$/ test here mismatched the quote strip
        // on the untrimmed value: a quoted item followed by a trailing
        // comment or whitespace ("- \"cmd\" # note", "- \"cmd\"  ") kept its
        // closing quote and the comment, reaching bash as an unterminated
        // quote.
        items.push(parseInlineScalar(match[1]).value);
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
        return parseInlineScalar(rest).value.trim();
      }
      grab = true;
      // An explicit indentation digit (`|2`, `>1-`, etc.) fixes the base
      // indent from the header itself rather than leaving it to be inferred
      // from the first content line below -- honor it if present, so a
      // first line indented deeper than the declared digit doesn't corrupt
      // every later line's slice point.
      const digitMatch = rest.match(/[1-9]/);
      baseIndent = digitMatch ? Number(digitMatch[0]) : null;
      continue;
    }
    if (grab) {
      if (/^\S/.test(line)) break;
      // Strip only the block's own base indentation (the header's explicit
      // digit if it declared one, otherwise inferred from the first
      // non-blank continuation line), not all leading whitespace -- content
      // indented further than the base (nested lists, code) must survive.
      // A line consisting ENTIRELY of whitespace is blank in YAML terms
      // (its own indentation is meaningless), not the first content line --
      // /\S/ finds a real character, not just a non-zero-length string.
      if (/\S/.test(line) && baseIndent === null) {
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
      const raw = line.slice(match[0].length);
      const { value: parsed, wasQuoted } = parseInlineScalar(raw);
      const value = parsed.replace(/\s+$/, '');
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

/**
 * Per-run herdr workspace pinning (issue #19): a herdr pane must stay pinned
 * to the workspace the run started in, not follow whatever tab/Space the
 * operator's terminal focus happens to be on at the moment a later pane is
 * spawned. The lead's workspace id is captured on the first successful
 * focusedWorkspace() query in a run and persisted into that run's run.yaml;
 * subsequent pane spawns read the persisted value rather than re-querying the
 * live focus. HYDRA_HERDR_WORKSPACE_PIN=0 disables the pin and restores the
 * legacy always-live-query behavior.
 *
 * Persistence is best effort: a missing/corrupt run.yaml, or a run.yaml
 * without the field yet, must fall back to a live query and never throw.
 */
export const HERDR_WORKSPACE_PIN_DISABLED = '0';

export function herdrWorkspacePinEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.HYDRA_HERDR_WORKSPACE_PIN !== HERDR_WORKSPACE_PIN_DISABLED;
}

export function pinnedHerdrWorkspace(runYamlPath: string): string | undefined {
  try {
    const value = yamlScalar(runYamlPath, 'herdr_workspace');
    return value === '' ? undefined : value;
  } catch {
    // Missing run.yaml or read failure: not pinned.
    return undefined;
  }
}

/**
 * A plain check-then-write on run.yaml is not atomic across processes: two
 * concurrent dispatches could both observe "no pin yet" and the second
 * writer would still land, clobbering the first-captured workspace. A single
 * filesystem primitive IS atomic across processes though: exclusive file
 * creation (O_CREAT | O_EXCL, Node's 'wx' flag) fails with EEXIST if the
 * file already exists. Use a dedicated lock file next to run.yaml as a
 * one-shot "first past the post" latch: whichever process creates it wins
 * the right to write the pin; every later racer's create attempt fails and
 * that racer must not write, only read back the winner's value. The lock
 * file is intentionally never deleted — its continued existence for the
 * life of the run IS the "already captured" signal, not a re-entrant lock.
 */
function herdrWorkspaceLockPath(runYamlPath: string): string {
  return `${runYamlPath}.herdr-workspace.lock`;
}

export function setPinnedHerdrWorkspace(runYamlPath: string, workspace: string): void {
  if (!workspace) return;
  try {
    // Fast path: already pinned, nothing to do.
    if (pinnedHerdrWorkspace(runYamlPath) !== undefined) return;

    try {
      writeFileSync(herdrWorkspaceLockPath(runYamlPath), String(process.pid), { flag: 'wx' });
    } catch {
      // Lock already exists: another process won this race (or is mid-write).
      // Do not write — the winner's value is what subsequent reads must see.
      return;
    }

    // Lock acquired: this process won. Defensively re-check (a previous run's
    // stale lock could in principle coexist with an already-written pin).
    if (pinnedHerdrWorkspace(runYamlPath) !== undefined) return;

    let content = '';
    try {
      content = readFileSync(runYamlPath, 'utf8');
    } catch {
      // Missing run.yaml: write a minimal file with just the pin so the next
      // reader finds it. Real run.yaml fields (run_id/base_commit/...) are
      // created by run-init and won't be clobbered when the file exists.
      writeFileSync(runYamlPath, `herdr_workspace: ${workspace}\n`, 'utf8');
      return;
    }
    if (content === '') {
      writeFileSync(runYamlPath, `herdr_workspace: ${workspace}\n`, 'utf8');
      return;
    }
    const padded = content.endsWith('\n') ? content : `${content}\n`;
    writeFileSync(runYamlPath, `${padded}herdr_workspace: ${workspace}\n`, 'utf8');
  } catch {
    // Pinning must never block a dispatch — callers fall back to a live query.
  }
}

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

// ---------------------------------------------------------------------------
// Live-progress text extraction from vendor NDJSON streams.
// Shared between dispatch.ts and review-dispatch.ts.
// ---------------------------------------------------------------------------

export function codexEventText(line: string): string | undefined {
  let event: {
    type?: string;
    item?: {
      type?: string;
      text?: string;
      command?: string;
      changes?: Array<{ path?: string }>;
      server?: string;
      tool?: string;
    };
  };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return undefined;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return undefined;
  const type = event.type;
  const item = event.item;
  if (!item) return undefined;

  if (type === 'item.completed' && item.type === 'agent_message' && item.text) {
    return item.text;
  }
  if (type === 'item.started' && item.type === 'command_execution' && item.command) {
    const cmd = item.command.split('\n').join(' ').slice(0, 140);
    return `\n[cmd] ${cmd}`;
  }
  if (type === 'item.started' && item.type === 'file_change') {
    const paths = (item.changes ?? [])
      .map((change) => {
        const parts = (change.path ?? '').split('/');
        return parts[parts.length - 1] ?? '';
      })
      .filter((segment) => segment !== '')
      .join(', ');
    return `\n[edit] ${paths}`;
  }
  if (type === 'item.started' && item.type === 'mcp_tool_call') {
    return `\n[tool] ${item.server ?? ''}.${item.tool ?? ''}`;
  }
  return undefined;
}

export function kimiEventText(line: string): string | undefined {
  let event: { role?: string; content?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return undefined;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return undefined;
  if (event.role === 'assistant' && typeof event.content === 'string' && event.content !== '') {
    return event.content;
  }
  return undefined;
}

export interface JsonlTailState {
  offset: number;
}

export function pollJsonlFile(
  eventsPath: string,
  outputPath: string,
  parseEvent: (line: string) => string | undefined,
  state: JsonlTailState,
  final = false,
): void {
  try {
    const contents = readFileSync(eventsPath);
    if (contents.length < state.offset) state.offset = 0;
    const available = contents.subarray(state.offset);
    const lastNewline = available.lastIndexOf(0x0a);
    const consumed = final ? available.length : lastNewline + 1;
    if (consumed > 0) {
      const lines = available.subarray(0, consumed).toString('utf8').split('\n');
      for (const line of lines) {
        if (!line) continue;
        const text = parseEvent(line);
        if (text !== undefined) appendFileSync(outputPath, `${text}\n`, 'utf8');
      }
      state.offset += consumed;
    }
  } catch {
    // The adapter creates capture files lazily; missing/partial files are normal.
  }
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
  herdrWorkspacePinEnabled,
  pinnedHerdrWorkspace,
  setPinnedHerdrWorkspace,
  killTree,
  withTimeout,
  normalizeRelpath,
  pathInGlobs,
  yamlList,
  yamlBlock,
  yamlScalar,
  codexEventText,
  kimiEventText,
  pollJsonlFile,
};
