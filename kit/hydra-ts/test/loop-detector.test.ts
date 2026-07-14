import assert from 'node:assert/strict';
import {
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type LedgerEntry } from '../src/current-attempt.ts';
import {
  createLoopDetectorState,
  detectCycle,
  extractCodexSignatures,
  extractKimiSignatures,
  extractOpenCodeSignatures,
  loopDetectorTick,
  readCaptureIncrementally,
  sampleGitSignature,
  sha256,
  type LoopDetectorOptions,
  type LoopDetectorState,
} from '../src/loop-detector.ts';

const TEST_TMP = mkdtempSync(join(tmpdir(), 'hydra-loop-detector-'));

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function baseOptions(overrides: Partial<LoopDetectorOptions> = {}): LoopDetectorOptions {
  const clock = makeClock();
  const ledger: LedgerEntry[] = [];
  const dispatchInstanceId = overrides.dispatchInstanceId ?? 'deadbeefdeadbeef';
  const agentRunId = overrides.agentRunId ?? '0014-task-a-v1';
  const taskId = overrides.taskId ?? 'task-a';
  const runId = overrides.runId ?? '0014';
  // Seed the ledger with the current task_started so the identity check passes
  // by default in unit tests.
  ledger.push({
    time: '2026-07-14T00:00:00Z',
    event: 'task_started',
    run_id: runId,
    task_id: taskId,
    agent_run_id: agentRunId,
    dispatch_instance_id: dispatchInstanceId,
  });
  const options: LoopDetectorOptions = {
    runId,
    taskId,
    worktree: TEST_TMP,
    sessionsDir: TEST_TMP,
    agentRunId,
    vendor: 'codex',
    dispatchInstanceId,
    pollIntervalMs: 2000,
    clock,
    appendLedger: (event, ...kvs) => {
      const entry: LedgerEntry = {
        event,
        run_id: runId,
        task_id: taskId,
        agent_run_id: agentRunId,
        dispatch_instance_id: dispatchInstanceId,
      };
      for (let i = 0; i + 1 < kvs.length; i += 2) entry[kvs[i]] = kvs[i + 1];
      ledger.push(entry);
    },
    readLedger: () => ledger,
    execGit: (_file: string, args: string[]) => {
      if (args.includes('rev-parse')) return 'HEAD\n';
      if (args.includes('diff')) return '';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return '';
      return '';
    },
    ...overrides,
  };
  (options as unknown as { ledger: LedgerEntry[] }).ledger = ledger;
  return options;
}

function ledgerEvents(opts: LoopDetectorOptions): LedgerEntry[] {
  return (opts as unknown as { ledger: LedgerEntry[] }).ledger;
}

function codexCommand(cmd: string, exitCode?: number): string {
  if (exitCode !== undefined) {
    return JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: cmd }, exit_code: exitCode });
  }
  return JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: cmd } });
}

function codexFailedTool(server: string, tool: string, error: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: { type: 'mcp_tool_call', server, tool },
    status: 'error',
    error,
  });
}

function kimiTool(name: string, args: unknown, failed = false, error?: string): string {
  const toolCall = { role: 'assistant', tool_calls: [{ type: 'function', id: `tc-${name}`, function: { name, arguments: args } }] };
  if (!failed) return JSON.stringify(toolCall);
  return [
    JSON.stringify(toolCall),
    JSON.stringify({ role: 'tool', tool_call_id: `tc-${name}`, is_error: true, error: error ?? 'failed' }),
  ].join('\n');
}

function opencodeTool(tool: string, title: string, failed = false, error?: string): string {
  return JSON.stringify({
    part: {
      type: 'tool',
      tool,
      state: { title, status: failed ? 'error' : 'ok', error: failed ? (error ?? 'failed') : undefined },
    },
  });
}

