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
import {
  adapterCodex,
  type AdapterCodexOptions,
  type ExecLike,
  type SpawnLike,
} from '../src/adapter-codex.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-adapter-codex');
type SpawnOptions = Parameters<SpawnLike>[2];

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setupFixture(runId: string): {
  taskSpec: string;
  worktree: string;
  inbox: string;
  sessions: string;
} {
  const dir = join(TEST_TMP, runId);
  const taskSpec = join(dir, 'task.yaml');
  const worktree = join(dir, 'worktree');
  const inbox = join(dir, 'inbox');
  const sessions = join(dir, 'sessions');
  mkdirSync(dir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { taskSpec, worktree, inbox, sessions };
}

function writeTaskSpec(
  path: string,
  overrides: Record<string, string | string[]> = {},
): void {
  const taskId = (overrides.task_id as string) ?? 'adapter-codex';
  const runId = (overrides.run_id as string) ?? '0019';
  const specVersion = (overrides.spec_version as string) ?? '1';
  const branch = (overrides.branch as string) ?? 'hydra/0019/adapter-codex';
  const baseCommit =
    (overrides.base_commit as string) ?? '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070';
  const objective = (overrides.objective as string) ?? 'Port the codex adapter.';
  const writable = Array.isArray(overrides.writable_paths)
    ? overrides.writable_paths
    : ['hydra-ts/src/adapter-codex.ts'];
  const readonly = Array.isArray(overrides.read_only_paths)
    ? overrides.read_only_paths
    : ['hydra/adapters/codex.sh'];
  const acceptance = Array.isArray(overrides.acceptance_criteria)
    ? overrides.acceptance_criteria
    : ['module compiles', 'tests pass'];

  const lines = [
    `task_id: ${taskId}`,
    `run_id: ${runId}`,
    `spec_version: ${specVersion}`,
    `branch: ${branch}`,
    `base_commit: ${baseCommit}`,
    `objective: ${objective}`,
    'writable_paths:',
    ...writable.map((p) => `  - ${p}`),
    'read_only_paths:',
    ...readonly.map((p) => `  - ${p}`),
    'acceptance_criteria:',
    ...acceptance.map((a) => `  - ${a}`),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function makeExec(
  gitCommon: string,
  evidence: { base?: string; head?: string; files?: string[] } = {},
): ExecLike {
  const base = evidence.base ?? '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070';
  const head = evidence.head ?? base;
  return (command: string, args: string[]) => {
    assert.equal(command, 'git');
    if (args.includes('--git-common-dir')) return `${gitCommon}\n`;
    if (args.at(-1) === 'HEAD' && args.includes('rev-parse')) return `${head}\n`;
    if (args.at(-1) === base && args.includes('rev-parse')) return `${base}\n`;
    if (args.includes('diff')) return `${(evidence.files ?? []).join('\n')}\n`;
    throw new Error(`unexpected injected git invocation: ${args.join(' ')}`);
  };
}

function makeSpawn(
  jsonlContent: string,
  capture?: { command?: string; args?: string[]; options?: SpawnOptions },
  workerResult?: unknown,
): SpawnLike {
  return (command: string, args: string[], options) => {
    if (capture) {
      capture.command = command;
      capture.args = args;
      capture.options = options;
    }
    if (options.stdout) {
      mkdirSync(dirname(options.stdout), { recursive: true });
      writeFileSync(options.stdout, jsonlContent, 'utf8');
    }
    if (workerResult !== undefined && options.cwd) {
      writeFileSync(
        join(options.cwd, '.hydra-result.json'),
        JSON.stringify(workerResult),
        'utf8',
      );
    }
    return { exitCode: 0, signal: null };
  };
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

describe('adapterCodex', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
  });

  it('rejects a missing or non-start verb', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    await assert.rejects(
      adapterCodex('', taskSpec, worktree, inbox, sessions, 'run-1'),
      /usage: codex\.sh start/,
    );
    await assert.rejects(
      adapterCodex('stop', taskSpec, worktree, inbox, sessions, 'run-1'),
      /only 'start' is implemented in Wave 0 \(got 'stop'\)/,
    );
  });

  it('rejects missing required arguments', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    await assert.rejects(
      adapterCodex('start', '', worktree, inbox, sessions, 'run-1'),
      /task_spec required/,
    );
    await assert.rejects(
      adapterCodex('start', taskSpec, '', inbox, sessions, 'run-1'),
      /worktree required/,
    );
    await assert.rejects(
      adapterCodex('start', taskSpec, worktree, '', sessions, 'run-1'),
      /inbox required/,
    );
    await assert.rejects(
      adapterCodex('start', taskSpec, worktree, inbox, '', 'run-1'),
      /sessions required/,
    );
    await assert.rejects(
      adapterCodex('start', taskSpec, worktree, inbox, sessions, ''),
      /agent_run_id required/,
    );
  });

  it('bridges a valid worker result into the inbox', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);
    const gitCommon = join(worktree, '.git');

    const workerResult = {
      task_id: 'adapter-codex',
      run_id: '0019',
      spec_version: 1,
      vendor: 'codex',
      status: 'completed',
      branch: 'hydra/0019/adapter-codex',
      base_commit: '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
      head_commit: 'deadbeef',
      summary: 'done',
      files_changed: ['hydra-ts/src/adapter-codex.ts'],
      verification_claims: [],
      risks: [],
      unresolved_questions: [],
      suggested_additional_checks: [],
    };

    const capture: {
      command?: string;
      args?: string[];
      options?: SpawnOptions;
    } = {};
    const options: AdapterCodexOptions = {
      exec: makeExec(gitCommon),
      spawn: makeSpawn('', capture, workerResult),
    };

    const { output, result } = await captureStdout(() =>
      adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-1', options),
    );

    assert.equal(result, 'run-1');
    assert.equal(output.trim(), 'run-1');

    const resultPath = join(inbox, 'result.json');
    assert.equal(existsSync(resultPath), true);
    const bridged = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(bridged.vendor, 'codex');
    assert.equal(bridged.session_id, '');
    assert.equal(bridged.head_commit, 'deadbeef');

    assert.equal(capture.command, 'codex');
    assert.equal(capture.options?.stdin, 'ignore');
    assert.ok(capture.args?.includes('workspace-write'));
    assert.ok(
      capture.args?.some((a) => a.includes('sandbox_workspace_write.writable_roots')),
    );
    assert.ok(
      capture.args?.some((a) => a.includes(gitCommon)),
      `expected git-common-dir in codex args: ${capture.args?.join(' ')}`,
    );
  });

  it('extracts thread_id from the JSONL stream', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc' }),
      JSON.stringify({ type: 'message', msg: { role: 'assistant' } }),
    ].join('\n');

    const options: AdapterCodexOptions = {
      exec: makeExec(join(worktree, '.git')),
      spawn: makeSpawn(jsonl),
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-2', options);

    const sessionJson = join(sessions, 'run-2.json');
    assert.equal(existsSync(sessionJson), true);
    const session = JSON.parse(readFileSync(sessionJson, 'utf8'));
    assert.equal(session.session_id, 'thread-abc');
  });

  it('prefers msg.session_id over top-level session_id', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    const jsonl = [
      JSON.stringify({ session_id: 'old-id' }),
      JSON.stringify({ msg: { session_id: 'new-id' } }),
    ].join('\n');

    const options: AdapterCodexOptions = {
      exec: makeExec(join(worktree, '.git')),
      spawn: makeSpawn(jsonl),
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-3', options);

    const resultPath = join(inbox, 'result.json');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.session_id, 'new-id');
  });

  it('falls through a null thread_id like jq alternative', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    const jsonl = JSON.stringify({
      thread_id: null,
      msg: { session_id: 'msg-session' },
      session_id: 'top-session',
    });
    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-null', {
      exec: makeExec(join(worktree, '.git')),
      spawn: makeSpawn(jsonl),
    });

    const session = JSON.parse(readFileSync(join(sessions, 'run-null.json'), 'utf8'));
    assert.equal(session.session_id, 'msg-session');
  });

  it('falls back to deriving a drop from git evidence', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    writeTaskSpec(taskSpec, { base_commit: base });

    const options: AdapterCodexOptions = {
      exec: makeExec(join(worktree, '.git'), {
        base,
        head,
        files: ['src/change.txt'],
      }),
      spawn: makeSpawn(''),
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-4', options);

    const resultPath = join(inbox, 'result.json');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.status, 'completed');
    assert.equal(result.vendor, 'codex');
    assert.equal(result.summary, 'harness-derived from git (worker committed without a self-report)');
    assert.deepEqual(result.files_changed, ['src/change.txt']);
  });

  it('synthesizes a failed drop when nothing was produced', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    const base = 'a'.repeat(40);
    writeTaskSpec(taskSpec, { base_commit: base });

    const options: AdapterCodexOptions = {
      exec: makeExec(join(worktree, '.git')),
      spawn: makeSpawn(''),
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-5', options);

    const resultPath = join(inbox, 'result.json');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.vendor, 'codex');
    assert.equal(result.head_commit, base);
    assert.deepEqual(result.risks, ['adapter synthesized a failed drop']);
    assert.deepEqual(result.files_changed, []);
  });

  it('falls back after an invalid worker result JSON file', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);
    const spawn: SpawnLike = (_command, _args, options) => {
      writeFileSync(join(options.cwd!, '.hydra-result.json'), '{not-json', 'utf8');
      return { exitCode: 0, signal: null };
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-invalid', {
      exec: makeExec(join(worktree, '.git')),
      spawn,
    });

    const result = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'worker produced no result drop');
  });

  it('ignores a thrown codex spawn like the bash || true path', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-throw', {
      exec: makeExec(join(worktree, '.git')),
      spawn: () => {
        throw new Error('injected codex failure');
      },
    });

    const result = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(result.status, 'failed');
  });

  it('hard-fails when git-common-dir cannot be resolved', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);
    let spawnCalled = false;

    await assert.rejects(
      adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-git-fail', {
        exec: () => {
          throw new Error('injected git failure');
        },
        spawn: () => {
          spawnCalled = true;
          return { exitCode: 0, signal: null };
        },
      }),
      /injected git failure/,
    );
    assert.equal(spawnCalled, false);
    assert.equal(existsSync(join(inbox, 'result.json')), false);
  });

  it('hard-fails failed-drop synthesis for invalid JSON spec_version', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec, { spec_version: 'not-a-json-number' });

    await assert.rejects(
      adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-bad-version', {
        exec: makeExec(join(worktree, '.git')),
        spawn: makeSpawn(''),
      }),
      SyntaxError,
    );
    assert.equal(existsSync(join(inbox, 'result.json')), false);
  });

  it('overrides vendor and fills missing session_id when bridging worker result', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    const workerResult = {
      status: 'completed',
      vendor: 'claude',
      session_id: undefined,
      head_commit: 'abc123',
    };

    const jsonl = [JSON.stringify({ thread_id: 'thread-xyz' })].join('\n');
    const options: AdapterCodexOptions = {
      exec: makeExec(join(worktree, '.git')),
      spawn: makeSpawn(jsonl, undefined, workerResult),
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-6', options);

    const resultPath = join(inbox, 'result.json');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.vendor, 'codex');
    assert.equal(result.session_id, 'thread-xyz');
  });

  it('builds the prompt from the task specification', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec, {
      task_id: 'my-task',
      objective: 'Do the thing.',
      writable_paths: ['src/**'],
      read_only_paths: ['docs/readme.md'],
      acceptance_criteria: ['It works.'],
    });

    let capturedPrompt = '';
    const options: AdapterCodexOptions = {
      exec: makeExec(join(worktree, '.git')),
      spawn: (command: string, args: string[]) => {
        capturedPrompt = args.at(-1) ?? '';
        return { exitCode: 0, signal: null };
      },
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-7', options);

    assert.match(capturedPrompt, /Task my-task/);
    assert.match(capturedPrompt, /Do the thing\./);
    assert.match(capturedPrompt, /src\/\*\*/);
    assert.match(capturedPrompt, /docs\/readme\.md/);
    assert.match(capturedPrompt, /It works\./);
  });

  it('never invokes the real codex CLI', async () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture(makeRunId());
    writeTaskSpec(taskSpec);

    let codexCalled = false;
    const options: AdapterCodexOptions = {
      exec: makeExec(join(worktree, '.git')),
      spawn: () => {
        codexCalled = true;
        return { exitCode: 0, signal: null };
      },
    };

    await adapterCodex('start', taskSpec, worktree, inbox, sessions, 'run-8', options);
    assert.equal(codexCalled, true);
  });
});
