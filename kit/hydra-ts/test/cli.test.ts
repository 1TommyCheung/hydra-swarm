// Tests for the Stage 1 (Phase 1b) single-entry CLI router, src/cli.ts.
//
// Three layers:
//   1. Table identity — routes[name] must BE the main() exported by <name>.ts
//      (imports here are independent of cli.ts's own imports, so a miswired
//      table entry fails loudly).
//   2. route() dispatch — every subcommand dispatches to exactly its own slot
//      (spy registry) and to no other file's slot; sync and async return
//      values are both awaited and passed through; unknown/missing subcommand
//      prints the usage listing to stderr and returns 1.
//   3. End-to-end — real child processes compare
//      `node --experimental-strip-types src/cli.ts <sub> <args>` against the
//      old direct invocation `node --experimental-strip-types src/<file>.ts
//      <args>` byte-for-byte (stdout, stderr, exit code).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { route, routes, usage, type MainFn } from '../src/cli.ts';

import { main as adapterClaudeMain } from '../src/adapter-claude.ts';
import { main as adapterCodexMain } from '../src/adapter-codex.ts';
import { main as adapterKimiMain } from '../src/adapter-kimi.ts';
import { main as adapterOpencodeMain } from '../src/adapter-opencode.ts';
import { main as adapterStubMain } from '../src/adapter-stub.ts';
import { main as aggregateUsageMain } from '../src/aggregate-usage.ts';
import { main as allocateMain } from '../src/allocate.ts';
import { main as amendTaskMain } from '../src/amend-task.ts';
import { main as auditOwnershipMain } from '../src/audit-ownership.ts';
import { main as buildWorkerPromptMain } from '../src/build-worker-prompt.ts';
import { main as cancelTaskMain } from '../src/cancel-task.ts';
import { main as codeIntelMain } from '../src/code-intel.ts';
import { main as createWorktreeMain } from '../src/create-worktree.ts';
import { main as dispatchMain } from '../src/dispatch.ts';
import { main as freshnessGateMain } from '../src/freshness-gate.ts';
import { main as graphImpactMain } from '../src/graph-impact.ts';
import { main as graphifyBaselineMain } from '../src/graphify-baseline.ts';
import { main as graphifyInvestigateMain } from '../src/graphify-investigate.ts';
import { main as graphifyRepoMain } from '../src/graphify-repo.ts';
import { main as herdrPushMain } from '../src/herdr-push.ts';
import { main as indexCandidateMain } from '../src/index-candidate.ts';
import { main as integrateMain } from '../src/integrate.ts';
import { main as ledgerViewMain } from '../src/ledger-view.ts';
import { main as measureDivergenceMain } from '../src/measure-divergence.ts';
import { main as otelEnvMain } from '../src/otel-env.ts';
import { main as promoteMain } from '../src/promote.ts';
import { main as recordReviewMain } from '../src/record-review.ts';
import { main as recordUsageMain } from '../src/record-usage.ts';
import { main as reviewDispatchMain } from '../src/review-dispatch.ts';
import { main as reviewRequiredMain } from '../src/review-required.ts';
import { main as runInitMain } from '../src/run-init.ts';
import { main as squashMain } from '../src/squash.ts';
import { main as statusMain } from '../src/status.ts';
import { main as verifyMain } from '../src/verify.ts';

const SRC_DIR = join(import.meta.dirname, '..', 'src');
const CLI_PATH = join(SRC_DIR, 'cli.ts');
const TEST_TMP = join(import.meta.dirname, 'tmp-cli');

// name -> the main() that <name>.ts actually exports. Kept independent of
// cli.ts so the wiring is cross-checked, not self-referential.
const EXPECTED: Record<string, MainFn> = {
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

const SUBCOMMANDS = Object.keys(EXPECTED).sort();

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

interface SpyRegistry {
  registry: Record<string, MainFn>;
  calls: Map<string, string[][]>;
}

// Every slot gets a recording spy that returns a distinctive non-zero code,
// so a dispatch to the wrong slot (or an extra call) is always observable.
function makeSpies(): SpyRegistry {
  const calls = new Map<string, string[][]>();
  const registry: Record<string, MainFn> = {};
  SUBCOMMANDS.forEach((name, index) => {
    calls.set(name, []);
    registry[name] = (args: string[]) => {
      calls.get(name)?.push(args);
      return 40 + index;
    };
  });
  return { registry, calls };
}

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let collected = '';
  process.stderr.write = ((chunk: unknown) => {
    collected += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stderr: collected };
  } finally {
    process.stderr.write = original;
  }
}

describe('cli router table', () => {
  it('covers exactly the 34 Stage-1 subcommands', () => {
    assert.deepEqual(Object.keys(routes).sort(), SUBCOMMANDS);
  });

  for (const name of SUBCOMMANDS) {
    it(`routes['${name}'] is the main() exported by ${name}.ts`, () => {
      assert.equal(routes[name], EXPECTED[name]);
    });
  }
});

