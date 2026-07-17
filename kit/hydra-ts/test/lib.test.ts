import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
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
  codexEventText,
  kimiEventText,
  pollJsonlFile,
  type JsonlTailState,
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

  it('unescapes \\" and \\\\ inside a double-quoted scalar', () => {
    const file = writeFixture('scalar', 'key: "say \\"hi\\" with a \\\\ backslash"\n');
    assert.equal(yamlScalar(file, 'key'), 'say "hi" with a \\ backslash');
  });

  it('leaves backslashes in an unquoted scalar untouched', () => {
    const file = writeFixture('scalar', 'key: a\\b\n');
    assert.equal(yamlScalar(file, 'key'), 'a\\b');
  });

  it('keeps a literal "#" inside a quoted scalar instead of treating it as a comment', () => {
    const file = writeFixture('scalar', 'key: "release notes (see issue #42)"\n');
    assert.equal(yamlScalar(file, 'key'), 'release notes (see issue #42)');
  });
});

describe('yamlList quoting', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('unescapes \\" inside a double-quoted list item (verification commands)', () => {
    const file = writeFixture(
      'list-quoted',
      'commands:\n  - "for f in x/*.md; do [ -s \\"$f\\" ] || exit 1; done"\n',
    );
    assert.deepEqual(yamlList(file, 'commands'), [
      'for f in x/*.md; do [ -s "$f" ] || exit 1; done',
    ]);
  });

  it('leaves unquoted list items untouched', () => {
    const file = writeFixture('list-plain', 'commands:\n  - echo a\\b\n');
    assert.deepEqual(yamlList(file, 'commands'), ['echo a\\b']);
  });

  it('strips a trailing comment after a quoted list item instead of corrupting the value', () => {
    // The quote test must run against the extracted quoted body, not the
    // whole remainder of the line: with a trailing comment present the old
    // whole-line /^".*"$/ test failed, leaving the closing quote and the
    // comment inside the value -- a command like this reaches bash with an
    // unterminated quote and always fails.
    const file = writeFixture(
      'list-quoted-comment',
      'commands:\n  - "npm test" # run the suite\n',
    );
    assert.deepEqual(yamlList(file, 'commands'), ['npm test']);
  });

  it('does not leave the closing quote behind when a quoted list item has trailing whitespace', () => {
    // The old code tested value.trim() for quotes but stripped them from the
    // UNtrimmed value, so the closing quote before the trailing spaces
    // survived into the item.
    const file = writeFixture('list-quoted-ws', 'commands:\n  - "npm test"  \n');
    assert.deepEqual(yamlList(file, 'commands'), ['npm test']);
  });

  it('keeps a literal "#" inside a quoted list item even when a comment follows', () => {
    const file = writeFixture('list-quoted-hash', 'commands:\n  - "echo #hi" # c\n');
    assert.deepEqual(yamlList(file, 'commands'), ['echo #hi']);
  });

  it('strips a trailing comment from an unquoted list item, matching yamlScalar', () => {
    const file = writeFixture('list-plain-comment', 'commands:\n  - echo hi # comment\n');
    assert.deepEqual(yamlList(file, 'commands'), ['echo hi']);
    const scalar = writeFixture('list-plain-comment-scalar', 'key: echo hi # comment\n');
    assert.equal(yamlScalar(scalar, 'key'), 'echo hi');
  });

  it('parses an empty double-quoted list item as an empty string', () => {
    const file = writeFixture('list-empty-quoted', 'commands:\n  - ""\n');
    assert.deepEqual(yamlList(file, 'commands'), ['']);
  });

  it('unescapes an odd backslash run before the closing quote of a list item', () => {
    // File text "ends in a backslash\\" is YAML for: ends in a backslash\
    const file = writeFixture(
      'list-backslash-run',
      'commands:\n  - "ends in a backslash\\\\"\n',
    );
    assert.deepEqual(yamlList(file, 'commands'), ['ends in a backslash\\']);
  });

  it('unescapes quoted list items under CRLF line endings', () => {
    const file = writeFixture('list-crlf-quoted', 'commands:\r\n  - "echo \\"hi\\""\r\n');
    assert.deepEqual(yamlList(file, 'commands'), ['echo "hi"']);
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

  it('skips a whitespace-only leading line when inferring the base indent, not just an empty one', () => {
    // A line of pure whitespace is blank in YAML terms -- its own
    // indentation is meaningless and must not become the inferred base.
    // Using it as the base (as an earlier version of this code did, since
    // it only checked for a zero-length string) left "  actual" partially
    // un-stripped instead of correctly reading "actual".
    const file = writeFixture('block', 'reason: |\n \n  actual\nnext: value\n');
    assert.equal(yamlBlock(file, 'reason'), 'actual');
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

  it('keeps a literal "#" inside a quoted inline value instead of treating it as a comment', () => {
    const file = writeFixture('block', 'reason: "see issue #42"\n');
    assert.equal(yamlBlock(file, 'reason'), 'see issue #42');
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

  it('honors an explicit indentation digit as the base indent, not the first line\'s inferred indent', () => {
    const file = writeFixture('block', 'reason: |2\n    first\n  second\nnext: value\n');
    // The header declares base indent 2. "first" has 4 leading spaces (2
    // base + 2 extra, preserved); "second" has exactly 2 (the base, none
    // left over). Inferring the base from "first" instead (as if the
    // digit weren't there) would wrongly use 4 and delete real characters
    // from "second" -- this was a real corruption bug, not just lost
    // formatting, caught by adversarial review.
    assert.equal(yamlBlock(file, 'reason'), '  first\nsecond');
  });

  it('explicit indentation digit works with a chomping indicator in either order', () => {
    for (const header of ['|2-', '|-2', '>2+', '>+2']) {
      const file = writeFixture('block', `reason: ${header}\n    first\n  second\nnext: value\n`);
      assert.equal(yamlBlock(file, 'reason'), '  first\nsecond', `header ${header}`);
    }
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

describe('codexEventText', () => {
  it('extracts completed agent messages', () => {
    assert.equal(
      codexEventText(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })),
      'done',
    );
  });

  it('extracts started command executions with a capped display', () => {
    const longCommand = 'npm\nrun\ntest' + 'x'.repeat(200);
    assert.equal(
      codexEventText(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: longCommand } })),
      `\n[cmd] ${longCommand.replaceAll('\n', ' ').slice(0, 140)}`,
    );
  });

  it('extracts file changes with basenames', () => {
    assert.equal(
      codexEventText(JSON.stringify({
        type: 'item.started',
        item: { type: 'file_change', changes: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }] },
      })),
      '\n[edit] foo.ts, bar.ts',
    );
  });

  it('extracts mcp tool calls', () => {
    assert.equal(
      codexEventText(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'fs', tool: 'read' } })),
      '\n[tool] fs.read',
    );
  });

  it('ignores unsupported events and malformed lines', () => {
    assert.equal(codexEventText(JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: 'ignored' } })), undefined);
    assert.equal(codexEventText('{malformed'), undefined);
    assert.equal(codexEventText(''), undefined);
    assert.equal(codexEventText('null'), undefined);
    assert.equal(codexEventText(JSON.stringify([1, 2, 3])), undefined);
  });
});