function writeCapture(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function appendCapture(path: string, lines: string[]): void {
  const content = lines.join('\n');
  writeFileSync(path, `${content}\n`, { flag: 'a', encoding: 'utf8' });
}

describe('signature extraction', () => {
  it('extracts codex command_execution signatures', () => {
    const line = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } });
    const sigs = extractCodexSignatures(line, '/worktree');
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].isActionable, true);
    assert.equal(sigs[0].failureHash, undefined);
  });

  it('correlates codex command_execution failure by nonzero exit code', () => {
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' }, exit_code: 1 });
    const sigs = extractCodexSignatures(line, '/worktree');
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0].isActionable, true);
    assert.ok(sigs[0].failureHash);
  });

  it('extracts codex mcp_tool_call signatures and failures', () => {
    const started = JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'fs', tool: 'read' } });
    const failed = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'fs', tool: 'read' }, status: 'error', error: 'not found' });
    const s1 = extractCodexSignatures(started, '/worktree');
    const s2 = extractCodexSignatures(failed, '/worktree');
    assert.equal(s1[0].hash, s2[0].hash);
    assert.ok(s2[0].failureHash);
  });

  it('extracts kimi tool_calls and text separately', () => {
    const tool = JSON.stringify({ role: 'assistant', tool_calls: [{ type: 'function', id: 't1', function: { name: 'Read', arguments: { path: 'x' } } }] });
    const text = JSON.stringify({ role: 'assistant', content: 'hello' });
    const t1 = extractKimiSignatures(tool, '/worktree');
    const t2 = extractKimiSignatures(text, '/worktree');
    assert.equal(t1.length, 1);
    assert.equal(t1[0].isActionable, true);
    assert.equal(t2.length, 1);
    assert.equal(t2[0].isActionable, false);
  });

  it('extracts opencode tool parts and failures', () => {
    const ok = opencodeTool('bash', 'run tests', false);
    const bad = opencodeTool('bash', 'run tests', true, 'exit 1');
    const s1 = extractOpenCodeSignatures(ok, '/worktree');
    const s2 = extractOpenCodeSignatures(bad, '/worktree');
    assert.equal(s1[0].hash, s2[0].hash);
    assert.ok(s2[0].failureHash);
    assert.equal(s1[0].failureHash, undefined);
  });

  it('ignores malformed and non-actionable records', () => {
    assert.deepEqual(extractCodexSignatures('{malformed', '/worktree'), []);
    assert.deepEqual(extractCodexSignatures('null', '/worktree'), []);
    assert.deepEqual(extractKimiSignatures('"string"', '/worktree'), []);
    assert.deepEqual(extractOpenCodeSignatures('[]', '/worktree'), []);
  });

  it('strips absolute worktree prefixes from signatures', () => {
    const cmd = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: `${TEST_TMP}/src/file.ts arg` } });
    const s1 = extractCodexSignatures(cmd, TEST_TMP);
    const cmd2 = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'src/file.ts arg' } });
    const s2 = extractCodexSignatures(cmd2, TEST_TMP);
    assert.equal(s1[0].hash, s2[0].hash);
  });
});

describe('incremental capture reader', () => {
  const vendor = 'codex';
  const worktree = TEST_TMP;

  it('reads complete records and leaves partial lines pending', () => {
    const path = join(TEST_TMP, 'inc-partial.cli.jsonl');
    writeFileSync(path, `${codexCommand('a')}\n${codexCommand('b')}`, 'utf8');
    let state = { capturePath: path, offset: 0, lastSize: -1, lastIno: -1, lastDev: -1, boundaryHash: '' };
    const r1 = readCaptureIncrementally(state, vendor, worktree, readFileSync, statSync);
    // 'b' has no trailing newline, so only 'a' is consumed; 'b' remains pending.
    assert.equal(r1.signatures.length, 1);
    assert.equal(r1.state.offset > 0, true);
    appendCapture(path, ['', codexCommand('c')]);
    const r2 = readCaptureIncrementally(r1.state, vendor, worktree, readFileSync, statSync);
    assert.equal(r2.signatures.length, 2);
  });

  it('resets when the file shrinks', () => {
    const path = join(TEST_TMP, 'inc-shrink.cli.jsonl');
    writeCapture(path, [codexCommand('a'), codexCommand('b'), codexCommand('c')]);
    let state = { capturePath: path, offset: 0, lastSize: -1, lastIno: -1, lastDev: -1, boundaryHash: '' };
    const r1 = readCaptureIncrementally(state, vendor, worktree, readFileSync, statSync);
    assert.equal(r1.signatures.length, 3);
    writeFileSync(path, `${codexCommand('x')}\n`, 'utf8');
    const r2 = readCaptureIncrementally(r1.state, vendor, worktree, readFileSync, statSync);
    assert.equal(r2.reset, true);
    assert.equal(r2.signatures.length, 1);
  });

  it('detects a same-size rewrite and resets', () => {
    const path = join(TEST_TMP, 'inc-rewrite.cli.jsonl');
    const lines = [codexCommand('a'), codexCommand('b')];
    writeCapture(path, lines);
    let state = { capturePath: path, offset: 0, lastSize: -1, lastIno: -1, lastDev: -1, boundaryHash: '' };
    const r1 = readCaptureIncrementally(state, vendor, worktree, readFileSync, statSync);
    assert.equal(r1.signatures.length, 2);
    writeCapture(path, [codexCommand('x'), codexCommand('y')]);
    const r2 = readCaptureIncrementally(r1.state, vendor, worktree, readFileSync, statSync);
    assert.equal(r2.reset, true);
    assert.equal(r2.signatures.length, 2);
  });
});

