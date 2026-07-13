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
import {
  explore,
  review,
  start,
  buildWorkerPrompt,
  type OpencodeExec,
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

function eventsStdout(...events: Record<string, unknown>[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function makeExec(
  stdout: string,
  opts?: { exitCode?: number; sideEffect?: (command: string, args: string[], cwd?: string) => void },
): OpencodeExec {
  return (command, args, options) => {
    opts?.sideEffect?.(command, args, options?.cwd);
    return {
      exitCode: opts?.exitCode ?? 0,
      stdout,
      stderr: '',
    };
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

  it('runs opencode under the hydra-reviewer agent and writes outputs', () => {
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
    const exec: OpencodeExec = (command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedCwd = options?.cwd;
      return { exitCode: 0, stdout, stderr: '' };
    };

    const { output, result } = captureStdout(() =>
      explore(cwd, 'explore this repo', outPrefix, agentRunId, { exec }),
    );

    assert.equal(capturedCommand, 'opencode');
    assert.deepEqual(capturedArgs, [
      'run',
      '--model',
      'zhipu/glm-5.2',
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
    assert.equal(session.model, 'zhipu/glm-5.2');
    assert.equal(session.session_id, 'sess-1');
    assert.deepEqual(session.tokens, { input: 20, output: 5 });
    assert.equal(session.cost, 0.003);
  });

  it('uses the HYDRA_OPENCODE_MODEL environment variable by default', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    process.env.HYDRA_OPENCODE_MODEL = 'custom/model-7';

    let capturedModel = '';
    const exec: OpencodeExec = (command, args) => {
      const modelIndex = args.indexOf('--model');
      capturedModel = args[modelIndex + 1] ?? '';
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    explore(cwd, 'prompt', outPrefix, agentRunId, { exec });
    assert.equal(capturedModel, 'custom/model-7');
  });

  it('uses the default model when HYDRA_OPENCODE_MODEL is empty', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    process.env.HYDRA_OPENCODE_MODEL = '';

    let capturedModel = '';
    const exec: OpencodeExec = (command, args) => {
      capturedModel = args[args.indexOf('--model') + 1] ?? '';
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    explore(cwd, 'prompt', outPrefix, agentRunId, { exec });
    assert.equal(capturedModel, 'zhipu/glm-5.2');
  });

  it('allows the model to be overridden via options', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    process.env.HYDRA_OPENCODE_MODEL = 'env/model';

    let capturedModel = '';
    const exec: OpencodeExec = (command, args) => {
      const modelIndex = args.indexOf('--model');
      capturedModel = args[modelIndex + 1] ?? '';
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    explore(cwd, 'prompt', outPrefix, agentRunId, { exec, model: 'opt/model-99' });
    assert.equal(capturedModel, 'opt/model-99');
  });

  it('extracts text from .part.type == "text" events', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout(
      { sessionID: 's-2', part: { type: 'text', text: 'part one' } },
      { sessionID: 's-2', part: { type: 'text', text: 'part two' } },
    );

    const exec = makeExec(stdout);
    explore(cwd, 'prompt', outPrefix, agentRunId, { exec });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'part two\n');
  });

  it('falls back from null top-level text to part text like jq //', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({
      sessionID: 's-2b',
      type: 'text',
      text: null,
      part: { type: 'metadata', text: 'fallback' },
    });

    explore(cwd, 'prompt', outPrefix, agentRunId, { exec: makeExec(stdout) });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'fallback\n');
  });

  it('defaults usage to empty tokens and zero cost when no step_finish events', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({ sessionID: 's-3', type: 'text', text: 'ok' });

    const exec = makeExec(stdout);
    explore(cwd, 'prompt', outPrefix, agentRunId, { exec });

    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.deepEqual(session.tokens, {});
    assert.equal(session.cost, 0);
  });

  it('ignores non-zero opencode exit codes', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({ sessionID: 's-4', type: 'text', text: 'still captured' });

    const exec = makeExec(stdout, { exitCode: 1 });
    const { result } = captureStdout(() => explore(cwd, 'prompt', outPrefix, agentRunId, { exec }));

    assert.equal(result, `${outPrefix}.txt`);
    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), 'still captured\n');
  });

  it('treats a malformed JSON line as failure of each whole jq extraction', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = '{"sessionID":"s-5","type":"text","text":"good"}\nnot-json\n';

    const exec = makeExec(stdout);
    explore(cwd, 'prompt', outPrefix, agentRunId, { exec });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), '');
    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.equal(session.session_id, '');
    assert.deepEqual(session.tokens, {});
    assert.equal(session.cost, 0);
  });

  it('discards all extracted text when jq hits an invalid nested part', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout(
      { sessionID: 's-nested', type: 'text', text: 'earlier' },
      { sessionID: 's-nested', type: 'other', part: [] },
    );

    explore(cwd, 'prompt', outPrefix, agentRunId, { exec: makeExec(stdout) });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), '');
    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.equal(session.session_id, 's-nested');
  });

  it('uses jq addition semantics for string costs', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout(
      { type: 'step_finish', part: { tokens: { input: 1 }, cost: 'a' } },
      { type: 'step_finish', part: { tokens: false, cost: 'b' } },
    );

    explore(cwd, 'prompt', outPrefix, agentRunId, { exec: makeExec(stdout) });

    const session = readJson(`${outPrefix}.session.json`) as Record<string, unknown>;
    assert.deepEqual(session.tokens, {});
    assert.equal(session.cost, 'ab');
  });

  it('writes stderr to the out prefix', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const exec: OpencodeExec = () => ({ exitCode: 0, stdout: '', stderr: 'some warning' });

    explore(cwd, 'prompt', outPrefix, agentRunId, { exec });
    assert.equal(readFileSync(`${outPrefix}.stderr`, 'utf8'), 'some warning');
  });
});

