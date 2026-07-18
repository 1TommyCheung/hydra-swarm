// hydra gc — reap worktrees and branches of ledger-proven-integrated tasks
// (GitHub issue #12, run 0048, spec v6).
//
// A task's worktree+branch may be reaped ONLY when ALL hold:
//   1. an authoritative result exists (authoritative/results/<task>.json);
//   2. a RECORDED integration SHA is an ancestor of the repo default branch,
//      where recorded means the ledger's candidate_integrated `head` value or
//      the authoritative/results/<task>.squash.json `integration_commit`. The
//      integrate step cherry-picks the squash, so branch ancestry can never
//      prove integration — only a recorded SHA counts; if git cannot prove
//      reachability of any recorded SHA the task is INELIGIBLE;
//   3. the worktree has no uncommitted/untracked/ignored content beyond a
//      known-junk set (node_modules, .pnpm-store, .ffmpeg-bin,
//      .hydra-result.json) — both sides of a rename count as content;
//   4. the REACHABLE proof is PAIRED with the current candidate: the proof's
//      own candidate head (the squash record's candidate_head; for a
//      ledger-only proof without a squash record, the result envelope's
//      claims.head_commit) must EQUAL the branch tip at scan. A historic
//      reachable proof must never qualify a branch whose tip is a newer
//      unintegrated retry — and NO evidence borrowing, ever (spec v5): a
//      squash record missing its own candidate_head is incomplete squash
//      evidence, the task is INELIGIBLE, and result.head_commit (or any
//      other field) is never substituted for the missing candidate_head;
//   5. the proof comes from the SAME evidence chain as the current candidate
//      (spec v4): a squash_created or result_promoted ledger event AFTER an
//      integration proof's ledger position opens a newer, never-integrated
//      candidate generation — the task is INELIGIBLE regardless of
//      reachability, and a result_promoted newer than the newest
//      squash_created makes the on-disk squash record itself stale.
//
// Safety rules (binding):
//   - default mode is a dry-run printing what would be removed and the proof;
//     actual removal requires an explicit --apply flag;
//   - every candidate path is validated against `git worktree list
//     --porcelain -z` output and must reside under the worktree root before
//     any removal, and the registered worktree's branch must be
//     refs/heads/hydra/<run>/<task> exactly — ledger/spec content is data and
//     is never passed to rm directly;
//   - all parsed git output is NUL-framed (`git status --porcelain -z`,
//     `git worktree list --porcelain -z`) so a pathname containing the
//     literal ' -> ' can never be misparsed as a rename — delimiter
//     ambiguity is structurally impossible;
//   - immediately before EACH destructive operation gc re-verifies the
//     candidate (spec v4): the full check (registered branch binding, branch
//     tip still equal to the paired proven candidate head, NUL-framed
//     cleanliness — the --force decision comes from this fresh read, never
//     the scan's) runs directly before `git worktree remove`, and the branch
//     deletion itself is git's atomic compare-and-delete (spec v5):
//     `git update-ref -d refs/heads/<branch> <expected-proven-sha>` has no
//     read-then-delete gap for a race to exploit — git itself refuses the
//     deletion when the ref no longer points at the proven sha; any change
//     aborts that candidate with a skip reason (TOCTOU);
//   - removal uses `git worktree remove` (with --force only for the known-junk
//     case) followed by the atomic branch deletion above, restricted to the
//     branch matching hydra/<run_id>/<task_id> exactly — a nonzero exit from
//     update-ref -d is a skip with reason, never an error;
//   - the default branch is never guessed: an explicit --default-branch or the
//     clone's origin/HEAD is required, otherwise gc refuses to run;
//   - each applied removal appends a `worktree_reaped` ledger event; when the
//     worktree was removed but branch deletion failed a `worktree_reap_partial`
//     event is appended instead, and a later run retries the branch cleanup;
//   - --keep-last orders strictly by the newest REACHABLE proof's timestamp —
//     unreachable records buy no retention;
//   - run/task ids read from state are validated against the id shape BEFORE
//     any filesystem path is constructed from them;
//   - the scan covers ALL runs of the current repo's state root.
//
// Follows the repo options-bag pattern: every git/du invocation goes through
// the injectable exec so tests never mutate a real checkout.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCompiledBinary } from './kit-assets.ts';
import { die, now, repoRoot, stateRoot, worktreeRoot, yamlScalar } from './lib.ts';

/** Injectable exec, same shape as integrate.ts's ExecFunction. */
export type ExecFunction = (
  file: string,
  args: string[],
  options?: { encoding?: BufferEncoding; cwd?: string; stdio?: any },
) => string;