describe('cycle detection', () => {
  it('detects a repeating 1-signature cycle', () => {
    const actions = Array.from({ length: 5 }, () => ({ hash: 'a', timestamp: 0, isActionable: true }));
    const cycle = detectCycle(actions);
    assert.ok(cycle);
    assert.equal(cycle!.period, 1);
    assert.equal(cycle!.repetitions, 5);
  });

  it('detects a 2-signature cycle repeated five times', () => {
    const actions: { hash: string; timestamp: number; isActionable: boolean }[] = [];
    for (let i = 0; i < 10; i += 1) actions.push({ hash: i % 2 === 0 ? 'a' : 'b', timestamp: i, isActionable: true });
    const cycle = detectCycle(actions);
    assert.ok(cycle);
    assert.equal(cycle!.period, 2);
    assert.equal(cycle!.repetitions, 5);
  });

  it('requires five repetitions', () => {
    const actions = Array.from({ length: 8 }, (_, i) => ({ hash: i % 2 === 0 ? 'a' : 'b', timestamp: i, isActionable: true }));
    const cycle = detectCycle(actions);
    assert.equal(cycle, null);
  });

  it('reports whether the cycle contains an actionable event', () => {
    const text = Array.from({ length: 5 }, () => ({ hash: 'say', timestamp: 0, isActionable: false }));
    assert.equal(detectCycle(text)!.hasActionable, false);
    const mixed = Array.from({ length: 5 }, () => ({ hash: 'tool', timestamp: 0, isActionable: true }));
    assert.equal(detectCycle(mixed)!.hasActionable, true);
  });
});

describe('git fingerprint', () => {
  it('uses GIT_OPTIONAL_LOCKS=0 on every invocation', () => {
    const worktree = mkdtempSync(join(TEST_TMP, 'git-'));
    const calls: Array<{ env: NodeJS.ProcessEnv | undefined }> = [];
    const execGit: LoopDetectorOptions['execGit'] = (_file, _args, options) => {
      calls.push({ env: options?.env });
      if (_args.includes('rev-parse')) return 'abc123\n';
      if (_args.includes('diff')) return '';
      if (_args.includes('status')) return '';
      return '';
    };
    sampleGitSignature(worktree, execGit, readFileSync, {});
    assert.ok(calls.length > 0);
    for (const call of calls) assert.equal(call.env?.GIT_OPTIONAL_LOCKS, '0');
  });

  it('detects an untracked file content rewrite as a Git signature change', () => {
    const worktree = mkdtempSync(join(TEST_TMP, 'git-untracked-'));
    const execGit: LoopDetectorOptions['execGit'] = (_file, args) => {
      if (args.includes('rev-parse')) return 'HEAD\n';
      if (args.includes('diff')) return '';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) {
        return 'untracked.txt\0';
      }
      return '';
    };
    const untrackedPath = join(worktree, 'untracked.txt');
    writeFileSync(untrackedPath, 'first', 'utf8');
    const s1 = sampleGitSignature(worktree, execGit, readFileSync, statSync, {});
    writeFileSync(untrackedPath, 'second', 'utf8');
    const s2 = sampleGitSignature(worktree, execGit, readFileSync, statSync, {});
    assert.notEqual(s1.signature, s2.signature);
    assert.equal(s1.unknown, false);
  });
});