describe('review', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('uses the hydra-reviewer agent like explore', () => {
    const { cwd, outPrefix, agentRunId } = makePaths();
    const stdout = eventsStdout({ sessionID: 's-r', type: 'text', text: 'reviewed' });

    let capturedArgs: string[] = [];
    const exec: OpencodeExec = (command, args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout, stderr: '' };
    };

    review(cwd, 'review prompt', outPrefix, agentRunId, { exec });
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

  it('runs the implementer profile and writes session + result files', () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout(
      { sessionID: 'impl-1', type: 'text', text: 'done' },
      { sessionID: 'impl-1', type: 'step_finish', part: { tokens: { input: 1, output: 2 }, cost: 0.0001 } },
    );

    let capturedArgs: string[] = [];
    let capturedCwd: string | undefined;
    const exec: OpencodeExec = (command, args, options) => {
      capturedArgs = args;
      capturedCwd = options?.cwd;
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
      return { exitCode: 0, stdout, stderr: '' };
    };

    const { output, result } = captureStdout(() =>
      start(spec, worktree, inbox, sessions, agentRunId, { exec }),
    );

    assert.equal(result, agentRunId);
    assert.equal(output, `${agentRunId}\n`);

    assert.ok(capturedArgs.includes('hydra-implementer'));
    assert.ok(capturedArgs.includes(worktree));
    assert.equal(capturedCwd, undefined);

    assert.equal(readFileSync(`${sessions}/${agentRunId}.events.jsonl`, 'utf8'), stdout);
    const session = readJson(`${sessions}/${agentRunId}.json`) as Record<string, unknown>;
    assert.equal(session.agent_run_id, agentRunId);
    assert.equal(session.vendor, 'opencode');
    assert.equal(session.model, 'zhipu/glm-5.2');
    assert.equal(session.session_id, 'impl-1');

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.session_id, 'impl-1');
    assert.equal(resultDrop.head_commit, 'deadbeef');
  });

  it('falls back to a git-derived drop when no worker result is produced', () => {
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

    const exec = makeExec(stdout);
    start(spec, worktree, inbox, sessions, agentRunId, { exec, deriveDropFromGit });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.head_commit, 'abc123');
    assert.equal(resultDrop.summary, 'derived');
  });

  it('synthesizes a failed drop when neither worker result nor git derivation succeeds', () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout({ sessionID: 'impl-3', type: 'text', text: 'ok' });

    const deriveDropFromGit = (): boolean => false;
    const exec = makeExec(stdout);
    start(spec, worktree, inbox, sessions, agentRunId, { exec, deriveDropFromGit });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.task_id, 'adapter-opencode');
    assert.equal(resultDrop.run_id, '0019');
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.status, 'failed');
    assert.equal(resultDrop.head_commit, '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070');
    assert.deepEqual(resultDrop.files_changed, []);
    assert.deepEqual(resultDrop.risks, ['adapter synthesized a failed drop']);
  });

  it('fails like jq --argjson when a synthesized drop has an invalid spec version', () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const rawSpec = readFileSync(spec, 'utf8').replace('spec_version: 1', 'spec_version: nope');
    writeFileSync(spec, rawSpec, 'utf8');

    assert.throws(
      () => start(spec, worktree, inbox, sessions, agentRunId, {
        exec: makeExec(''),
        deriveDropFromGit: () => false,
      }),
      /invalid JSON spec_version: nope/,
    );
    assert.equal(readFileSync(join(inbox, 'result.json'), 'utf8'), '');
  });

  it('overrides vendor and preserves an empty session_id in a worker result drop', () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout({ sessionID: 'impl-4', type: 'text', text: 'ok' });

    const exec: OpencodeExec = () => {
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
      return { exitCode: 0, stdout, stderr: '' };
    };

    start(spec, worktree, inbox, sessions, agentRunId, { exec });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.session_id, '');
  });

  it('backfills a null session_id in a worker result drop', () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const stdout = eventsStdout({ sessionID: 'impl-5', type: 'text', text: 'ok' });

    const exec: OpencodeExec = () => {
      writeFileSync(
        join(worktree, '.hydra-result.json'),
        JSON.stringify({ session_id: null }),
        'utf8',
      );
      return { exitCode: 0, stdout, stderr: '' };
    };

    start(spec, worktree, inbox, sessions, agentRunId, { exec });

    const resultDrop = readJson(join(inbox, 'result.json')) as Record<string, unknown>;
    assert.equal(resultDrop.vendor, 'opencode');
    assert.equal(resultDrop.session_id, 'impl-5');
  });

  it('falls back when the worker result is false, null, or invalid JSON', () => {
    for (const raw of ['false', 'null', '{bad json']) {
      const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
      let deriveCalls = 0;
      const exec: OpencodeExec = () => {
        writeFileSync(join(worktree, '.hydra-result.json'), raw, 'utf8');
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      const deriveDropFromGit = (): boolean => {
        deriveCalls += 1;
        writeFileSync(join(inbox, 'result.json'), JSON.stringify({ derived: true }), 'utf8');
        return true;
      };

      start(spec, worktree, inbox, sessions, agentRunId, { exec, deriveDropFromGit });
      assert.equal(deriveCalls, 1);
      assert.deepEqual(readJson(join(inbox, 'result.json')), { derived: true });
    }
  });

  it('fails hard when jq would accept then fail to stamp a non-object drop', () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    let deriveCalled = false;
    const exec: OpencodeExec = () => {
      writeFileSync(join(worktree, '.hydra-result.json'), '[]', 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    assert.throws(
      () => start(spec, worktree, inbox, sessions, agentRunId, {
        exec,
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

  it('removes a stale worker result before running', () => {
    const { agentRunId, worktree, inbox, sessions, spec } = setupStart();
    const staleResult = join(worktree, '.hydra-result.json');
    writeFileSync(staleResult, JSON.stringify({ stale: true }), 'utf8');

    const exec: OpencodeExec = () => {
      assert.equal(existsSync(staleResult), false);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const deriveDropFromGit = (): boolean => {
      writeFileSync(
        join(inbox, 'result.json'),
        JSON.stringify({ derived: true }),
        'utf8',
      );
      return true;
    };

    start(spec, worktree, inbox, sessions, agentRunId, { exec, deriveDropFromGit });
  });
});
