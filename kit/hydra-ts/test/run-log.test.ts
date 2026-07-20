import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  escapeMarkdown,
  main,
  runLog,
  type ExecFunction,
} from '../src/run-log.ts';
import { recordReview } from '../src/record-review.ts';
import { publishVerdict } from '../src/review-store.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-run-log');
const RUN_LOG_SH = join(import.meta.dirname, '../../hydra/scripts/run-log.sh');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
}

function makeDir(id: string, kind: string): string {
  const dir = join(TEST_TMP, `${kind}-${id}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Stub exec: the only external call run-log makes is the repo-root probe. */
function repoExec(repoRoot: string): ExecFunction {
  return (_file: string, args: string[]) => {
    if (args.includes('rev-parse')) return `${repoRoot}\n`;
    throw new Error(`unexpected exec: ${args.join(' ')}`);
  };
}

function writeLedger(root: string, runId: string, entries: Record<string, unknown>[]): void {
  const ledgerPath = join(root, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
  mkdirSync(join(ledgerPath, '..'), { recursive: true });
  writeFileSync(ledgerPath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

/** Write a ledger verbatim (including malformed lines) for anomaly tests. */
function writeRawLedger(root: string, runId: string, raw: string): void {
  const ledgerPath = join(root, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
  mkdirSync(join(ledgerPath, '..'), { recursive: true });
  writeFileSync(ledgerPath, raw, 'utf8');
}

function writeRunYaml(root: string, runId: string, baseCommit: string): void {
  const dir = join(root, 'runs', `run-${runId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'run.yaml'),
    `run_id: "${runId}"\nbase_commit: ${baseCommit}\nstate: done\n`,
    'utf8',
  );
}

function writeTaskSpec(
  root: string,
  runId: string,
  taskId: string,
  fields: Record<string, string>,
): void {
  const dir = join(root, 'runs', `run-${runId}`, 'tasks');
  mkdirSync(dir, { recursive: true });
  const body = Object.entries({ task_id: taskId, run_id: runId, ...fields })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(join(dir, `${taskId}.yaml`), `${body}\n`, 'utf8');
}

/** Distinct 40-hex reviewed heads for append-only generation filenames. */
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);

function reviewsDirFor(root: string, runId: string, taskId: string): string {
  return join(root, 'runs', `run-${runId}`, 'authoritative', 'reviews', taskId);
}

/**
 * Write one append-only review generation directly at the real store layout:
 * authoritative/reviews/<task>/<seq>-<head>.json. This is the durable
 * "file-only generation" shape — a verdict that reached disk without any
 * ledger append (crash between publish and ledger write).
 *
 * The document self-identifies with `task_id` by default, exactly as every
 * generation published through record-review does. Pass an explicit
 * `task_id` in `review` to simulate a misfiled generation, or
 * `task_id: undefined` for one with no identity at all.
 */
function writeReviewGeneration(
  root: string,
  runId: string,
  taskId: string,
  seq: number,
  head: string,
  review: Record<string, unknown>,
): string {
  const dir = reviewsDirFor(root, runId, taskId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(seq).padStart(4, '0')}-${head}.json`);
  writeFileSync(path, `${JSON.stringify({ task_id: taskId, ...review })}\n`, 'utf8');
  return path;
}

function writeSquash(root: string, runId: string, taskId: string, record: Record<string, unknown>): void {
  const dir = join(root, 'runs', `run-${runId}`, 'authoritative', 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.squash.json`), `${JSON.stringify(record)}\n`, 'utf8');
}

/**
 * The REAL promoted-record envelope the promote lane writes at
 * authoritative/results/<task>.json: the worker claims nested under `claims`
 * (task identity lives at claims.task_id — there is no top-level task_id),
 * plus harness-observed verification, the divergence flag and the timestamp.
 */
function promotedRecord(taskId: string, runId: string): Record<string, unknown> {
  return {
    claims: {
      task_id: taskId,
      run_id: runId,
      spec_version: 1,
      vendor: 'codex',
      status: 'completed',
      branch: `hydra/${runId}/${taskId}`,
      base_commit: `base-${runId}`,
      head_commit: `head-${taskId}`,
      summary: 'worker claims record',
      files_changed: [],
      verification_claims: [],
      risks: [],
      unresolved_questions: [],
      suggested_additional_checks: [],
    },
    harness_observed: { verification: [] },
    divergence: false,
    promoted_at: '2026-07-14T00:01:05Z',
  };
}

/** The promote lane's authoritative result record (authoritative/results/<task>.json). */
function writePromotedResult(root: string, runId: string, taskId: string): void {
  const dir = join(root, 'runs', `run-${runId}`, 'authoritative', 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}.json`), `${JSON.stringify(promotedRecord(taskId, runId))}\n`, 'utf8');
}

function writeUsage(root: string, entries: Record<string, unknown>[]): void {
  const dir = join(root, 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'usage.jsonl'),
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
    'utf8',
  );
}

function captureStdout<T>(fn: () => T): { output: string; result: T } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = fn();
    return { output: chunks.join(''), result };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function captureStderr<T>(fn: () => T): { output: string; result: T } {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = fn();
    return { output: chunks.join(''), result };
  } finally {
    process.stderr.write = originalWrite;
  }
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** A complete lifecycle: dispatch -> promote -> review -> squash -> integrate -> reap. */
function fullLifecycleFixture(): { runId: string; stateRoot: string; repoRoot: string } {
  const runId = 'full';
  const stateRoot = makeDir(runId, 'state');
  const repoRoot = makeDir(runId, 'repo');
  writeRunYaml(stateRoot, runId, 'base111full');
  writeTaskSpec(stateRoot, runId, 'task-a', {
    assigned_vendor: 'codex',
    spec_version: '1',
  });
  writeLedger(stateRoot, runId, [
    { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: 'base111full' },
    { time: '2026-07-14T00:00:01Z', event: 'heads_detected', run_id: runId, available: 'claude,codex', count: '2' },
    { time: '2026-07-14T00:00:02Z', event: 'task_started', run_id: runId, task_id: 'task-a', vendor: 'codex', agent_run_id: 'full-task-a-v1', dispatch_instance_id: 'iid-full-a-1', delivery: 'start' },
    { time: '2026-07-14T00:01:04Z', event: 'agent_exited', run_id: runId, task_id: 'task-a', vendor: 'codex', agent_run_id: 'full-task-a-v1', dispatch_instance_id: 'iid-full-a-1', exit_code: '0' },
    { time: '2026-07-14T00:01:05Z', event: 'result_promoted', run_id: runId, task_id: 'task-a', head: 'headaaa123', divergence: 'false' },
    { time: '2026-07-14T00:01:06Z', event: 'review_verdict', run_id: runId, task_id: 'task-a', verdict: 'accept', reviewer: 'claude', risk: 'low' },
    { time: '2026-07-14T00:01:07Z', event: 'squash_created', run_id: runId, task_id: 'task-a', integration_commit: 'squashaaa' },
    { time: '2026-07-14T00:01:08Z', event: 'candidate_integrated', run_id: runId, task_id: 'task-a', head: 'integrated123' },
    { time: '2026-07-14T00:01:09Z', event: 'worktree_reaped', run_id: runId, task_id: 'task-a', path: '/tmp/wt-full-task-a' },
  ]);
  // The ledger promotion and the authoritative result file agree: no divergence.
  writePromotedResult(stateRoot, runId, 'task-a');
  writeReviewGeneration(stateRoot, runId, 'task-a', 1, HEAD_A, { verdict: 'accept', reviewer: 'claude', risk: 'low' });
  writeSquash(stateRoot, runId, 'task-a', {
    candidate_head: 'headaaa123',
    integration_commit: 'squashaaa',
    source_commits: ['c1', 'c2'],
  });
  writeUsage(stateRoot, [
    { run_id: runId, vendor: 'claude', time: '2026-07-14T00:00:10Z', cost_usd: 0.1, tokens_out: 1000 },
    { run_id: runId, vendor: 'claude', time: '2026-07-14T00:00:20Z', cost_usd: 0.25, tokens_out: 500 },
    { run_id: runId, vendor: 'codex', time: '2026-07-14T00:00:30Z', cost_usd: 0.05, tokens_out: 100 },
    // Records for other runs, and untagged legacy rows, must not leak into
    // this run's aggregate.
    { run_id: 'other-run', vendor: 'claude', time: '2026-07-14T00:00:40Z', cost_usd: 99, tokens_out: 99999 },
    { vendor: 'claude', time: '2026-07-14T00:00:50Z', cost_usd: 50, tokens_out: 50000 },
  ]);
  return { runId, stateRoot, repoRoot };
}

/** A run still in flight: a rejection, an amendment, a redispatch, a loop suspicion. */
function inFlightFixture(): { runId: string; stateRoot: string; repoRoot: string } {
  const runId = 'flight';
  const stateRoot = makeDir(runId, 'state');
  const repoRoot = makeDir(runId, 'repo');
  writeRunYaml(stateRoot, runId, 'base222flight');
  writeTaskSpec(stateRoot, runId, 'task-b', {
    assigned_vendor: 'kimi',
    spec_version: '2',
  });
  writeLedger(stateRoot, runId, [
    { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: 'base222flight' },
    { time: '2026-07-14T00:00:05Z', event: 'task_started', run_id: runId, task_id: 'task-b', vendor: 'kimi', agent_run_id: 'flight-task-b-v1', dispatch_instance_id: 'iid-flight-b-1', delivery: 'start' },
    { time: '2026-07-14T00:10:05Z', event: 'agent_timed_out', run_id: runId, task_id: 'task-b', vendor: 'kimi', agent_run_id: 'flight-task-b-v1', dispatch_instance_id: 'iid-flight-b-1', reason: 'stalled', idle_sec: '30' },
    { time: '2026-07-14T00:10:06Z', event: 'result_rejected', run_id: runId, task_id: 'task-b', reason: 'verification_failed', detail: 'harness re-run did not pass; see /x/y.json' },
    { time: '2026-07-14T00:10:07Z', event: 'task_spec_amended', run_id: runId, task_id: 'task-b', from: 'v1', to: 'v2', delivery: 'restart', reason: 'tighten spec' },
    { time: '2026-07-14T00:10:08Z', event: 'task_started', run_id: runId, task_id: 'task-b', vendor: 'kimi', agent_run_id: 'flight-task-b-v2', dispatch_instance_id: 'iid-flight-b-2', delivery: 'restart' },
    { time: '2026-07-14T00:12:00Z', event: 'agent_loop_suspected', run_id: runId, task_id: 'task-b', vendor: 'kimi', agent_run_id: 'flight-task-b-v2', dispatch_instance_id: 'iid-flight-b-2', dominant_action_hash: 'hashabc' },
  ]);
  return { runId, stateRoot, repoRoot };
}

/** Ledger values carrying markdown/HTML metacharacters — pure data, must be neutralized. */
function hostileFixture(): { runId: string; stateRoot: string; repoRoot: string } {
  const runId = 'hostile';
  const stateRoot = makeDir(runId, 'state');
  const repoRoot = makeDir(runId, 'repo');
  writeRunYaml(stateRoot, runId, 'base333hostile');
  writeTaskSpec(stateRoot, runId, 'task-c', {
    assigned_vendor: 'cod`ex|<i>',
    spec_version: '1',
  });
  writeLedger(stateRoot, runId, [
    { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: 'base333hostile' },
    { time: '2026-07-14T00:00:05Z', event: 'task_started', run_id: runId, task_id: 'task-c', vendor: 'cod`ex|<i>', agent_run_id: 'hostile-task-c-v1', delivery: 'start' },
    { time: '2026-07-14T00:01:00Z', event: 'result_rejected', run_id: runId, task_id: 'task-c', reason: 'schema_invalid', detail: 'bad `code` | pipe <script>alert(1)</script> & "quoted" \u001b[1;31mRED\u001b[0m' },
  ]);
  return { runId, stateRoot, repoRoot };
}

