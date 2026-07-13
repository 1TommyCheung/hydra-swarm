import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  auditOwnership,
  type AuditOwnershipOptions,
  type AuditOwnershipResult,
} from './audit-ownership.ts';
import {
  ledgerAppend,
  log,
  now,
  repoRoot,
  runDir as libRunDir,
  stateRoot as libStateRoot,
  warn,
  yamlList,
  yamlScalar,
} from './lib.ts';
import { verify, type VerifyOptions, type VerifyResult } from './verify.ts';

function defaultSchemaPath(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return join(selfDir, '..', '..', 'hydra', 'schemas', 'result.schema.json');
}

function defaultVerifyPolicyPath(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return join(selfDir, '..', '..', 'hydra', 'policies', 'verification.yaml');
}

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** Shape of a git/execFileSync call that tests can override. */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { encoding?: string; stdio?: any },
) => string | Buffer;

/** Testable options for promote(), mirroring sibling modules. */
export interface PromoteOptions {
  /** Base directory used to resolve relative paths; defaults to process.cwd(). */
  cwd?: string;
  /** Hydra state root; defaults to HYDRA_STATE_ROOT or lib.ts stateRoot(). */
  stateRoot?: string;
  /** Path to result.schema.json; defaults to the self-relative hydra/schemas/result.schema.json. */
  schema?: string;
  /** Path to verification policy YAML; defaults to HYDRA_VERIFY_POLICY or the self-relative hydra/policies/verification.yaml. */
  verifyPolicy?: string;
  /** Injected exec implementation for git commands. */
  exec?: ExecLike;
  /** Injected ownership audit; defaults to auditOwnership(). */
  audit?: (
    worktree: string,
    base: string,
    head: string,
    writable: string[],
    options?: AuditOwnershipOptions,
  ) => AuditOwnershipResult;
  /** Injected verification; defaults to verify(). */
  verify?: (
    worktree: string,
    policy: string,
    out?: string,
    options?: VerifyOptions,
  ) => Promise<VerifyResult[]>;
}

/** Result returned on successful promotion. */
export interface PromoteResult {
  /** Absolute path to the promoted authoritative result file. */
  promoted: string;
  /** Whether the worker's verification claims diverged from harness observation. */
  divergence: boolean;
}

