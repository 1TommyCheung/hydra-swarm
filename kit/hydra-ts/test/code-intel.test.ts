import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  codeIntel,
  changed,
  drift,
  impact,
  query,
  stripAnsi,
  type ExecLike,
} from '../src/code-intel.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-code-intel');

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function graphPath(runId: string): string {
  const dir = join(TEST_TMP, runId);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'graph.json');
}

interface ExecConfig {
  repoRoot?: string;
  gitnexusAvailable?: boolean;
  graphifyAvailable?: boolean;
  gitnexusOutputs?: Record<string, string>;
  gitnexusFailures?: string[];
  graphifyOutput?: string;
  graphifyFailure?: boolean;
  changedFiles?: string[];
  calls?: Array<{ command: string; args: string[] }>;
}

function makeExec(config: ExecConfig): ExecLike {
  return (command, args, _options) => {
    config.calls?.push({ command, args: [...args] });
    if (
      command === 'git' &&
      args[0] === 'rev-parse' &&
      args[1] === '--show-toplevel'
    ) {
      return `${config.repoRoot ?? '/fake/repo'}\n`;
    }
    if (
      command === 'git' &&
      args[0] === '-C' &&
      args[2] === 'diff'
    ) {
      return (config.changedFiles ?? []).join('\n') + '\n';
    }
    if (
      command === 'bash' &&
      args[0] === '-c' &&
      args[1].includes('command -v')
    ) {
      const target = args[3];
      const available =
        (target === 'gitnexus' && config.gitnexusAvailable) ||
        (target === 'graphify' && config.graphifyAvailable);
      if (available) return '';
      const err = new Error(
        `command not found: ${target}`,
      ) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    if (command === 'gitnexus') {
      const sub = args[0];
      if (config.gitnexusFailures?.includes(sub)) {
        const error = new Error(`gitnexus ${sub} failed`) as Error & {
          stdout?: string;
        };
        error.stdout = config.gitnexusOutputs?.[sub] ?? '';
        throw error;
      }
      return config.gitnexusOutputs?.[sub] ?? '';
    }
    if (command === 'graphify') {
      if (!config.graphifyAvailable || config.graphifyFailure) {
        throw new Error('graphify query failed');
      }
      return config.graphifyOutput ?? '';
    }
    return '';
  };
}

function writeGraph(path: string, graph: unknown): void {
  writeFileSync(path, JSON.stringify(graph), 'utf8');
}

describe('code-intel helpers', () => {
  it('strips ANSI escape codes', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
    assert.equal(stripAnsi('no ansi'), 'no ansi');
  });
});