export interface GcOptions {
  /** Repository root (defaults to the containing repo of cwd). */
  cwd?: string;
  /** External state root (defaults to lib.stateRoot()). */
  stateRoot?: string;
  /** Worktree parent directory (defaults to lib.worktreeRoot()). */
  worktreeRoot?: string;
  /** Optional exec injection for tests. Defaults to child_process.execFileSync. */
  exec?: ExecFunction;
  /** Actually remove; default false is a dry-run. */
  apply?: boolean;
  /** Retain the N most recently integrated eligible tasks. */
  keepLast?: number;
  /** Explicit default-branch ref (e.g. main). Required when the clone has no
   *  origin/HEAD — the default branch is never guessed. */
  defaultBranch?: string;
}

export type GcCandidateStatus =
  | 'reaped'
  | 'would-reap'
  | 'kept'
  | 'ineligible'
  | 'skipped'
  | 'error';

export interface GcProof {
  /** Path of the authoritative result that anchors eligibility. */
  result: string;
  /** The recorded SHA git proved reachable from the default branch. */
  integrated_sha: string;
  /** Where the recorded SHA came from. */
  source: 'ledger' | 'squash_record';
  /** The candidate head this proof is PAIRED with: eligibility required the
   *  branch tip to equal exactly this head, and the pre-removal re-check
   *  requires it to still hold. */
  candidate_head: string;
}

export interface GcCandidate {
  run_id: string;
  task_id: string;
  worktree: string;
  branch: string;
  status: GcCandidateStatus;
  reason?: string;
  proof?: GcProof;
  /** Best-effort du of the worktree in bytes, taken before any removal. */
  bytes?: number;
  /** True when the worktree was dirty only via the known-junk set. */
  junk_only?: boolean;
  /** True when the worktree is already gone and only the stale branch remains
   *  (a partial reap being retried). */
  branch_only?: boolean;
  /** Integration time used for --keep-last ordering (ms epoch): the newest
   *  REACHABLE proof only, unreachable records are ignored. */
  integrated_ms?: number;
}

export interface GcReport {
  mode: 'dry-run' | 'apply';
  default_ref: string;
  keep_last: number;
  candidates: GcCandidate[];
  totals: {
    reaped: number;
    would_reap: number;
    kept: number;
    skipped: number;
    ineligible: number;
    errors: number;
    bytes: number;
  };
}

/**
 * Untracked/ignored-path entries that never block reaping. Compared against
 * the first path segment of each `git status --porcelain` entry.
 */
export const KNOWN_JUNK = new Set([
  'node_modules',
  '.pnpm-store',
  '.ffmpeg-bin',
  '.hydra-result.json',
]);

// Run/task identifiers become branch names and path components; they are read
// from the ledger/spec (data), so refuse anything that could escape that shape.
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VALID_SHA = /^[0-9a-f]{4,64}$/i;
// A ref passed to git as the default branch: sane ref chars, no traversal.
const VALID_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

const USAGE = 'usage: gc [--apply] [--keep-last N] [--default-branch REF] [--json]';

function defaultExec(
  file: string,
  args: string[],
  options?: { encoding?: BufferEncoding; cwd?: string; stdio?: any },
): string {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  }) as string;
}

function git(execFn: ExecFunction, cwd: string, args: string[]): string {
  return execFn('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function tryGit(execFn: ExecFunction, cwd: string, args: string[]): string | undefined {
  try {
    return git(execFn, cwd, args);
  } catch {
    return undefined;
  }
}

/**
 * Raw variant for NUL-framed output: trim() must NOT touch it — the leading
 * space of a first entry's XY code (' M …') is significant, and trailing
 * NULs are frame delimiters, not whitespace.
 */
function gitRaw(execFn: ExecFunction, cwd: string, args: string[]): string {
  return execFn('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function tryGitRaw(execFn: ExecFunction, cwd: string, args: string[]): string | undefined {
  try {
    return gitRaw(execFn, cwd, args);
  } catch {
    return undefined;
  }
}

/**
 * The ref used for ancestry proofs: the explicit --default-branch when given,
 * else the clone's origin/HEAD. There is deliberately NO fallback to the
 * invoking worktree's branch: integration must be proven against the real
 * default branch, so when neither exists gc refuses to run (fail closed).
 */
function resolveDefaultRef(execFn: ExecFunction, repo: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!VALID_REF.test(explicit) || explicit.includes('..')) {
      die(`invalid --default-branch ref '${explicit}'`);
    }
    return explicit;
  }
  const originHead = tryGit(execFn, repo, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead) return originHead;
  die(
    'cannot determine the repo default branch: this clone has no origin/HEAD and no '
    + '--default-branch was given — refusing to guess; re-run with --default-branch <ref>',
  );
}

