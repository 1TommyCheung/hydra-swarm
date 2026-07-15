import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecFileSyncOptions } from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { herdrPush, type HerdrPushOptions, type PaneState } from '../src/herdr-push.ts';
import { authDir, ledger, runDir } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-herdr-push');
const ORIGINAL_STATE_ROOT = process.env.HYDRA_STATE_ROOT;

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function uniqueRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface LedgerEntry {
  time?: string;
  event?: string;
  run_id?: string;
  task_id?: string;
  vendor?: string;
  status?: string;
}

function setupRun(runId: string, entries: LedgerEntry[]): void {
  const ledgerPath = ledger(runId);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(
    ledgerPath,
    entries.map((e) => `${JSON.stringify(e)}\n`).join(''),
    'utf8',
  );
}

function setupTask(runId: string, taskId: string, worktree: string): void {
  const taskDir = join(runDir(runId), 'tasks');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, `${taskId}.yaml`),
    `worktree: ${worktree}\n`,
    'utf8',
  );
}

interface ExecCall {
  file: string;
  args: string[];
  cwd?: string;
}

interface MockExecState {
  calls: ExecCall[];
  available: boolean;
  paneList?: unknown;
  agentList?: unknown;
  repoRoot?: string;
}

function makeMockExec(state: MockExecState): HerdrPushOptions['exec'] {
  return (
    file: string,
    args: string[],
    options?: ExecFileSyncOptions,
  ): string => {
    const call: ExecCall = { file, args: args.slice() };
    if (options?.cwd) call.cwd = options.cwd;
    state.calls.push(call);

    if (file === 'herdr' && args[0] === 'status') {
      if (!state.available) throw new Error('herdr not available');
      return '';
    }
    if (file === 'herdr' && args[0] === 'pane' && args[1] === 'list') {
      return JSON.stringify(state.paneList ?? { result: { panes: [] } });
    }
    if (file === 'herdr' && args[0] === 'agent' && args[1] === 'list') {
      return JSON.stringify(state.agentList ?? { result: { agents: [] } });
    }
    if (
      file === 'git' &&
      args[0] === 'rev-parse' &&
      args[1] === '--show-toplevel'
    ) {
      return `${state.repoRoot ?? '/repo'}\n`;
    }
    return '';
  };
}

