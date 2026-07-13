import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  die,
  herdrState,
  killTree,
  ledgerAppend,
  log,
  repoRoot,
  runDir,
  stateRoot,
} from './lib.ts';

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => ExecResult;

export interface ReviewDispatchOptions {
  /** Explicit repository root; otherwise resolved with git. */
  cwd?: string;
  /** Explicit state root; otherwise resolved from the environment. */
  stateRoot?: string;
  /** Injectable command runner for tests. */
  exec?: ExecFn;
  /** Injectable pane-state reporter for tests. */
  herdrState?: typeof herdrState;
  /** Optional image path (kimi only). */
  image?: string;
  /** Injectable process-tree killer for tests. */
  killTree?: typeof killTree;
  /** Injectable poll sleeper for tests. */
  sleep?: (ms: number) => void;
}

// ---------------------------------------------------------------------------
// Default command runner.
// ---------------------------------------------------------------------------

export function defaultExec(
  file: string,
  args: string[],
  options?: { cwd?: string },
): ExecResult {
  const result = spawnSync(file, args, {
    cwd: options?.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  let exitCode: number;
  if (result.status !== null) {
    exitCode = result.status;
  } else if (result.signal) {
    const signalNumber = osConstants.signals[result.signal] ?? 0;
    exitCode = 128 + signalNumber;
  } else if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    exitCode = code === 'EACCES' ? 126 : 127;
  } else {
    exitCode = 1;
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// State-root-aware ledger append. lib.ledgerAppend derives the ledger path
// from the environment, so we temporarily redirect HYDRA_STATE_ROOT when an
// explicit state root was supplied without re-implementing the helper.
// ---------------------------------------------------------------------------

function appendLedger(
  stateRootPath: string,
  runId: string,
  event: string,
  ...kvs: string[]
): void {
  const previous = process.env.HYDRA_STATE_ROOT;
  process.env.HYDRA_STATE_ROOT = stateRootPath;
  try {
    ledgerAppend(runId, event, ...kvs);
  } finally {
    if (previous === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = previous;
    }
  }
}

// ---------------------------------------------------------------------------
// Vendor command construction.
// ---------------------------------------------------------------------------

function vendorCommand(
  vendor: string,
  prompt: string,
  repoRootPath: string,
  image?: string,
): { file: string; args: string[] } {
  switch (vendor) {
    case 'codex':
      return {
        file: 'codex',
        args: ['exec', '--json', '-s', 'read-only', '-C', repoRootPath, prompt],
      };
    case 'kimi': {
      const args = [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--add-dir',
        repoRootPath,
      ];
      if (image) {
        args.push('--add-dir', dirname(image));
      }
      return { file: 'kimi', args };
    }
    case 'claude':
      return {
        file: 'claude',
        args: ['-p', prompt, '--output-format', 'json', '--add-dir', repoRootPath],
      };
    case 'opencode': {
      const model =
        process.env.HYDRA_OPENCODE_MODEL ?? 'zai-coding-plan/glm-5.2';
      return {
        file: 'opencode',
        args: [
          'run',
          '--model',
          model,
          '--agent',
          'hydra-reviewer',
          '--format',
          'json',
          '--auto',
          '--dir',
          repoRootPath,
          prompt,
        ],
      };
    }
    default:
      die(`unknown vendor: ${vendor}`);
  }
}

// ---------------------------------------------------------------------------
// Extract the final assistant message per vendor stream format.
// ---------------------------------------------------------------------------

function extractFinalMessage(vendor: string, rawPath: string): string {
  if (!existsSync(rawPath)) return '';
  const raw = readFileSync(rawPath, 'utf8');

  try {
    const jsonLines = (): Record<string, unknown>[] =>
      raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    switch (vendor) {
      case 'codex': {
        const messages: string[] = [];
        for (const obj of jsonLines()) {
          const msg = obj.msg as Record<string, unknown> | undefined;
          const item = obj.item as Record<string, unknown> | undefined;
          if (msg?.type === 'agent_message' || obj.type === 'item.completed') {
            messages.push(
              String(msg?.message ?? item?.text ?? ''),
            );
          }
        }
        return messages.at(-1) ?? '';
      }
      case 'kimi': {
        const contents: string[] = [];
        for (const obj of jsonLines()) {
          if (obj.role === 'assistant') {
            contents.push(String(obj.content ?? ''));
          }
        }
        return contents.at(-1) ?? '';
      }
      case 'claude': {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        return String(obj.result ?? '');
      }
      case 'opencode': {
        const texts: string[] = [];
        for (const obj of jsonLines()) {
          const part = obj.part as Record<string, unknown> | undefined;
          if (obj.type === 'text' || part?.type === 'text') {
            texts.push(String(obj.text ?? part?.text ?? ''));
          }
        }
        return texts.at(-1) ?? '';
      }
      default:
        return '';
    }
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Herdr pane helpers.
// ---------------------------------------------------------------------------

function findHerdrWorkspace(
  repoRootPath: string,
  exec: ExecFn,
): string | undefined {
  const result = exec('herdr', ['pane', 'list'], { cwd: repoRootPath });
  if (result.exitCode !== 0) return undefined;
  try {
    const data = JSON.parse(result.stdout) as {
      result?: { panes?: Array<{ agent?: unknown; cwd?: string; workspace_id?: string }> };
    };
    const pane = data.result?.panes?.find(
      (p) => p.agent != null && p.cwd === repoRootPath,
    );
    return pane?.workspace_id;
  } catch {
    return undefined;
  }
}

function launchInPane(
  runId: string,
  reviewId: string,
  vendor: string,
  repoRootPath: string,
  wrapped: string,
  exec: ExecFn,
): { pane?: string } | undefined {
  const status = exec('herdr', ['status'], { cwd: repoRootPath });
  if (status.exitCode !== 0) return undefined;

  const ws = findHerdrWorkspace(repoRootPath, exec);
  const label = `hydra:${runId}:${reviewId}:${vendor}`;
  const args = [
    'agent',
    'start',
    label,
    '--cwd',
    repoRootPath,
    ...(ws ? ['--workspace', ws] : []),
    '--split',
    'down',
    '--no-focus',
    '--',
    'bash',
    '-lc',
    wrapped,
  ];

  const started = exec('herdr', args, { cwd: repoRootPath });
  if (started.exitCode !== 0) return undefined;

  try {
    const data = JSON.parse(started.stdout) as {
      result?: { agent?: { pane_id?: string } };
    };
    return { pane: data.result?.agent?.pane_id };
  } catch {
    // The command did start successfully. Bash's jq failure leaves an empty
    // pane id but does not turn the successful launch into an inline fallback.
    return { pane: undefined };
  }
}

function sleepMs(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)], { encoding: 'utf8', stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export function reviewDispatch(
  runId: string,
  reviewId: string,
  vendor: string,
  promptFile: string,
  options: ReviewDispatchOptions = {},
): string {
  if (!runId) die('usage: reviewDispatch <run_id> <review_id> <vendor> <prompt_file> [--image PATH] (run_id required)');
  if (!reviewId) die('review_id required');
  if (!vendor) die('vendor required');
  if (!promptFile) die('prompt_file required');
  if (!existsSync(promptFile)) die(`prompt file not found: ${promptFile}`);

  const exec = options.exec ?? defaultExec;
  const reportHerdrState = options.herdrState ?? herdrState;
  const terminateTree = options.killTree ?? killTree;
  const sleep = options.sleep ?? sleepMs;
  const repoRootPath = options.cwd ?? repoRoot();
  const stateRootPath = options.stateRoot ?? stateRoot();
  const rd = options.stateRoot
    ? join(stateRootPath, 'runs', `run-${runId}`)
    : runDir(runId);

  const sessions = join(rd, 'sessions');
  mkdirSync(sessions, { recursive: true });

  const outMd = join(sessions, `${reviewId}.${vendor}.md`);
  const raw = join(sessions, `${reviewId}.${vendor}.raw`);
  const sentinel = join(sessions, `${reviewId}.${vendor}.exit`);
  const pidfile = join(sessions, `${reviewId}.${vendor}.pid`);

  rmSync(sentinel, { force: true });
  rmSync(pidfile, { force: true });

  const prompt = readFileSync(promptFile, 'utf8');
  const { file, args } = vendorCommand(vendor, prompt, repoRootPath, options.image);

  // For a herdr pane we need a shell command string that writes its own pid,
  // runs the vendor, and records the exit code.
  const wrapped = `echo $$ > '${pidfile}'; ${file} ${args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ')} > '${raw}' 2>&1; printf '%s' $? > '${sentinel}'`;

  appendLedger(stateRootPath, runId, 'review_started', 'review_id', reviewId, 'vendor', vendor);

  let launchedInPane = false;
  let pane: string | undefined;

  if (process.env.HYDRA_HERDR_PANES === '1') {
    const launched = launchInPane(
      runId,
      reviewId,
      vendor,
      repoRootPath,
      wrapped,
      exec,
    );
    if (launched) {
      launchedInPane = true;
      pane = launched.pane;
      appendLedger(
        stateRootPath,
        runId,
        'herdr_pane_started',
        'review_id',
        reviewId,
        'vendor',
        vendor,
        'label',
        `hydra:${runId}:${reviewId}:${vendor}`,
        'pane',
        pane ?? '?',
      );
      log(`reviewer hosted in herdr pane ${pane ?? '?'}: hydra:${runId}:${reviewId}:${vendor}`);
      if (pane) reportHerdrState(pane, vendor, 'working');

      const limitMinutes = Number(
        process.env.HYDRA_REVIEW_TIMEOUT_MIN ?? '15',
      );
      const limitSeconds = limitMinutes * 60;
      const start = Date.now();
      while (
        !existsSync(sentinel) &&
        (Date.now() - start) / 1000 < limitSeconds
      ) {
        sleep(3000);
      }

      if (!existsSync(sentinel) && existsSync(pidfile)) {
        const pid = Number(readFileSync(pidfile, 'utf8').trim());
        if (!Number.isNaN(pid)) terminateTree(pid);
      }

      if (pane) reportHerdrState(pane, vendor, 'idle');
      if (pane && process.env.HYDRA_HERDR_KEEP_PANE !== '1') {
        const closed = exec('herdr', ['pane', 'close', pane], {
          cwd: repoRootPath,
        });
        if (closed.exitCode === 0) log(`closed reviewer pane ${pane}`);
      }
    }
  }

  // Fallback: run inline when herdr is disabled or unavailable.
  if (!launchedInPane) {
    const result = exec('bash', ['-lc', wrapped], { cwd: repoRootPath });
    // A real shell writes these files from wrapped. Preserve useful command
    // errors for injected runners or a shell that fails before redirection.
    if (!existsSync(raw)) {
      writeFileSync(raw, result.stderr || result.stdout, 'utf8');
    }
    if (!existsSync(sentinel)) {
      writeFileSync(sentinel, String(result.exitCode), 'utf8');
    }
  }

  const message = extractFinalMessage(vendor, raw);
  if (message) {
    writeFileSync(outMd, `${message}\n`, 'utf8');
  } else if (existsSync(raw)) {
    writeFileSync(outMd, readFileSync(raw, 'utf8'), 'utf8');
  }

  const exitCode = existsSync(sentinel)
    ? readFileSync(sentinel, 'utf8').trim()
    : '?';
  appendLedger(
    stateRootPath,
    runId,
    'review_completed',
    'review_id',
    reviewId,
    'vendor',
    vendor,
    'exit_code',
    exitCode,
  );
  log(`review ${reviewId} (${vendor}) -> ${outMd}`);
  process.stdout.write(`${outMd}\n`);
  return outMd;
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const [runId, reviewId, vendor, promptFile, ...rest] = process.argv.slice(2);
    let image: string | undefined;
    const imageIdx = rest.indexOf('--image');
    if (imageIdx !== -1) {
      image = rest[imageIdx + 1];
    }
    reviewDispatch(runId, reviewId, vendor, promptFile, { image });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
