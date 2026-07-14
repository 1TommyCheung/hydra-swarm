import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const TEST_TMP = join(tmpdir(), `hydra-cancel-task-sh-${process.pid}`);
const CANCEL_TASK_SH = join(import.meta.dirname, '../../hydra/scripts/cancel-task.sh');

interface Fixture {
  runId: string;
  taskId: string;
  stateRoot: string;
  runDir: string;
  ledgerPath: string;
  helperPath: string;
  readyPath: string;
  processListPath: string;
  fakeBin: string;
}

type DispatcherMode = 'terminate' | 'delayed-terminal' | 'ignore-term' | 'change-identity';

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
}

function writeDispatcher(f: Fixture, mode: DispatcherMode = 'terminate'): void {
  const cancelled = JSON.stringify({
    time: '2026-07-14T00:00:02Z',
    event: 'agent_cancelled',
    run_id: f.runId,
    task_id: f.taskId,
    vendor: 'codex',
    source: `fake_dispatcher_${mode}`,
  });
  let trap: string;
  if (mode === 'terminate') {
    trap = "trap 'printf \"%s\\n\" \"$terminal\" >>\"$ledger\"; exit 0' TERM";
  } else if (mode === 'delayed-terminal') {
    trap = "trap '(sleep 1.2; printf \"%s\\n\" \"$terminal\" >>\"$ledger\") &' TERM";
  } else if (mode === 'change-identity') {
    trap = "trap ': >\"$ready.identity\"; exec sleep 30' TERM";
  } else {
    trap = "trap '' TERM";
  }
  writeFileSync(f.helperPath, [
    '#!/usr/bin/env bash',
    'ledger="$3"',
    'ready="$4"',
    `terminal='${cancelled}'`,
    trap,
    ': >"$ready"',
    'while :; do sleep 0.05; done',
    '',
  ].join('\n'));
  chmodSync(f.helperPath, 0o755);
}

