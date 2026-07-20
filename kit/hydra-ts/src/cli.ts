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
// Invocation shape mirrors the kit/hydra/scripts/<name>.sh entry points 1:1:
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
import { main as detectHeadsMain } from './detect-heads.ts';
import { main as dispatchMain } from './dispatch.ts';
import { main as freshnessGateMain } from './freshness-gate.ts';
import { main as gcMain } from './gc.ts';
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
import { main as runLogMain } from './run-log.ts';
import { main as squashMain } from './squash.ts';
import { main as statusMain } from './status.ts';
import { main as verifyMain } from './verify.ts';
import { main as versionMain } from './version.ts';
import { initEmbeddedAssets, isCompiledBinary } from './kit-assets.ts';

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

// Post-Stage-1 subcommands. cli.test.ts pins the Stage-1 `routes` table at
// exactly 34 subcommands (its 'covers exactly the 34 Stage-1 subcommands'
// assertion), so newer subcommands register HERE instead: route() consults
// this table only when the default registry is in play, and usage() lists
// both. (run 0047: detect-heads; run 0048: gc, run-log.)
const extensionRoutes: Readonly<Record<string, MainFn>> = {
  'detect-heads': detectHeadsMain,
  'gc': gcMain,
  'run-log': runLogMain,
  'help': (args) => {
    void args;
    process.stdout.write(usage());
    return 0;
  },
  'version': versionMain,
};

/**
 * Argument signature per subcommand, rendered by usage() on a continuation
 * line under each name (the Stage-1 cli tests pin the exact `  <name>\n`
 * name-line shape, so signatures must not share the name's line). Keep in
 * sync with each module's own `usage:` die() string — that string remains
 * the authority the module enforces.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  'adapter-claude': 'start|resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session]',
  'adapter-codex': 'start <task_spec> <worktree> <inbox> <sessions> <agent_run_id>',
  'adapter-kimi': 'start <task_spec> <worktree> <inbox> <sessions> <agent_run_id> | visual <cwd> <prompt> <out_prefix> <agent_run_id> [image]',
  'adapter-opencode': 'start <task_spec> <worktree> <inbox> <sessions> <agent_run_id> | explore|review <cwd> <prompt> <out_prefix> <agent_run_id>',
  'adapter-stub': 'start|resume <task_spec> <worktree> <inbox> <sessions> <agent_run_id> [prior_session]',
  'aggregate-usage': '(no args — prints per-vendor measured profiles as JSONL)',
  'allocate': '<role> <task_type> [risk] [--exclude-vendor <v>]',
  'amend-task': '<run_id> <task_id> <reason> [resume|restart]',
  'audit-ownership': '<worktree> <base> <head> <writable_glob>...',
  'build-worker-prompt': '<task_spec>',
  'cancel-task': '<run_id> <task_id> [--wait-seconds N]',
  'code-intel': 'changed [--base <ref>] | impact <symbol> | query "<q>" | drift',
  'create-worktree': '<run_id> <task_id> [base_commit]',
  'detect-heads': '[--json]',
  'dispatch': '<run_id> <task_id> [--background]',
  'freshness-gate': '<run_id> <task_id>',
  'gc': '[--apply] [--keep-last N] [--default-branch REF] [--json]',
  'run-log': '<run_id> [--out <dir>] [--json]',
  'graph-impact': '<run_id> <task_id>',
  'graphify-baseline': '<run_id> [source_path] [--backend claude|kimi]',
  'graphify-investigate': '<run_id> <task_id> | <run_id> --files <f>...',
  'graphify-repo': 'build | update | query "<q>" | status',
  'help': '(prints this listing)',
  'herdr-push': '<run_id> [--notify]',
  'index-candidate': '<run_id> <task_id> [logical_label]',
  'integrate': '<run_id> <task_id_in_dependency_order>...',
  'ledger-view': '<run_id> [out.html]',
  'measure-divergence': '[run_id...] (defaults to all runs)',
  'otel-env': '(no args — prints OTEL exporter env shell exports)',
  'promote': '<run_id> <task_id> <inbox_result.json>',
  'record-review': '<run_id> <task_id> <verdict.json>',
  'record-usage': '<run_id> <task_id> <vendor> <agent_run_id>',
  'review-dispatch': '<run_id> <review_id> <vendor> <prompt_file> --task <task_id> [--image PATH]',
  'review-required': '<implementer_vendor> <risk> [label...]',
  'run-init': '<run_id> [base_commit]',
  'squash': '<run_id> <task_id>',
  'status': '<run_id> <task_id> [--lines N] [--json]',
  'verify': '<worktree> <policy.yaml> [out.json]',
  'version': '[--json]',
};

export function usage(): string {
  const names = [...Object.keys(routes), ...Object.keys(extensionRoutes)].sort();
  return [
    'Usage: hydra <subcommand> [args...]',
    '',
    'Subcommands:',
    ...names.flatMap((name) => {
      const signature = SIGNATURES[name];
      return signature === undefined ? [`  ${name}`] : [`  ${name}`, `      ${signature}`];
    }),
    '',
  ].join('\n');
}

/**
 * Route argv (subcommand first, args after) to the matching module main().
 * Returns the subcommand's exit code; unknown/missing subcommand prints the
 * usage listing to stderr and returns 1. `registry` is injectable for tests;
 * the post-Stage-1 extensionRoutes are consulted only for the default
 * registry so a custom registry fully controls the dispatch surface.
 */
