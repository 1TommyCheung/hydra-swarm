import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { die, ledgerAppend, log, runDir, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Task-spec amendment (TypeScript port of hydra/scripts/amend-task.sh).
//
// The lead first edits the instantiated task spec's substantive fields, then
// calls amendTask() to bump the version, stamp amendment metadata, record a
// task_spec_amended ledger event, and re-dispatch.
// ---------------------------------------------------------------------------

export interface AmendTaskOptions {
  /** Optional override for the re-dispatch step. Defaults to running dispatch.sh. */
  dispatch?: (runId: string, taskId: string, delivery: string) => void;
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

function defaultDispatch(runId: string, taskId: string, delivery: string): void {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const dispatchScript = join(selfDir, '..', '..', 'hydra', 'scripts', 'dispatch.sh');
  execFileSync(dispatchScript, [runId, taskId], {
    env: { ...process.env, HYDRA_DELIVERY: delivery },
    stdio: 'inherit',
  });
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
  for (const line of lines) {
    if (/^spec_version:/.test(line)) {
      out.push(`spec_version: ${toV}`);
    } else if (/^supersedes:/.test(line)) {
      continue;
    } else if (/^amendment_reason:/.test(line)) {
      continue;
    } else if (/^delivered_via:/.test(line)) {
      continue;
    } else {
      out.push(line);
    }
  }

  out.push(`supersedes: ${fromV}`);
  out.push(`amendment_reason: ${awkAssignmentValue(reason)}`);
  out.push(`delivered_via: ${awkAssignmentValue(delivery)}`);
  return out.join('\n') + '\n';
}

/**
 * Amend a task spec: bump its version, stamp amendment metadata, record a
 * task_spec_amended ledger event, log, and re-dispatch the task.
 *
 * Usage mirrors amend-task.sh:
 *   amendTask(runId, taskId, reason, delivery = 'restart')
 */
export function amendTask(
  runId: string,
  taskId: string,
  reason: string,
  delivery = 'restart',
  options: AmendTaskOptions = {},
): string {
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

  const content = readFileSync(taskSpec, 'utf8');
  replaceFileAtomically(
    taskSpec,
    rewriteTaskSpec(content, fromVStr, toV, reason, delivery),
  );

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
  dispatch(runId, taskId, delivery);

  return taskSpec;
}

// Backwards-compatible default export for consumers that import the module.
export default { amendTask, rewriteTaskSpec };

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, taskId, reason, delivery = 'restart'] = args;
    if (!runId || !taskId) {
      die('usage: amend-task.sh <run_id> <task_id> <reason> [resume|restart]');
    }
    if (!reason) die('amendment_reason required');
    amendTask(runId, taskId, reason, delivery);
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
