import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import {
  DEFAULT_MODEL,
  parseGrokSessionId,
  resolveGrokModel,
  resume,
  start,
  type GrokSpawn,
} from '../src/adapter-grok.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-adapter-grok');

function cleanTmp(): void {
  rmSync(TEST_TMP, { recursive: true, force: true });
}

function fixture(extra = ''): {
  taskSpec: string;
  worktree: string;
  inbox: string;
  sessions: string;
} {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const root = join(TEST_TMP, id);
  const taskSpec = join(root, 'task.yaml');
  const worktree = join(root, 'worktree');
  const inbox = join(root, 'inbox');
  const sessions = join(root, 'sessions');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(taskSpec, `task_id: grok-adapter
run_id: 0070
spec_version: 2
assigned_vendor: grok
branch: hydra/0070/grok-adapter
base_commit: 37b275d0385bccad8c74f3a2c382dd1f331ae4d3
timeout_minutes: 1
objective: Add the Grok adapter.
writable_paths:
  - kit/hydra-ts/src/adapter-grok.ts
read_only_paths: []
acceptance_criteria:
  - tests pass
${extra}`, 'utf8');
  return { taskSpec, worktree, inbox, sessions };
}

function workerResult(): Record<string, unknown> {
  return {
    task_id: 'grok-adapter',
    run_id: '0070',
    spec_version: 2,
    vendor: 'codex',
    status: 'completed',
    branch: 'hydra/0070/grok-adapter',
    base_commit: '37b275d0385bccad8c74f3a2c382dd1f331ae4d3',
    head_commit: 'deadbeef',
    summary: 'done',
    files_changed: ['kit/hydra-ts/src/adapter-grok.ts'],
    verification_claims: [],
    risks: [],
    unresolved_questions: [],
    suggested_additional_checks: [],
  };
}

function fakeSpawn(
  stdoutText: string,
  options: {
    workerResult?: unknown;
    rawWorkerResult?: string;
    capture?: {
      command?: string;
      args?: string[];
      options?: SpawnOptionsWithoutStdio;
    };
  } = {},
): GrokSpawn {
  return (command, args, spawnOptions) => {
    options.capture && Object.assign(options.capture, {
      command,
      args,
      options: spawnOptions,
    });
    if (spawnOptions?.cwd) {
      const resultPath = join(spawnOptions.cwd.toString(), '.hydra-result.json');
      if (options.rawWorkerResult !== undefined) {
        writeFileSync(resultPath, options.rawWorkerResult, 'utf8');
      } else if (options.workerResult !== undefined) {
        writeFileSync(resultPath, JSON.stringify(options.workerResult), 'utf8');
      }
    }

    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      pid: 4242,
      kill: () => true,
    }) as unknown as ChildProcess;
    process.nextTick(() => {
      stdout.push(Buffer.from(stdoutText, 'utf8'));
      stdout.push(null);
      stderr.push(null);
      child.emit('exit', 0, null);
    });
    return child;
  };
}

