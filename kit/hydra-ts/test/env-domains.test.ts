import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveEnvironmentDomains,
  deriveEnvironmentDomainsDetailed,
  formatDerivedDomainsLog,
  persistDerivedDomains,
} from '../src/env-domains.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-env-domains');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

describe('deriveEnvironmentDomains', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('returns empty when no manifests are present', () => {
    const dir = makeTempDir('empty');
    assert.deepEqual(deriveEnvironmentDomains(dir), []);
  });

  it('adds the npm registry for package-lock.json', () => {
    const dir = makeTempDir('npm-lock');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    writeFileSync(join(dir, 'package-lock.json'), '{}', 'utf8');
    assert.deepEqual(deriveEnvironmentDomains(dir), ['registry.npmjs.org']);
  });

  it('adds the npm and yarn registries for yarn.lock', () => {
    const dir = makeTempDir('yarn-lock');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    writeFileSync(join(dir, 'yarn.lock'), '', 'utf8');
    assert.deepEqual(deriveEnvironmentDomains(dir), ['registry.npmjs.org', 'registry.yarnpkg.com']);
  });

  it('adds the npm registry for pnpm-lock.yaml alone (no package.json required)', () => {
    const dir = makeTempDir('pnpm-lock-only');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    assert.deepEqual(deriveEnvironmentDomains(dir), ['registry.npmjs.org']);
  });

  it('adds the github domain set for a git-hosted dependency in the root package.json', () => {
    const dir = makeTempDir('git-dep-root');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'root',
      dependencies: { 'live-hmr-feedback': 'git+https://github.com/1TommyCheung/live-hmr-feedback.git#v1.3.0' },
    }), 'utf8');
    const domains = deriveEnvironmentDomains(dir);
    assert.ok(domains.includes('github.com'));
    assert.ok(domains.includes('codeload.github.com'));
    assert.ok(domains.includes('objects.githubusercontent.com'));
    assert.ok(domains.includes('raw.githubusercontent.com'));
    assert.ok(domains.includes('registry.npmjs.org'));
  });

  it('adds the github domain set for a git dep declared in a workspace package.json', () => {
    const dir = makeTempDir('git-dep-workspace');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
    }), 'utf8');
    mkdirSync(join(dir, 'packages', 'pkg-a'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'pkg-a', 'package.json'), JSON.stringify({
      name: 'pkg-a',
      dependencies: { thing: 'github:someorg/somerepo#main' },
    }), 'utf8');
    const domains = deriveEnvironmentDomains(dir);
    assert.ok(domains.includes('github.com'));
    assert.ok(domains.includes('codeload.github.com'));
  });

  it('adds the github domain set for pnpm-workspace.yaml globs', () => {
    const dir = makeTempDir('git-dep-pnpm-workspace');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8');
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n', 'utf8');
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'web', 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { thing: 'https://github.com/someorg/somerepo/archive/main.tar.gz' },
    }), 'utf8');
    const domains = deriveEnvironmentDomains(dir);
    assert.ok(domains.includes('github.com'));
  });

  it('does not treat an ordinary semver dependency as a git dependency', () => {
    const dir = makeTempDir('semver-dep');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x',
      dependencies: { lodash: '^4.17.21' },
    }), 'utf8');
    const domains = deriveEnvironmentDomains(dir);
    assert.ok(!domains.includes('github.com'));
  });

  it('adds a custom registry host from .npmrc', () => {
    const dir = makeTempDir('npmrc');
    writeFileSync(join(dir, '.npmrc'), [
      'registry=https://npm.internal.example.com/',
      '@myscope:registry=https://scoped.registry.example.com/',
    ].join('\n'), 'utf8');
    const domains = deriveEnvironmentDomains(dir);
    assert.ok(domains.includes('npm.internal.example.com'));
    assert.ok(domains.includes('scoped.registry.example.com'));
  });

  it('adds pypi domains for requirements.txt', () => {
    const dir = makeTempDir('requirements');
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31.0\n', 'utf8');
    assert.deepEqual(deriveEnvironmentDomains(dir), ['files.pythonhosted.org', 'pypi.org']);
  });

  it('adds pypi domains for pyproject.toml', () => {
    const dir = makeTempDir('pyproject');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    assert.deepEqual(deriveEnvironmentDomains(dir), ['files.pythonhosted.org', 'pypi.org']);
  });

  it('never throws on a worktree root that does not exist', () => {
    assert.doesNotThrow(() => deriveEnvironmentDomains(join(TEST_TMP, 'does-not-exist-at-all')));
  });

  it('never throws on a malformed package.json', () => {
    const dir = makeTempDir('malformed-pkg');
    writeFileSync(join(dir, 'package.json'), '{ not valid json', 'utf8');
    writeFileSync(join(dir, 'package-lock.json'), '{}', 'utf8');
    const domains = deriveEnvironmentDomains(dir);
    assert.ok(domains.includes('registry.npmjs.org'));
  });

  it('returns a sorted, deduped list', () => {
    const dir = makeTempDir('sorted');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x',
      dependencies: {
        a: 'git+https://github.com/foo/bar.git',
        b: 'github:foo/baz',
      },
    }), 'utf8');
    writeFileSync(join(dir, 'yarn.lock'), '', 'utf8');
    writeFileSync(join(dir, 'requirements.txt'), '', 'utf8');
    const domains = deriveEnvironmentDomains(dir);
    const sorted = [...domains].sort();
    assert.deepEqual(domains, sorted);
    assert.deepEqual(domains, [...new Set(domains)]);
  });
});

