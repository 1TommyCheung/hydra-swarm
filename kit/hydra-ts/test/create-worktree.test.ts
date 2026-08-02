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

function createGitRepo(name: string, extraFiles: Record<string, string> = {}): RepoFixture {
  const repoRoot = join(TEST_TMP, 'repos', name);
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), `# ${name}\n`, 'utf8');
  for (const [relative, content] of Object.entries(extraFiles)) {
    writeFileSync(join(repoRoot, relative), content, 'utf8');
  }
  execFileSync('git', ['add', '-A', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  // Every fixture repo gets a harmless bootstrap policy of its own. The
  // implementation now resolves the policy the way kitAssetPath() does and
  // falls back to the real checkout's policy when the fixture repo has none —
  // without this, unrelated tests would execute this repo's actual bootstrap
  // steps (including the wave_1 gitnexus index, since the checkout's WAVE is 2).
  writeBootstrapPolicy(repoRoot, ['true'], ['true']);
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
  const dir = join(repoRoot, 'kit', 'hydra', 'policies');
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

    const mockExec = ((
      command: string,
      args: string[] = [],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'git' && args.includes('worktree') && args.includes('add')) {
        throw new Error('raw child-process failure');
      }
      return execFileSync(command, args, options);
    }) as typeof execFileSync;

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

  function recordedBootstrapSteps(
    repoRoot: string,
    runId: string,
    taskId: string,
    headCommit: string,
  ): string[] {
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);
    const steps: string[] = [];
    const mockExec = ((
      command: string,
      args: string[] = [],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'bash') {
        steps.push(args[1] ?? '');
        return '';
      }
      return execFileSync(command, args, options);
    }) as typeof execFileSync;

    createWorktree(runId, taskId, undefined, { repoRoot, exec: mockExec });
    return steps;
  }

  it('runs the dev-checkout kit/hydra/policies bootstrap policy', () => {
    const { repoRoot, headCommit } = createGitRepo('bootstrap-path-dev');
    writeBootstrapPolicy(repoRoot, ['echo dev_checkout_step'], []);

    const steps = recordedBootstrapSteps(repoRoot, 'bootstrap-path-dev', 'task-dev', headCommit);

    assert.ok(
      steps.some((step) => step.includes('dev_checkout_step')),
      'expected the common step from kit/hydra/policies/bootstrap.yaml to execute',
    );
  });

  it('prefers the installed-plugin hydra/policies layout over kit/hydra/policies', () => {
    // Regression for issue #38: the old hardcoded
    // join(repoRoot, 'kit', 'hydra', 'policies', 'bootstrap.yaml') never
    // resolved in an installed-plugin layout, where the kit lives at
    // <repo>/hydra/... — bootstrap silently became a total no-op there. The
    // policy is now resolved with kitAssetPath()'s candidates and order
    // (installed layout first, dev checkout second), matching how promote.ts
    // resolves policies/verification.yaml.
    const { repoRoot, headCommit } = createGitRepo('bootstrap-path-installed');
    writeBootstrapPolicy(repoRoot, ['echo dev_checkout_step'], []);

    const installedDir = join(repoRoot, 'hydra', 'policies');
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, 'bootstrap.yaml'),
      'bootstrap:\n  common:\n    - "echo installed_layout_step"\n',
      'utf8',
    );

    const steps = recordedBootstrapSteps(
      repoRoot,
      'bootstrap-path-installed',
      'task-installed',
      headCommit,
    );

    assert.ok(
      steps.some((step) => step.includes('installed_layout_step')),
      'expected the installed-layout hydra/policies/bootstrap.yaml to execute',
    );
    assert.ok(
      !steps.some((step) => step.includes('dev_checkout_step')),
      'did not expect kit/hydra/policies to win over the installed layout',
    );
  });

  it('fails loudly when a lockfile is present but bootstrap left no node_modules', () => {
    // Issue #38: every step exited 0, so worktree_bootstrapped status=ok was
    // appended for a worktree that never got its dependencies; the worker then
    // silently substituted a weaker check for its mandated verification.
    const { repoRoot, headCommit } = createGitRepo('bootstrap-no-node-modules', {
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    });
    writeBootstrapPolicy(repoRoot, ['true'], []);

    const runId = 'bootstrap-no-node-modules';
    const taskId = 'task-no-node-modules';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const worktree = join(process.env.HYDRA_WORKTREE_ROOT!, `run-${runId}-${taskId}`);
    assert.throws(
      () => createWorktree(runId, taskId, undefined, { repoRoot }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /bootstrap incomplete for task-no-node-modules/);
        assert.ok(error.message.includes(worktree), 'message must name the worktree');
        assert.match(error.message, /node_modules is missing/);
        return true;
      },
    );

    const bootstrapped = readLedgerEvents(runId).find((e) => e.event === 'worktree_bootstrapped');
    assert.ok(bootstrapped);
    assert.notEqual(bootstrapped.status, 'ok');
  });

  it('reports the failing install command and its error when a bootstrap step exits nonzero', () => {
    // Companion to the case above: there the install exits 0 and leaves no
    // node_modules; here the install itself fails. runBootstrapSteps() used to
    // collapse ANY step failure to `false`, so this path died with only the
    // generic "bootstrap failed for <task>" and discarded which command failed
    // and why. The failure detail must now be as specific as the other case.
    const { repoRoot, headCommit } = createGitRepo('bootstrap-install-fails', {
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    });
    const installStep = 'test -f pnpm-lock.yaml && pnpm install --frozen-lockfile';
    writeBootstrapPolicy(repoRoot, [installStep], []);

    const runId = 'bootstrap-install-fails';
    const taskId = 'task-install-fails';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    // A failing `pnpm` stand-in, injected through the exec override the sibling
    // bootstrap tests already use; the shape mirrors an execFileSync rejection.
    const stderrText = 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile';
    const mockExec = ((
      command: string,
      args: string[] = [],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'bash' && (args[1] ?? '').includes('pnpm install')) {
        const failure = new Error(`Command failed: bash -c ${args[1]}`) as Error & {
          status?: number;
          stderr?: string;
        };
        failure.status = 1;
        failure.stderr = stderrText;
        throw failure;
      }
      return execFileSync(command, args, options);
    }) as typeof execFileSync;

    const worktree = join(process.env.HYDRA_WORKTREE_ROOT!, `run-${runId}-${taskId}`);
    assert.throws(
      () => createWorktree(runId, taskId, undefined, { repoRoot, exec: mockExec }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message !== `bootstrap failed for ${taskId}`,
          'the generic message must not be all the operator gets',
        );
        assert.ok(error.message.includes(worktree), 'message must name the worktree');
        assert.ok(
          error.message.includes('pnpm install --frozen-lockfile'),
          'message must name the failed command',
        );
        assert.ok(error.message.includes(stderrText), 'message must carry the underlying error');
        assert.match(error.message, /exit status 1/);
        return true;
      },
    );

    const bootstrapped = readLedgerEvents(runId).find((e) => e.event === 'worktree_bootstrapped');
    assert.ok(bootstrapped);
    assert.equal(bootstrapped.status, 'failed');
    assert.match(String(bootstrapped.detail), /pnpm install --frozen-lockfile/);
    assert.match(String(bootstrapped.detail), /ERR_PNPM_OUTDATED_LOCKFILE/);
  });

  it('accepts a lockfile-present worktree once bootstrap produced node_modules', () => {
    const { repoRoot, headCommit } = createGitRepo('bootstrap-node-modules-ok', {
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    });
    writeBootstrapPolicy(repoRoot, ['mkdir -p node_modules'], []);

    const runId = 'bootstrap-node-modules-ok';
    const taskId = 'task-node-modules-ok';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const worktree = createWorktree(runId, taskId, undefined, { repoRoot });

    assert.ok(existsSync(join(worktree, 'node_modules')));
    const bootstrapped = readLedgerEvents(runId).find((e) => e.event === 'worktree_bootstrapped');
    assert.equal(bootstrapped?.status, 'ok');
  });

  it('does not require node_modules when the repo has no lockfile', () => {
    // The no-lockfile case must behave exactly as before the node_modules
    // assertion existed: nothing to install, nothing to check.
    const { repoRoot, headCommit } = createGitRepo('bootstrap-no-lockfile');
    writeBootstrapPolicy(repoRoot, ['true'], []);

    const runId = 'bootstrap-no-lockfile';
    const taskId = 'task-no-lockfile';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const worktree = createWorktree(runId, taskId, undefined, { repoRoot });

    assert.ok(!existsSync(join(worktree, 'node_modules')));
    const bootstrapped = readLedgerEvents(runId).find((e) => e.event === 'worktree_bootstrapped');
    assert.equal(bootstrapped?.status, 'ok');
  });

  it('shipped bootstrap policy no-ops without a lockfile and propagates install failure', () => {
    // The tracked policy's install step must stay a no-op when there is no
    // lockfile (no new failure mode for repos without one) while no longer
    // swallowing a real install failure behind `|| true`.
    const policy = resolve(import.meta.dirname, '..', '..', 'hydra', 'policies', 'bootstrap.yaml');
    const step = readFileSync(policy, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('- "') && line.includes('pnpm install'));
    assert.ok(step, 'expected a pnpm install step in the shipped bootstrap policy');
    assert.ok(!step.includes('|| true'), 'the install step must not swallow failures');

    const command = step.slice(3, step.lastIndexOf('"'));
    const noLockfileDir = join(TEST_TMP, 'shipped-policy-no-lockfile');
    mkdirSync(noLockfileDir, { recursive: true });
    // Exits 0 with no lockfile present; `pnpm` is never invoked.
    execFileSync('bash', ['-c', command], { cwd: noLockfileDir, stdio: 'ignore' });

    const failingDir = join(TEST_TMP, 'shipped-policy-install-fails');
    mkdirSync(failingDir, { recursive: true });
    writeFileSync(join(failingDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    const fakeBin = join(failingDir, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'pnpm'), '#!/usr/bin/env bash\nexit 7\n', { mode: 0o755 });
    assert.throws(
      () => execFileSync('bash', ['-c', command], {
        cwd: failingDir,
        stdio: 'ignore',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      }),
      /Command failed|status 7/,
    );
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

    // A failed bootstrap still records a ledger event — now carrying the step
    // that failed, from a real (unmocked) nonzero exit.
    const events = readLedgerEvents(runId);
    const bootstrapped = events.find((e) => e.event === 'worktree_bootstrapped');
    assert.ok(bootstrapped);
    assert.equal(bootstrapped.status, 'failed');
    assert.match(String(bootstrapped.detail), /bootstrap step failed \(common\): `false`/);
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
    const mockExec = ((
      command: string,
      args: string[] = [],
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
    }) as typeof execFileSync;

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
    mkdirSync(join(repoRoot, 'hydra'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'hydra', 'WAVE'),
      realWaveRunsWave1 ? '0\n' : '2\n',
      'utf8',
    );

    const runId = 'wave-file';
    const taskId = 'task-wave-file';
    writeTaskSpec(runId, taskId, `task_id: ${taskId}\nrun_id: ${runId}\nbase_commit: ${headCommit}\n`);

    const wave1Steps: string[] = [];
    const mockExec = ((
      command: string,
      args: string[] = [],
      options?: ExecFileSyncOptions,
    ): string | Buffer => {
      if (command === 'bash') {
        const script = args[1] ?? '';
        if (script.includes('wave_1')) wave1Steps.push(script);
        return '';
      }
      return execFileSync(command, args, options);
    }) as typeof execFileSync;

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
    const mockExec = ((
      command: string,
      args: string[] = [],
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
    }) as typeof execFileSync;

    createWorktree(runId, taskId, undefined, {
      repoRoot,
      exec: mockExec,
      env: { HYDRA_WAVE: '0' },
    });

    assert.equal(wave1Steps.length, 0);
  });
});