describe('changed', () => {
  let originalRepo: string | undefined;

  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    originalRepo = process.env.HYDRA_GITNEXUS_REPO;
    process.env.HYDRA_GITNEXUS_REPO = 'test-repo';
  });

  after(() => {
    cleanTmp();
    if (originalRepo === undefined) {
      delete process.env.HYDRA_GITNEXUS_REPO;
    } else {
      process.env.HYDRA_GITNEXUS_REPO = originalRepo;
    }
  });

  it('renders the GitNexus structure section when gitnexus is available', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({
      gitnexusAvailable: true,
      gitnexusOutputs: {
        'detect-changes': 'changed symbol A\nchanged symbol B',
      },
      changedFiles: ['src/foo.ts'],
    });
    const out = changed('main', { exec, graphPath: path });
    assert.match(out, /# code-intel: changed\s+\(base main\)/);
    assert.match(out, /## Structure — GitNexus/);
    assert.match(out, /changed symbol A/);
    assert.match(out, /changed symbol B/);
  });

  it('omits the GitNexus section when gitnexus is unavailable', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({ changedFiles: ['src/foo.ts'] });
    const out = changed('main', { exec, graphPath: path });
    assert.match(out, /## Structure — GitNexus/);
    assert.match(out, /\(gitnexus not available\)/);
  });

  it('renders Graphify design-intent edges from changed files', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [
        { id: 'a', source_file: 'src/foo.ts' },
        { id: 'b', source_file: 'docs/design.md' },
      ],
      links: [
        {
          relation: 'implements',
          confidence: 'EXTRACTED',
          source: 'b',
          target: 'a',
        },
        {
          relation: 'mentions',
          confidence: 'INFERRED',
          source: 'b',
          target: 'a',
        },
      ],
    });
    const exec = makeExec({ changedFiles: ['src/foo.ts'] });
    const out = changed('main', { exec, graphPath: path });
    assert.match(out, /## Design intent touched — Graphify/);
    assert.match(out, /EXTRACTED investigations.*1/);
    assert.match(out, /implements: b → a\s+\[docs\/design.md\]/);
    assert.match(out, /INFERRED questions.*1/);
    assert.match(out, /mentions: b → a/);
  });

  it('falls back to HEAD when no files changed', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [{ id: 'a', source_file: 'docs/design.md' }],
      links: [
        {
          relation: 'refs',
          confidence: 'EXTRACTED',
          source: 'a',
          target: 'a',
        },
      ],
    });
    const exec = makeExec({ changedFiles: [] });
    const out = changed('main', { exec, graphPath: path });
    assert.match(out, /EXTRACTED investigations.*0/);
    assert.match(out, /INFERRED questions.*0/);
  });

  it('reports no standing graph when graph.json is missing', () => {
    const exec = makeExec({ gitnexusAvailable: true });
    const out = changed('main', {
      exec,
      graphPath: join(TEST_TMP, 'no-such-graph.json'),
    });
    assert.match(out, /\(no standing graph — run: graphify-repo.sh build\)/);
  });

  it('treats an unreadable standing graph like an empty edge set', () => {
    const path = graphPath(makeRunId());
    writeFileSync(path, '{invalid', 'utf8');
    const exec = makeExec({ changedFiles: ['src/foo.ts'] });
    const out = changed('main', { exec, graphPath: path });
    assert.match(out, /EXTRACTED investigations.*0/);
    assert.match(out, /INFERRED questions.*0/);
    assert.doesNotMatch(out, /no standing graph/);
  });

  it('honours a custom base ref', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    let capturedBase = '';
    const exec: ExecLike = (command, args) => {
      if (command === 'gitnexus' && args[0] === 'detect-changes') {
        const idx = args.indexOf('--base-ref');
        capturedBase = args[idx + 1];
      }
      return '';
    };
    changed('develop', { exec, graphPath: path });
    assert.equal(capturedBase, 'develop');
  });
});

