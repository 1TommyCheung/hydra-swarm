// Tests for src/gc.ts — `hydra gc`: reap worktrees and branches of
// ledger-proven-integrated tasks.
//
// Fixtures are REAL git repositories + real state roots in a tmp dir; every
// git/du invocation gc makes goes through the injected exec, which delegates
// to real execFileSync while recording calls so tests can prove that no
// removal command ever ran (dry-run, ineligibility, path-validation
// rejection). The tmp dir lives under os.tmpdir() (the status.sh.test.ts
// pattern), NOT under the checkout: worker sandboxes deny writes to nested
// .git/ paths inside the worktree, so fixture repos cannot be created there.
//
// Spec v2 (Codex review of v1) regression coverage: dirty-tree detection must
// see rename sources and ignored files beyond the junk allowlist; a
// registered worktree must be bound to its expected hydra/<run>/<task>
// branch; default-branch discovery fails closed without origin/HEAD or
// --default-branch; the branch tip must equal the recorded candidate head;
// --keep-last orders by the newest REACHABLE proof only; a partial reap
// appends worktree_reap_partial and a rerun retries the branch cleanup; ids
// are validated before ANY filesystem path construction.
//
// Spec v3 (Codex re-review of v2) regression coverage: all parsed git output
// is NUL-framed so a pathname containing the literal ' -> ' can never be
// misparsed as a rename; every reachable proof is PAIRED with its own
// candidate head (a historic reachable proof must never qualify a branch
// whose tip is a newer unintegrated retry); immediately before each
// destructive operation gc re-verifies the registered branch binding, the
// branch tip, and the cleanliness (TOCTOU); the result reader honors the
// production promoted-result envelope claims.head_commit (flat head_commit
// only as legacy fallback), and fixtures model the production shape.
//
// Spec v4 (Codex v3 re-review) regression coverage: the proof and the
// candidate head must come from the SAME evidence chain — a squash_created
// or result_promoted ledger event after an integration proof's position
// opens a newer, never-integrated generation and makes the task ineligible
// regardless of reachability; and revalidation happens immediately before
// EACH destructive operation separately — the full recheck (branch binding,
// tip, cleanliness, with the --force decision from the fresh read) directly
// before `git worktree remove`, and the branch tip verified again directly
// before `git branch -D`.
//
// Spec v5 (Codex v4 re-review) regression coverage: NO evidence borrowing,
// ever — a squash record missing its own candidate_head is incomplete
// squash evidence and makes the task INELIGIBLE (result.head_commit is
// never substituted for the missing field); and branch deletion is git's
// atomic compare-and-delete (`git update-ref -d <ref> <expected-proven-sha>`)
// replacing the show-ref + branch -D sequence — when the ref moved after
// revalidation git itself refuses, and a nonzero exit is a skip with reason
// plus worktree_reap_partial per the existing recovery path.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { gc, type ExecFunction, type GcReport } from '../src/gc.ts';
import { route, usage } from '../src/cli.ts';

const TEST_TMP = join(tmpdir(), `hydra-gc-${process.pid}`);
const SRC_DIR = join(import.meta.dirname, '..', 'src');
const GC_PATH = join(SRC_DIR, 'gc.ts');

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

interface ExecCall {
  file: string;
  args: string[];
}

interface Fixture {
  repo: string;
  stateRoot: string;
  worktreeRoot: string;
  exec: ExecFunction;
  calls: ExecCall[];
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

/** Direct git against the fixture repo (fixture setup only, never recorded). */
function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function newFixture(name: string): Fixture {
  const root = join(TEST_TMP, name);
  const repo = join(root, 'repo');
  const stateRoot = join(root, 'state');
  const worktreeRoot = join(root, 'worktrees');  mkdirSync(repo, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'hydra@test']);
  git(repo, ['config', 'user.name', 'Hydra Test']);
  writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf8');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'base commit']);

  const calls: ExecCall[] = [];
  const exec: ExecFunction = (file, args, options) => {
    calls.push({ file, args: [...args] });
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: 'pipe',
      ...options,
    }) as string;
  };

  return { repo, stateRoot, worktreeRoot, exec, calls };
}

/** A commit landing on main — reachable from the default branch. */
function commitOnMain(f: Fixture, file: string): string {
  writeFileSync(join(f.repo, file), `${file}\n`, 'utf8');
  git(f.repo, ['add', file]);
  git(f.repo, ['commit', '-m', `integrate ${file}`]);
  return git(f.repo, ['rev-parse', 'HEAD']);
}

/** A commit on a side branch that never lands on main — unreachable. */
function commitOffMain(f: Fixture, file: string): string {
  const side = `side-${file.replace(/[^a-z0-9]/gi, '')}`;
  git(f.repo, ['checkout', '-b', side, 'main']);
  writeFileSync(join(f.repo, file), `${file}\n`, 'utf8');
  git(f.repo, ['add', file]);
  git(f.repo, ['commit', '-m', `side ${file}`]);
  const sha = git(f.repo, ['rev-parse', 'HEAD']);
  git(f.repo, ['checkout', 'main']);
  return sha;
}

interface TaskFixture {
  runId: string;
  taskId: string;
  /** Write authoritative/results/<task>.json (default true). */
  result?: boolean;
  /** Result JSON shape: 'envelope' (the production promoted-result shape
   *  written by promote.ts — claims.head_commit) or 'flat' (legacy
   *  top-level head_commit). Default 'envelope'. */
  resultShape?: 'envelope' | 'flat';
  /** head_commit for the result drop: default is the registered branch tip;
   *  null omits the field entirely. */
  resultHeadCommit?: string | null;
  /** candidate_integrated ledger events to append. */
  ledgerHeads?: Array<{ sha: string; time: string }>;
  /** Write authoritative/results/<task>.squash.json with this integration_commit. */
  squashSha?: string;
  /** candidate_head for the squash record: default is the registered branch
   *  tip (when a squash record is written); null omits the field. */
  squashCandidateHead?: string | null;
  /** Create a real registered git worktree + branch (default true). */
  registeredWorktree?: boolean;
  /** Branch the worktree is registered on (default hydra/<runId>/<taskId>). */
  registeredBranch?: string;
  /** Register the worktree on a detached HEAD instead of a branch. */
  detach?: boolean;
  /** Files committed onto the registered branch inside the worktree. */
  branchFiles?: Record<string, string>;
  /** Explicit worktree path for the task spec; null omits the spec field so
   *  gc must fall back to the run-<run>-<task> convention. */
  specWorktree?: string | null;
  /** Untracked files to create inside the worktree (relative paths). */
  untracked?: string[];
}

/** The production promoted-result envelope promote.ts writes (claims.*). */
function productionResult(opts: {
  runId: string;
  taskId: string;
  branch: string;
  headCommit: string | null;
}): string {
  return `${JSON.stringify({
    claims: {
      task_id: opts.taskId,
      run_id: opts.runId,
      spec_version: 1,
      vendor: 'test',
      status: 'completed',
      branch: opts.branch,
      base_commit: '',
      ...(opts.headCommit === null ? {} : { head_commit: opts.headCommit }),
      summary: 'fixture result',
      files_changed: [],
      verification_claims: [],
      risks: [],
      unresolved_questions: [],
      suggested_additional_checks: [],
    },
    harness_observed: { verification: [] },
    divergence: false,
    promoted_at: '2024-01-01T00:00:00Z',
  })}\n`;
}

