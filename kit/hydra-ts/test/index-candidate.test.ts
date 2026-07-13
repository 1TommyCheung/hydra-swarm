import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { indexCandidate, type ExecFn } from '../src/index-candidate.ts';


const TEST_TMP = join(import.meta.dirname, 'tmp-index-candidate');

const ORIGINAL_HYDRA_STATE_ROOT = process.env.HYDRA_STATE_ROOT;
const ORIGINAL_HYDRA_REPO_ID = process.env.HYDRA_REPO_ID;

function chmodRecursiveWritable(root: string): void {
  if (!existsSync(root)) return;
  chmodSync(root, 0o755);
  const st = statSync(root);
  if (st.isDirectory()) {
    for (const entry of readdirSync(root)) {
      chmodRecursiveWritable(join(root, entry));
    }
  }
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    chmodRecursiveWritable(TEST_TMP);
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupEnv(): void {
  process.env.HYDRA_STATE_ROOT = join(TEST_TMP, 'state');
  process.env.HYDRA_REPO_ID = 'test-repo';
}

function restoreEnv(): void {
  if (ORIGINAL_HYDRA_STATE_ROOT === undefined) {
    delete process.env.HYDRA_STATE_ROOT;
  } else {
    process.env.HYDRA_STATE_ROOT = ORIGINAL_HYDRA_STATE_ROOT;
  }
  if (ORIGINAL_HYDRA_REPO_ID === undefined) {
    delete process.env.HYDRA_REPO_ID;
  } else {
    process.env.HYDRA_REPO_ID = ORIGINAL_HYDRA_REPO_ID;
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
  writeFileSync(join(dir, filename), content, 'utf8');
  execFileSync('git', ['-C', dir, 'add', filename], { encoding: 'utf8', stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-m', `add ${filename}`], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

interface FixturePaths {
  stateRoot: string;
  worktree: string;
  taskSpec: string;
  graphDir: string;
}

function setupFixture(runId: string, taskId: string, worktree?: string): FixturePaths {
  const stateRoot = makeTempDir('state');
  const actualWorktree = worktree ?? makeTempDir('worktree');
  const runDir = join(stateRoot, 'runs', `run-${runId}`);
  const tasksDir = join(runDir, 'tasks');
  const graphDir = join(runDir, 'authoritative', 'graph');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(graphDir, { recursive: true });

  const taskSpec = join(tasksDir, `${taskId}.yaml`);
  writeFileSync(taskSpec, `worktree: ${actualWorktree}\n`, 'utf8');

  return { stateRoot, worktree: actualWorktree, taskSpec, graphDir };
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function createExec(opts: {
  worktree: string;
  version?: string;
  onAnalyze?: (args: string[]) => void;
  skipOutputDir?: boolean;
}): ExecFn {
  return (command, args) => {
    if (command === 'gitnexus') {
      if (args[0] === '--version') {
        return `${opts.version ?? 'gitnexus 1.2.3'}\n`;
      }
      if (args[0] === 'analyze') {
        opts.onAnalyze?.(args);
        if (!opts.skipOutputDir) {
          mkdirSync(join(opts.worktree, '.gitnexus'), { recursive: true });
          writeFileSync(
            join(opts.worktree, '.gitnexus', 'meta.json'),
            JSON.stringify({ name: args[args.indexOf('--name') + 1] }),
            'utf8',
          );
        }
        return '';
      }
      throw new Error(`unexpected gitnexus command: ${args.join(' ')}`);
    }
    if (command === 'git') {
      return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' }).trim();
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

describe('indexCandidate', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    setupEnv();
  });

  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('throws when runId or taskId is empty', () => {
    assert.throws(() => indexCandidate('', 'task'), /usage: index-candidate/);
    assert.throws(() => indexCandidate('run', ''), /usage: index-candidate/);
  });

  it('throws when the task spec is missing', () => {
    const stateRoot = makeTempDir('state');
    const worktree = makeTempDir('worktree');
    mkdirSync(join(stateRoot, 'runs', 'run-missing', 'tasks'), { recursive: true });

    process.env.HYDRA_STATE_ROOT = stateRoot;
    try {
      assert.throws(
        () => indexCandidate('missing', 'no-such', undefined, { exec: createExec({ worktree }) }),
        /task spec not found/,
      );
    } finally {
      process.env.HYDRA_STATE_ROOT = join(TEST_TMP, 'state');
    }
  });

  it('throws when the worktree does not exist', () => {
    const fixture = setupFixture('0018', 'bad-worktree', '/nonexistent/worktree/path');
    assert.throws(
      () => indexCandidate('0018', 'bad-worktree', undefined, {
        exec: createExec({ worktree: fixture.worktree }),
        stateRoot: fixture.stateRoot,
      }),
      /worktree not found/,
    );
  });

  it('throws when the worktree has uncommitted tracked changes', () => {
    const fixture = setupFixture('0018', 'dirty-worktree');
    initGitRepo(fixture.worktree);
    commitFile(fixture.worktree, 'file.txt', 'hello');
    writeFileSync(join(fixture.worktree, 'file.txt'), 'modified', 'utf8');

    assert.throws(
      () => indexCandidate('0018', 'dirty-worktree', undefined, {
        exec: createExec({ worktree: fixture.worktree }),
        stateRoot: fixture.stateRoot,
      }),
      /worktree has uncommitted tracked changes/,
    );
  });

  it('builds the index and custody tree on the happy path', () => {
    const runId = '0018';
    const taskId = 'index-candidate';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const head = commitFile(fixture.worktree, 'tracked.txt', 'initial');

    let capturedArgs: string[] | undefined;
    const exec = createExec({
      worktree: fixture.worktree,
      version: 'gitnexus 9.9.9',
      onAnalyze: (args) => {
        capturedArgs = args;
      },
    });

    const indexName = indexCandidate(runId, taskId, undefined, {
      exec,
      stateRoot: fixture.stateRoot,
    });

    assert.equal(indexName, `hydra-${runId}-${taskId}`);

    // Analyzer was invoked with the expected flags.
    assert.ok(capturedArgs);
    assert.equal(capturedArgs![0], 'analyze');
    assert.ok(capturedArgs!.includes('--skip-agents-md'));
    assert.ok(capturedArgs!.includes('--skip-skills'));
    assert.ok(capturedArgs!.includes('--name'));
    assert.equal(capturedArgs![capturedArgs!.indexOf('--name') + 1], indexName);
    assert.ok(capturedArgs!.includes('--allow-duplicate-name'));
    assert.ok(capturedArgs!.includes(fixture.worktree));

    // External custody keyed by commit.
    const custody = join(fixture.stateRoot, 'indexes', 'gitnexus', 'test-repo', head);
    assert.ok(existsSync(custody));
    assert.ok(existsSync(join(custody, 'meta.json')));

    // Manifest in custody.
    const manifest = join(custody, 'manifest.yaml');
    assert.ok(existsSync(manifest));
    const manifestContent = readFileSync(manifest, 'utf8');
    assert.match(manifestContent, new RegExp(`^worktree: ${basename(fixture.worktree)}$`, 'm'));
    assert.match(manifestContent, new RegExp(`^logical_index: candidate/${taskId}/${head}$`, 'm'));
    assert.match(manifestContent, new RegExp(`^index_name: ${indexName}$`, 'm'));
    assert.match(manifestContent, new RegExp(`^indexed_commit: ${head}$`, 'm'));
    assert.match(manifestContent, /^working_tree_dirty_at_index: false$/m);
    assert.match(manifestContent, /^indexer_version: gitnexus 9\.9\.9$/m);
    assert.match(manifestContent, /^created_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);

    // Manifest mirrored to the run's authoritative graph tree.
    const authManifest = join(fixture.graphDir, `${taskId}.manifest.yaml`);
    assert.ok(existsSync(authManifest));
    assert.equal(readFileSync(authManifest, 'utf8'), manifestContent);

    // Ledger event recorded.
    const ledgerPath = join(fixture.stateRoot, 'runs', `run-${runId}`, 'authoritative', 'ledger', 'events.jsonl');
    const events = readJsonl(ledgerPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'index_built');
    assert.equal(events[0].task_id, taskId);
    assert.equal(events[0].index_name, indexName);
    assert.equal(events[0].indexed_commit, head);
    assert.equal(events[0].logical, `candidate/${taskId}/${head}`);
    assert.ok(events[0].time);

    // In-worktree index is read-only.
    const worktreeGitnexus = join(fixture.worktree, '.gitnexus');
    assert.ok(existsSync(worktreeGitnexus));
    assert.equal(statSync(worktreeGitnexus).mode & 0o222, 0);
    assert.equal(statSync(join(worktreeGitnexus, 'meta.json')).mode & 0o222, 0);

    // Git exclude was updated to ignore the index directory.
    const excludeFile = execFileSync(
      'git',
      ['-C', fixture.worktree, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    ).trim();
    const excludePath = excludeFile.startsWith('/')
      ? excludeFile
      : join(fixture.worktree, excludeFile);
    const excludeContent = readFileSync(excludePath, 'utf8');
    assert.match(excludeContent, /^\.gitnexus\/$/m);
  });

  it('uses an explicit logical label when provided', () => {
    const runId = '0018';
    const taskId = 'labelled';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const head = commitFile(fixture.worktree, 'a.txt', 'a');

    indexCandidate(runId, taskId, 'my/custom/label', {
      exec: createExec({ worktree: fixture.worktree }),
      stateRoot: fixture.stateRoot,
    });

    const custody = join(fixture.stateRoot, 'indexes', 'gitnexus', 'test-repo', head);
    const manifestContent = readFileSync(join(custody, 'manifest.yaml'), 'utf8');
    assert.match(manifestContent, /^logical_index: my\/custom\/label$/m);
  });

  it('removes a pre-existing worktree .gitnexus before indexing', () => {
    const runId = '0018';
    const taskId = 'cleanup';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const head = commitFile(fixture.worktree, 'keep.txt', 'keep');

    const staleDir = join(fixture.worktree, '.gitnexus');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'stale.json'), '{}', 'utf8');

    indexCandidate(runId, taskId, undefined, {
      exec: createExec({ worktree: fixture.worktree }),
      stateRoot: fixture.stateRoot,
    });

    const custody = join(fixture.stateRoot, 'indexes', 'gitnexus', 'test-repo', head);
    assert.equal(existsSync(join(staleDir, 'stale.json')), false);
    assert.ok(existsSync(join(custody, 'meta.json')));
  });

  it('appends the exclude pattern without duplicating existing exclude content', () => {
    const runId = '0018';
    const taskId = 'existing-excludes';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    commitFile(fixture.worktree, 'keep.txt', 'keep');

    const excludeFile = execFileSync(
      'git',
      ['-C', fixture.worktree, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    ).trim();
    const excludePath = excludeFile.startsWith('/')
      ? excludeFile
      : join(fixture.worktree, excludeFile);
    writeFileSync(excludePath, '# existing rules\nbuild/\n', 'utf8');

    indexCandidate(runId, taskId, undefined, {
      exec: createExec({ worktree: fixture.worktree }),
      stateRoot: fixture.stateRoot,
    });

    assert.equal(readFileSync(excludePath, 'utf8'), '# existing rules\nbuild/\n.gitnexus/\n');
  });

  it('does not append a duplicate when the exact exclude pattern already exists', () => {
    const runId = '0018';
    const taskId = 'existing-gitnexus-exclude';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    commitFile(fixture.worktree, 'keep.txt', 'keep');

    const excludeFile = execFileSync(
      'git',
      ['-C', fixture.worktree, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    ).trim();
    const excludePath = excludeFile.startsWith('/')
      ? excludeFile
      : join(fixture.worktree, excludeFile);
    writeFileSync(excludePath, '# existing rules\n.gitnexus/\nbuild/\n', 'utf8');

    indexCandidate(runId, taskId, undefined, {
      exec: createExec({ worktree: fixture.worktree }),
      stateRoot: fixture.stateRoot,
    });

    assert.equal(readFileSync(excludePath, 'utf8'), '# existing rules\n.gitnexus/\nbuild/\n');
  });

  it('defaults indexer_version to unknown when version cannot be read', () => {
    const runId = '0018';
    const taskId = 'unknown-version';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const head = commitFile(fixture.worktree, 'b.txt', 'b');

    const exec: ExecFn = (command, args) => {
      if (command === 'gitnexus' && args[0] === '--version') {
        throw new Error('version unavailable');
      }
      return createExec({ worktree: fixture.worktree })(command, args);
    };

    indexCandidate(runId, taskId, undefined, { exec, stateRoot: fixture.stateRoot });

    const custody = join(fixture.stateRoot, 'indexes', 'gitnexus', 'test-repo', head);
    const manifestContent = readFileSync(join(custody, 'manifest.yaml'), 'utf8');
    assert.match(manifestContent, /^indexer_version: unknown$/m);
  });

  it('does not fail when the analyzer produces no .gitnexus directory', () => {
    const runId = '0018';
    const taskId = 'no-output';
    const fixture = setupFixture(runId, taskId);
    initGitRepo(fixture.worktree);
    const head = commitFile(fixture.worktree, 'c.txt', 'c');

    indexCandidate(runId, taskId, undefined, {
      exec: createExec({ worktree: fixture.worktree, skipOutputDir: true }),
      stateRoot: fixture.stateRoot,
    });

    const custody = join(fixture.stateRoot, 'indexes', 'gitnexus', 'test-repo', head);
    assert.ok(existsSync(join(custody, 'manifest.yaml')));
    assert.equal(existsSync(join(fixture.worktree, '.gitnexus')), false);
  });
});
