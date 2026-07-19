import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { amendTask, main, resolveReason, rewriteTaskSpec } from '../src/amend-task.ts';
import { ledger, runDir, yamlBlock, yamlScalar } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'amend-task-tmp');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupRun(runId: string): string {
  const root = runDir(runId);
  mkdirSync(join(root, 'tasks'), { recursive: true });
  return root;
}

function writeTaskSpec(runId: string, taskId: string, content: string): string {
  const p = join(runDir(runId), 'tasks', `${taskId}.yaml`);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('rewriteTaskSpec', () => {
  it('bumps spec_version and stamps amendment metadata', () => {
    const content = `task_id: t1
spec_version: 3
objective: Do something.
`;
    const out = rewriteTaskSpec(content, 3, 4, 'clarify scope', 'restart');
    assert.match(out, /^spec_version: 4$/m);
    assert.match(out, /^supersedes: 3$/m);
    assert.match(out, /^amendment_reason: clarify scope$/m);
    assert.match(out, /^delivered_via: restart$/m);
  });

  it('replaces existing amendment metadata idempotently', () => {
    const content = `task_id: t1
spec_version: 2
supersedes: 1
amendment_reason: old reason
delivered_via: restart
objective: Do something.
`;
    const out = rewriteTaskSpec(content, 2, 3, 'new reason', 'resume');
    const lines = out.trim().split('\n');
    const specVersionCount = lines.filter((l) => l.startsWith('spec_version:')).length;
    const supersedesCount = lines.filter((l) => l.startsWith('supersedes:')).length;
    const reasonCount = lines.filter((l) => l.startsWith('amendment_reason:')).length;
    const deliveryCount = lines.filter((l) => l.startsWith('delivered_via:')).length;
    assert.equal(specVersionCount, 1);
    assert.equal(supersedesCount, 1);
    assert.equal(reasonCount, 1);
    assert.equal(deliveryCount, 1);
    assert.match(out, /^amendment_reason: new reason$/m);
    assert.match(out, /^delivered_via: resume$/m);
  });

  it('preserves block scalar content', () => {
    const content = `task_id: t1
spec_version: 1
objective: >
  Port the thing.
  Keep it exact.
`;
    const out = rewriteTaskSpec(content, 1, 2, 'expand objective', 'restart');
    assert.match(out, /^spec_version: 2$/m);
    assert.match(out, /Port the thing\./);
    assert.match(out, /Keep it exact\./);
  });

  it('does not inject extra blank lines when the original ends with a newline', () => {
    const content = 'task_id: t1\nspec_version: 1\n';
    const out = rewriteTaskSpec(content, 1, 2, 'r', 'restart');
    // The new keys should immediately follow the last original line.
    assert.match(out, /spec_version: 2\nsupersedes: 1\namendment_reason: r\ndelivered_via: restart\n$/);
  });

  it('matches awk -v escape processing for reason and delivery', () => {
    const content = 'task_id: t1\nspec_version: 1\n';
    const out = rewriteTaskSpec(content, 1, 2, 'first\\nsecond\\\\third', 're\\tstart');
    // The decoded reason now contains a real newline, so it must be written
    // as a block scalar (a plain `key: value` line cannot span lines without
    // corrupting the YAML) -- see the round-trip test below.
    assert.ok(out.includes('amendment_reason: |2\n  first\n  second\\third\n'));
    assert.ok(out.includes('delivered_via: re\tstart\n'));
  });

  it('emits a literal block scalar for a multi-line reason, and it round-trips exactly via yamlBlock', () => {
    const content = 'task_id: t1\nspec_version: 1\n';
    const reason = 'SPEC VERSION 2 -- REQUIRED FIX.\n\n1. Fix the thing.\n2. Also fix this # not a comment.\n';
    const out = rewriteTaskSpec(content, 1, 2, reason, 'restart');

    assert.match(out, /^amendment_reason: \|2$/m);
    // A plain scalar line for the same key must not also be present.
    assert.doesNotMatch(out, /^amendment_reason: [^|]/m);

    mkdirSync(TEST_TMP, { recursive: true });
    const specPath = join(TEST_TMP, 'roundtrip.yaml');
    writeFileSync(specPath, out, 'utf8');
    const roundTripped = yamlBlock(specPath, 'amendment_reason');
    // yamlBlock only trims a LEADING blank line, not a trailing one; a
    // reason ending in "\n" round-trips byte-for-byte because the block
    // scalar's final empty continuation line reconstitutes it on join.
    assert.equal(roundTripped, reason);
  });

  it('round-trips a reason whose first line is more indented than a later line, without corrupting it', () => {
    // A bare "|" header makes a real YAML parser auto-detect the base
    // indent from the FIRST content line -- but this writer always adds a
    // constant 2 spaces regardless of the value's own per-line indentation.
    // If the first line already had leading whitespace (e.g. pasted code),
    // auto-detection would pick up a too-large base, and a later,
    // less-indented "root level" line becomes invalid YAML / gets
    // corrupted on read. Declaring "|2" explicitly removes the ambiguity.
    const content = 'task_id: t1\nspec_version: 1\n';
    const reason = '  first\nsecond';
    const out = rewriteTaskSpec(content, 1, 2, reason, 'restart');

    assert.match(out, /^amendment_reason: \|2$/m);

    mkdirSync(TEST_TMP, { recursive: true });
    const specPath = join(TEST_TMP, 'roundtrip-uneven-indent.yaml');
    writeFileSync(specPath, out, 'utf8');
    assert.equal(yamlBlock(specPath, 'amendment_reason'), reason);
  });

  it('drops a prior multi-line amendment_reason block in full (header + continuation lines) when re-amending', () => {
    const firstPass = rewriteTaskSpec(
      'task_id: t1\nspec_version: 1\n',
      1,
      2,
      'first reason\nwith a second line\nand a third',
      'restart',
    );
    const secondPass = rewriteTaskSpec(firstPass, 2, 3, 'second reason', 'resume');

    const lines = secondPass.trim().split('\n');
    assert.equal(lines.filter((l) => l.startsWith('amendment_reason:')).length, 1);
    assert.equal(lines.filter((l) => l.startsWith('delivered_via:')).length, 1);
    assert.equal(lines.filter((l) => l.startsWith('supersedes:')).length, 1);
    // None of the first pass's continuation lines survived as stray content.
    assert.doesNotMatch(secondPass, /with a second line/);
    assert.doesNotMatch(secondPass, /and a third/);
    assert.match(secondPass, /^amendment_reason: second reason$/m);
    assert.match(secondPass, /^supersedes: 2$/m);
  });
});

describe('amendTask', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });
  after(() => {
    cleanTmp();
    delete process.env.HYDRA_STATE_ROOT;
  });

  it('amends a task spec and appends a ledger event', async () => {
    const runId = '001';
    const taskId = 'task-x';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
run_id: run-${runId}
spec_version: 1
objective: Do work.
`);

    const dispatches: Array<{ runId: string; taskId: string; delivery: string }> = [];
    await amendTask(runId, taskId, 'clarify objective', 'restart', {
      dispatch: (r, t, d) => {
        dispatches.push({ runId: r, taskId: t, delivery: d });
      },
    });

    const specPath = join(runDir(runId), 'tasks', `${taskId}.yaml`);
    assert.equal(yamlScalar(specPath, 'spec_version'), '2');
    assert.equal(yamlScalar(specPath, 'supersedes'), '1');
    assert.equal(yamlScalar(specPath, 'amendment_reason'), 'clarify objective');
    assert.equal(yamlScalar(specPath, 'delivered_via'), 'restart');

    const ledgerContent = readFileSync(ledger(runId), 'utf8').trim();
    const events = ledgerContent.split('\n').map((line) => JSON.parse(line));
    const amended = events.find((e) => e.event === 'task_spec_amended');
    assert.ok(amended);
    assert.equal(amended.task_id, taskId);
    assert.equal(amended.from, 'v1');
    assert.equal(amended.to, 'v2');
    assert.equal(amended.delivery, 'restart');
    assert.equal(amended.reason, 'clarify objective');

    assert.equal(dispatches.length, 1);
    assert.deepEqual(dispatches[0], { runId, taskId, delivery: 'restart' });
  });

  it('refreshes the worktree\'s own read-only .hydra-task.yaml copy, not just the authoritative spec', async () => {
    // The vendor CLI reads ONLY the worktree-local .hydra-task.yaml (it has
    // no access to the authoritative state root) -- if amendTask() only
    // rewrote the authoritative copy, a resumed/restarted worker would
    // silently keep reading the pre-amendment spec: no error, just the old
    // objective and no amendment_reason. This was a real bug found live.
    const runId = 'worktree-refresh';
    const taskId = 'task-refresh';
    const worktreeDir = join(TEST_TMP, 'wt-refresh');
    mkdirSync(worktreeDir, { recursive: true });
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
run_id: run-${runId}
worktree: ${worktreeDir}
spec_version: 1
objective: Original objective.
`);

    // Simulate create-worktree.ts's own read-only worktree copy.
    const worktreeSpecPath = join(worktreeDir, '.hydra-task.yaml');
    writeFileSync(
      worktreeSpecPath,
      `task_id: ${taskId}\nrun_id: run-${runId}\nworktree: ${worktreeDir}\nspec_version: 1\nobjective: Original objective.\n`,
      { mode: 0o444 },
    );

    await amendTask(runId, taskId, 'REQUIRED FIX: do the other thing', 'restart', {
      dispatch: () => {},
    });

    assert.equal(yamlScalar(worktreeSpecPath, 'spec_version'), '2');
    assert.equal(
      yamlScalar(worktreeSpecPath, 'amendment_reason'),
      'REQUIRED FIX: do the other thing',
    );
    // Still read-only afterward, matching create-worktree.ts's own convention.
    const mode = statSync(worktreeSpecPath).mode & 0o777;
    assert.equal(mode, 0o444);
  });

  it('dies with a clear error when the recorded worktree does not exist, WITHOUT mutating the spec or ledger first', async () => {
    const runId = 'worktree-missing';
    const taskId = 'task-missing-wt';
    setupRun(runId);
    const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
worktree: ${join(TEST_TMP, 'does-not-exist')}
spec_version: 1
`);

    let dispatched = false;
    await assert.rejects(
      amendTask(runId, taskId, 'reason', 'restart', { dispatch: () => { dispatched = true; } }),
      /worktree not found/,
    );

    // The missing-worktree check must run BEFORE the authoritative spec is
    // rewritten -- otherwise a failed amendment leaves a broken half-amended
    // state: spec_version bumped, amendment_reason set, but no refreshed
    // worktree copy, no ledger event, and no redispatch.
    assert.equal(yamlScalar(specPath, 'spec_version'), '1');
    assert.equal(yamlScalar(specPath, 'amendment_reason'), '');
    assert.equal(dispatched, false);
    assert.equal(existsSync(ledger(runId)), false);
  });

  it('dies (not ENOTDIR-crashes) when the recorded worktree is a regular file, not a directory', async () => {
    // existsSync() alone accepts a regular file too -- an earlier version of
    // this check used existsSync, so mkdtempSync() would throw ENOTDIR
    // later, AFTER the authoritative spec was already rewritten, recreating
    // the exact half-amended state the preflight exists to prevent.
    const runId = 'worktree-is-a-file';
    const taskId = 'task-file-wt';
    setupRun(runId);
    const notADir = join(TEST_TMP, 'worktree-as-file.txt');
    writeFileSync(notADir, 'not a directory', 'utf8');
    const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
worktree: ${notADir}
spec_version: 1
`);

    await assert.rejects(
      amendTask(runId, taskId, 'reason', 'restart', { dispatch: () => {} }),
      /worktree not found/,
    );
    assert.equal(yamlScalar(specPath, 'spec_version'), '1');
  });

  it('defaults delivery to restart', async () => {
    const runId = '002';
    const taskId = 'task-y';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
run_id: run-${runId}
spec_version: 5
objective: Do work.
`);

    const dispatches: Array<{ delivery: string }> = [];
    await amendTask(runId, taskId, 'reason', undefined, {
      dispatch: (r, t, d) => {
        dispatches.push({ delivery: d });
      },
    });

    assert.equal(dispatches[0].delivery, 'restart');
    assert.equal(
      yamlScalar(join(runDir(runId), 'tasks', `${taskId}.yaml`), 'delivered_via'),
      'restart',
    );
  });

  it('uses the native TS dispatch for default re-dispatch', async () => {
    const runId = 'native-dispatch';
    const taskId = 'task-native';
    setupRun(runId);
    const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
assigned_vendor: native-missing
worktree: ${TEST_TMP}
spec_version: 1
`);

    const originalRuntime = process.env.HYDRA_ADAPTER_RUNTIME;
    process.env.HYDRA_ADAPTER_RUNTIME = 'ts';
    try {
      await assert.rejects(
        amendTask(runId, taskId, 'exercise native dispatch'),
        /no adapter for vendor 'native-missing':.*hydra-ts\/src\/adapter-native-missing\.ts/,
      );
    } finally {
      if (originalRuntime === undefined) {
        delete process.env.HYDRA_ADAPTER_RUNTIME;
      } else {
        process.env.HYDRA_ADAPTER_RUNTIME = originalRuntime;
      }
    }

    assert.equal(yamlScalar(specPath, 'spec_version'), '2');
  });

  it('dies when task spec is missing', async () => {
    await assert.rejects(
      amendTask('missing', 'task-missing', 'reason', 'restart', { dispatch: () => {} }),
      /task spec not found/,
    );
  });

  it('dies when spec_version is missing', async () => {
    const runId = '003';
    setupRun(runId);
    writeTaskSpec(runId, 'task-z', `task_id: task-z
objective: No version.
`);
    await assert.rejects(
      amendTask(runId, 'task-z', 'reason', 'restart', { dispatch: () => {} }),
      /task spec has no spec_version/,
    );
  });

  it('dies when spec_version is not numeric', async () => {
    const runId = '004';
    setupRun(runId);
    writeTaskSpec(runId, 'task-w', `task_id: task-w
spec_version: abc
`);
    await assert.rejects(
      amendTask(runId, 'task-w', 'reason', 'restart', { dispatch: () => {} }),
      /invalid spec_version/,
    );
  });

  it('rejects a floating-point spec_version', async () => {
    const runId = '005';
    setupRun(runId);
    writeTaskSpec(runId, 'task-float', `task_id: task-float
spec_version: 3.5
`);
    await assert.rejects(
      amendTask(runId, 'task-float', 'reason', 'restart', { dispatch: () => {} }),
      /invalid spec_version/,
    );
  });

  it('preserves the original integer literal in supersedes and the ledger', async () => {
    for (const [runId, taskId, version] of [
      ['006', 'task-hex', '0x3'],
      ['007', 'task-octal', '03'],
    ]) {
      setupRun(runId);
      const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: ${version}
`);
      await amendTask(runId, taskId, 'reason', 'restart', { dispatch: () => {} });

      assert.equal(yamlScalar(specPath, 'spec_version'), '4');
      assert.equal(yamlScalar(specPath, 'supersedes'), version);
      const event = JSON.parse(readFileSync(ledger(runId), 'utf8').trim());
      assert.equal(event.from, `v${version}`);
      assert.equal(event.to, 'v4');
    }
  });

  it('replaces the task spec via a temporary file', async () => {
    const runId = '008';
    const taskId = 'task-atomic';
    setupRun(runId);
    const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
`);
    const originalInode = statSync(specPath).ino;

    await amendTask(runId, taskId, 'reason', 'restart', { dispatch: () => {} });

    assert.notEqual(statSync(specPath).ino, originalInode);
    assert.equal(statSync(specPath).mode & 0o777, 0o600);
  });
});