describe('impact', () => {
  let originalRepo: string | undefined;

  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    originalRepo = process.env.HYDRA_GITNEXUS_REPO;
    process.env.HYDRA_GITNEXUS_REPO = 'test-repo';
  });

  after(() => {
    cleanTmp();
    if (originalRepo === undefined) {
      delete process.env.HYDRA_GITNEXUS_REPO;
    } else {
      process.env.HYDRA_GITNEXUS_REPO = originalRepo;
    }
  });

  it('renders blast radius and semantic neighbours', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [
        { id: 'sym', source_file: 'src/foo.ts' },
        { id: 'n1', source_file: 'src/bar.ts' },
      ],
      links: [
        {
          relation: 'calls',
          confidence: 'EXTRACTED',
          source: 'sym',
          target: 'n1',
        },
      ],
    });
    const exec = makeExec({
      gitnexusAvailable: true,
      gitnexusOutputs: {
        impact: 'affected caller X\naffected caller Y',
      },
    });
    const out = impact('foo', { exec, graphPath: path });
    assert.match(out, /# code-intel: impact\s+\(foo\)/);
    assert.match(out, /## Blast radius — GitNexus/);
    assert.match(out, /affected caller X/);
    assert.match(out, /## Semantic neighbours — Graphify/);
    assert.match(out, /EXTRACTED calls: sym → n1\s+\[src\/foo.ts\]/);
  });

  it('does not fall back when impact succeeds with no output', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = makeExec({
      gitnexusAvailable: true,
      gitnexusOutputs: {
        impact: '',
        context: 'context line 1\ncontext line 2',
      },
      calls,
    });
    const out = impact('sym', { exec, graphPath: path });
    assert.doesNotMatch(out, /context line/);
    assert.equal(
      calls.some((call) => call.command === 'gitnexus' && call.args[0] === 'context'),
      false,
    );
  });

  it('falls back on impact failure, discards partial output, and preserves context ANSI', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({
      gitnexusAvailable: true,
      gitnexusFailures: ['impact'],
      gitnexusOutputs: {
        impact: 'partial impact output',
        context: '\x1b[32mcontext line\x1b[0m',
      },
    });
    const out = impact('sym', { exec, graphPath: path });
    assert.doesNotMatch(out, /partial impact output/);
    assert.match(out, /\x1b\[32mcontext line\x1b\[0m/);
  });

  it('limits gitnexus output to 30 lines', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({
      gitnexusAvailable: true,
      gitnexusOutputs: {
        impact: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'),
      },
    });
    const out = impact('sym', { exec, graphPath: path });
    const match = out.match(/## Blast radius — GitNexus[^\n]*\n([\s\S]*?)\n\n## Semantic neighbours/);
    assert.ok(match);
    assert.equal(match[1].trim().split('\n').length, 30);
  });

  it('limits semantic neighbours to 20 lines', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [{ id: 'sym', source_file: 'src/foo.ts' }],
      links: Array.from({ length: 30 }, (_, i) => ({
        relation: `rel${i}`,
        confidence: 'EXTRACTED',
        source: 'sym',
        target: `n${i}`,
      })),
    });
    const exec = makeExec({ gitnexusAvailable: false });
    const out = impact('foo', { exec, graphPath: path });
    const matches = out.match(/EXTRACTED rel\d+/g);
    assert.equal(matches?.length, 20);
  });

  it('treats an empty fragment as matching every edge', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [
        { id: 'a', source_file: 'src/a.ts' },
        { id: 'b', source_file: 'src/b.ts' },
      ],
      links: [
        {
          relation: 'calls',
          confidence: 'EXTRACTED',
          source: 'a',
          target: 'b',
        },
      ],
    });
    const exec = makeExec({ gitnexusAvailable: false });
    const out = impact('', { exec, graphPath: path });
    assert.match(out, /EXTRACTED calls: a → b/);
  });

  it('derives the repo id through the injected git command', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const originalGitnexusRepo = process.env.HYDRA_GITNEXUS_REPO;
    const originalRepoId = process.env.HYDRA_REPO_ID;
    delete process.env.HYDRA_GITNEXUS_REPO;
    delete process.env.HYDRA_REPO_ID;
    const calls: Array<{ command: string; args: string[] }> = [];
    try {
      const exec = makeExec({
        repoRoot: '/fake/injected-repo',
        gitnexusAvailable: true,
        gitnexusOutputs: { impact: 'blast' },
        calls,
      });
      impact('sym', { exec, graphPath: path });
    } finally {
      if (originalGitnexusRepo === undefined) {
        delete process.env.HYDRA_GITNEXUS_REPO;
      } else {
        process.env.HYDRA_GITNEXUS_REPO = originalGitnexusRepo;
      }
      if (originalRepoId === undefined) {
        delete process.env.HYDRA_REPO_ID;
      } else {
        process.env.HYDRA_REPO_ID = originalRepoId;
      }
    }
    const call = calls.find(({ command }) => command === 'gitnexus');
    assert.ok(call);
    assert.deepEqual(call.args.slice(-2), ['--repo', 'injected-repo']);
  });
});