// ---------------------------------------------------------------------------
// escapeMarkdown — the pure escaping helper.
// ---------------------------------------------------------------------------

describe('escapeMarkdown', () => {
  it('leaves plain text untouched', () => {
    assert.equal(escapeMarkdown('plain text 123'), 'plain text 123');
  });

  it('escapes pipes so table cells cannot be broken', () => {
    assert.equal(escapeMarkdown('a|b'), 'a\\|b');
  });

  it('replaces backticks outright — backslash is rendered literally inside code spans, so it cannot neutralize them', () => {
    assert.equal(escapeMarkdown('a`b'), "a'b");
    const escaped = escapeMarkdown('x` — **bold** `y');
    assert.ok(!escaped.includes('`'), escaped);
  });

  it('neutralizes HTML by escaping angle brackets and ampersands without double-escaping', () => {
    assert.equal(escapeMarkdown('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeMarkdown('a & b'), 'a &amp; b');
    assert.equal(escapeMarkdown('&lt;'), '&amp;lt;');
  });

  it('escapes emphasis, link brackets and literal backslashes', () => {
    assert.equal(escapeMarkdown('*x* _y_ [z]'), '\\*x\\* \\_y\\_ \\[z\\]');
    assert.equal(escapeMarkdown('a\\b'), 'a\\\\b');
  });

  it('collapses newlines so a hostile value cannot break a table row or list item', () => {
    assert.equal(escapeMarkdown('line1\nline2\r\nline3'), 'line1 line2 line3');
  });

  it('strips ANSI/OSC escape sequences and all remaining C0/C1 control bytes', () => {
    assert.equal(escapeMarkdown('\u001b[1;31mALERT\u001b[0m'), 'ALERT');
    assert.equal(escapeMarkdown('\u001b]8;;https://evil.example\u0007click\u001b]8;;\u001b\\'), 'click');
    assert.equal(escapeMarkdown('a\u0000b\u0001c\u007fd\u0080\u009fe'), 'abcde');
    assert.equal(escapeMarkdown('lone \u001b escape'), 'lone  escape');
    assert.equal(escapeMarkdown('a\tb'), 'a b');
  });
});

// ---------------------------------------------------------------------------
// Full-lifecycle run.
// ---------------------------------------------------------------------------

describe('runLog full-lifecycle run', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('renders header, lifecycle table, timeline, usage and notes from state', () => {
    const { runId, stateRoot, repoRoot } = fullLifecycleFixture();
    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    const md = result.markdown;

    // (1) run header.
    assert.ok(md.includes('# Hydra-Swarm run log — run `full`'), md);
    assert.ok(md.includes('| Run ID | `full` |'), md);
    assert.ok(md.includes('| Base commit | `base111full` |'), md);
    assert.ok(md.includes('| Run started | 2026-07-14T00:00:00Z |'), md);
    assert.ok(md.includes('| Last event | 2026-07-14T00:01:09Z |'), md);
    assert.ok(md.includes('| Wall-clock span | 1m 9s |'), md);
    assert.ok(md.includes('| Heads detected | claude,codex (2) |'), md);

    // (2) per-task lifecycle row.
    assert.ok(md.includes('| `task-a` | codex | v1 |'), md);
    assert.ok(
      md.includes('1. started 2026-07-14T00:00:02Z — ended 2026-07-14T00:01:04Z — exit 0'),
      md,
    );
    assert.ok(md.includes('promoted head=`headaaa123` (divergence=false)'), md);
    assert.ok(md.includes('accept (reviewer=claude, risk=low)'), md);
    assert.ok(md.includes('integration_commit=`squashaaa`'), md);
    assert.ok(md.includes('| `integrated123` |'), md);
    assert.ok(md.includes('2026-07-14T00:01:09Z (path=/tmp/wt-full-task-a)'), md);

    // (3) event timeline, chronological. Event names are ledger data too, so
    // their underscores are escaped like every other value.
    assert.ok(
      md.includes('- `2026-07-14T00:00:02Z` **task\\_started** (task `task-a`) — vendor=codex'),
      md,
    );
    assert.ok(
      md.indexOf('**task\\_started**') < md.indexOf('**agent\\_exited**')
        && md.indexOf('**agent\\_exited**') < md.indexOf('**worktree\\_reaped**'),
      `timeline out of order:\n${md}`,
    );

    // (4) usage aggregate per vendor + notes. Only this run's usage records
    // count; the foreign and untagged fixture rows must not leak in.
    assert.ok(md.includes('| claude | 2 | 0.35 | 0.25 | 1500 |'), md);
    assert.ok(md.includes('| codex | 1 | 0.05 | 0.05 | 100 |'), md);
    assert.ok(!md.includes('99999'), md);
    assert.ok(md.includes('- Unresolved divergence flags: (none recorded)'), md);

    // Clean ledger + a tree that agrees with it: explicit empty sections.
    assert.ok(md.includes('## Ledger anomalies\n\n(none recorded)'), md);
    assert.ok(md.includes('- Ledger/tree reconciliation: (none recorded)'), md);
    assert.deepEqual(result.data.ledger_anomalies, []);
    assert.deepEqual(result.data.reconciliation, []);
  });

  it('writes the markdown to the default docs/hydra-dev-logs path under the repo root', () => {
    const { runId, stateRoot, repoRoot } = fullLifecycleFixture();
    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    const expectedDir = join(repoRoot, 'docs', 'hydra-dev-logs');
    // The written path is the canonical (realpath) form of the default dir.
    assert.equal(result.outPath, join(realpathSync(expectedDir), 'run-full.md'));
    assert.equal(readFileSync(join(expectedDir, 'run-full.md'), 'utf8'), result.markdown);
  });
});

// ---------------------------------------------------------------------------
// In-flight run with rejections: partial log must still be a faithful snapshot.
// ---------------------------------------------------------------------------

describe('runLog in-flight run with rejections', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('renders attempts, rejection, amendment, loop signal and explicit gaps', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    const md = result.markdown;

    assert.ok(md.includes('| Base commit | `base222flight` |'), md);
    assert.ok(md.includes('| Wall-clock span | 12m 0s |'), md);
    assert.ok(md.includes('| Heads detected | (none recorded) |'), md);

    // Two attempts: first timed out, second still in flight.
    assert.ok(
      md.includes('1. started 2026-07-14T00:00:05Z — ended 2026-07-14T00:10:05Z — timed out (reason=stalled)'),
      md,
    );
    assert.ok(md.includes('2. started 2026-07-14T00:10:08Z — in flight'), md);

    // Spec version from the (amended) task spec, plus the amendment record.
    assert.ok(md.includes('| `task-b` | kimi | v2<br>amended v1 → v2 (restart): tighten spec |'), md);

    // Timeout + loop signals (signal detail keeps every ledger field; the
    // underscores in event names and keys are escaped as data).
    assert.ok(
      md.includes('agent\\_timed\\_out (vendor=kimi  agent\\_run\\_id=flight-task-b-v1  dispatch\\_instance\\_id=iid-flight-b-1  reason=stalled  idle\\_sec=30)'),
      md,
    );
    assert.ok(
      md.includes('agent\\_loop\\_suspected (vendor=kimi  agent\\_run\\_id=flight-task-b-v2  dispatch\\_instance\\_id=iid-flight-b-2  dominant\\_action\\_hash=hashabc)'),
      md,
    );

    // Rejection with reason + detail.
    assert.ok(
      md.includes('rejected verification\\_failed — harness re-run did not pass; see /x/y.json (2026-07-14T00:10:06Z)'),
      md,
    );

    // Nothing promoted / reviewed / squashed / integrated / reaped yet: the row
    // must show explicit "(none recorded)" gaps, not omissions.
    const row = md.split('\n').find((line) => line.startsWith('| `task-b` |'));
    assert.ok(row !== undefined, md);
    assert.ok(row.includes('rejected verification\\_failed'), row);
    assert.ok((row.match(/\(none recorded\)/g) ?? []).length >= 4, row);

    // No usage file -> explicit gap, not omission.
    assert.ok(md.includes('## Usage\n\n(none recorded)'), md);

    // JSON data mirrors the same partial state.
    assert.equal(result.data.tasks.length, 1);
    assert.equal(result.data.tasks[0].attempts.length, 2);
    assert.equal(result.data.tasks[0].attempts[1].exit, null);
    assert.equal(result.data.tasks[0].promote.promoted, false);
    assert.equal(result.data.tasks[0].promote.rejections.length, 1);
    assert.equal(result.data.usage, null);
    assert.equal(result.data.heads_detected, null);
    assert.equal(result.data.wall_clock_seconds, 720);
  });
});