describe('formatDerivedDomainsLog', () => {
  it('returns undefined for no derived domains', () => {
    assert.equal(formatDerivedDomainsLog([]), undefined);
  });

  it('names each domain and its trigger', () => {
    const line = formatDerivedDomainsLog([
      { domain: 'registry.npmjs.org', trigger: 'pnpm-lock.yaml' },
      { domain: 'github.com', trigger: 'git dep live-hmr-feedback' },
    ]);
    assert.ok(line?.startsWith('env-domains: '));
    assert.ok(line?.includes('+registry.npmjs.org (pnpm-lock.yaml)'));
    assert.ok(line?.includes('+github.com (git dep live-hmr-feedback)'));
  });
});

describe('persistDerivedDomains', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('creates a baseline file with the derived domains when none exists', () => {
    const dir = makeTempDir('persist-new');
    const baselinePath = join(dir, 'kimi-sandbox-domains.json');
    persistDerivedDomains(baselinePath, ['registry.npmjs.org', 'github.com']);
    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(written.allowedDomains, ['github.com', 'registry.npmjs.org']);
  });

  it('unions derived domains into an existing baseline without dropping existing entries', () => {
    const dir = makeTempDir('persist-union');
    const baselinePath = join(dir, 'kimi-sandbox-domains.json');
    writeJson(baselinePath, { allowedDomains: ['api.kimi.com', 'api.moonshot.ai'] });
    persistDerivedDomains(baselinePath, ['registry.npmjs.org', 'api.kimi.com']);
    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(written.allowedDomains, ['api.kimi.com', 'api.moonshot.ai', 'registry.npmjs.org']);
  });

  it('preserves unknown fields already present in the baseline file', () => {
    const dir = makeTempDir('persist-preserve');
    const baselinePath = join(dir, 'kimi-sandbox-domains.json');
    writeJson(baselinePath, { allowedDomains: ['api.kimi.com'], note: 'operator-curated', version: 2 });
    persistDerivedDomains(baselinePath, ['registry.npmjs.org']);
    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(written.note, 'operator-curated');
    assert.equal(written.version, 2);
    assert.deepEqual(written.allowedDomains, ['api.kimi.com', 'registry.npmjs.org']);
  });

  it('writes atomically (no leftover .tmp file after a successful write)', () => {
    const dir = makeTempDir('persist-atomic');
    const baselinePath = join(dir, 'kimi-sandbox-domains.json');
    persistDerivedDomains(baselinePath, ['registry.npmjs.org']);
    const leftovers = readdirSync(dir).filter((f: string) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, []);
  });

  it('falls back to derived-only domains when the baseline JSON is malformed, without crashing', () => {
    const dir = makeTempDir('persist-malformed');
    const baselinePath = join(dir, 'kimi-sandbox-domains.json');
    writeFileSync(baselinePath, '{ this is not json', 'utf8');
    assert.doesNotThrow(() => persistDerivedDomains(baselinePath, ['registry.npmjs.org']));
    const written = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.deepEqual(written.allowedDomains, ['registry.npmjs.org']);
  });

  it('is a no-op when there are no derived domains to persist', () => {
    const dir = makeTempDir('persist-noop');
    const baselinePath = join(dir, 'kimi-sandbox-domains.json');
    persistDerivedDomains(baselinePath, []);
    assert.equal(existsSync(baselinePath), false);
  });

  it('never throws when the baseline path is unwritable', () => {
    // Directory that does not exist and cannot be created because a parent
    // segment is a file, not a directory — forces the write itself to fail.
    const dir = makeTempDir('persist-unwritable');
    const blockerFile = join(dir, 'blocker');
    writeFileSync(blockerFile, 'x', 'utf8');
    const baselinePath = join(blockerFile, 'nested', 'kimi-sandbox-domains.json');
    assert.doesNotThrow(() => persistDerivedDomains(baselinePath, ['registry.npmjs.org']));
  });
});

// Sanity: the "detailed" form and the plain form agree on the domain set.
describe('deriveEnvironmentDomainsDetailed', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('agrees with deriveEnvironmentDomains on the domain set', () => {
    const dir = makeTempDir('detailed-agree');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
    writeFileSync(join(dir, 'package-lock.json'), '{}', 'utf8');
    const detailed = deriveEnvironmentDomainsDetailed(dir).map((d) => d.domain);
    assert.deepEqual(detailed, deriveEnvironmentDomains(dir));
  });
});
