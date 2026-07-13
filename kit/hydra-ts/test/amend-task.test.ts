import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { amendTask, rewriteTaskSpec } from '../src/amend-task.ts';
import { ledger, runDir, yamlScalar } from '../src/lib.ts';

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
    assert.ok(out.includes('amendment_reason: first\nsecond\\third\n'));
    assert.ok(out.includes('delivered_via: re\tstart\n'));
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

  it('amends a task spec and appends a ledger event', () => {
    const runId = '001';
    const taskId = 'task-x';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
run_id: run-${runId}
spec_version: 1
objective: Do work.
`);

    const dispatches: Array<{ runId: string; taskId: string; delivery: string }> = [];
    amendTask(runId, taskId, 'clarify objective', 'restart', {
      dispatch: (r, t, d) => dispatches.push({ runId: r, taskId: t, delivery: d }),
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

  it('defaults delivery to restart', () => {
    const runId = '002';
    const taskId = 'task-y';
    setupRun(runId);
    writeTaskSpec(runId, taskId, `task_id: ${taskId}
run_id: run-${runId}
spec_version: 5
objective: Do work.
`);

    const dispatches: Array<{ delivery: string }> = [];
    amendTask(runId, taskId, 'reason', undefined, {
      dispatch: (r, t, d) => dispatches.push({ delivery: d }),
    });

    assert.equal(dispatches[0].delivery, 'restart');
    assert.equal(
      yamlScalar(join(runDir(runId), 'tasks', `${taskId}.yaml`), 'delivered_via'),
      'restart',
    );
  });

  it('dies when task spec is missing', () => {
    assert.throws(() => {
      amendTask('missing', 'task-missing', 'reason', 'restart', { dispatch: () => {} });
    }, /task spec not found/);
  });

  it('dies when spec_version is missing', () => {
    const runId = '003';
    setupRun(runId);
    writeTaskSpec(runId, 'task-z', `task_id: task-z
objective: No version.
`);
    assert.throws(() => {
      amendTask(runId, 'task-z', 'reason', 'restart', { dispatch: () => {} });
    }, /task spec has no spec_version/);
  });

  it('dies when spec_version is not numeric', () => {
    const runId = '004';
    setupRun(runId);
    writeTaskSpec(runId, 'task-w', `task_id: task-w
spec_version: abc
`);
    assert.throws(() => {
      amendTask(runId, 'task-w', 'reason', 'restart', { dispatch: () => {} });
    }, /invalid spec_version/);
  });

  it('rejects a floating-point spec_version', () => {
    const runId = '005';
    setupRun(runId);
    writeTaskSpec(runId, 'task-float', `task_id: task-float
spec_version: 3.5
`);
    assert.throws(() => {
      amendTask(runId, 'task-float', 'reason', 'restart', { dispatch: () => {} });
    }, /invalid spec_version/);
  });

  it('preserves the original integer literal in supersedes and the ledger', () => {
    for (const [runId, taskId, version] of [
      ['006', 'task-hex', '0x3'],
      ['007', 'task-octal', '03'],
    ]) {
      setupRun(runId);
      const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: ${version}
`);
      amendTask(runId, taskId, 'reason', 'restart', { dispatch: () => {} });

      assert.equal(yamlScalar(specPath, 'spec_version'), '4');
      assert.equal(yamlScalar(specPath, 'supersedes'), version);
      const event = JSON.parse(readFileSync(ledger(runId), 'utf8').trim());
      assert.equal(event.from, `v${version}`);
      assert.equal(event.to, 'v4');
    }
  });

  it('replaces the task spec via a temporary file', () => {
    const runId = '008';
    const taskId = 'task-atomic';
    setupRun(runId);
    const specPath = writeTaskSpec(runId, taskId, `task_id: ${taskId}
spec_version: 1
`);
    const originalInode = statSync(specPath).ino;

    amendTask(runId, taskId, 'reason', 'restart', { dispatch: () => {} });

    assert.notEqual(statSync(specPath).ino, originalInode);
    assert.equal(statSync(specPath).mode & 0o777, 0o600);
  });
});
