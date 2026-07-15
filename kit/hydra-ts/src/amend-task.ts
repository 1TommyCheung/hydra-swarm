import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dispatch } from './dispatch.ts';
import { die, ledgerAppend, log, runDir, YAML_BLOCK_HEADER, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Task-spec amendment (TypeScript port of the historical shell harness).
//
// The lead first edits the instantiated task spec's substantive fields, then
// calls amendTask() to bump the version, stamp amendment metadata, record a
// task_spec_amended ledger event, and re-dispatch.
// ---------------------------------------------------------------------------

export interface AmendTaskOptions {
  /** Optional override for the re-dispatch step. Defaults to native TS dispatch. */
  dispatch?: (runId: string, taskId: string, delivery: string) => void | Promise<void>;
}

function parseBashInteger(value: string): bigint | undefined {
  const match = value.trim().match(/^([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/);
  if (!match) return undefined;

  const sign = match[1] === '-' ? -1n : 1n;
  const literal = match[2];
  let parsed: bigint;
  if (/^0[xX]/.test(literal)) {
    parsed = BigInt(literal);
  } else if (/^0[0-7]+$/.test(literal)) {
    parsed = BigInt(`0o${literal.slice(1)}`);
  } else {
    parsed = BigInt(literal);
  }
  return sign * parsed;
}

// awk processes command-line `-v name=value` escape sequences before the
// program sees them. Keep that observable behaviour for the YAML metadata;
// ledger values continue to use the original arguments, as the shell does.
function awkAssignmentValue(value: string): string {
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
  };

  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '\\' || i + 1 >= value.length) {
      result += value[i];
      continue;
    }

    const next = value[++i];
    if (next in escapes) {
      result += escapes[next];
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && i + 1 < value.length && /[0-7]/.test(value[i + 1])) {
        octal += value[++i];
      }
      result += String.fromCharCode(Number.parseInt(octal, 8));
      continue;
    }

    // The system awk used by the Bash implementation discards the backslash
    // on an unrecognised escape (and may emit a warning).
    result += next;
  }
  return result;
}