describe('adapter-grok', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => cleanTmp());

  it('constructs start argv with default model, workspace sandbox, cwd, and streaming output', async () => {
    const ctx = fixture();
    const capture: {
      command?: string;
      args?: string[];
      options?: SpawnOptionsWithoutStdio;
    } = {};
    const output = [
      JSON.stringify({ type: 'text', data: 'done' }),
      JSON.stringify({ type: 'end', sessionId: 'grok-session-1' }),
    ].join('\n');

    await start(ctx.taskSpec, ctx.worktree, ctx.inbox, ctx.sessions, 'agent-1', {
      spawn: fakeSpawn(output, { workerResult: workerResult(), capture }),
      deriveDropFromGit: () => false,
    });

    assert.equal(capture.command, 'grok');
    const args = capture.args ?? [];
    assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', DEFAULT_MODEL]);
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace']);
    assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
    assert.deepEqual(args.slice(args.indexOf('--cwd'), args.indexOf('--cwd') + 2), ['--cwd', ctx.worktree]);
    assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'streaming-json']);
    assert.equal(args.includes('--fork-session'), false);
    assert.deepEqual(capture.options?.stdio, ['ignore', 'pipe', 'pipe']);

    const session = JSON.parse(readFileSync(join(ctx.sessions, 'agent-1.json'), 'utf8'));
    assert.equal(session.session_id, 'grok-session-1');
    assert.equal(session.model, DEFAULT_MODEL);
    const result = JSON.parse(readFileSync(join(ctx.inbox, 'result.json'), 'utf8'));
    assert.equal(result.vendor, 'grok');
    assert.equal(result.session_id, 'grok-session-1');
  });

  it('passes explicit model and effort overrides to start', async () => {
    const ctx = fixture('model: spec/model\neffort: low\n');
    const capture: { args?: string[] } = {};
    await start(ctx.taskSpec, ctx.worktree, ctx.inbox, ctx.sessions, 'agent-2', {
      model: 'explicit/model',
      effort: 'high',
      spawn: fakeSpawn(JSON.stringify({ type: 'end', sessionId: 'override-1' }), {
        workerResult: workerResult(),
        capture,
      }),
      deriveDropFromGit: () => false,
    });

    const args = capture.args ?? [];
    assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'explicit/model']);
    assert.deepEqual(
      args.slice(args.indexOf('--reasoning-effort'), args.indexOf('--reasoning-effort') + 2),
      ['--reasoning-effort', 'high'],
    );
  });

  it('resolves model precedence as explicit > task spec > env > default', () => {
    const withPin = fixture('model: spec/model\n');
    const withoutPin = fixture();
    const env = { ...process.env, HYDRA_GROK_MODEL: 'env/model' };

    assert.equal(resolveGrokModel(withPin.taskSpec, { model: 'explicit/model', env }).model, 'explicit/model');
    assert.equal(resolveGrokModel(withPin.taskSpec, { env }).model, 'spec/model');
    assert.equal(resolveGrokModel(withoutPin.taskSpec, { env }).model, 'env/model');
    assert.equal(resolveGrokModel(withoutPin.taskSpec, { env: {} }).model, DEFAULT_MODEL);
  });

  it('treats malformed or partial streaming JSON as having no session id', async () => {
    const ctx = fixture();
    const jsonlPath = join(TEST_TMP, 'partial.jsonl');
    writeFileSync(jsonlPath, '{"type":"end","sessionId":"partial', 'utf8');
    assert.equal(parseGrokSessionId(jsonlPath), '');

    await start(ctx.taskSpec, ctx.worktree, ctx.inbox, ctx.sessions, 'agent-3', {
      spawn: fakeSpawn('{"type":"end","sessionId":"partial', { workerResult: workerResult() }),
      deriveDropFromGit: () => false,
    });
    const session = JSON.parse(readFileSync(join(ctx.sessions, 'agent-3.json'), 'utf8'));
    assert.equal(session.session_id, '');
  });

  it('falls back to git derivation after a malformed worker result drop', async () => {
    const ctx = fixture();
    let derived = false;
    await start(ctx.taskSpec, ctx.worktree, ctx.inbox, ctx.sessions, 'agent-4', {
      spawn: fakeSpawn(JSON.stringify({ type: 'end', sessionId: 'derive-1' }), {
        rawWorkerResult: '{partial',
      }),
      deriveDropFromGit: (_spec, _worktree, vendor, sessionId, outJson) => {
        derived = true;
        assert.equal(vendor, 'grok');
        assert.equal(sessionId, 'derive-1');
        mkdirSync(dirname(outJson), { recursive: true });
        writeFileSync(outJson, JSON.stringify({ derived: true }), 'utf8');
        return true;
      },
    });
    assert.equal(derived, true);
    assert.deepEqual(JSON.parse(readFileSync(join(ctx.inbox, 'result.json'), 'utf8')), { derived: true });
  });

  it('resumes the requested session without forking', async () => {
    const ctx = fixture();
    const capture: { args?: string[] } = {};
    await resume(ctx.taskSpec, ctx.worktree, ctx.inbox, ctx.sessions, 'agent-5', 'prior-123', {
      spawn: fakeSpawn(JSON.stringify({ type: 'end', sessionId: 'prior-123' }), {
        workerResult: workerResult(),
        capture,
      }),
      deriveDropFromGit: () => false,
    });
    const args = capture.args ?? [];
    assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'prior-123']);
    assert.equal(args.includes('--fork-session'), false);
  });

  it('never needs the real grok binary in unit tests', () => {
    assert.equal(existsSync(join(TEST_TMP, 'definitely-not-a-grok-binary')), false);
  });
});
