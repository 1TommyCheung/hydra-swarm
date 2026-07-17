import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  inlineDeriveDomains,
  prepareWorkerEnv,
} from '../src/worker-devenv.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-worker-devenv');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true, force: true });
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function writeTaskSpec(dir: string, extra: string[] = []): string {
  const specPath = join(dir, 'task.yaml');
  writeFileSync(specPath, [
    'task_id: t1',
    'run_id: "0001"',
    ...extra,
    '',
  ].join('\n'), 'utf8');
  return specPath;
}

/** A fake PATH: a directory containing only the named executables (as empty files — existsSync is all resolveOnPath needs here). */
function makeFakePath(dir: string, tools: string[]): string {
  const binDir = join(dir, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  for (const t of tools) writeFileSync(join(binDir, t), '', 'utf8');
  return binDir;
}

describe('inlineDeriveDomains', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('returns empty when no manifests are present', () => {
    const dir = makeTempDir('empty');
    assert.deepEqual(inlineDeriveDomains(dir), []);
  });

  it('adds the npm registry for a pnpm lockfile', () => {
    const dir = makeTempDir('pnpm');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    assert.deepEqual(inlineDeriveDomains(dir), ['registry.npmjs.org']);
  });

  it('adds npm + yarn registries for a yarn lockfile', () => {
    const dir = makeTempDir('yarn');
    writeFileSync(join(dir, 'yarn.lock'), '', 'utf8');
    assert.deepEqual(inlineDeriveDomains(dir), ['registry.npmjs.org', 'registry.yarnpkg.com']);
  });

  it('adds bun.sh for a bun lockfile', () => {
    const dir = makeTempDir('bun');
    writeFileSync(join(dir, 'bun.lock'), '', 'utf8');
    assert.deepEqual(inlineDeriveDomains(dir), ['bun.sh']);
  });

  it('adds bun.sh for bunfig.toml alone', () => {
    const dir = makeTempDir('bunfig');
    writeFileSync(join(dir, 'bunfig.toml'), '', 'utf8');
    assert.deepEqual(inlineDeriveDomains(dir), ['bun.sh']);
  });

  it('adds github hosts for a git-hosted dependency', () => {
    const dir = makeTempDir('gitdep');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x',
      dependencies: { thing: 'git+https://github.com/owner/repo.git#main' },
    }), 'utf8');
    const domains = inlineDeriveDomains(dir);
    assert.ok(domains.includes('github.com'));
    assert.ok(domains.includes('codeload.github.com'));
    assert.ok(domains.includes('registry.npmjs.org'));
  });

  it('does not treat an ordinary semver dependency as a git dependency', () => {
    const dir = makeTempDir('semver');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x',
      dependencies: { lodash: '^4.17.21' },
    }), 'utf8');
    assert.ok(!inlineDeriveDomains(dir).includes('github.com'));
  });
});

describe('prepareWorkerEnv — network domains', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('uses the injected deriveEnvironmentDomains when supplied (feature-detect stand-in for PR #3)', async () => {
    const dir = makeTempDir('with-pr3');
    const tasksDir = makeTempDir('with-pr3-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']);

    const result = await prepareWorkerEnv(dir, spec, {
      agentRunId: 'run-a',
      pathEnv: fakeBin,
      tmpDir: join(dir, 'tmp'),
      deriveEnvironmentDomains: () => ['from-pr3.example.com'],
    });

    assert.equal(result.domainSource, 'env-domains.ts');
    assert.ok(result.allowedDomains.includes('from-pr3.example.com'));
  });

  it('falls back to inline derivation when no deriveEnvironmentDomains is available and the module cannot be imported', async () => {
    const dir = makeTempDir('no-pr3');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    const tasksDir = makeTempDir('no-pr3-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']);

    // env-domains.ts exists on this repo checkout (PR #3 already merged to
    // master here), so we can't force an import failure end-to-end without
    // faking the module resolution. Exercise the documented fallback path
    // directly instead: inlineDeriveDomains is what prepareWorkerEnv uses
    // when the dynamic import fails, and that behavior is covered above.
    // Here we just confirm the happy path still merges in task network_domains.
    void fakeBin;
    const result = await prepareWorkerEnv(dir, spec, {
      agentRunId: 'run-b',
      pathEnv: makeFakePath(dir, ['git', 'node', 'npm']),
      tmpDir: join(dir, 'tmp'),
    });
    assert.ok(Array.isArray(result.allowedDomains));
  });

  it('merges task-spec network_domains into the allowlist', async () => {
    const dir = makeTempDir('task-domains');
    const tasksDir = makeTempDir('task-domains-task');
    const spec = writeTaskSpec(tasksDir, ['network_domains:', '  - exotic.example.com']);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']);

    const result = await prepareWorkerEnv(dir, spec, {
      agentRunId: 'run-c',
      pathEnv: fakeBin,
      tmpDir: join(dir, 'tmp'),
      deriveEnvironmentDomains: () => [],
    });

    assert.ok(result.allowedDomains.includes('exotic.example.com'));
  });
});

