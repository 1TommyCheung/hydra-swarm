import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildWorkerPrompt,
  claude,
  defaultRunCommand,
  start,
  resume,
  type CliRunner,
} from '../src/adapter-claude.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-adapter-claude');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, uniqueName(prefix));
  mkdirSync(p, { recursive: true });
  return p;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
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
  execFileSync('git', ['-C', dir, 'add', filename], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', dir, 'commit', '-m', `add ${filename}`], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

function writeTaskSpec(
  path: string,
  overrides: Record<string, string> = {},
): void {
  const taskId = overrides.task_id ?? 'adapter-claude-test';
  const runId = overrides.run_id ?? '0019';
  const specVersion = overrides.spec_version ?? '1';
  const branch = overrides.branch ?? 'hydra/0019/adapter-claude';
  const baseCommit =
    overrides.base_commit ??
    '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070';
  const objective = overrides.objective ?? 'Port the bash adapter.';
  const writable = overrides.writable_paths ??
    'hydra-ts/src/adapter-claude.ts\nhydra-ts/test/adapter-claude.test.ts';
  const readonly = overrides.read_only_paths ??
    'hydra/adapters/claude.sh';
  const acceptance = overrides.acceptance_criteria ??
    'port is faithful\ntests pass';

  function formatList(value: string): string {
    if (!value) return '';
    return value
      .split('\n')
      .map((line) => `  - ${line}`)
      .join('\n');
  }

  const content = [
    `task_id: ${taskId}`,
    `run_id: ${runId}`,
    `spec_version: ${specVersion}`,
    `branch: ${branch}`,
    `base_commit: ${baseCommit}`,
    'objective: >',
    `  ${objective}`,
    'writable_paths:',
    formatList(writable),
    'read_only_paths:',
    formatList(readonly),
    'acceptance_criteria:',
    formatList(acceptance),
    '',
  ].join('\n');
  writeFileSync(path, content, 'utf8');
}

interface RunnerResult {
  runner: CliRunner;
  calls: Array<{ command: string; args: string[]; cwd: string }>;
}

function makeRunner(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  sideEffect?: (cwd: string) => void;
}): RunnerResult {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: CliRunner = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (opts.sideEffect) {
      opts.sideEffect(options.cwd);
    }
    return {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exitCode: opts.exitCode ?? 0,
    };
  };
  return { runner, calls };
}

function setupFixture(
  overrides: Record<string, string> = {},
): {
  taskSpec: string;
  worktree: string;
  inbox: string;
  sessions: string;
} {
  const dir = makeTempDir('fixture');
  const worktree = join(dir, 'worktree');
  const inbox = join(dir, 'inbox');
  const sessions = join(dir, 'sessions');
  const taskSpec = join(dir, 'task.yaml');
  mkdirSync(worktree, { recursive: true });
  // Every fixture worktree is its own git repo so that git commands in the
  // adapter never traverse up into the enclosing Hydra repository.
  initGitRepo(worktree);
  const base = commitFile(worktree, 'anchor.txt', 'anchor');
  writeTaskSpec(taskSpec, { base_commit: base, ...overrides });
  return { taskSpec, worktree, inbox, sessions };
}

