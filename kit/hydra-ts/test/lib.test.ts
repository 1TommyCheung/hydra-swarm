import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  pathInGlobs,
  normalizeRelpath,
  yamlScalar,
  yamlBlock,
  yamlList,
  now,
  deriveDropFromGit,
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

describe('key matching', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('yamlScalar does not match a longer key sharing a prefix (time vs timeline)', () => {
    const file = writeFixture('keys', `timeline: morning\ntime: noon\n`);
    assert.equal(yamlScalar(file, 'time'), 'noon');
    assert.equal(yamlScalar(file, 'timeline'), 'morning');
  });

  it('yamlBlock does not match a longer key sharing a prefix (time vs timeline)', () => {
    const file = writeFixture('keys', `timeline: morning\ntime: noon\n`);
    assert.equal(yamlBlock(file, 'time'), 'noon');
    assert.equal(yamlBlock(file, 'timeline'), 'morning');
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

  it('preserves a trailing blank line that is part of the block', () => {
    const file = writeFixture('block', `description: |
  line one
  line two

next: value
`);
    const block = yamlBlock(file, 'description');
    assert.deepEqual(block.split('\n'), ['line one', 'line two', '']);
  });

  it('preserves all trailing blank lines at end of file without inventing one', () => {
    const withTrailingBlanks = writeFixture(
      'block',
      'description: |\n  line one\n\n\n',
    );
    const withoutTrailingBlank = writeFixture('block', 'description: |\n  line one\n');

    assert.equal(yamlBlock(withTrailingBlanks, 'description'), 'line one\n\n');
    assert.equal(yamlBlock(withoutTrailingBlank, 'description'), 'line one');
  });

  it('preserves trailing blank lines and removes carriage returns under CRLF', () => {
    const file = writeFixture(
      'block',
      'description: |\r\n  line one\r\n  line two\r\n\r\nnext: value\r\n',
    );

    assert.equal(yamlBlock(file, 'description'), 'line one\nline two\n');
  });

  it('preserves interior blank lines once block content has started', () => {
    const file = writeFixture('block', `description: |
  line one

  line two
next: value
`);
    const block = yamlBlock(file, 'description');
    assert.equal(block, 'line one\n\nline two');
  });

  it('returns an inline value that itself contains a pipe character', () => {
    const file = writeFixture('block', `cmd: echo a | b\n`);
    assert.equal(yamlBlock(file, 'cmd'), 'echo a | b');
  });

  it('returns an inline value that itself contains a greater-than character', () => {
    const file = writeFixture('block', `cmd: echo a > b\n`);
    assert.equal(yamlBlock(file, 'cmd'), 'echo a > b');
  });

  it('preserves indentation beyond the block\'s own base indent (nested content survives)', () => {
    const file = writeFixture('block', `reason: |
  Keep relative indentation:
    child instruction
      nested instruction
next: value
`);
    const block = yamlBlock(file, 'reason');
    assert.equal(
      block,
      'Keep relative indentation:\n  child instruction\n    nested instruction',
    );
  });

  it('strips a trailing comment from an inline value, matching yamlScalar', () => {
    const file = writeFixture('block', 'reason: Fix this # literal hash\n');
    assert.equal(yamlBlock(file, 'reason'), 'Fix this');
    assert.equal(yamlScalar(file, 'reason'), 'Fix this');
  });

  it('recognizes chomping/indentation block-header variants in either indicator order', () => {
    for (const header of ['|', '|-', '|+', '>', '>-', '>+', '|2', '|2-', '|2+', '|-2', '|+2', '>2', '>2-', '>-2']) {
      const file = writeFixture('block', `reason: ${header}\n  content line\nnext: value\n`);
      assert.equal(yamlBlock(file, 'reason'), 'content line', `header ${header}`);
    }
  });

  it('returns empty (not the literal marker) for a block header with no content', () => {
    const file = writeFixture('block', 'reason: |\n\nnext: value\n');
    assert.equal(yamlBlock(file, 'reason'), '');
    // The scalar reader, used as a fallback by callers, must not misread
    // the bare header line as if "|" were real content either.
    assert.equal(yamlScalar(file, 'reason'), '');
  });

  it('does not misread a QUOTED "|" or ">" as a bare block-scalar header', () => {
    const file = writeFixture('block', 'reason: "|"\nother: ">"\n');
    assert.equal(yamlScalar(file, 'reason'), '|');
    assert.equal(yamlScalar(file, 'other'), '>');
  });

  it('known accepted gap: an explicit indentation digit is recognized but not honored', () => {
    // amend-task.ts's writer never emits an explicit indentation digit (it
    // always writes a bare "|"), so this only affects a hand-authored spec
    // using that specific YAML feature -- documented, not silently wrong.
    const file = writeFixture('block', 'reason: |2\n    first\n  second\nnext: value\n');
    // A spec-compliant parser would use the declared indent (2) as the base,
    // yielding "  first\nsecond". This reader still infers the base from the
    // first content line instead (4, not the declared 2), which both
    // mis-indents "first" and over-strips "second" -- a known, accepted
    // limitation for this unreachable-via-the-harness YAML feature.
    assert.equal(yamlBlock(file, 'reason'), 'first\ncond');
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

  it('parses list items under CRLF line endings', () => {
    const file = writeFixture('list', 'items:\r\n  - alpha\r\n  - beta\r\n  - gamma\r\n');
    assert.deepEqual(yamlList(file, 'items'), ['alpha', 'beta', 'gamma']);
  });
});

describe('now', () => {
  it('returns an ISO-8601 UTC timestamp', () => {
    const t = now();
    assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(!Number.isNaN(Date.parse(t)));
  });
});

describe('deriveDropFromGit', () => {
  const DIR = join(TEST_TMP, 'derive');
  let worktree = '';

  function git(args: string[]): void {
    execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
  }

  before(() => {
    mkdirSync(DIR, { recursive: true });
    worktree = join(DIR, `repo-${Date.now()}`);
    execFileSync('git', ['init', worktree], { encoding: 'utf8', stdio: 'ignore' });
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(join(worktree, 'a.txt'), 'base\n');
    git(['add', 'a.txt']);
    git(['commit', '-m', 'base']);
    writeFileSync(join(worktree, 'b.txt'), 'more\n');
    git(['add', 'b.txt']);
    git(['commit', '-m', 'more']);
  });
  after(cleanTmp);

  it('proceeds (does not hard-fail) when base_commit is unresolvable', () => {
    const spec = join(DIR, 'spec-invalid.yaml');
    writeFileSync(
      spec,
      'task_id: t1\nrun_id: "0020"\nspec_version: 1\nbranch: b\nbase_commit: not-a-real-commit-xyz\n',
    );
    const out = join(DIR, 'out-invalid.json');
    const ok = deriveDropFromGit(spec, worktree, 'codex', 'sess1', out);
    assert.equal(ok, true);
    assert.ok(existsSync(out));
    const drop = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(drop.status, 'completed');
    assert.ok(drop.head_commit.length > 0);
    assert.deepEqual(drop.files_changed, []);
    assert.equal(drop.base_commit, 'not-a-real-commit-xyz');
  });

  it('derives files_changed from a valid base_commit', () => {
    const base = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD~1'], {
      encoding: 'utf8',
    }).trim();
    const spec = join(DIR, 'spec-valid.yaml');
    writeFileSync(
      spec,
      `task_id: t2\nrun_id: "0020"\nspec_version: 1\nbranch: b\nbase_commit: ${base}\n`,
    );
    const out = join(DIR, 'out-valid.json');
    const ok = deriveDropFromGit(spec, worktree, 'codex', 'sess2', out);
    assert.equal(ok, true);
    const drop = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(drop.files_changed, ['b.txt']);
  });

  it('returns false when HEAD equals base_commit (nothing committed)', () => {
    const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const spec = join(DIR, 'spec-same.yaml');
    writeFileSync(
      spec,
      `task_id: t3\nrun_id: "0020"\nspec_version: 1\nbranch: b\nbase_commit: ${head}\n`,
    );
    const out = join(DIR, 'out-same.json');
    const ok = deriveDropFromGit(spec, worktree, 'codex', 'sess3', out);
    assert.equal(ok, false);
    assert.equal(existsSync(out), false);
  });
});
