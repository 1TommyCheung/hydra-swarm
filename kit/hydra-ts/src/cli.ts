// Stage 1 (Phase 1b) single-entry CLI router.
//
// Background: docs/bun-migration-spike-adapters.md spike #2 proved that under
// `bun build --compile` every module-level `isMain` guard in the bundle
// evaluates TRUE simultaneously (Bun collapses import.meta.url to the same
// synthetic entry URL for every bundled module), so the tree cannot be
// compiled unmodified. This file is THE single real entry point: it imports
// every CLI module's exported main(args) and routes process.argv to the right
// one explicitly. See docs/bun-migration-stage1-cli.md for the full table.
//
// Invocation shape mirrors the existing bash wrappers 1:1:
//   cli.ts <subcommand> [args...]   ==   scripts/<subcommand>.sh [args...]
// The five adapter-*.ts modules keep their existing standalone shape:
//   cli.ts adapter-<vendor> <verb> [args...]
//
// This task does NOT rewire kit/hydra/scripts/*.sh or HYDRA_HARNESS; cli.ts is
// exercised standalone via `node --experimental-strip-types src/cli.ts ...`.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { main as adapterClaudeMain } from './adapter-claude.ts';
import { main as adapterCodexMain } from './adapter-codex.ts';
import { main as adapterKimiMain } from './adapter-kimi.ts';
import { main as adapterOpencodeMain } from './adapter-opencode.ts';
import { main as adapterStubMain } from './adapter-stub.ts';
import { main as aggregateUsageMain } from './aggregate-usage.ts';
import { main as allocateMain } from './allocate.ts';
import { main as amendTaskMain } from './amend-task.ts';
import { main as auditOwnershipMain } from './audit-ownership.ts';
import { main as buildWorkerPromptMain } from './build-worker-prompt.ts';
import { main as cancelTaskMain } from './cancel-task.ts';
import { main as codeIntelMain } from './code-intel.ts';
import { main as createWorktreeMain } from './create-worktree.ts';
import { main as dispatchMain } from './dispatch.ts';
import { main as freshnessGateMain } from './freshness-gate.ts';
import { main as graphImpactMain } from './graph-impact.ts';
import { main as graphifyBaselineMain } from './graphify-baseline.ts';
import { main as graphifyInvestigateMain } from './graphify-investigate.ts';
import { main as graphifyRepoMain } from './graphify-repo.ts';
import { main as herdrPushMain } from './herdr-push.ts';
import { main as indexCandidateMain } from './index-candidate.ts';
import { main as integrateMain } from './integrate.ts';
import { main as ledgerViewMain } from './ledger-view.ts';
import { main as measureDivergenceMain } from './measure-divergence.ts';
import { main as otelEnvMain } from './otel-env.ts';
import { main as promoteMain } from './promote.ts';
import { main as recordReviewMain } from './record-review.ts';
import { main as recordUsageMain } from './record-usage.ts';
import { main as reviewDispatchMain } from './review-dispatch.ts';
import { main as reviewRequiredMain } from './review-required.ts';
import { main as runInitMain } from './run-init.ts';
import { main as squashMain } from './squash.ts';
import { main as statusMain } from './status.ts';
import { main as verifyMain } from './verify.ts';

/** Every routed module exposes the normalized router-callable shape. */
export type MainFn = (args: string[]) => number | Promise<number>;

/**
 * Subcommand -> module main(). The subcommand is the module's basename without
 * the .ts extension, matching kit/hydra/scripts/<name>.sh 1:1 (the five
 * adapter-* names have no scripts/ wrapper; they are dispatched by vendor via
 * dispatch.ts and keep their standalone `<verb> ...args` arg shape here).
 */
export const routes: Readonly<Record<string, MainFn>> = {
  'adapter-claude': adapterClaudeMain,
  'adapter-codex': adapterCodexMain,
  'adapter-kimi': adapterKimiMain,
  'adapter-opencode': adapterOpencodeMain,
  'adapter-stub': adapterStubMain,
  'aggregate-usage': aggregateUsageMain,
  'allocate': allocateMain,
  'amend-task': amendTaskMain,
  'audit-ownership': auditOwnershipMain,
  'build-worker-prompt': buildWorkerPromptMain,
  'cancel-task': cancelTaskMain,
  'code-intel': codeIntelMain,
  'create-worktree': createWorktreeMain,
  'dispatch': dispatchMain,
  'freshness-gate': freshnessGateMain,
  'graph-impact': graphImpactMain,
  'graphify-baseline': graphifyBaselineMain,
  'graphify-investigate': graphifyInvestigateMain,
  'graphify-repo': graphifyRepoMain,
  'herdr-push': herdrPushMain,
  'index-candidate': indexCandidateMain,
  'integrate': integrateMain,
  'ledger-view': ledgerViewMain,
  'measure-divergence': measureDivergenceMain,
  'otel-env': otelEnvMain,
  'promote': promoteMain,
  'record-review': recordReviewMain,
  'record-usage': recordUsageMain,
  'review-dispatch': reviewDispatchMain,
  'review-required': reviewRequiredMain,
  'run-init': runInitMain,
  'squash': squashMain,
  'status': statusMain,
  'verify': verifyMain,
};

export function usage(): string {
  const names = Object.keys(routes).sort();
  return [
    'Usage: hydra <subcommand> [args...]',
    '',
    'Subcommands:',
    ...names.map((name) => `  ${name}`),
    '',
  ].join('\n');
}

/**
 * Route argv (subcommand first, args after) to the matching module main().
 * Returns the subcommand's exit code; unknown/missing subcommand prints the
 * usage listing to stderr and returns 1. `registry` is injectable for tests.
 */
export async function route(
  argv: string[],
  registry: Readonly<Record<string, MainFn>> = routes,
): Promise<number> {
  const subcommand = argv[0];
  const fn = subcommand === undefined ? undefined : registry[subcommand];
  if (fn === undefined) {
    process.stderr.write(usage());
    return 1;
  }
  return await fn(argv.slice(1));
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await route(process.argv.slice(2));
}