// ---------------------------------------------------------------------------
// Hostile ledger values: escaped, never rendered as markup.
// ---------------------------------------------------------------------------

describe('runLog markdown escaping of hostile ledger values', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('neutralizes backticks, pipes, HTML and control sequences in specs, ledger details and timeline', () => {
    const { runId, stateRoot, repoRoot } = hostileFixture();
    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    const md = result.markdown;

    assert.ok(!md.includes('<script>'), md);
    assert.ok(!md.includes('</script>'), md);
    assert.ok(md.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), md);
    // Backticks are replaced (never backslash-escaped), pipes escaped.
    assert.ok(md.includes("bad 'code' \\| pipe"), md);
    assert.ok(md.includes("cod'ex\\|&lt;i&gt;"), md);
    assert.ok(md.includes('&amp;'), md);
    // The ANSI color sequence in the rejection detail is stripped, not rendered.
    assert.ok(!md.includes('\u001b'), md);
    assert.ok(md.includes('RED'), md);
    // The raw pipe in the vendor/rejection detail must not leak unescaped into a table row.
    const taskRow = md.split('\n').find((line) => line.startsWith('| `task-c` |'));
    assert.ok(taskRow !== undefined, md);
    assert.ok(!taskRow.includes('ex|<'), taskRow);
  });
});

// ---------------------------------------------------------------------------
// Output directory resolution: --out option and HYDRA_DEV_LOG_DIR.
// ---------------------------------------------------------------------------

describe('runLog output directory resolution', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('honors HYDRA_DEV_LOG_DIR and gives the --out option precedence', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    const envDir = makeDir(runId, 'env-logs');
    const optDir = makeDir(runId, 'opt-logs');

    const previous = process.env.HYDRA_DEV_LOG_DIR;
    process.env.HYDRA_DEV_LOG_DIR = envDir;
    try {
      const viaEnv = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
      assert.equal(viaEnv.outPath, join(envDir, 'run-flight.md'));
      assert.ok(existsSync(join(envDir, 'run-flight.md')));

      const viaOption = runLog(runId, {
        cwd: repoRoot,
        stateRoot,
        exec: repoExec(repoRoot),
        outDir: optDir,
      });
      assert.equal(viaOption.outPath, join(optDir, 'run-flight.md'));
      assert.ok(existsSync(join(optDir, 'run-flight.md')));
    } finally {
      if (previous === undefined) delete process.env.HYDRA_DEV_LOG_DIR;
      else process.env.HYDRA_DEV_LOG_DIR = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// --json mode.
// ---------------------------------------------------------------------------

describe('run-log --json', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('prints the structured data as JSON to stdout and writes no markdown file', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    const options = { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) };
    const { output, result: code } = captureStdout(() => main([runId, '--json'], options));
    assert.equal(code, 0);

    const data = JSON.parse(output) as Record<string, unknown>;
    assert.equal(data.run_id, 'flight');
    assert.equal(data.base_commit, 'base222flight');
    assert.equal(data.run_started, '2026-07-14T00:00:00Z');
    assert.equal(data.wall_clock_seconds, 720);
    assert.equal(data.heads_detected, null);
    assert.equal(data.usage, null);

    const tasks = data.tasks as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].task_id, 'task-b');
    assert.equal(tasks[0].vendor, 'kimi');
    assert.equal(tasks[0].spec_version, '2');
    assert.equal((tasks[0].attempts as unknown[]).length, 2);
    assert.equal((data.timeline as unknown[]).length, 7);

    // --json must not create the default output tree.
    assert.ok(!existsSync(join(repoRoot, 'docs')), 'no markdown written in --json mode');
  });

  it('markdown mode main prints the written path to stdout', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    const outDir = makeDir(runId, 'main-out');
    const options = { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), outDir };
    const { output, result: code } = captureStdout(() => main([runId, '--out', outDir], options));
    assert.equal(code, 0);
    assert.equal(output, `${join(outDir, 'run-flight.md')}\n`);
    assert.ok(existsSync(join(outDir, 'run-flight.md')));
  });

  it('returns 1 with a usage error when run_id is missing', () => {
    const { result: code } = captureStderr(() => main([], {}));
    assert.equal(code, 1);
  });

  it('returns 1 when the run has no ledger', () => {
    const stateRoot = makeDir('noledger', 'state');
    const repoRoot = makeDir('noledger', 'repo');
    const options = { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) };
    const { output, result: code } = captureStderr(() => main(['nope'], options));
    assert.equal(code, 1);
    assert.ok(output.includes('no ledger for run nope'), output);
  });
});

// ---------------------------------------------------------------------------
// Idempotent overwrite.
// ---------------------------------------------------------------------------

describe('runLog idempotent overwrite', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('re-running refreshes the same file instead of appending or failing', () => {
    const { runId, stateRoot, repoRoot } = fullLifecycleFixture();
    const options = { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) };
    const outPath = join(repoRoot, 'docs', 'hydra-dev-logs', 'run-full.md');

    const first = runLog(runId, options);
    assert.equal(first.outPath, join(realpathSync(join(repoRoot, 'docs', 'hydra-dev-logs')), 'run-full.md'));

    // Pre-existing junk at the target is replaced, not preserved.
    writeFileSync(outPath, 'STALE JUNK — should be overwritten', 'utf8');
    const second = runLog(runId, options);
    const content = readFileSync(outPath, 'utf8');
    assert.equal(content, second.markdown);
    assert.equal(content, first.markdown);
    assert.ok(!content.includes('STALE JUNK'));
  });
});

// ---------------------------------------------------------------------------
// Launcher script presence.
// ---------------------------------------------------------------------------

describe('run-log.sh launcher', () => {
  it('exists and routes the run-log subcommand through hydra_launch like its siblings', () => {
    assert.ok(existsSync(RUN_LOG_SH), 'kit/hydra/scripts/run-log.sh must exist');
    const body = readFileSync(RUN_LOG_SH, 'utf8');
    assert.ok(body.includes('hydra_launch run-log "$@"'), body);
    assert.ok(body.includes('source "$SELF_DIR/lib.sh"'), body);
  });
});

// ---------------------------------------------------------------------------
// Strict id validation + output path safety.
// ---------------------------------------------------------------------------

