import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import {
  explore,
  review,
  start,
  buildWorkerPrompt,
  type OpencodeSpawn,
} from '../src/adapter-opencode.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-adapter-opencode');
const ORIGINAL_OPENCODE_MODEL = process.env.HYDRA_OPENCODE_MODEL;

afterEach(restoreEnv);

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function restoreEnv(): void {
  if (ORIGINAL_OPENCODE_MODEL === undefined) {
    delete process.env.HYDRA_OPENCODE_MODEL;
  } else {
    process.env.HYDRA_OPENCODE_MODEL = ORIGINAL_OPENCODE_MODEL;
  }
}

function makePaths(): { cwd: string; outPrefix: string; agentRunId: string } {
  const agentRunId = `ar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cwd = join(TEST_TMP, 'cwd', agentRunId);
  const outPrefix = join(TEST_TMP, 'out', agentRunId, 'result');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dirname(outPrefix), { recursive: true });
  return { cwd, outPrefix, agentRunId };
}

async function captureStdout<T>(
  fn: () => T | Promise<T>,
): Promise<{ output: string; result: T }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await fn();
    return { output: chunks.join(''), result };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function captureStderr<T>(
  fn: () => T | Promise<T>,
): Promise<{ output: string; result: T }> {
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

function eventsStdout(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function makeSpawn(
  stdout: string,
  opts?: {
    exitCode?: number | null;
    stderr?: string;
    onSpawn?: (command: string, args: string[], options?: SpawnOptionsWithoutStdio) => void;
  },
): OpencodeSpawn {
  return (command, args, options) => {
    opts?.onSpawn?.(command, args, options);
    const child = Object.assign(new EventEmitter(), {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      pid: 12345,
    }) as ChildProcess;

    process.nextTick(() => {
      if (stdout) child.stdout?.push(Buffer.from(stdout, 'utf8'));
      child.stdout?.push(null);
      if (opts?.stderr) child.stderr?.push(Buffer.from(opts.stderr, 'utf8'));
      child.stderr?.push(null);
      child.emit('exit', opts?.exitCode ?? 0, null);
    });

    return child;
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('buildWorkerPrompt', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('compiles the worker protocol prompt from a task spec', () => {
    const spec = join(TEST_TMP, 'task-spec.yaml');
    writeFileSync(
      spec,
      `task_id: adapter-opencode
run_id: 0019
spec_version: 1
branch: hydra/0019/adapter-opencode
base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070
objective: >
  Port the bash adapter to TypeScript.
writable_paths:
  - hydra-ts/src/adapter-opencode.ts
  - hydra-ts/test/adapter-opencode.test.ts
read_only_paths:
  - hydra/adapters/opencode.sh
acceptance_criteria:
  - passes tests
  - no real CLI invocations
`,
      'utf8',
    );

    const prompt = buildWorkerPrompt(spec);

    assert.match(prompt, /branch: hydra\/0019\/adapter-opencode/);
    assert.match(prompt, /base 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070/);
    assert.match(prompt, /Task adapter-opencode \(run 0019, spec v1\)/);
    assert.match(prompt, /Port the bash adapter to TypeScript\./);
    assert.match(prompt, /- hydra-ts\/src\/adapter-opencode\.ts/);
    assert.match(prompt, /- hydra-ts\/test\/adapter-opencode\.test\.ts/);
    assert.match(prompt, /- hydra\/adapters\/opencode\.sh/);
    assert.match(prompt, /- passes tests/);
    assert.match(prompt, /- no real CLI invocations/);
    assert.match(prompt, /`\.hydra-result\.json`/);
  });
});

describe('explore', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('runs opencode under the hydra-reviewer agent and writes outputs', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout(
      { sessionID: 'sess-1', type: 'text', text: 'first' },
      { sessionID: 'sess-1', type: 'text', text: 'second' },
      { sessionID: 'sess-1', type: 'step_finish', part: { tokens: { input: 10 }, cost: 0.001 } },
      { sessionID: 'sess-1', type: 'step_finish', part: { tokens: { input: 20, output: 5 }, cost: 0.002 } },
    );

    let capturedCommand = '';
    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    const spawn = makeSpawn(stdout, { onSpawn: (command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedCwd = options?.cwd?.toString();
    } });

    const { output, result } = await captureStdout(() =>
      explore(cwd, 'explore this repo', outPrefix, agentRunId, {
        spawn,
        stateRoot: join(TEST_TMP, 'missing-state', agentRunId),
      }),
    );

    assert.equal(capturedCommand, 'opencode');
    assert.deepEqual(capturedArgs, [
      'run',
      '--model',
      'zai-coding-plan/glm-5.2',
      '--agent',
      'hydra-reviewer',
      '--format',
      'json',
      '--auto',
      '--dir',
      cwd,
      'explore this repo',
    ]);
    assert.equal(capturedCwd, undefined);
    assert.equal(result, `${outPrefix}.txt`);
    assert.equal(output, `${outPrefix}.txt\n`);

    assert.equal(readFileSync(`${outPrefix}.events.jsonl`, 'utf8'), stdout);
    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'second\n');

    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.equal(session.agent_run_id, agentRunId);
    assert.equal(session.vendor, 'opencode');
    assert.equal(session.model, 'zai-coding-plan/glm-5.2');
    assert.equal(session.session_id, 'sess-1');
    assert.deepEqual(session.tokens, { input: 20, output: 5 });
    assert.equal(session.cost, 0.003);
  });

  it('uses the HYDRA_OPENCODE_MODEL environment variable by default', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    process.env.HYDRA_OPENCODE_MODEL = 'custom/model-7';

    let capturedModel = '';
    const spawn = makeSpawn('', { onSpawn: (_command, args) => {
      const modelIndex = args.indexOf('--model');
      capturedModel = args[modelIndex + 1] ?? '';
    } });

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn });
    assert.equal(capturedModel, 'custom/model-7');
  });

  it('uses the default model when HYDRA_OPENCODE_MODEL is empty', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    process.env.HYDRA_OPENCODE_MODEL = '';

    let capturedModel = '';
    const spawn = makeSpawn('', { onSpawn: (_command, args) => {
      capturedModel = args[args.indexOf('--model') + 1] ?? '';
    } });

    await explore(cwd, 'prompt', outPrefix, agentRunId, {
      spawn,
      stateRoot: join(TEST_TMP, 'missing-state', agentRunId),
    });
    assert.equal(capturedModel, 'zai-coding-plan/glm-5.2');
  });

  it('uses a valid model from the durable config file', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stateRoot = join(TEST_TMP, 'state', agentRunId);
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      join(stateRoot, 'opencode-model.json'),
      JSON.stringify({ model: 'account/model-from-file' }),
      'utf8',
    );
    delete process.env.HYDRA_OPENCODE_MODEL;

    let capturedModel = '';
    const spawn = makeSpawn('', { onSpawn: (_command, args) => {
      capturedModel = args[args.indexOf('--model') + 1] ?? '';
    } });

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn, stateRoot });
    assert.equal(capturedModel, 'account/model-from-file');
  });

  it('prefers HYDRA_OPENCODE_MODEL over the durable config file', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stateRoot = join(TEST_TMP, 'state', agentRunId);
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      join(stateRoot, 'opencode-model.json'),
      JSON.stringify({ model: 'account/model-from-file' }),
      'utf8',
    );
    process.env.HYDRA_OPENCODE_MODEL = 'one-off/env-model';

    let capturedModel = '';
    const spawn = makeSpawn('', { onSpawn: (_command, args) => {
      capturedModel = args[args.indexOf('--model') + 1] ?? '';
    } });

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn, stateRoot });
    assert.equal(capturedModel, 'one-off/env-model');
  });

  it('warns and uses the default when the durable config file is invalid', async () => {
    const invalidConfigs = ['not JSON', '{}', '{"model":""}', '{"model":42}'];

    for (const [index, rawConfig] of invalidConfigs.entries()) {
      const { cwd, outPrefix, agentRunId } = makePaths();
      const stateRoot = join(TEST_TMP, 'invalid-state', `${index}-${agentRunId}`);
      mkdirSync(stateRoot, { recursive: true });
      writeFileSync(join(stateRoot, 'opencode-model.json'), rawConfig, 'utf8');
      delete process.env.HYDRA_OPENCODE_MODEL;

      let capturedModel = '';
      const spawn = makeSpawn('', { onSpawn: (_command, args) => {
        capturedModel = args[args.indexOf('--model') + 1] ?? '';
      } });

      const { output } = await captureStderr(() =>
        explore(cwd, 'prompt', outPrefix, agentRunId, { spawn, stateRoot }),
      );
      assert.equal(capturedModel, 'zai-coding-plan/glm-5.2');
      assert.match(output, /invalid or unreadable OpenCode model config/);
    }
  });

  it('warns and uses the default when the durable config file is unreadable', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stateRoot = join(TEST_TMP, 'unreadable-state', agentRunId);
    mkdirSync(join(stateRoot, 'opencode-model.json'), { recursive: true });
    delete process.env.HYDRA_OPENCODE_MODEL;

    let capturedModel = '';
    const spawn = makeSpawn('', { onSpawn: (_command, args) => {
      capturedModel = args[args.indexOf('--model') + 1] ?? '';
    } });

    const { output } = await captureStderr(() =>
      explore(cwd, 'prompt', outPrefix, agentRunId, { spawn, stateRoot }),
    );
    assert.equal(capturedModel, 'zai-coding-plan/glm-5.2');
    assert.match(output, /invalid or unreadable OpenCode model config/);
  });

  it('allows the model to be overridden via options', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    process.env.HYDRA_OPENCODE_MODEL = 'env/model';

    let capturedModel = '';
    const spawn = makeSpawn('', { onSpawn: (_command, args) => {
      const modelIndex = args.indexOf('--model');
      capturedModel = args[modelIndex + 1] ?? '';
    } });

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn, model: 'opt/model-99' });
    assert.equal(capturedModel, 'opt/model-99');
  });

  it('extracts text from .part.type == "text" events', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout(
      { sessionID: 's-2', part: { type: 'text', text: 'part one' } },
      { sessionID: 's-2', part: { type: 'text', text: 'part two' } },
    );

    const spawn = makeSpawn(stdout);
    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'part two\n');
  });

  it('falls back from null top-level text to part text like jq //', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({
      sessionID: 's-2b',
      type: 'text',
      text: null,
      part: { type: 'metadata', text: 'fallback' },
    });

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn: makeSpawn(stdout) });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'fallback\n');
  });

  it('defaults usage to empty tokens and zero cost when no step_finish events', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({ sessionID: 's-3', type: 'text', text: 'ok' });

    const spawn = makeSpawn(stdout);
    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn });

    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.deepEqual(session.tokens, {});
    assert.equal(session.cost, 0);
  });

  it('ignores non-zero opencode exit codes', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({ sessionID: 's-4', type: 'text', text: 'still captured' });

    const spawn = makeSpawn(stdout, { exitCode: 1 });
    const { result } = await captureStdout(() => explore(cwd, 'prompt', outPrefix, agentRunId, { spawn }));

    assert.equal(result, `${outPrefix}.txt`);
    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'still captured\n');
  });

  it('treats a malformed JSON line as failure of each whole jq extraction', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = '{"sessionID":"s-5","type":"text","text":"good"}\nnot-json\n';

    const spawn = makeSpawn(stdout);
    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), '');
    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.equal(session.session_id, '');
    assert.deepEqual(session.tokens, {});
    assert.equal(session.cost, 0);
  });

  it('discards all extracted text when jq hits an invalid nested part', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout(
      { sessionID: 's-nested', type: 'text', text: 'earlier' },
      { sessionID: 's-nested', type: 'other', part: [] },
    );

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn: makeSpawn(stdout) });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), '');
    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.equal(session.session_id, 's-nested');
  });

  it('uses jq addition semantics for string costs', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout(
      { type: 'step_finish', part: { tokens: { input: 1 }, cost: 'a' } },
      { type: 'step_finish', part: { tokens: false, cost: 'b' } },
    );

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn: makeSpawn(stdout) });

    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.deepEqual(session.tokens, {});
    assert.equal(session.cost, 'ab');
  });

  it('writes stderr to the out prefix', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const spawn = makeSpawn('', { stderr: 'some warning' });

    await explore(cwd, 'prompt', outPrefix, agentRunId, { spawn });
    assert.equal(readFileSync(`${outPrefix}.stderr`, 'utf8'), 'some warning');
  });

  it('appends event chunks while opencode is still running', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const first = eventsStdout({ sessionID: 'stream-1', type: 'step_start' });
    const second = eventsStdout({ sessionID: 'stream-1', type: 'text', text: 'finished' });
    let child!: ChildProcess;

    const spawn: OpencodeSpawn = (_command, _args, options) => {
      assert.deepEqual(options?.stdio, ['ignore', 'pipe', 'pipe']);
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      child = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        pid: 23456,
      }) as ChildProcess;
      process.nextTick(() => stdout.push(Buffer.from(first, 'utf8')));
      return child;
    };

    let completed = false;
    const runPromise = explore(cwd, 'prompt', outPrefix, agentRunId, { spawn })
      .then((result) => {
        completed = true;
        return result;
      });

    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(readFileSync(`${outPrefix}.events.jsonl`, 'utf8'), first);
    assert.equal(completed, false);
    assert.equal(existsSync(`${outPrefix}.txt`), false);

    child.stdout?.push(Buffer.from(second, 'utf8'));
    child.stdout?.push(null);
    child.stderr?.push(Buffer.from('late warning', 'utf8'));
    child.stderr?.push(null);
    child.emit('exit', 7, null);

    assert.equal(await runPromise, `${outPrefix}.txt`);
    assert.equal(readFileSync(`${outPrefix}.events.jsonl`, 'utf8'), first + second);
    assert.equal(readFileSync(`${outPrefix}.stderr`, 'utf8'), 'late warning');
    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'finished\n');
  });
});

describe('review', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('uses the hydra-reviewer agent like explore', async () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({ sessionID: 's-r', type: 'text', text: 'reviewed' });

    let capturedArgs: string[] = [];
    const spawn = makeSpawn(stdout, { onSpawn: (_command, args) => {
      capturedArgs = args;
    } });

    await review(cwd, 'review prompt', outPrefix, agentRunId, { spawn });
    assert.ok(capturedArgs.includes('hydra-reviewer'));
    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'reviewed\n');
  });
});

describe('start', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  function setupStart() {
    const agentRunId = `ar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const worktree = join(TEST_TMP, 'worktrees', agentRunId);
    const inbox = join(TEST_TMP, 'inbox', agentRunId);
    const sessions = join(TEST_TMP, 'sessions', agentRunId);
    const spec = join(TEST_TMP, 'specs', `${agentRunId}.yaml`);
    mkdirSync(worktree, { recursive: true });
    mkdirSync(inbox, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(
      spec,
      `task_id: adapter-opencode
run_id: 0019
spec_version: 1
branch: hydra/0019/adapter-opencode
base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070
objective: >
  Do the thing.
writable_paths:
  - hydra-ts/src/adapter-opencode.ts
read_only_paths:
  - hydra/adapters/opencode.sh
acceptance_criteria:
  - pass
`,
      'utf8',
    );
    return { agentRunId, worktree, inbox, sessions, spec };
  }

  it('runs the implementer profile and writes session + result files', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout(
      { sessionID: 'impl-1', type: 'text', text: 'done' },
      { sessionID: 'impl-1', type: 'step_finish', part: { tokens: { input: 1, output: 2 }, cost: 0.0001 } },
    );

    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    const spawn = makeSpawn(stdout, { onSpawn: (_command, args, options) => {
      capturedArgs = args;
      capturedCwd = options?.cwd?.toString();
      // Worker produced a result while the CLI ran.
      writeFileSync(
        join(worktree, '.hydra-result.json'),
        JSON.stringify({
          task_id: 'adapter-opencode',
          run_id: '0019',
          spec_version: 1,
          vendor: 'codex',
          status: 'completed',
          branch: 'hydra/0019/adapter-opencode',
          base_commit: '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
          head_commit: 'deadbeef',
          summary: 'all good',
          files_changed: ['hydra-ts/src/adapter-opencode.ts'],
          verification_claims: [],
          risks: [],
          unresolved_questions: [],
          suggested_additional_checks: [],
        }),
        'utf8',
      );
    } });

    const { output, result } = await captureStdout(() =>
      start(spec, worktree, inbox, sessions, agentRunId, {
        spawn,
        stateRoot: join(TEST_TMP, 'missing-state', agentRunId),
      }),
    );

    assert.equal(result, agentRunId);
    assert.ok(output.endsWith(`${agentRunId}\n`));

    assert.ok(capturedArgs.includes('hydra-implementer'));
    assert.ok(capturedArgs.includes(worktree));
    // The usage detector reads the vendor CLI's own ERROR-level diagnostics
    // from the .stderr capture, so start() must opt into print-logs.
    const printLogsIndex = capturedArgs.indexOf('--print-logs');
    assert.notEqual(printLogsIndex, -1);
    assert.deepEqual(capturedArgs.slice(printLogsIndex, printLogsIndex + 3), ['--print-logs', '--log-level', 'ERROR']);
    assert.equal(capturedCwd, undefined);

    assert.equal(readFileSync(`${sessions}/${agentRunId}.events.jsonl`, 'utf8'), stdout);
    const session = readJson(`${sessions}/${agentRunId}.json`) as Record<string, unknown>;
    assert.equal(session.agent_run_id, agentRunId);
    assert.equal(session.vendor, 'opencode');
    assert.equal(session.model, 'zai-coding-plan/glm-5.2');
    assert.equal(session.session_id, 'impl-1');

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.session_id, 'impl-1');
    assert.equal(resultDrop.head_commit, 'deadbeef');
  });

  it('falls back to a git-derived drop when no worker result is produced', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout({ sessionID: 'impl-2', type: 'text', text: 'ok' });

    const deriveDropFromGit = (
      taskSpecPath: string,
      wt: string,
      vendor: string,
      sessionId: string,
      outJson: string,
    ): boolean => {
      assert.equal(taskSpecPath, spec);
      assert.equal(wt, worktree);
      assert.equal(vendor, 'opencode');
      assert.equal(sessionId, 'impl-2');
      writeFileSync(
        outJson,
        JSON.stringify({
          task_id: 'adapter-opencode',
          run_id: '0019',
          spec_version: 1,
          vendor: 'opencode',
          session_id: 'impl-2',
          status: 'completed',
          branch: 'hydra/0019/adapter-opencode',
          base_commit: '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
          head_commit: 'abc123',
          summary: 'derived',
          files_changed: ['a.ts'],
          verification_claims: [],
          risks: [],
          unresolved_questions: [],
          suggested_additional_checks: [],
        }),
        'utf8',
      );
      return true;
    };

    const spawn = makeSpawn(stdout);
    await start(spec, worktree, inbox, sessions, agentRunId, { spawn, deriveDropFromGit });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.head_commit, 'abc123');
    assert.equal(resultDrop.summary, 'derived');
  });

  it('synthesizes a failed drop when neither worker result nor git derivation succeeds', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout({ sessionID: 'impl-3', type: 'text', text: 'ok' });

    const deriveDropFromGit = (): boolean => false;
    const spawn = makeSpawn(stdout);
    await start(spec, worktree, inbox, sessions, agentRunId, { spawn, deriveDropFromGit });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.task_id, 'adapter-opencode');
    assert.equal(resultDrop.run_id, '0019');
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.status, 'failed');
    assert.equal(resultDrop.head_commit, '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070');
    assert.deepEqual(resultDrop.files_changed, []);
    assert.deepEqual(resultDrop.risks, ['adapter synthesized a failed drop']);
  });

  it('fails like jq --argjson when a synthesized drop has an invalid spec version', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const rawSpec = readFileSync(spec, 'utf8').replace('spec_version: 1', 'spec_version: nope');
    writeFileSync(spec, rawSpec, 'utf8');

    await assert.rejects(
      () => start(spec, worktree, inbox, sessions, agentRunId, {
        spawn: makeSpawn(''),
        deriveDropFromGit: () => false,
      }),
      /invalid JSON spec_version: nope/,
    );
    assert.equal(readFileSync(join(inbox, 'result.json'), 'utf8'), '');
  });

  it('overrides vendor and preserves an empty session_id in a worker result drop', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout({ sessionID: 'impl-4', type: 'text', text: 'ok' });

    const spawn = makeSpawn(stdout, { onSpawn: () => {
      writeFileSync(
        join(worktree, '.hydra-result.json'),
        JSON.stringify({
          task_id: 'adapter-opencode',
          run_id: '0019',
          spec_version: 1,
          vendor: 'codex',
          session_id: '',
          status: 'completed',
          branch: 'hydra/0019/adapter-opencode',
          base_commit: '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
          head_commit: '00ff00',
          summary: 'x',
          files_changed: [],
          verification_claims: [],
          risks: [],
          unresolved_questions: [],
          suggested_additional_checks: [],
        }),
        'utf8',
      );
    } });

    await start(spec, worktree, inbox, sessions, agentRunId, { spawn });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.session_id, '');
  });

  it('backfills a null session_id in a worker result drop', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout({ sessionID: 'impl-5', type: 'text', text: 'ok' });

    const spawn = makeSpawn(stdout, { onSpawn: () => {
      writeFileSync(
        join(worktree, '.hydra-result.json'),
        JSON.stringify({ session_id: null }),
        'utf8',
      );
    } });

    await start(spec, worktree, inbox, sessions, agentRunId, { spawn });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.session_id, 'impl-5');
  });

  it('falls back when the worker result is false, null, or invalid JSON', async () => {
    for (const raw of ['false', 'null', '{bad json']) {
      const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
      let deriveCalls = 0;
      const spawn = makeSpawn('', { onSpawn: () => {
        writeFileSync(join(worktree, '.hydra-result.json'), raw, 'utf8');
      } });
      const deriveDropFromGit = (): boolean => {
        deriveCalls += 1;
        writeFileSync(join(inbox, 'result.json'), JSON.stringify({ derived: true }), 'utf8');
        return true;
      };

      await start(spec, worktree, inbox, sessions, agentRunId, { spawn, deriveDropFromGit });
      assert.equal(deriveCalls, 1);
      assert.deepEqual(readJson(join(inbox, 'result.json')), { derived: true });
    }
  });

  it('fails hard when jq would accept then fail to stamp a non-object drop', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    let deriveCalled = false;
    const spawn = makeSpawn('', { onSpawn: () => {
      writeFileSync(join(worktree, '.hydra-result.json'), '[]', 'utf8');
    } });

    await assert.rejects(
      () => start(spec, worktree, inbox, sessions, agentRunId, {
        spawn,
        deriveDropFromGit: () => {
          deriveCalled = true;
          return false;
        },
      }),
      /cannot stamp vendor\/session_id on non-object worker result/,
    );
    assert.equal(deriveCalled, false);
    assert.equal(readFileSync(join(inbox, 'result.json'), 'utf8'), '');
  });

  it('removes a stale worker result before running', async () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const staleResult = join(worktree, '.hydra-result.json');
    writeFileSync(staleResult, JSON.stringify({ stale: true }), 'utf8');

    const spawn = makeSpawn('', { onSpawn: () => {
      assert.equal(existsSync(staleResult), false);
    } });

    const deriveDropFromGit = (): boolean => {
      writeFileSync(
        join(inbox, 'result.json'),
        JSON.stringify({ derived: true }),
        'utf8',
      );
      return true;
    };

    await start(spec, worktree, inbox, sessions, agentRunId, { spawn, deriveDropFromGit });
  });
});

