import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
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
import type { ChildProcess } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import {
  buildWorkerPrompt,
  kimiStart,
  kimiVisual,
  makeSandboxProfile,
} from '../src/adapter-kimi.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-adapter-kimi');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
}

function commitFile(dir: string, filename: string, content: string): string {
  const fullPath = join(dir, filename);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  execFileSync('git', ['-C', dir, 'add', filename], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', `add ${filename}`], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function writeTaskSpec(
  path: string,
  overrides: Record<string, string | string[]> = {},
): void {
  const base = {
    task_id: 'adapter-kimi',
    run_id: '0019',
    spec_version: '1',
    branch: 'hydra/0019/adapter-kimi',
    base_commit: '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
    objective: 'Port the bash module to TypeScript.',
    writable_paths: ['hydra-ts/src/adapter-kimi.ts', 'hydra-ts/test/adapter-kimi.test.ts'],
    read_only_paths: ['hydra/adapters/kimi.sh'],
    acceptance_criteria: ['- passes tests'],
    ...overrides,
  };
  const lines = Object.entries(base).map(([k, v]) => {
    if (k === 'objective') return `${k}: >\n  ${v}`;
    if (Array.isArray(v)) return `${k}:\n${v.map((item) => `  - "${item}"`).join('\n')}`;
    return `${k}: ${v}`;
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

interface SpawnRecording {
  command?: string;
  args?: string[];
  options?: SpawnOptionsWithoutStdio;
}

interface FakeSpawnOutputs {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  onSpawn?: (command: string, args: string[], options?: SpawnOptionsWithoutStdio) => void;
  throwError?: Error;
}

function fakeSpawn(
  recording: SpawnRecording,
  outputs: FakeSpawnOutputs,
): typeof import('node:child_process').spawn {
  return ((command: string, args: string[], options?: SpawnOptionsWithoutStdio) => {
    recording.command = command;
    recording.args = args;
    recording.options = options;
    outputs.onSpawn?.(command, args, options);
    if (outputs.throwError) throw outputs.throwError;

    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: new Writable({ write() {} }),
      pid: 12345,
    }) as ChildProcess;

    process.nextTick(() => {
      if (outputs.stdout) stdout.push(Buffer.from(outputs.stdout, 'utf8'));
      stdout.push(null);
      if (outputs.stderr) stderr.push(Buffer.from(outputs.stderr, 'utf8'));
      stderr.push(null);
      child.emit('exit', outputs.exitCode ?? 0, null);
    });

    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

interface ExecCall {
  command: string;
  args: string[];
  options?: ExecFileSyncOptions;
}

function adapterExec(
  calls: ExecCall[],
): typeof execFileSync {
  return (command: string, args: string[], options?: ExecFileSyncOptions): string | Buffer => {
    calls.push({ command, args, options });
    if (command === 'git') {
      return execFileSync(command, args, options);
    }
    throw new Error(`unexpected exec command: ${command}`);
  };
}

function commandLookup(
  available: string[] = ['kimi', 'sandbox-exec'],
  calls: string[] = [],
): (command: string) => boolean {
  return (command) => {
    calls.push(command);
    return available.includes(command);
  };
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

describe('buildWorkerPrompt', () => {
  it('assembles the worker protocol prompt from the task spec', () => {
    const dir = makeTempDir('prompt');
    const spec = join(dir, 'task.yaml');
    writeTaskSpec(spec, {
      task_id: 't1',
      run_id: 'r1',
      spec_version: '2',
      branch: 'hydra/r1/t1',
      base_commit: 'abc123',
      objective: 'Do the thing.',
      writable_paths: ['src/**'],
      read_only_paths: ['docs/**'],
      acceptance_criteria: ['- one', '- two'],
    });

    const prompt = buildWorkerPrompt(spec);

    assert.match(prompt, /You are a Hydra-Swarm implementation worker/);
    assert.match(prompt, /branch: hydra\/r1\/t1/);
    assert.match(prompt, /base abc123/);
    assert.match(prompt, /Task t1 \(run r1, spec v2\)/);
    assert.match(prompt, /Objective: Do the thing\./);
    assert.match(prompt, /src\/\*\*/);
    assert.match(prompt, /docs\/\*\*/);
    assert.match(prompt, /- one/);
    assert.match(prompt, /- two/);
  });
});

describe('makeSandboxProfile', () => {
  it('writes an SBPL profile allowing writes only under the supplied roots', () => {
    const dir = makeTempDir('profile');
    const profilePath = makeSandboxProfile([dir, '/tmp/foo']);

    assert.ok(existsSync(profilePath));
    const content = readFileSync(profilePath, 'utf8');
    assert.match(content, /\(version 1\)/);
    assert.match(content, /\(allow default\)/);
    assert.match(content, /\(deny file-write\*\)/);
    assert.match(content, /\(allow file-write\* \(subpath "\/dev"\)\)/);
    assert.match(content, new RegExp(`\\(allow file-write\\* \\(subpath "${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`));
    assert.ok(content.includes('(allow file-write* (subpath "/tmp/foo"))'));

    rmSync(dirname(profilePath), { recursive: true, force: true });
  });
});

describe('kimiVisual', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('runs kimi in read-only mode and writes the parsed outputs', async () => {
    const dir = makeTempDir('visual');
    const outPrefix = join(dir, 'out', 'visual');
    const stdoutLines = [
      JSON.stringify({ role: 'assistant', content: 'first' }),
      JSON.stringify({ role: 'assistant', content: 'second', session_id: 'sess-123' }),
    ];
    const recording: SpawnRecording = {};
    const spawn = fakeSpawn(recording, { stdout: stdoutLines.join('\n') + '\n', stderr: 'progress' });

    const result = await kimiVisual(dir, 'describe this', outPrefix, 'run-abc', '', {
      spawn,
      commandExists: commandLookup(['kimi']),
    });

    assert.equal(result, `${outPrefix}.txt`);
    assert.equal(recording.command, 'kimi');
    assert.ok(recording.args?.includes('-p'));
    assert.ok(recording.args?.includes('describe this'));
    assert.ok(recording.args?.includes('--output-format'));
    assert.ok(recording.args?.includes('stream-json'));
    assert.ok(recording.args?.includes('--add-dir'));
    assert.ok(recording.args?.includes(dir));
    assert.ok(!recording.args?.includes('-y'));
    assert.equal(recording.options?.cwd, dir);

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8').trim(), 'second');
    assert.equal(readFileSync(`${outPrefix}.stderr`, 'utf8').trim(), 'progress');

    const session = JSON.parse(readFileSync(`${outPrefix}.session.json`, 'utf8'));
    assert.equal(session.agent_run_id, 'run-abc');
    assert.equal(session.vendor, 'kimi');
    assert.equal(session.role, 'visual_debugging');
    assert.equal(session.session_id, 'sess-123');
  });

  it('attaches an image path when provided', async () => {
    const dir = makeTempDir('visual-image');
    const imageDir = makeTempDir('images');
    const imagePath = join(imageDir, 'screenshot.png');
    writeFileSync(imagePath, 'png', 'utf8');
    const outPrefix = join(dir, 'out', 'visual');
    const recording: SpawnRecording = {};
    const spawn = fakeSpawn(recording, { stdout: '' });

    await kimiVisual(dir, 'describe this', outPrefix, 'run-abc', imagePath, {
      spawn,
      commandExists: commandLookup(['kimi']),
    });

    const promptArg = recording.args?.[recording.args.indexOf('-p') + 1];
    assert.ok(promptArg?.includes('Image to analyze:'));
    assert.ok(promptArg?.includes(imagePath));
    assert.ok(recording.args?.includes('--add-dir'));
    assert.ok(recording.args?.includes(dirname(imagePath)));
  });

  it('matches jq by rejecting the complete stream when a JSONL value is malformed', async () => {
    const dir = makeTempDir('visual-messy');
    const outPrefix = join(dir, 'out', 'visual');
    const spawn = fakeSpawn({}, { stdout: 'not-json\n' + JSON.stringify({ role: 'assistant', content: 'ok' }) + '\n' });

    await kimiVisual(dir, 'prompt', outPrefix, 'run-abc', '', {
      spawn,
      commandExists: commandLookup(['kimi']),
    });

    assert.equal(readFileSync(`${outPrefix}.txt`, 'utf8'), '');
    const session = JSON.parse(readFileSync(`${outPrefix}.session.json`, 'utf8'));
    assert.equal(session.session_id, '');
  });

  it('refuses to run when the Kimi CLI is unavailable', async () => {
    const dir = makeTempDir('visual-no-kimi');
    let spawned = false;

    await assert.rejects(
      () => kimiVisual(dir, 'prompt', join(dir, 'out'), 'run-abc', '', {
        commandExists: commandLookup([]),
        spawn: fakeSpawn({}, { onSpawn: () => { spawned = true; } }),
      }),
      /kimi CLI not found/,
    );
    assert.equal(spawned, false);
  });

  it('passes the original relative cwd to --add-dir while spawning in its resolved path', async () => {
    const root = makeTempDir('visual-relative');
    mkdirSync(join(root, 'work'), { recursive: true });
    const recording: SpawnRecording = {};

    await kimiVisual('work', 'prompt', join(root, 'out'), 'run-abc', '', {
      cwd: root,
      commandExists: commandLookup(['kimi']),
      spawn: fakeSpawn(recording, {}),
    });

    assert.deepEqual(recording.args?.slice(-2), ['--add-dir', 'work']);
    assert.equal(recording.options?.cwd, join(root, 'work'));
  });
});

describe('kimiStart', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('runs the sandboxed write role and bridges a worker result drop', async () => {
    const dir = makeTempDir('start');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    const baseCommit = commitFile(repoRoot, 'README.md', '# hi\n');

    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { base_commit: baseCommit });
    const inbox = join(dir, 'inbox');
    const sessions = join(dir, 'sessions');
    const agentRunId = 'agent-0019';

    const workerResult = {
      task_id: 'adapter-kimi',
      run_id: '0019',
      spec_version: 1,
      vendor: 'kimi',
      status: 'completed',
      branch: 'hydra/0019/adapter-kimi',
      base_commit: baseCommit,
      head_commit: baseCommit,
      summary: 'done',
      files_changed: ['hydra-ts/src/adapter-kimi.ts'],
      verification_claims: [],
      risks: [],
      unresolved_questions: [],
      suggested_additional_checks: [],
    };
    writeFileSync(join(worktree, '.hydra-result.json'), '{"summary":"stale"}', 'utf8');
    const stdoutLines = [
      JSON.stringify({ role: 'assistant', content: 'working' }),
      JSON.stringify({ session_id: 'sess-write-1' }),
    ];
    const recording: SpawnRecording = {};
    let profileAtSpawn = '';
    const spawn = fakeSpawn(recording, {
      stdout: stdoutLines.join('\n') + '\n',
      stderr: 'live progress',
      onSpawn: (_command, args) => {
        assert.equal(existsSync(join(worktree, '.hydra-result.json')), false);
        const profilePath = args[args.indexOf('-f') + 1];
        profileAtSpawn = readFileSync(profilePath, 'utf8');
        // The Bash adapter removes stale results before invoking Kimi. Model the
        // worker creating its fresh result while the injected CLI is running.
        writeFileSync(join(worktree, '.hydra-result.json'), JSON.stringify(workerResult), 'utf8');
      },
    });
    const execCalls: ExecCall[] = [];
    const exec = adapterExec(execCalls);

    const { stderr } = await captureStderr(async () => {
      const result = await kimiStart(taskSpec, worktree, inbox, sessions, agentRunId, {
        spawn,
        exec,
        commandExists: commandLookup(),
      });
      assert.equal(result, agentRunId);
    });

    assert.equal(recording.command, 'sandbox-exec');
    assert.ok(recording.args?.includes('-f'));
    const profilePath = recording.args?.[recording.args.indexOf('-f') + 1];
    assert.ok(profilePath && !existsSync(profilePath));
    assert.match(profileAtSpawn, /\(deny file-write\*\)/);
    assert.match(profileAtSpawn, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(recording.args?.includes('kimi'));
    assert.ok(recording.args?.includes('--output-format'));
    assert.ok(recording.args?.includes('stream-json'));
    assert.ok(!recording.args?.includes('-y'));
    assert.ok(stderr.includes('live progress'));

    const sessionJson = JSON.parse(readFileSync(join(sessions, `${agentRunId}.json`), 'utf8'));
    assert.equal(sessionJson.agent_run_id, agentRunId);
    assert.equal(sessionJson.vendor, 'kimi');
    assert.equal(sessionJson.session_id, 'sess-write-1');

    const cliJsonl = readFileSync(join(sessions, `${agentRunId}.cli.jsonl`), 'utf8');
    assert.ok(cliJsonl.includes('sess-write-1'));

    const resultDrop = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(resultDrop.vendor, 'kimi');
    assert.equal(resultDrop.session_id, 'sess-write-1');
    assert.equal(resultDrop.status, 'completed');
  });

  it('derives a result drop from git evidence when the worker omits one', async () => {
    const dir = makeTempDir('start-git');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    const baseCommit = commitFile(repoRoot, 'README.md', '# hi\n');

    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'file.ts'), 'export const x = 1;\n', 'utf8');
    execFileSync('git', ['-C', worktree, 'add', '.'], { encoding: 'utf8', stdio: 'ignore' });
    execFileSync('git', ['-C', worktree, 'commit', '-m', 'worker commit'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { base_commit: baseCommit });
    const inbox = join(dir, 'inbox');
    const sessions = join(dir, 'sessions');
    const agentRunId = 'agent-git';

    const spawn = fakeSpawn({}, { stdout: '' });
    const exec = adapterExec([]);

    await kimiStart(taskSpec, worktree, inbox, sessions, agentRunId, {
      spawn,
      exec,
      commandExists: commandLookup(),
    });

    const resultDrop = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(resultDrop.vendor, 'kimi');
    assert.equal(resultDrop.status, 'completed');
    assert.ok(resultDrop.files_changed.includes('src/file.ts'));
    assert.match(resultDrop.summary, /derived from git/);
  });

  it('synthesizes a failed drop when there is no result and no commit', async () => {
    const dir = makeTempDir('start-fail');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    const baseCommit = commitFile(repoRoot, 'README.md', '# hi\n');

    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { base_commit: baseCommit });
    const inbox = join(dir, 'inbox');
    const sessions = join(dir, 'sessions');
    const agentRunId = 'agent-fail';

    const spawn = fakeSpawn({}, { stdout: '' });
    const exec = adapterExec([]);

    await kimiStart(taskSpec, worktree, inbox, sessions, agentRunId, {
      spawn,
      exec,
      commandExists: commandLookup(),
    });

    const resultDrop = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(resultDrop.vendor, 'kimi');
    assert.equal(resultDrop.status, 'failed');
    assert.equal(resultDrop.head_commit, baseCommit);
    assert.deepEqual(resultDrop.files_changed, []);
  });

  it('treats a malformed worker result as absent and synthesizes failure without git evidence', async () => {
    const dir = makeTempDir('start-malformed-result');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    const baseCommit = commitFile(repoRoot, 'README.md', '# hi\n');
    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { base_commit: baseCommit });
    const inbox = join(dir, 'inbox');

    await kimiStart(taskSpec, worktree, inbox, join(dir, 'sessions'), 'agent-bad-result', {
      commandExists: commandLookup(),
      exec: adapterExec([]),
      spawn: fakeSpawn({}, {
        onSpawn: () => writeFileSync(join(worktree, '.hydra-result.json'), '{broken', 'utf8'),
      }),
    });

    const resultDrop = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(resultDrop.status, 'failed');
    assert.deepEqual(resultDrop.risks, ['adapter synthesized a failed drop']);
  });

  it('refuses the write role when sandbox-exec cannot be found without spawning it', async () => {
    const dir = makeTempDir('start-no-sandbox');
    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec);
    const lookups: string[] = [];
    let spawned = false;

    await assert.rejects(
      () => kimiStart(taskSpec, dir, join(dir, 'inbox'), join(dir, 'sessions'), 'agent', {
        commandExists: commandLookup(['kimi'], lookups),
        spawn: fakeSpawn({}, { onSpawn: () => { spawned = true; } }),
      }),
      /no OS sandbox/,
    );
    assert.deepEqual(lookups, ['kimi', 'sandbox-exec']);
    assert.equal(spawned, false);
  });

  it('hard-refuses an empty sandbox profile before the auto-approving worker can spawn', async () => {
    const dir = makeTempDir('start-empty-profile');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    const baseCommit = commitFile(repoRoot, 'README.md', '# hi\n');
    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { base_commit: baseCommit });
    let spawned = false;

    await assert.rejects(
      () => kimiStart(taskSpec, worktree, join(dir, 'inbox'), join(dir, 'sessions'), 'agent', {
        commandExists: commandLookup(),
        exec: adapterExec([]),
        makeSandboxProfile: () => '',
        spawn: fakeSpawn({}, { onSpawn: () => { spawned = true; } }),
      }),
      /failed to build sandbox profile/,
    );
    assert.equal(spawned, false);
  });
});