describe('run-log id validation and output path safety', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('rejects run ids that fail the strict id pattern before any path construction', () => {
    const { stateRoot, repoRoot } = inFlightFixture();
    for (const bad of ['../flight', 'a/b', '..', 'a b', '.hidden']) {
      assert.throws(
        () => runLog(bad, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) }),
        /invalid run_id/,
        bad,
      );
    }
    const { output, result: code } = captureStderr(() =>
      main(['../flight'], { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) }));
    assert.equal(code, 1);
    assert.ok(output.includes('invalid run_id'), output);
  });

  it('never constructs read paths from ledger-supplied hostile task ids', () => {
    const runId = 'hostileid';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base444hostileid');
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:05Z', event: 'task_started', run_id: runId, task_id: '../../etc/evil', vendor: 'kimi', agent_run_id: 'hostileid-x', dispatch_instance_id: 'iid-h-1', delivery: 'start' },
    ]);
    // Bait at the path a naive join(runPath, 'tasks', '<id>.yaml') resolves to.
    const baitDir = join(stateRoot, 'runs', 'etc');
    mkdirSync(baitDir, { recursive: true });
    writeFileSync(join(baitDir, 'evil.yaml'), 'assigned_vendor: pwned-vendor\nspec_version: 9\n', 'utf8');

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.ok(!result.markdown.includes('pwned-vendor'), result.markdown);
    // The hostile id is still rendered — escaped, as data — with explicit gaps.
    assert.ok(result.markdown.includes('`../../etc/evil`'), result.markdown);
    const row = result.markdown
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes('../../etc/evil'));
    assert.ok(row !== undefined, result.markdown);
    assert.ok(row.includes('(none recorded)'), row);
  });

  it('canonicalizes a symlinked --out directory and keeps the output under it', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    const realDir = makeDir(runId, 'real-logs');
    const linkDir = join(TEST_TMP, `link-out-${runId}`);
    symlinkSync(realDir, linkDir);

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), outDir: linkDir });
    assert.equal(result.outPath, join(realpathSync(realDir), `run-${runId}.md`));
    assert.ok(existsSync(join(realDir, `run-${runId}.md`)));
  });

  it('resolves --out values containing .. segments into the canonical directory', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    const base = makeDir(runId, 'dotdot');
    const result = runLog(runId, {
      cwd: repoRoot,
      stateRoot,
      exec: repoExec(repoRoot),
      outDir: join(base, 'sub', '..', 'logs'),
    });
    assert.equal(result.outPath, join(realpathSync(join(base, 'logs')), `run-${runId}.md`));
    assert.ok(existsSync(join(base, 'logs', `run-${runId}.md`)));
  });

  it('refuses to follow a symlink at the output path', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    const outDir = makeDir(runId, 'sym-out');
    const sentinel = join(outDir, 'sentinel.txt');
    writeFileSync(sentinel, 'SENTINEL', 'utf8');
    symlinkSync(sentinel, join(outDir, `run-${runId}.md`));

    assert.throws(
      () => runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), outDir }),
      /symlink/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'SENTINEL');
  });
});

// ---------------------------------------------------------------------------
// Attempt open/close correlation by dispatch ids, never recency.
// ---------------------------------------------------------------------------

describe('runLog attempt correlation by agent_run_id / dispatch_instance_id', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('closes overlapping attempts on their own terminal events, not by recency', () => {
    const runId = 'overlap';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base555overlap');
    writeTaskSpec(stateRoot, runId, 'task-o', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-o', vendor: 'codex', agent_run_id: 'o-v1', dispatch_instance_id: 'iid-1', delivery: 'start' },
      { time: '2026-07-14T00:00:02Z', event: 'task_started', run_id: runId, task_id: 'task-o', vendor: 'codex', agent_run_id: 'o-v2', dispatch_instance_id: 'iid-2', delivery: 'start' },
      // The first-started attempt exits first; closing must follow dispatch
      // ids, so attempt 1 gets exit 1 and attempt 2 gets exit 0.
      { time: '2026-07-14T00:03:00Z', event: 'agent_exited', run_id: runId, task_id: 'task-o', vendor: 'codex', agent_run_id: 'o-v1', dispatch_instance_id: 'iid-1', exit_code: '1' },
      { time: '2026-07-14T00:04:00Z', event: 'agent_exited', run_id: runId, task_id: 'task-o', vendor: 'codex', agent_run_id: 'o-v2', dispatch_instance_id: 'iid-2', exit_code: '0' },
    ]);

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    const task = result.data.tasks[0];
    assert.equal(task.attempts.length, 2);
    assert.equal(task.attempts[0].exit, 'exit 1');
    assert.equal(task.attempts[0].ended, '2026-07-14T00:03:00Z');
    assert.equal(task.attempts[1].exit, 'exit 0');
    assert.equal(task.attempts[1].ended, '2026-07-14T00:04:00Z');
    assert.ok(
      result.markdown.includes('1. started 2026-07-14T00:00:01Z — ended 2026-07-14T00:03:00Z — exit 1'),
      result.markdown,
    );
    assert.ok(
      result.markdown.includes('2. started 2026-07-14T00:00:02Z — ended 2026-07-14T00:04:00Z — exit 0'),
      result.markdown,
    );
  });

  it('matches on agent_run_id when dispatch_instance_id is absent (legacy ledgers)', () => {
    const runId = 'legacy';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base556legacy');
    writeTaskSpec(stateRoot, runId, 'task-l', { assigned_vendor: 'kimi', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-l', vendor: 'kimi', agent_run_id: 'l-v1', delivery: 'start' },
      { time: '2026-07-14T00:01:00Z', event: 'agent_exited', run_id: runId, task_id: 'task-l', vendor: 'kimi', agent_run_id: 'l-v1', exit_code: '0' },
    ]);

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.tasks[0].attempts[0].exit, 'exit 0');
    assert.equal(result.data.tasks[0].attempts[0].ended, '2026-07-14T00:01:00Z');
  });

  it('leaves attempts in flight when a terminal event matches no open attempt', () => {
    const runId = 'orphan';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base557orphan');
    writeTaskSpec(stateRoot, runId, 'task-x', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-x', vendor: 'codex', agent_run_id: 'x-v1', dispatch_instance_id: 'iid-x1', delivery: 'start' },
      { time: '2026-07-14T00:01:00Z', event: 'agent_exited', run_id: runId, task_id: 'task-x', vendor: 'codex', agent_run_id: 'unrelated', dispatch_instance_id: 'iid-9', exit_code: '0' },
    ]);

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.tasks[0].attempts[0].ended, null);
    assert.equal(result.data.tasks[0].attempts[0].exit, null);
    assert.ok(result.markdown.includes('1. started 2026-07-14T00:00:01Z — in flight'), result.markdown);
  });

  it('matches on dispatch_instance_id alone when the terminal event carries one, ignoring a shared agent_run_id', () => {
    const runId = 'sharedagent';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base558shared');
    writeTaskSpec(stateRoot, runId, 'task-s', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-s', vendor: 'codex', agent_run_id: 'shared-agent', dispatch_instance_id: 'iid-s1', delivery: 'start' },
      { time: '2026-07-14T00:00:02Z', event: 'task_started', run_id: runId, task_id: 'task-s', vendor: 'codex', agent_run_id: 'shared-agent', dispatch_instance_id: 'iid-s2', delivery: 'start' },
      // Both open attempts share the agent_run_id; the terminal event carries
      // iid-s1, so ONLY attempt 1 may close — attempt 2 stays in flight.
      { time: '2026-07-14T00:03:00Z', event: 'agent_exited', run_id: runId, task_id: 'task-s', vendor: 'codex', agent_run_id: 'shared-agent', dispatch_instance_id: 'iid-s1', exit_code: '1' },
    ]);

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    const task = result.data.tasks[0];
    assert.equal(task.attempts.length, 2);
    assert.equal(task.attempts[0].ended, '2026-07-14T00:03:00Z');
    assert.equal(task.attempts[0].exit, 'exit 1');
    assert.equal(task.attempts[1].ended, null);
    assert.equal(task.attempts[1].exit, null);
  });
});

// ---------------------------------------------------------------------------
// Authoritative result file vs ledger promotion reconciliation.
// ---------------------------------------------------------------------------