/** Canonical path for comparisons: realpath when it exists, resolve otherwise. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

interface RegisteredWorktree {
  /** refs/heads/<branch> of the worktree, or null when detached. */
  branch: string | null;
}

/** Registered worktree paths -> branch, from `git worktree list --porcelain -z`.
 *  NUL framing keeps paths containing newlines, quotes, or ' -> ' unambiguous. */
function listRegisteredWorktrees(
  execFn: ExecFunction,
  repo: string,
): Map<string, RegisteredWorktree> {
  const out = gitRaw(execFn, repo, ['worktree', 'list', '--porcelain', '-z']);
  const registered = new Map<string, RegisteredWorktree>();
  let current: string | undefined;
  for (const line of out.split('\0')) {
    if (line.startsWith('worktree ')) {
      current = canonical(line.slice('worktree '.length));
      registered.set(current, { branch: null });
    } else if (current !== undefined && line.startsWith('branch ')) {
      registered.set(current, { branch: line.slice('branch '.length) });
    }
  }
  return registered;
}

function discoverRunIds(root: string): string[] {
  const runsDir = join(root, 'runs');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => e.name.slice(4))
    .sort();
}

interface LedgerIntegratedEvent {
  head: string;
  ms: number;
  /** Position in the ledger file (non-empty lines) — generation ordering. */
  index: number;
}

interface TaskTimeline {
  /** candidate_integrated events in ledger order. */
  integrations: LedgerIntegratedEvent[];
  /** Ledger position of the newest squash_created event (-1: none). */
  lastSquash: number;
  /** Ledger position of the newest result_promoted event (-1: none). */
  lastPromote: number;
}

/** Per-task event timelines, read from one run's ledger. Ledger position is
 *  significant (spec v4): a squash_created or result_promoted event AFTER an
 *  integration proof opens a newer, never-integrated candidate generation. */
function readTaskTimelines(ledgerPath: string): Map<string, TaskTimeline> {
  const byTask = new Map<string, TaskTimeline>();
  if (!existsSync(ledgerPath)) return byTask;
  let index = 0;
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event: { event?: unknown; task_id?: unknown; head?: unknown; time?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      index += 1; // a torn line still occupied a ledger position
      continue; // a torn trailing line is data, not a fatal error
    }
    if (typeof event.task_id === 'string') {
      const timeline = byTask.get(event.task_id)
        ?? { integrations: [], lastSquash: -1, lastPromote: -1 };
      if (event.event === 'candidate_integrated' && typeof event.head === 'string') {
        const ms = typeof event.time === 'string' ? Date.parse(event.time) : NaN;
        timeline.integrations.push({
          head: event.head,
          ms: Number.isNaN(ms) ? 0 : ms,
          index,
        });
      } else if (event.event === 'squash_created') {
        timeline.lastSquash = index;
      } else if (event.event === 'result_promoted') {
        timeline.lastPromote = index;
      }
      byTask.set(event.task_id, timeline);
    }
    index += 1;
  }
  return byTask;
}

interface SquashRecordFields {
  integration_commit?: string;
  candidate_head?: string;
}

/** Fields of a squash record; absent/malformed fields come back undefined. */
function readSquashRecord(recordPath: string): SquashRecordFields {
  if (!existsSync(recordPath)) return {};
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      integration_commit?: unknown;
      candidate_head?: unknown;
    };
    return {
      integration_commit: typeof record.integration_commit === 'string'
        ? record.integration_commit
        : undefined,
      candidate_head: typeof record.candidate_head === 'string'
        ? record.candidate_head
        : undefined,
    };
  } catch {
    return {};
  }
}

/** head_commit from an authoritative result: the production promoted-result
 *  envelope's claims.head_commit (what promote.ts writes), with the flat
 *  top-level head_commit as the legacy fallback. Undefined when absent or
 *  malformed. */
