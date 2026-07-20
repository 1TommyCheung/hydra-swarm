import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import {
  buildWorkerPrompt,
  kimi,
  kimiStart,
  kimiVisual,
  makeSrtSettings,
  resume,
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

/**
 * Deterministic stand-in for the real prepareWorkerEnv, used by every
 * kimiStart() test that reaches the preflight: real prepareWorkerEnv
 * resolves tools against the actual host PATH, which would make these
 * tests depend on the machine (e.g. whether 'kimi' happens to be
 * installed). worker-devenv.test.ts exercises the real preflight logic
 * in isolation; this file only needs kimiStart's wiring to it.
 */
function stubPrepareWorkerEnv(): ReturnType<typeof import('../src/worker-devenv.ts')['prepareWorkerEnv']> {
  return Promise.resolve({
    allowedDomains: [],
    envOverrides: { npm_config_store_dir: '/tmp/hydra-test-pnpm-store' },
    toolsVerified: { git: '/usr/bin/git', node: '/usr/bin/node', npm: '/usr/bin/npm', kimi: '/usr/bin/kimi' },
    domainSource: 'inline-fallback',
    logLine: 'worker-devenv: stub',
  });
}

function writeBaselineDomains(dir: string): string {
  const path = join(dir, 'kimi-sandbox-domains.json');
  writeFileSync(path, JSON.stringify({
    allowedDomains: ['api.kimi.com', 'api.moonshot.ai', 'api.moonshot.cn'],
  }), 'utf8');
  return path;
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
  return ((command: string, args?: readonly string[], options?: ExecFileSyncOptions): string | Buffer => {
    const argList = args ? [...args] : [];
    calls.push({ command, args: argList, options });
    if (command === 'git') {
      return execFileSync(command, argList, options);
    }
    throw new Error(`unexpected exec command: ${command}`);
  }) as typeof execFileSync;
}

function commandLookup(
  available: string[] = ['kimi', 'srt'],
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

describe('makeSrtSettings', () => {
  it('writes valid srt settings with network and write allowlists', () => {
    const dir = makeTempDir('settings');
    const settingsPath = join(dir, 'agent.srt-settings.json');
    const result = makeSrtSettings(
      settingsPath,
      [dir, '/tmp/foo'],
      ['api.kimi.com', 'registry.npmjs.org', 'api.kimi.com'],
    );

    assert.equal(result, settingsPath);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.network.allowedDomains, ['api.kimi.com', 'registry.npmjs.org']);
    assert.deepEqual(settings.network.deniedDomains, []);
    assert.ok(settings.filesystem.allowWrite.includes(dir));
    assert.ok(settings.filesystem.allowWrite.includes('/tmp/foo'));
    assert.deepEqual(settings.filesystem.denyWrite, []);
    assert.deepEqual(settings.filesystem.denyRead, []);
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
    writeTaskSpec(taskSpec, {
      base_commit: baseCommit,
      network_domains: ['registry.npmjs.org', 'api.kimi.com'],
    });
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
    let settingsAtSpawn: {
      network: { allowedDomains: string[]; deniedDomains: string[] };
      filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
    } | undefined;
    const spawn = fakeSpawn(recording, {
      stdout: stdoutLines.join('\n') + '\n',
      stderr: 'live progress',
      onSpawn: (_command, args) => {
        assert.equal(existsSync(join(worktree, '.hydra-result.json')), false);
        const settingsPath = args[args.indexOf('-s') + 1];
        settingsAtSpawn = JSON.parse(readFileSync(settingsPath, 'utf8'));
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
        sandboxDomainsPath: writeBaselineDomains(dir),
      });
      assert.equal(result, agentRunId);
    });

    assert.equal(recording.command, 'srt');
    assert.ok(recording.args?.includes('-s'));
    const settingsPath = recording.args?.[recording.args.indexOf('-s') + 1];
    assert.equal(settingsPath, join(sessions, `${agentRunId}.srt-settings.json`));
    assert.ok(settingsPath && !existsSync(settingsPath));
    assert.deepEqual(settingsAtSpawn?.network.allowedDomains, [
      'api.kimi.com',
      'api.moonshot.ai',
      'api.moonshot.cn',
      'registry.npmjs.org',
    ]);
    assert.deepEqual(settingsAtSpawn?.network.deniedDomains, []);
    assert.ok(settingsAtSpawn?.filesystem.allowWrite.includes(worktree));
    assert.ok(settingsAtSpawn?.filesystem.allowWrite.includes(join(repoRoot, '.git')));
    // srt allowWrite matching needs physical paths (see the realpathSync calls in
    // kimiStart): the TMPDIR root must be canonicalized, not the raw env value.
    assert.ok(settingsAtSpawn?.filesystem.allowWrite.includes(realpathSync(process.env.TMPDIR ?? '/tmp')));
    assert.ok(settingsAtSpawn?.filesystem.allowWrite.includes('/private/tmp'));
    assert.ok(settingsAtSpawn?.filesystem.allowWrite.includes(`${process.env.HOME}/.kimi-code`));
    assert.deepEqual(settingsAtSpawn?.filesystem.denyWrite, []);
    assert.deepEqual(settingsAtSpawn?.filesystem.denyRead, []);
    assert.ok(recording.args?.includes('-c'));
    const commandString = recording.args?.[recording.args.indexOf('-c') + 1] ?? '';
    assert.match(commandString, /^'kimi' '-p' /);
    assert.match(commandString, /'--output-format' 'stream-json'/);
    assert.match(commandString, /'--add-dir'/);
    assert.ok(commandString.includes(`'${worktree}'`));
    assert.ok(!commandString.includes("'-y'"));
    assert.ok(stderr.includes('live progress'));

    // Store/cache env vars come from prepareWorkerEnv (stubbed here) — the
    // former inline pnpm-store computation was superseded by worker-devenv.ts.
    // The dirs are per-attempt and removed once the run ends.
    const expectedStoreDir = '/tmp/hydra-test-pnpm-store';
    assert.equal(recording.options?.env?.npm_config_store_dir, expectedStoreDir);
    assert.equal(existsSync(expectedStoreDir), false);

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

  it('keeps the per-task pnpm store under an effective srt allowWrite root when TMPDIR contains a symlink (regression: raw TMPDIR is not a physical path)', async () => {
    const dir = makeTempDir('start-symlinked-tmp');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    const baseCommit = commitFile(repoRoot, 'README.md', '# hi\n');

    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    // macOS hands out TMPDIR under /var/folders (a symlink to /private/var), and
    // kimiStart canonicalizes the worktree/git-common-dir precisely because srt
    // allowWrite matching works on physical paths. Model that here: the tmp base
    // the store is rooted at must be the canonicalized one, or the sandboxed
    // pnpm still cannot write its store.
    const realTmp = join(dir, 'real-tmp');
    const tmpLink = join(dir, 'tmp-link');
    mkdirSync(realTmp, { recursive: true });
    symlinkSync(realTmp, tmpLink);
    const symlinkedTmp = join(tmpLink, 'T');
    mkdirSync(symlinkedTmp, { recursive: true });
    const resolvedTmp = realpathSync(symlinkedTmp);
    assert.notEqual(symlinkedTmp, resolvedTmp);

    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { base_commit: baseCommit });
    const inbox = join(dir, 'inbox');
    const sessions = join(dir, 'sessions');
    const agentRunId = 'agent-symlinked-tmp';

    const recording: SpawnRecording = {};
    let settingsAtSpawn: { filesystem: { allowWrite: string[] } } | undefined;
    const spawn = fakeSpawn(recording, {
      stdout: '',
      onSpawn: (_command, args) => {
        const settingsPath = args[args.indexOf('-s') + 1];
        settingsAtSpawn = JSON.parse(readFileSync(settingsPath, 'utf8'));
      },
    });

    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = symlinkedTmp;
    try {
      await captureStderr(async () => {
        await kimiStart(taskSpec, worktree, inbox, sessions, agentRunId, {
          spawn,
          exec: adapterExec([]),
          commandExists: commandLookup(),
          sandboxDomainsPath: writeBaselineDomains(dir),
        });
      });
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }

    const expectedStoreDir = join(resolvedTmp, `hydra-pnpm-store-${agentRunId}`);
    assert.ok(settingsAtSpawn?.filesystem.allowWrite.includes(resolvedTmp));
    assert.equal(recording.options?.env?.npm_config_store_dir, expectedStoreDir);
    // The store is per-attempt; nothing references it after the run, so it is
    // removed rather than left to accumulate in TMPDIR.
    assert.equal(existsSync(expectedStoreDir), false);
  });

  it('falls back to the provider domains when the baseline file is missing', async () => {
    const dir = makeTempDir('start-no-baseline');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    const baseCommit = commitFile(repoRoot, 'README.md', '# hi\n');

    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, {
      base_commit: baseCommit,
      network_domains: ['registry.npmjs.org', 'api.kimi.com'],
    });
    const inbox = join(dir, 'inbox');
    const sessions = join(dir, 'sessions');
    const agentRunId = 'agent-0019-nb';

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
    const stdoutLines = [
      JSON.stringify({ role: 'assistant', content: 'working' }),
      JSON.stringify({ session_id: 'sess-no-baseline' }),
    ];
    const recording: SpawnRecording = {};
    let settingsAtSpawn: {
      network: { allowedDomains: string[]; deniedDomains: string[] };
    } | undefined;
    const spawn = fakeSpawn(recording, {
      stdout: stdoutLines.join('\n') + '\n',
      stderr: '',
      onSpawn: (_command, args) => {
        const settingsPath = args[args.indexOf('-s') + 1];
        settingsAtSpawn = JSON.parse(readFileSync(settingsPath, 'utf8'));
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
        sandboxDomainsPath: join(dir, 'does-not-exist.json'),
      });
      assert.equal(result, agentRunId);
    });

    assert.deepEqual(settingsAtSpawn?.network.allowedDomains, [
      'api.kimi.com',
      'api.moonshot.ai',
      'api.moonshot.cn',
      'registry.npmjs.org',
    ]);
    assert.ok(stderr.includes('sandbox baseline missing or invalid'));
  });

  it('merges derived worktree-manifest domains ahead of task-spec domains, logs the trigger, and persists them to the baseline', async () => {
    const dir = makeTempDir('start-derived');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    commitFile(repoRoot, 'README.md', '# hi\n');
    commitFile(repoRoot, 'package.json', JSON.stringify({
      name: 'repo',
      dependencies: {
        'live-hmr-feedback': 'git+https://github.com/1TommyCheung/live-hmr-feedback.git#v1.3.0',
      },
    }));
    const baseCommit = commitFile(repoRoot, 'pnpm-lock.yaml', '');

    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, {
      base_commit: baseCommit,
      network_domains: ['some-task-domain.example.com'],
    });
    const inbox = join(dir, 'inbox');
    const sessions = join(dir, 'sessions');
    const agentRunId = 'agent-0019-derived';
    const baselinePath = writeBaselineDomains(dir);

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
    const stdoutLines = [
      JSON.stringify({ role: 'assistant', content: 'working' }),
      JSON.stringify({ session_id: 'sess-derived' }),
    ];
    const recording: SpawnRecording = {};
    let settingsAtSpawn: {
      network: { allowedDomains: string[]; deniedDomains: string[] };
    } | undefined;
    const spawn = fakeSpawn(recording, {
      stdout: stdoutLines.join('\n') + '\n',
      stderr: '',
      onSpawn: (_command, args) => {
        const settingsPath = args[args.indexOf('-s') + 1];
        settingsAtSpawn = JSON.parse(readFileSync(settingsPath, 'utf8'));
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
        sandboxDomainsPath: baselinePath,
      });
      assert.equal(result, agentRunId);
    });

    const allowed = settingsAtSpawn?.network.allowedDomains ?? [];
    assert.ok(allowed.includes('registry.npmjs.org'));
    assert.ok(allowed.includes('github.com'));
    assert.ok(allowed.includes('codeload.github.com'));
    assert.ok(allowed.includes('some-task-domain.example.com'));
    assert.ok(allowed.includes('api.kimi.com'));

    assert.ok(stderr.includes('env-domains:'));
    assert.ok(stderr.includes('+registry.npmjs.org (pnpm-lock.yaml)'));
    assert.ok(stderr.includes('+github.com'));

    const persisted = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.ok(persisted.allowedDomains.includes('registry.npmjs.org'));
    assert.ok(persisted.allowedDomains.includes('github.com'));
    // Original baseline entries are still present — union, not replace.
    assert.ok(persisted.allowedDomains.includes('api.kimi.com'));
    assert.ok(persisted.allowedDomains.includes('api.moonshot.ai'));
  });

  it('persists the provider-domain fallback alongside derived domains when the baseline file is missing (regression: a bare-derived first write must not silently drop api.kimi.com/api.moonshot.* for every dispatch after it)', async () => {
    const dir = makeTempDir('start-derived-no-baseline');
    const repoRoot = join(dir, 'repo');
    initGitRepo(repoRoot);
    commitFile(repoRoot, 'README.md', '# hi\n');
    commitFile(repoRoot, 'package.json', JSON.stringify({ name: 'repo', dependencies: { foo: '^1.0.0' } }));
    const baseCommit = commitFile(repoRoot, 'pnpm-lock.yaml', '');

    const worktree = join(dir, 'worktree');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', worktree, baseCommit], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { base_commit: baseCommit });
    const inbox = join(dir, 'inbox');
    const sessions = join(dir, 'sessions');
    const agentRunId = 'agent-0019-derived-no-baseline';
    // No writeBaselineDomains() call — the baseline path must not exist yet.
    const baselinePath = join(dir, 'kimi-sandbox-domains.json');
    assert.ok(!existsSync(baselinePath));

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
    const stdoutLines = [
      JSON.stringify({ role: 'assistant', content: 'working' }),
      JSON.stringify({ session_id: 'sess-derived-no-baseline' }),
    ];
    const recording: SpawnRecording = {};
    const spawn = fakeSpawn(recording, {
      stdout: stdoutLines.join('\n') + '\n',
      stderr: '',
      onSpawn: (_command, _args) => {
        writeFileSync(join(worktree, '.hydra-result.json'), JSON.stringify(workerResult), 'utf8');
      },
    });
    const execCalls: ExecCall[] = [];
    const exec = adapterExec(execCalls);

    await captureStderr(async () => {
      const result = await kimiStart(taskSpec, worktree, inbox, sessions, agentRunId, {
        spawn,
        exec,
        commandExists: commandLookup(),
        prepareWorkerEnv: stubPrepareWorkerEnv,
        sandboxDomainsPath: baselinePath,
      });
      assert.equal(result, agentRunId);
    });

    // The FIRST-EVER write to this baseline path (triggered by derivation)
    // must already include the Kimi provider domains, not just the derived
    // registry domain -- otherwise the very next dispatch reads this file
    // as "valid" and never falls back to KIMI_PROVIDER_DOMAINS again.
    const persisted = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.ok(persisted.allowedDomains.includes('registry.npmjs.org'));
    assert.ok(persisted.allowedDomains.includes('api.kimi.com'));
    assert.ok(persisted.allowedDomains.includes('api.moonshot.ai'));
    assert.ok(persisted.allowedDomains.includes('api.moonshot.cn'));
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
      sandboxDomainsPath: writeBaselineDomains(dir),
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
      sandboxDomainsPath: writeBaselineDomains(dir),
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
      exec: adapterExec([]),
      sandboxDomainsPath: writeBaselineDomains(dir),
      spawn: fakeSpawn({}, {
        onSpawn: () => writeFileSync(join(worktree, '.hydra-result.json'), '{broken', 'utf8'),
      }),
    });

    const resultDrop = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(resultDrop.status, 'failed');
    assert.deepEqual(resultDrop.risks, ['adapter synthesized a failed drop']);
  });

  it('refuses the write role when srt cannot be found without spawning it', async () => {
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
    assert.deepEqual(lookups, ['kimi', 'srt']);
    assert.equal(spawned, false);
  });

  it('hard-refuses empty srt settings before the auto-approving worker can spawn', async () => {
    const dir = makeTempDir('start-empty-settings');
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
        exec: adapterExec([]),
        sandboxDomainsPath: writeBaselineDomains(dir),
        makeSrtSettings: () => '',
        spawn: fakeSpawn({}, { onSpawn: () => { spawned = true; } }),
      }),
      /failed to build valid srt settings/,
    );
    assert.equal(spawned, false);
  });

  it('hard-refuses invalid srt settings before spawning', async () => {
    const dir = makeTempDir('start-invalid-settings');
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
        prepareWorkerEnv: stubPrepareWorkerEnv,
        exec: adapterExec([]),
        sandboxDomainsPath: writeBaselineDomains(dir),
        makeSrtSettings: (settingsPath) => {
          writeFileSync(settingsPath, JSON.stringify({
            network: { allowedDomains: ['*'], deniedDomains: [] },
            filesystem: { allowWrite: [worktree], denyWrite: [], denyRead: [] },
          }), 'utf8');
          return settingsPath;
        },
        spawn: fakeSpawn({}, { onSpawn: () => { spawned = true; } }),
      }),
      /failed to build valid srt settings/,
    );
    assert.equal(spawned, false);
  });
});

