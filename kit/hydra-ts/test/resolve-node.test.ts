import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveWorkerNodeBinDir, nodeMeetsRequirement } from '../src/resolve-node.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-resolve-node');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeFakeNode(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho fake\n', 'utf8');
  chmodSync(path, 0o755);
}

describe('nodeMeetsRequirement', () => {
  it('accepts >=22.6 and rejects below', () => {
    assert.equal(nodeMeetsRequirement('v22.6.0'), true);
    assert.equal(nodeMeetsRequirement('v22.14.0'), true);
    assert.equal(nodeMeetsRequirement('v24.1.0'), true);
    assert.equal(nodeMeetsRequirement('v22.5.1'), false);
    assert.equal(nodeMeetsRequirement('v17.4.0'), false);
    assert.equal(nodeMeetsRequirement('garbage'), false);
    assert.equal(nodeMeetsRequirement(''), false);
  });
});

describe('resolveWorkerNodeBinDir', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
  });
  after(cleanTmp);

  it('returns the running node bin dir when not compiled (launcher guarantees >=22.6)', () => {
    const dir = resolveWorkerNodeBinDir({ compiled: false, execPath: '/fake/node-v22/bin/node' });
    assert.equal(dir, '/fake/node-v22/bin');
  });

  it('compiled: uses the PATH node when its version qualifies', () => {
    const exec = (file: string, args: string[]): string => {
      if (file === 'sh') return '/opt/somewhere/bin/node\n';
      if (file === '/opt/somewhere/bin/node' && args[0] === '--version') return 'v22.14.0\n';
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const dir = resolveWorkerNodeBinDir({ compiled: true, exec, homeDir: join(TEST_TMP, 'no-home') });
    assert.equal(dir, '/opt/somewhere/bin');
  });

  it('compiled: skips a stale PATH node and picks the best qualifying nvm install', () => {
    const home = join(TEST_TMP, 'home-nvm');
    makeFakeNode(join(home, '.nvm/versions/node/v22.14.0/bin/node'));
    makeFakeNode(join(home, '.nvm/versions/node/v24.1.0/bin/node'));
    makeFakeNode(join(home, '.nvm/versions/node/v22.5.0/bin/node'));
    const exec = (file: string, args: string[]): string => {
      if (file === 'sh') return '/usr/local/bin/node\n';
      if (file === '/usr/local/bin/node' && args[0] === '--version') return 'v17.4.0\n';
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    };
    const dir = resolveWorkerNodeBinDir({ compiled: true, exec, homeDir: home });
    assert.equal(dir, join(home, '.nvm/versions/node/v24.1.0/bin'));
  });

  it('compiled: returns empty string when nothing qualifies', () => {
    const exec = (): string => {
      throw new Error('command not found');
    };
    const dir = resolveWorkerNodeBinDir({ compiled: true, exec, homeDir: join(TEST_TMP, 'empty-home') });
    assert.equal(dir, '');
  });
});