function readResultHeadCommit(resultPath: string): string | undefined {
  try {
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      claims?: unknown;
      head_commit?: unknown;
    };
    const claims = result.claims;
    if (claims !== null && typeof claims === 'object') {
      const envelopeHead = (claims as { head_commit?: unknown }).head_commit;
      if (typeof envelopeHead === 'string') return envelopeHead;
    }
    return typeof result.head_commit === 'string' ? result.head_commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a worktree's `git status --porcelain -z -uall --ignored=matching`
 * output: entries beyond the known-junk set make it dirty; junk-only means
 * removal needs --force. The output is NUL-framed, so a pathname containing
 * the literal ' -> ' stays a single field and can never be misparsed as a
 * rename; with -z a rename/copy entry is `XY <to>\0<from>\0` and BOTH sides
 * count as content — a tracked file renamed INTO a junk directory must still
 * block reaping.
 */
function classifyStatusZ(porcelainZ: string): { dirty: string[]; junkOnly: boolean } {
  const dirty: string[] = [];
  let sawJunk = false;
  const fields = porcelainZ.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === '') continue; // trailing NUL / entry separators
    const xy = field.slice(0, 2);
    const sides = [field.slice(3)];
    if (xy.includes('R') || xy.includes('C')) {
      // Rename/copy: the FROM path follows as the next NUL field.
      i += 1;
      if (i < fields.length && fields[i] !== '') sides.push(fields[i]);
    }
    for (const side of sides) {
      const firstSegment = side.replace(/\/$/, '').split('/')[0];
      if (KNOWN_JUNK.has(firstSegment)) {
        sawJunk = true;
      } else {
        dirty.push(side);
      }
    }
  }
  return { dirty, junkOnly: sawJunk && dirty.length === 0 };
}

/** Best-effort `du -sk` of a path in bytes; undefined when du fails. */
function diskUsage(execFn: ExecFunction, path: string): number | undefined {
  try {
    const out = execFn('du', ['-sk', path], { encoding: 'utf8', stdio: 'pipe' });
    const kb = Number.parseInt(out.split(/\s/, 1)[0], 10);
    return Number.isNaN(kb) ? undefined : kb * 1024;
  } catch {
    return undefined;
  }
}

