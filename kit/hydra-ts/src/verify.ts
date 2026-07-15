import { spawn } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, killTree, log, yamlList, yamlScalar } from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';

/**
 * Per-command verification outcome.
 */
export interface VerifyResult {
  command: string;
  status: 'passed' | 'failed' | 'timed_out';
}

/**
 * Result returned by a single sandboxed command execution.
 */
export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
}

/**
 * Injected command runner. Receives the raw command string, the worktree path,
 * the timeout in seconds, and the scrubbed sandbox environment. Used by tests
 * to avoid running real commands.
 */
export type CommandRunner = (
  command: string,
  worktree: string,
  timeoutSec: number,
  env: NodeJS.ProcessEnv,
) => ExecResult | Promise<ExecResult>;

/**
 * Options that make the side-effectful verify() function testable.
 */
export interface VerifyOptions {
  /** Working directory for path resolution; defaults to process.cwd(). */
  cwd?: string;
  /** Base environment for the sandbox; defaults to a minimal scrubbed env. */
  env?: NodeJS.ProcessEnv;
  /** Injected command runner; defaults to a real bash sandbox runner. */
  exec?: CommandRunner;
}

/**
 * Run a task's verification commands inside a sandbox against a worktree,
 * capturing pass/fail per command.
 *
 * This is a TypeScript port of hydra/scripts/verify.sh. The command list and
 * timeout are read ONLY from the tracked policy file (command-provenance rule).
 * Commands run with a scrubbed, credential-free environment inside the
 * candidate worktree and a wall-clock timeout.
 *
 * @param worktree - path to the candidate worktree
 * @param policy - path to the verification policy YAML
 * @param out - optional path to write the JSON results array
 * @param options - testability overrides
 * @returns the per-command results array
 */
export async function verify(
  worktree: string,
  policy: string,
  out?: string,
  options: VerifyOptions = {},
): Promise<VerifyResult[]> {
  if (!worktree || !policy) {
    die('usage: verify(worktree, policy, [out])');
  }

  const cwd = options.cwd ?? process.cwd();
  const resolvedWorktree = resolve(cwd, worktree);
  const resolvedPolicy = resolve(cwd, policy);

  if (!statSync(resolvedWorktree, { throwIfNoEntry: false })?.isDirectory()) {
    die(`worktree not found: ${worktree}`);
  }
  if (!statSync(resolvedPolicy, { throwIfNoEntry: false })?.isFile()) {
    die(`policy not found: ${policy}`);
  }

  // Mandatory commands come from the tracked policy ONLY.
  let commands = yamlList(resolvedPolicy, '  commands');
  if (commands.length === 0) {
    // Support both `commands:` at column 0 and nested under verification_policy.
    commands = yamlList(resolvedPolicy, 'commands');
  }
  if (commands.length === 0) {
    die(`no verification commands in policy: ${policy}`);
  }

  let timeoutMin = yamlScalar(resolvedPolicy, '  timeout_minutes');
  if (!timeoutMin) {
    timeoutMin = yamlScalar(resolvedPolicy, 'timeout_minutes');
  }
  const timeoutSec = Number(timeoutMin || '15') * 60;

  const baseEnv = options.env ?? {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C',
  };
  const sandboxEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    HYDRA_SANDBOX: '1',
    NO_NETWORK: '1',
  };

  const runCommand = options.exec ?? defaultRunCommand;
  const results: VerifyResult[] = [];

  for (const cmd of commands) {
    if (!cmd) continue;
    log(`verify: running: ${cmd}`);
    let status: VerifyResult['status'] = 'passed';
    const { exitCode } = await runCommand(cmd, resolvedWorktree, timeoutSec, sandboxEnv);
    if (exitCode !== 0) {
      // Match hydra_timeout: only its conventional exit code 124 is a timeout.
      status = exitCode === 124 ? 'timed_out' : 'failed';
    }
    results.push({ command: cmd, status });
  }

  const json = JSON.stringify(results);
  process.stdout.write(`${json}\n`);
  if (out) {
    writeFileSync(out, `${json}\n`, 'utf8');
  }

  return results;
}

export function defaultRunCommand(
  command: string,
  worktree: string,
  timeoutSec: number,
  env: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  const environment = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`);

  return new Promise((resolvePromise) => {
    const child = spawn(
      'env',
      [
        '-i',
        ...environment,
        'bash',
        '-c',
        'cd "$1" && exec bash -c "$2" >/dev/null 2>&1',
        '_',
        worktree,
        command,
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    let settled = false;

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      if (settled || child.pid === undefined) return;
      signalProcessGroup(child.pid, 'SIGTERM');
      setTimeout(() => {
        signalProcessGroup(child.pid!, 'SIGKILL');
      }, 2000);
      finish({ exitCode: 124, signal: null });
    }, timeoutSec * 1000);

    child.on('exit', (exitCode, signal) => {
      if (settled) return;
      clearTimeout(timer);
      finish({ exitCode: exitCode ?? null, signal: signal ?? null });
    });

    child.on('error', () => {
      clearTimeout(timer);
      finish({ exitCode: 127, signal: null });
    });
  });
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      killTree(pid);
    }
  }
}

export default verify;

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const [worktree, policy, out] = args;
    if (!worktree || !policy) {
      die('usage: verify.sh <worktree> <policy.yaml> [out.json]');
    }
    const results = await verify(worktree, policy, out);
    return results.every((result) => result.status === 'passed') ? 0 : 4;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await main();
}
