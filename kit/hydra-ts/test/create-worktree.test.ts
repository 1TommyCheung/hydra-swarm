import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createWorktree } from '../src/create-worktree.ts';
import { ledger, yamlScalar } from '../src/lib.ts';

const TEST_TMP = join(tmpdir(), 'hydra-create-worktree-test');

const ORIGINAL_HYDRA_STATE_ROOT = process.env.HYDRA_STATE_ROOT;
const ORIGINAL_HYDRA_WORKTREE_ROOT = process.env.HYDRA_WORKTREE_ROOT;
const ORIGINAL_HYDRA_REPO_ID = process.env.HYDRA_REPO_ID;
const ORIGINAL_HYDRA_WAVE = process.env.HYDRA_WAVE;

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupEnv(): void {
  process.env.HYDRA_STATE_ROOT = join(TEST_TMP, 'state');
  process.env.HYDRA_WORKTREE_ROOT = join(TEST_TMP, 'worktrees');
  process.env.HYDRA_REPO_ID = 'test-repo';
  delete process.env.HYDRA_WAVE;
}

function restoreEnv(): void {
  if (ORIGINAL_HYDRA_STATE_ROOT === undefined) {
    delete process.env.HYDRA_STATE_ROOT;
  } else {
    process.env.HYDRA_STATE_ROOT = ORIGINAL_HYDRA_STATE_ROOT;
  }
  if (ORIGINAL_HYDRA_WORKTREE_ROOT === undefined) {
    delete process.env.HYDRA_WORKTREE_ROOT;
  } else {
    process.env.HYDRA_WORKTREE_ROOT = ORIGINAL_HYDRA_WORKTREE_ROOT;
  }
  if (ORIGINAL_HYDRA_REPO_ID === undefined) {
    delete process.env.HYDRA_REPO_ID;
  } else {
    process.env.HYDRA_REPO_ID = ORIGINAL_HYDRA_REPO_ID;
  }
  if (ORIGINAL_HYDRA_WAVE === undefined) {
    delete process.env.HYDRA_WAVE;
  } else {
    process.env.HYDRA_WAVE = ORIGINAL_HYDRA_WAVE;
  }
}

interface RepoFixture {
  repoRoot: string;
  headCommit: string;
}

function createGitRepo(name: string): RepoFixture {
  const repoRoot = join(TEST_TMP, 'repos', name);
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), `# ${name}\n`, 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  return { repoRoot, headCommit };
}