describe('runLog result-file / ledger reconciliation', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('flags a ledger promotion with no authoritative result file as DIVERGENCE', () => {
    const runId = 'norec';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base777norec');
    writeTaskSpec(stateRoot, runId, 'task-n', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-n', vendor: 'codex', agent_run_id: 'n-v1', dispatch_instance_id: 'iid-n1', delivery: 'start' },
      { time: '2026-07-14T00:01:00Z', event: 'result_promoted', run_id: runId, task_id: 'task-n', head: 'headnorec1', divergence: 'false' },
    ]);

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].task_id, 'task-n');
    assert.equal(result.data.reconciliation[0].kind, 'ledger_without_file');
    assert.ok(result.markdown.includes('promoted head=`headnorec1`'), result.markdown);
    assert.ok(result.markdown.includes('DIVERGENCE'), result.markdown);
    assert.ok(
      result.markdown.includes('- DIVERGENCE: task `task-n` — ledger records result\\_promoted but no authoritative result file exists'),
      result.markdown,
    );
  });

  it('flags an authoritative result file with no ledger promotion as DIVERGENCE', () => {
    const runId = 'noledger';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base778noledger');
    writeTaskSpec(stateRoot, runId, 'task-n', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-n', vendor: 'codex', agent_run_id: 'n-v1', dispatch_instance_id: 'iid-n1', delivery: 'start' },
    ]);
    writePromotedResult(stateRoot, runId, 'task-n');

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].task_id, 'task-n');
    assert.equal(result.data.reconciliation[0].kind, 'file_without_ledger');
    // The promote cell must surface the divergence rather than silently
    // trusting the file (or silently reporting nothing).
    const row = result.markdown.split('\n').find((line) => line.startsWith('| `task-n` |'));
    assert.ok(row !== undefined, result.markdown);
    assert.ok(row.includes('DIVERGENCE: result file present without ledger promotion'), row);
  });

  it('reports a clean reconciliation when the file and the ledger agree', () => {
    const { runId, stateRoot, repoRoot } = fullLifecycleFixture();
    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.deepEqual(result.data.reconciliation, []);
    assert.ok(result.markdown.includes('- Ledger/tree reconciliation: (none recorded)'), result.markdown);
  });
});

// ---------------------------------------------------------------------------
// Result-file validation: only a REGULAR FILE (lstat — symlinks rejected,
// never followed) containing parseable JSON that carries the task's identity
// counts as "present". The identity is read from the production
// promoted-record envelope at claims.task_id (top-level task_id only as the
// legacy fallback); a directory, symlink, unparseable file, identity mismatch
// or absent identity must render DIVERGENCE, never suppress it.
// ---------------------------------------------------------------------------

describe('runLog result-file validation before treating it as present', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  /** Minimal ledger claiming a promotion for task-v; the tree is per-test bait. */
  function promotionFixture(runId: string): { stateRoot: string; repoRoot: string } {
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, `base-${runId}`);
    writeTaskSpec(stateRoot, runId, 'task-v', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-v', vendor: 'codex', agent_run_id: `${runId}-v1`, dispatch_instance_id: `iid-${runId}-1`, delivery: 'start' },
      { time: '2026-07-14T00:01:00Z', event: 'result_promoted', run_id: runId, task_id: 'task-v', head: `head-${runId}`, divergence: 'false' },
    ]);
    return { stateRoot, repoRoot };
  }

  function resultsDir(stateRoot: string, runId: string): string {
    const dir = join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'results');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('flags a directory at the result path as DIVERGENCE despite a ledger promotion', () => {
    const runId = 'recdir';
    const { stateRoot, repoRoot } = promotionFixture(runId);
    mkdirSync(join(resultsDir(stateRoot, runId), 'task-v.json'));

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].kind, 'ledger_without_file');
    assert.ok(result.markdown.includes('DIVERGENCE'), result.markdown);
  });

  it('flags a symlink at the result path as DIVERGENCE and never follows it', () => {
    const runId = 'recsym';
    const { stateRoot, repoRoot } = promotionFixture(runId);
    // A perfectly valid result record lives elsewhere; the symlink to it must
    // still be rejected via lstat — the target is never followed.
    const realFile = join(stateRoot, 'runs', `run-${runId}`, 'real-result.json');
    writeFileSync(realFile, `${JSON.stringify({ task_id: 'task-v', claims: {} })}\n`, 'utf8');
    symlinkSync(realFile, join(resultsDir(stateRoot, runId), 'task-v.json'));

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].kind, 'ledger_without_file');
    assert.match(result.data.reconciliation[0].detail, /symlink/);
    assert.ok(result.markdown.includes('DIVERGENCE'), result.markdown);
  });

  it('flags an unparseable result file as DIVERGENCE despite a ledger promotion', () => {
    const runId = 'recbad';
    const { stateRoot, repoRoot } = promotionFixture(runId);
    writeFileSync(join(resultsDir(stateRoot, runId), 'task-v.json'), 'not json{{{', 'utf8');

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].kind, 'ledger_without_file');
    assert.match(result.data.reconciliation[0].detail, /unparseable/);
  });

  it('flags a result file whose claims.task_id does not match the task as DIVERGENCE', () => {
    const runId = 'recmismatch';
    const { stateRoot, repoRoot } = promotionFixture(runId);
    // The REAL promoted-record shape — task identity lives in the claims
    // envelope — but the envelope names a different task.
    writeFileSync(
      join(resultsDir(stateRoot, runId), 'task-v.json'),
      `${JSON.stringify(promotedRecord('task-other', runId))}\n`,
      'utf8',
    );

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].kind, 'ledger_without_file');
    assert.match(result.data.reconciliation[0].detail, /task_id mismatch/);
  });

  it('flags a result file carrying no task identity at all as DIVERGENCE', () => {
    const runId = 'recnoid';
    const { stateRoot, repoRoot } = promotionFixture(runId);
    // Well-formed envelope, but neither claims.task_id nor a legacy top-level
    // task_id: identity is absent, which must render DIVERGENCE, not a pass.
    writeFileSync(
      join(resultsDir(stateRoot, runId), 'task-v.json'),
      `${JSON.stringify({ claims: {}, harness_observed: { verification: [] }, divergence: false, promoted_at: '2026-07-14T00:01:05Z' })}\n`,
      'utf8',
    );

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].kind, 'ledger_without_file');
    assert.match(result.data.reconciliation[0].detail, /no task identity/);
    assert.ok(result.markdown.includes('DIVERGENCE'), result.markdown);
  });

  it("flags task B's valid promoted record placed at task-a.json as DIVERGENCE (swapped record)", () => {
    const runId = 'recswap';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, `base-${runId}`);
    writeTaskSpec(stateRoot, runId, 'task-a', { assigned_vendor: 'codex', spec_version: '1' });
    writeTaskSpec(stateRoot, runId, 'task-b', { assigned_vendor: 'kimi', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-a', vendor: 'codex', agent_run_id: 'swap-a-v1', dispatch_instance_id: 'iid-swap-a-1', delivery: 'start' },
      { time: '2026-07-14T00:00:02Z', event: 'task_started', run_id: runId, task_id: 'task-b', vendor: 'kimi', agent_run_id: 'swap-b-v1', dispatch_instance_id: 'iid-swap-b-1', delivery: 'start' },
      { time: '2026-07-14T00:01:00Z', event: 'result_promoted', run_id: runId, task_id: 'task-a', head: 'head-swap-a', divergence: 'false' },
      { time: '2026-07-14T00:01:01Z', event: 'result_promoted', run_id: runId, task_id: 'task-b', head: 'head-swap-b', divergence: 'false' },
    ]);
    // task-b's record is correct at its own path — but task-b's VALID promoted
    // JSON was also placed at task-a's path. Valid JSON, valid envelope, wrong
    // task: task-a's claimed promotion has no valid record of its own.
    writePromotedResult(stateRoot, runId, 'task-b');
    writeFileSync(
      join(resultsDir(stateRoot, runId), 'task-a.json'),
      `${JSON.stringify(promotedRecord('task-b', runId))}\n`,
      'utf8',
    );

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].task_id, 'task-a');
    assert.equal(result.data.reconciliation[0].kind, 'ledger_without_file');
    assert.match(result.data.reconciliation[0].detail, /task_id mismatch: record carries "task-b"/);
    assert.ok(result.markdown.includes('DIVERGENCE'), result.markdown);
    // task-b's own record agrees with its ledger promotion: not flagged.
    assert.ok(!result.data.reconciliation.some((flag) => flag.task_id === 'task-b'));
  });

  it('renders DIVERGENCE for an invalid entry at the result path even without a ledger promotion', () => {
    const runId = 'recnopromo';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, `base-${runId}`);
    writeTaskSpec(stateRoot, runId, 'task-v', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId },
      { time: '2026-07-14T00:00:01Z', event: 'task_started', run_id: runId, task_id: 'task-v', vendor: 'codex', agent_run_id: `${runId}-v1`, dispatch_instance_id: `iid-${runId}-1`, delivery: 'start' },
    ]);
    // A stray directory at the result path with a silent ledger: the invalid
    // entry must still surface as DIVERGENCE, never be suppressed.
    mkdirSync(join(resultsDir(stateRoot, runId), 'task-v.json'));

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.reconciliation.length, 1);
    assert.equal(result.data.reconciliation[0].kind, 'file_without_ledger');
    assert.ok(result.markdown.includes('DIVERGENCE'), result.markdown);
  });

  it('accepts a regular file whose legacy top-level task_id matches the task (fallback when the envelope has none)', () => {
    const runId = 'recok';
    const { stateRoot, repoRoot } = promotionFixture(runId);
    // Legacy shape: no claims.task_id, so the top-level task_id decides.
    writeFileSync(
      join(resultsDir(stateRoot, runId), 'task-v.json'),
      `${JSON.stringify({ task_id: 'task-v', claims: {}, divergence: false })}\n`,
      'utf8',
    );

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.deepEqual(result.data.reconciliation, []);
    assert.ok(result.markdown.includes('- Ledger/tree reconciliation: (none recorded)'), result.markdown);
  });
});