describe('start opencode_model task-spec pin', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  function setupPinSpec(extraSpecLines = '') {
    const agentRunId = `ar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const worktree = join(TEST_TMP, 'worktrees', agentRunId);
    const inbox = join(TEST_TMP, 'inbox', agentRunId);
    const sessions = join(TEST_TMP, 'sessions', agentRunId);
    const spec = join(TEST_TMP, 'specs', `${agentRunId}.yaml`);
    mkdirSync(worktree, { recursive: true });
    mkdirSync(inbox, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(
      spec,
      `task_id: adapter-opencode
run_id: 0047
spec_version: 1
branch: hydra/0047/adapter-opencode
base_commit: 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070
objective: >
  Do the thing.
writable_paths:
  - hydra-ts/src/adapter-opencode.ts
acceptance_criteria:
  - pass
${extraSpecLines}`,
      'utf8',
    );
    return { agentRunId, worktree, inbox, sessions, spec };
  }

  async function captureStartModel(
    ctx: { agentRunId: string; worktree: string; inbox: string; sessions: string; spec: string },
    options: Record<string, unknown> = {},
  ) {
    let capturedModel = '';
    const spawn = makeSpawn(eventsStdout({ sessionID: 'pin-1', type: 'text', text: 'ok' }), {
      onSpawn: (_command, args) => {
        capturedModel = args[args.indexOf('--model') + 1] ?? '';
      },
    });
    await start(ctx.spec, ctx.worktree, ctx.inbox, ctx.sessions, ctx.agentRunId, {
      spawn,
      deriveDropFromGit: () => false,
      stateRoot: join(TEST_TMP, 'missing-state', ctx.agentRunId),
      ...options,
    });
    const session = readJson(`${ctx.sessions}/${ctx.agentRunId}.json`) as Record<string, unknown>;
    return { capturedModel, sessionModel: session.model };
  }

  it('passes the task-spec opencode_model to the opencode CLI', async () => {
    delete process.env.HYDRA_OPENCODE_MODEL;
    const ctx = setupPinSpec('opencode_model: acme/pinned-model\n');

    const { capturedModel, sessionModel } = await captureStartModel(ctx);

    assert.equal(capturedModel, 'acme/pinned-model');
    assert.equal(sessionModel, 'acme/pinned-model');
  });

  it('task-spec opencode_model beats HYDRA_OPENCODE_MODEL', async () => {
    process.env.HYDRA_OPENCODE_MODEL = 'env/model';
    const ctx = setupPinSpec('opencode_model: acme/pinned-model\n');

    const { capturedModel } = await captureStartModel(ctx);

    assert.equal(capturedModel, 'acme/pinned-model');
  });

  it('HYDRA_OPENCODE_MODEL applies when the spec carries no pin', async () => {
    process.env.HYDRA_OPENCODE_MODEL = 'env/model';
    const ctx = setupPinSpec();

    const { capturedModel } = await captureStartModel(ctx);

    assert.equal(capturedModel, 'env/model');
  });

  it('an explicit options.model still wins over the task-spec pin', async () => {
    delete process.env.HYDRA_OPENCODE_MODEL;
    const ctx = setupPinSpec('opencode_model: acme/pinned-model\n');

    const { capturedModel } = await captureStartModel(ctx, { model: 'override/model' });

    assert.equal(capturedModel, 'override/model');
  });
});

describe('worker prompt parity (issue #26)', () => {
  it('renders the shared amendment + revision-evidence contract byte-for-byte', async () => {
    const { mkdtempSync, mkdirSync: makeDir, writeFileSync: writeF, rmSync: removeR } = await import('node:fs');
    const { tmpdir: osTmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { resolveRevisionEvidence, materializeRevisionEvidence } = await import('../src/revision-evidence.ts');
    const { buildWorkerPrompt: buildSharedPrompt } = await import('../src/build-worker-prompt.ts');
    const { buildWorkerPrompt: adapterPrompt } = await import('../src/adapter-opencode.ts');

    const dir = mkdtempSync(joinPath(osTmpdir(), 'hydra-parity-opencode-'));
    try {
      const worktree = joinPath(dir, 'wt');
      makeDir(worktree, { recursive: true });
      const runDir = joinPath(dir, 'run');
      const head = 'a'.repeat(40);
      const reviews = joinPath(runDir, 'authoritative', 'reviews', 'task-parity');
      makeDir(reviews, { recursive: true });
      const verdictBytes = JSON.stringify({
        task_id: 'task-parity',
        verdict: 'revise',
        reviewed_base: head,
        reviewed_head: head,
        reviewer: 'codex-reviewer',
        risk: 'high',
        blocking_findings: ['PARITY-VERDICT-MARKER in src/x.ts:5'],
      });
      writeF(joinPath(reviews, `0001-${head}.json`), verdictBytes);
      const ledgerDir = joinPath(runDir, 'authoritative', 'ledger');
      makeDir(ledgerDir, { recursive: true });
      const { createHash } = await import('node:crypto');
      writeF(joinPath(ledgerDir, 'events.jsonl'), JSON.stringify({
        event: 'review_verdict', task_id: 'task-parity', seq: '1', reviewed_head: head,
        content_sha256: createHash('sha256').update(verdictBytes).digest('hex'),
      }) + '\n');
      materializeRevisionEvidence(worktree, resolveRevisionEvidence(runDir, 'task-parity'), {
        taskId: 'task-parity', runId: '0062', specVersion: '2',
      });
      const spec = joinPath(dir, 'task.yaml');
      writeF(spec, [
        'task_id: task-parity',
        'run_id: "0062"',
        'spec_version: 2',
        'branch: hydra/0062/task-parity',
        `base_commit: ${head}`,
        `worktree: ${worktree}`,
        'objective: Do the thing.',
        'writable_paths:',
        '  - src/**',
        'read_only_paths: []',
        'acceptance_criteria:',
        '  - done',
        'supersedes: 1',
        'amendment_reason: Fix the blocking findings.',
        'amendment_check:',
        '  - "grep -n fixed src/x.ts"',
        '',
      ].join('\n'));

      const prompt = adapterPrompt(spec);
      // Byte-for-byte parity with the shared builder: every vendor delivers
      // one consistent amendment/evidence contract.
      assert.equal(prompt, buildSharedPrompt(spec));
      assert.match(prompt, /THIS TASK WAS AMENDED/);
      assert.match(prompt, /## Amendment verification gate \(MANDATORY\)/);
      assert.ok(prompt.includes('grep -n fixed src/x.ts'));
      assert.match(prompt, /## Revision evidence bundle/);
      assert.ok(prompt.includes('.hydra-context/revision-evidence/manifest.json'));
      assert.ok(!prompt.includes('PARITY-VERDICT-MARKER'), 'verdict body must not be inlined');
    } finally {
      removeR(dir, { recursive: true, force: true });
    }
  });
});