// Captures everything written to process.stderr during `fn` (synchronous) so a
// test can assert on warn()/log() output. Matches the capture pattern already
// used in dispatch.test.ts / run-log.test.ts.
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

async function captureStderrAsync<T>(fn: () => Promise<T>): Promise<{ output: string; result: T }> {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { output: chunks.join(''), result };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe('amendTask amendment_reason preservation warning', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });
  after(() => {
    cleanTmp();
    delete process.env.HYDRA_STATE_ROOT;
  });

  it('warns when discarding a non-empty prior amendment_reason that differs from the new reason', async () => {
    const runId = 'warn-differing';
    const taskId = 'task-warn-differ';
    setupRun(runId);
    // A spec that already carries a hand-edited amendment_reason (the live
    // run-0051 scenario): a detailed multi-line revise note.
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
run_id: run-${runId}
spec_version: 1
supersedes: 0
amendment_reason: |
  Detailed hand-edited revise note:
  - src/foo.ts:42 -- fix off-by-one
  - src/bar.ts:7  -- add null check
delivered_via: restart
objective: Do work.
`);

    const { output } = await captureStderrAsync(() =>
      amendTask(runId, taskId, 'short CLI summary', 'restart', { dispatch: () => {} }),
    );

    // Warning fires, names both the discard and the surviving CLI reason, and
    // surfaces a preview of the clobbered content (recognizable enough that
    // the operator notices the loss).
    assert.match(output, /hydra: warn: amend-task: discarding existing amendment_reason/);
    assert.match(output, /Detailed hand-edited revise note/);
    assert.match(output, /in favor of the new CLI reason argument/);

    // The amendment itself still proceeds (visibility-only, not blocking):
    // spec_version bumped, new reason persisted, prior content dropped.
    const specPath = join(runDir(runId), 'tasks', `${taskId}.yaml`);
    assert.equal(yamlScalar(specPath, 'spec_version'), '2');
    assert.equal(yamlScalar(specPath, 'amendment_reason'), 'short CLI summary');
  });

  it('truncates a long prior amendment_reason to ~80 chars in the warning preview', async () => {
    const runId = 'warn-truncate';
    const taskId = 'task-warn-trunc';
    setupRun(runId);
    const longReason = 'X'.repeat(200);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
amendment_reason: ${longReason}
`);

    const { output } = await captureStderrAsync(() =>
      amendTask(runId, taskId, 'new short reason', 'restart', { dispatch: () => {} }),
    );

    // Preview shows the first 80 chars + ellipsis, not the whole 200-char blob.
    assert.match(output, /discarding existing amendment_reason \(X{80}\.\.\.\)/);
  });

  it('does NOT warn when the new reason matches the prior amendment_reason (idempotent amend)', async () => {
    const runId = 'warn-idempotent';
    const taskId = 'task-warn-idem';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
amendment_reason: same reason
`);

    const { output } = await captureStderrAsync(() =>
      amendTask(runId, taskId, 'same reason', 'restart', { dispatch: () => {} }),
    );

    assert.doesNotMatch(output, /discarding existing amendment_reason/);
  });

  it('does NOT warn when there is no prior amendment_reason in the spec', async () => {
    const runId = 'warn-none';
    const taskId = 'task-warn-none';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
objective: Original objective.
`);

    const { output } = await captureStderrAsync(() =>
      amendTask(runId, taskId, 'fresh reason', 'restart', { dispatch: () => {} }),
    );

    assert.doesNotMatch(output, /discarding existing amendment_reason/);
  });

  it('warns when the prior reason is a plain scalar (not just when it is a block scalar)', async () => {
    const runId = 'warn-plain';
    const taskId = 'task-warn-plain';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
amendment_reason: prior plain reason
`);

    const { output } = await captureStderrAsync(() =>
      amendTask(runId, taskId, 'new reason', 'restart', { dispatch: () => {} }),
    );

    assert.match(output, /discarding existing amendment_reason \(prior plain reason\)/);
  });

  it('prints the warning BEFORE the spec is rewritten (the rewrite still happens)', async () => {
    // The warning is observability, not a guard. Order matters only in that
    // the rewrite MUST still proceed -- a regression that turned the warning
    // into a die() would surface here as a missing spec_version bump.
    const runId = 'warn-then-rewrite';
    const taskId = 'task-warn-order';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
amendment_reason: old
`);

    await captureStderrAsync(() =>
      amendTask(runId, taskId, 'new', 'restart', { dispatch: () => {} }),
    );

    const specPath = join(runDir(runId), 'tasks', `${taskId}.yaml`);
    assert.equal(yamlScalar(specPath, 'spec_version'), '2');
    assert.equal(yamlScalar(specPath, 'amendment_reason'), 'new');
  });
});