/** Rejection error carrying the bash exit code 5 and the ledger reason. */
export class PromoteError extends Error {
  readonly code = 5;
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(`REJECTED: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.reason = reason;
  }
}

/** Internal/usage error carrying the bash exit code 2. */
export class PromoteInternalError extends Error {
  readonly code = 2;
}

// ---------------------------------------------------------------------------
// Minimal dependency-free JSON Schema validator.
// Mirrors hydra/scripts/jsonschema.mjs (subset used by result.schema.json).
// ---------------------------------------------------------------------------

type SchemaNode = any;

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

function validateSchema(node: unknown, sch: SchemaNode, path: string, errors: string[]): void {
  if (sch == null || typeof sch !== 'object') return;

  if (sch.type) {
    const actual = typeOf(node);
    const expected = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!expected.some((t: string) => typeMatches(t, actual))) {
      errors.push(`${path}: expected type ${expected.join('|')}, got ${actual}`);
      return;
    }
  }

  if (sch.const !== undefined && JSON.stringify(node) !== JSON.stringify(sch.const)) {
    errors.push(`${path}: must equal const ${JSON.stringify(sch.const)}`);
  }

  if (sch.enum && !sch.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(node))) {
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
        validateSchema(val, sch.properties[key], childPath, errors);
      } else if (sch.additionalProperties === false) {
        errors.push(`${childPath}: additional property not allowed`);
      } else if (sch.additionalProperties && typeof sch.additionalProperties === 'object') {
        validateSchema(val, sch.additionalProperties, childPath, errors);
      }
    }
  }

  if (typeOf(node) === 'array') {
    const arr = node as unknown[];
    if (typeof sch.minItems === 'number' && arr.length < sch.minItems) {
      errors.push(`${path}: array shorter than minItems ${sch.minItems}`);
    }
    if (sch.items) {
      arr.forEach((el, i) => validateSchema(el, sch.items, `${path}/${i}`, errors));
    }
  }
}

function validateDrop(schemaPath: string, dropPath: string): string[] {
  let schema: SchemaNode;
  let instance: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read/parse schema: ${(e as Error).message}`);
  }
  try {
    instance = JSON.parse(readFileSync(dropPath, 'utf8'));
  } catch (e) {
    return [`instance is not valid JSON: ${(e as Error).message}`];
  }
  const errors: string[] = [];
  validateSchema(instance, schema, '$', errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Promotion logic.
// ---------------------------------------------------------------------------

function withStateRoot<T>(stateRootPath: string, fn: () => T): T {
  const previous = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = stateRootPath;
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

function runDir(stateRootPath: string, runId: string): string {
  return withStateRoot(stateRootPath, () => libRunDir(runId));
}

function appendLedger(
  stateRoot: string,
  runId: string,
  event: string,
  ...kvs: string[]
): void {
  withStateRoot(stateRoot, () => ledgerAppend(runId, event, ...kvs));
}

function reject(
  stateRoot: string,
  runId: string,
  taskId: string,
  reason: string,
  detail?: string,
): never {
  appendLedger(stateRoot, runId, 'result_rejected', 'task_id', taskId, 'reason', reason, 'detail', detail ?? '');
  warn(`REJECTED [${taskId}]: ${reason}${detail ? ` — ${detail}` : ''}`);
  warn('worktree preserved for forensics/recovery');
  throw new PromoteError(reason, detail);
}

function internal(message: string): never {
  throw new PromoteInternalError(message);
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Promote an untrusted worker inbox drop into the authoritative result tree.
 *
 * This is the TypeScript port of hydra/scripts/promote.sh — the trust boundary.
 * Every rejection gate from the bash script is reproduced exactly:
 * schema_invalid, stale_spec, not_completed, git_evidence (including base
 * ancestry and branch matching), no_commit, ownership_violation, and
 * verification_failed.
 *
 * @param runId - run identifier
 * @param taskId - task identifier
 * @param drop - path to the untrusted inbox result JSON
 * @param options - testability overrides
 * @returns path to the promoted authoritative result and divergence flag
 */
export async function promote(
  runId: string,
  taskId: string,
  drop: string,
  options: PromoteOptions = {},
): Promise<PromoteResult> {
  if (!runId || !taskId || !drop) {
    internal('usage: promote(run_id, task_id, inbox_result.json)');
  }

  const cwd = options.cwd ?? process.cwd();
  const stateRoot = options.stateRoot ?? libStateRoot();
  const rDir = runDir(stateRoot, runId);
  const taskSpec = join(rDir, 'tasks', `${taskId}.yaml`);

  const defaultSchema = defaultSchemaPath();
  const schema = options.schema ? resolve(cwd, options.schema) : defaultSchema;

  const defaultPolicy = process.env.HYDRA_VERIFY_POLICY ?? defaultVerifyPolicyPath();
  const verifyPolicy = options.verifyPolicy ? resolve(cwd, options.verifyPolicy) : defaultPolicy;

  if (!isFile(drop)) {
    internal(`inbox drop not found: ${drop}`);
  }
  if (!isFile(taskSpec)) {
    internal(`instantiated task spec not found: ${taskSpec}`);
  }
  if (!isFile(schema)) {
    internal(`result schema not found: ${schema}`);
  }

  appendLedger(stateRoot, runId, 'result_dropped', 'task_id', taskId, 'inbox', drop);

  // --- 1. Schema validation -------------------------------------------------
  let schemaErrors: string[];
  try {
    schemaErrors = validateDrop(schema, drop);
  } catch (error) {
    schemaErrors = [(error as Error).message];
  }
  if (schemaErrors.length > 0) {
    const detail = `${schemaErrors.slice(0, 3).join(';')};`;
    reject(stateRoot, runId, taskId, 'schema_invalid', detail);
  }

  // --- 2. Spec-version freshness --------------------------------------------
  const specVersionLatest = yamlScalar(taskSpec, 'spec_version');
  let claims: Record<string, any>;
  try {
    claims = JSON.parse(readFileSync(drop, 'utf8'));
  } catch (e) {
    reject(stateRoot, runId, taskId, 'schema_invalid', `instance is not valid JSON: ${(e as Error).message}`);
  }
  const claimedVersion = String(claims.spec_version ?? '');
  if (claimedVersion !== specVersionLatest) {
    reject(stateRoot, runId, taskId, 'stale_spec', `claimed v${claimedVersion}, latest v${specVersionLatest}`);
  }

  // --- 2b. Worker-declared status -------------------------------------------
  const claimedStatus = claims.status;
  if (claimedStatus !== 'completed') {
    reject(stateRoot, runId, taskId, 'not_completed', `worker reported status '${claimedStatus}'`);
  }

  // --- Load spec fields ------------------------------------------------------
  const worktree = yamlScalar(taskSpec, 'worktree');
  const branch = yamlScalar(taskSpec, 'branch');
  const baseCommit = yamlScalar(taskSpec, 'base_commit');
  const writable = yamlList(taskSpec, 'writable_paths');

  const claimedHead = claims.head_commit;

  if (!isDirectory(worktree)) {
    reject(stateRoot, runId, taskId, 'git_evidence', `worktree missing: ${worktree}`);
  }

  const exec = options.exec ?? execFileSync;
  const git = (args: string[], allowFail = false): string | Buffer => {
    try {
      return exec('git', ['-C', worktree, ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      if (allowFail) return '';
      throw e;
    }
  };

  // --- 3. Git evidence ------------------------------------------------------
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    reject(stateRoot, runId, taskId, 'git_evidence', `not a git worktree: ${worktree}`);
  }

  try {
    git(['cat-file', '-e', `${claimedHead}^{commit}`]);
  } catch {
    reject(stateRoot, runId, taskId, 'git_evidence', `head_commit does not exist: ${claimedHead}`);
  }

  try {
    git(['cat-file', '-e', `${baseCommit}^{commit}`]);
  } catch {
    reject(stateRoot, runId, taskId, 'git_evidence', `base_commit does not exist: ${baseCommit}`);
  }

  try {
    git(['merge-base', '--is-ancestor', baseCommit, claimedHead]);
  } catch {
    reject(stateRoot, runId, taskId, 'git_evidence', 'head does not descend from declared base');
  }

  let actualBranchHead = '';
  try {
    actualBranchHead = String(git(['rev-parse', '--verify', '--quiet', branch], true)).trim();
  } catch {
    actualBranchHead = '';
  }
  if (!actualBranchHead) {
    reject(stateRoot, runId, taskId, 'git_evidence', `branch does not exist: ${branch}`);
  }

  let fullClaimed = '';
  try {
    fullClaimed = String(git(['rev-parse', '--verify', claimedHead], true)).trim();
  } catch {
    fullClaimed = '';
  }
  if (actualBranchHead !== fullClaimed) {
    reject(
      stateRoot,
      runId,
      taskId,
      'git_evidence',
      `branch ${branch} head (${actualBranchHead}) != claimed head (${fullClaimed})`,
    );
  }

  const trackedStatus = String(git(['status', '--porcelain', '--untracked-files=no'], true));
  if (trackedStatus.trim().length > 0) {
    reject(stateRoot, runId, taskId, 'git_evidence', 'worktree has uncommitted tracked changes');
  }

  const baseResolved = String(git(['rev-parse', baseCommit], true)).trim();
  let diffNames = '';
  try {
    diffNames = String(git(['diff', '--name-only', `${baseCommit}...${fullClaimed}`], true)).trim();
  } catch {
    diffNames = '';
  }
  if (baseResolved === fullClaimed || diffNames.length === 0) {
    reject(stateRoot, runId, taskId, 'no_commit', 'head == base (or empty diff): worker produced no committed work (§2.1)');
  }

  // --- 4. Ownership audit (authoritative) -----------------------------------
  const auditFn = options.audit ?? auditOwnership;
  let auditResult: AuditOwnershipResult;
  try {
    auditResult = auditFn(worktree, baseCommit, claimedHead, writable, {
      cwd,
      stateRoot,
      exec,
    });
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error).replace(/\n/g, ';');
    reject(stateRoot, runId, taskId, 'ownership_violation', detail);
  }
  if (!auditResult.clean) {
    reject(stateRoot, runId, taskId, 'ownership_violation', auditResult.violations.join('; '));
  }

  // --- 5. Sandboxed verification --------------------------------------------
  const verifyDir = join(rDir, 'authoritative', 'verification');
  mkdirSync(verifyDir, { recursive: true });
  const observedJson = join(verifyDir, `${taskId}.json`);

  const verifyFn = options.verify ?? verify;
  let observed: VerifyResult[];
  try {
    observed = await verifyFn(worktree, verifyPolicy, observedJson, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LANG: process.env.LANG ?? 'C',
      },
    });
  } catch {
    appendLedger(stateRoot, runId, 'verification_executed', 'task_id', taskId, 'status', 'failed');
    reject(stateRoot, runId, taskId, 'verification_failed', `harness re-run did not pass; see ${observedJson}`);
  }

  const allPassed = observed.every((r) => r.status === 'passed');
  if (!allPassed) {
    appendLedger(stateRoot, runId, 'verification_executed', 'task_id', taskId, 'status', 'failed');
    reject(stateRoot, runId, taskId, 'verification_failed', `harness re-run did not pass; see ${observedJson}`);
  }
  appendLedger(stateRoot, runId, 'verification_executed', 'task_id', taskId, 'status', 'passed');

  try {
    observed = JSON.parse(readFileSync(observedJson, 'utf8')) as VerifyResult[];
  } catch (error) {
    internal(`cannot read/parse verification output: ${(error as Error).message}`);
  }

  // --- 6. Promotion: claims + observed + divergence -------------------------
  const claimsMap = new Map<string, string>();
  for (const c of claims.verification_claims ?? []) {
    claimsMap.set(c.command, c.status);
  }
  const observedMap = new Map<string, string>();
  for (const o of observed) {
    observedMap.set(o.command, o.status);
  }

  let divergence = false;
  for (const [cmd, observedStatus] of observedMap) {
    if (claimsMap.has(cmd) && claimsMap.get(cmd) !== observedStatus) {
      divergence = true;
      break;
    }
  }

  const promotedDir = join(rDir, 'authoritative', 'results');
  mkdirSync(promotedDir, { recursive: true });
  const promoted = join(promotedDir, `${taskId}.json`);

  const promotedDoc = {
    claims,
    harness_observed: { verification: observed },
    divergence,
    promoted_at: now(),
  };
  writeFileSync(promoted, `${JSON.stringify(promotedDoc)}\n`, 'utf8');

  appendLedger(
    stateRoot,
    runId,
    'result_promoted',
    'task_id',
    taskId,
    'head',
    fullClaimed,
    'divergence',
    String(divergence),
  );

  log(`PROMOTED [${taskId}] head=${fullClaimed} divergence=${divergence}`);

  return { promoted, divergence };
}

/** CLI entry point preserving promote.sh's 0/2/5 exit-code contract. */
export async function main(
  args: string[] = process.argv.slice(2),
  options: PromoteOptions = {},
): Promise<number> {
  try {
    const result = await promote(args[0] ?? '', args[1] ?? '', args[2] ?? '', options);
    process.stdout.write(`${result.promoted}\n`);
    return 0;
  } catch (error) {
    if (error instanceof PromoteError) return error.code;
    const code = error instanceof PromoteInternalError ? error.code : 2;
    process.stderr.write(`hydra: error: ${(error as Error).message}\n`);
    return code;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await main();
}

export default promote;
