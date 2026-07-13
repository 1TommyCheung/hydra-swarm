import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  graphifyInvestigate,
  GraphifyInvestigateError,
  type ExecLike,
} from '../src/graphify-investigate.ts';
import { runDir, graphifyDir } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-graphify-investigate');

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function setupStateRoot(): string {
  const stateRoot = join(TEST_TMP, `state-${uniqueName('state')}`);
  process.env.HYDRA_STATE_ROOT = stateRoot;
  return stateRoot;
}

function writeGraph(runId: string, graph: unknown): void {
  const dir = graphifyDir(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph), 'utf8');
}

function writeTaskSpec(runId: string, taskId: string, worktree: string, baseCommit: string): void {
  const taskSpec = join(runDir(runId), 'tasks', `${taskId}.yaml`);
  mkdirSync(dirname(taskSpec), { recursive: true });
  writeFileSync(
    taskSpec,
    `worktree: ${worktree}\nbase_commit: ${baseCommit}\n`,
    'utf8',
  );
}

function ledgerEvents(runId: string): Array<Record<string, unknown>> {
  const ledgerPath = join(runDir(runId), 'authoritative', 'ledger', 'events.jsonl');
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeGraph() {
  return {
    nodes: [
      { id: 'n1', source_file: 'src/auth/login.ts' },
      { id: 'n2', source_file: 'src/auth/session.ts' },
      { id: 'n3', source_file: 'lib/utils.ts' },
    ],
    links: [
      {
        source: 'n1',
        target: 'n2',
        relation: 'calls',
        confidence: 'EXTRACTED',
        confidence_score: 0.95,
        source_file: 'src/auth/login.ts',
      },
      {
        source: 'n2',
        target: 'n3',
        relation: 'imports',
        confidence: 'INFERRED',
        confidence_score: 0.72,
      },
      {
        source: 'n1',
        target: 'n3',
        relation: 'maybe-uses',
        confidence: 'AMBIGUOUS',
        confidence_score: 0.41,
      },
      {
        source: 'n3',
        target: 'n1',
        relation: 'unrelated',
        confidence: 'EXTRACTED',
        confidence_score: 0.88,
      },
    ],
  };
}

function mockGitDiff(files: string[]): ExecLike {
  return (command: string, args: string[]) => {
    if (command === 'git' && args.join(' ').includes('diff --name-only')) {
      return files.join('\n') + '\n';
    }
    throw new Error(`unexpected exec: ${command} ${args.join(' ')}`);
  };
}

const forbidExternalExec: ExecLike = (command, args) => {
  throw new Error(`unexpected external command: ${command} ${args.join(' ')}`);
};

describe('graphifyInvestigate', () => {
  let originalStateRoot: string | undefined;
  let originalRepoId: string | undefined;

  before(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    originalStateRoot = process.env.HYDRA_STATE_ROOT;
    originalRepoId = process.env.HYDRA_REPO_ID;
    // Prevent lib.ts from invoking git to discover the repository name.
    process.env.HYDRA_REPO_ID = 'graphify-investigate-test-repo';
  });

  after(() => {
    cleanTmp();
    if (originalStateRoot === undefined) {
      delete process.env.HYDRA_STATE_ROOT;
    } else {
      process.env.HYDRA_STATE_ROOT = originalStateRoot;
    }
    if (originalRepoId === undefined) {
      delete process.env.HYDRA_REPO_ID;
    } else {
      process.env.HYDRA_REPO_ID = originalRepoId;
    }
  });

  it('omits evidence and exits 8 when no Graphify baseline exists', () => {
    setupStateRoot();
    const runId = uniqueName('run');

    assert.throws(
      () => graphifyInvestigate(runId, 'task-a', { exec: forbidExternalExec }),
      (err: unknown) =>
        err instanceof GraphifyInvestigateError && err.exitCode === 8,
    );

    const events = ledgerEvents(runId);
    const noBaseline = events.find((e) => e.status === 'no_baseline');
    assert.ok(noBaseline, 'expected no_baseline ledger event');
    assert.equal(noBaseline.advisory, 'true');
  });

  it('generates a report in --files mode and matches edges by basename', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    writeGraph(runId, makeGraph());

    const reportPath = graphifyInvestigate(runId, {
      files: ['auth/login.ts', 'deep/session.ts'],
    }, { exec: forbidExternalExec });

    assert.ok(existsSync(reportPath));
    assert.ok(reportPath.endsWith('graphify-doc-conflict.md'));

    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Graphify investigation \(doc-conflict\)/);
    assert.match(report, /Blocking investigations \(EXTRACTED, require confirmation\) — 2/);
    assert.match(report, /Review questions \(INFERRED\/AMBIGUOUS, never blocking\) — 2/);
    assert.match(report, /\*\*calls\*\*: n1 → n2/);
    assert.match(report, /imports: n2 → n3/);
    assert.match(report, /maybe-uses: n1 → n3/);
    assert.match(report, /\*\*unrelated\*\*: n3 → n1/);

    const events = ledgerEvents(runId);
    const event = events.find((e) => e.event === 'graphify_investigation');
    assert.ok(event);
    assert.equal(event.task_id, 'doc-conflict');
    assert.equal(event.advisory, 'true');
    assert.equal(event.investigations, '2');
    assert.equal(event.questions, '2');
    assert.equal(event.requires_confirmation, 'true');
  });

  it('defaults to doc-conflict task id when using files mode', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    writeGraph(runId, makeGraph());

    const reportPath = graphifyInvestigate(runId, {
      files: ['auth/login.ts'],
    }, { exec: forbidExternalExec });

    assert.ok(reportPath.endsWith('graphify-doc-conflict.md'));
  });

  it('uses git diff for changed files in task mode', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const taskId = uniqueName('task');
    writeGraph(runId, makeGraph());
    writeTaskSpec(runId, taskId, '/tmp/worktree', 'base123');

    let observedArgs: string[] | undefined;
    let observedCwd: string | undefined;
    const exec: ExecLike = (command, args, options) => {
      assert.equal(command, 'git');
      observedArgs = args;
      observedCwd = options?.cwd;
      return 'src/auth/login.ts\n';
    };
    const reportPath = graphifyInvestigate(runId, taskId, { exec });

    assert.deepEqual(observedArgs, [
      '-C',
      '/tmp/worktree',
      'diff',
      '--name-only',
      'base123...HEAD',
    ]);
    assert.equal(observedCwd, undefined);
    assert.ok(reportPath.endsWith(`${taskId}.graphify.md`));
    const report = readFileSync(reportPath, 'utf8');
    assert.ok(report.includes(`Graphify investigation (${taskId})`));
    assert.match(report, /Blocking investigations.*— 2/);
  });

  it('falls back to empty changed files when git diff fails', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const taskId = uniqueName('task');
    writeGraph(runId, makeGraph());
    writeTaskSpec(runId, taskId, '/tmp/worktree', 'base123');

    const exec: ExecLike = (command, args) => {
      if (command === 'git' && args.join(' ').includes('diff --name-only')) {
        throw new Error('git diff failed');
      }
      throw new Error(`unexpected exec: ${command} ${args.join(' ')}`);
    };

    const reportPath = graphifyInvestigate(runId, taskId, { exec });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 0/);
    assert.match(report, /Review questions.*— 0/);
  });

  it('warns but continues when no changed files are found', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const taskId = uniqueName('task');
    writeGraph(runId, makeGraph());
    writeTaskSpec(runId, taskId, '/tmp/worktree', 'base123');

    const exec = mockGitDiff([]);
    const reportPath = graphifyInvestigate(runId, taskId, { exec });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 0/);
    assert.match(report, /Review questions.*— 0/);
  });

  it('throws when task spec is missing in task mode', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    writeGraph(runId, makeGraph());

    assert.throws(
      () => graphifyInvestigate(runId, 'missing-task', { exec: forbidExternalExec }),
      /hydra: error: task spec not found/,
    );
  });

  it('uses .edges when .links is absent', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const graph = makeGraph();
    const edges = (graph as any).links;
    delete (graph as any).links;
    (graph as any).edges = edges;
    writeGraph(runId, graph);

    const reportPath = graphifyInvestigate(runId, {
      files: ['auth/login.ts'],
    }, { exec: forbidExternalExec });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /\*\*calls\*\*: n1 → n2/);
  });

  it('matches changed files by node source_file basename', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    writeGraph(runId, {
      nodes: [
        { id: 'n1', source_file: 'some/prefix/session.ts' },
        { id: 'n2', source_file: 'other/login.ts' },
      ],
      links: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'calls',
          confidence: 'EXTRACTED',
          confidence_score: 0.9,
        },
      ],
    });

    const reportPath = graphifyInvestigate(runId, {
      files: ['session.ts'],
    }, { exec: forbidExternalExec });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 1/);
    assert.match(report, /\*\*calls\*\*: n1 → n2/);
  });

  it('ignores edges whose confidence is not requested', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    writeGraph(runId, {
      nodes: [
        { id: 'n1', source_file: 'src/a.ts' },
        { id: 'n2', source_file: 'src/b.ts' },
      ],
      links: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'rumour',
          confidence: 'UNKNOWN',
          confidence_score: 0.5,
          source_file: 'src/a.ts',
        },
      ],
    });

    const reportPath = graphifyInvestigate(runId, {
      files: ['a.ts'],
    }, { exec: forbidExternalExec });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 0/);
    assert.match(report, /Review questions.*— 0/);
  });

  it('honours an injected exec function', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const taskId = uniqueName('task');
    writeGraph(runId, makeGraph());
    writeTaskSpec(runId, taskId, '/tmp/worktree', 'base123');

    let called = false;
    const exec: ExecLike = (command, args) => {
      called = true;
      return mockGitDiff(['src/auth/login.ts'])(command, args);
    };

    graphifyInvestigate(runId, taskId, { exec });
    assert.equal(called, true);
  });

  it('preserves whitespace in git-reported filenames like mapfile', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const taskId = uniqueName('task');
    writeGraph(runId, {
      nodes: [
        { id: 'n1', source_file: 'src/ padded.ts ' },
        { id: 'n2', source_file: 'src/other.ts' },
      ],
      links: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'calls',
          confidence: 'EXTRACTED',
        },
      ],
    });
    writeTaskSpec(runId, taskId, '/tmp/worktree', 'base123');

    const exec: ExecLike = () => 'src/ padded.ts \n';
    const reportPath = graphifyInvestigate(runId, taskId, { exec });
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 1/);
  });

  it('renders missing fields as jq null values', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    writeGraph(runId, {
      nodes: [
        { id: 'n1', source_file: 'src/a.ts' },
        { id: 'n2', source_file: 'src/b.ts' },
      ],
      links: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'calls',
          confidence: 'EXTRACTED',
        },
      ],
    });

    const reportPath = graphifyInvestigate(
      runId,
      { files: ['a.ts'] },
      { exec: forbidExternalExec },
    );
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /_\(null, score null\)_/);
  });

  it('falls back to empty evidence when the Graphify JSON is malformed', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const graphDir = graphifyDir(runId);
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, 'graph.json'), '{not-json', 'utf8');

    const reportPath = graphifyInvestigate(
      runId,
      { files: ['a.ts'] },
      { exec: forbidExternalExec },
    );
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 0/);
    assert.match(report, /Review questions.*— 0/);
  });

  it('falls back to empty evidence when the required nodes array is absent', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    writeGraph(runId, {
      links: [
        {
          source: 'n1',
          target: 'n2',
          relation: 'calls',
          confidence: 'EXTRACTED',
          source_file: 'src/a.ts',
        },
      ],
    });

    const reportPath = graphifyInvestigate(
      runId,
      { files: ['a.ts'] },
      { exec: forbidExternalExec },
    );
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 0/);
  });

  it('uses .edges when .links is false, matching jq alternative semantics', () => {
    setupStateRoot();
    const runId = uniqueName('run');
    const graph = makeGraph();
    (graph as any).links = false;
    (graph as any).edges = makeGraph().links;
    writeGraph(runId, graph);

    const reportPath = graphifyInvestigate(
      runId,
      { files: ['auth/login.ts'] },
      { exec: forbidExternalExec },
    );
    const report = readFileSync(reportPath, 'utf8');
    assert.match(report, /Blocking investigations.*— 2/);
  });

  it('honours state-root and cwd overrides without leaking environment state', () => {
    const ambientRoot = setupStateRoot();
    const overrideRoot = join(TEST_TMP, uniqueName('override-root'));
    const runId = uniqueName('run');
    const taskId = uniqueName('task');
    const graphDir = join(
      overrideRoot,
      'indexes',
      'graphify',
      'graphify-investigate-test-repo',
      `run-${runId}`,
    );
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, 'graph.json'), JSON.stringify(makeGraph()), 'utf8');
    const taskSpec = join(overrideRoot, 'runs', `run-${runId}`, 'tasks', `${taskId}.yaml`);
    mkdirSync(dirname(taskSpec), { recursive: true });
    writeFileSync(taskSpec, 'worktree: /tmp/worktree\nbase_commit: base123\n', 'utf8');

    let observedCwd: string | undefined;
    const exec: ExecLike = (_command, _args, options) => {
      observedCwd = options?.cwd;
      return 'src/auth/login.ts\n';
    };
    const reportPath = graphifyInvestigate(runId, taskId, {
      stateRoot: overrideRoot,
      cwd: '/tmp/injected-cwd',
      exec,
    });

    assert.ok(reportPath.startsWith(overrideRoot));
    assert.equal(observedCwd, '/tmp/injected-cwd');
    assert.equal(process.env.HYDRA_STATE_ROOT, ambientRoot);
  });
});