function fixture(overrides: { runId?: string } = {}): Fixture {
  const runId = overrides.runId
    ?? `bash-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const taskId = 'task-a';
  const stateRoot = join(TEST_TMP, runId, 'state');
  const runDir = join(stateRoot, 'runs', `run-${runId}`);
  const ledgerPath = join(runDir, 'authoritative', 'ledger', 'events.jsonl');
  const helperPath = join(TEST_TMP, runId, 'dispatch.sh');
  const readyPath = join(TEST_TMP, runId, 'ready');
  const processListPath = join(TEST_TMP, runId, 'processes.tsv');
  const fakeBin = join(TEST_TMP, runId, 'bin');
  mkdirSync(join(runDir, 'tasks'), { recursive: true });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  mkdirSync(dirname(helperPath), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(processListPath, '');
  const fakePs = join(fakeBin, 'ps');
  writeFileSync(fakePs, [
    '#!/usr/bin/env bash',
    'while IFS=$\'\\t\' read -r pid command marker; do',
    '  [ -n "$pid" ] || continue',
    '  if [ "$marker" != "-" ] && [ -f "$marker" ]; then',
    '    command="sleep 30"',
    '  fi',
    '  printf "  %s %s\\n" "$pid" "$command"',
    'done <"$HYDRA_TEST_PROCESS_LIST"',
    '',
  ].join('\n'));
  chmodSync(fakePs, 0o755);
  writeFileSync(join(runDir, 'tasks', `${taskId}.yaml`), [
    `task_id: ${taskId}`,
    `run_id: ${runId}`,
    'assigned_vendor: codex',
    `worktree: ${join(TEST_TMP, runId, 'worktree')}`,
    'timeout_minutes: 45',
    'spec_version: 1',
    `branch: hydra/${runId}/${taskId}`,
    'base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    '',
  ].join('\n'));
  const entries = [
    {
      time: '2026-07-14T00:00:00Z',
      event: 'task_started',
      run_id: runId,
      task_id: taskId,
      vendor: 'codex',
      agent_run_id: `${runId}-${taskId}-v1`,
    },
  ];
  writeFileSync(ledgerPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));

  const result = {
    runId,
    taskId,
    stateRoot,
    runDir,
    ledgerPath,
    helperPath,
    readyPath,
    processListPath,
    fakeBin,
  };
  writeDispatcher(result);
  return result;
}

function envFor(f: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HYDRA_HARNESS: 'bash',
    HYDRA_STATE_ROOT: f.stateRoot,
    HYDRA_REPO_ID: `test-${f.runId}`,
    HYDRA_TEST_PROCESS_LIST: f.processListPath,
    PATH: `${f.fakeBin}:${process.env.PATH ?? ''}`,
  };
}

function appendEvent(f: Fixture, event: Record<string, unknown>): void {
  writeFileSync(f.ledgerPath, `${readFileSync(f.ledgerPath, 'utf8')}${JSON.stringify(event)}\n`);
}

function registerProcess(
  f: Fixture,
  pid: number,
  taskId: string,
  marker = '-',
): void {
  const command = `bash ${f.helperPath} ${f.runId} ${taskId} ${f.ledgerPath} ${f.readyPath}`;
  writeFileSync(
    f.processListPath,
    `${readFileSync(f.processListPath, 'utf8')}${pid}\t${command}\t${marker}\n`,
  );
}

function registerUnrelated(f: Fixture, pid: number): void {
  writeFileSync(
    f.processListPath,
    `${readFileSync(f.processListPath, 'utf8')}${pid}\tsleep 30\t-\n`,
  );
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function spawnDispatcher(f: Fixture, taskId = f.taskId, readyPath = f.readyPath): ChildProcess {
  return spawn('bash', [f.helperPath, f.runId, taskId, f.ledgerPath, readyPath], {
    stdio: 'ignore',
  });
}

function writePidfile(f: Fixture, pid: number): void {
  const pidfile = join(
    f.runDir,
    'sessions',
    'supervisor',
    `${f.runId}-${f.taskId}-v1.dispatch.pid`,
  );
  mkdirSync(dirname(pidfile), { recursive: true });
  writeFileSync(pidfile, `${pid}\n`, 'utf8');
}

function runCancel(f: Fixture, waitSeconds: number): ReturnType<typeof spawnSync> {
  return spawnSync(
    'bash',
    [CANCEL_TASK_SH, f.runId, f.taskId, '--wait-seconds', String(waitSeconds)],
    {
      encoding: 'utf8',
      env: envFor(f),
      timeout: 10_000,
    },
  );
}

describe('cancel-task.sh bash fallback', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('signals a dispatcher from its pidfile and observes its terminal event', async () => {
    const f = fixture();
    const dispatcher = spawnDispatcher(f);
    assert.ok(dispatcher.pid);

    try {
      await waitFor(f.readyPath);
      registerProcess(f, dispatcher.pid, f.taskId);
      writePidfile(f, dispatcher.pid);
      const result = runCancel(f, 3);

      assert.equal(
        result.status,
        0,
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.match(result.stdout, /agent_cancelled/);
      assert.match(result.stdout, /fake_dispatcher_terminate/);
      const events = readFileSync(f.ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string });
      assert.deepEqual(events.map(({ event }) => event), [
        'task_started',
        'agent_cancelled',
      ]);
    } finally {
      await stopChild(dispatcher);
    }
  });

  it('is idempotent when the current attempt is already terminal', () => {
    const f = fixture();
    appendEvent(f, {
      time: '2026-07-14T00:00:01Z',
      event: 'agent_exited',
      run_id: f.runId,
      task_id: f.taskId,
      agent_run_id: `${f.runId}-${f.taskId}-v1`,
      exit_code: 0,
    });

    const result = runCancel(f, 0);

    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /agent_exited/);
    assert.equal(readFileSync(f.ledgerPath, 'utf8').split('\n').filter(Boolean).length, 2);
  });

  it('finds the queued dispatcher by literal full-process scan and rejects a non-match', async () => {
    const f = fixture({
      runId: `bash+cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    appendEvent(f, {
      time: '2026-07-14T00:00:01Z',
      event: 'concurrency_wait',
      run_id: f.runId,
      task_id: f.taskId,
    });
    const invalidReady = `${f.readyPath}-invalid`;
    const invalid = spawnDispatcher(f, 'different-task', invalidReady);
    const dispatcher = spawnDispatcher(f);
    assert.ok(invalid.pid);
    assert.ok(dispatcher.pid);

    try {
      await Promise.all([waitFor(invalidReady), waitFor(f.readyPath)]);
      registerProcess(f, invalid.pid, 'different-task');
      registerProcess(f, dispatcher.pid, f.taskId);
      const result = runCancel(f, 3);

      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /agent_cancelled/);
      assert.equal(invalid.kill(0), true, 'non-matching dispatcher must not be signaled');
    } finally {
      await Promise.all([stopChild(invalid), stopChild(dispatcher)]);
    }
  });

  it('rejects a stale live pidfile PID and signals the discovered dispatcher', async () => {
    const f = fixture();
    const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' });
    const dispatcher = spawnDispatcher(f);
    assert.ok(unrelated.pid);
    assert.ok(dispatcher.pid);

    try {
      await waitFor(f.readyPath);
      registerUnrelated(f, unrelated.pid);
      registerProcess(f, dispatcher.pid, f.taskId);
      writePidfile(f, unrelated.pid);
      const result = runCancel(f, 3);

      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /agent_cancelled/);
      assert.equal(unrelated.kill(0), true, 'stale pidfile target must not be signaled');
    } finally {
      await Promise.all([stopChild(unrelated), stopChild(dispatcher)]);
    }
  });

  it('escalates an unresponsive dispatcher to SIGKILL and observes a terminal event', async () => {
    const f = fixture();
    writeDispatcher(f, 'delayed-terminal');
    const dispatcher = spawnDispatcher(f);
    assert.ok(dispatcher.pid);

    try {
      await waitFor(f.readyPath);
      registerProcess(f, dispatcher.pid, f.taskId);
      writePidfile(f, dispatcher.pid);
      const result = runCancel(f, 1);

      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /agent_cancelled/);
      assert.match(result.stdout, /fake_dispatcher_delayed-terminal/);
    } finally {
      await stopChild(dispatcher);
    }
  });

  it('reports an orphan after SIGKILL without fabricating a ledger event', async () => {
    const f = fixture();
    writeDispatcher(f, 'ignore-term');
    const dispatcher = spawnDispatcher(f);
    assert.ok(dispatcher.pid);

    try {
      await waitFor(f.readyPath);
      registerProcess(f, dispatcher.pid, f.taskId);
      writePidfile(f, dispatcher.pid);
      const before = readFileSync(f.ledgerPath, 'utf8');
      const result = runCancel(f, 0);

      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /ORPHAN.*manual investigation.*no ledger event was fabricated/);
      assert.equal(readFileSync(f.ledgerPath, 'utf8'), before);
    } finally {
      await stopChild(dispatcher);
    }
  });

  it('skips SIGKILL when escalation-time identity no longer matches', async () => {
    const f = fixture();
    writeDispatcher(f, 'change-identity');
    const dispatcher = spawnDispatcher(f);
    assert.ok(dispatcher.pid);

    try {
      await waitFor(f.readyPath);
      registerProcess(f, dispatcher.pid, f.taskId, `${f.readyPath}.identity`);
      writePidfile(f, dispatcher.pid);
      const result = runCancel(f, 1);

      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /ORPHAN/);
      assert.equal(dispatcher.kill(0), true, 'identity-mismatched PID must not receive SIGKILL');
    } finally {
      await stopChild(dispatcher);
    }
  });
});