describe('cli route() dispatch', () => {
  for (const name of SUBCOMMANDS) {
    it(`'${name}' dispatches to its own main() and no other`, async () => {
      const { registry, calls } = makeSpies();
      const probeArgs = ['--usage-error-probe', 'extra-arg'];
      const code = await route([name, ...probeArgs], registry);

      assert.deepEqual(calls.get(name), [probeArgs], `${name} slot must receive argv.slice(1) unchanged`);
      assert.equal(code, 40 + SUBCOMMANDS.indexOf(name), 'route must return the slot main() exit code');
      for (const other of SUBCOMMANDS) {
        if (other !== name) {
          assert.deepEqual(calls.get(other), [], `no call expected into ${other}`);
        }
      }
    });
  }

  it('passes a sync main() return value through', async () => {
    const code = await route(['status', 'x'], { status: () => 7 });
    assert.equal(code, 7);
  });

  it('awaits an async main() and passes its return value through', async () => {
    const code = await route(['verify', 'x'], { verify: async () => 9 });
    assert.equal(code, 9);
  });

  it('unknown subcommand prints usage to stderr and returns 1', async () => {
    const { registry, calls } = makeSpies();
    const { code, stderr } = await captureStderr(() => route(['no-such-subcommand'], registry));
    assert.equal(code, 1);
    assert.ok(stderr.startsWith('Usage: hydra <subcommand> [args...]'), 'usage banner expected on stderr');
    for (const name of SUBCOMMANDS) {
      assert.ok(stderr.includes(`  ${name}\n`), `usage must list '${name}'`);
      assert.deepEqual(calls.get(name), [], `no dispatch expected for '${name}'`);
    }
  });

  it('missing subcommand prints usage to stderr and returns 1', async () => {
    const { code, stderr } = await captureStderr(() => route([]));
    assert.equal(code, 1);
    assert.ok(stderr.includes('Usage: hydra <subcommand> [args...]'));
  });

  it('usage() lists every subcommand exactly once', () => {
    const text = usage();
    for (const name of SUBCOMMANDS) {
      assert.equal(text.split(`  ${name}\n`).length - 1, 1, `'${name}' must appear exactly once`);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: cli.ts child process vs. direct <file>.ts child process.
// ---------------------------------------------------------------------------

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function nodeRun(scriptPath: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', scriptPath, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Cross-check: identical args through the router and directly must produce
// byte-identical stdout/stderr and the same exit code.
function assertSameAsDirect(subcommand: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  const viaCli = nodeRun(CLI_PATH, [subcommand, ...args], env);
  const direct = nodeRun(join(SRC_DIR, `${subcommand}.ts`), args, env);
  assert.equal(viaCli.status, direct.status, `exit code mismatch for '${subcommand}'`);
  assert.equal(viaCli.stdout, direct.stdout, `stdout mismatch for '${subcommand}'`);
  assert.equal(viaCli.stderr, direct.stderr, `stderr mismatch for '${subcommand}'`);
  return viaCli;
}

describe('cli end-to-end (child process)', { concurrency: 1 }, () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('status (sync main) — usage error matches direct invocation', () => {
    const result = assertSameAsDirect('status', ['--lines', 'not-a-number'], {});
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('usage: status'), result.stderr);
  });

  it('otel-env (sync main, no args) — success output matches direct invocation', () => {
    const result = assertSameAsDirect('otel-env', [], { HYDRA_STATE_ROOT: join(TEST_TMP, 'otel-state') });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('export '), result.stdout);
  });

  it('allocate (sync main) — success JSON matches direct invocation', () => {
    const stateRoot = join(TEST_TMP, 'allocate-state');
    mkdirSync(join(stateRoot, 'agents', 'profiles'), { recursive: true });
    const result = assertSameAsDirect('allocate', ['implementer', 'code_review', 'high'], { HYDRA_STATE_ROOT: stateRoot });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed.role, 'implementer');
    assert.equal(parsed.task_type, 'code_review');
  });

  it('verify (async main) — usage error matches direct invocation', () => {
    const result = assertSameAsDirect('verify', [], {});
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('usage: verify'), result.stderr);
  });

  it('adapter-claude (sync adapter) — verb-less usage error matches direct invocation', () => {
    const result = assertSameAsDirect('adapter-claude', [], {});
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('usage: claude.sh'), result.stderr);
  });

  it('adapter-codex (async adapter) — verb-less usage error matches direct invocation', () => {
    const result = assertSameAsDirect('adapter-codex', [], {});
    assert.equal(result.status, 1);
    assert.ok(result.stderr.length > 0, 'adapter-codex usage error expected on stderr');
  });

  it('unknown subcommand exits 1 with the full usage listing on stderr', () => {
    const result = nodeRun(CLI_PATH, ['no-such-subcommand'], {});
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith('Usage: hydra <subcommand> [args...]'), result.stderr);
    for (const name of SUBCOMMANDS) {
      assert.ok(result.stderr.includes(`  ${name}\n`), `usage must list '${name}'`);
    }
  });
});
