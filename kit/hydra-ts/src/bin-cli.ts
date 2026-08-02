// Stage 0 compiled-binary router.
// This is a standalone, additive entry point. It is NOT wired into any existing
// shell wrapper or the TypeScript harness default. It exists only to prove the
// `bun build --compile` self-re-exec path and settle runtime-unknowns before
// Stage 1 introduces the HYDRA_HARNESS=bin switch.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { main as detectHeadsMain } from './detect-heads.ts';
import { main as gcMain } from './gc.ts';
import { main as runLogMain } from './run-log.ts';
import { main as waitTaskMain, mainRun as waitRunMain } from './wait-task.ts';

// Bun documents that `BUN_BE_BUN=1` can cause a compiled executable to ignore its
// bundled entry point and run Bun's own generic CLI instead. Unset it in our own
// process before any routing, and strip it from every child we spawn.
if (process.env.BUN_BE_BUN !== undefined) {
  delete process.env.BUN_BE_BUN;
}

function printUsage(): void {
  console.error('Usage: hydra-bin-stage0 <status|detect-heads [--json]|gc [--apply] [--keep-last N] [--default-branch REF] [--json]|run-log <run_id> [--out <dir>] [--json]|wait-task <run_id> <task_id> [--timeout-seconds N] [--json]|wait-run <run_id> [task_id...] [--timeout-seconds N] [--json]|__adapter stub <verb> [args...]>');
}

function failUnknown(): void {
  printUsage();
  process.exitCode = 2;
}

export function selfReexec(subcommandArgs: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, subcommandArgs, {
    env: { ...process.env, BUN_BE_BUN: undefined },
    encoding: 'utf8',
  });
}

function handleStatus(): void {
  const child = selfReexec(['__adapter', 'stub', 'spike-check']);
  let childReport: unknown = null;
  if (child.stdout) {
    try {
      childReport = JSON.parse(child.stdout.trim());
    } catch {
      // leave childReport as null; the test surface will treat this as a failure
    }
  }

  const output = {
    ok: true,
    runtime: 'bun-cli-stage0',
    selfReexecCheck: childReport,
  };

  console.log(JSON.stringify(output));
  process.exitCode = 0;
}

function handleAdapter(): void {
  const vendor = process.argv[3];
  const verb = process.argv[4];

  if (vendor !== 'stub') {
    console.error(`Unknown adapter vendor: ${vendor ?? '(none)'}`);
    process.exitCode = 2;
    return;
  }

  if (!verb) {
    console.error('Missing adapter verb');
    process.exitCode = 2;
    return;
  }

  const report = {
    argv: process.argv,
    execPath: process.execPath,
    importMetaUrl: import.meta.url,
  };

  console.log(JSON.stringify(report));
  process.exitCode = 0;
}

function handleDetectHeads(): void {
  // Same subcommand surface as cli.ts's extension route, registered here too
  // so the standalone compiled router exposes vendor-head detection (run 0047).
  process.exitCode = detectHeadsMain(process.argv.slice(3));
}

function handleGc(): void {
  // Same subcommand surface as cli.ts's extension route, registered here too
  // so the standalone compiled router exposes worktree/branch reaping (run 0048).
  process.exitCode = gcMain(process.argv.slice(3));
}

function handleRunLog(): void {
  // Same subcommand surface as cli.ts's extension route (run 0048): the
  // per-run lifecycle audit document that makes worktree reaping safe.
  process.exitCode = runLogMain(process.argv.slice(3));
}

function handleWaitTask(): void {
  // Same subcommand surface as cli.ts's extension route (run 0068): block until
  // one task reaches a terminal ledger state. Unlike the handlers above these
  // mains are async (they poll), so the exit code is assigned on settlement.
  void waitTaskMain(process.argv.slice(3)).then((code) => {
    process.exitCode = code;
  });
}

function handleWaitRun(): void {
  // Same subcommand surface as cli.ts's extension route (run 0068): the
  // fan-out wait across several tasks of a run.
  void waitRunMain(process.argv.slice(3)).then((code) => {
    process.exitCode = code;
  });
}

function main(): void {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case 'status':
      handleStatus();
      break;
    case 'detect-heads':
      handleDetectHeads();
      break;
    case 'gc':
      handleGc();
      break;
    case 'run-log':
      handleRunLog();
      break;
    case 'wait-task':
      handleWaitTask();
      break;
    case 'wait-run':
      handleWaitRun();
      break;
    case '__adapter':
      handleAdapter();
      break;
    case undefined:
    default:
      failUnknown();
      break;
  }
}

main();