// ---------------------------------------------------------------------------
// Usage aggregation filtered to this run.
// ---------------------------------------------------------------------------

describe('runLog usage filtered by run_id', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('aggregates only usage records tagged with this run_id', () => {
    const { runId, stateRoot, repoRoot } = fullLifecycleFixture();
    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.ok(result.data.usage !== null);
    assert.deepEqual(Object.keys(result.data.usage ?? {}).sort(), ['claude', 'codex']);
    assert.equal(result.data.usage?.claude.n_dispatch, 2);
    assert.ok(Math.abs((result.data.usage?.claude.total_cost_usd ?? 0) - 0.35) < 1e-12);
    assert.equal(result.data.usage?.claude.total_tokens_out, 1500);
    assert.equal(result.data.usage?.codex.n_dispatch, 1);
    // The foreign-run and untagged rows must not leak into the aggregate.
    assert.ok(!result.markdown.includes('99999'), result.markdown);
    assert.ok(!result.markdown.includes('50000'), result.markdown);
  });

  it('renders (none recorded) when usage.jsonl exists but has no records for this run', () => {
    const { runId, stateRoot, repoRoot } = inFlightFixture();
    writeUsage(stateRoot, [
      { run_id: 'some-other-run', vendor: 'claude', time: '2026-07-14T00:00:10Z', cost_usd: 1, tokens_out: 10 },
    ]);
    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.equal(result.data.usage, null);
    assert.ok(result.markdown.includes('## Usage\n\n(none recorded)'), result.markdown);
  });
});

// ---------------------------------------------------------------------------
// Ledger anomalies: malformed and non-object lines are counted, not skipped.
// ---------------------------------------------------------------------------

describe('runLog ledger anomalies', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('counts malformed and non-object lines with line numbers and still renders the run', () => {
    const runId = 'anom';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, 'base666anom');
    writeTaskSpec(stateRoot, runId, 'task-z', { assigned_vendor: 'kimi', spec_version: '1' });
    writeRawLedger(stateRoot, runId, [
      '{"time":"2026-07-14T00:00:00Z","event":"run_started","run_id":"anom"}',
      '{not json',
      '42',
      'null',
      '["array"]',
      '{"time":"2026-07-14T00:00:05Z","event":"task_started","run_id":"anom","task_id":"task-z","vendor":"kimi","agent_run_id":"z-v1","dispatch_instance_id":"iid-z-1"}',
      '',
    ].join('\n'));

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot) });
    assert.deepEqual(result.data.ledger_anomalies.map((anomaly) => anomaly.line), [2, 3, 4, 5]);
    assert.match(result.data.ledger_anomalies[0].reason, /invalid JSON/);
    assert.match(result.data.ledger_anomalies[1].reason, /not a JSON object/);
    assert.match(result.data.ledger_anomalies[2].reason, /not a JSON object/);
    assert.match(result.data.ledger_anomalies[3].reason, /not a JSON object/);

    // Valid events are still processed — a non-object line must not crash the render.
    assert.equal(result.data.tasks.length, 1);
    assert.equal(result.data.tasks[0].task_id, 'task-z');
    assert.equal(result.data.timeline.length, 2);

    assert.ok(result.markdown.includes('## Ledger anomalies'), result.markdown);
    assert.ok(result.markdown.includes('4 malformed ledger lines skipped'), result.markdown);
    assert.ok(result.markdown.includes('line 2'), result.markdown);
    assert.ok(result.markdown.includes('line 5'), result.markdown);
  });
});

// ---------------------------------------------------------------------------
// Review provenance semantics (issue #32): the Review column distinguishes
// three separate states — reviewer process completed, authoritative verdict
// recorded, recorded verdict accepted — and never infers a task from
// review_id naming. Legacy review events without task_id stay in the flat
// timeline only.
// ---------------------------------------------------------------------------

