// Tests for src/kit-assets.ts (Stage 1 Phase 2 asset resolution) AND the
// per-call-site wiring of the 8 migrated asset reads.
//
// Why the per-call-site tests live in THIS file: the task's writable_paths
// make every other test file read-only, and the binding constraints are
// "edit only writable paths" + "zero regressions". So the required
// override-precedence (a) and default-resolution (b) tests for allocate,
// create-worktree, graph-impact, promote, record-review, integrate, and
// review-required are colocated here. Pre-existing tests in the per-module
// test files keep passing unchanged and are noted per case.
//
// Fixture roots live under os.tmpdir() so the suite also runs where git
// cannot init inside the checkout (see docs/bun-migration-stage2-assets.md).
//
// NOT tested here (needs a real `bun build --compile`, deferred to Phase 3):
// isCompiledBinary() === true, the embedded map being populated by cli.ts's
// `with: { type: 'text' }` imports, and reads from a moved/deleted checkout.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { allocate } from '../src/allocate.ts';
import { createWorktree } from '../src/create-worktree.ts';
import { graphImpact, GraphImpactError } from '../src/graph-impact.ts';
import {
  initEmbeddedAssets,
  isCompiledBinary,
  kitAssetPath,
  kitAssetText,
} from '../src/kit-assets.ts';
import { promote, PromoteError } from '../src/promote.ts';
import { recordReview, RecordReviewError } from '../src/record-review.ts';
import { reviewRequired } from '../src/review-required.ts';

// The real dev checkout this test file runs inside.
const CHECKOUT = realpathSync(resolve(import.meta.dirname, '..', '..', '..'));
const KIT = join(CHECKOUT, 'kit', 'hydra');
const SRC = join(CHECKOUT, 'kit', 'hydra-ts', 'src');

const TEST_TMP = join(tmpdir(), 'hydra-kit-assets-test');

const ORIGINAL_ENV = {
  HYDRA_STATE_ROOT: process.env.HYDRA_STATE_ROOT,
  HYDRA_VERIFY_POLICY: process.env.HYDRA_VERIFY_POLICY,
  HYDRA_WAVE: process.env.HYDRA_WAVE,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, uniqueName(prefix));
  mkdirSync(p, { recursive: true });
  return p;
}

