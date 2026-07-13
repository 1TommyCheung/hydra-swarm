import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultRunCommand,
  verify,
  type CommandRunner,
  type VerifyOptions,
} from '../src/verify.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-verify');
const ORIGINAL_EXIT_CODE = process.exitCode;

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setupFixture(runId: string): { worktree: string; policy: string } {
  const dir = join(TEST_TMP, runId);
  const worktree = join(dir, 'worktree');
  const policy = join(dir, 'policy.yaml');
  mkdirSync(worktree, { recursive: true });
  return { worktree, policy };
}

function writePolicy(policy: string, content: string): void {
  writeFileSync(policy, content, 'utf8');
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sequentialRunner(
  responses: Array<{ exitCode: number | null; signal?: string | null }>,
): CommandRunner {
  let index = 0;
  return (_command, _worktree, _timeoutSec, _env) => {
    const response = responses[index++] ?? { exitCode: 0, signal: null };
    return { exitCode: response.exitCode, signal: response.signal ?? null };
  };
}

describe('verify', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    cleanTmp();
    delete process.env.HYDRA_TEST_TIMEOUT_SEC;
    process.exitCode = ORIGINAL_EXIT_CODE;
  });

  it('throws when worktree or policy is missing', async () => {
    const { worktree } = setupFixture(makeRunId());
    const missingPolicy = join(worktree, 'missing.yaml');

    await assert.rejects(verify('', 'policy.yaml'), /usage: verify/);
    await assert.rejects(verify(worktree, ''), /usage: verify/);
    await assert.rejects(verify(worktree, missingPolicy), /policy not found/);

    const missingWorktree = join(TEST_TMP, 'no-such-worktree');
    await assert.rejects(
      verify(missingWorktree, missingPolicy),
      /worktree not found/,
    );
  });

  it('exits 1 for an uncaught usage error, matching hydra_die', () => {
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, '../src/verify.ts'),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `import { verify } from ${JSON.stringify(moduleUrl)}; await verify('', 'policy.yaml');`,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(child.status, 1);
    assert.match(child.stderr, /usage: verify/);
  });

  it('requires a directory worktree and a regular policy file', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    const fileWorktree = join(worktree, 'not-a-directory');
    const directoryPolicy = join(worktree, 'policy-directory');
    writeFileSync(fileWorktree, '', 'utf8');
    mkdirSync(directoryPolicy);
    writePolicy(policy, 'commands:\n  - true\n');

    await assert.rejects(verify(fileWorktree, policy), /worktree not found/);
    await assert.rejects(verify(worktree, directoryPolicy), /policy not found/);
  });

  it('throws when the policy contains no commands', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(policy, 'timeout_minutes: 5\n');

    await assert.rejects(
      verify(worktree, policy),
      /no verification commands in policy/,
    );
  });

  it('reads commands from the nested verification_policy.commands key', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `verification_policy:
  commands:
    - echo one
    - echo two
`,
    );

    const exec = sequentialRunner([{ exitCode: 0 }, { exitCode: 0 }]);
    const { output, result } = await captureStdout(() =>
      verify(worktree, policy, undefined, { exec }),
    );

    assert.equal(
      JSON.stringify(result),
      JSON.stringify([
        { command: 'echo one', status: 'passed' },
        { command: 'echo two', status: 'passed' },
      ]),
    );
    assert.equal(output.trim(), JSON.stringify(result));
  });

  it('resolves paths containing spaces and URL-special characters', async () => {
    const { worktree, policy } = setupFixture(`space # percent% ${makeRunId()}`);
    writePolicy(policy, 'commands:\n  - true\n');

    let capturedWorktree = '';
    const exec: CommandRunner = (_command, candidateWorktree) => {
      capturedWorktree = candidateWorktree;
      return { exitCode: 0, signal: null };
    };
    const result = await verify(worktree, policy, undefined, { exec });

    assert.deepEqual(result, [{ command: 'true', status: 'passed' }]);
    assert.equal(capturedWorktree, worktree);
  });

  it('falls back to a top-level commands key', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - top one
  - top two
`,
    );

    const exec = sequentialRunner([{ exitCode: 0 }, { exitCode: 0 }]);
    const result = await verify(worktree, policy, undefined, { exec });

    assert.deepEqual(
      result.map((r) => r.command),
      ['top one', 'top two'],
    );
  });

  it('prefers the nested key over the top-level key', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - ignored
verification_policy:
  commands:
    - nested
`,
    );

    const exec = sequentialRunner([{ exitCode: 0 }]);
    const result = await verify(worktree, policy, undefined, { exec });

    assert.deepEqual(
      result.map((r) => r.command),
      ['nested'],
    );
  });

  it('defaults timeout to 15 minutes', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - echo hi
`,
    );

    let capturedTimeout = 0;
    const exec: CommandRunner = (_cmd, _wt, timeoutSec, _env) => {
      capturedTimeout = timeoutSec;
      return { exitCode: 0, signal: null };
    };
    await verify(worktree, policy, undefined, { exec });

    assert.equal(capturedTimeout, 15 * 60);
  });

  it('reads timeout_minutes from the policy', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `verification_policy:
  timeout_minutes: 7
  commands:
    - echo hi
`,
    );

    let capturedTimeout = 0;
    const exec: CommandRunner = (_cmd, _wt, timeoutSec, _env) => {
      capturedTimeout = timeoutSec;
      return { exitCode: 0, signal: null };
    };
    await verify(worktree, policy, undefined, { exec });

    assert.equal(capturedTimeout, 7 * 60);
  });

  it('falls back to a top-level timeout_minutes key', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `timeout_minutes: 3
commands:
  - echo hi
`,
    );

    let capturedTimeout = 0;
    const exec: CommandRunner = (_cmd, _wt, timeoutSec, _env) => {
      capturedTimeout = timeoutSec;
      return { exitCode: 0, signal: null };
    };
    await verify(worktree, policy, undefined, { exec });

    assert.equal(capturedTimeout, 3 * 60);
  });

  it('preserves a zero-minute timeout', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `timeout_minutes: 0
commands:
  - echo hi
`,
    );

    let capturedTimeout = -1;
    const exec: CommandRunner = (_cmd, _wt, timeoutSec) => {
      capturedTimeout = timeoutSec;
      return { exitCode: 124, signal: null };
    };
    const result = await verify(worktree, policy, undefined, { exec });

    assert.equal(capturedTimeout, 0);
    assert.deepEqual(result, [{ command: 'echo hi', status: 'timed_out' }]);
  });

  it('marks failed commands', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - pass
  - fail
`,
    );

    const exec = sequentialRunner([{ exitCode: 0 }, { exitCode: 1 }]);
    const result = await verify(worktree, policy, undefined, { exec });

    assert.deepEqual(result, [
      { command: 'pass', status: 'passed' },
      { command: 'fail', status: 'failed' },
    ]);
  });

  it('treats exit code 124 as a timeout', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - slow
`,
    );

    const exec = sequentialRunner([{ exitCode: 124 }]);
    const result = await verify(worktree, policy, undefined, { exec });

    assert.deepEqual(result, [{ command: 'slow', status: 'timed_out' }]);
  });

  it('treats a signal-terminated command as failed', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - killed
`,
    );

    const exec = sequentialRunner([{ exitCode: null, signal: 'SIGKILL' }]);
    const result = await verify(worktree, policy, undefined, { exec });

    assert.deepEqual(result, [{ command: 'killed', status: 'failed' }]);
  });

  it('skips empty commands without adding results', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  -
  - real
`,
    );

    const exec = sequentialRunner([{ exitCode: 0 }]);
    const result = await verify(worktree, policy, undefined, { exec });

    assert.deepEqual(result, [{ command: 'real', status: 'passed' }]);
  });

  it('writes results to an output file when given', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - one
  - two
`,
    );

    const out = join(TEST_TMP, `out-${makeRunId()}.json`);
    const exec = sequentialRunner([{ exitCode: 0 }, { exitCode: 1 }]);
    await verify(worktree, policy, out, { exec });

    const written = readFileSync(out, 'utf8').trim();
    assert.deepEqual(JSON.parse(written), [
      { command: 'one', status: 'passed' },
      { command: 'two', status: 'failed' },
    ]);
  });

  it('runs commands in the worktree with a scrubbed sandbox env', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - env-check
`,
    );

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedWorktree = '';
    const exec: CommandRunner = (cmd, wt, _timeout, env) => {
      if (cmd === 'env-check') {
        capturedEnv = env;
        capturedWorktree = wt;
      }
      return { exitCode: 0, signal: null };
    };
    await verify(worktree, policy, undefined, { exec });

    assert.equal(capturedWorktree, worktree);
    assert.equal(capturedEnv?.HYDRA_SANDBOX, '1');
    assert.equal(capturedEnv?.NO_NETWORK, '1');
  });

  it('honours an injected base environment', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - env-check
`,
    );

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const exec: CommandRunner = (cmd, _wt, _timeout, env) => {
      if (cmd === 'env-check') {
        capturedEnv = env;
      }
      return { exitCode: 0, signal: null };
    };
    const options: VerifyOptions = {
      exec,
      env: { CUSTOM_VAR: 'custom-value', PATH: '/usr/bin' },
    };
    await verify(worktree, policy, undefined, options);

    assert.equal(capturedEnv?.CUSTOM_VAR, 'custom-value');
    assert.equal(capturedEnv?.HYDRA_SANDBOX, '1');
  });

  it('scrubs inherited credentials in the default runner', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - test -z "\${HYDRA_TEST_SECRET+x}" && test "$HYDRA_SANDBOX" = 1 && test "$NO_NETWORK" = 1
`,
    );

    const previousSecret = process.env.HYDRA_TEST_SECRET;
    process.env.HYDRA_TEST_SECRET = 'must-not-leak';
    const previousExitCode = process.exitCode;
    try {
      const result = await verify(worktree, policy);
      assert.deepEqual(result, [
        {
          command:
            'test -z "${HYDRA_TEST_SECRET+x}" && test "$HYDRA_SANDBOX" = 1 && test "$NO_NETWORK" = 1',
          status: 'passed',
        },
      ]);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.HYDRA_TEST_SECRET;
      } else {
        process.env.HYDRA_TEST_SECRET = previousSecret;
      }
      process.exitCode = previousExitCode ?? undefined;
    }
  });

  it('prints a JSON array of {command,status} to stdout', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - a
  - b
`,
    );

    const exec = sequentialRunner([{ exitCode: 0 }, { exitCode: 2 }]);
    const { output } = await captureStdout(() =>
      verify(worktree, policy, undefined, { exec }),
    );

    assert.deepEqual(JSON.parse(output), [
      { command: 'a', status: 'passed' },
      { command: 'b', status: 'failed' },
    ]);
  });

  it('runs real commands through the default sandbox runner', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - echo ok > output.txt
  - test -f output.txt
`,
    );

    const result = await verify(worktree, policy);

    assert.deepEqual(result, [
      { command: 'echo ok > output.txt', status: 'passed' },
      { command: 'test -f output.txt', status: 'passed' },
    ]);
    assert.equal(existsSync(join(worktree, 'output.txt')), true);
  });

  it('kills descendant processes when the default runner times out', async () => {
    const { worktree } = setupFixture(makeRunId());
    const pidFile = join(worktree, 'descendant.pid');
    const heartbeatFile = join(worktree, 'heartbeat');
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      LANG: process.env.LANG ?? 'C',
      HYDRA_SANDBOX: '1',
      NO_NETWORK: '1',
    };

    const result = await defaultRunCommand(
      'while true; do echo tick >> heartbeat; sleep 0.05; done & echo $! > descendant.pid; wait',
      worktree,
      0.25,
      env,
    );
    assert.equal(result.exitCode, 124);
    assert.equal(existsSync(pidFile), true);

    const descendantPid = Number(readFileSync(pidFile, 'utf8').trim());
    try {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2250));
      const heartbeatAfterGrace = readFileSync(heartbeatFile, 'utf8');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      assert.equal(readFileSync(heartbeatFile, 'utf8'), heartbeatAfterGrace);
    } finally {
      if (processExists(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL');
      }
    }
  });

  it('reports a real failing command', async () => {
    const { worktree, policy } = setupFixture(makeRunId());
    writePolicy(
      policy,
      `commands:
  - false
`,
    );

    const result = await verify(worktree, policy);

    assert.deepEqual(result, [{ command: 'false', status: 'failed' }]);
  });
});