function captureIO<T>(fn: () => T): { result: T; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe('herdrPush', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });

  after(() => {
    cleanTmp();
    if (ORIGINAL_STATE_ROOT === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = ORIGINAL_STATE_ROOT;
    }
  });

  it('throws when runId is empty', () => {
    assert.throws(() => herdrPush(''), /usage: herdrPush/);
  });

  it('throws when the ledger is missing', () => {
    const runId = uniqueRunId('no-ledger');
    mkdirSync(runDir(runId), { recursive: true });
    assert.throws(() => herdrPush(runId), /no ledger for run/);
  });

  it('derives pane state from ledger events', () => {
    const runId = uniqueRunId('derive');
    setupRun(runId, [
      { time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId },
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
      {
        time: '2024-01-01T00:02:00Z',
        event: 'result_promoted',
        run_id: runId,
        task_id: 't1',
      },
      {
        time: '2024-01-01T00:03:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't2',
        vendor: 'codex',
      },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { result } = captureIO(() => herdrPush(runId, { exec: makeMockExec(mock) }));

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      task: 't1',
      vendor: 'claude',
      last_event: 'result_promoted',
      promoted: true,
      rejected: false,
      running: true,
    });
    assert.deepEqual(result[1], {
      task: 't2',
      vendor: 'codex',
      last_event: 'task_started',
      promoted: false,
      rejected: false,
      running: true,
    });
  });

  it('sorts interleaved task groups by task_id like jq group_by', () => {
    const runId = uniqueRunId('interleaved');
    setupRun(runId, [
      { event: 'task_started', task_id: 'z-task', vendor: 'claude' },
      { event: 'task_started', task_id: 'a-task', vendor: 'codex' },
      { event: 'result_promoted', task_id: 'z-task' },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { result } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    assert.deepEqual(
      result.map((pane) => pane.task),
      ['a-task', 'z-task'],
    );
    assert.equal(result[1].last_event, 'result_promoted');
  });

  it('uses null when the last task entry has no event', () => {
    const runId = uniqueRunId('missing-event');
    setupRun(runId, [
      { event: 'task_started', task_id: 't1', vendor: 'claude' },
      { task_id: 't1' },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { result } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    assert.equal(result[0].last_event, null);
  });

  it('retains a task whose id is literally run', () => {
    const runId = uniqueRunId('run-task');
    setupRun(runId, [
      { event: 'task_started', task_id: 'run', vendor: 'codex' },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { result } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    assert.equal(result.length, 1);
    assert.equal(result[0].task, 'run');
  });

  it('marks running false when terminal events outnumber starts', () => {
    const runId = uniqueRunId('not-running');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
      {
        time: '2024-01-01T00:02:00Z',
        event: 'agent_exited',
        run_id: runId,
        task_id: 't1',
      },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { result } = captureIO(() => herdrPush(runId, { exec: makeMockExec(mock) }));

    assert.equal(result[0].running, false);
  });

  it('ignores events with no task_id', () => {
    const runId = uniqueRunId('no-task');
    setupRun(runId, [
      { time: '2024-01-01T00:00:00Z', event: 'run_started', run_id: runId },
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { result } = captureIO(() => herdrPush(runId, { exec: makeMockExec(mock) }));

    assert.equal(result.length, 1);
    assert.equal(result[0].task, 't1');
  });

  it('writes a fallback JSON file when herdr is not available', () => {
    const runId = uniqueRunId('fallback');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { stdout, stderr } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    const fallback = join(authDir(runId), 'herdr-panes.json');
    assert.ok(existsSync(fallback));
    const written = JSON.parse(readFileSync(fallback, 'utf8')) as PaneState[];
    assert.equal(written.length, 1);
    assert.equal(written[0].task, 't1');
    assert.equal(stdout, `${JSON.stringify(written)}\n`);
    assert.match(stderr, /herdr not running/);
  });

  it('finds the lead pane and renames it with a summary', () => {
    const runId = uniqueRunId('lead-pane');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: {
        result: {
          panes: [
            { pane_id: 'p1', cwd: '/other', agent: null },
            { pane_id: 'p2', cwd: '/repo', agent: { id: 'a1' } },
          ],
        },
      },
    };
    const { stderr } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    const renameCall = mock.calls.find(
      (c) => c.file === 'herdr' && c.args[0] === 'pane' && c.args[1] === 'rename',
    );
    assert.ok(renameCall);
    assert.equal(renameCall.args[2], 'p2');
    assert.match(renameCall.args[3], /hydra .* · 0 promoted · 1 running/);
    assert.match(stderr, /pushed pane label -> p2:/);
  });

  it('falls back to HYDRA_HERDR_PANE when no matching pane is found', () => {
    const runId = uniqueRunId('env-pane');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const previousPane = process.env.HYDRA_HERDR_PANE;
    process.env.HYDRA_HERDR_PANE = 'env-pane-42';
    try {
      const mock: MockExecState = {
        calls: [],
        available: true,
        repoRoot: '/repo',
        paneList: { result: { panes: [] } },
      };
      captureIO(() => herdrPush(runId, { exec: makeMockExec(mock) }));

      const renameCall = mock.calls.find(
        (c) =>
          c.file === 'herdr' && c.args[0] === 'pane' && c.args[1] === 'rename',
      );
      assert.ok(renameCall);
      assert.equal(renameCall.args[2], 'env-pane-42');
    } finally {
      if (previousPane === undefined) {
        delete process.env.HYDRA_HERDR_PANE;
      } else {
        process.env.HYDRA_HERDR_PANE = previousPane;
      }
    }
  });

  it('warns when no lead pane is identified', () => {
    const runId = uniqueRunId('no-lead');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const previousPane = process.env.HYDRA_HERDR_PANE;
    delete process.env.HYDRA_HERDR_PANE;
    try {
      const mock: MockExecState = {
        calls: [],
        available: true,
        repoRoot: '/repo',
        paneList: { result: { panes: [] } },
      };
      const { stderr } = captureIO(() =>
        herdrPush(runId, { exec: makeMockExec(mock) }),
      );
      assert.match(stderr, /no lead pane identified/);
    } finally {
      if (previousPane === undefined) {
        delete process.env.HYDRA_HERDR_PANE;
      } else {
        process.env.HYDRA_HERDR_PANE = previousPane;
      }
    }
  });

  it('sends a notification when notify is true', () => {
    const runId = uniqueRunId('notify');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
      {
        time: '2024-01-01T00:02:00Z',
        event: 'result_promoted',
        run_id: runId,
        task_id: 't1',
      },
    ]);

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: { result: { panes: [] } },
    };
    const { stderr } = captureIO(() =>
      herdrPush(runId, { notify: true, exec: makeMockExec(mock) }),
    );

    const notifyCall = mock.calls.find(
      (c) =>
        c.file === 'herdr' && c.args[0] === 'notification' && c.args[1] === 'show',
    );
    assert.ok(notifyCall);
    assert.equal(notifyCall.args[2], `Hydra run ${runId}`);
    assert.ok(notifyCall.args.includes('done'));
    assert.match(stderr, /pushed notification:/);
  });

  it('notifies with jq null semantics for an empty ledger', () => {
    const runId = uniqueRunId('notify-empty');
    setupRun(runId, []);

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: { result: { panes: [] } },
    };
    captureIO(() =>
      herdrPush(runId, { notify: true, exec: makeMockExec(mock) }),
    );

    const notifyCall = mock.calls.find(
      (c) =>
        c.file === 'herdr' && c.args[0] === 'notification' && c.args[1] === 'show',
    );
    assert.ok(notifyCall);
    const bodyIndex = notifyCall.args.indexOf('--body');
    assert.equal(
      notifyCall.args[bodyIndex + 1],
      `null  · hydra ${runId} · 0 promoted · 0 running`,
    );
  });

  it('notifies with null when the last entry has no event', () => {
    const runId = uniqueRunId('notify-missing-event');
    setupRun(runId, [{ task_id: 't1' }]);

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: { result: { panes: [] } },
    };
    captureIO(() =>
      herdrPush(runId, { notify: true, exec: makeMockExec(mock) }),
    );

    const notifyCall = mock.calls.find(
      (c) =>
        c.file === 'herdr' && c.args[0] === 'notification' && c.args[1] === 'show',
    );
    assert.ok(notifyCall);
    const bodyIndex = notifyCall.args.indexOf('--body');
    assert.match(notifyCall.args[bodyIndex + 1], /^null t1 ·/);
  });

  it('uses the request sound for rejected or failed events', () => {
    const runId = uniqueRunId('notify-reject');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
      {
        time: '2024-01-01T00:02:00Z',
        event: 'result_rejected',
        run_id: runId,
        task_id: 't1',
      },
    ]);

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: { result: { panes: [] } },
    };
    captureIO(() => herdrPush(runId, { notify: true, exec: makeMockExec(mock) }));

    const notifyCall = mock.calls.find(
      (c) =>
        c.file === 'herdr' && c.args[0] === 'notification' && c.args[1] === 'show',
    );
    assert.ok(notifyCall);
    assert.ok(notifyCall.args.includes('request'));
  });

  it('detects anomalies when live working disagrees with ledger running', () => {
    const runId = uniqueRunId('anomaly');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);
    setupTask(runId, 't1', '/worktrees/t1');

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: { result: { panes: [] } },
      agentList: {
        result: {
          agents: [{ cwd: '/worktrees/t1', agent_status: 'idle' }],
        },
      },
    };
    const { stderr } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    assert.match(stderr, /ANOMALY \[t1\]/);

    const ledgerEvents = readFileSync(ledger(runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const anomaly = ledgerEvents.find((e) => e.event === 'observability_anomaly');
    assert.ok(anomaly);
    assert.equal(anomaly.task_id, 't1');
    assert.equal(anomaly.ledger_running, 'true');
    assert.equal(anomaly.live_working, 'false');
  });

  it('does not flag an anomaly when live state matches ledger', () => {
    const runId = uniqueRunId('no-anomaly');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);
    setupTask(runId, 't1', '/worktrees/t1');

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: { result: { panes: [] } },
      agentList: {
        result: {
          agents: [{ cwd: '/worktrees/t1', agent_status: 'working' }],
        },
      },
    };
    const { stderr } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    assert.doesNotMatch(stderr, /ANOMALY/);
  });

  it('skips reconciliation for tasks with no worktree', () => {
    const runId = uniqueRunId('no-worktree');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const mock: MockExecState = {
      calls: [],
      available: true,
      repoRoot: '/repo',
      paneList: { result: { panes: [] } },
      agentList: {
        result: {
          agents: [{ cwd: '/worktrees/t1', agent_status: 'idle' }],
        },
      },
    };
    const { stderr } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    assert.doesNotMatch(stderr, /ANOMALY/);
  });

  it('prints compact JSON pane state to stdout', () => {
    const runId = uniqueRunId('stdout');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const mock: MockExecState = { calls: [], available: false };
    const { stdout, result } = captureIO(() =>
      herdrPush(runId, { exec: makeMockExec(mock) }),
    );

    assert.equal(stdout, `${JSON.stringify(result)}\n`);
    assert.ok(!stdout.includes('\n{\n'));
  });

  it('honours an explicit repoRoot override', () => {
    const runId = uniqueRunId('repo-root-override');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const mock: MockExecState = {
      calls: [],
      available: true,
      paneList: {
        result: {
          panes: [{ pane_id: 'p9', cwd: '/custom-root', agent: { id: 'a1' } }],
        },
      },
    };
    captureIO(() =>
      herdrPush(runId, { repoRoot: '/custom-root', exec: makeMockExec(mock) }),
    );

    assert.ok(
      !mock.calls.some(
        (c) =>
          c.file === 'git' && c.args[0] === 'rev-parse',
      ),
    );
    const renameCall = mock.calls.find(
      (c) => c.file === 'herdr' && c.args[0] === 'pane' && c.args[1] === 'rename',
    );
    assert.ok(renameCall);
    assert.equal(renameCall.args[2], 'p9');
  });

  it('uses cwd for external commands when provided', () => {
    const runId = uniqueRunId('cwd');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const mock: MockExecState = {
      calls: [],
      available: true,
      paneList: { result: { panes: [] } },
    };
    captureIO(() =>
      herdrPush(runId, { cwd: '/some/dir', exec: makeMockExec(mock) }),
    );

    const gitCall = mock.calls.find((c) => c.file === 'git');
    assert.ok(gitCall);
    assert.equal(gitCall.cwd, '/some/dir');
  });

  it('resolves an explicit stateRoot without mutating process.env', () => {
    const runId = uniqueRunId('state-root');
    const explicitRoot = join(TEST_TMP, 'explicit-root');
    const ledgerPath = join(
      explicitRoot,
      'runs',
      `run-${runId}`,
      'authoritative',
      'ledger',
      'events.jsonl',
    );
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ event: 'task_started', task_id: 't1' })}\n`,
      'utf8',
    );

    const expectedStateRoot = process.env.HYDRA_STATE_ROOT;
    let observedStateRoot: string | undefined;
    const mock: MockExecState = { calls: [], available: false };
    const mockExec = makeMockExec(mock);
    captureIO(() =>
      herdrPush(runId, {
        stateRoot: explicitRoot,
        exec(file, args, options) {
          observedStateRoot = process.env.HYDRA_STATE_ROOT;
          return mockExec(file, args, options);
        },
      }),
    );

    assert.equal(observedStateRoot, expectedStateRoot);
    assert.equal(process.env.HYDRA_STATE_ROOT, expectedStateRoot);
    assert.ok(
      existsSync(
        join(
          explicitRoot,
          'runs',
          `run-${runId}`,
          'authoritative',
          'herdr-panes.json',
        ),
      ),
    );
  });

  it('rejects a malformed JSONL line', () => {
    const runId = uniqueRunId('malformed');
    const ledgerPath = ledger(runId);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ event: 'task_started', task_id: 't1' })}\nnot-json\n`,
      'utf8',
    );

    const mock: MockExecState = { calls: [], available: false };
    assert.throws(
      () => herdrPush(runId, { exec: makeMockExec(mock) }),
      /JSON|Unexpected token/,
    );
  });

  it('the real default runner strips BUN_BE_BUN from every herdr child (Stage 4 review bug #2)', () => {
    // No exec injection: this exercises defaultExec itself. A stub `herdr`
    // on PATH records whether BUN_BE_BUN is present in its own environment
    // for every call site herdrPush drives (status probe, pane list, pane
    // rename, notification show, agent list).
    const runId = uniqueRunId('bunbebun');
    setupRun(runId, [
      { event: 'task_started', task_id: 't1', run_id: runId, vendor: 'claude' },
      { event: 'agent_exited', task_id: 't1', run_id: runId },
    ]);

    const binDir = join(TEST_TMP, `stub-bin-${process.pid}`);
    mkdirSync(binDir, { recursive: true });
    const stubLog = join(TEST_TMP, `herdr-stub-${process.pid}.log`);
    writeFileSync(
      join(binDir, 'herdr'),
      [
        '#!/bin/sh',
        'state=absent',
        'if [ "${BUN_BE_BUN+x}" = "x" ]; then state="present"; fi',
        'printf \'%s BUN_BE_BUN=%s\\n\' "$*" "$state" >> "$HYDRA_HERDR_STUB_LOG"',
        'case "$1" in',
        '  pane) [ "$2" = "list" ] && printf \'{"result":{"panes":[{"agent":"lead","cwd":"/repo","pane_id":"pane-1"}]}}\\n\' ;;',
        '  agent) [ "$2" = "list" ] && printf \'{"result":{"agents":[]}}\\n\' ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const saved = {
      PATH: process.env.PATH,
      BUN_BE_BUN: process.env.BUN_BE_BUN,
      HYDRA_HERDR_STUB_LOG: process.env.HYDRA_HERDR_STUB_LOG,
    };
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    // Prove the strip: with BUN_BE_BUN set in the PARENT environment, an
    // unstripped child would observe it (the pre-fix behavior).
    process.env.BUN_BE_BUN = '1';
    process.env.HYDRA_HERDR_STUB_LOG = stubLog;
    try {
      const { result } = captureIO(() =>
        herdrPush(runId, { notify: true, repoRoot: '/repo' }),
      );
      assert.equal(result.length, 1);
    } finally {
      process.env.PATH = saved.PATH ?? '';
      if (saved.BUN_BE_BUN === undefined) delete process.env.BUN_BE_BUN;
      else process.env.BUN_BE_BUN = saved.BUN_BE_BUN;
      if (saved.HYDRA_HERDR_STUB_LOG === undefined) delete process.env.HYDRA_HERDR_STUB_LOG;
      else process.env.HYDRA_HERDR_STUB_LOG = saved.HYDRA_HERDR_STUB_LOG;
    }

    const log = readFileSync(stubLog, 'utf8').trim().split('\n');
    // All five herdr call sites fired...
    assert.ok(log.some((l) => l.startsWith('status ')), `status call missing: ${log}`);
    assert.ok(log.some((l) => l.startsWith('pane list ')), `pane list missing: ${log}`);
    assert.ok(log.some((l) => l.startsWith('pane rename pane-1 ')), `pane rename missing: ${log}`);
    assert.ok(log.some((l) => l.startsWith('notification show ')), `notification missing: ${log}`);
    assert.ok(log.some((l) => l.startsWith('agent list ')), `agent list missing: ${log}`);
    // ...and none of their children could observe BUN_BE_BUN.
    for (const line of log) {
      assert.ok(line.endsWith('BUN_BE_BUN=absent'), `child saw BUN_BE_BUN: ${line}`);
    }
  });
});

describe('CLI', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = TEST_TMP;
  });

  after(() => {
    cleanTmp();
    if (ORIGINAL_STATE_ROOT === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = ORIGINAL_STATE_ROOT;
    }
  });

  it('prints pane JSON and exits 0 for a valid run', () => {
    const runId = uniqueRunId('cli');
    setupRun(runId, [
      {
        time: '2024-01-01T00:01:00Z',
        event: 'task_started',
        run_id: runId,
        task_id: 't1',
        vendor: 'claude',
      },
    ]);

    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'herdr-push.ts'),
        runId,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HYDRA_STATE_ROOT: TEST_TMP },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const panes = JSON.parse(result.stdout) as PaneState[];
    assert.equal(panes.length, 1);
    assert.equal(panes[0].task, 't1');
  });

  it('exits non-zero when the ledger is missing', () => {
    const runId = uniqueRunId('cli-no-ledger');
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'herdr-push.ts'),
        runId,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, HYDRA_STATE_ROOT: TEST_TMP },
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no ledger for run/);
  });
});
