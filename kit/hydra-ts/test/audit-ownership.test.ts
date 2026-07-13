import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  auditOwnership,
  type AuditOwnershipOptions,
  type ExecLike,
} from '../src/audit-ownership.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-audit-ownership');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, uniqueName(prefix));
  mkdirSync(p, { recursive: true });
  return p;
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', dir], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
}

function commitFile(dir: string, filename: string, content: string): string {
  const fullPath = join(dir, filename);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  execFileSync('git', ['-C', dir, 'add', filename], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', `add ${filename}`], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function modifyFile(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf8');
}

function stageAll(dir: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8', stdio: 'ignore' });
}

function commit(dir: string, message: string): string {
  execFileSync('git', ['-C', dir, 'commit', '-m', message], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function passThroughExec(): ExecLike {
  return (command: string, args: string[], options?: { encoding?: string; stdio?: any }) =>
    execFileSync(command, args, options);
}

function audit(
  worktree: string,
  base: string,
  head: string,
  writable: string[],
  options: AuditOwnershipOptions = {},
) {
  return auditOwnership(worktree, base, head, writable, options);
}

describe('auditOwnership', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(cleanTmp);

  it('returns clean when all tracked changes are inside writable globs', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    modifyFile(worktree, 'src/app.js', 'world');
    stageAll(worktree);
    const head = commit(worktree, 'modify app');

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, true);
    assert.equal(result.violations.length, 0);
  });

  it('flags a modified file outside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'docs/readme.md', '# hi');
    modifyFile(worktree, 'docs/readme.md', '# bye');
    stageAll(worktree);
    const head = commit(worktree, 'modify docs');

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('changed outside writable_paths: docs/readme.md')));
  });

  it('flags an added file outside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    mkdirSync(join(worktree, 'other'), { recursive: true });
    writeFileSync(join(worktree, 'other/new.js'), 'new', 'utf8');
    stageAll(worktree);
    const head = commit(worktree, 'add file');

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('changed outside writable_paths: other/new.js')));
  });

  it('flags a deleted file outside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'docs/readme.md', '# hi');
    execFileSync('git', ['-C', worktree, 'rm', 'docs/readme.md'], { encoding: 'utf8', stdio: 'ignore' });
    const head = commit(worktree, 'delete file');

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('changed outside writable_paths: docs/readme.md')));
  });

  it('flags both old and new paths of a rename outside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'other/app.js', 'hello');
    mkdirSync(join(worktree, 'docs'), { recursive: true });
    execFileSync('git', ['-C', worktree, 'mv', 'other/app.js', 'docs/app.js'], {
      encoding: 'utf8',
      stdio: 'ignore',
    });
    const head = commit(worktree, 'rename file');

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('renamed-from outside writable_paths: other/app.js')));
    assert.ok(result.violations.some((v) => v.includes('renamed-to outside writable_paths: docs/app.js')));
  });

  it('flags an untracked file outside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    mkdirSync(join(worktree, 'other'), { recursive: true });
    writeFileSync(join(worktree, 'other/untracked.js'), 'untracked', 'utf8');
    const head = base;

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('untracked outside writable_paths: other/untracked.js')));
  });

  it('does not flag tracked changes when they match writable globs', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/deep/nested/app.js', 'hello');
    modifyFile(worktree, 'src/deep/nested/app.js', 'world');
    stageAll(worktree);
    const head = commit(worktree, 'modify deep file');

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, true);
    assert.equal(result.violations.length, 0);
  });

  it('does not flag untracked files inside writable globs', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    writeFileSync(join(worktree, 'src/new.js'), 'new', 'utf8');
    const head = base;

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, true);
    assert.equal(result.violations.length, 0);
  });

  it('flags a symlink whose target is inside the worktree but outside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/anchor.js', 'hello');
    mkdirSync(join(worktree, 'src'), { recursive: true });
    symlinkSync('../docs/secret.md', join(worktree, 'src/escape.md'));
    const head = base;

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('symlink target outside writable_paths: src/escape.md')));
  });

  it('flags a symlink whose target escapes the worktree', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/anchor.js', 'hello');
    symlinkSync('/etc/passwd', join(worktree, 'src/escape.md'));
    const head = base;

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('symlink escapes worktree: src/escape.md')));
  });

  it('allows a symlink whose target is inside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/anchor.js', 'hello');
    writeFileSync(join(worktree, 'src/target.js'), 'target', 'utf8');
    symlinkSync('target.js', join(worktree, 'src/link.js'));
    const head = base;

    const result = audit(worktree, base, head, ['src/**']);
    assert.equal(result.clean, true);
    assert.equal(result.violations.length, 0);
  });

  it('flags absolute paths reported by git', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    const head = base;

    const exec = ((command: string, args: string[], options?: { encoding?: string; stdio?: any }) => {
      const joined = args.join(' ');
      if (joined.includes('diff --name-status')) {
        return 'M\0/etc/passwd\0';
      }
      return execFileSync(command, args, options);
    }) as ExecLike;

    const result = audit(worktree, base, head, ['src/**'], { exec });
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('absolute path (changed): /etc/passwd')));
  });

  it('flags path traversal reported by git', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    const head = base;

    const exec = ((command: string, args: string[], options?: { encoding?: string; stdio?: any }) => {
      const joined = args.join(' ');
      if (joined.includes('diff --name-status')) {
        return 'M\0src/../../secret\0';
      }
      return execFileSync(command, args, options);
    }) as ExecLike;

    const result = audit(worktree, base, head, ['src/**'], { exec });
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('path traversal (changed): src/../../secret')));
  });

  it('throws when the worktree does not exist', () => {
    assert.throws(
      () => audit('/nonexistent/worktree/path', 'base', 'head', ['src/**']),
      /worktree not found/,
    );
  });

  it('throws when the worktree is not a git repository', () => {
    const worktree = makeTempDir('not-git');
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = TEST_TMP;
    try {
      assert.throws(
        () => audit(worktree, 'base', 'head', ['src/**']),
        /not a git worktree/,
      );
    } finally {
      if (previousCeiling === undefined) {
        delete process.env.GIT_CEILING_DIRECTORIES;
      } else {
        process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      }
    }
  });

  it('flags submodule pointer changes outside writable_paths', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    const head = base;

    const exec = ((command: string, args: string[], options?: { encoding?: string; stdio?: any }) => {
      const joined = args.join(' ');
      if (joined.includes('diff --name-status')) {
        return 'M\0external/lib\0';
      }
      if (joined.includes('ls-tree')) {
        return '160000 commit abc123def4567890abcdef1234567890abcdef12\texternal/lib\n';
      }
      return execFileSync(command, args, options);
    }) as ExecLike;

    const result = audit(worktree, base, head, ['src/**'], { exec });
    assert.equal(result.clean, false);
    assert.ok(result.violations.some((v) => v.includes('changed outside writable_paths: external/lib')));
    assert.ok(
      result.violations.some((v) => v.includes('submodule pointer change outside writable_paths: external/lib')),
    );
  });

  it('honours an injected exec function', () => {
    const worktree = makeTempDir('worktree');
    initGitRepo(worktree);
    const base = commitFile(worktree, 'src/app.js', 'hello');
    const head = base;

    let called = false;
    const exec = ((command: string, args: string[], options?: { encoding?: string; stdio?: any }) => {
      called = true;
      return passThroughExec()(command, args, options);
    }) as ExecLike;

    const result = audit(worktree, base, head, ['src/**'], { exec });
    assert.equal(called, true);
    assert.equal(result.clean, true);
  });
});
