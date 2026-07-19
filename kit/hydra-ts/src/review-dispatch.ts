import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
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
  codexEventText,
  die,
  herdrState,
  killTree,
  kimiEventText,
  ledgerAppend,
  log,
  pollJsonlFile,
  repoRoot,
  runDir,
  stateRoot,
  type JsonlTailState,
} from './lib.ts';
import { herdrAgentPaneRatio, monitorEventText } from './dispatch.ts';
import { isCompiledBinary } from './kit-assets.ts';

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
    // Strip BUN_BE_BUN so a leaked BUN_BE_BUN=1 cannot hijack a Bun-compiled
    // child (vendor CLIs via `bash -lc`, or herdr itself — spike:
    // docs/bun-migration-spike-results.md); Bun omits undefined env keys.
    env: { ...process.env, BUN_BE_BUN: undefined },
    encoding: 'utf8',
    stdio: 'pipe',
  });

  let exitCode: number;
  // Tolerate Bun's spawn-error shape: Node reports `status: null` while Bun
  // reports `status: undefined`; loose `!= null` covers both.
  if (result.status != null) {
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shrink a freshly started reviewer pane so the lead console keeps the
 * majority of the terminal height (issue #18). The pane was split `down`
 * from the lead console, so `pane resize --direction down` moves the divider
 * toward the reviewer pane, leaving it at roughly HYDRA_HERDR_PANE_RATIO of
 * the height. Purely cosmetic: any failure is ignored.
 */
function shrinkAgentPane(exec: ExecFn, repoRootPath: string, pane: string): void {
  try {
    exec('herdr', [
      'pane',
      'resize',
      '--direction',
      'down',
      '--amount',
      String(herdrAgentPaneRatio(process.env.HYDRA_HERDR_PANE_RATIO)),
      '--pane',
      pane,
    ], { cwd: repoRootPath });
  } catch {
    // Pane sizing is best effort and must never fail the review.
  }
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
  const progressPath = join(sessions, `${reviewId}.${vendor}.pane-progress.txt`);

  rmSync(sentinel, { force: true });
  rmSync(pidfile, { force: true });

  const prompt = readFileSync(promptFile, 'utf8');
  const { file, args } = vendorCommand(vendor, prompt, repoRootPath, options.image);

  // Live pane feedback (issue #18): codex/kimi/opencode stream NDJSON that
  // pollJsonlFile re-parses into event text for the pane's `tail -f` progress
  // file (opencode reuses the worker lane's monitorEventText parser from
  // dispatch.ts). Claude emits a single JSON document at exit
  // (`--output-format json`), so its pane gets a supervisor-written heartbeat
  // on every poll instead — either way no vendor shows a blank pane while
  // the reviewer is running.
  const streamsVendorEvents = vendor === 'codex' || vendor === 'kimi' || vendor === 'opencode';
  const usesHeartbeat = vendor === 'claude';
  const usesLiveProgressPane = streamsVendorEvents || usesHeartbeat;
  const liveProgressTailState: JsonlTailState = { offset: 0 };
  const parseLiveProgress =
    vendor === 'kimi' ? kimiEventText :
    vendor === 'opencode' ? monitorEventText :
    codexEventText;
  let paneStartedAt = 0;
  const pollLiveProgress = (final = false): void => {
    if (streamsVendorEvents) {
      pollJsonlFile(raw, progressPath, parseLiveProgress, liveProgressTailState, final);
      return;
    }
    if (usesHeartbeat && !final && paneStartedAt > 0) {
      const elapsedSec = Math.floor((Date.now() - paneStartedAt) / 1000);
      try {
        appendFileSync(progressPath, `[hydra] claude working... elapsed ${elapsedSec}s\n`, 'utf8');
      } catch { /* best effort — the heartbeat is cosmetic */ }
    }
  };

  // The plain wrapper writes its own pid, runs the vendor, and records the
  // exit code -- no live tail. This is what the inline/fallback path always
  // uses (herdr disabled, or pane launch fails): nothing polls the progress
  // file in that path (the supervisor's poll loop only runs while a pane is
  // actually hosting the run), so giving a live-feedback vendor the live
  // wrapper there would spawn a pointless background tail process for no
  // observer.
  const plainWrapped = `echo $$ > '${pidfile}'; ${file} ${args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ')} > '${raw}' 2>&1; printf '%s' $? > '${sentinel}'`;

  // The live wrapper additionally tails a progress file into the pane's own
  // terminal while the vendor command runs (streamed vendor events, or the
  // claude heartbeat) -- used ONLY for an actual pane-launch attempt.
  let wrapped = plainWrapped;
  if (usesLiveProgressPane) {
    const inner = `${shellQuote(file)} ${args.map(shellQuote).join(' ')} > ${shellQuote(raw)} 2>&1`;
    wrapped = [
      `echo $$ > ${shellQuote(pidfile)}`,
      `set +e`,
      `touch ${shellQuote(progressPath)} 2>/dev/null`,
      `tail -n +1 -f ${shellQuote(progressPath)} 2>/dev/null & TPID=$!`,
      `${inner}`,
      `RC=$?`,
      `kill $TPID 2>/dev/null`,
      `printf '%s' $RC > ${shellQuote(sentinel)}`,
    ].join('; ');
  }

  appendLedger(stateRootPath, runId, 'review_started', 'review_id', reviewId, 'vendor', vendor);

  let launchedInPane = false;
  let pane: string | undefined;

  if (process.env.HYDRA_HERDR_PANES !== '0') {
    // Seed the progress file BEFORE launching the pane, matching the worker
    // lane in dispatch.ts: a fast-exiting vendor can end the pane's
    // `tail -f` before a post-launch write ever lands, leaving a blank pane
    // -- exactly the failure this file's live feedback exists to prevent
    // (cross-vendor review, spec v4 fix 2).
    if (usesLiveProgressPane) {
      try {
        writeFileSync(progressPath, `[hydra] ${vendor} started — waiting for output...\n`, 'utf8');
      } catch { /* best effort — pane uses touch */ }
    }
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
      paneStartedAt = Date.now();
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
      if (pane) shrinkAgentPane(exec, repoRootPath, pane);
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
        pollLiveProgress();
      }
      pollLiveProgress(true);

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

  // Fallback: run inline when herdr is disabled or unavailable. Always the
  // PLAIN wrapper -- no pane means no progress-file observer.
  if (!launchedInPane) {
    const result = exec('bash', ['-lc', plainWrapped], { cwd: repoRootPath });
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

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    const [runId, reviewId, vendor, promptFile, ...rest] = args;
    let image: string | undefined;
    const imageIdx = rest.indexOf('--image');
    if (imageIdx !== -1) {
      image = rest[imageIdx + 1];
    }
    reviewDispatch(runId, reviewId, vendor, promptFile, { image });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isMain =
  !isCompiledBinary() &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