/** Append a ledger event in exactly lib.ledgerAppend's record shape. */
function appendLedgerEvent(
  stateRootPath: string,
  runId: string,
  event: string,
  kvs: Record<string, string>,
): void {
  const ledgerPath = join(
    stateRootPath,
    'runs',
    `run-${runId}`,
    'authoritative',
    'ledger',
    'events.jsonl',
  );
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({ time: now(), event, run_id: runId, ...kvs })}\n`,
    'utf8',
  );
}

interface RecheckResult {
  /** Abort reason; undefined when the candidate is unchanged since the scan. */
  reason?: string;
  /** Fresh junk-only classification — the --force decision must come from
   *  THIS read, never from the scan's (spec v4). */
  junkOnly: boolean;
}

/**
 * TOCTOU guard run directly before `git worktree remove` (spec v4):
 * re-verify everything the scan proved — the worktree is still registered
 * and bound to refs/heads/hydra/<run>/<task>, the branch tip still equals
 * the paired proven candidate head, and the worktree is still clean beyond
 * the known-junk set (NUL-framed). The fresh junk-only classification is
 * returned so the removal's --force decision never relies on the scan's.
 */
function recheckBeforeWorktreeRemove(
  execFn: ExecFunction,
  repo: string,
  candidate: GcCandidate,
): RecheckResult {
  const branchRef = `refs/heads/${candidate.branch}`;
  const entry = listRegisteredWorktrees(execFn, repo).get(candidate.worktree);
  if (entry === undefined) {
    return { junkOnly: false, reason: 'worktree is no longer registered in git worktree list — changed since scan' };
  }
  if (entry.branch !== branchRef) {
    return { junkOnly: false, reason: `registered worktree branch changed since scan (now '${entry.branch ?? 'detached'}')` };
  }
  const proven = candidate.proof?.candidate_head ?? '';
  const tip = tryGit(execFn, repo, ['rev-parse', branchRef]);
  if (tip === undefined) {
    return { junkOnly: false, reason: `branch ${candidate.branch} vanished since scan` };
  }
  if (tip !== proven) {
    return { junkOnly: false, reason: `branch tip moved since scan (${tip.slice(0, 12)} != proven candidate head ${proven.slice(0, 12)})` };
  }
  const porcelain = tryGitRaw(execFn, candidate.worktree, [
    'status',
    '--porcelain',
    '-z',
    '-uall',
    '--ignored=matching',
  ]);
  if (porcelain === undefined) {
    return { junkOnly: false, reason: 'git status failed during the pre-removal re-check' };
  }
  const { dirty, junkOnly } = classifyStatusZ(porcelain);
  if (dirty.length > 0) {
    return { junkOnly: false, reason: `worktree gained uncommitted/untracked content since scan: ${dirty.slice(0, 5).join(', ')}` };
  }
  return { junkOnly };
}

/**
 * Scan every run of the state root for reap candidates, evaluate eligibility,
 * and (only with apply: true) remove worktrees + branches.
 */
export function gc(options: GcOptions = {}): GcReport {
  const repoRootPath = options.cwd ?? repoRoot();
  const stateRootPath = options.stateRoot ?? stateRoot();
  const worktreeRootPath = canonical(options.worktreeRoot ?? worktreeRoot());
  const execFn: ExecFunction = options.exec ?? defaultExec;
  const apply = options.apply === true;
  const keepLast = options.keepLast ?? 0;

  const defaultRef = resolveDefaultRef(execFn, repoRootPath, options.defaultBranch);
  const registered = listRegisteredWorktrees(execFn, repoRootPath);

  const candidates: GcCandidate[] = [];

  for (const runId of discoverRunIds(stateRootPath)) {
    // Ids from state are data: validate BEFORE any path is built from them.
    if (!VALID_ID.test(runId)) continue;
    const runDirPath = join(stateRootPath, 'runs', `run-${runId}`);
    const resultsDir = join(runDirPath, 'authoritative', 'results');

    // The candidate universe: tasks with an authoritative result, a squash
    // record, or a candidate_integrated ledger event in this run.
    const taskIds = new Set<string>();
    if (existsSync(resultsDir)) {
      for (const entry of readdirSync(resultsDir)) {
        if (entry.endsWith('.squash.json')) {
          taskIds.add(entry.slice(0, -'.squash.json'.length));
        } else if (entry.endsWith('.json')) {
          taskIds.add(entry.slice(0, -'.json'.length));
        }
      }
    }
    const timelines = readTaskTimelines(
      join(runDirPath, 'authoritative', 'ledger', 'events.jsonl'),
    );
    for (const taskId of timelines.keys()) taskIds.add(taskId);

    for (const taskId of [...taskIds].sort()) {
      const branch = `hydra/${runId}/${taskId}`;

      // Validate the id BEFORE any filesystem path is constructed from it.
      if (!VALID_ID.test(taskId)) {
        candidates.push({
          run_id: runId,
          task_id: taskId,
          worktree: '',
          branch,
          status: 'skipped',
          reason: 'task id from state does not match the id shape — refused as data',
        });
        continue;
      }

      const taskSpec = join(runDirPath, 'tasks', `${taskId}.yaml`);
      const specWorktree = existsSync(taskSpec) ? yamlScalar(taskSpec, 'worktree') : '';
      const worktree = specWorktree
        ? resolve(specWorktree)
        : join(worktreeRootPath, `run-${runId}-${taskId}`);
      const candidate: GcCandidate = {
        run_id: runId,
        task_id: taskId,
        worktree,
        branch,
        status: 'skipped',
      };
      candidates.push(candidate);

      // (1) An authoritative result must exist.
      const resultPath = join(resultsDir, `${taskId}.json`);
      if (!existsSync(resultPath)) {
        candidate.status = 'ineligible';
        candidate.reason = `no authoritative result (${join('authoritative', 'results', `${taskId}.json`)} missing)`;
        continue;
      }

      // (2) A recorded integration SHA must be an ancestor of the default
      // branch, and the proof must come from the SAME evidence chain as the
      // current candidate (spec v4): a squash_created or result_promoted
      // ledger event AFTER an integration proof's position opens a newer
      // candidate generation that was never integrated — the task is then
      // INELIGIBLE regardless of reachability. The squash record on disk is
      // the newest squash_created's record, so a result_promoted newer than
      // the newest squash_created makes the record itself stale.
      const timeline = timelines.get(taskId)
        ?? { integrations: [], lastSquash: -1, lastPromote: -1 };
      const squashPath = join(resultsDir, `${taskId}.squash.json`);
      const squashRecordExists = existsSync(squashPath);
      const squash = readSquashRecord(squashPath);
      const resultHead = readResultHeadCommit(resultPath);
      const lastMarker = Math.max(timeline.lastSquash, timeline.lastPromote);
      const currentIntegrations = timeline.integrations.filter(
        (e) => e.index > lastMarker,
      );
      if (timeline.integrations.length > 0 && currentIntegrations.length === 0) {
        candidate.status = 'ineligible';
        candidate.reason = 'a newer squash_created/result_promoted ledger event post-dates every recorded integration proof — the current candidate generation was never integrated';
        continue;
      }
      const recordIsCurrent = timeline.lastPromote <= timeline.lastSquash;
      if (currentIntegrations.length === 0 && !recordIsCurrent) {
        candidate.status = 'ineligible';
        candidate.reason = 'a newer result_promoted ledger event post-dates the squash record — the current candidate generation was never integrated';
        continue;
      }

      // Recorded integration SHAs, all from the current generation's evidence
      // chain: the heads of integration proofs newer than every generation
      // marker, plus the current squash record's own integration_commit.
      const recorded: Array<{
        sha: string;
        source: GcProof['source'];
        ms: number;
      }> = [
        ...currentIntegrations.map((e) => ({
          sha: e.head,
          source: 'ledger' as const,
          ms: e.ms,
        })),
        ...(recordIsCurrent && squash.integration_commit !== undefined
          ? [{
            sha: squash.integration_commit,
            source: 'squash_record' as const,
            ms: statSync(squashPath).mtimeMs,
          }]
          : []),
      ].filter((r) => VALID_SHA.test(r.sha));

      if (recorded.length === 0) {
        candidate.status = 'ineligible';
        candidate.reason = 'no recorded integration SHA (no ledger candidate_integrated head, no squash integration_commit)';
        continue;
      }

      // Only REACHABLE records count — for the proof itself AND for
      // --keep-last ordering: an unreachable record buys no retention.
      const reachable = recorded.filter(
        (r) => tryGit(execFn, repoRootPath, ['merge-base', '--is-ancestor', r.sha, defaultRef]) !== undefined,
      );
      if (reachable.length === 0) {
        candidate.status = 'ineligible';
        candidate.reason = `no recorded SHA reachable from default branch '${defaultRef}' (integration unproven)`;
        continue;
      }

      // Path validation: an existing candidate path must be a registered
      // worktree under the worktree root, bound to exactly
      // refs/heads/hydra/<run>/<task>. Ledger/spec content is data — only a
      // path that passes every check may ever reach `git worktree remove`.
      const canonicalWorktree = canonical(worktree);
      const branchRef = `refs/heads/${branch}`;
      if (existsSync(canonicalWorktree)) {
        if (canonicalWorktree !== worktreeRootPath
          && !canonicalWorktree.startsWith(`${worktreeRootPath}${sep}`)) {
          candidate.status = 'skipped';
          candidate.reason = `worktree path outside worktree root (${worktreeRootPath}) — refused`;
          continue;
        }
        const entry = registered.get(canonicalWorktree);
        if (entry === undefined) {
          candidate.status = 'skipped';
          candidate.reason = 'worktree not registered in git worktree list --porcelain — refused';
          continue;
        }
        if (entry.branch !== branchRef) {
          candidate.status = 'skipped';
          candidate.reason = `registered worktree is on branch '${entry.branch ?? 'detached'}', expected ${branchRef} — refused`;
          continue;
        }
        candidate.worktree = canonicalWorktree;
      } else {
        // Nothing on disk: the only legal remnant is a stale branch left by
        // a partial reap — retry its cleanup. Anything else is already gone.
        if (tryGit(execFn, repoRootPath, ['show-ref', '--verify', '--quiet', branchRef]) === undefined) {
          candidate.status = 'skipped';
          candidate.reason = 'worktree and branch already gone — nothing to reap';
          continue;
        }
        candidate.branch_only = true;
        candidate.reason = 'worktree already gone; stale branch cleanup';
      }

      // (4) The branch tip at scan time must equal the current generation's
      // candidate head — the current squash record's candidate_head, or (for
      // a ledger proof with no current squash record) the result envelope's
      // head_commit. A branch that moved past the proven candidate (a newer
      // unintegrated retry) is INELIGIBLE, no matter how old and reachable
      // the historic proof is.
      const tip = tryGit(execFn, repoRootPath, ['rev-parse', branchRef]);
      if (tip === undefined) {
        candidate.status = 'skipped';
        candidate.reason = `cannot resolve ${branchRef} — refused`;
        continue;
      }
      // Spec v5 — NO evidence borrowing, ever: when the current generation's
      // evidence chain includes the on-disk squash record but the record
      // lacks its own candidate_head, the squash evidence is incomplete and
      // the task is INELIGIBLE; result.head_commit (or any other field) is
      // NEVER substituted for the missing candidate_head. (A ledger-only
      // proof with NO record on disk still binds via the result envelope.)
      if (recordIsCurrent && squashRecordExists && squash.candidate_head === undefined) {
        candidate.status = 'ineligible';
        candidate.reason = 'squash record is missing its own candidate_head — incomplete squash evidence; refusing to substitute result head_commit';
        continue;
      }
      const candidateHead = (recordIsCurrent ? squash.candidate_head : undefined)
        ?? resultHead;
      if (candidateHead === undefined || !VALID_SHA.test(candidateHead)) {
        candidate.status = 'ineligible';
        candidate.reason = 'no recorded candidate head (result claims.head_commit, squash candidate_head) to bind the integration proof to';
        continue;
      }
      if (candidateHead !== tip) {
        candidate.status = 'ineligible';
        candidate.reason = `branch tip ${tip.slice(0, 12)} moved past the proven candidate head ${candidateHead.slice(0, 12)} — commits after the proof are not gc's to delete`;
        continue;
      }
      const proof = reachable[0];
      candidate.proof = {
        result: resultPath,
        integrated_sha: proof.sha,
        source: proof.source,
        candidate_head: candidateHead,
      };
      candidate.integrated_ms = Math.max(...reachable.map((r) => r.ms));

      // (3) Clean beyond the known-junk set. Ignored files count too (they
      // are only safe inside the explicit junk allowlist), and a worktree
      // whose status cannot be read is skipped, never treated as clean.
      // The output is NUL-framed so delimiter ambiguity (' -> ' in a real
      // pathname, quoting) is structurally impossible.
      if (candidate.branch_only !== true) {
        const porcelain = tryGitRaw(execFn, canonicalWorktree, [
          'status',
          '--porcelain',
          '-z',
          '-uall',
          '--ignored=matching',
        ]);
        if (porcelain === undefined) {
          candidate.status = 'skipped';
          candidate.reason = 'git status failed in worktree — cannot prove it clean';
          continue;
        }
        const { dirty, junkOnly } = classifyStatusZ(porcelain);
        if (dirty.length > 0) {
          candidate.status = 'skipped';
          candidate.reason = `worktree has uncommitted/untracked content beyond known junk: ${dirty.slice(0, 5).join(', ')}`;
          continue;
        }
        candidate.junk_only = junkOnly;

        // Eligible. Disk accounting happens before any removal.
        candidate.bytes = diskUsage(execFn, canonicalWorktree);
      }
      candidate.status = 'would-reap';
    }
  }

  // --keep-last: retain the N most recently integrated eligible tasks.
  const eligible = candidates
    .filter((c) => c.status === 'would-reap')
    .sort((a, b) => (b.integrated_ms ?? 0) - (a.integrated_ms ?? 0)
      || `${a.run_id}/${a.task_id}`.localeCompare(`${b.run_id}/${b.task_id}`));
  for (const kept of eligible.slice(0, keepLast)) {
    kept.status = 'kept';
    kept.reason = `kept by --keep-last ${keepLast}`;
  }
  const reapList = eligible.slice(keepLast);

  const totals = {
    reaped: 0,
    would_reap: 0,
    kept: 0,
    skipped: 0,
    ineligible: 0,
    errors: 0,
    bytes: 0,
  };

  if (apply) {
    for (const candidate of reapList) {
      if (candidate.branch_only !== true) {
        // Spec v4: full revalidation directly before `git worktree remove` —
        // registered branch binding, branch tip still equal to the paired
        // proven candidate head, NUL-framed cleanliness — with the --force
        // decision taken from THIS fresh read, never the scan's.
        const recheck = recheckBeforeWorktreeRemove(execFn, repoRootPath, candidate);
        if (recheck.reason !== undefined) {
          candidate.status = 'skipped';
          candidate.reason = `aborted before removal: ${recheck.reason}`;
          continue;
        }
        const removeArgs = ['worktree', 'remove'];
        if (recheck.junkOnly) removeArgs.push('--force');
        removeArgs.push(candidate.worktree);
        if (tryGit(execFn, repoRootPath, removeArgs) === undefined) {
          candidate.status = 'error';
          candidate.reason = 'git worktree remove failed';
          continue;
        }
      }
      // Spec v5: branch deletion is git's atomic compare-and-delete —
      // `git update-ref -d <ref> <expected-proven-sha>` makes GIT refuse the
      // deletion when the ref no longer points at the paired proven candidate
      // sha, closing the read-then-delete mutation window the old show-ref +
      // branch -D sequence had. Deletion is restricted to
      // hydra/<run_id>/<task_id> exactly — the ref is constructed from
      // validated ids, never read from state. The show-ref gate only
      // distinguishes "already gone, nothing to delete" from "present";
      // the atomic expected-sha check does the real safety work.
      const branchRef = `refs/heads/${candidate.branch}`;
      const expectedTip = candidate.proof?.candidate_head ?? '';
      if (tryGit(execFn, repoRootPath, ['show-ref', '--verify', '--quiet', branchRef]) !== undefined) {
        // --no-deref: update-ref dereferences symbolic refs by default, so a
        // candidate ref raced into a symref pointing at another branch (e.g.
        // main) holding the same expected SHA would delete THAT branch. The
        // flag makes git operate on the ref itself, never its target.
        if (tryGit(execFn, repoRootPath, ['update-ref', '--no-deref', '-d', branchRef, expectedTip]) === undefined) {
          // A nonzero exit is a skip with reason (spec v5), never an error:
          // the ref moved or vanished after revalidation, so the branch is no
          // longer gc's to delete.
          candidate.status = 'skipped';
          if (candidate.branch_only === true) {
            candidate.reason = `atomic branch deletion failed: git update-ref -d ${branchRef} ${expectedTip.slice(0, 12)} refused (the ref moved or vanished) — branch left in place`;
          } else {
            // The worktree is gone but the branch survived: record the
            // partial reap so a later run retries the branch cleanup.
            appendLedgerEvent(stateRootPath, candidate.run_id, 'worktree_reap_partial', {
              task_id: candidate.task_id,
              worktree: candidate.worktree,
              branch: candidate.branch,
              integration_sha: candidate.proof?.integrated_sha ?? '',
            });
            candidate.reason = `worktree removed but atomic branch deletion failed: git update-ref -d ${branchRef} at the proven candidate sha refused — worktree_reap_partial recorded; re-run gc --apply to retry the branch cleanup`;
          }
          continue;
        }
      }
      appendLedgerEvent(stateRootPath, candidate.run_id, 'worktree_reaped', {
        task_id: candidate.task_id,
        worktree: candidate.worktree,
        branch: candidate.branch,
        integration_sha: candidate.proof?.integrated_sha ?? '',
      });
      candidate.status = 'reaped';
    }
  }

  for (const candidate of candidates) {
    if (candidate.status === 'reaped') totals.reaped += 1;
    else if (candidate.status === 'would-reap') totals.would_reap += 1;
    else if (candidate.status === 'kept') totals.kept += 1;
    else if (candidate.status === 'skipped') totals.skipped += 1;
    else if (candidate.status === 'ineligible') totals.ineligible += 1;
    else if (candidate.status === 'error') totals.errors += 1;
    if ((candidate.status === 'reaped' || candidate.status === 'would-reap')
      && candidate.bytes !== undefined) {
      totals.bytes += candidate.bytes;
    }
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    default_ref: defaultRef,
    keep_last: keepLast,
    candidates,
    totals,
  };
}