function writeTaskSpec(
  runId: string,
  taskId: string,
  content: string,
): string {
  const dir = join(process.env.HYDRA_STATE_ROOT!, 'runs', `run-${runId}`, 'tasks');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId}.yaml`);
  writeFileSync(path, content, 'utf8');
  return path;
}

function writeBootstrapPolicy(
  repoRoot: string,
  common: string[],
  wave1: string[],
): void {
  const dir = join(repoRoot, 'hydra', 'policies');
  mkdirSync(dir, { recursive: true });
  const lines = ['bootstrap:'];
  lines.push('  common:');
  for (const step of common) lines.push(`    - "${step}"`);
  // Insert a top-level separator so the naive YAML list parser stops reading
  // common items before the wave_1 block. This matches how the parser behaves
  // when keys are separated by a column-0 line.
  lines.push('__wave_1_block__:');
  lines.push('  wave_1:');
  for (const step of wave1) lines.push(`    - "${step}"`);
  writeFileSync(join(dir, 'bootstrap.yaml'), `${lines.join('\n')}\n`, 'utf8');
}

function readLedgerEvents(runId: string): Record<string, unknown>[] {
  const content = readFileSync(ledger(runId), 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expectedPortFromCksum(runId: string, taskId: string): number {
  const output = execFileSync('cksum', [], {
    input: `${runId}/${taskId}`,
    encoding: 'utf8',
  });
  const checksum = Number.parseInt(output.split(/\s+/)[0], 10);
  return 20000 + (checksum % 20000);
}

function readAllocatedPort(runId: string, taskId: string): number {
  const content = readFileSync(
    join(process.env.HYDRA_WORKTREE_ROOT!, `run-${runId}-${taskId}`, '.env.worktree'),
    'utf8',
  ).trim();
  return Number.parseInt(content.slice('PORT='.length), 10);
}

describe('createWorktree', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    setupEnv();
  });

  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('throws when runId is empty', () => {
    assert.throws(() => createWorktree('', 't1'), /usage: create-worktree.ts/);
  });

  it('throws when taskId is empty', () => {
    assert.throws(() => createWorktree('0018', ''), /usage: create-worktree.ts/);
  });

  it('throws when the task spec is missing', () => {
    assert.throws(
      () => createWorktree('0018', 'missing', undefined, { repoRoot: '/dev/null' }),
      /instantiated task spec not found/,
    );
  });

  it('throws when the worktree path already exists', () => {
    const { repoRoot, headCommit } = createGitRepo('exists');
    const runId = 'exists';
    const taskId = 'task-exists';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const worktree = join(process.env.HYDRA_WORKTREE_ROOT!, `run-${runId}-${taskId}`);
    mkdirSync(worktree, { recursive: true });

    assert.throws(
      () => createWorktree(runId, taskId, undefined, { repoRoot }),
      /worktree path already exists/,
    );
  });

  it('reports a clean error when git worktree add fails', () => {
    const { repoRoot, headCommit } = createGitRepo('git-add-fail');
    const runId = 'git-add-fail';
    const taskId = 'task-git-add-fail';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const mockExec = (
      command: string,
      args: string[],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'git' && args.includes('worktree') && args.includes('add')) {
        throw new Error('raw child-process failure');
      }
      return execFileSync(command, args, options);
    };

    assert.throws(
      () => createWorktree(runId, taskId, undefined, { repoRoot, exec: mockExec }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'hydra: error: git worktree add failed');
        return true;
      },
    );
  });

  it('creates the worktree and stamps the spec', () => {
    const { repoRoot, headCommit } = createGitRepo('happy');
    const runId = '0018';
    const taskId = 'create-worktree';
    const specPath = writeTaskSpec(
      runId,
      taskId,
      `task_id: ${taskId}\nrun_id: ${runId}\nspec_version: 1\nbase_commit: ${headCommit}\n`,
    );

    const worktree = createWorktree(runId, taskId, undefined, { repoRoot });

    assert.equal(worktree, join(process.env.HYDRA_WORKTREE_ROOT!, `run-${runId}-${taskId}`));
    assert.ok(existsSync(worktree));
    assert.ok(existsSync(join(worktree, '.git')));

    // Branch was created.
    const branches = execFileSync('git', ['-C', repoRoot, 'branch', '--list', `hydra/${runId}/${taskId}`], {
      encoding: 'utf8',
    }).trim();
    assert.ok(branches.includes(`hydra/${runId}/${taskId}`));

    // Exclude file contains harness-injected paths.
    const excludePath = execFileSync('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
    }).trim();
    const excludeContent = readFileSync(excludePath, 'utf8');
    assert.ok(excludeContent.includes('.hydra-task.yaml'));
    assert.ok(excludeContent.includes('.env.worktree'));
    assert.ok(excludeContent.includes('.hydra-result.json'));
    assert.ok(excludeContent.includes('.gitnexus/'));

    // Read-only spec copy.
    const copiedSpec = join(worktree, '.hydra-task.yaml');
    assert.ok(existsSync(copiedSpec));
    const mode = statSync(copiedSpec).mode & 0o777;
    assert.equal(mode, 0o444);

    // PORT env file.
    const envContent = readFileSync(join(worktree, '.env.worktree'), 'utf8');
    assert.match(envContent, /^PORT=\d+\n$/);

    // Operational fields stamped into the instantiated spec.
    assert.equal(yamlScalar(specPath, 'worktree'), worktree);
    assert.equal(yamlScalar(specPath, 'branch'), `hydra/${runId}/${taskId}`);
    assert.equal(yamlScalar(specPath, 'base_commit'), headCommit);

    // Ledger event.
    const events = readLedgerEvents(runId);
    const bootstrapped = events.find((e) => e.event === 'worktree_bootstrapped');
    assert.ok(bootstrapped);
    assert.equal(bootstrapped.task_id, taskId);
    assert.equal(bootstrapped.status, 'ok');
    assert.equal(bootstrapped.worktree, worktree);
    assert.equal(bootstrapped.port, envContent.trim().slice('PORT='.length));
  });

  it('defaults base_commit to HEAD when not provided and not in spec', () => {
    const { repoRoot, headCommit } = createGitRepo('default-base');
    const runId = 'default-base';
    const taskId = 'task-default';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\n`);

    const worktree = createWorktree(runId, taskId, undefined, { repoRoot });

    const worktreeHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(worktreeHead, headCommit);
  });

  it('uses an explicit base_commit override', () => {
    const { repoRoot } = createGitRepo('explicit-base');
    // Create two more commits so HEAD~1 differs from HEAD.
    writeFileSync(join(repoRoot, 'second.md'), 'second\n', 'utf8');
    execFileSync('git', ['add', 'second.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'third.md'), 'third\n', 'utf8');
    execFileSync('git', ['add', 'third.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-m', 'third'], { cwd: repoRoot });

    const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const overrideCommit = execFileSync('git', ['rev-parse', 'HEAD~1'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    assert.notEqual(overrideCommit, headCommit);

    const runId = 'explicit-base';
    const taskId = 'task-explicit';
    const specPath = writeTaskSpec(
      runId,
      taskId,
      `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: placeholder\n`,
    );

    createWorktree(runId, taskId, overrideCommit, { repoRoot });

    assert.equal(yamlScalar(specPath, 'base_commit'), overrideCommit);
  });

  it('prints the worktree path followed by a newline', () => {
    const { repoRoot, headCommit } = createGitRepo('stdout');
    const runId = 'stdout';
    const taskId = 'task-stdout';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const worktree = createWorktree(runId, taskId, undefined, { repoRoot });
      assert.equal(chunks.join(''), `${worktree}\n`);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('allocates deterministic ports for run+task identifiers', () => {
    const { repoRoot, headCommit } = createGitRepo('port');
    const runId = 'port-run';
    const taskId = 'port-task';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    createWorktree(runId, taskId, undefined, { repoRoot });
    const firstPort = readFileSync(
      join(process.env.HYDRA_WORKTREE_ROOT!, `run-${runId}-${taskId}`, '.env.worktree'),
      'utf8',
    ).trim();

    // A different task gets a different port.
    const otherTaskId = 'other-task';
    writeTaskSpec(
      runId,
      otherTaskId,
      `task_id: ${otherTaskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`,
    );
    createWorktree(runId, otherTaskId, undefined, { repoRoot });
    const otherPort = readFileSync(
      join(process.env.HYDRA_WORKTREE_ROOT!, `run-${runId}-${otherTaskId}`, '.env.worktree'),
      'utf8',
    ).trim();

    assert.notEqual(firstPort, otherPort);
    assert.match(firstPort, /^PORT=\d+$/);
    assert.match(otherPort, /^PORT=\d+$/);
  });

  it('matches the real POSIX cksum binary when allocating an ASCII port', () => {
    const { repoRoot, headCommit } = createGitRepo('port-cksum-ascii');
    // cksum("run/task") exceeds 2^31, covering unsigned CRC handling too.
    const runId = 'run';
    const taskId = 'task';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    createWorktree(runId, taskId, undefined, { repoRoot });

    assert.equal(readAllocatedPort(runId, taskId), expectedPortFromCksum(runId, taskId));
  });

  it('matches POSIX cksum byte semantics for non-ASCII identifiers', () => {
    const { repoRoot, headCommit } = createGitRepo('port-cksum-unicode');
    const runId = 'rún-雪';
    const taskId = 'tâsk-界';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    createWorktree(runId, taskId, undefined, { repoRoot });

    assert.equal(readAllocatedPort(runId, taskId), expectedPortFromCksum(runId, taskId));
  });

  it('dies when bootstrap common steps fail', () => {
    const { repoRoot, headCommit } = createGitRepo('bootstrap-fail');
    writeBootstrapPolicy(repoRoot, ['false'], []);

    const runId = 'bootstrap-fail';
    const taskId = 'task-fail';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    assert.throws(
      () => createWorktree(runId, taskId, undefined, { repoRoot }),
      /bootstrap failed/,
    );

    // A failed bootstrap still records a ledger event.
    const events = readLedgerEvents(runId);
    const bootstrapped = events.find((e) => e.event === 'worktree_bootstrapped');
    assert.ok(bootstrapped);
    assert.equal(bootstrapped.status, 'failed');
  });

  it('runs wave_1 bootstrap steps when wave level is >= 1', () => {
    const { repoRoot, headCommit } = createGitRepo('wave1');
    writeBootstrapPolicy(repoRoot, ['true'], ['echo wave_1_step']);

    const runId = 'wave1';
    const taskId = 'task-wave1';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const wave1Steps: string[] = [];
    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write;
    const mockExec = (
      command: string,
      args: string[],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'bash') {
        const script = args[1] ?? '';
        if (script.includes('wave_1')) {
          wave1Steps.push(script);
        }
        return '';
      }
      return execFileSync(command, args, options);
    };

    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      createWorktree(runId, taskId, undefined, {
        repoRoot,
        exec: mockExec,
        env: { HYDRA_WAVE: '1' },
      });
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    assert.ok(wave1Steps.length > 0);
    assert.match(
      stderrChunks.join(''),
      /wave_1 bootstrap steps executed \(wave level 1\)/,
    );
  });

  it('reads the wave level from the self-relative hydra/WAVE when HYDRA_WAVE is unset', () => {
    const { repoRoot, headCommit } = createGitRepo('wave-file');
    writeBootstrapPolicy(repoRoot, ['true'], ['echo wave_1_step']);

    // Read the self-relative WAVE file that the implementation resolves to.
    const selfRelativeWave = resolve(
      import.meta.dirname,
      '..',
      '..',
      'hydra',
      'WAVE',
    );
    const realWaveLevel = existsSync(selfRelativeWave)
      ? Number.parseInt(readFileSync(selfRelativeWave, 'utf8').trim(), 10)
      : 0;
    const realWaveRunsWave1 = Number.isFinite(realWaveLevel) && realWaveLevel >= 1;

    // Deliberately write the opposite value in the provided repoRoot so that
    // repoRoot-based resolution would produce a different result than the
    // self-relative resolution.
    writeFileSync(
      join(repoRoot, 'hydra', 'WAVE'),
      realWaveRunsWave1 ? '0\n' : '2\n',
      'utf8',
    );

    const runId = 'wave-file';
    const taskId = 'task-wave-file';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const wave1Steps: string[] = [];
    const mockExec = (
      command: string,
      args: string[],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'bash') {
        const script = args[1] ?? '';
        if (script.includes('wave_1')) wave1Steps.push(script);
        return '';
      }
      return execFileSync(command, args, options);
    };

    createWorktree(runId, taskId, undefined, { repoRoot, exec: mockExec });

    if (realWaveRunsWave1) {
      assert.ok(
        wave1Steps.length > 0,
        'expected wave_1 steps to run because self-relative WAVE >= 1',
      );
    } else {
      assert.equal(
        wave1Steps.length,
        0,
        'expected no wave_1 steps because self-relative WAVE == 0',
      );
    }
  });

  it('does not run wave_1 bootstrap steps when wave level is 0', () => {
    const { repoRoot, headCommit } = createGitRepo('wave0');
    writeBootstrapPolicy(repoRoot, ['true'], ['echo wave_1_step']);

    const runId = 'wave0';
    const taskId = 'task-wave0';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const wave1Steps: string[] = [];
    const mockExec = (
      command: string,
      args: string[],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'bash') {
        const script = args[1] ?? '';
        if (script.includes('wave_1')) {
          wave1Steps.push(script);
        }
        return '';
      }
      return execFileSync(command, args, options);
    };

    createWorktree(runId, taskId, undefined, {
      repoRoot,
      exec: mockExec,
      env: { HYDRA_WAVE: '0' },
    });

    assert.equal(wave1Steps.length, 0);
  });
});