describe('query', () => {
  let originalRepo: string | undefined;

  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    originalRepo = process.env.HYDRA_GITNEXUS_REPO;
    process.env.HYDRA_GITNEXUS_REPO = 'test-repo';
  });

  after(() => {
    cleanTmp();
    if (originalRepo === undefined) {
      delete process.env.HYDRA_GITNEXUS_REPO;
    } else {
      process.env.HYDRA_GITNEXUS_REPO = originalRepo;
    }
  });

  it('renders execution flows and semantic results', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({
      repoRoot: '/fake/repo',
      gitnexusAvailable: true,
      graphifyAvailable: true,
      gitnexusOutputs: { query: 'flow A\nflow B' },
      graphifyOutput: 'semantic hit 1\nsemantic hit 2',
    });
    const out = query('how does auth work', { exec, graphPath: path });
    assert.match(out, /# code-intel: query\s+\(how does auth work\)/);
    assert.match(out, /## Execution flows — GitNexus/);
    assert.match(out, /flow A/);
    assert.match(out, /## Semantic — Graphify/);
    assert.match(out, /semantic hit 1/);
  });

  it('preserves Graphify ANSI output', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({
      gitnexusAvailable: false,
      graphifyAvailable: true,
      graphifyOutput: '\x1b[35msemantic hit\x1b[0m',
    });
    const out = query('q', { exec, graphPath: path });
    assert.match(out, /\x1b\[35msemantic hit\x1b\[0m/);
  });

  it('propagates a missing or failing Graphify command when a graph exists', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({ gitnexusAvailable: false });
    assert.throws(() => query('q', { exec, graphPath: path }), /graphify query failed/);
  });

  it('queries Graphify based on graph existence without parsing the graph', () => {
    const path = graphPath(makeRunId());
    writeFileSync(path, '{invalid', 'utf8');
    const exec = makeExec({
      gitnexusAvailable: false,
      graphifyAvailable: true,
      graphifyOutput: 'semantic hit',
    });
    const out = query('q', { exec, graphPath: path });
    assert.match(out, /semantic hit/);
  });

  it('limits both halves to 25 lines', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({
      repoRoot: '/fake/repo',
      gitnexusAvailable: true,
      graphifyAvailable: true,
      gitnexusOutputs: {
        query: Array.from({ length: 40 }, (_, i) => `flow ${i}`).join('\n'),
      },
      graphifyOutput: Array.from({ length: 40 }, (_, i) => `sem ${i}`).join('\n'),
    });
    const out = query('q', { exec, graphPath: path });
    const flowMatch = out.match(/## Execution flows — GitNexus[^\n]*\n([\s\S]*?)\n\n## Semantic/);
    const semMatch = out.match(/## Semantic — Graphify[^\n]*\n([\s\S]*?)$/);
    assert.ok(flowMatch);
    assert.ok(semMatch);
    assert.equal(flowMatch[1].trim().split('\n').length, 25);
    assert.equal(semMatch[1].trim().split('\n').length, 25);
  });

  it('omits semantic results when no graph exists', () => {
    const exec = makeExec({
      repoRoot: '/fake/repo',
      gitnexusAvailable: true,
      gitnexusOutputs: { query: 'flow A' },
    });
    const out = query('q', {
      exec,
      graphPath: join(TEST_TMP, 'missing-graph.json'),
    });
    assert.match(out, /\(no standing graph\)/);
  });
});

describe('drift', () => {
  let originalRepo: string | undefined;

  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    originalRepo = process.env.HYDRA_GITNEXUS_REPO;
    process.env.HYDRA_GITNEXUS_REPO = 'test-repo';
  });

  after(() => {
    cleanTmp();
    if (originalRepo === undefined) {
      delete process.env.HYDRA_GITNEXUS_REPO;
    } else {
      process.env.HYDRA_GITNEXUS_REPO = originalRepo;
    }
  });

  it('lists docs-to-code EXTRACTED edges', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [
        { id: 'doc', source_file: 'docs/design.md' },
        { id: 'code', source_file: 'src/foo.ts' },
        { id: 'other', source_file: 'hydra/scripts/bar.sh' },
        { id: 'noncode', source_file: 'README.md' },
      ],
      links: [
        {
          relation: 'implements',
          confidence: 'EXTRACTED',
          source: 'doc',
          target: 'code',
        },
        {
          relation: 'refs',
          confidence: 'EXTRACTED',
          source: 'doc',
          target: 'other',
        },
        {
          relation: 'mentions',
          confidence: 'EXTRACTED',
          source: 'doc',
          target: 'noncode',
        },
      ],
    });
    const out = drift({ graphPath: path });
    assert.match(out, /# code-intel: docs-vs-code drift/);
    assert.match(out, /Design→implementation edges to confirm.*2/);
    assert.match(out, /docs\/design.md\s+—implements→\s+src\/foo.ts/);
    assert.match(out, /docs\/design.md\s+—refs→\s+hydra\/scripts\/bar.sh/);
    assert.doesNotMatch(out, /README.md/);
  });

  it('matches edges in either direction', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [
        { id: 'doc', source_file: 'docs/design.md' },
        { id: 'code', source_file: 'hydra/foo.sh' },
      ],
      links: [
        {
          relation: 'documented-by',
          confidence: 'EXTRACTED',
          source: 'code',
          target: 'doc',
        },
      ],
    });
    const out = drift({ graphPath: path });
    assert.match(out, /docs\/design.md\s+—documented-by→\s+hydra\/foo.sh/);
  });

  it('dies when no standing graph exists', () => {
    let stdout = '';
    assert.throws(
      () => drift({
        graphPath: join(TEST_TMP, 'missing-graph.json'),
        stdout: (output) => {
          stdout += output;
        },
      }),
      /no standing graph — run: graphify-repo.sh build/,
    );
    assert.equal(
      stdout,
      '# code-intel: docs-vs-code drift  (Graphify design→implementation edges)\n\n',
    );
  });

  it('emits the header before an unreadable standing graph fails', () => {
    const path = graphPath(makeRunId());
    writeFileSync(path, '{invalid', 'utf8');
    let stdout = '';
    assert.throws(
      () => drift({
        graphPath: path,
        stdout: (output) => {
          stdout += output;
        },
      }),
      /JSON/,
    );
    assert.equal(
      stdout,
      '# code-intel: docs-vs-code drift  (Graphify design→implementation edges)\n\n',
    );
  });
});

