import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const TEST_TMP = join(tmpdir(), `hydra-cancel-task-sh-${process.pid}`);
const CANCEL_TASK_SH = join(import.meta.dirname, '../../hydra/scripts/cancel-task.sh');

/**
 * Launcher-routing coverage for the `cancel-task` wrapper. The shell-adapter/
 * bash body lane was retired in run 0045 (docs/bash-lane-retirement-plan.md);
 * these cases verify the wrapper routes to the TypeScript implementation
 * (`ts`, the default) and to a pinned compiled binary (`bin`) with the
 * documented argv and BUN_BE_BUN hygiene. The retired-`bash` and
 * unrecognized-value rejections are exercised at the dispatch layer in
 * dispatch.test.ts.
 */

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
}

function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface Fixture {
  runId: string;
  taskId: string;
  stateRoot: string;
}

function fixture(id: string): Fixture {
  const stateRoot = join(TEST_TMP, id, 'state');
  const runDir = join(stateRoot, 'runs', `run-${id}`);
  const taskSpecPath = join(runDir, 'tasks', 'task-a.yaml');
  const ledgerPath = join(runDir, 'authoritative', 'ledger', 'events.jsonl');
  const worktree = join(TEST_TMP, id, 'worktree');
  const taskId = 'task-a';

  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(taskSpecPath, [
    `task_id: ${taskId}`,
    `run_id: ${id}`,
    'assigned_vendor: codex',
    `worktree: ${worktree}`,
    'timeout_minutes: 45',
    'spec_version: 1',
    `branch: hydra/${id}/${taskId}`,
    'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    '',
  ].join('\n'));
  // An already-terminal task: cancel-task must be idempotent (exit 0, print
  // the terminal event) rather than attempting to signal anything.
  writeFileSync(ledgerPath, [
    `${JSON.stringify({ time: '2026-07-14T00:00:00Z', event: 'task_started', run_id: id, task_id: taskId, vendor: 'codex', agent_run_id: `${id}-${taskId}-v1` })}\n`,
    `${JSON.stringify({ time: '2026-07-14T00:00:30Z', event: 'agent_exited', run_id: id, task_id: taskId, vendor: 'codex', exit_code: '0' })}\n`,
  ].join(''));

  return { runId: id, taskId, stateRoot };
}

function writeFakeBin(dir: string): { bin: string; record: string } {
  const bin = join(dir, 'fake-hydra-cli');
  const record = join(dir, 'fake-bin.record');
  writeFileSync(bin, [
    '#!/usr/bin/env bash',
    '{',
    '  printf \'argv:\';',
    '  for a in "$@"; do printf \' %s\' "$a"; done',
    '  printf \'\\n\'',
    '  if [ -n "${BUN_BE_BUN+x}" ]; then printf \'BUN_BE_BUN=set\\n\';',
    '  else printf \'BUN_BE_BUN=unset\\n\'; fi',
    '} >"$HYDRA_FAKE_BIN_RECORD"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(bin, 0o755);
  return { bin, record };
}

describe('cancel-task.sh launcher routing', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('routes the default/ts path to the TypeScript implementation and is idempotent on a terminal task', () => {
    const f = fixture(uniqueRunId('ts'));
    const result = spawnSync(
      'bash',
      [CANCEL_TASK_SH, f.runId, f.taskId, '--wait-seconds', '0'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HYDRA_HARNESS: 'ts',
          HYDRA_STATE_ROOT: f.stateRoot,
          HYDRA_REPO_ID: `test-${f.runId}`,
        },
      },
    );
    assert.equal(
      result.status,
      0,
      `ts route exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(result.stdout, /agent_exited/, 'ts cancel-task must report the existing terminal event');
  });

  it('routes the bin path to a pinned HYDRA_BIN with the cancel-task subcommand and original argv', () => {
    const f = fixture(uniqueRunId('bin'));
    const dir = join(TEST_TMP, f.runId);
    mkdirSync(dir, { recursive: true });
    const { bin, record } = writeFakeBin(dir);

    const result = spawnSync(
      'bash',
      [CANCEL_TASK_SH, f.runId, f.taskId, '--wait-seconds', '3'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HYDRA_HARNESS: 'bin',
          HYDRA_BIN: bin,
          HYDRA_STATE_ROOT: f.stateRoot,
          HYDRA_REPO_ID: `test-${f.runId}`,
          HYDRA_FAKE_BIN_RECORD: record,
          BUN_BE_BUN: '1',
        },
      },
    );
    assert.equal(
      result.status,
      0,
      `bin route exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.equal(existsSync(record), true, 'the pinned binary must actually be exec\'d');
    const captured = readFileSync(record, 'utf8');
    assert.equal(
      captured.includes(`argv: cancel-task ${f.runId} ${f.taskId} --wait-seconds 3`),
      true,
      `bin argv mismatch: ${captured}`,
    );
    assert.equal(
      captured.includes('BUN_BE_BUN=unset'),
      true,
      `BUN_BE_BUN must be stripped at the bin exec: ${captured}`,
    );
  });
});