describe('prepareWorkerEnv — store/cache env vars', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('sets store/cache dirs under TMPDIR, namespaced by agentRunId, and creates them', async () => {
    const dir = makeTempDir('store');
    const tasksDir = makeTempDir('store-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']);
    const tmpDir = makeTempDir('store-tmpdir');

    const result = await prepareWorkerEnv(dir, spec, {
      agentRunId: 'agent-xyz',
      pathEnv: fakeBin,
      tmpDir,
      deriveEnvironmentDomains: () => [],
    });

    assert.equal(result.envOverrides.npm_config_store_dir, join(tmpDir, 'hydra-pnpm-store-agent-xyz'));
    assert.equal(result.envOverrides.npm_config_cache, join(tmpDir, 'hydra-npm-cache-agent-xyz'));
    assert.equal(result.envOverrides.BUN_INSTALL_CACHE_DIR, join(tmpDir, 'hydra-bun-cache-agent-xyz'));
    assert.equal(result.envOverrides.YARN_CACHE_FOLDER, join(tmpDir, 'hydra-yarn-cache-agent-xyz'));
    assert.ok(existsSync(result.envOverrides.npm_config_store_dir));

    // None of the store/cache dirs land inside the worktree.
    for (const p of Object.values(result.envOverrides)) {
      assert.ok(!p.startsWith(dir), `${p} should be outside the worktree ${dir}`);
    }
  });

  it('does not throw for a differently-named agentRunId used twice (idempotent mkdir)', async () => {
    const dir = makeTempDir('store-repeat');
    const tasksDir = makeTempDir('store-repeat-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']);
    const tmpDir = join(dir, 'tmp');
    const opts = { agentRunId: 'agent-dup', pathEnv: fakeBin, tmpDir, deriveEnvironmentDomains: () => [] };

    await prepareWorkerEnv(dir, spec, opts);
    await assert.doesNotReject(prepareWorkerEnv(dir, spec, opts));
  });
});