function replaceFileAtomically(path: string, content: string): void {
  const tempDir = mkdtempSync(join(dirname(path), '.amend-task-'));
  const tempPath = join(tempDir, 'task.yaml');
  try {
    // mktemp creates a mode-0600 file in the Bash implementation.
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function defaultDispatch(runId: string, taskId: string, delivery: string): Promise<void> {
  await dispatch(runId, taskId, {
    env: { ...process.env, HYDRA_DELIVERY: delivery },
  });
}

// Render a `key: value` YAML pair, promoting to a literal block scalar
// (`key: |` + indented lines) whenever the value contains a newline. A plain
// scalar cannot span multiple lines, so writing a multi-line reason directly
// after `key: ` would corrupt the file structurally -- everything past the
// first line would land as bare, unindented top-level text instead of part
// of the value.
function yamlKeyValue(key: string, value: string): string {
  if (!value.includes('\n')) {
    return `${key}: ${value}`;
  }
  const indented = value.split('\n').map((line) => (line ? `  ${line}` : ''));
  // An IMPLICIT (bare `|`) indentation indicator makes a real YAML parser
  // auto-detect the base indent from the first content line -- but this
  // writer always adds exactly 2 spaces regardless of what leading
  // whitespace that line's own content already had. If the value's first
  // line happens to be more indented than a later "root level" line within
  // the same value (e.g. "  first\nsecond"), auto-detection picks up that
  // larger indent, and the less-indented later line is then invalid YAML
  // under a strict parser -- silently corrupted content under this file's
  // own lenient readers. Declaring the indent explicitly (`|2`, matching
  // the constant 2 spaces this writer always adds) removes the ambiguity
  // entirely: every emitted line is unambiguously 2 spaces deep, regardless
  // of the original value's own per-line indentation.
  return [`${key}: |2`, ...indented].join('\n');
}

/**
 * Rewrite a task-spec YAML body: bump spec_version, drop any prior amendment
 * metadata, and append fresh supersedes / amendment_reason / delivered_via keys.
 */
export function rewriteTaskSpec(
  content: string,
  fromV: string | number,
  toV: string | number,
  reason: string,
  delivery: string,
): string {
  let lines = content.split('\n');
  // Drop the trailing empty segment produced by a terminal newline, matching
  // awk's line-at-a-time behaviour.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }

  const out: string[] = [];
  const dropKeys = /^(supersedes|amendment_reason|delivered_via):/;
  // A dropped key's value may be a literal block scalar (`key: |` followed by
  // indented continuation lines, as yamlKeyValue emits for a multi-line
  // reason) rather than a plain single-line value. When re-amending an
  // already-amended spec, those continuation lines must be dropped along with
  // the header -- otherwise they survive as stray, unindented top-level text.
  let skippingBlock = false;
  for (const line of lines) {
    if (skippingBlock) {
      if (line === '' || /^\s/.test(line)) continue;
      skippingBlock = false;
      // Fall through: this dedented line is real content and still needs
      // the normal handling below (it could itself be one of dropKeys).
    }
    if (/^spec_version:/.test(line)) {
      out.push(`spec_version: ${toV}`);
    } else if (dropKeys.test(line)) {
      const header = line.slice(line.indexOf(':') + 1).trim();
      if (header === '' || YAML_BLOCK_HEADER.test(header)) skippingBlock = true;
    } else {
      out.push(line);
    }
  }

  out.push(`supersedes: ${fromV}`);
  out.push(yamlKeyValue('amendment_reason', awkAssignmentValue(reason)));
  out.push(yamlKeyValue('delivered_via', awkAssignmentValue(delivery)));
  return out.join('\n') + '\n';
}

/**
 * Amend a task spec: bump its version, stamp amendment metadata, record a
 * task_spec_amended ledger event, log, and re-dispatch the task.
 *
 * Usage mirrors amend-task.sh:
 *   amendTask(runId, taskId, reason, delivery = 'restart')
 */
export async function amendTask(
  runId: string,
  taskId: string,
  reason: string,
  delivery = 'restart',
  options: AmendTaskOptions = {},
): Promise<string> {
  if (!runId) die('usage: amend-task.ts <run_id> <task_id> <reason> [resume|restart]');
  if (!taskId) die('usage: amend-task.ts <run_id> <task_id> <reason> [resume|restart]');
  if (!reason) die('amendment_reason required');

  const taskSpec = join(runDir(runId), 'tasks', `${taskId}.yaml`);
  if (!existsSync(taskSpec)) {
    die(`task spec not found: ${taskSpec}`);
  }

  const fromVStr = yamlScalar(taskSpec, 'spec_version');
  if (!fromVStr) die('task spec has no spec_version');
  const fromV = parseBashInteger(fromVStr);
  if (fromV === undefined) die('task spec has invalid spec_version');
  const toV = (fromV + 1n).toString();

  // Preflight the recorded worktree BEFORE mutating the authoritative spec.
  // Checking only after the rewrite would leave a broken half-amended state
  // on a missing worktree: spec_version bumped, amendment_reason set, but
  // no refreshed worktree copy, no ledger event, and no redispatch.
  const worktree = yamlScalar(taskSpec, 'worktree');
  if (worktree) {
    // existsSync alone accepts a regular file too -- mkdtempSync() would
    // then throw ENOTDIR later, AFTER the authoritative spec is already
    // rewritten, recreating the exact half-amended state this preflight
    // exists to prevent. Require an actual directory.
    let isDir = false;
    try {
      isDir = statSync(worktree).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      die(`amend-task: worktree not found, cannot refresh its task spec copy: ${worktree}`);
    }
  }

  const content = readFileSync(taskSpec, 'utf8');
  const rewritten = rewriteTaskSpec(content, fromVStr, toV, reason, delivery);
  replaceFileAtomically(taskSpec, rewritten);

  // The worktree's own .hydra-task.yaml (written once by create-worktree.ts,
  // read-only, and the ONLY task spec the sandboxed vendor CLI ever sees --
  // it has no access to the authoritative state root) must be refreshed to
  // match, or a resumed/restarted worker silently keeps reading the PRE-
  // amendment spec: no error, no crash, just the old objective and no
  // amendment_reason at all, indistinguishable from "nothing was amended."
  // This was found live: two consecutive redispatches reported false
  // completion because the worker never saw the amendment.
  //
  // Written via the same temp-file-then-atomic-rename pattern as
  // replaceFileAtomically, with the mode set AT CREATION rather than via a
  // separate chmod step -- a chmod-writable/copy/chmod-readonly sequence
  // leaves the destination genuinely writable for the whole window between
  // the two chmods, and if the copy throws in between, it never gets
  // re-locked: a real trust-boundary violation (workers must not be able
  // to self-amend their own instructions), not just a missed refresh.
  if (worktree) {
    const worktreeSpec = join(worktree, '.hydra-task.yaml');
    const tempDir = mkdtempSync(join(worktree, '.hydra-task-'));
    const tempPath = join(tempDir, 'task.yaml');
    try {
      writeFileSync(tempPath, rewritten, { encoding: 'utf8', mode: 0o444 });
      renameSync(tempPath, worktreeSpec);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  ledgerAppend(
    runId,
    'task_spec_amended',
    'task_id', taskId,
    'from', `v${fromVStr}`,
    'to', `v${toV}`,
    'delivery', delivery,
    'reason', reason,
  );
  log(`amended ${taskId} v${fromVStr} -> v${toV} (${delivery}): ${reason}`);

  const dispatch = options.dispatch ?? defaultDispatch;
  await dispatch(runId, taskId, delivery);

  return taskSpec;
}

// Backwards-compatible default export for consumers that import the module.
export default { amendTask, rewriteTaskSpec };

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const [runId, taskId, reason, delivery = 'restart'] = args;
    if (!runId || !taskId) {
      die('usage: amend-task.sh <run_id> <task_id> <reason> [resume|restart]');
    }
    if (!reason) die('amendment_reason required');
    await amendTask(runId, taskId, reason, delivery);
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
  process.exitCode = await main();
}
