import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  auditOwnership,
  type AuditOwnershipOptions,
  type AuditOwnershipResult,
} from './audit-ownership.ts';
import { isCompiledBinary, kitAssetPath, kitAssetText } from './kit-assets.ts';
import {
  ledgerAppend,
  log,
  now,
  repoRoot,
  runDir as libRunDir,
  stateRoot as libStateRoot,
  unescapeYamlDoubleQuoted,
  warn,
  yamlList,
  yamlScalar,
} from './lib.ts';
import { verify, type VerifyOptions, type VerifyResult } from './verify.ts';

/**
 * Trust-boundary schema content. The `schema` option (tests) reads from disk
 * and wins; the default goes through kit-assets — embedded in the compiled
 * binary so an operator cannot weaken result validation without rebuilding,
 * checkout file in the source lane (spike §9 verdict #4).
 */
function defaultSchemaText(): string {
  return kitAssetText('schemas/result.schema.json');
}

function defaultVerifyPolicyPath(): string {
  // Per-project active config — resolve checkout-relative (spike §9 verdict
  // #5). HYDRA_VERIFY_POLICY and options.verifyPolicy keep precedence.
  return kitAssetPath('policies/verification.yaml');
}

// ---------------------------------------------------------------------------
// Verification-honesty signals (issue #38).
//
// Two blind spots let a promotion print a reassuring "passed" while nothing
// meaningful was checked:
//
//   1. The claims-vs-observed divergence check below is INTERSECTION based: it
//      only fires for a command present in both the worker's claims and the
//      policy's observations. A worker that substituted its own weaker checks
//      for the task spec's mandated commands overlaps neither set, so
//      divergence stays false and the substitution is invisible.
//   2. The active verification policy may still be the kit template's
//      illustrative placeholder, which matches no files in this repo, exits 0,
//      and is reported as "passed" having verified nothing.
//
// Both are disclosed loudly here. Neither blocks promotion — that is a policy
// decision an operator has not signed off on.
// ---------------------------------------------------------------------------

/** The illustrative command shipped in the kit's policies/verification.yaml. */
const TEMPLATE_PLACEHOLDER_VERIFY_COMMAND =
  /^find\s+src\s+-name\s+'\*\.js'\s+-print0\s*\|\s*xargs\s+-0\s+-I\{\}\s+node\s+--check\s+\{\}$/;

/** Whitespace-insensitive form used to compare command strings. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/**
 * The task spec's own declared `verification:` list.
 *
 * yamlList() needs a bare key line, but the shipped task template writes
 * `verification:            # advisory to the worker; the MANDATORY gate` — a
 * trailing comment is legal YAML and common in hand-authored specs. Falling
 * back to a comment-tolerant scan keeps this disclosure from silently
 * no-op'ing on exactly the shape operators copy from the template.
 */
function taskSpecVerification(taskSpec: string): string[] {
  const direct = yamlList(taskSpec, 'verification').filter(Boolean);
  if (direct.length > 0) return direct;

  const items: string[] = [];
  let grab = false;
  for (const rawLine of readFileSync(taskSpec, 'utf8').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^verification:\s*(#.*)?$/.test(line)) {
      grab = true;
      continue;
    }
    if (!grab) continue;
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item) {
      const quoted = item[1].trim().match(/^"((?:\\.|[^"\\])*)"/);
      const value = quoted
        ? unescapeYamlDoubleQuoted(quoted[1])
        : item[1].replace(/\s+#.*$/, '').trim();
      if (value) items.push(value);
      continue;
    }
    if (/^\S/.test(line)) grab = false;
  }
  return items;
}

/**
 * The match must begin where a shell would start a command: at the start of the
 * claim, or right after a separator (`&&`, `||`, `;`, `|`, `(`, `{`). This is
 * what stops `echo pnpm test` from counting as having run `pnpm test`.
 */
const COMMAND_POSITION = /(?:^|[;&|({]\s*)$/;

/** ...and it must end on a word boundary, so `pnpm testfoo` does not match. */
const COMMAND_BOUNDARY = /^(?:\s|[;&|)}]|$)/;