function addTask(f: Fixture, t: TaskFixture): { worktree: string; branch: string } {
  const runDir = join(f.stateRoot, 'runs', `run-${t.runId}`);
  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(join(runDir, 'authoritative', 'results'), { recursive: true });
  mkdirSync(join(runDir, 'authoritative', 'ledger'), { recursive: true });

  const branch = `hydra/${t.runId}/${t.taskId}`;
  const worktree = t.specWorktree
    ?? join(f.worktreeRoot, `run-${t.runId}-${t.taskId}`);

  if (t.registeredWorktree !== false) {
    if (t.detach === true) {
      git(f.repo, ['worktree', 'add', '--quiet', '--detach', worktree, 'main']);
    } else {
      const registeredBranch = t.registeredBranch ?? branch;
      git(f.repo, ['worktree', 'add', '--quiet', '-b', registeredBranch, worktree, 'main']);
    }
  } else {
    mkdirSync(worktree, { recursive: true });
  }

  const branchFiles = Object.entries(t.branchFiles ?? {});
  if (branchFiles.length > 0) {
    for (const [rel, content] of branchFiles) {
      const full = join(worktree, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
      git(worktree, ['add', rel]);
    }
    git(worktree, ['commit', '-m', 'task branch files']);
  }

  // The branch tip the proofs must bind to (spec v2 finding 4).
  const tip = t.registeredWorktree !== false
    ? git(worktree, ['rev-parse', 'HEAD'])
    : git(f.repo, ['rev-parse', 'main']);

  const specLines = [`task_id: ${t.taskId}`, `run_id: ${t.runId}`, `branch: ${branch}`];
  if (t.specWorktree !== null) {
    specLines.push(`worktree: ${worktree}`);
  }
  writeFileSync(join(runDir, 'tasks', `${t.taskId}.yaml`), `${specLines.join('\n')}\n`, 'utf8');

  if (t.result !== false) {
    const headCommit = t.resultHeadCommit === undefined ? tip : t.resultHeadCommit;
    const resultPath = join(runDir, 'authoritative', 'results', `${t.taskId}.json`);
    if (t.resultShape === 'flat') {
      writeFileSync(
        resultPath,
        `${JSON.stringify({
          task_id: t.taskId,
          run_id: t.runId,
          status: 'completed',
          ...(headCommit === null ? {} : { head_commit: headCommit }),
        })}\n`,
        'utf8',
      );
    } else {
      writeFileSync(
        resultPath,
        productionResult({ runId: t.runId, taskId: t.taskId, branch, headCommit }),
        'utf8',
      );
    }
  }
  if (t.squashSha !== undefined) {
    const candidateHead = t.squashCandidateHead === undefined ? tip : t.squashCandidateHead;
    writeFileSync(
      join(runDir, 'authoritative', 'results', `${t.taskId}.squash.json`),
      `${JSON.stringify({
        integration_commit: t.squashSha,
        ...(candidateHead === null ? {} : { candidate_head: candidateHead }),
      })}\n`,
      'utf8',
    );
  }
  const ledgerPath = join(runDir, 'authoritative', 'ledger', 'events.jsonl');
  for (const ev of t.ledgerHeads ?? []) {
    appendFileSync(
      ledgerPath,
      `${JSON.stringify({
        time: ev.time,
        event: 'candidate_integrated',
        run_id: t.runId,
        task_id: t.taskId,
        head: ev.sha,
      })}\n`,
      'utf8',
    );
  }
  for (const rel of t.untracked ?? []) {
    const full = join(worktree, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'junk\n', 'utf8');
  }

  return { worktree, branch };
}

function readLedger(f: Fixture, runId: string): Array<Record<string, unknown>> {
  const p = join(f.stateRoot, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Append a raw ledger event (fixture setup only) — ledger order is significant
 *  for the spec v4 same-evidence-chain rule, so tests control it explicitly. */
function appendLedger(f: Fixture, runId: string, fields: Record<string, unknown>): void {
  const p = join(f.stateRoot, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
  appendFileSync(
    p,
    `${JSON.stringify({ time: '2024-01-02T00:00:00Z', run_id: runId, ...fields })}\n`,
    'utf8',
  );
}

function branchExists(f: Fixture, branch: string): boolean {
  try {
    git(f.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Every recorded exec call that mutates state (worktree remove, or branch
 *  deletion — atomic `update-ref -d` since spec v5; `branch -D` must never
 *  appear at all). */
function removalCalls(f: Fixture): ExecCall[] {
  return f.calls.filter(
    (c) => c.file === 'git'
      && (c.args.includes('remove')
        || (c.args.includes('update-ref') && c.args.includes('-d'))
        || (c.args.includes('branch') && c.args.includes('-D'))),
  );
}

function runGc(f: Fixture, extra: Partial<Parameters<typeof gc>[0]> = {}): GcReport {
  return gc({
    cwd: f.repo,
    stateRoot: f.stateRoot,
    worktreeRoot: f.worktreeRoot,
    exec: f.exec,
    defaultBranch: 'main', // fixture clones have no origin/HEAD: pin explicitly
    ...extra,
  });
}

function onlyCandidate(report: GcReport) {
  assert.equal(report.candidates.length, 1, 'expected exactly one candidate');
  return report.candidates[0];
}

// ---------------------------------------------------------------------------

describe('gc', { concurrency: 1 }, () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('dry-run (default) reports would-reap with proof and changes nothing', () => {
    const f = newFixture('dry-run');
    const sha = commitOnMain(f, 'alpha.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0001',
      taskId: 'alpha',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      specWorktree: null, // convention path run-0001-alpha
    });

    const report = runGc(f);

    assert.equal(report.mode, 'dry-run');
    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    // gc canonicalizes validated worktree paths (realpath) before any use.
    assert.equal(c.worktree, realpathSync(worktree));
    assert.equal(c.branch, branch);
    assert.equal(c.proof?.integrated_sha, sha);
    assert.equal(c.proof?.source, 'ledger');
    assert.ok(c.proof?.result.endsWith(join('authoritative', 'results', 'alpha.json')));
    assert.ok(typeof c.bytes === 'number' && c.bytes > 0, 'du must run before removal');

    // No changes: worktree + branch survive, no removal exec, no ledger event.
    assert.ok(existsSync(worktree), 'dry-run must not remove the worktree');
    assert.ok(branchExists(f, branch), 'dry-run must not delete the branch');
    assert.deepEqual(removalCalls(f), [], 'dry-run must not exec any removal');
    assert.ok(
      !readLedger(f, '0001').some((e) => e.event === 'worktree_reaped'),
      'dry-run must not append ledger events',
    );
  });

  it('apply reaps worktree+branch and appends a worktree_reaped ledger event', () => {
    const f = newFixture('apply');
    const sha = commitOnMain(f, 'beta.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0002',
      taskId: 'beta',
      squashSha: sha,
    });
    const canonicalWorktree = realpathSync(worktree); // capture before removal

    const report = runGc(f, { apply: true });

    assert.equal(report.mode, 'apply');
    const c = onlyCandidate(report);
    assert.equal(c.status, 'reaped');
    assert.equal(c.proof?.integrated_sha, sha);
    assert.equal(c.proof?.source, 'squash_record');

    assert.ok(!existsSync(worktree), 'apply must remove the worktree');
    assert.ok(!branchExists(f, branch), 'apply must delete the branch');

    const events = readLedger(f, '0002');
    const reaped = events.find((e) => e.event === 'worktree_reaped');
    assert.ok(reaped, 'apply must append worktree_reaped');
    assert.equal(reaped.task_id, 'beta');
    assert.equal(reaped.run_id, '0002');
    assert.equal(reaped.worktree, canonicalWorktree);
    assert.equal(reaped.branch, branch);
    assert.equal(reaped.integration_sha, sha);
  });

  it('is ineligible without an authoritative result (proof missing)', () => {
    const f = newFixture('no-result');
    const sha = commitOnMain(f, 'gamma.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0003',
      taskId: 'gamma',
      result: false,
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /authoritative result/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('is ineligible without any recorded integration SHA (proof missing)', () => {
    const f = newFixture('no-sha');
    const { worktree, branch } = addTask(f, {
      runId: '0004',
      taskId: 'delta',
      // authoritative result only — no ledger head, no squash record.
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /no recorded integration SHA/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('is ineligible when no recorded SHA is reachable from the default branch', () => {
    const f = newFixture('unreachable');
    const dangling = commitOffMain(f, 'epsilon.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0005',
      taskId: 'epsilon',
      squashSha: dangling,
      ledgerHeads: [{ sha: dangling, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /reachable|ancestor/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('accepts the squash record when the ledger head is unreachable but integration_commit is on main', () => {
    const f = newFixture('squash-proof');
    const dangling = commitOffMain(f, 'zeta-side.txt');
    const integrated = commitOnMain(f, 'zeta.txt');
    addTask(f, {
      runId: '0006',
      taskId: 'zeta',
      squashSha: integrated,
      ledgerHeads: [{ sha: dangling, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f);

    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    assert.equal(c.proof?.integrated_sha, integrated);
    assert.equal(c.proof?.source, 'squash_record');
  });

  it('skips a dirty worktree (uncommitted/untracked beyond known junk) with a reason', () => {
    const f = newFixture('dirty');
    const sha = commitOnMain(f, 'eta.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0007',
      taskId: 'eta',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      untracked: ['notes.txt', 'node_modules/pkg/index.js'],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /uncommitted|untracked/);
    assert.match(c.reason ?? '', /notes\.txt/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('removes a junk-only worktree with git worktree remove --force', () => {
    const f = newFixture('junk-only');
    const sha = commitOnMain(f, 'theta.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0008',
      taskId: 'theta',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      untracked: [
        'node_modules/pkg/index.js',
        '.pnpm-store/v3/index',
        '.ffmpeg-bin/ffmpeg',
        '.hydra-result.json',
      ],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'reaped');
    assert.equal(c.junk_only, true);
    const removes = f.calls.filter(
      (call) => call.file === 'git' && call.args.includes('worktree') && call.args.includes('remove'),
    );
    assert.equal(removes.length, 1, 'exactly one worktree remove expected');
    assert.ok(removes[0].args.includes('--force'), 'junk-only removal must use --force');
    assert.ok(!existsSync(worktree));
    assert.ok(!branchExists(f, branch));
  });

  it('rejects a worktree path not registered in git worktree list (never passed to rm)', () => {
    const f = newFixture('unregistered');
    const sha = commitOnMain(f, 'iota.txt');
    const rogue = join(f.worktreeRoot, 'run-0009-iota');
    addTask(f, {
      runId: '0009',
      taskId: 'iota',
      registeredWorktree: false, // plain directory, NOT a git worktree
      specWorktree: rogue,
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });
    writeFileSync(join(rogue, 'precious.txt'), 'do not delete\n', 'utf8');

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /worktree list/);
    assert.deepEqual(removalCalls(f), [], 'unvalidated paths must never reach removal');
    assert.ok(existsSync(join(rogue, 'precious.txt')), 'rogue directory must be untouched');
  });

  it('rejects a worktree path outside the worktree root', () => {
    const f = newFixture('outside-root');
    const sha = commitOnMain(f, 'kappa.txt');
    const outside = join(TEST_TMP, 'outside-root-elsewhere');
    addTask(f, {
      runId: '0010',
      taskId: 'kappa',
      registeredWorktree: false,
      specWorktree: outside,
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /outside.*worktree root/);
    assert.deepEqual(removalCalls(f), []);
    assert.ok(existsSync(outside));
  });

  it('--keep-last retains the N most recently integrated eligible tasks across all runs', () => {
    const f = newFixture('keep-last');
    const shaOldest = commitOnMain(f, 'old.txt');
    const shaMiddle = commitOnMain(f, 'mid.txt');
    const shaNewest = commitOnMain(f, 'new.txt');
    const oldest = addTask(f, {
      runId: '0011',
      taskId: 'old',
      ledgerHeads: [{ sha: shaOldest, time: '2024-01-01T00:00:00Z' }],
    });
    const middle = addTask(f, {
      runId: '0012', // a DIFFERENT run — gc scans all runs of the state root
      taskId: 'mid',
      ledgerHeads: [{ sha: shaMiddle, time: '2024-01-03T00:00:00Z' }],
    });
    const newest = addTask(f, {
      runId: '0011',
      taskId: 'new',
      ledgerHeads: [{ sha: shaNewest, time: '2024-01-02T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true, keepLast: 2 });

    assert.equal(report.candidates.length, 3);
    const byTask = new Map(report.candidates.map((c) => [`${c.run_id}/${c.task_id}`, c]));
    assert.equal(byTask.get('0012/mid')?.status, 'kept');
    assert.equal(byTask.get('0011/new')?.status, 'kept');
    assert.equal(byTask.get('0011/old')?.status, 'reaped');

    assert.ok(existsSync(middle.worktree), 'kept worktree must survive');
    assert.ok(existsSync(newest.worktree), 'kept worktree must survive');
    assert.ok(branchExists(f, middle.branch));
    assert.ok(branchExists(f, newest.branch));
    assert.ok(!existsSync(oldest.worktree), 'oldest eligible task is reaped');
    assert.ok(!branchExists(f, oldest.branch));
  });

  it('tolerates a failing du (best-effort disk accounting)', () => {
    const f = newFixture('du-fails');
    const sha = commitOnMain(f, 'lambda.txt');
    addTask(f, {
      runId: '0013',
      taskId: 'lambda',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });
    const baseExec = f.exec;
    const noDu: ExecFunction = (file, args, options) => {
      if (file === 'du') throw new Error('du unavailable');
      return baseExec(file, args, options);
    };

    const report = runGc(f, { exec: noDu });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    assert.equal(c.bytes, undefined);
  });

  it('main --json prints a machine-readable dry-run report (child process)', () => {
    const f = newFixture('cli-json');
    const sha = commitOnMain(f, 'mu.txt');
    addTask(f, {
      runId: '0014',
      taskId: 'mu',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', GC_PATH, '--default-branch', 'main', '--json'],
      {
        encoding: 'utf8',
        cwd: f.repo,
        env: {
          ...process.env,
          HYDRA_STATE_ROOT: f.stateRoot,
          HYDRA_WORKTREE_ROOT: f.worktreeRoot,
        },
      },
    );

    assert.equal(result.status, 0, `gc --json failed: ${result.stderr}`);
    const report = JSON.parse(result.stdout) as GcReport;
    assert.equal(report.mode, 'dry-run');
    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    assert.equal(c.task_id, 'mu');
  });

  it('main rejects unknown flags and missing/invalid option values with usage', () => {
    for (const args of [
      ['--bogus'],
      ['--keep-last'],
      ['--keep-last', 'x'],
      ['--default-branch'],
      ['--default-branch', '..bad'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['--no-warnings', '--experimental-strip-types', GC_PATH, ...args],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1, `args ${args.join(' ')} must exit 1`);
      assert.ok(result.stderr.includes('usage: gc'), `usage expected for ${args.join(' ')}: ${result.stderr}`);
    }
  });

  it('cli.ts routes the gc extension subcommand and lists it in usage()', async () => {
    // Dispatch through the real default registry reaches gc's main(): a usage
    // error exit proves the extension route is wired.
    const code = await route(['gc', '--bogus']);
    assert.equal(code, 1);

    const text = usage();
    assert.ok(text.includes('  gc\n'), 'usage() must list gc');
    assert.ok(
      text.includes('[--apply] [--keep-last N] [--default-branch REF] [--json]'),
      'usage() must carry the gc signature',
    );
  });

  // -------------------------------------------------------------------------
  // Spec v2 regression tests (Codex review of v1, 5 blocking + 2 non-blocking).
  // -------------------------------------------------------------------------

  it('finding 1: a tracked file renamed INTO a junk dir still counts as dirty', () => {
    const f = newFixture('rename-into-junk');
    const sha = commitOnMain(f, 'rho.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0015',
      taskId: 'rho',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      branchFiles: { 'notes.txt': 'precious notes\n' },
    });
    // Stage a rename whose DESTINATION is inside node_modules: the source side
    // is real tracked content and must not vanish silently.
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    git(worktree, ['mv', 'notes.txt', 'node_modules/']);

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /notes\.txt/);
    assert.ok(existsSync(join(worktree, 'node_modules', 'notes.txt')));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 1: an ignored file beyond the junk allowlist counts as dirty', () => {
    const f = newFixture('ignored-beyond-junk');
    const sha = commitOnMain(f, 'sigma.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0016',
      taskId: 'sigma',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      branchFiles: { '.gitignore': 'secret.txt\n' },
    });
    writeFileSync(join(worktree, 'secret.txt'), 'do not lose\n', 'utf8');

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /secret\.txt/);
    assert.ok(existsSync(join(worktree, 'secret.txt')));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 1: ignored junk-only content is still reaped with --force', () => {
    const f = newFixture('ignored-junk-only');
    const sha = commitOnMain(f, 'tau.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0017',
      taskId: 'tau',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      branchFiles: { '.gitignore': 'node_modules/\n' },
      untracked: ['node_modules/pkg/index.js'],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'reaped');
    assert.equal(c.junk_only, true);
    const removes = f.calls.filter(
      (call) => call.file === 'git' && call.args.includes('worktree') && call.args.includes('remove'),
    );
    assert.equal(removes.length, 1);
    assert.ok(removes[0].args.includes('--force'));
    assert.ok(!existsSync(worktree));
    assert.ok(!branchExists(f, branch));
  });

  it('finding 2: skips a registered worktree whose branch is not hydra/<run>/<task>', () => {
    const f = newFixture('branch-mismatch');
    const sha = commitOnMain(f, 'ups.txt');
    const { worktree } = addTask(f, {
      runId: '0018',
      taskId: 'upsilon',
      registeredBranch: 'hydra/0018/other', // worktree registered on the WRONG branch
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /branch/);
    assert.deepEqual(removalCalls(f), [], 'a path bound to another branch must never be removed');
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, 'hydra/0018/other'));
  });

  it('finding 2: skips a registered worktree on a detached HEAD', () => {
    const f = newFixture('detached');
    const sha = commitOnMain(f, 'phi.txt');
    const { worktree } = addTask(f, {
      runId: '0019',
      taskId: 'phi',
      detach: true,
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /branch/);
    assert.deepEqual(removalCalls(f), []);
    assert.ok(existsSync(worktree));
  });

  it('finding 3: refuses to run without origin/HEAD or an explicit --default-branch', () => {
    const f = newFixture('fail-closed');
    const sha = commitOnMain(f, 'chi.txt');
    addTask(f, {
      runId: '0020',
      taskId: 'chi',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    // The fixture clone has no origin remote; defaultBranch explicitly unset.
    assert.throws(
      () => runGc(f, { defaultBranch: undefined }),
      /--default-branch/,
      'gc must fail closed with guidance instead of guessing the default branch',
    );

    // Same at the CLI surface: exit 1 with guidance on stderr.
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', GC_PATH, '--json'],
      {
        encoding: 'utf8',
        cwd: f.repo,
        env: {
          ...process.env,
          HYDRA_STATE_ROOT: f.stateRoot,
          HYDRA_WORKTREE_ROOT: f.worktreeRoot,
        },
      },
    );
    assert.equal(result.status, 1, 'gc must refuse to run');
    assert.match(result.stderr, /--default-branch/);
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 3: uses origin/HEAD when the clone has one (no flag needed)', () => {
    const f = newFixture('origin-head');
    const sha = commitOnMain(f, 'psi.txt');
    addTask(f, {
      runId: '0021',
      taskId: 'psi',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });
    git(f.repo, ['remote', 'add', 'origin', f.repo]);
    git(f.repo, ['fetch', '--quiet', 'origin']);
    git(f.repo, ['remote', 'set-head', 'origin', 'main']);

    const report = runGc(f, { defaultBranch: undefined });

    assert.equal(report.default_ref, 'origin/main');
    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
  });

  it('finding 4: is ineligible when the branch tip moved past the proven candidate', () => {
    const f = newFixture('tip-moved');
    const sha = commitOnMain(f, 'ome.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0022',
      taskId: 'omega',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });
    // Someone committed more work on the candidate branch AFTER the result
    // drop recorded its head_commit: the tip no longer matches the proof.
    writeFileSync(join(worktree, 'later.txt'), 'later work\n', 'utf8');
    git(worktree, ['add', 'later.txt']);
    git(worktree, ['commit', '-m', 'post-proof work']);

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /tip|moved/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 4: is ineligible when no candidate head is recorded to bind against', () => {
    const f = newFixture('no-bind');
    const sha = commitOnMain(f, 'ala.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0023',
      taskId: 'alabama',
      resultHeadCommit: null, // result drop carries no head_commit
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /candidate head|bind/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 4: the squash candidate_head binds when the result head_commit is stale', () => {
    const f = newFixture('squash-bind');
    const integrated = commitOnMain(f, 'alb.txt');
    const { worktree } = addTask(f, {
      runId: '0024',
      taskId: 'alberta',
      resultHeadCommit: git(f.repo, ['rev-parse', 'main~1']), // stale on purpose
      squashSha: integrated,
      // squashCandidateHead defaults to the current branch tip → binds.
    });

    const report = runGc(f);

    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    assert.equal(c.proof?.integrated_sha, integrated);
    assert.ok(existsSync(worktree));
  });

  it('finding 5: --keep-last orders by the newest REACHABLE proof, ignoring unreachable records', () => {
    const f = newFixture('keep-last-reachable');
    const reachableOld = commitOnMain(f, 'old.txt');
    const reachableMid = commitOnMain(f, 'mid.txt');
    const unreachableNew = commitOffMain(f, 'new.txt');
    const taskA = addTask(f, {
      runId: '0025',
      taskId: 'aaa',
      ledgerHeads: [
        { sha: reachableOld, time: '2024-01-01T00:00:00Z' },
        // Newest record is UNREACHABLE — it must not buy retention.
        { sha: unreachableNew, time: '2024-01-03T00:00:00Z' },
      ],
    });
    const taskB = addTask(f, {
      runId: '0025',
      taskId: 'bbb',
      ledgerHeads: [{ sha: reachableMid, time: '2024-01-02T00:00:00Z' }],
    });

    const report = runGc(f, { apply: true, keepLast: 1 });

    const byTask = new Map(report.candidates.map((c) => [c.task_id, c]));
    assert.equal(byTask.get('bbb')?.status, 'kept', 'newest REACHABLE proof wins retention');
    assert.equal(byTask.get('aaa')?.status, 'reaped');
    assert.ok(existsSync(taskB.worktree));
    assert.ok(branchExists(f, taskB.branch));
    assert.ok(!existsSync(taskA.worktree));
    assert.ok(!branchExists(f, taskA.branch));
  });

  it('spec v6: update-ref uses --no-deref so a raced symref candidate ref never deletes its target branch', () => {
    const f = newFixture('symref');
    const sha = commitOnMain(f, 'symref.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0027',
      taskId: 'sym',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    // First pass: worktree removal succeeds, branch deletion is denied —
    // leaving the branch-only cleanup for a rerun (the partial-reap path).
    const failBranchDel: ExecFunction = (file, args, options) => {
      if (file === 'git' && args.includes('update-ref') && args.includes('-d')) {
        throw new Error('update-ref -d denied');
      }
      return f.exec(file, args, options);
    };
    runGc(f, { apply: true, exec: failBranchDel });
    assert.ok(!existsSync(worktree));
    assert.ok(branchExists(f, branch));

    // Race simulation: the candidate ref becomes a SYMREF to a decoy branch
    // whose tip equals the proven sha. Revalidation (rev-parse) resolves
    // through the symref and still sees the expected tip.
    f.exec('git', ['-C', f.repo, 'branch', 'decoy-target', sha]);
    f.exec('git', ['-C', f.repo, 'symbolic-ref', `refs/heads/${branch}`, 'refs/heads/decoy-target']);

    const report = runGc(f, { apply: true });

    // Every atomic deletion must carry --no-deref, so git deletes the ref
    // itself (the symref), never its target: the decoy branch survives.
    const deletions = f.calls.filter(
      (c) => c.file === 'git' && c.args.includes('update-ref') && c.args.includes('-d'),
    );
    assert.ok(deletions.length > 0, 'an atomic deletion must have been attempted');
    for (const call of deletions) {
      assert.ok(call.args.includes('--no-deref'), `update-ref -d must carry --no-deref: ${call.args.join(' ')}`);
    }
    assert.ok(branchExists(f, 'decoy-target'), 'the symref TARGET must never be deleted');
    assert.ok(!branchExists(f, branch), 'the candidate symref itself is removed');
    const c = onlyCandidate(report);
    assert.equal(c.status, 'reaped');
  });

  it('non-blocking: records worktree_reap_partial when the atomic branch deletion fails, and a rerun retries the cleanup', () => {
    const f = newFixture('partial');
    const sha = commitOnMain(f, 'geo.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0026',
      taskId: 'georgia',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });
    const canonicalWorktree = realpathSync(worktree);
    const failBranchDel: ExecFunction = (file, args, options) => {
      if (file === 'git' && args.includes('update-ref') && args.includes('-d')) {
        throw new Error('update-ref -d denied');
      }
      return f.exec(file, args, options);
    };

    const first = runGc(f, { apply: true, exec: failBranchDel });

    const c1 = onlyCandidate(first);
    // Spec v5: a nonzero exit from the atomic compare-and-delete is a skip
    // with reason, never an error.
    assert.equal(c1.status, 'skipped');
    assert.match(c1.reason ?? '', /branch deletion|update-ref/);
    assert.ok(!existsSync(worktree), 'worktree removal succeeded');
    assert.ok(branchExists(f, branch), 'branch deletion failed');
    const events1 = readLedger(f, '0026');
    const partial = events1.find((e) => e.event === 'worktree_reap_partial');
    assert.ok(partial, 'a partial reap must be recorded');
    assert.equal(partial.task_id, 'georgia');
    assert.equal(partial.worktree, canonicalWorktree);
    assert.equal(partial.branch, branch);
    assert.equal(partial.integration_sha, sha);
    assert.ok(!events1.some((e) => e.event === 'worktree_reaped'), 'no full reap yet');

    // Rerun with a healthy exec: the worktree is already gone, so gc retries
    // the stale branch cleanup and completes the reap.
    const second = runGc(f, { apply: true });

    const c2 = onlyCandidate(second);
    assert.equal(c2.status, 'reaped');
    assert.equal(c2.branch_only, true);
    assert.ok(!branchExists(f, branch));
    assert.ok(
      readLedger(f, '0026').some((e) => e.event === 'worktree_reaped'),
      'rerun completes the reap and records it',
    );
  });

  it('non-blocking: refuses ids failing VALID_ID before any filesystem path construction', () => {
    const f = newFixture('invalid-ids');
    const sha = commitOnMain(f, 'ida.txt');
    const runDir = join(f.stateRoot, 'runs', 'run-0027');
    mkdirSync(join(runDir, 'tasks'), { recursive: true });
    mkdirSync(join(runDir, 'authoritative', 'results'), { recursive: true });
    mkdirSync(join(runDir, 'authoritative', 'ledger'), { recursive: true });
    // A traversal-shaped task id arrives via the ledger (pure data). Plant a
    // spec at the path join(runDir, 'tasks', '../escape.yaml') would resolve
    // to: if gc touched the filesystem with the unvalidated id it would read
    // this planted file.
    writeFileSync(join(runDir, 'escape.yaml'), 'worktree: /tmp/planted-by-test\n', 'utf8');
    appendFileSync(
      join(runDir, 'authoritative', 'ledger', 'events.jsonl'),
      `${JSON.stringify({
        time: '2024-01-01T00:00:00Z',
        event: 'candidate_integrated',
        run_id: '0027',
        task_id: '../escape',
        head: sha,
      })}\n`,
      'utf8',
    );
    // An invalid run directory must be skipped entirely.
    mkdirSync(join(f.stateRoot, 'runs', 'run-bad;id', 'authoritative', 'results'), { recursive: true });

    const report = runGc(f, { apply: true });

    assert.equal(report.candidates.length, 1, 'invalid run dirs produce no candidates');
    const c = report.candidates[0];
    assert.equal(c.task_id, '../escape');
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /id shape/);
    assert.notEqual(c.worktree, '/tmp/planted-by-test', 'the planted spec must never be read');
    assert.deepEqual(removalCalls(f), []);
  });

  // -------------------------------------------------------------------------
  // Spec v3 regression tests (Codex re-review of v2: 3 blocking + 1 required).
  // -------------------------------------------------------------------------

  it('finding 1: a pathname containing the literal " -> " is never misparsed as a rename', () => {
    const f = newFixture('arrow-in-name');
    const sha = commitOnMain(f, 'arr.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0028',
      taskId: 'arrow',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      // One literal top-level file whose NAME mimics a rename into a junk
      // dir. Line-based parsing splits it into two junk sides and would
      // --force-remove real content; NUL framing keeps it a single path
      // whose first segment is not junk.
      untracked: ['node_modules -> node_modules'],
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /uncommitted|untracked/);
    assert.match(c.reason ?? '', /node_modules -> node_modules/);
    assert.ok(existsSync(join(worktree, 'node_modules -> node_modules')), 'real content must survive');
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 1: a tracked file literally named "a -> b" with real content is dirty, never junk-only', () => {
    const f = newFixture('tracked-arrow');
    const sha = commitOnMain(f, 'trk.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0029',
      taskId: 'trackarrow',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
      branchFiles: { 'a -> b': 'real content\n' }, // committed on the candidate branch
    });
    // Uncommitted modification: the tracked file must classify the tree dirty.
    appendFileSync(join(worktree, 'a -> b'), 'more real content\n', 'utf8');

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /a -> b/);
    assert.notEqual(c.junk_only, true);
    assert.ok(existsSync(join(worktree, 'a -> b')));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 2: a historic reachable proof never qualifies a branch retried past it', () => {
    const f = newFixture('stale-proof');
    const integratedOld = commitOnMain(f, 'old-integration.txt');
    const danglingSquash = commitOffMain(f, 'old-squash.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0030',
      taskId: 'retry',
      branchFiles: { 'attempt1.txt': 'attempt 1\n' }, // branch tip T1 at addTask time
      // Attempt 1's artifacts: the squash record of T1 (its integration
      // commit is dangling, as commit-tree squashes are) plus the reachable
      // ledger head that integrating T1 produced. The squash record's
      // candidate_head defaults to T1.
      squashSha: danglingSquash,
      ledgerHeads: [{ sha: integratedOld, time: '2024-01-01T00:00:00Z' }],
    });
    // Retry: the branch advances to T2 and the re-promoted result envelope
    // now claims T2 — but T2 was never squashed or integrated.
    writeFileSync(join(worktree, 'attempt2.txt'), 'attempt 2\n', 'utf8');
    git(worktree, ['add', 'attempt2.txt']);
    git(worktree, ['commit', '-m', 'unintegrated retry']);
    const tip2 = git(worktree, ['rev-parse', 'HEAD']);
    writeFileSync(
      join(f.stateRoot, 'runs', 'run-0030', 'authoritative', 'results', 'retry.json'),
      productionResult({ runId: '0030', taskId: 'retry', branch, headCommit: tip2 }),
      'utf8',
    );

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /tip|moved/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 2: a legacy flat head_commit does not bind a historic proof to a retried tip', () => {
    // The exact v2 hole with the LEGACY flat result shape: v2 bound the tip
    // to the flat head_commit and would have reaped unintegrated work. v3
    // binds every proof to ITS OWN candidate head — here the stale squash
    // record's T1 — so the retried tip T2 stays ineligible.
    const f = newFixture('stale-proof-flat');
    const integratedOld = commitOnMain(f, 'old-integration.txt');
    const danglingSquash = commitOffMain(f, 'old-squash.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0031',
      taskId: 'retryflat',
      branchFiles: { 'attempt1.txt': 'attempt 1\n' },
      resultShape: 'flat',
      squashSha: danglingSquash,
      ledgerHeads: [{ sha: integratedOld, time: '2024-01-01T00:00:00Z' }],
    });
    writeFileSync(join(worktree, 'attempt2.txt'), 'attempt 2\n', 'utf8');
    git(worktree, ['add', 'attempt2.txt']);
    git(worktree, ['commit', '-m', 'unintegrated retry']);
    const tip2 = git(worktree, ['rev-parse', 'HEAD']);
    writeFileSync(
      join(f.stateRoot, 'runs', 'run-0031', 'authoritative', 'results', 'retryflat.json'),
      `${JSON.stringify({
        task_id: 'retryflat',
        run_id: '0031',
        status: 'completed',
        head_commit: tip2,
      })}\n`,
      'utf8',
    );

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /tip|moved/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('finding 3: re-verifies immediately before removal — a worktree mutated after scan is not removed', () => {
    const f = newFixture('toctou');
    const sha = commitOnMain(f, 'toc.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0032',
      taskId: 'toctou',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    // Race a mutation in the moment gc's apply phase re-checks the worktree
    // (or, on code without a re-check, the moment it attempts the removal).
    let statusCalls = 0;
    let mutated = false;
    const intruder = join(worktree, 'intruder.txt');
    const racyExec: ExecFunction = (file, args, options) => {
      if (file === 'git' && args.includes('status')) statusCalls += 1;
      const isApplyPhaseRecheck = file === 'git' && args.includes('status') && statusCalls >= 2;
      const isRemoval = file === 'git' && args.includes('worktree') && args.includes('remove');
      if (!mutated && (isApplyPhaseRecheck || isRemoval)) {
        writeFileSync(intruder, 'raced in after the scan\n', 'utf8');
        mutated = true;
      }
      return f.exec(file, args, options);
    };

    const report = runGc(f, { apply: true, exec: racyExec });

    const c = onlyCandidate(report);
    assert.ok(mutated, 'the race must actually fire');
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /since scan|changed/);
    assert.deepEqual(removalCalls(f), [], 'no removal may run after a failed re-check');
    assert.ok(existsSync(intruder), 'the raced-in file must survive');
    assert.ok(branchExists(f, branch));
    assert.ok(
      !readLedger(f, '0032').some((e) => e.event === 'worktree_reaped'),
      'an aborted candidate records no reap event',
    );
  });

  it('finding 3: a branch tip that moved after the scan aborts the reap', () => {
    const f = newFixture('toctou-tip');
    const sha = commitOnMain(f, 't2.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0033',
      taskId: 'toctoutip',
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    let revParseCalls = 0;
    let moved = false;
    const racyExec: ExecFunction = (file, args, options) => {
      if (file === 'git' && args.includes('rev-parse')) {
        revParseCalls += 1;
        // The apply-phase re-check resolves the branch tip again; move it first.
        if (!moved && revParseCalls >= 2 && args.some((a) => a.includes('hydra/0033/'))) {
          writeFileSync(join(worktree, 'sneaky.txt'), 'committed after the scan\n', 'utf8');
          git(worktree, ['add', 'sneaky.txt']);
          git(worktree, ['commit', '-m', 'raced commit']);
          moved = true;
        }
      }
      return f.exec(file, args, options);
    };

    const report = runGc(f, { apply: true, exec: racyExec });

    const c = onlyCandidate(report);
    assert.ok(moved, 'the race must actually fire');
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /since scan|moved/);
    assert.deepEqual(removalCalls(f), []);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
  });

  it('finding 4: binds via the production envelope claims.head_commit', () => {
    const f = newFixture('envelope');
    const sha = commitOnMain(f, 'env.txt');
    addTask(f, {
      runId: '0034',
      taskId: 'envelope',
      // addTask writes the production promoted-result envelope
      // (claims.head_commit = the branch tip) by default.
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f);

    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    assert.equal(c.proof?.source, 'ledger');
    assert.equal(c.proof?.candidate_head, git(f.repo, ['rev-parse', `refs/heads/${c.branch}`]));
  });

  it('finding 4: flat head_commit remains as the legacy fallback', () => {
    const f = newFixture('legacy-flat');
    const sha = commitOnMain(f, 'leg.txt');
    addTask(f, {
      runId: '0035',
      taskId: 'legacy',
      resultShape: 'flat', // legacy top-level head_commit, no claims envelope
      ledgerHeads: [{ sha, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f);

    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    assert.equal(c.proof?.source, 'ledger');
  });

  // -------------------------------------------------------------------------
  // Spec v4 regression tests (Codex v3 re-review: 2 refinements).
  // -------------------------------------------------------------------------

  it('v4 finding 1: a newer squash record after the integration proof makes the task ineligible', () => {
    const f = newFixture('v4-mixed-generation');
    const integrated = commitOnMain(f, 'old-integration.txt'); // reachable OLD proof
    const { worktree, branch } = addTask(f, {
      runId: '0040',
      taskId: 'evolve',
      branchFiles: { 'attempt1.txt': 'first attempt\n' },
      ledgerHeads: [{ sha: integrated, time: '2024-01-01T00:00:00Z' }],
      squashSha: integrated, // OLD squash record — rewritten by the retry below
    });
    // Retry: new work on the branch, then a NEWER squash record whose
    // candidate_head equals the NEW tip, with its squash_created ledger event
    // AFTER the recorded integration proof (spec v4 pinning scenario).
    writeFileSync(join(worktree, 'attempt2.txt'), 'second attempt\n', 'utf8');
    git(worktree, ['add', 'attempt2.txt']);
    git(worktree, ['commit', '-m', 'unintegrated retry']);
    const newTip = git(worktree, ['rev-parse', 'HEAD']);
    const newSquash = commitOffMain(f, 'evolve-retry.txt'); // unreachable
    writeFileSync(
      join(f.stateRoot, 'runs', 'run-0040', 'authoritative', 'results', 'evolve.squash.json'),
      `${JSON.stringify({ integration_commit: newSquash, candidate_head: newTip })}\n`,
      'utf8',
    );
    appendLedger(f, '0040', {
      event: 'squash_created',
      task_id: 'evolve',
      integration_commit: newSquash,
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /newer|post-dates|generation/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('v4 finding 1: a newer result_promoted after the integration proof makes the task ineligible', () => {
    const f = newFixture('v4-late-promote');
    const integrated = commitOnMain(f, 'promoted-integration.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0041',
      taskId: 'repromote',
      ledgerHeads: [{ sha: integrated, time: '2024-01-01T00:00:00Z' }],
    });
    // A re-promotion (a newer result generation) AFTER the recorded proof.
    appendLedger(f, '0041', {
      event: 'result_promoted',
      task_id: 'repromote',
      head: git(f.repo, ['rev-parse', `refs/heads/${branch}`]),
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /newer|post-dates|generation/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('v4 finding 1: production-order events (promote, squash, integrate) stay eligible', () => {
    const f = newFixture('v4-production-order');
    const integrated = commitOnMain(f, 'prod-order.txt');
    const { branch } = addTask(f, {
      runId: '0044',
      taskId: 'order',
      squashSha: integrated, // record on disk, candidate_head = the branch tip
    });
    const tip = git(f.repo, ['rev-parse', `refs/heads/${branch}`]);
    // The production chain, in order: result_promoted -> squash_created ->
    // candidate_integrated. Markers PRECEDE the proof, so it stays valid.
    appendLedger(f, '0044', { time: '2024-01-01T00:00:00Z', event: 'result_promoted', task_id: 'order', head: tip });
    appendLedger(f, '0044', { time: '2024-01-01T00:01:00Z', event: 'squash_created', task_id: 'order', integration_commit: integrated });
    appendLedger(f, '0044', { time: '2024-01-01T00:02:00Z', event: 'candidate_integrated', task_id: 'order', head: integrated });

    const report = runGc(f);

    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
  });

  it('v4 finding 2: a branch tip mutated between worktree remove and branch deletion survives', () => {
    const f = newFixture('v4-mid-reap-mutation');
    const integrated = commitOnMain(f, 'mid.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0042',
      taskId: 'midreap',
      ledgerHeads: [{ sha: integrated, time: '2024-01-01T00:00:00Z' }],
    });
    const racedTip = commitOffMain(f, 'raced-tip.txt');
    const provenTip = git(f.repo, ['rev-parse', `refs/heads/${branch}`]);
    let removed = false;
    const racyExec: ExecFunction = (file, args, options) => {
      const isRemove = file === 'git' && args.includes('worktree') && args.includes('remove');
      const out = f.exec(file, args, options);
      if (isRemove && !removed) {
        removed = true;
        // Race: the branch gains a commit in the window between the worktree
        // removal and the branch deletion.
        git(f.repo, ['branch', '-f', branch, racedTip]);
      }
      return out;
    };

    const report = runGc(f, { apply: true, exec: racyExec });

    const c = onlyCandidate(report);
    assert.ok(removed, 'the race must actually fire');
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /branch deletion|tip/);
    assert.ok(!existsSync(worktree), 'the worktree removal already happened');
    assert.ok(branchExists(f, branch), 'the moved branch must survive');
    assert.equal(git(f.repo, ['rev-parse', `refs/heads/${branch}`]), racedTip);
    // Spec v5: the atomic compare-and-delete ran ONCE with the PRE-race
    // proven sha, so git itself refused after the ref moved — and no
    // branch -D ever ran.
    const updateRefs = f.calls.filter((call) => call.file === 'git' && call.args.includes('update-ref'));
    assert.equal(updateRefs.length, 1, 'exactly one atomic branch deletion attempt');
    assert.ok(
      updateRefs[0].args.includes(provenTip),
      'update-ref -d must carry the expected proven sha',
    );
    assert.ok(!removalCalls(f).some((call) => call.args.includes('-D')), 'no branch -D may run');
    assert.ok(
      readLedger(f, '0042').some((e) => e.event === 'worktree_reap_partial'),
      'a refused atomic deletion records worktree_reap_partial per the recovery path',
    );
    assert.ok(
      !readLedger(f, '0042').some((e) => e.event === 'worktree_reaped'),
      'an aborted branch deletion records no reap event',
    );

    // A rerun must NOT reap the moved branch: the tip no longer equals the
    // proven candidate head, so the partial-cleanup retry stays ineligible.
    const second = runGc(f, { apply: true });
    const c2 = onlyCandidate(second);
    assert.equal(c2.status, 'ineligible');
    assert.match(c2.reason ?? '', /tip|moved/);
    assert.ok(branchExists(f, branch));
  });

  it('v4 finding 2: junk added between scan and remove is reclassified by the pre-remove recheck', () => {
    const f = newFixture('v4-junk-race');
    const integrated = commitOnMain(f, 'junk-race.txt');
    const { worktree } = addTask(f, {
      runId: '0043',
      taskId: 'junkrace',
      ledgerHeads: [{ sha: integrated, time: '2024-01-01T00:00:00Z' }],
    });
    let statusCalls = 0;
    let junked = false;
    const racyExec: ExecFunction = (file, args, options) => {
      if (file === 'git' && args.includes('status')) {
        statusCalls += 1;
        if (statusCalls === 2 && !junked) {
          // After the scan's status read, before the pre-remove recheck's read.
          mkdirSync(join(worktree, 'node_modules', '.bin'), { recursive: true });
          writeFileSync(join(worktree, 'node_modules', '.bin', 'junk.js'), 'junk\n', 'utf8');
          junked = true;
        }
      }
      return f.exec(file, args, options);
    };

    const report = runGc(f, { apply: true, exec: racyExec });

    const c = onlyCandidate(report);
    assert.ok(junked, 'the race must actually fire');
    assert.equal(c.status, 'reaped');
    assert.equal(c.junk_only, false, 'the scan saw a clean worktree');
    const removes = removalCalls(f).filter((call) => call.args.includes('remove'));
    assert.equal(removes.length, 1);
    assert.ok(
      removes[0].args.includes('--force'),
      'the --force decision must come from the fresh pre-remove recheck, never the scan',
    );
    assert.ok(!existsSync(worktree));
  });

  // -------------------------------------------------------------------------
  // Spec v5 regression tests (Codex v4 re-review: 2 residuals).
  // -------------------------------------------------------------------------

  it('v5 finding 1: a squash record missing its own candidate_head is incomplete evidence — never reap', () => {
    // The exact v5 pinning scenario: squash record WITHOUT candidate_head +
    // a reachable integration sha + the branch tip equal to the result
    // envelope's head_commit => must NOT reap. v4 borrowed result.head_commit
    // for the missing candidate_head and reaped; v5 refuses.
    const f = newFixture('v5-no-borrow');
    const integrated = commitOnMain(f, 'borrow.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0050',
      taskId: 'borrow',
      squashSha: integrated, // reachable integration_commit...
      squashCandidateHead: null, // ...but the record lacks its own candidate_head
      // The result envelope's head_commit defaults to the branch tip — the
      // exact borrowing trap.
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /incomplete squash evidence/);
    assert.ok(existsSync(worktree), 'an incomplete squash record must never be reaped');
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('v5 finding 1: a reachable ledger proof does not rescue an incomplete squash record either', () => {
    const f = newFixture('v5-no-borrow-ledger');
    const integrated = commitOnMain(f, 'borrowledger.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0051',
      taskId: 'borrowledger',
      ledgerHeads: [{ sha: integrated, time: '2024-01-01T00:00:00Z' }],
      squashSha: integrated,
      squashCandidateHead: null, // the generation's record exists but is incomplete
    });

    const report = runGc(f, { apply: true });

    const c = onlyCandidate(report);
    assert.equal(c.status, 'ineligible');
    assert.match(c.reason ?? '', /incomplete squash evidence/);
    assert.ok(existsSync(worktree));
    assert.ok(branchExists(f, branch));
    assert.deepEqual(removalCalls(f), []);
  });

  it('v5 finding 1: a ledger-only proof (no squash record at all) still binds via the result envelope', () => {
    // Guard against overreach: the no-borrowing rule targets a record that
    // EXISTS but is incomplete. With no record on disk the production
    // ledger-proof path (claims.head_commit binding) is unchanged.
    const f = newFixture('v5-ledger-only');
    const integrated = commitOnMain(f, 'ledgeronly.txt');
    addTask(f, {
      runId: '0052',
      taskId: 'ledgeronly',
      ledgerHeads: [{ sha: integrated, time: '2024-01-01T00:00:00Z' }],
    });

    const report = runGc(f);

    const c = onlyCandidate(report);
    assert.equal(c.status, 'would-reap');
    assert.equal(c.proof?.source, 'ledger');
  });

  it('v5 finding 2: branch deletion is git\'s atomic compare-and-delete carrying the expected proven sha', () => {
    // The v5 pinning scenario: injected exec simulates the ref moving after
    // revalidation (update-ref -d fails); asserts update-ref -d is invoked
    // WITH the expected proven sha and that its failure aborts the branch
    // deletion.
    const f = newFixture('v5-atomic');
    const integrated = commitOnMain(f, 'atomic.txt');
    const { worktree, branch } = addTask(f, {
      runId: '0053',
      taskId: 'atomic',
      ledgerHeads: [{ sha: integrated, time: '2024-01-01T00:00:00Z' }],
    });
    const provenTip = git(f.repo, ['rev-parse', `refs/heads/${branch}`]);
    const updateRefCalls: string[][] = [];
    const failUpdateRef: ExecFunction = (file, args, options) => {
      if (file === 'git' && args.includes('update-ref')) {
        updateRefCalls.push([...args]);
        throw new Error('simulated ref move: update-ref -d refused');
      }
      return f.exec(file, args, options);
    };

    const report = runGc(f, { apply: true, exec: failUpdateRef });

    const c = onlyCandidate(report);
    assert.equal(updateRefCalls.length, 1, 'exactly one atomic branch deletion attempt');
    const at = updateRefCalls[0].indexOf('update-ref');
    assert.deepEqual(
      updateRefCalls[0].slice(at),
      ['update-ref', '--no-deref', '-d', `refs/heads/${branch}`, provenTip],
      'update-ref -d must be invoked WITH the expected proven sha',
    );
    assert.ok(
      !f.calls.some((call) => call.file === 'git' && call.args.includes('branch') && call.args.includes('-D')),
      'branch -D must never run (spec v5)',
    );
    // The nonzero exit aborts the branch deletion: a skip with reason (never
    // an error), the partial recorded per the existing recovery path, the
    // worktree already removed, and the branch left in place.
    assert.equal(c.status, 'skipped');
    assert.match(c.reason ?? '', /branch deletion|update-ref/);
    assert.ok(!existsSync(worktree), 'the worktree removal already happened');
    assert.ok(branchExists(f, branch), 'the refused branch deletion leaves the branch in place');
    const events = readLedger(f, '0053');
    assert.ok(events.some((e) => e.event === 'worktree_reap_partial'), 'partial recorded per the recovery path');
    assert.ok(!events.some((e) => e.event === 'worktree_reaped'));
  });
});