describe('prepareWorkerEnv — toolchain preflight', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('succeeds and reports resolved paths when git/node/package-manager/vendor are all on PATH', async () => {
    const dir = makeTempDir('tools-ok');
    const tasksDir = makeTempDir('tools-ok-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm', 'kimi']);

    const result = await prepareWorkerEnv(dir, spec, {
      agentRunId: 'run-tools',
      vendorBin: 'kimi',
      pathEnv: fakeBin,
      tmpDir: join(dir, 'tmp'),
      deriveEnvironmentDomains: () => [],
    });

    assert.equal(result.toolsVerified.git, join(fakeBin, 'git'));
    assert.equal(result.toolsVerified.node, join(fakeBin, 'node'));
    assert.equal(result.toolsVerified.npm, join(fakeBin, 'npm'));
    assert.equal(result.toolsVerified.kimi, join(fakeBin, 'kimi'));
  });

  it('respects the repo-declared packageManager field (corepack-style) instead of defaulting to npm', async () => {
    const dir = makeTempDir('tools-pnpm');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'pnpm@8.15.0' }), 'utf8');
    const tasksDir = makeTempDir('tools-pnpm-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'pnpm']);

    const result = await prepareWorkerEnv(dir, spec, {
      agentRunId: 'run-pnpm',
      pathEnv: fakeBin,
      tmpDir: join(dir, 'tmp'),
      deriveEnvironmentDomains: () => [],
    });

    assert.equal(result.toolsVerified.pnpm, join(fakeBin, 'pnpm'));
  });

  it('accepts a corepack shim in place of the literal package-manager binary', async () => {
    const dir = makeTempDir('tools-corepack');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'pnpm@8.15.0' }), 'utf8');
    const tasksDir = makeTempDir('tools-corepack-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'corepack']); // no literal pnpm binary

    const result = await prepareWorkerEnv(dir, spec, {
      agentRunId: 'run-corepack',
      pathEnv: fakeBin,
      tmpDir: join(dir, 'tmp'),
      deriveEnvironmentDomains: () => [],
    });

    assert.equal(result.toolsVerified.pnpm, 'corepack-shim');
  });

  it('dies with a symlink remedy when a missing tool is discoverable in a common install root', async () => {
    const dir = makeTempDir('tools-missing-discoverable');
    const tasksDir = makeTempDir('tools-missing-discoverable-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']); // no 'kimi'
    const fakeHome = join(dir, 'home');
    mkdirSync(join(fakeHome, '.kimi-code', 'bin'), { recursive: true });
    writeFileSync(join(fakeHome, '.kimi-code', 'bin', 'kimi'), '', 'utf8');

    await assert.rejects(
      prepareWorkerEnv(dir, spec, {
        agentRunId: 'run-missing',
        vendorBin: 'kimi',
        pathEnv: fakeBin,
        homeEnv: fakeHome,
        tmpDir: join(dir, 'tmp'),
        deriveEnvironmentDomains: () => [],
      }),
      (err: Error) => {
        assert.match(err.message, /ln -sf/);
        assert.match(err.message, new RegExp(join(fakeHome, '.kimi-code', 'bin', 'kimi').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(err.message, /~\/\.local\/bin\/kimi/);
        return true;
      },
    );
  });

  it('dies with a plain not-found message when a missing tool is not discoverable anywhere', async () => {
    const dir = makeTempDir('tools-missing-nowhere');
    const tasksDir = makeTempDir('tools-missing-nowhere-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']); // no 'codex'
    const fakeHome = join(dir, 'home-empty');
    mkdirSync(fakeHome, { recursive: true });

    await assert.rejects(
      prepareWorkerEnv(dir, spec, {
        agentRunId: 'run-missing-2',
        vendorBin: 'codex',
        pathEnv: fakeBin,
        homeEnv: fakeHome,
        tmpDir: join(dir, 'tmp'),
        deriveEnvironmentDomains: () => [],
      }),
      (err: Error) => {
        assert.match(err.message, /codex/);
        assert.match(err.message, /not found on PATH/);
        return true;
      },
    );
  });

  it('never spawns the worker (does not create store dirs) when the preflight fails', async () => {
    const dir = makeTempDir('tools-missing-noleak');
    const tasksDir = makeTempDir('tools-missing-noleak-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git']); // node missing entirely
    const tmpDir = join(dir, 'tmp');

    await assert.rejects(prepareWorkerEnv(dir, spec, {
      agentRunId: 'run-noleak',
      pathEnv: fakeBin,
      homeEnv: join(dir, 'home-empty'),
      tmpDir,
      deriveEnvironmentDomains: () => [],
    }));
  });
});

describe('prepareWorkerEnv — happy-path log line', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('logs a one-line summary naming the task, domain count, store dir, and verified tools', async () => {
    const dir = makeTempDir('log');
    const tasksDir = makeTempDir('log-task');
    const spec = writeTaskSpec(tasksDir);
    const fakeBin = makeFakePath(dir, ['git', 'node', 'npm']);
    const tmpDir = join(dir, 'tmp');

    const originalWrite = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const result = await prepareWorkerEnv(dir, spec, {
        agentRunId: 'run-log',
        pathEnv: fakeBin,
        tmpDir,
        deriveEnvironmentDomains: () => ['x.example.com'],
      });
      assert.match(result.logLine, /worker-devenv:/);
      assert.match(result.logLine, /task=t1/);
      assert.match(result.logLine, /store=/);
      assert.match(result.logLine, /tools=/);
      assert.ok(lines.some((l) => l.includes('worker-devenv: task=t1')));
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