describe('codeIntel dispatcher', () => {
  let originalRepo: string | undefined;

  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    originalRepo = process.env.HYDRA_GITNEXUS_REPO;
    process.env.HYDRA_GITNEXUS_REPO = 'test-repo';
  });

  after(() => {
    cleanTmp();
    if (originalRepo === undefined) {
      delete process.env.HYDRA_GITNEXUS_REPO;
    } else {
      process.env.HYDRA_GITNEXUS_REPO = originalRepo;
    }
  });

  it('dispatches changed with default base', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({ gitnexusAvailable: false, changedFiles: [] });
    const out = codeIntel(['changed'], { exec, graphPath: path });
    assert.match(out, /# code-intel: changed\s+\(base main\)/);
  });

  it('dispatches changed with --base', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    let capturedBase = '';
    const exec: ExecLike = (command, args) => {
      if (command === 'gitnexus' && args[0] === 'detect-changes') {
        const idx = args.indexOf('--base-ref');
        capturedBase = args[idx + 1];
      }
      return '';
    };
    codeIntel(['changed', '--base', 'develop'], { exec, graphPath: path });
    assert.equal(capturedBase, 'develop');
  });

  it('dispatches impact', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({ gitnexusAvailable: false });
    const out = codeIntel(['impact', 'mySymbol'], { exec, graphPath: path });
    assert.match(out, /# code-intel: impact\s+\(mySymbol\)/);
  });

  it('dispatches query', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, { nodes: [], links: [] });
    const exec = makeExec({
      gitnexusAvailable: false,
      graphifyAvailable: true,
    });
    const out = codeIntel(['query', 'my question'], { exec, graphPath: path });
    assert.match(out, /# code-intel: query\s+\(my question\)/);
  });

  it('dispatches drift', () => {
    const path = graphPath(makeRunId());
    writeGraph(path, {
      nodes: [
        { id: 'doc', source_file: 'docs/design.md' },
        { id: 'code', source_file: 'src/foo.ts' },
      ],
      links: [
        {
          relation: 'implements',
          confidence: 'EXTRACTED',
          source: 'doc',
          target: 'code',
        },
      ],
    });
    const out = codeIntel(['drift'], { graphPath: path });
    assert.match(out, /# code-intel: docs-vs-code drift/);
  });

  it('throws on missing or unknown verb', () => {
    assert.throws(() => codeIntel([]), /usage: code-intel/);
    assert.throws(() => codeIntel(['impact']), /usage: code-intel impact/);
    assert.throws(() => codeIntel(['query']), /usage: code-intel query/);
    assert.throws(() => codeIntel(['nope']), /usage: code-intel/);
  });
});