describe('resolveReason (@file expansion)', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });
  after(() => {
    cleanTmp();
    delete process.env.HYDRA_STATE_ROOT;
    delete process.env.HYDRA_ADAPTER_RUNTIME;
  });

  it('returns a literal reason unchanged when it does not start with @', () => {
    assert.equal(resolveReason('just a reason'), 'just a reason');
    assert.equal(resolveReason('reason with spaces and # hash'), 'reason with spaces and # hash');
    // A reason that contains but does not start with @ is literal.
    assert.equal(resolveReason('cc @alice'), 'cc @alice');
    // Empty string is literal (not @-prefixed).
    assert.equal(resolveReason(''), '');
  });

  it('reads the file contents when the reason starts with @', () => {
    mkdirSync(TEST_TMP, { recursive: true });
    const reasonFile = join(TEST_TMP, 'reason.txt');
    const contents = 'Multi-line\nreason\nfrom a file\n';
    writeFileSync(reasonFile, contents, 'utf8');

    assert.equal(resolveReason(`@${reasonFile}`), contents);
  });

  it('dies clearly when the @file path does not exist (does NOT silently use the literal @-string)', () => {
    const missing = join(TEST_TMP, 'does-not-exist.txt');
    assert.throws(
      () => resolveReason(`@${missing}`),
      // die() prefixes with "hydra: error:"; the message must name the file.
      /hydra: error: amend-task: reason file not found: /,
    );
    // Crucially: the error must NOT pass through as "treat the literal
    // '@missing/...' string as the reason", which would silently corrupt the
    // amendment_reason. Asserting the thrown error names the file confirms
    // the failure path was taken rather than the happy path.
  });

  it('main() resolves an @file reason and persists its contents as the amendment_reason', async () => {
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
    process.env.HYDRA_ADAPTER_RUNTIME = 'ts';
    try {
      mkdirSync(TEST_TMP, { recursive: true });
      const runId = 'main-atfile';
      setupRun(runId);
      const taskId = 'task-main-atfile';
      // assigned_vendor points at an adapter that does not exist, so the
      // default native dispatch fails AFTER the spec is rewritten -- that
      // failure is unrelated to @file resolution. We assert on the spec
      // state below to prove the @file contents were read and persisted
      // before the dispatch blew up.
      const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
assigned_vendor: native-missing
worktree: ${TEST_TMP}
spec_version: 1
objective: Do work.
`);

      const reasonFile = join(TEST_TMP, 'main-reason.txt');
      const reasonText = 'Detailed reason\nspanning multiple lines\nfrom a file\n';
      writeFileSync(reasonFile, reasonText, 'utf8');

      const exitCode = await main([runId, taskId, `@${reasonFile}`, 'restart']);
      // Dispatch failure (no adapter) -> main() catches it and returns 1.
      assert.equal(exitCode, 1);

      // The decisive assertion: the @file contents were resolved and written
      // as the new amendment_reason before dispatch was attempted. If
      // resolution had failed, exitCode would still be 1 but the spec would
      // still be at v1 with no amendment_reason at all.
      assert.equal(yamlScalar(specPath, 'spec_version'), '2');
      assert.equal(yamlBlock(specPath, 'amendment_reason'), reasonText);
    } finally {
      delete process.env.HYDRA_STATE_ROOT;
      delete process.env.HYDRA_ADAPTER_RUNTIME;
    }
  });

  it('main() accepts a literal (non-@) reason exactly as before', async () => {
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
    process.env.HYDRA_ADAPTER_RUNTIME = 'ts';
    try {
      mkdirSync(TEST_TMP, { recursive: true });
      const runId = 'main-literal';
      setupRun(runId);
      const taskId = 'task-main-literal';
      const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
assigned_vendor: native-missing
worktree: ${TEST_TMP}
spec_version: 1
`);

      const exitCode = await main([runId, taskId, 'literal reason', 'restart']);
      // Same dispatch-failure shape as the @file test above; the spec
      // mutation is what proves the literal-reason path still works.
      assert.equal(exitCode, 1);

      assert.equal(yamlScalar(specPath, 'spec_version'), '2');
      assert.equal(yamlScalar(specPath, 'amendment_reason'), 'literal reason');
    } finally {
      delete process.env.HYDRA_STATE_ROOT;
      delete process.env.HYDRA_ADAPTER_RUNTIME;
    }
  });

  it('main() fails with a clear error (exit 1) when the @file is missing', async () => {
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
    try {
      mkdirSync(TEST_TMP, { recursive: true });
      const runId = 'main-missing-atfile';
      setupRun(runId);
      const taskId = 'task-main-missing';
      const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
`);

      const missing = join(TEST_TMP, 'absent-reason.txt');
      const { output, result: exitCode } = await captureStderrAsync(() =>
        main([runId, taskId, `@${missing}`, 'restart']),
      );

      assert.equal(exitCode, 1);
      assert.match(output, /amend-task: reason file not found: /);
      // The spec was NOT mutated -- amendTask() never ran.
      assert.equal(yamlScalar(specPath, 'spec_version'), '1');
    } finally {
      delete process.env.HYDRA_STATE_ROOT;
    }
  });

  it('main() usage text mentions the @reason-file form', async () => {
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
    try {
      mkdirSync(TEST_TMP, { recursive: true });
      // No taskId supplied -> usage path.
      const { output, result: exitCode } = await captureStderrAsync(() =>
        main(['only-run-id']),
      );
      assert.equal(exitCode, 1);
      assert.match(output, /usage: amend-task\.sh <run_id> <task_id> <reason\|@reason-file> \[resume\|restart\]/);
    } finally {
      delete process.env.HYDRA_STATE_ROOT;
    }
  });
});