describe('kimiEventText', () => {
  it('extracts assistant content', () => {
    assert.equal(kimiEventText(JSON.stringify({ role: 'assistant', content: 'hello' })), 'hello');
  });

  it('ignores empty assistant content and other roles', () => {
    assert.equal(kimiEventText(JSON.stringify({ role: 'assistant', content: '' })), undefined);
    assert.equal(kimiEventText(JSON.stringify({ role: 'user', content: 'hi' })), undefined);
    assert.equal(kimiEventText(JSON.stringify({ role: 'tool', tool_call_id: 't1', content: 'result' })), undefined);
  });

  it('ignores malformed and non-object lines', () => {
    assert.equal(kimiEventText('{malformed'), undefined);
    assert.equal(kimiEventText('null'), undefined);
    assert.equal(kimiEventText(JSON.stringify([1, 2, 3])), undefined);
    assert.equal(kimiEventText('"bare string"'), undefined);
  });
});

describe('pollJsonlFile', () => {
  const DIR = join(TEST_TMP, 'poll');

  before(() => mkdirSync(DIR, { recursive: true }));
  after(cleanTmp);

  it('parses new complete lines and appends extracted text', () => {
    const events = join(DIR, 'events.jsonl');
    const output = join(DIR, 'output.txt');
    writeFileSync(
      events,
      [
        JSON.stringify({ role: 'assistant', content: 'first' }),
        JSON.stringify({ role: 'assistant', content: 'second' }),
        '',
      ].join('\n'),
      'utf8',
    );
    const state: JsonlTailState = { offset: 0 };
    pollJsonlFile(events, output, kimiEventText, state);

    assert.equal(readFileSync(output, 'utf8'), 'first\nsecond\n');
    assert.equal(state.offset, readFileSync(events, 'utf8').length);
  });

  it('waits for a trailing newline unless polling final', () => {
    const events = join(DIR, 'events2.jsonl');
    const output = join(DIR, 'output2.txt');
    writeFileSync(events, JSON.stringify({ role: 'assistant', content: 'partial' }), 'utf8');
    const state: JsonlTailState = { offset: 0 };
    pollJsonlFile(events, output, kimiEventText, state);
    assert.equal(existsSync(output), false);

    pollJsonlFile(events, output, kimiEventText, state, true);
    assert.equal(readFileSync(output, 'utf8'), 'partial\n');
  });

  it('resumes from the previous offset when appending', () => {
    const events = join(DIR, 'events3.jsonl');
    const output = join(DIR, 'output3.txt');
    writeFileSync(
      events,
      [JSON.stringify({ role: 'assistant', content: 'one' }), ''].join('\n'),
      'utf8',
    );
    const state: JsonlTailState = { offset: 0 };
    pollJsonlFile(events, output, kimiEventText, state);

    appendFileSync(
      events,
      `${JSON.stringify({ role: 'assistant', content: 'two' })}\n`,
      'utf8',
    );
    pollJsonlFile(events, output, kimiEventText, state);

    assert.equal(readFileSync(output, 'utf8'), 'one\ntwo\n');
  });

  it('tolerates a missing events file', () => {
    const events = join(DIR, 'missing.jsonl');
    const output = join(DIR, 'output4.txt');
    const state: JsonlTailState = { offset: 0 };
    assert.doesNotThrow(() => pollJsonlFile(events, output, kimiEventText, state));
    assert.equal(existsSync(output), false);
  });
});
