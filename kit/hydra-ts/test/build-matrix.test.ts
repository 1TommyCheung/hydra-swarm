import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  artifactPaths,
  buildTarget,
  DEFAULT_TARGETS,
  outfileNameForTarget,
  parseTargets,
} from '../scripts/build-matrix.ts';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'build-matrix.ts');
const RELEASE_WORKFLOW = join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'release.yml');
const SOURCE_SHA = 'a'.repeat(40);

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'hydra-build-matrix-'));
}

describe('build matrix targets and paths', () => {
  it('defaults to all six current Bun desktop targets and accepts Windows subsets', () => {
    assert.deepEqual(parseTargets([]), [
      'bun-darwin-arm64',
      'bun-darwin-x64',
      'bun-linux-x64',
      'bun-linux-arm64',
      'bun-windows-arm64',
      'bun-windows-x64',
    ]);
    assert.equal(DEFAULT_TARGETS.length, 6);
    assert.deepEqual(
      parseTargets(['--targets=bun-windows-arm64,bun-windows-x64']),
      ['bun-windows-arm64', 'bun-windows-x64'],
    );
  });

  it('rejects unofficial Windows target aliases before resolving Bun', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', SCRIPT, '--targets=bun-windows-amd64'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown target\(s\): bun-windows-amd64/);
  });

  it('uses .exe only for Windows outfiles and keeps per-target manifests unambiguous', () => {
    assert.equal(outfileNameForTarget('bun-windows-arm64'), 'hydra-cli.exe');
    assert.equal(outfileNameForTarget('bun-windows-x64'), 'hydra-cli.exe');
    assert.equal(outfileNameForTarget('bun-darwin-x64'), 'hydra-cli');
    assert.equal(outfileNameForTarget('bun-linux-arm64'), 'hydra-cli');

    const windows = artifactPaths('bun-windows-x64', '/dist');
    assert.equal(windows.outfile, join('/dist', 'bun-windows-x64', 'hydra-cli.exe'));
    assert.equal(windows.manifestPath, join('/dist', 'bun-windows-x64', 'manifest.json'));
    const linux = artifactPaths('bun-linux-x64', '/dist');
    assert.equal(linux.outfile, join('/dist', 'bun-linux-x64', 'hydra-cli'));
  });
});

describe('build matrix publication hygiene', () => {
  it('publishes a checksum- and source-bound Windows manifest with the .exe path', () => {
    const root = scratch();
    try {
      const payload = Buffer.from('MZ-fake-PE-for-path-and-provenance-test');
      const manifest = buildTarget(
        'bun-windows-x64',
        { path: '/controlled/bun', version: '1.3.14' },
        SOURCE_SHA,
        '2026-07-21T00:00:00.000Z',
        {
          hydraRoot: root,
          distDir: join(root, 'dist'),
          executeBuild: (_bunPath, args) => {
            const outfileIndex = args.indexOf('--outfile');
            assert.notEqual(outfileIndex, -1);
            assert.match(args[outfileIndex + 1], /hydra-cli\.tmp-\d+\.exe$/);
            writeFileSync(args[outfileIndex + 1], payload);
          },
        },
      );

      assert.ok(manifest);
      assert.equal(manifest.source_sha, SOURCE_SHA);
      assert.equal(manifest.target, 'bun-windows-x64');
      assert.equal(manifest.outfile, join('dist', 'bun-windows-x64', 'hydra-cli.exe'));
      assert.equal(manifest.sha256, createHash('sha256').update(payload).digest('hex'));
      assert.equal(manifest.size_bytes, payload.length);
      assert.ok(existsSync(join(root, manifest.outfile)));
      assert.deepEqual(
        JSON.parse(readFileSync(join(root, 'dist', 'bun-windows-x64', 'manifest.json'), 'utf8')),
        manifest,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes current, legacy, manifest, and interrupted temp artifacts before a failed build', () => {
    const root = scratch();
    try {
      const outDir = join(root, 'dist', 'bun-windows-arm64');
      mkdirSync(outDir, { recursive: true });
      for (const name of [
        'hydra-cli',
        'hydra-cli.exe',
        'manifest.json',
        'hydra-cli.tmp-111.exe',
        'hydra-cli.exe.tmp-222',
        'manifest.json.tmp-333',
      ]) {
        writeFileSync(join(outDir, name), 'stale');
      }
      writeFileSync(join(outDir, 'keep.txt'), 'unrelated');

      const manifest = buildTarget(
        'bun-windows-arm64',
        { path: '/controlled/bun', version: '1.3.14' },
        SOURCE_SHA,
        '2026-07-21T00:00:00.000Z',
        {
          hydraRoot: root,
          distDir: join(root, 'dist'),
          executeBuild: () => { throw Object.assign(new Error('expected failure'), { status: 23 }); },
        },
      );

      assert.equal(manifest, null);
      assert.deepEqual(readdirSync(outDir), ['keep.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release workflow', () => {
  const workflow = readFileSync(RELEASE_WORKFLOW, 'utf8');

  it('stages six unambiguous binaries, six manifests, and the aggregate manifest', () => {
    for (const target of [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'windows-arm64',
      'windows-x64',
    ]) {
      assert.ok(workflow.includes(target));
    }
    assert.ok(workflow.includes('release-assets/hydra-cli-$t"'));
    assert.ok(workflow.includes('release-assets/hydra-cli-$t.exe"'));
    assert.equal((workflow.match(/release-assets\/manifest-\$t\.json/g) ?? []).length, 2);
    assert.ok(workflow.includes('release-assets/manifest-all.json'));
  });

  it('fans out native Linux, macOS, and Windows verification before one release job', () => {
    assert.match(workflow, /verify-linux:[\s\S]*?runs-on: ubuntu-latest/);
    assert.match(workflow, /verify-macos:[\s\S]*?runs-on: macos-latest/);
    assert.match(workflow, /verify-windows:[\s\S]*?runs-on: windows-latest/);
    assert.match(workflow, /verify-windows:[\s\S]*?blackbox-compiled\.ts release-assets\/hydra-cli-windows-x64\.exe/);
    assert.match(workflow, /release:\n    needs: \[verify-linux, verify-macos, verify-windows\]/);
    assert.equal((workflow.match(/gh release create/g) ?? []).length, 1);
    assert.equal((workflow.match(/scripts\/blackbox-compiled\.ts/g) ?? []).length, 3);
    assert.equal((workflow.match(/version --json/g) ?? []).length, 3);
  });
});