export default { gc };

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function renderHuman(report: GcReport): string {
  const lines: string[] = [
    `gc: ${report.mode} (default branch: ${report.default_ref})`,
  ];
  for (const c of report.candidates) {
    const size = c.bytes !== undefined ? `, ${formatBytes(c.bytes)}` : '';
    const proof = c.proof
      ? ` — proof: ${c.proof.integrated_sha} reachable from ${report.default_ref} via ${c.proof.source}; result ${c.proof.result}`
      : '';
    const note = c.reason !== undefined && (c.status === 'would-reap' || c.status === 'reaped')
      ? ` — ${c.reason}`
      : '';
    if (c.status === 'would-reap') {
      lines.push(`would reap ${c.branch_only === true ? c.branch : c.worktree} (branch ${c.branch}${size})${proof}${note}`);
    } else if (c.status === 'reaped') {
      lines.push(`reaped ${c.branch_only === true ? c.branch : c.worktree} (branch ${c.branch}${size})${proof}${note}`);
    } else if (c.status === 'kept') {
      lines.push(`keep ${c.worktree} (branch ${c.branch}) — ${c.reason}${proof}`);
    } else {
      lines.push(`${c.status} ${c.run_id}/${c.task_id} (${c.worktree}) — ${c.reason ?? ''}`);
    }
  }
  const t = report.totals;
  if (report.mode === 'dry-run') {
    lines.push(
      `gc: ${t.would_reap} would be reaped (~${formatBytes(t.bytes)} reclaimable), `
      + `${t.kept} kept, ${t.skipped} skipped, ${t.ineligible} ineligible — re-run with --apply to remove`,
    );
  } else {
    lines.push(
      `gc: ${t.reaped} reaped (~${formatBytes(t.bytes)} reclaimed), `
      + `${t.kept} kept, ${t.skipped} skipped, ${t.ineligible} ineligible, ${t.errors} errors`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    let apply = false;
    let json = false;
    let keepLast = 0;
    let defaultBranch: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--apply') {
        apply = true;
      } else if (arg === '--json') {
        json = true;
      } else if (arg === '--keep-last') {
        const next = args[i + 1];
        if (next === undefined || !/^\d+$/.test(next)) {
          die(USAGE);
        }
        keepLast = Number(next);
        i += 1;
      } else if (arg === '--default-branch') {
        const next = args[i + 1];
        if (next === undefined || !VALID_REF.test(next) || next.includes('..')) {
          die(USAGE);
        }
        defaultBranch = next;
        i += 1;
      } else {
        die(USAGE);
      }
    }

    const report = gc({ apply, keepLast, defaultBranch });
    if (json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderHuman(report));
    }
    return report.totals.errors > 0 ? 1 : 0;
  } catch (error) {
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