describe('runLog review provenance semantics (issue #32)', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  interface ReviewFixtureOptions {
    /** Extra ledger entries, appended after run_started. */
    ledger?: Record<string, unknown>[];
    /** Write a task spec for task-a (default true). */
    spec?: boolean;
    /** An authoritative review generation at authoritative/reviews/task-a/0001-<head>.json. */
    reviewDoc?: Record<string, unknown>;
  }

  function reviewFixture(id: string, opts: ReviewFixtureOptions) {
    const runId = id;
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, `base-${runId}`);
    if (opts.spec !== false) {
      writeTaskSpec(stateRoot, runId, 'task-a', { assigned_vendor: 'codex', spec_version: '1' });
    }
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
      ...(opts.ledger ?? []),
    ]);
    if (opts.reviewDoc !== undefined) writeReviewGeneration(stateRoot, runId, 'task-a', 1, HEAD_A, opts.reviewDoc);
    return runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
  }

  /** The Review cell is the 7th column of the task lifecycle table. */
  function reviewCell(md: string, taskId: string): string {
    const row = md.split('\n').find((line) => line.startsWith(`| \`${taskId}\` |`));
    assert.ok(row !== undefined, md);
    const cells = row.split(' | ');
    assert.ok(cells.length >= 7, row);
    return cells[6];
  }

  it('marks a completed review without a verdict as verdict pending — exit 0 and free text are not acceptance', () => {
    const { data, markdown } = reviewFixture('rev-pending', {
      ledger: [
        { time: '2026-07-14T00:00:01Z', event: 'review_started', run_id: 'rev-pending', task_id: 'task-a', review_id: 'rev-1', vendor: 'claude' },
        // A clean exit plus free-text approval-looking output: still not a verdict.
        { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: 'rev-pending', task_id: 'task-a', review_id: 'rev-1', vendor: 'claude', exit_code: '0', note: 'LGTM — ship it' },
      ],
    });

    const cell = reviewCell(markdown, 'task-a');
    assert.ok(cell.includes('reviewer completed (review_id=rev-1, vendor=claude, exit=0, 2026-07-14T00:00:02Z)'), cell);
    assert.ok(cell.includes('verdict pending — a completed review is not a verdict'), cell);
    assert.ok(!cell.includes('accepted'), cell);
    assert.ok(!cell.includes('(none recorded)'), cell);
    assert.ok(!cell.includes('LGTM'), cell);

    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0].review.completions.length, 1);
    assert.equal(data.tasks[0].review.completions[0].review_id, 'rev-1');
    assert.equal(data.tasks[0].review.verdict, null);
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('renders accepted only when the recorded verdict is accept', () => {
    const { data, markdown } = reviewFixture('rev-accept', {
      ledger: [
        { time: '2026-07-14T00:00:01Z', event: 'review_started', run_id: 'rev-accept', task_id: 'task-a', review_id: 'rev-1', vendor: 'claude' },
        { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: 'rev-accept', task_id: 'task-a', review_id: 'rev-1', vendor: 'claude', exit_code: '0' },
        { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: 'rev-accept', task_id: 'task-a', verdict: 'accept', reviewer: 'claude', risk: 'low' },
      ],
    });

    const cell = reviewCell(markdown, 'task-a');
    assert.ok(cell.includes('reviewer completed (review_id=rev-1, vendor=claude, exit=0, 2026-07-14T00:00:02Z)'), cell);
    assert.ok(cell.includes('accepted — verdict accept (reviewer=claude, risk=low)'), cell);
    assert.ok(!cell.includes('verdict pending'), cell);

    assert.equal(data.tasks[0].review.completions.length, 1);
    assert.deepEqual(data.tasks[0].review.verdict, { verdict: 'accept', reviewer: 'claude', risk: 'low' });
    assert.equal(data.tasks[0].review.accepted, true);
  });

  it('renders revise and reject verdicts as recorded but not accepted', () => {
    for (const verdict of ['revise', 'reject'] as const) {
      const { data, markdown } = reviewFixture(`rev-${verdict}`, {
        ledger: [
          { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: `rev-${verdict}`, task_id: 'task-a', review_id: 'rev-1', vendor: 'claude', exit_code: '0' },
          { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: `rev-${verdict}`, task_id: 'task-a', verdict, reviewer: 'claude', risk: 'medium' },
        ],
      });

      const cell = reviewCell(markdown, 'task-a');
      assert.ok(cell.includes(`verdict ${verdict} (reviewer=claude, risk=medium) — not accepted`), cell);
      assert.ok(!cell.includes('accepted —'), cell);
      assert.equal(data.tasks[0].review.accepted, false, `${verdict} must never satisfy acceptance`);
      assert.equal(data.tasks[0].review.verdict?.verdict, verdict);
    }
  });

  it('gates acceptance on a recorded verdict alone, even without completion events', () => {
    const { data, markdown } = reviewFixture('rev-verdict-only', {
      ledger: [
        { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: 'rev-verdict-only', task_id: 'task-a', verdict: 'accept', reviewer: 'claude', risk: 'low' },
      ],
    });

    const cell = reviewCell(markdown, 'task-a');
    assert.ok(cell.includes('accepted — verdict accept (reviewer=claude, risk=low)'), cell);
    assert.ok(!cell.includes('reviewer completed'), cell);
    assert.equal(data.tasks[0].review.completions.length, 0);
    assert.equal(data.tasks[0].review.accepted, true);
  });

  it('lets the authoritative review record win over the ledger verdict', () => {
    const { data, markdown } = reviewFixture('rev-doc-wins', {
      ledger: [
        { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: 'rev-doc-wins', task_id: 'task-a', verdict: 'revise', reviewer: 'claude', risk: 'medium' },
      ],
      reviewDoc: { verdict: 'accept', reviewer: 'claude', risk: 'low' },
    });

    const cell = reviewCell(markdown, 'task-a');
    assert.ok(cell.includes('accepted — verdict accept (reviewer=claude, risk=low)'), cell);
    assert.equal(data.tasks[0].review.verdict?.verdict, 'accept');
    assert.equal(data.tasks[0].review.accepted, true);
  });

  it('keeps legacy unkeyed review events in the flat timeline without task attribution', () => {
    const { data, markdown } = reviewFixture('rev-legacy', {
      ledger: [
        { time: '2026-07-14T00:00:01Z', event: 'review_started', run_id: 'rev-legacy', review_id: 'rev-legacy-1', vendor: 'claude' },
        { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: 'rev-legacy', review_id: 'rev-legacy-1', vendor: 'claude', exit_code: '0' },
      ],
    });

    // No false attribution: the task row shows the explicit gap, and no extra
    // task row is invented for the legacy review.
    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0].task_id, 'task-a');
    assert.equal(data.tasks[0].review.completions.length, 0);
    assert.equal(data.tasks[0].review.verdict, null);
    assert.equal(data.tasks[0].review.accepted, false);
    assert.equal(reviewCell(markdown, 'task-a'), '(none recorded)');

    // The events remain fully visible in the flat timeline, untasked.
    const reviewEvents = data.timeline.filter((entry) => entry.event.startsWith('review_'));
    assert.equal(reviewEvents.length, 2);
    for (const entry of reviewEvents) {
      assert.equal(entry.task_id, null);
    }
    assert.ok(markdown.includes('**review\\_completed** — review\\_id=rev-legacy-1'), markdown);
  });

  it('never infers a task from a review_id that matches a task id', () => {
    const { data, markdown } = reviewFixture('rev-named-like-task', {
      ledger: [
        // Legacy event: no task_id, but the review_id IS a task id's spelling.
        { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: 'rev-named-like-task', review_id: 'task-a', vendor: 'claude', exit_code: '0' },
      ],
    });

    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0].review.completions.length, 0);
    assert.equal(data.tasks[0].review.accepted, false);
    assert.equal(reviewCell(markdown, 'task-a'), '(none recorded)');
  });

  it('lists repeated reviews in ledger order, each one only completed', () => {
    const { data, markdown } = reviewFixture('rev-repeated', {
      ledger: [
        { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: 'rev-repeated', task_id: 'task-a', review_id: 'rev-1', vendor: 'claude', exit_code: '1' },
        { time: '2026-07-14T00:00:04Z', event: 'review_completed', run_id: 'rev-repeated', task_id: 'task-a', review_id: 'rev-2', vendor: 'codex', exit_code: '0' },
      ],
    });

    const cell = reviewCell(markdown, 'task-a');
    const first = cell.indexOf('review_id=rev-1');
    const second = cell.indexOf('review_id=rev-2');
    assert.ok(first !== -1 && second !== -1 && first < second, cell);
    assert.ok(cell.includes('verdict pending'), cell);
    assert.deepEqual(
      data.tasks[0].review.completions.map((completion) => completion.review_id),
      ['rev-1', 'rev-2'],
    );
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('accepts once the verdict is recorded regardless of ledger ordering', () => {
    const { data, markdown } = reviewFixture('rev-order', {
      ledger: [
        // Verdict first, process completion second — the final snapshot still
        // reflects both facts truthfully.
        { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: 'rev-order', task_id: 'task-a', verdict: 'accept', reviewer: 'claude', risk: 'low' },
        { time: '2026-07-14T00:00:04Z', event: 'review_completed', run_id: 'rev-order', task_id: 'task-a', review_id: 'rev-1', vendor: 'claude', exit_code: '0' },
      ],
    });

    const cell = reviewCell(markdown, 'task-a');
    assert.ok(cell.includes('reviewer completed'), cell);
    assert.ok(cell.includes('accepted — verdict accept (reviewer=claude, risk=low)'), cell);
    assert.equal(data.tasks[0].review.accepted, true);
  });

  it('renders a hostile task id from a review event without constructing paths from it', () => {
    const { data, markdown } = reviewFixture('rev-hostile', {
      spec: false,
      ledger: [
        { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: 'rev-hostile', task_id: '../evil', review_id: 'rev-x', vendor: 'claude', exit_code: '0' },
        // A hostile review_id is data too: escaped, never markup.
        { time: '2026-07-14T00:00:03Z', event: 'review_completed', run_id: 'rev-hostile', task_id: '../evil', review_id: 'rev`|*inject*|`', vendor: 'claude', exit_code: '0' },
      ],
    });

    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0].task_id, '../evil');
    assert.equal(data.tasks[0].review.completions.length, 2);
    assert.equal(data.tasks[0].review.accepted, false);
    const cell = reviewCell(markdown, '../evil');
    assert.ok(cell.includes('review_id=rev-x'), cell);
    assert.ok(cell.includes("review_id=rev'\\|\\*inject\\*\\|'"), cell);
    assert.ok(cell.includes('verdict pending'), cell);
  });
});

// ---------------------------------------------------------------------------
// Append-only authoritative review generations: run-log reads the REAL store
// layout authoritative/reviews/<task>/<seq>-<reviewed_head>.json, picks the
// highest valid generation deterministically, and lets that record override
// conflicting ledger telemetry. Flat <task>.json files are legacy debris and
// are never read.
// ---------------------------------------------------------------------------

