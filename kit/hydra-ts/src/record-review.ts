import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCompiledBinary, kitAssetText } from './kit-assets.ts';
import { die, ledgerAppend, log, repoRoot, runDir, warn } from './lib.ts';
import { assertGitObjectId, publishVerdict } from './review-store.ts';

// ---------------------------------------------------------------------------
// Record a branch-review verdict.
// ---------------------------------------------------------------------------

export interface RecordReviewOptions {
  /** Override the Hydra external state root. */
  stateRoot?: string;
  /** Override the path to review.schema.json. */
  schemaPath?: string;
}

export class RecordReviewError extends Error {
  readonly exitCode = 5;
}

/**
 * Trust-boundary schema content. The `schemaPath` option (tests) reads from
 * disk and wins; the default goes through kit-assets — embedded in the
 * compiled binary, checkout file in the source lane (spike §9 verdict #6).
 */
function defaultSchemaText(): string {
  return kitAssetText('schemas/review.schema.json');
}

interface SchemaNode {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  enum?: unknown[];
  items?: SchemaNode;
  minItems?: number;
  const?: unknown;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function validate(node: unknown, sch: SchemaNode | null | undefined, path: string, errors: string[]): void {
  if (sch == null || typeof sch !== 'object') return;

  if (sch.type) {
    const actual = typeOf(node);
    const expected = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!expected.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected type ${expected.join('|')}, got ${actual}`);
      return;
    }
  }

  if (sch.const !== undefined && JSON.stringify(node) !== JSON.stringify(sch.const)) {
    errors.push(`${path}: must equal const ${JSON.stringify(sch.const)}`);
  }

  if (sch.enum && !sch.enum.some((e) => JSON.stringify(e) === JSON.stringify(node))) {
    errors.push(`${path}: value ${JSON.stringify(node)} not in enum ${JSON.stringify(sch.enum)}`);
  }

  if (typeOf(node) === 'object') {
    const obj = node as Record<string, unknown>;
    for (const req of sch.required || []) {
      if (!(req in obj)) errors.push(`${path}: missing required property '${req}'`);
    }
    for (const [key, val] of Object.entries(obj)) {
      const childPath = `${path}/${key}`;
      if (sch.properties && key in sch.properties) {
        validate(val, sch.properties[key], childPath, errors);
      } else if (sch.additionalProperties === false) {
        errors.push(`${childPath}: additional property not allowed`);
      } else if (sch.additionalProperties && typeof sch.additionalProperties === 'object') {
        validate(val, sch.additionalProperties as SchemaNode, childPath, errors);
      }
    }
  }

  if (typeOf(node) === 'array') {
    const arr = node as unknown[];
    if (typeof sch.minItems === 'number' && arr.length < sch.minItems) {
      errors.push(`${path}: array shorter than minItems ${sch.minItems}`);
    }
    if (sch.items) {
      arr.forEach((el, i) => validate(el, sch.items, `${path}/${i}`, errors));
    }
  }
}

function parseVerdict(verdictPath: string, verdictBytes: Buffer): { instance: unknown; errors: string[] } {
  try {
    return { instance: JSON.parse(verdictBytes.toString('utf8')), errors: [] };
  } catch (e) {
    return { instance: undefined, errors: [`${verdictPath}: invalid JSON: ${(e as Error).message}`] };
  }
}

function withStateRoot<T>(stateRootOverride: string | undefined, fn: () => T): T {
  if (!stateRootOverride) return fn();
  const original = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = stateRootOverride;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HYDRA_STATE_ROOT;
    else process.env.HYDRA_STATE_ROOT = original;
  }
}

function rejectReview(runId: string, taskId: string, reason: string, message: string, detail: string): never {
  ledgerAppend(
    runId,
    'review_rejected',
    'task_id',
    taskId,
    'reason',
    reason,
    'detail',
    detail,
  );
  warn(message);
  throw new RecordReviewError(message);
}

function rejectSchemaInvalid(runId: string, taskId: string, errors: string[]): never {
  const detail = errors.slice(0, 2).join(';');
  const message = `review verdict rejected (schema): ${errors.join('; ')}`;
  return rejectReview(runId, taskId, 'schema_invalid', message, detail);
}

function rejectTaskIdMismatch(runId: string, taskId: string, bodyTaskId: string): never {
  const detail = `verdict body task_id '${bodyTaskId}' does not match target task '${taskId}'`;
  const message = `review verdict rejected (task_id_mismatch): ${detail}`;
  return rejectReview(runId, taskId, 'task_id_mismatch', message, detail);
}

function rejectInvalidReviewedHead(runId: string, taskId: string, detail: string): never {
  const message = `review verdict rejected (reviewed_head): ${detail}`;
  return rejectReview(runId, taskId, 'invalid_reviewed_head', message, detail);
}

/**
 * Validate a reviewer verdict against review.schema.json and record it into
 * authoritative state.
 *
 * Mirrors hydra/scripts/record-review.sh: validates the supplied verdict file,
 * copies it into the run's authoritative reviews tree, emits a review_verdict
 * ledger event, and returns (and prints) the recorded path. If validation
 * fails, a review_rejected event is appended and a RecordReviewError with
 * exitCode 5 is thrown.
 *
 * @param runId - required run identifier
 * @param taskId - required task identifier
 * @param verdictPath - path to the verdict JSON file
 * @param options - optional overrides for testing
 * @returns absolute path to the recorded review file
 */
export function recordReview(
  runId: string,
  taskId: string,
  verdictPath: string,
  options: RecordReviewOptions = {},
): string {
  if (!runId || !taskId || !verdictPath) {
    die('usage: recordReview(runId, taskId, verdictPath)');
  }

  if (!existsSync(verdictPath)) {
    die(`verdict file not found: ${verdictPath}`);
  }

  return withStateRoot(options.stateRoot, () => {
    let schema: SchemaNode;
    try {
      schema = options.schemaPath !== undefined
        ? JSON.parse(readFileSync(options.schemaPath, 'utf8')) as SchemaNode
        : JSON.parse(defaultSchemaText()) as SchemaNode;
    } catch (e) {
      rejectSchemaInvalid(runId, taskId, [`cannot read/parse schema: ${(e as Error).message}`]);
    }

    const verdictBytes = readFileSync(verdictPath);
    const { instance, errors: parseErrors } = parseVerdict(verdictPath, verdictBytes);
    if (parseErrors.length) {
      rejectSchemaInvalid(runId, taskId, parseErrors);
    }

    const errors: string[] = [];
    validate(instance, schema, '$', errors);
    if (errors.length) {
      rejectSchemaInvalid(runId, taskId, errors);
    }

    const verdictObj = instance as Record<string, unknown>;
    const bodyTaskId = String(verdictObj.task_id ?? '');
    if (bodyTaskId !== taskId) {
      rejectTaskIdMismatch(runId, taskId, bodyTaskId);
    }

    const reviewedHead = String(verdictObj.reviewed_head ?? '');
    try {
      assertGitObjectId(reviewedHead, 'reviewed_head');
    } catch (e) {
      rejectInvalidReviewedHead(runId, taskId, (e as Error).message);
    }

    const published = publishVerdict(runDir(runId), taskId, verdictBytes, reviewedHead);

    const v = String(verdictObj.verdict ?? '');
    const reviewer = String(verdictObj.reviewer ?? 'unknown');
    const risk = String(verdictObj.risk ?? 'unknown');

    ledgerAppend(
      runId,
      'review_verdict',
      'task_id',
      taskId,
      'verdict',
      v,
      'reviewer',
      reviewer,
      'risk',
      risk,
      'reviewed_head',
      reviewedHead,
      'seq',
      String(published.seq),
      'content_sha256',
      published.sha256,
    );

    log(`review recorded [${taskId}]: ${v} (reviewer=${reviewer} risk=${risk})`);
    process.stdout.write(`${published.path}\n`);
    return published.path;
  });
}

export default {
  recordReview,
  RecordReviewError,
};

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, taskId, verdictPath] = args;
    if (!runId || !taskId || !verdictPath) {
      die('usage: record-review.sh <run_id> <task_id> <verdict.json>');
    }
    recordReview(runId, taskId, verdictPath);
    return 0;
  } catch (error) {
    if (error instanceof RecordReviewError) return error.exitCode;
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