/**
 * True when a mandated command appears among the worker's claimed commands,
 * either as-is (modulo whitespace) or wrapped by a claim that runs it (e.g.
 * `cd pkg && <cmd>`). Deliberately forgiving about wrapping and trailing
 * arguments — this signal exists to catch a WHOLESALE substitution, not to
 * nitpick a reworded invocation — but not so forgiving that the mandated
 * command counts when it is merely an ARGUMENT to some other command.
 */
function mandatedCommandRan(mandated: string, claimed: string[]): boolean {
  const needle = normalizeCommand(mandated);
  if (needle === '') return true;
  return claimed.some((command) => {
    const haystack = normalizeCommand(command);
    for (let from = 0; ; from += 1) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) return false;
      if (
        COMMAND_POSITION.test(haystack.slice(0, at))
        && COMMAND_BOUNDARY.test(haystack.slice(at + needle.length))
      ) {
        return true;
      }
      from = at;
    }
  });
}

/** The commands the active verification policy would run, if it is readable. */
function policyCommands(policyPath: string): string[] {
  // Same two lookups verify.ts performs: nested under verification_policy, or
  // declared at column 0.
  let commands = yamlList(policyPath, '  commands');
  if (commands.length === 0) commands = yamlList(policyPath, 'commands');
  return commands.filter(Boolean);
}

/**
 * True when every command in the active policy is still the kit template's
 * illustrative placeholder. An unreadable policy is not this signal's problem
 * (verify() rejects on it), so it reports false.
 */
function isTemplatePlaceholderPolicy(policyPath: string): boolean {
  let commands: string[];
  try {
    commands = policyCommands(policyPath);
  } catch {
    return false;
  }
  return commands.length > 0
    && commands.every((command) => TEMPLATE_PLACEHOLDER_VERIFY_COMMAND.test(command.trim()));
}

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** Shape of a git/execFileSync call that tests can override. */
export type ExecLike = (
  command: string,
  args: string[],
  options?: { encoding?: BufferEncoding; stdio?: any },
) => string | Buffer;