function initGitRepo(dir: string): string {
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8');
  execFileSync('git', ['-C', dir, 'add', 'README.md'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { stdio: 'ignore' });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

before(() => mkdirSync(TEST_TMP, { recursive: true }));
after(() => {
  rmSync(TEST_TMP, { recursive: true, force: true });
  restoreEnv();
});

describe('kitAssetPath', () => {
  it('finds existing files under the kit/hydra base of the current checkout', () => {
    assert.equal(kitAssetPath('WAVE'), join(KIT, 'WAVE'));
    assert.equal(kitAssetPath('schemas/result.schema.json'), join(KIT, 'schemas', 'result.schema.json'));
    assert.equal(kitAssetPath('schemas/review.schema.json'), join(KIT, 'schemas', 'review.schema.json'));
    assert.equal(kitAssetPath('policies/verification.yaml'), join(KIT, 'policies', 'verification.yaml'));
    assert.equal(kitAssetPath('policies/review-policy.yaml'), join(KIT, 'policies', 'review-policy.yaml'));
    assert.equal(kitAssetPath('profiles/claude-fable-5.yaml'), join(KIT, 'profiles', 'claude-fable-5.yaml'));
  });

  it('finds an existing file under the hydra base (installed layout)', () => {
    const fixtureRepo = makeTempDir('installed-layout');
    initGitRepo(fixtureRepo);
    mkdirSync(join(fixtureRepo, 'hydra'), { recursive: true });
    writeFileSync(join(fixtureRepo, 'hydra', 'WAVE'), '9\n', 'utf8');

    const originalCwd = process.cwd();
    process.chdir(fixtureRepo);
    try {
      assert.equal(
        kitAssetPath('WAVE'),
        join(realpathSync(fixtureRepo), 'hydra', 'WAVE'),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('falls back to the installed-layout path when the asset exists nowhere', () => {
    assert.equal(
      kitAssetPath('no-such-asset.xyz'),
      join(CHECKOUT, 'hydra', 'no-such-asset.xyz'),
    );
  });

  it('source lane falls back to source-relative when cwd is outside any repo', () => {
    const outside = makeTempDir('outside-repo');
    const originalCwd = process.cwd();
    process.chdir(outside);
    try {
      assert.equal(kitAssetPath('WAVE'), join(KIT, 'WAVE'));
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('kitAssetText', () => {
  it('falls through to the checkout file when no embedded map is registered', () => {
    assert.equal(kitAssetText('WAVE'), readFileSync(join(KIT, 'WAVE'), 'utf8'));
    assert.equal(
      kitAssetText('schemas/result.schema.json'),
      readFileSync(join(KIT, 'schemas', 'result.schema.json'), 'utf8'),
    );
  });

  it('prefers the embedded map after initEmbeddedAssets, other keys still fall through', () => {
    try {
      initEmbeddedAssets({ WAVE: 'embedded-wave-for-test\n' });
      assert.equal(kitAssetText('WAVE'), 'embedded-wave-for-test\n');
      // A key not present in the map still reads the checkout file.
      assert.equal(
        kitAssetText('schemas/review.schema.json'),
        readFileSync(join(KIT, 'schemas', 'review.schema.json'), 'utf8'),
      );
    } finally {
      // Reset to an empty map so later tests in this file fall through.
      initEmbeddedAssets({});
    }
  });
});

describe('isCompiledBinary', () => {
  it('is false under plain Node (source lane)', () => {
    // The true case requires an actual `bun build --compile` binary
    // (import.meta.url === file:///$bunfs/...); Phase 3 verifies that lane.
    assert.equal(isCompiledBinary(), false);
  });

  it('is false for a /$bunfs-rooted checkout URL under plain Node (the review collision)', () => {
    // Stage 4 review bug #3: a repository physically checked out at a
    // root-level /$bunfs/... path (legal, e.g. in a root-run container) gives
    // modules file:///$bunfs/... URLs under ORDINARY Node. The URL prefix
    // alone must not decide compiled-ness — without the Bun-only
    // process.versions.bun marker the answer stays false, so the 34
    // direct-invocation guards keep working in that checkout.
    assert.equal(
      isCompiledBinary(
        'file:///$bunfs/checkout/kit/hydra-ts/src/kit-assets.ts',
        {} as NodeJS.ProcessVersions,
      ),
      false,
    );
  });

  it('is true only when BOTH the $bunfs URL prefix and process.versions.bun hold', () => {
    const bunVersions = { bun: '1.2.3' } as unknown as NodeJS.ProcessVersions;
    // The compiled-binary shape: synthetic URL + Bun runtime marker.
    assert.equal(
      isCompiledBinary('file:///$bunfs/root/kit-assets.ts', bunVersions),
      true,
    );
    // A Bun runtime WITHOUT the synthetic prefix (ordinary `bun script.ts`
    // source run) is not a compiled binary.
    assert.equal(
      isCompiledBinary('file:///home/user/checkout/kit-assets.ts', bunVersions),
      false,
    );
    // Node runtime WITHOUT the prefix: the everyday source lane.
    assert.equal(
      isCompiledBinary(
        'file:///home/user/checkout/kit-assets.ts',
        {} as NodeJS.ProcessVersions,
      ),
      false,
    );
  });
});

describe('cli.ts asset-import quarantine', () => {
  it('cli.ts is the only src module carrying `with { type: ... }` asset imports', () => {
    const offenders: string[] = [];
    // Match the attribute SYNTAX (static `from '...' with { type: ... }` or
    // dynamic `{ with: { type: ... } }`), not prose mentions in comments.
    const staticAttr = /from\s+['"][^'"]+['"]\s+with\s*\{\s*type\s*:/;
    const dynamicAttr = /with:\s*\{\s*type\s*:/;
    for (const entry of readdirSync(SRC)) {
      if (!entry.endsWith('.ts')) continue;
      const content = readFileSync(join(SRC, entry), 'utf8');
      if (staticAttr.test(content) || dynamicAttr.test(content)) {
        offenders.push(entry);
      }
    }
    assert.deepEqual(offenders, ['cli.ts']);
  });
});

describe('allocate kit-asset wiring', () => {
  it('(a) profilesDir override still wins over the kit-assets default', () => {
    const profilesDir = makeTempDir('profiles');
    const stateRoot = makeTempDir('state');
    mkdirSync(join(stateRoot, 'agents', 'profiles'), { recursive: true });
    for (const [vendor, file] of Object.entries({
      claude: 'claude-fable-5.yaml',
      codex: 'codex-gpt-5.6-sol.yaml',
      kimi: 'kimi-k2.7-code.yaml',
    })) {
      const hint = vendor === 'claude' ? 'override_marker_xyz' : 'subscription';
      writeFileSync(join(profilesDir, file), `cost_hint: ${hint}\n`, 'utf8');
    }

    const result = allocate('implementer', 'feature', 'medium', '', { profilesDir, stateRoot });
    const claude = result.ranked.find((c) => c.vendor === 'claude');
    // The real checkout seed says subscription_or_api; the marker proves the
    // override directory was consulted instead.
    assert.equal(claude?.cost_hint, 'override_marker_xyz');
  });

  it('(b) without profilesDir, seeds resolve from the real checkout via kit-assets', () => {
    const stateRoot = makeTempDir('state');
    mkdirSync(join(stateRoot, 'agents', 'profiles'), { recursive: true });

    const result = allocate('integrator', 'merge', 'low', '', { stateRoot });
    const claude = result.ranked.find((c) => c.vendor === 'claude');
    const codex = result.ranked.find((c) => c.vendor === 'codex');
    assert.equal(claude?.cost_hint, 'subscription_or_api');
    assert.equal(codex?.cost_hint, '5.0/30.0');
  });
});

describe('create-worktree WAVE wiring', () => {
  function setupFixture(runId: string, taskId: string): {
    repoRoot: string;
    stateRoot: string;
    worktreeRoot: string;
    headCommit: string;
  } {
    const repoRoot = makeTempDir('repo');
    const headCommit = initGitRepo(repoRoot);
    const stateRoot = makeTempDir('state');
    const worktreeRoot = makeTempDir('worktrees');

    const taskDir = join(stateRoot, 'runs', `run-${runId}`, 'tasks');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, `${taskId}.yaml`),
      `task_id: ${taskId}\nrun_id: ${runId}\nspec_version: 1\nbase_commit: ${headCommit}\n`,
      'utf8',
    );

    // common steps always succeed; wave_1 steps always FAIL — so a wave level
    // >= 1 is fatal, proving which WAVE source drove the decision.
    const policyDir = join(repoRoot, 'kit', 'hydra', 'policies');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'bootstrap.yaml'),
      'bootstrap:\n  common:\n    - "true"\n__wave_1_block__:\n  wave_1:\n    - "false"\n',
      'utf8',
    );

    return { repoRoot, stateRoot, worktreeRoot, headCommit };
  }

  it('(a) wavePath option overrides the checkout WAVE (real value: 2)', () => {
    const runId = uniqueName('wave-override');
    const taskId = 'task-wave-override';
    const f = setupFixture(runId, taskId);
    const waveOverride = join(TEST_TMP, `${uniqueName('WAVE')}`);
    writeFileSync(waveOverride, '0\n', 'utf8');

    process.env.HYDRA_STATE_ROOT = f.stateRoot;
    try {
      // The real checkout WAVE is 2 (would run the failing wave_1 step); the
      // override file says 0, so bootstrap must succeed.
      const worktree = createWorktree(runId, taskId, undefined, {
        repoRoot: f.repoRoot,
        stateRoot: f.stateRoot,
        worktreeRoot: f.worktreeRoot,
        wavePath: waveOverride,
      });
      assert.ok(existsSync(worktree));
    } finally {
      restoreEnv();
    }
  });

  it('(a, control) a wavePath >= 1 runs wave_1 steps (and fails here)', () => {
    const runId = uniqueName('wave-control');
    const taskId = 'task-wave-control';
    const f = setupFixture(runId, taskId);
    const waveOverride = join(TEST_TMP, `${uniqueName('WAVE')}`);
    writeFileSync(waveOverride, '2\n', 'utf8');

    process.env.HYDRA_STATE_ROOT = f.stateRoot;
    try {
      assert.throws(
        () =>
          createWorktree(runId, taskId, undefined, {
            repoRoot: f.repoRoot,
            stateRoot: f.stateRoot,
            worktreeRoot: f.worktreeRoot,
            wavePath: waveOverride,
          }),
        /bootstrap failed/,
      );
    } finally {
      restoreEnv();
    }
  });

  // (b) default resolution: kitAssetPath('WAVE') === <checkout>/kit/hydra/WAVE
  // is asserted in the kitAssetPath suite above; the existing
  // create-worktree.test.ts wave-file test keeps passing unchanged and covers
  // the no-override path (HYDRA_WAVE env precedence is covered there too).
});

describe('graph-impact freshness-gate wiring', () => {
  it('(b) with no freshnessGatePath dep, the gate runs in-process via freshness-gate.ts', () => {
    const stateRoot = makeTempDir('state');
    const runId = uniqueName('gi');
    const taskId = 'task-gi';
    const taskDir = join(stateRoot, 'runs', `run-${runId}`, 'tasks');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, `${taskId}.yaml`), `task_id: ${taskId}\nrun_id: ${runId}\n`, 'utf8');

    const gitnexus = join(TEST_TMP, uniqueName('gitnexus'));
    writeFileSync(gitnexus, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    process.env.HYDRA_STATE_ROOT = stateRoot;
    try {
      // No manifest exists, so the REAL freshnessGate (freshness-gate.ts,
      // called in-process — no freshness-gate.sh involved) reports stale.
      assert.throws(
        () => graphImpact(runId, taskId, { gitnexusPath: gitnexus }),
        (error: unknown) => error instanceof GraphImpactError && error.exitCode === 8,
      );
      const ledgerPath = join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
      assert.ok(readFileSync(ledgerPath, 'utf8').includes('stale_omitted'));
    } finally {
      restoreEnv();
    }
  });

  // (a) the freshnessGatePath dep keeps its out-of-process behavior — covered
  // by the six pre-existing graph-impact.test.ts tests that inject mock gate
  // scripts (unchanged, still passing).
});

describe('promote kit-asset wiring', () => {
  function validDrop(runId: string, taskId: string, overrides: Record<string, unknown> = {}): string {
    const drop = join(TEST_TMP, uniqueName('drop'));
    writeFileSync(
      drop,
      `${JSON.stringify({
        task_id: taskId,
        run_id: runId,
        spec_version: 1,
        vendor: 'claude',
        status: 'completed',
        branch: 'test-branch',
        base_commit: 'base',
        head_commit: 'head',
        files_changed: [],
        verification_claims: [],
        ...overrides,
      })}\n`,
      'utf8',
    );
    return drop;
  }

  function writeTaskSpec(
    runId: string,
    taskId: string,
    stateRoot: string,
    options: { specVersion?: number; extra?: string } = {},
  ): void {
    const taskDir = join(stateRoot, 'runs', `run-${runId}`, 'tasks');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, `${taskId}.yaml`),
      `task_id: ${taskId}\nrun_id: ${runId}\nspec_version: ${options.specVersion ?? 1}\n${options.extra ?? ''}`,
      'utf8',
    );
  }

  it('(a) options.schema override wins over the kit-assets default schema', async () => {
    const stateRoot = makeTempDir('state');
    const runId = uniqueName('promote-schema-override');
    const taskId = 'task-schema-override';
    writeTaskSpec(runId, taskId, stateRoot);
    // Valid per the real result.schema.json, but the override schema demands a
    // field nothing has — if the override were ignored, validation would pass.
    const schema = join(TEST_TMP, uniqueName('schema'));
    writeFileSync(
      schema,
      JSON.stringify({ type: 'object', required: ['zzz_never_present'] }),
      'utf8',
    );

    await assert.rejects(
      promote(runId, taskId, validDrop(runId, taskId), { stateRoot, schema }),
      (error: unknown) => error instanceof PromoteError && error.reason === 'schema_invalid',
    );
  });

  it('(b) without options.schema, the default resolves the real checkout schema', async () => {
    const stateRoot = makeTempDir('state');
    const runId = uniqueName('promote-schema-default');
    const taskId = 'task-schema-default';
    // Task spec at spec_version 2 while the drop claims 1: reachable ONLY
    // after the (real) default schema has accepted the drop.
    writeTaskSpec(runId, taskId, stateRoot, { specVersion: 2 });

    await assert.rejects(
      promote(runId, taskId, validDrop(runId, taskId), { stateRoot }),
      (error: unknown) => error instanceof PromoteError && error.reason === 'stale_spec',
    );
  });

  async function promoteToVerification(envPolicy: string | undefined): Promise<string> {
    const stateRoot = makeTempDir('state');
    const runId = uniqueName('promote-policy');
    const taskId = 'task-policy';
    const repoRoot = makeTempDir('repo');

    const base = initGitRepo(repoRoot);
    writeFileSync(join(repoRoot, 'feature.txt'), 'feature\n', 'utf8');
    execFileSync('git', ['-C', repoRoot, 'add', 'feature.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'feature'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'branch', 'test-branch'], { stdio: 'ignore' });
    const head = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'test-branch'], { encoding: 'utf8' }).trim();

    writeTaskSpec(
      runId,
      taskId,
      stateRoot,
      { extra: `worktree: ${repoRoot}\nbranch: test-branch\nbase_commit: ${base}\nwritable_paths:\n  - "*"\n` },
    );
    const drop = validDrop(runId, taskId, { base_commit: base, head_commit: head, files_changed: ['feature.txt'] });

    const captured: string[] = [];
    if (envPolicy === undefined) {
      delete process.env.HYDRA_VERIFY_POLICY;
    } else {
      process.env.HYDRA_VERIFY_POLICY = envPolicy;
    }
    try {
      await promote(runId, taskId, drop, {
        stateRoot,
        audit: () => ({ clean: true, violations: [] }),
        verify: async (_worktree, policy, out) => {
          captured.push(policy);
          const observed = [{ command: 'test pass', status: 'passed' as const }];
          assert.ok(out);
          writeFileSync(out, `${JSON.stringify(observed)}\n`, 'utf8');
          return observed;
        },
      });
    } finally {
      restoreEnv();
    }
    return captured[0];
  }

  it('(a) HYDRA_VERIFY_POLICY wins over the kit-assets default policy', async () => {
    const policy = await promoteToVerification('/custom/operator-verification.yaml');
    assert.equal(policy, '/custom/operator-verification.yaml');
  });

  it('(b) without HYDRA_VERIFY_POLICY, the default resolves the real checkout policy', async () => {
    const policy = await promoteToVerification(undefined);
    assert.equal(policy, kitAssetPath('policies/verification.yaml'));
    assert.equal(policy, join(KIT, 'policies', 'verification.yaml'));
    assert.ok(existsSync(policy));
  });
});

describe('record-review kit-asset wiring', () => {
  function validVerdict(taskId: string): string {
    const verdict = join(TEST_TMP, uniqueName('verdict'));
    writeFileSync(
      verdict,
      `${JSON.stringify({
        task_id: taskId,
        verdict: 'accept',
        reviewed_base: 'base',
        reviewed_head: 'head',
        reviewer: 'codex',
        risk: 'low',
      })}\n`,
      'utf8',
    );
    return verdict;
  }

  it('(a) schemaPath override wins over the kit-assets default schema', () => {
    const stateRoot = makeTempDir('state');
    const runId = uniqueName('review-schema-override');
    const taskId = 'task-review-override';
    const schema = join(TEST_TMP, uniqueName('schema'));
    writeFileSync(
      schema,
      JSON.stringify({ type: 'object', required: ['zzz_never_present'] }),
      'utf8',
    );

    assert.throws(
      () => recordReview(runId, taskId, validVerdict(taskId), { stateRoot, schemaPath: schema }),
      (error: unknown) => error instanceof RecordReviewError,
    );
  });

  it('(b) without schemaPath, the default resolves the real checkout schema', () => {
    const stateRoot = makeTempDir('state');
    const runId = uniqueName('review-schema-default');
    const taskId = 'task-review-default';

    const out = recordReview(runId, taskId, validVerdict(taskId), { stateRoot });
    assert.ok(existsSync(out));
    const recorded = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    assert.equal(recorded.verdict, 'accept');
    assert.equal(recorded.reviewer, 'codex');
  });
});

describe('review-required kit-asset wiring', () => {
  it('(a) policyFile option wins over the kit-assets default policy', () => {
    const policy = join(TEST_TMP, uniqueName('review-policy'));
    writeFileSync(
      policy,
      'review_policy:\n  cross_vendor_required_when:\n    risk_at_least: low\n  cross_vendor_pairing:\n    claude: codex\n',
      'utf8',
    );
    // The real checkout policy requires risk >= high; the override says low.
    const decision = reviewRequired('claude', 'low', [], { policyFile: policy });
    assert.equal(decision.cross_vendor_required, true);
    assert.equal(decision.reviewer_vendor, 'codex');
  });

  it('(b) without policyFile, the default resolves the real checkout policy', () => {
    const required = reviewRequired('claude', 'critical', []);
    assert.equal(required.cross_vendor_required, true);
    assert.equal(required.reviewer_vendor, 'codex');

    const notRequired = reviewRequired('claude', 'low', []);
    assert.equal(notRequired.cross_vendor_required, false);
    assert.equal(notRequired.reviewer_vendor, 'any');
  });
});

// integrate.ts verify-policy wiring: covered by the pre-existing
// integrate.test.ts tests 'uses non-empty verify and smoke policy overrides'
// (HYDRA_VERIFY_POLICY / HYDRA_SMOKE_POLICY precedence) and 'treats empty
// policy overrides as unset' (default resolution, whose expected path equals
// kitAssetPath('policies/verification.yaml') when run from this checkout).
// Those tests are read-only under this task's writable_paths and keep passing.