describe('kimi resume', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('inserts -S <priorSessionId> ahead of --add-dir in the sandboxed kimi command', async () => {
    const dir = makeTempDir('resume-flag');
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
    const agentRunId = 'agent-resume-flag';

    const recording: SpawnRecording = {};
    const spawn = fakeSpawn(recording, { stdout: '' });

    const { stderr } = await captureStderr(async () => {
      const result = await resume(taskSpec, worktree, join(dir, 'inbox'), join(dir, 'sessions'), agentRunId, 'sess-prior-1', {
        spawn,
        exec: adapterExec([]),
        commandExists: commandLookup(),
        prepareWorkerEnv: stubPrepareWorkerEnv,
        sandboxDomainsPath: writeBaselineDomains(dir),
      });
      assert.equal(result, agentRunId);
    });

    assert.equal(recording.command, 'srt');
    const commandString = recording.args?.[recording.args.indexOf('-c') + 1] ?? '';
    const tokens = commandString.split(' ');
    // The installed Kimi CLI's resume flag is `-S, --session <id>` (verified
    // via `kimi --help`; docs/vendor-adapters.md §3) — inserted right before
    // --add-dir, where adapter-claude.ts appends --resume.
    const flagIndex = tokens.indexOf("'-S'");
    assert.notEqual(flagIndex, -1);
    assert.equal(tokens[flagIndex + 1], `'sess-prior-1'`);
    assert.ok(flagIndex < tokens.indexOf("'--add-dir'"));
    assert.equal(tokens[0], `'kimi'`);
    assert.equal(tokens[1], `'-p'`);
    assert.match(commandString, /'--output-format' 'stream-json'/);
    // The resume is logged, like adapter-claude's `claude resume from session ...`.
    assert.ok(stderr.includes('kimi resume from session sess-prior-1'));
  });

  it('start leaves the kimi command unchanged — no -S flag without a prior session', async () => {
    const dir = makeTempDir('start-no-resume-flag');
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
    const agentRunId = 'agent-start-no-resume';

    const recording: SpawnRecording = {};
    const spawn = fakeSpawn(recording, { stdout: '' });

    await captureStderr(async () => {
      const result = await kimiStart(taskSpec, worktree, join(dir, 'inbox'), join(dir, 'sessions'), agentRunId, {
        spawn,
        exec: adapterExec([]),
        commandExists: commandLookup(),
        prepareWorkerEnv: stubPrepareWorkerEnv,
        sandboxDomainsPath: writeBaselineDomains(dir),
      });
      assert.equal(result, agentRunId);
    });

    assert.equal(recording.command, 'srt');
    const commandString = recording.args?.[recording.args.indexOf('-c') + 1] ?? '';
    assert.match(commandString, /^'kimi' '-p' /);
    assert.match(commandString, /'--output-format' 'stream-json'/);
    assert.match(commandString, /'--add-dir'/);
    assert.ok(commandString.includes(`'${worktree}'`));
    // No resume flag and no session id leak onto the cold-start path.
    assert.ok(!commandString.split(' ').includes("'-S'"));
    assert.ok(!commandString.includes('sess-prior-1'));
  });

  it('captures the new session id and bridges the worker result on the resume path', async () => {
    const dir = makeTempDir('resume-bridge');
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
    const agentRunId = 'agent-resume-bridge';

    const workerResult = {
      task_id: 'adapter-kimi',
      run_id: '0019',
      spec_version: 1,
      vendor: 'kimi',
      status: 'completed',
      branch: 'hydra/0019/adapter-kimi',
      base_commit: baseCommit,
      head_commit: baseCommit,
      summary: 'resumed and done',
      files_changed: ['hydra-ts/src/adapter-kimi.ts'],
      verification_claims: [],
      risks: [],
      unresolved_questions: [],
      suggested_additional_checks: [],
    };
    const stdoutLines = [
      JSON.stringify({ role: 'assistant', content: 'continuing' }),
      JSON.stringify({ session_id: 'sess-resumed-2' }),
    ];
    const recording: SpawnRecording = {};
    const spawn = fakeSpawn(recording, {
      stdout: `${stdoutLines.join('\n')}\n`,
      onSpawn: () => {
        writeFileSync(join(worktree, '.hydra-result.json'), JSON.stringify(workerResult), 'utf8');
      },
    });

    await captureStderr(async () => {
      const result = await resume(taskSpec, worktree, inbox, sessions, agentRunId, 'sess-prior-1', {
        spawn,
        exec: adapterExec([]),
        commandExists: commandLookup(),
        prepareWorkerEnv: stubPrepareWorkerEnv,
        sandboxDomainsPath: writeBaselineDomains(dir),
      });
      assert.equal(result, agentRunId);
    });

    // Session-id capture is identical to the start path: the NEW session id
    // emitted by this run's stream (not the prior one passed via -S).
    const sessionJson = JSON.parse(readFileSync(join(sessions, `${agentRunId}.json`), 'utf8'));
    assert.equal(sessionJson.agent_run_id, agentRunId);
    assert.equal(sessionJson.vendor, 'kimi');
    assert.equal(sessionJson.session_id, 'sess-resumed-2');

    const cliJsonl = readFileSync(join(sessions, `${agentRunId}.cli.jsonl`), 'utf8');
    assert.ok(cliJsonl.includes('sess-resumed-2'));

    // Result bridging is identical to the start path too.
    const resultDrop = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(resultDrop.vendor, 'kimi');
    assert.equal(resultDrop.session_id, 'sess-resumed-2');
    assert.equal(resultDrop.status, 'completed');
    assert.equal(resultDrop.summary, 'resumed and done');
  });

  it('rejects an unknown verb through the shared kimi() entry point', async () => {
    await assert.rejects(
      () => kimi('explore' as 'start', 'spec', 'wt', 'inbox', 'sessions', 'agent', undefined, {
        commandExists: commandLookup(),
      }),
      /kimi: unknown verb 'explore'/,
    );
  });
});

describe('worker prompt parity (issue #26)', () => {
  it('renders the shared amendment + revision-evidence contract byte-for-byte', async () => {
    const { mkdtempSync, mkdirSync: makeDir, writeFileSync: writeF, rmSync: removeR } = await import('node:fs');
    const { tmpdir: osTmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { resolveRevisionEvidence, materializeRevisionEvidence } = await import('../src/revision-evidence.ts');
    const { buildWorkerPrompt: buildSharedPrompt } = await import('../src/build-worker-prompt.ts');
    const { buildWorkerPrompt: adapterPrompt } = await import('../src/adapter-kimi.ts');

    const dir = mkdtempSync(joinPath(osTmpdir(), 'hydra-parity-kimi-'));
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