/** Testable options for promote(), mirroring sibling modules. */
export interface PromoteOptions {
  /** Base directory used to resolve relative paths; defaults to process.cwd(). */
  cwd?: string;
  /** Hydra state root; defaults to HYDRA_STATE_ROOT or lib.ts stateRoot(). */
  stateRoot?: string;
  /** Path to result.schema.json; defaults to the kit asset (embedded when compiled, else hydra/schemas/result.schema.json from the checkout). */
  schema?: string;
  /** Path to verification policy YAML; defaults to HYDRA_VERIFY_POLICY or the checkout-relative hydra/policies/verification.yaml. */
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
  /** True when NONE of the task spec's declared verification commands appear in the worker's claims. */
  mandatedVerificationMissing: boolean;
  /** True when the active verification policy is still the kit template's placeholder. */
  placeholderVerifyPolicy: boolean;
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

function validateDrop(schemaText: string, dropPath: string): string[] {
  let schema: SchemaNode;
  let instance: unknown;
  try {
    schema = JSON.parse(schemaText);
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

  const defaultPolicy = process.env.HYDRA_VERIFY_POLICY ?? defaultVerifyPolicyPath();
  const verifyPolicy = options.verifyPolicy ? resolve(cwd, options.verifyPolicy) : defaultPolicy;

  if (!isFile(drop)) {
    internal(`inbox drop not found: ${drop}`);
  }
  if (!isFile(taskSpec)) {
    internal(`instantiated task spec not found: ${taskSpec}`);
  }

  let schemaText: string;
  if (options.schema) {
    const schemaPath = resolve(cwd, options.schema);
    if (!isFile(schemaPath)) {
      internal(`result schema not found: ${schemaPath}`);
    }
    schemaText = readFileSync(schemaPath, 'utf8');
  } else {
    try {
      schemaText = defaultSchemaText();
    } catch {
      internal(
        `result schema not found: ${kitAssetPath('schemas/result.schema.json')} `
        + '(a repo without the installed kit layout needs hydra/{schemas,policies} '
        + 'copied from the plugin kit — see docs/state-and-worktrees.md)',
      );
    }
  }

  appendLedger(stateRoot, runId, 'result_dropped', 'task_id', taskId, 'inbox', drop);

  // --- 1. Schema validation -------------------------------------------------
  let schemaErrors: string[];
  try {
    schemaErrors = validateDrop(schemaText, drop);
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
  } catch (error) {
    // verify() can die before running (missing/unparseable policy, no
    // commands) without writing observedJson; a reject that says "see
    // <file>" would then point at a file that does not exist and swallow
    // the real cause. Persist a diagnostic record and surface the error.
    const detail = String(error instanceof Error ? error.message : error).replace(/\n/g, ';');
    try {
      writeFileSync(
        observedJson,
        `${JSON.stringify([{ command: '(verification harness)', status: 'failed', error: detail }])}\n`,
        'utf8',
      );
    } catch {
      // best-effort: the reject detail below still carries the cause
    }
    appendLedger(stateRoot, runId, 'verification_executed', 'task_id', taskId, 'status', 'failed');
    reject(stateRoot, runId, taskId, 'verification_failed', `verification harness error: ${detail}`);
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

  // --- 6b. Spec-mandated verification vs the worker's claims (issue #38) ----
  // Additive to (and independent of) the intersection-based divergence check
  // above: this compares the TASK SPEC's declared commands against the claims,
  // which is the pair with zero overlap when a worker substitutes its own
  // weaker checks.
  const mandatedCommands = taskSpecVerification(taskSpec);
  const claimedCommands = [...claimsMap.keys()];
  const mandatedNotClaimed = mandatedCommands.filter(
    (command) => !mandatedCommandRan(command, claimedCommands),
  );
  const mandatedVerificationMissing = mandatedCommands.length > 0
    && mandatedNotClaimed.length === mandatedCommands.length;

  if (mandatedVerificationMissing) {
    const detail = mandatedNotClaimed.join(' ;; ');
    appendLedger(
      stateRoot,
      runId,
      'mandated_verification_missing',
      'task_id',
      taskId,
      'commands',
      detail,
    );
    warn(
      `MANDATED VERIFICATION MISSING [${taskId}]: the worker's verification_claims name NONE `
      + `of the ${mandatedCommands.length} verification command(s) declared in its task spec `
      + `— never run: ${detail}`,
    );
    warn(
      `[${taskId}] promoting anyway (this is disclosure, not a block) — treat this result's `
      + 'verification as UNPROVEN and re-check it by hand before integrating',
    );
  }

  // --- 6c. Is the active mandatory gate still the shipped placeholder? ------
  const placeholderVerifyPolicy = isTemplatePlaceholderPolicy(verifyPolicy);
  if (placeholderVerifyPolicy) {
    appendLedger(
      stateRoot,
      runId,
      'verification_policy_placeholder',
      'task_id',
      taskId,
      'policy',
      verifyPolicy,
    );
    warn(
      `PLACEHOLDER VERIFICATION POLICY [${taskId}]: ${verifyPolicy} still contains only the kit `
      + "template's illustrative command — no repo-specific mandatory gate is configured",
    );
    warn(
      `[${taskId}] the verification "passed" status above therefore means NOTHING WAS ACTUALLY `
      + `VERIFIED; put this repo's real commands in ${verifyPolicy}`,
    );
  }

  const promotedDir = join(rDir, 'authoritative', 'results');
  mkdirSync(promotedDir, { recursive: true });
  const promoted = join(promotedDir, `${taskId}.json`);

  const promotedDoc = {
    claims,
    harness_observed: { verification: observed },
    divergence,
    mandated_verification_missing: mandatedVerificationMissing,
    mandated_verification_not_claimed: mandatedNotClaimed,
    verification_policy_placeholder: placeholderVerifyPolicy,
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
    'mandated_verification_missing',
    String(mandatedVerificationMissing),
    'verification_policy_placeholder',
    String(placeholderVerifyPolicy),
  );

  log(
    `PROMOTED [${taskId}] head=${fullClaimed} divergence=${divergence}`
    + ` mandated_verification_missing=${mandatedVerificationMissing}`
    + ` verification_policy_placeholder=${placeholderVerifyPolicy}`,
  );

  return {
    promoted,
    divergence,
    mandatedVerificationMissing,
    placeholderVerifyPolicy,
  };
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

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await main();
}

export default promote;