export async function route(
  argv: string[],
  registry: Readonly<Record<string, MainFn>> = routes,
): Promise<number> {
  const subcommand = argv[0];
  const fn = subcommand === undefined
    ? undefined
    : (registry[subcommand] ?? (registry === routes ? extensionRoutes[subcommand] : undefined));
  if (fn === undefined) {
    process.stderr.write(usage());
    return 1;
  }
  return await fn(argv.slice(1));
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  // Stage 1 Phase 2 (spike §10): inside a `bun build --compile` binary, embed
  // the EMBED-set kit assets (trust-boundary schemas + seeded profiles) and
  // hand them to kit-assets BEFORE route() runs any subcommand main() that
  // reads them. The `with: { type: 'text' }` attribute is Bun-only — Node
  // 22/24 reject it (spike §7) — so these must never be STATIC imports: the
  // source lane (`node --experimental-strip-types`, cli.test.ts) loads this
  // module too. Dynamic import() behind isCompiledBinary() keeps the
  // attribute out of Node's loader path entirely; cli.ts is the ONLY module
  // in the tree carrying it. The embedded-binary behavior itself is verified
  // in Phase 3 (compile lane), not here.
  if (isCompiledBinary()) {
    const [resultSchema, reviewSchema, profileClaude, profileCodex, profileOpencode, profileKimi, pluginManifest] =
      await Promise.all([
        // @ts-ignore -- Bun 'text'-loader asset specifier; tsc cannot resolve it (no network for typecheck here — visually confirmed, Phase 3 verifies the compile lane).
        import('../../hydra/schemas/result.schema.json', { with: { type: 'text' } }),
        // @ts-ignore -- Bun 'text'-loader asset specifier; see above.
        import('../../hydra/schemas/review.schema.json', { with: { type: 'text' } }),
        // @ts-ignore -- Bun 'text'-loader asset specifier; see above.
        import('../../hydra/profiles/claude-fable-5.yaml', { with: { type: 'text' } }),
        // @ts-ignore -- Bun 'text'-loader asset specifier; see above.
        import('../../hydra/profiles/codex-gpt-5.6-sol.yaml', { with: { type: 'text' } }),
        // @ts-ignore -- Bun 'text'-loader asset specifier; see above.
        import('../../hydra/profiles/opencode-glm-5.2.yaml', { with: { type: 'text' } }),
        // @ts-ignore -- Bun 'text'-loader asset specifier; see above.
        import('../../hydra/profiles/kimi-k2.7-code.yaml', { with: { type: 'text' } }),
        // @ts-ignore -- Bun 'text'-loader asset specifier; see above. The
        // manifest is embedded so `version` reports the version the binary
        // was BUILT from, even when it runs outside any checkout.
        import('../../../.claude-plugin/plugin.json', { with: { type: 'text' } }),
      ]);
    initEmbeddedAssets({
      // The Bun text loader yields strings at runtime; tsc resolves the .json
      // specifiers to their parsed object types, hence the casts.
      'schemas/result.schema.json': resultSchema.default as unknown as string,
      'schemas/review.schema.json': reviewSchema.default as unknown as string,
      'profiles/claude-fable-5.yaml': profileClaude.default,
      'profiles/codex-gpt-5.6-sol.yaml': profileCodex.default,
      'profiles/opencode-glm-5.2.yaml': profileOpencode.default,
      'profiles/kimi-k2.7-code.yaml': profileKimi.default,
      'plugin.json': pluginManifest.default as unknown as string,
    });
  }
  process.exitCode = await route(process.argv.slice(2));
}
