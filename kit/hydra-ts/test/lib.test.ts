import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  pathInGlobs,
  normalizeRelpath,
  yamlScalar,
  yamlBlock,
  yamlList,
  now,
} from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`;
}

function writeFixture(prefix: string, content: string): string {
  const p = join(TEST_TMP, uniqueName(prefix));
  writeFileSync(p, content, 'utf8');
  return p;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

describe('pathInGlobs', () => {
  it('matches ** globs across any depth', () => {
    assert.equal(pathInGlobs('src/app.js', ['src/**']), true);
    assert.equal(pathInGlobs('src/app.js', ['**']), true);
    assert.equal(pathInGlobs('src/deep/nested/app.js', ['src/**']), true);
    assert.equal(pathInGlobs('docs/x.md', ['src/**']), false);
  });

  it('matches * globs within a single segment only', () => {
    assert.equal(pathInGlobs('src/foo.js', ['src/*']), true);
    assert.equal(pathInGlobs('src/foo/bar.js', ['src/*']), false);
    assert.equal(pathInGlobs('file.txt', ['*.txt']), true);
    assert.equal(pathInGlobs('dir/file.txt', ['*.txt']), false);
  });

  it('matches combined ** and * globs', () => {
    assert.equal(pathInGlobs('src/components/Button.tsx', ['src/**/*.tsx']), true);
    assert.equal(pathInGlobs('src/components/Button.ts', ['src/**/*.tsx']), false);
    assert.equal(pathInGlobs('a/b/c.txt', ['**/*.txt']), true);
    assert.equal(pathInGlobs('a/b/c.ts', ['**/*.txt']), false);
  });

  it('matches any non-empty glob in the list', () => {
    assert.equal(pathInGlobs('docs/readme.md', ['src/**', 'docs/**']), true);
    assert.equal(pathInGlobs('other.txt', ['src/**', 'docs/**']), false);
  });

  it('ignores empty globs', () => {
    assert.equal(pathInGlobs('src/app.js', ['', 'src/**']), true);
  });

  it('anchors globs to the full path', () => {
    assert.equal(pathInGlobs('src/app.js', ['app.js']), false);
    assert.equal(pathInGlobs('app.js', ['app.js']), true);
  });
});

describe('normalizeRelpath', () => {
  it('returns a clean relative path', () => {
    assert.equal(normalizeRelpath('src/app.js'), 'src/app.js');
    assert.equal(normalizeRelpath('./src/app.js'), 'src/app.js');
    assert.equal(normalizeRelpath('src//app.js'), 'src/app.js');
    assert.equal(normalizeRelpath('./src//app.js'), 'src/app.js');
  });

  it('rejects absolute paths', () => {
    assert.throws(() => normalizeRelpath('/src/app.js'), /absolute path not allowed/);
  });

  it('rejects parent traversal', () => {
    assert.throws(() => normalizeRelpath('../secret'), /path traversal not allowed/);
    assert.throws(() => normalizeRelpath('src/../../secret'), /path traversal not allowed/);
    assert.throws(() => normalizeRelpath('src/../app.js'), /path traversal not allowed/);
  });
});

describe('yamlScalar', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('reads a simple scalar value', () => {
    const file = writeFixture('scalar', 'task_id: lib-ts\n');
    assert.equal(yamlScalar(file, 'task_id'), 'lib-ts');
  });

  it('strips inline comments', () => {
    const file = writeFixture('scalar', 'key: val  # c\n');
    assert.equal(yamlScalar(file, 'key'), 'val');
  });

  it('strips surrounding quotes', () => {
    const file = writeFixture('scalar', 'key: "quoted value"\n');
    assert.equal(yamlScalar(file, 'key'), 'quoted value');
  });

  it('trims trailing whitespace', () => {
    const file = writeFixture('scalar', 'key: value   \n');
    assert.equal(yamlScalar(file, 'key'), 'value');
  });
});

describe('yamlBlock', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('reads a folded block scalar and is not empty', () => {
    const file = writeFixture('block', `objective: >
  Port the harness library.
  Keep behavior exact.
next_key: value
`);
    const block = yamlBlock(file, 'objective');
    assert.ok(block.length > 0);
    assert.match(block, /Port the harness library/);
    assert.match(block, /Keep behavior exact/);
    assert.doesNotMatch(block, /next_key/);
  });

  it('reads a literal block scalar', () => {
    const file = writeFixture('block', `description: |
  Line one.
  Line two.
`);
    const block = yamlBlock(file, 'description');
    assert.match(block, /Line one\./);
    assert.match(block, /Line two\./);
  });

  it('falls back to an inline value', () => {
    const file = writeFixture('block', 'objective: inline objective\n');
    assert.equal(yamlBlock(file, 'objective'), 'inline objective');
  });

  it('dedents block lines and trims trailing whitespace', () => {
    const file = writeFixture('block', `objective: >
    Indented line.
`);
    const block = yamlBlock(file, 'objective');
    assert.equal(block, 'Indented line.');
  });

  it('stops at the next top-level key', () => {
    const file = writeFixture('block', `objective: >
  First.
other: value
  Still other.
`);
    const block = yamlBlock(file, 'objective');
    assert.equal(block, 'First.');
  });
});

describe('yamlList', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('reads list items', () => {
    const file = writeFixture('list', `items:
  - one
  - two
  - three
`);
    assert.deepEqual(yamlList(file, 'items'), ['one', 'two', 'three']);
  });

  it('stops at the next non-list line', () => {
    const file = writeFixture('list', `items:
  - a
  - b
other: value
  - c
`);
    assert.deepEqual(yamlList(file, 'items'), ['a', 'b']);
  });

  it('strips surrounding quotes', () => {
    const file = writeFixture('list', `items:
  - "quoted"
  - plain
`);
    assert.deepEqual(yamlList(file, 'items'), ['quoted', 'plain']);
  });
});

describe('now', () => {
  it('returns an ISO-8601 UTC timestamp', () => {
    const t = now();
    assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(!Number.isNaN(Date.parse(t)));
  });
});