describe('loop detector state machine', () => {
  it('stays healthy for diverse actions', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const lines = [
      codexCommand('a'),
      codexCommand('b'),
      codexCommand('c'),
      codexCommand('d'),
      codexCommand('e'),
      codexCommand('f'),
      codexCommand('g'),
      codexCommand('h'),
      codexCommand('i'),
      codexCommand('j'),
      codexCommand('k'),
      codexCommand('l'),
    ];
    writeCapture(join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`), lines);
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'healthy');
  });

  it('detects Rule A repeated explicit failure', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    // Add non-actionable text to satisfy the 20-record active-output floor.
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`), lines);
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'suspected');
    assert.equal(res.result.metrics?.repeatCount, 12);
    assert.equal(res.result.metrics?.failureCount, 12);
    const events = ledgerEvents(opts).map((e) => e.event);
    assert.ok(events.includes('agent_loop_suspected'));
    assert.ok(!events.includes('agent_loop_confirmed'));
  });

  it('confirms Rule A after the confirmation window with ongoing fresh failures', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(capturePath, lines);
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'suspected');
    state = r1.state;

    // Stage 2 requires fresh qualifying evidence during the confirmation window.
    // Provide two fresh matching failures shortly after suspicion, then wait for
    // the confirmation window to elapse.
    opts.clock.advance(2 * 60 * 1000);
    appendCapture(capturePath, [codexCommand('npm test', 1)]);
    const r2 = loopDetectorTick(state, opts);
    state = r2.state;
    opts.clock.advance(2 * 60 * 1000);
    appendCapture(capturePath, [codexCommand('npm test', 1)]);
    const r3 = loopDetectorTick(state, opts);
    state = r3.state;
    opts.clock.advance(2 * 60 * 1000);
    appendCapture(capturePath, [codexCommand('npm test', 1)]);
    const r4 = loopDetectorTick(state, opts);

    const events = ledgerEvents(opts).map((e) => e.event);
    assert.ok(events.includes('agent_loop_confirmed'), `expected agent_loop_confirmed in ${events.join(', ')}`);
  });

  it('does not trigger Rule A on repeated successes', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 0));
    writeCapture(join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`), lines);
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'healthy');
  });

  it('clears suspicion on a Git signature change', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    let gitCall = 0;
    const execGit: LoopDetectorOptions['execGit'] = (_file, args) => {
      if (args.includes('rev-parse')) return 'HEAD\n';
      if (args.includes('diff')) return gitCall++ === 0 ? '' : '+changed\n';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return '';
      return '';
    };
    opts.execGit = execGit;
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(capturePath, lines);
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'suspected');
    state = r1.state;
    opts.clock.advance(30_000);
    appendCapture(capturePath, [codexCommand('npm test', 1)]);
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.result.cleared, true);
    assert.equal(r2.result.verdict, 'healthy');
    assert.equal(ledgerEvents(opts).some((e) => e.event === 'agent_loop_cleared'), true);
  });

  it('detects Rule B repeated semantic cycle with explicit failure', () => {
    const opts = baseOptions({ vendor: 'opencode' });
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(15 * 60 * 1000);
    const lines: string[] = [];
    const longTitle = 'step '.repeat(2000);
    for (let i = 0; i < 30; i += 1) {
      // Rule B requires at least two explicit failures in the repeated cycle
      // (not just a single stale transient failure).
      lines.push(opencodeTool(i % 2 === 0 ? 'read' : 'bash', longTitle, i === 0 || i === 2, 'not found'));
    }
    writeCapture(join(opts.sessionsDir, `${opts.agentRunId}.events.jsonl`), lines);
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'suspected');
    assert.equal(res.result.metrics?.cycleLength, 2);
  });

  it('never auto-cancels Claude/non-streaming vendors', () => {
    const opts = baseOptions({ vendor: 'claude' });
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    opts.clock.advance(20 * 60 * 1000);
    writeCapture(join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`), [codexCommand('npm test', 1)]);
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'healthy');
    assert.equal(res.state.enabled, false);
  });

  it('is fully disabled by HYDRA_LOOP_DETECTOR=0', () => {
    const opts = baseOptions({ env: { HYDRA_LOOP_DETECTOR: '0' } });
    let state = createLoopDetectorState();
    opts.clock.advance(20 * 60 * 1000);
    writeCapture(join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`), Array.from({ length: 12 }, () => codexCommand('npm test', 1)));
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'healthy');
    assert.equal(res.state.enabled, false);
  });

  it('resets all rolling evidence when Git progress is detected', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(capturePath, lines);
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'suspected');
    state = r1.state;

    // Git fingerprint changes: the episode is cleared and all rolling evidence
    // is reset. Old failures must not contribute to a later suspicion.
    opts.clock.advance(30_000);
    opts.execGit = (_file: string, args: string[]) => {
      if (args.includes('rev-parse')) return 'HEAD\n';
      if (args.includes('diff')) return '+changed\n';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return '';
      return '';
    };
    appendCapture(capturePath, [codexCommand('npm test', 1)]);
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.result.cleared, true);
    state = r2.state;

    // After the reset, a few old-pattern failures plus diverse work must not
    // re-trigger using the stale pre-progress failure count.
    opts.clock.advance(10 * 60 * 1000);
    appendCapture(capturePath, [
      codexCommand('npm test', 1),
      codexCommand('npm test', 1),
      codexCommand('npm test', 1),
      codexCommand('git status', 0),
      codexCommand('git diff', 0),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'thinking...' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'still thinking...' } }),
    ]);
    const r3 = loopDetectorTick(state, opts);
    assert.equal(r3.result.verdict, 'healthy');
  });

  it('does not confirm Stage 2 when only elapsed time passes', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(capturePath, lines);
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'suspected');
    state = r1.state;

    // Advance through the confirmation window but only add a single new
    // non-repeating action. This must clear the episode, not confirm it.
    opts.clock.advance(5 * 60 * 1000);
    appendCapture(capturePath, [codexCommand('git status', 0)]);
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.result.verdict, 'healthy');
    assert.equal(r2.result.cleared, true);
    const events = ledgerEvents(opts).map((e) => e.event);
    assert.ok(events.includes('agent_loop_cleared'));
    assert.ok(!events.includes('agent_loop_confirmed'));
  });

  it('does not trigger Rule B on a cycle of repeated successful actions', () => {
    const opts = baseOptions({ vendor: 'opencode' });
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(15 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.events.jsonl`);
    const longTitle = 'step '.repeat(2000);
    const lines: string[] = [];
    for (let i = 0; i < 30; i += 1) lines.push(opencodeTool(i % 2 === 0 ? 'read' : 'bash', longTitle, false));
    writeCapture(capturePath, lines);
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'healthy');

    // Continue the same successful cycle for another full window plus
    // confirmation period. Rule B must stay inactive because there is no
    // explicit failure evidence.
    state = r1.state;
    opts.clock.advance(20 * 60 * 1000);
    for (let i = 0; i < 30; i += 1) {
      appendCapture(capturePath, [opencodeTool(i % 2 === 0 ? 'read' : 'bash', longTitle, false)]);
    }
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.result.verdict, 'healthy');
    const events = ledgerEvents(opts).map((e) => e.event);
    assert.ok(!events.includes('agent_loop_suspected'));
    assert.ok(!events.includes('agent_loop_confirmed'));
  });

  it('suppresses detection on any Git command failure and requires a fresh window after recovery', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(capturePath, lines);

    // ls-files failure must make the whole Git sample unknown and suppress detection.
    opts.execGit = (_file: string, args: string[]) => {
      if (args.includes('ls-files')) throw new Error('ls-files failed');
      if (args.includes('rev-parse')) return 'HEAD\n';
      if (args.includes('diff')) return '';
      if (args.includes('status')) return '';
      return '';
    };
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'healthy');
    assert.equal(r1.state.gitUnknown, true);
    state = r1.state;

    // Recover immediately. Even though the failure evidence is still present,
    // the Git stagnation clock has been reset, so the window is not met.
    opts.execGit = (_file: string, args: string[]) => {
      if (args.includes('rev-parse')) return 'HEAD\n';
      if (args.includes('diff')) return '';
      if (args.includes('status')) return '';
      if (args.includes('ls-files')) return '';
      return '';
    };
    opts.clock.advance(30_000);
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.state.gitUnknown, false);
    assert.equal(r2.result.verdict, 'healthy');

    // Now advance a full fresh window with continued failures. Detection should
    // trigger only because the post-recovery window is satisfied, not because
    // unknown-period time was credited.
    opts.clock.advance(10 * 60 * 1000);
    appendCapture(capturePath, [codexCommand('npm test', 1)]);
    const r3 = loopDetectorTick(state, opts);
    assert.equal(r3.result.verdict, 'suspected');
  });

  it('skips emission when the ledger shows a newer attempt boundary', () => {
    const ledger: LedgerEntry[] = [];
    ledger.push({
      time: '2026-07-14T00:00:00Z',
      event: 'task_started',
      run_id: '0014',
      task_id: 'task-a',
      agent_run_id: '0014-task-a-v1',
      dispatch_instance_id: 'deadbeefdeadbeef',
    });
    ledger.push({
      time: '2026-07-14T00:01:00Z',
      event: 'task_started',
      run_id: '0014',
      task_id: 'task-a',
      agent_run_id: '0014-task-a-v2',
      dispatch_instance_id: 'cafebabecafebabe',
    });
    const opts = baseOptions({
      agentRunId: '0014-task-a-v1',
      dispatchInstanceId: 'deadbeefdeadbeef',
      readLedger: () => ledger,
      appendLedger: (event, ...kvs) => {
        const entry: LedgerEntry = {
          event,
          run_id: '0014',
          task_id: 'task-a',
          agent_run_id: '0014-task-a-v1',
          dispatch_instance_id: 'deadbeefdeadbeef',
        };
        for (let i = 0; i + 1 < kvs.length; i += 2) entry[kvs[i]] = kvs[i + 1];
        ledger.push(entry);
      },
    });
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`), lines);
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'healthy');
    const loopEvents = ledgerEvents(opts).filter((e) =>
      e.event === 'agent_loop_suspected' || e.event === 'agent_loop_confirmed'
    );
    assert.equal(loopEvents.length, 0);
  });

  it('recognizes repeated identical tool calls with different correlation IDs as the same logical action', () => {
    const opts = baseOptions({ vendor: 'kimi' });
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    const lines: string[] = [];
    // Emit all assistant calls first so the correlation map is populated, then
    // all results. In real streaming they interleave, but the detector reads
    // incrementally and correlates by id regardless of ordering within a batch.
    for (let i = 0; i < 12; i += 1) {
      const id = `call-${i}`;
      lines.push(JSON.stringify({ role: 'assistant', tool_calls: [{ type: 'function', id, function: { name: 'Read', arguments: { path: 'x.txt' } } }] }));
    }
    for (let i = 0; i < 12; i += 1) {
      const id = `call-${i}`;
      lines.push(JSON.stringify({ role: 'tool', tool_call_id: id, is_error: true, error: 'not found' }));
    }
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ role: 'assistant', content: `msg ${i}` }));
    writeCapture(capturePath, lines);
    const res = loopDetectorTick(state, opts);
    assert.equal(res.result.verdict, 'suspected');
    assert.equal(res.result.metrics?.failureCount, 12);
  });

  it('does not confirm using a stale suspectedAt after the rule becomes inactive', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(capturePath, lines);
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'suspected');
    state = r1.state;

    // Rule A becomes inactive: many successful runs of the same command push
    // failures out of the recent suffix. The episode must end, not just pause.
    opts.clock.advance(1 * 60 * 1000);
    appendCapture(capturePath, Array.from({ length: 20 }, () => codexCommand('npm test', 0)));
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.result.cleared, true);
    assert.equal(r2.result.verdict, 'healthy');
    state = r2.state;

    // Advance well past the original confirmation window, then reactivate Rule A
    // with fresh failures. A surviving stale episode would confirm immediately.
    opts.clock.advance(6 * 60 * 1000);
    appendCapture(capturePath, [
      ...Array.from({ length: 12 }, () => codexCommand('npm test', 1)),
      ...Array.from({ length: 8 }, (_, i) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } })),
    ]);
    const r3 = loopDetectorTick(state, opts);
    assert.equal(r3.result.verdict, 'suspected');
    assert.ok(!ledgerEvents(opts).some((e) => e.event === 'agent_loop_confirmed'));
    state = r3.state;

    // The reactivated episode must measure a fresh confirmation window from
    // reactivation, so a tiny elapsed time with enough fresh failures does NOT
    // confirm using the original stale suspectedAt.
    opts.clock.advance(1);
    appendCapture(capturePath, [codexCommand('npm test', 1), codexCommand('npm test', 1)]);
    const r4 = loopDetectorTick(state, opts);
    assert.equal(r4.result.verdict, 'healthy');
    assert.ok(!ledgerEvents(opts).some((e) => e.event === 'agent_loop_confirmed'));
  });

  it('does not reach Rule B Stage 2 from one stale failure plus successful repetitions', () => {
    const opts = baseOptions({ vendor: 'opencode' });
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(15 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.events.jsonl`);
    const longTitle = 'step '.repeat(2000);
    const lines: string[] = [];
    // One stale failure followed by many successful cycle repetitions.
    for (let i = 0; i < 40; i += 1) {
      lines.push(opencodeTool(i % 2 === 0 ? 'read' : 'bash', longTitle, i === 0, 'not found'));
    }
    writeCapture(capturePath, lines);
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'healthy');

    // Continue the successful cycle long enough that even a Stage 2 confirmation
    // window would have elapsed. Rule B must stay inactive.
    state = r1.state;
    opts.clock.advance(20 * 60 * 1000);
    for (let i = 0; i < 30; i += 1) {
      appendCapture(capturePath, [opencodeTool(i % 2 === 0 ? 'read' : 'bash', longTitle, false)]);
    }
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.result.verdict, 'healthy');
    const events = ledgerEvents(opts).map((e) => e.event);
    assert.ok(!events.includes('agent_loop_suspected'));
    assert.ok(!events.includes('agent_loop_confirmed'));
  });

  it('suppresses detection when an untracked file cannot be read and requires a fresh window after recovery', () => {
    const opts = baseOptions();
    let state = createLoopDetectorState();
    state.lastGitChangeAt = 0;
    state.lastGitSampleAt = -30_000;
    opts.clock.advance(10 * 60 * 1000);
    const capturePath = join(opts.sessionsDir, `${opts.agentRunId}.cli.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(codexCommand('npm test', 1));
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `msg ${i}` } }));
    writeCapture(capturePath, lines);

    const untrackedPath = join(opts.worktree, 'untracked.txt');
    writeFileSync(untrackedPath, 'content', 'utf8');

    // Make the untracked file unreadable. The per-file failure must propagate
    // and make the whole Git sample unknown, suppressing detection.
    opts.execGit = (_file: string, args: string[]) => {
      if (args.includes('ls-files')) return 'untracked.txt\0';
      if (args.includes('rev-parse')) return 'HEAD\n';
      if (args.includes('diff')) return '';
      if (args.includes('status')) return '';
      return '';
    };
    opts.readFileSync = (p: string) => (p === untrackedPath ? undefined : readFileSync(p));
    const r1 = loopDetectorTick(state, opts);
    assert.equal(r1.result.verdict, 'healthy');
    assert.equal(r1.state.gitUnknown, true);
    state = r1.state;

    // Recovery must restart the stagnation clock; the window is not yet met.
    opts.readFileSync = readFileSync;
    opts.clock.advance(30_000);
    const r2 = loopDetectorTick(state, opts);
    assert.equal(r2.state.gitUnknown, false);
    assert.equal(r2.result.verdict, 'healthy');
    state = r2.state;

    // A full fresh window is required before suspicion can recur.
    opts.clock.advance(10 * 60 * 1000);
    appendCapture(capturePath, [codexCommand('npm test', 1)]);
    const r3 = loopDetectorTick(state, opts);
    assert.equal(r3.result.verdict, 'suspected');
  });
});