describe('runLog append-only authoritative review generations', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  function baseFixture(runId: string): { stateRoot: string; repoRoot: string } {
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, `base-${runId}`);
    writeTaskSpec(stateRoot, runId, 'task-a', { assigned_vendor: 'codex', spec_version: '1' });
    return { stateRoot, repoRoot };
  }

  function schemaVerdict(taskId: string, verdict: string, head: string, risk: string): Record<string, unknown> {
    return {
      task_id: taskId,
      verdict,
      reviewed_base: HEAD_C,
      reviewed_head: head,
      reviewer: 'codex',
      risk,
      blocking_findings: [],
      non_blocking_findings: [],
      required_integration_checks: [],
    };
  }

  function verdictFile(name: string, doc: Record<string, unknown>): string {
    const path = join(TEST_TMP, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(doc)}\n`, 'utf8');
    return path;
  }

  it('reads the latest of multiple REAL generations published through record-review', () => {
    const runId = 'gen-real';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
      { time: '2026-07-14T00:00:02Z', event: 'review_completed', run_id: runId, task_id: 'task-a', review_id: 'rev-1', vendor: 'claude', exit_code: '0' },
    ]);
    // Two review rounds through the production lane: revise first, accept second.
    captureStdout(() => recordReview(runId, 'task-a', verdictFile('gen-real-v1', schemaVerdict('task-a', 'revise', HEAD_A, 'medium')), { stateRoot }));
    captureStdout(() => recordReview(runId, 'task-a', verdictFile('gen-real-v2', schemaVerdict('task-a', 'accept', HEAD_B, 'low')), { stateRoot }));

    // The on-disk layout really is append-only generations, not a flat file.
    assert.deepEqual(
      readdirSync(reviewsDirFor(stateRoot, runId, 'task-a')).sort(),
      [`0001-${HEAD_A}.json`, `0002-${HEAD_B}.json`],
    );

    const result = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(result.data.tasks.length, 1);
    assert.equal(result.data.tasks[0].review.verdict?.verdict, 'accept');
    assert.equal(result.data.tasks[0].review.verdict?.risk, 'low');
    assert.equal(result.data.tasks[0].review.accepted, true);
    assert.ok(result.markdown.includes('accepted — verdict accept (reviewer=codex, risk=low)'), result.markdown);
  });

  it('a durable file-only generation with NO ledger append overrides stale ledger telemetry', () => {
    const runId = 'gen-file-only';
    const { stateRoot, repoRoot } = baseFixture(runId);
    // The ledger last heard 'revise'; a later verdict reached the durable
    // store but crashed before its review_verdict append.
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
      { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: runId, task_id: 'task-a', verdict: 'revise', reviewer: 'claude', risk: 'medium' },
    ]);
    publishVerdict(
      join(stateRoot, 'runs', `run-${runId}`),
      'task-a',
      Buffer.from(JSON.stringify(schemaVerdict('task-a', 'accept', HEAD_B, 'low'))),
      HEAD_B,
    );

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'accept');
    assert.equal(data.tasks[0].review.accepted, true);
  });

  it('the authoritative generation wins even when the ledger claims acceptance', () => {
    const runId = 'gen-truth';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
      // Stale/hostile telemetry claiming acceptance.
      { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: runId, task_id: 'task-a', verdict: 'accept', reviewer: 'claude', risk: 'low' },
    ]);
    writeReviewGeneration(stateRoot, runId, 'task-a', 1, HEAD_A, { verdict: 'reject', reviewer: 'codex', risk: 'high' });

    const { data, markdown } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'reject');
    assert.equal(data.tasks[0].review.accepted, false);
    assert.ok(markdown.includes('verdict reject (reviewer=codex, risk=high) — not accepted'), markdown);
  });

  it('orders generations numerically: a five-digit sequence beats a padded low one', () => {
    const runId = 'gen-numeric';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
    ]);
    writeReviewGeneration(stateRoot, runId, 'task-a', 2, HEAD_A, { verdict: 'revise', reviewer: 'codex', risk: 'medium' });
    writeReviewGeneration(stateRoot, runId, 'task-a', 10_000, HEAD_B, { verdict: 'accept', reviewer: 'codex', risk: 'low' });

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'accept');
    assert.equal(data.tasks[0].review.accepted, true);
  });

  it('breaks a same-sequence tie deterministically by descending filename', () => {
    const runId = 'gen-tie';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
    ]);
    // Two hostile same-sequence spellings: the byte-descending name wins.
    writeReviewGeneration(stateRoot, runId, 'task-a', 3, HEAD_A, { verdict: 'accept', reviewer: 'codex', risk: 'low' });
    writeReviewGeneration(stateRoot, runId, 'task-a', 3, HEAD_B, { verdict: 'reject', reviewer: 'codex', risk: 'high' });

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'reject', `0003-${HEAD_B} sorts after 0003-${HEAD_A}`);
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('skips invalid generations — symlinks, non-generation names, unparseable JSON, directories — and picks the highest VALID one', () => {
    const runId = 'gen-invalid';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
    ]);
    const dir = reviewsDirFor(stateRoot, runId, 'task-a');
    writeReviewGeneration(stateRoot, runId, 'task-a', 1, HEAD_A, { verdict: 'revise', reviewer: 'codex', risk: 'medium' });
    // Higher-numbered debris that must all be skipped:
    writeFileSync(join(dir, `0002-${HEAD_B}.json`), '{not json', 'utf8'); // unparseable
    writeFileSync(join(dir, 'evil.json'), JSON.stringify({ verdict: 'accept', reviewer: 'x', risk: 'low' }), 'utf8'); // bad name
    writeFileSync(join(dir, `0003-${'d'.repeat(12)}.json`), JSON.stringify({ verdict: 'accept' }), 'utf8'); // short head
    mkdirSync(join(dir, `0004-${HEAD_C}.json`)); // a directory wearing a generation name
    const outside = join(TEST_TMP, 'outside-accept.json');
    writeFileSync(outside, JSON.stringify({ verdict: 'accept', reviewer: 'evil', risk: 'low' }), 'utf8');
    symlinkSync(outside, join(dir, `0005-${HEAD_B}.json`)); // symlink: never followed

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'revise', 'only generation 0001 is valid');
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('skips a higher generation whose task_id claims a DIFFERENT task and falls back to the next valid one', () => {
    const runId = 'gen-mismatch';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeTaskSpec(stateRoot, runId, 'task-b', { assigned_vendor: 'codex', spec_version: '1' });
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
    ]);
    // Generation 1 is task-a's real verdict; generation 2 is an 'accept'
    // misfiled under task-a's directory but claiming task-b's identity.
    writeReviewGeneration(stateRoot, runId, 'task-a', 1, HEAD_A, { verdict: 'revise', reviewer: 'codex', risk: 'medium' });
    writeReviewGeneration(stateRoot, runId, 'task-a', 2, HEAD_B, { task_id: 'task-b', verdict: 'accept', reviewer: 'codex', risk: 'low' });

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    const taskA = data.tasks.find((task) => task.task_id === 'task-a');
    const taskB = data.tasks.find((task) => task.task_id === 'task-b');
    assert.equal(taskA?.review.verdict?.verdict, 'revise', 'the mismatched generation must be skipped, not trusted');
    assert.equal(taskA?.review.accepted, false);
    // The claimed task is untouched: a verdict misfiled under another task's
    // directory can never surface as task-b's verdict either.
    assert.equal(taskB?.review.verdict, null);
    assert.equal(taskB?.review.accepted, false);
  });

  it('skips a higher generation with NO task_id and falls back to the next valid one', () => {
    const runId = 'gen-missing-id';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
    ]);
    writeReviewGeneration(stateRoot, runId, 'task-a', 1, HEAD_A, { verdict: 'reject', reviewer: 'codex', risk: 'high' });
    // A generation-shaped document with no identity at all (pre-#32 debris).
    writeReviewGeneration(stateRoot, runId, 'task-a', 2, HEAD_B, { task_id: undefined, verdict: 'accept', reviewer: 'codex', risk: 'low' });

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'reject', 'an identity-less generation must be skipped');
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('yields no authoritative verdict when EVERY generation fails the identity check', () => {
    const runId = 'gen-all-mismatch';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
      // The ledger's own telemetry remains the fallback when the store holds
      // nothing that self-identifies as this task.
      { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: runId, task_id: 'task-a', verdict: 'revise', reviewer: 'claude', risk: 'medium' },
    ]);
    writeReviewGeneration(stateRoot, runId, 'task-a', 1, HEAD_A, { task_id: 'task-other', verdict: 'accept', reviewer: 'codex', risk: 'low' });
    writeReviewGeneration(stateRoot, runId, 'task-a', 2, HEAD_B, { task_id: undefined, verdict: 'accept', reviewer: 'codex', risk: 'low' });

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'revise', 'ledger telemetry stands when no store generation is valid');
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('never follows a symlinked per-task directory in the reviews tree', () => {
    const runId = 'gen-symdir';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
      { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: runId, task_id: 'task-a', verdict: 'revise', reviewer: 'claude', risk: 'medium' },
    ]);
    // A real directory elsewhere holding an 'accept' generation, reachable
    // only through a symlink planted at the task's slot.
    const decoy = makeDir(runId, 'decoy');
    writeFileSync(join(decoy, `0001-${HEAD_A}.json`), JSON.stringify({ verdict: 'accept', reviewer: 'evil', risk: 'low' }), 'utf8');
    const reviewsRoot = join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'reviews');
    mkdirSync(reviewsRoot, { recursive: true });
    symlinkSync(decoy, join(reviewsRoot, 'task-a'));

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.equal(data.tasks[0].review.verdict?.verdict, 'revise', 'the symlinked directory must not be read');
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('ignores a legacy flat <task>.json file — flat records are never revived', () => {
    const runId = 'gen-flat';
    const { stateRoot, repoRoot } = baseFixture(runId);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
      { time: '2026-07-14T00:00:03Z', event: 'review_verdict', run_id: runId, task_id: 'task-a', verdict: 'revise', reviewer: 'claude', risk: 'medium' },
    ]);
    const reviewsRoot = join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'reviews');
    mkdirSync(reviewsRoot, { recursive: true });
    writeFileSync(join(reviewsRoot, 'task-a.json'), JSON.stringify({ verdict: 'accept', reviewer: 'x', risk: 'low' }), 'utf8');
    // A flat file for an otherwise-unknown task must not invent a task row.
    writeFileSync(join(reviewsRoot, 'task-ghost.json'), JSON.stringify({ verdict: 'accept' }), 'utf8');

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.deepEqual(data.tasks.map((task) => task.task_id), ['task-a']);
    assert.equal(data.tasks[0].review.verdict?.verdict, 'revise', 'the flat file must not override the ledger');
    assert.equal(data.tasks[0].review.accepted, false);
  });

  it('discovers a task from its review generation directory alone', () => {
    const runId = 'gen-discover';
    const stateRoot = makeDir(runId, 'state');
    const repoRoot = makeDir(runId, 'repo');
    writeRunYaml(stateRoot, runId, `base-${runId}`);
    writeLedger(stateRoot, runId, [
      { time: '2026-07-14T00:00:00Z', event: 'run_started', run_id: runId, base_commit: `base-${runId}` },
    ]);
    writeReviewGeneration(stateRoot, runId, 'task-store-only', 1, HEAD_A, { verdict: 'accept', reviewer: 'codex', risk: 'low' });
    // Directory names that are not canonical task ids never become tasks.
    const reviewsRoot = join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'reviews');
    mkdirSync(join(reviewsRoot, '.seq-0001.claimed'), { recursive: true });
    mkdirSync(join(reviewsRoot, 'Task_UPPER'), { recursive: true });

    const { data } = runLog(runId, { cwd: repoRoot, stateRoot, exec: repoExec(repoRoot), json: true });
    assert.deepEqual(data.tasks.map((task) => task.task_id), ['task-store-only']);
    assert.equal(data.tasks[0].review.verdict?.verdict, 'accept');
    assert.equal(data.tasks[0].review.accepted, true);
  });
});