describe('adapter-claude', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('builds a worker prompt matching the retired build-worker-prompt.sh contract', () => {
    const dir = makeTempDir('prompt');
    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, {
      objective: 'Port the bash module.',
      writable_paths: 'src/a.ts\nsrc/b.ts',
      read_only_paths: 'scripts/lib.sh',
      acceptance_criteria: 'faithful\ntested',
    });

    const prompt = buildWorkerPrompt(taskSpec);

    assert.match(prompt, /branch: hydra\/0019\/adapter-claude/);
    assert.match(prompt, /base 71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070/);
    assert.match(prompt, /Objective: Port the bash module\./);
    assert.match(prompt, /- src\/a\.ts/);
    assert.match(prompt, /- src\/b\.ts/);
    assert.match(prompt, /- scripts\/lib\.sh/);
    assert.match(prompt, /- faithful/);
    assert.match(prompt, /- tested/);
    assert.match(prompt, /"vendor": "<claude\|codex>"/);
  });

  it('renders (none) for empty read_only_paths', () => {
    const dir = makeTempDir('prompt-empty');
    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec, { read_only_paths: '' });

    const prompt = buildWorkerPrompt(taskSpec);

    assert.match(prompt, /These paths are read-only context:\n  \(none\)/);
  });

  it('keeps an absent spec_version empty in the header and defaults only the JSON field', () => {
    const dir = makeTempDir('prompt-no-version');
    const taskSpec = join(dir, 'task.yaml');
    writeTaskSpec(taskSpec);
    const withoutVersion = readFileSync(taskSpec, 'utf8').replace(
      /^spec_version:.*\n/m,
      '',
    );
    writeFileSync(taskSpec, withoutVersion, 'utf8');

    const prompt = buildWorkerPrompt(taskSpec);

    assert.match(prompt, /## Task adapter-claude-test \(run 0019, spec v\)\n/);
    assert.match(prompt, /"spec_version": 1,/);
  });

  it('defaultRunCommand captures stderr when the child exits successfully', () => {
    const result = defaultRunCommand(
      process.execPath,
      [
        '-e',
        'process.stdout.write("ok"); process.stderr.write("warning\\n");',
      ],
      { cwd: process.cwd() },
    );

    assert.deepEqual(result, {
      stdout: 'ok',
      stderr: 'warning\n',
      exitCode: 0,
    });
  });

  it('defaultRunCommand returns captured output for a non-zero exit', () => {
    const result = defaultRunCommand(
      process.execPath,
      [
        '-e',
        'process.stdout.write("partial"); process.stderr.write("failed\\n"); process.exit(7);',
      ],
      { cwd: process.cwd() },
    );

    assert.deepEqual(result, {
      stdout: 'partial',
      stderr: 'failed\n',
      exitCode: 7,
    });
  });

  it('throws when required arguments are missing', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();

    assert.throws(
      () => claude('start', '', worktree, inbox, sessions, 'aid'),
      /usage: claude/,
    );
    assert.throws(
      () => claude('start', taskSpec, '', inbox, sessions, 'aid'),
      /usage: claude/,
    );
    assert.throws(
      () => claude('start', taskSpec, worktree, '', sessions, 'aid'),
      /usage: claude/,
    );
    assert.throws(
      () => claude('start', taskSpec, worktree, inbox, '', 'aid'),
      /usage: claude/,
    );
    assert.throws(
      () => claude('start', taskSpec, worktree, inbox, sessions, ''),
      /usage: claude/,
    );
  });

  it('throws on unknown verb', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();

    assert.throws(
      // @ts-expect-error — intentional invalid verb for test coverage.
      () => claude('stop', taskSpec, worktree, inbox, sessions, 'aid'),
      /unknown verb 'stop'/,
    );
  });

  it('fails the repository-context guard before creating paths or invoking claude', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const { runner, calls } = makeRunner({});

    assert.throws(
      () =>
        start(taskSpec, worktree, inbox, sessions, 'aid-no-repo', {
          exec: runner,
          repoRoot: () => {
            throw new Error('hydra: error: not inside a git repository');
          },
        }),
      /not inside a git repository/,
    );
    assert.equal(calls.length, 0);
    assert.equal(existsSync(inbox), false);
    assert.equal(existsSync(sessions), false);
  });

  it('start() invokes claude with print-mode args and captures session_id', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const { runner, calls } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-abc-123' }),
    });

    const returned = start(taskSpec, worktree, inbox, sessions, 'aid-123', {
      exec: runner,
    });

    assert.equal(returned, 'aid-123');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'claude');
    assert.ok(calls[0].args.includes('-p'));
    assert.ok(calls[0].args.includes('--output-format'));
    assert.ok(calls[0].args.includes('json'));
    assert.ok(calls[0].args.includes('--permission-mode'));
    assert.ok(calls[0].args.includes('bypassPermissions'));
    assert.ok(calls[0].args.includes('--add-dir'));
    assert.ok(calls[0].args.includes(resolve(worktree)));
    assert.equal(calls[0].cwd, resolve(worktree));

    const session = JSON.parse(
      readFileSync(join(sessions, 'aid-123.json'), 'utf8'),
    );
    assert.equal(session.agent_run_id, 'aid-123');
    assert.equal(session.vendor, 'claude');
    assert.equal(session.session_id, 'sess-abc-123');

    const cliJson = readFileSync(
      join(sessions, 'aid-123.cli.json'),
      'utf8',
    );
    assert.equal(cliJson, `${JSON.stringify({ session_id: 'sess-abc-123' })}`);
  });

  it('writes stderr to the sessions file', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const { runner } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-xyz' }),
      stderr: 'some warning\n',
      exitCode: 1,
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-stderr', { exec: runner });

    const stderr = readFileSync(
      join(sessions, 'aid-stderr.stderr'),
      'utf8',
    );
    assert.equal(stderr, 'some warning\n');
  });

  it('bridges a worker-written .hydra-result.json into the inbox', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const workerResult = {
      task_id: 'adapter-claude-test',
      run_id: '0019',
      spec_version: 1,
      vendor: 'should-be-overwritten',
      session_id: 'existing-sid',
      status: 'completed',
      branch: 'hydra/0019/adapter-claude',
      base_commit: '71bcbcf9acf0aeadc5d8eb5d1c0d3868b45b6070',
      head_commit: 'deadbeef',
      summary: 'worker self-report',
      files_changed: ['hydra-ts/src/adapter-claude.ts'],
      verification_claims: [{ command: 'npm test', status: 'passed' }],
      risks: [],
      unresolved_questions: [],
      suggested_additional_checks: [],
    };
    const { runner } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-bridge' }),
      sideEffect: (cwd) => {
        writeFileSync(
          join(cwd, '.hydra-result.json'),
          `${JSON.stringify(workerResult)}\n`,
        );
      },
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-bridge', { exec: runner });

    const result = JSON.parse(
      readFileSync(join(inbox, 'result.json'), 'utf8'),
    );
    assert.equal(result.vendor, 'claude');
    assert.equal(result.session_id, 'existing-sid');
    assert.equal(result.status, 'completed');
    assert.equal(result.head_commit, 'deadbeef');
    assert.deepEqual(result.files_changed, [
      'hydra-ts/src/adapter-claude.ts',
    ]);
  });

  it('fills in a missing session_id when bridging worker result', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const workerResult = {
      task_id: 'adapter-claude-test',
      status: 'completed',
      summary: 'done',
    };
    const { runner } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-fill' }),
      sideEffect: (cwd) => {
        writeFileSync(
          join(cwd, '.hydra-result.json'),
          `${JSON.stringify(workerResult)}\n`,
        );
      },
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-fill', { exec: runner });

    const result = JSON.parse(
      readFileSync(join(inbox, 'result.json'), 'utf8'),
    );
    assert.equal(result.vendor, 'claude');
    assert.equal(result.session_id, 'sess-fill');
  });

  it('preserves an empty worker-claimed session_id when bridging', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const workerResult = {
      task_id: 'adapter-claude-test',
      session_id: '',
      status: 'completed',
      summary: 'done',
    };
    const { runner } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-captured' }),
      sideEffect: (cwd) => {
        writeFileSync(
          join(cwd, '.hydra-result.json'),
          `${JSON.stringify(workerResult)}\n`,
        );
      },
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-empty-sid', {
      exec: runner,
    });

    const result = JSON.parse(
      readFileSync(join(inbox, 'result.json'), 'utf8'),
    );
    assert.equal(result.vendor, 'claude');
    assert.equal(result.session_id, '');
  });

  it('derives a drop from git evidence when worker commits without a self-report', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src/after.txt'), 'after', 'utf8');
    execFileSync('git', ['-C', worktree, 'add', 'src/after.txt'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    execFileSync('git', ['-C', worktree, 'commit', '-m', 'add after'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

    const { runner } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-git' }),
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-git', { exec: runner });

    const result = JSON.parse(
      readFileSync(join(inbox, 'result.json'), 'utf8'),
    );
    assert.equal(result.vendor, 'claude');
    assert.equal(result.session_id, 'sess-git');
    assert.equal(result.status, 'completed');
    assert.ok(Array.isArray(result.files_changed));
    assert.ok(result.files_changed.includes('src/after.txt'));
    assert.match(
      result.summary,
      /harness-derived from git/,
    );
  });

  it('suppresses worker and Git-derived completed drops for a structured Claude error', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    commitFile(worktree, 'src/old-head.txt', 'pre-existing head');
    const { runner } = makeRunner({
      stdout: JSON.stringify({
        type: 'result', subtype: 'success', is_error: true,
        api_error_status: 429,
        result: 'API Error: Usage credits required ...',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      sideEffect: (cwd) => writeFileSync(
        join(cwd, '.hydra-result.json'),
        JSON.stringify({ status: 'completed', summary: 'stale result' }),
      ),
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-quota', { exec: runner });

    const result = JSON.parse(readFileSync(join(inbox, 'result.json'), 'utf8'));
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /Claude API error/);
    assert.deepEqual(result.files_changed, []);
    const outcome = JSON.parse(readFileSync(join(sessions, 'aid-quota.outcome.json'), 'utf8'));
    assert.equal(outcome.kind, 'usage_limited');
  });

  it('synthesizes a failed drop when there is no result and no git advance', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();

    const { runner } = makeRunner({ stdout: '' });

    start(taskSpec, worktree, inbox, sessions, 'aid-fail', { exec: runner });

    const result = JSON.parse(
      readFileSync(join(inbox, 'result.json'), 'utf8'),
    );
    assert.equal(result.vendor, 'claude');
    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Claude API error: malformed Claude JSON result envelope');
    assert.deepEqual(result.files_changed, []);
    assert.ok(result.risks.includes('adapter synthesized a failed drop'));
  });

  it('resume() passes --resume with the prior session id', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const { runner, calls } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-resume' }),
    });

    resume(
      taskSpec,
      worktree,
      inbox,
      sessions,
      'aid-resume',
      'prior-sess-789',
      { exec: runner },
    );

    const resumeIdx = calls[0].args.indexOf('--resume');
    assert.notEqual(resumeIdx, -1);
    assert.equal(calls[0].args[resumeIdx + 1], 'prior-sess-789');

    const session = JSON.parse(
      readFileSync(join(sessions, 'aid-resume.json'), 'utf8'),
    );
    assert.equal(session.session_id, 'sess-resume');
  });

  it('start() does not pass --resume', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const { runner, calls } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-start' }),
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-start-only', {
      exec: runner,
    });

    assert.ok(!calls[0].args.includes('--resume'));
  });

  it('removes any stale .hydra-result.json before running the worker', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    const stale = join(worktree, '.hydra-result.json');
    writeFileSync(stale, '{"stale":true}\n', 'utf8');

    const { runner } = makeRunner({
      stdout: JSON.stringify({ session_id: 'sess-clean' }),
      sideEffect: (cwd) => {
        // Worker would write a fresh result after the adapter cleaned the stale one.
        writeFileSync(
          join(cwd, '.hydra-result.json'),
          '{"status":"completed","summary":"fresh"}\n',
        );
      },
    });

    start(taskSpec, worktree, inbox, sessions, 'aid-clean', { exec: runner });

    const result = JSON.parse(
      readFileSync(join(inbox, 'result.json'), 'utf8'),
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.summary, 'fresh');
  });

  it('uses the injected exec runner instead of the real claude CLI', () => {
    const { taskSpec, worktree, inbox, sessions } = setupFixture();
    let invoked = false;
    const runner: CliRunner = (command, args, options) => {
      assert.equal(command, 'claude');
      assert.ok(args.includes('-p'));
      assert.equal(options.cwd, resolve(worktree));
      invoked = true;
      return {
        stdout: JSON.stringify({ session_id: 'sess-mock' }),
        stderr: '',
        exitCode: 0,
      };
    };

    start(taskSpec, worktree, inbox, sessions, 'aid-mock', { exec: runner });

    assert.equal(invoked, true);
    const result = JSON.parse(
      readFileSync(join(inbox, 'result.json'), 'utf8'),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.vendor, 'claude');
  });
});

describe('worker prompt parity (issue #26)', () => {
  it('renders the shared amendment + revision-evidence contract byte-for-byte', async () => {
    const { mkdtempSync, mkdirSync: makeDir, writeFileSync: writeF, rmSync: removeR } = await import('node:fs');
    const { tmpdir: osTmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { resolveRevisionEvidence, materializeRevisionEvidence } = await import('../src/revision-evidence.ts');
    const { buildWorkerPrompt: buildSharedPrompt } = await import('../src/build-worker-prompt.ts');
    const { buildWorkerPrompt: adapterPrompt } = await import('../src/adapter-claude.ts');

    const dir = mkdtempSync(joinPath(osTmpdir(), 'hydra-parity-claude-'));
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
