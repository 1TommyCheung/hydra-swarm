import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  graphifyRepo,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from '../src/graphify-repo.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-graphify-repo');

interface Call {
  command: string;
  args: string[];
  options: CommandOptions;
}

interface Harness {
  root: string;
  calls: Call[];
  stdout: string[];
  stderr: string[];
  logs: string[];
  run: CommandRunner;
  response: (call: Call) => CommandResult;
}

const ok = (stdout = '', stderr = '', output?: string): CommandResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr,
  output,
});

function makeHarness(name: string): Harness {
  const root = join(TEST_TMP, name);
  mkdirSync(root, { recursive: true });
  const calls: Call[] = [];
  const harness: Harness = {
    root,
    calls,
    stdout: [],
    stderr: [],
    logs: [],
    response: (call) => {
      if (call.command === 'git') return ok('0123456789abcdef0123456789abcdef01234567\n');
      return ok();
    },
    run: async (command, args, options) => {
      const call = { command, args: [...args], options };
      calls.push(call);
      return harness.response(call);
    },
  };
  return harness;
}

function options(h: Harness, env: NodeJS.ProcessEnv = {}) {
  return {
    repoRoot: h.root,
    env,
    exec: h.run,
    graphifyPath: '/injected/bin/graphify',
    pythonPath: '/injected/bin/python3',
    stdout: (text: string) => h.stdout.push(text),
    stderr: (text: string) => h.stderr.push(text),
    logger: (text: string) => h.logs.push(text),
  };
}

function writeGraph(
  root: string,
  content: unknown = {
    nodes: [{ id: 1 }, { id: 2 }],
    links: [
      { confidence: 'EXTRACTED' },
      { confidence: 'INFERRED' },
      { confidence: 'EXTRACTED' },
    ],
  },
  nested = false,
): string {
  const directory = nested
    ? join(root, 'graphify-out', 'nested')
    : join(root, 'graphify-out');
  mkdirSync(directory, { recursive: true });
  const graph = join(directory, 'graph.json');
  writeFileSync(graph, JSON.stringify(content), 'utf8');
  return graph;
}

describe('graphifyRepo', { concurrency: 1 }, () => {
  before(() => {
    rmSync(TEST_TMP, { recursive: true, force: true });
    mkdirSync(TEST_TMP, { recursive: true });
  });
  after(() => rmSync(TEST_TMP, { recursive: true, force: true }));

  it('defaults to status and does not call graphify when no graph exists', async () => {
    const h = makeHarness('empty-status');
    const result = await graphifyRepo([], options(h));

    assert.equal(result, 'no standing repo graph yet — run: graphify-repo.sh build');
    assert.equal(h.stdout.join(''), `${result}\n`);
    assert.deepEqual(h.calls, []);
  });

  it('performs the graphify dependency gate before parsing the verb', async () => {
    const h = makeHarness('missing-cli');
    await assert.rejects(
      graphifyRepo(['destroy'], { ...options(h), graphifyPath: '' }),
      /graphify CLI not found \(Wave 2 dependency\)/,
    );
    assert.deepEqual(h.calls, []);
  });

  it('uses the injected runner for repository discovery', async () => {
    const h = makeHarness('discover-root');
    h.response = (call) => {
      if (call.command === 'git' && call.args[0] === 'rev-parse') {
        return ok(`${h.root}\n`);
      }
      return ok();
    };
    const configured = options(h);
    delete (configured as { repoRoot?: string }).repoRoot;

    await graphifyRepo(['status'], configured);

    assert.deepEqual(h.calls.map((call) => [call.command, call.args]), [
      ['git', ['rev-parse', '--show-toplevel']],
    ]);
  });

  it('reports up-to-date node and link counts', async () => {
    const h = makeHarness('fresh-status');
    writeGraph(h.root);
    writeFileSync(
      join(h.root, 'graphify-out', '.hydra_indexed_commit'),
      '0123456789abcdef0123456789abcdef01234567\n',
    );

    const result = await graphifyRepo(['status'], options(h));

    assert.equal(result, 'standing repo graph: 2 nodes, 3 edges — up-to-date');
    assert.deepEqual(h.calls.map((call) => [call.command, call.args]), [
      ['git', ['-C', h.root, 'rev-parse', 'HEAD']],
    ]);
  });

  it('reports stale status and uses edges when links is null', async () => {
    const h = makeHarness('stale-status');
    writeGraph(h.root, { nodes: [{}], links: null, edges: [{}, {}] });
    writeFileSync(join(h.root, 'graphify-out', '.hydra_indexed_commit'), 'deadbeef00\n');

    const result = await graphifyRepo(['status'], options(h));

    assert.equal(
      result,
      'standing repo graph: 1 nodes, 2 edges — STALE (indexed deadbeef, HEAD 01234567)',
    );
  });

  it('uses unknown when the status stamp is absent', async () => {
    const h = makeHarness('unknown-status');
    writeGraph(h.root, { nodes: [], edges: [] });
    const result = await graphifyRepo(['status'], options(h));
    assert.match(result, /STALE \(indexed unknown, HEAD 01234567\)/);
  });

  it('treats a graph.json directory as no standing graph', async () => {
    const h = makeHarness('graph-directory');
    mkdirSync(join(h.root, 'graphify-out', 'graph.json'), { recursive: true });
    const result = await graphifyRepo(['status'], options(h));
    assert.equal(result, 'no standing repo graph yet — run: graphify-repo.sh build');
  });

  it('rejects an unknown verb before invoking commands', async () => {
    const h = makeHarness('bad-verb');
    await assert.rejects(
      graphifyRepo(['destroy'], options(h)),
      /usage: graphify-repo\.sh build\|update\|query/,
    );
    assert.deepEqual(h.calls, []);
  });

  it('requires the backend-specific key and rejects unknown backends', async () => {
    const h = makeHarness('keys');
    await assert.rejects(
      graphifyRepo(['build', 'claude'], options(h, { MOONSHOT_API_KEY: 'wrong' })),
      /no LLM key for graphify --backend claude/,
    );
    await assert.rejects(
      graphifyRepo(['build', 'other'], options(h, { ANTHROPIC_API_KEY: 'key' })),
      /no LLM key for graphify --backend other/,
    );
    assert.deepEqual(h.calls, []);
  });

  it('builds with Kimi by default and writes the indexed commit', async () => {
    const h = makeHarness('build-kimi');
    h.response = (call) => {
      if (call.command === '/injected/bin/graphify') {
        writeGraph(h.root);
        return ok();
      }
      return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    };

    const result = await graphifyRepo(
      ['build'],
      options(h, { MOONSHOT_API_KEY: 'secret' }),
    );

    assert.equal(result, join(h.root, 'graphify-out', 'graph.json'));
    assert.deepEqual(h.calls[0].args, [
      'extract', h.root, '--backend', 'kimi', '--out', h.root,
    ]);
    assert.equal(h.calls[0].options.timeoutMs, 600_000);
    assert.equal(
      readFileSync(join(h.root, 'graphify-out', '.hydra_indexed_commit'), 'utf8'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
    );
    assert.match(h.logs[0], /backend kimi/);
    assert.match(h.logs[1], /2 nodes, 3 edges \(2 EXTRACTED\)/);
    assert.equal(h.stdout.join(''), `${result}\n`);
  });

  it('uses the Claude backend and configured timeout', async () => {
    const h = makeHarness('build-claude');
    h.response = (call) => {
      if (call.command === '/injected/bin/graphify') writeGraph(h.root);
      return call.command === 'git' ? ok('head\n') : ok();
    };
    await graphifyRepo(
      ['build', 'claude'],
      options(h, { ANTHROPIC_API_KEY: 'secret', GRAPHIFY_TIMEOUT_SEC: '7' }),
    );
    assert.deepEqual(h.calls[0].args, [
      'extract', h.root, '--backend', 'claude', '--out', h.root,
    ]);
    assert.equal(h.calls[0].options.timeoutMs, 7_000);
  });

  it('uses the injected Kimi interpreter adapter without invoking a real CLI', async () => {
    const h = makeHarness('build-kimi-override');
    h.response = (call) => {
      if (call.command === '/injected/bin/python3') writeGraph(h.root, {}, true);
      return call.command === 'git' ? ok('head\n') : ok();
    };

    const graph = await graphifyRepo(
      ['build', 'kimi'],
      {
        ...options(h, {
          MOONSHOT_API_KEY: 'secret',
          GRAPHIFY_KIMI_BASE_URL: 'https://example.invalid/coding',
        }),
        timeoutSec: 0.001,
        killGraceMs: 1,
      },
    );

    assert.equal(graph, join(h.root, 'graphify-out', 'nested', 'graph.json'));
    assert.equal(h.calls[0].command, '/injected/bin/python3');
    assert.deepEqual(h.calls[0].args, ['-', h.root]);
    assert.equal(h.calls[0].options.timeoutMs, 1);
    assert.match(h.calls[0].options.input ?? '', /GRAPHIFY_KIMI_BASE_URL/);
    assert.match(h.calls[0].options.input ?? '', /kimi-code-cli\/0\.23\.6/);
  });

  it('classifies regular and override build failures with the Bash messages', async () => {
    const regular = makeHarness('build-fail');
    regular.response = () => ({ ...ok(), exitCode: 124 });
    await assert.rejects(
      graphifyRepo(
        ['build'],
        { ...options(regular, { MOONSHOT_API_KEY: 'key' }), timeoutSec: 3 },
      ),
      /graphify extract failed or timed out after 3s/,
    );

    const override = makeHarness('override-fail');
    override.response = () => ({ ...ok(), exitCode: 1 });
    await assert.rejects(
      graphifyRepo(
        ['build'],
        options(override, {
          MOONSHOT_API_KEY: 'key',
          GRAPHIFY_KIMI_BASE_URL: 'https://example.invalid',
        }),
      ),
      /graphify extract \(override\) failed or timed out after 600s/,
    );
  });

  it('rejects a successful extraction that produces no graph', async () => {
    const h = makeHarness('no-graph');
    await assert.rejects(
      graphifyRepo(['build'], options(h, { MOONSHOT_API_KEY: 'key' })),
      /graphify produced no graph\.json/,
    );
    assert.equal(h.calls.some((call) => call.command === 'git'), false);
  });

  it('falls back to zero build counts for malformed graph JSON', async () => {
    const h = makeHarness('bad-build-json');
    h.response = (call) => {
      if (call.command === '/injected/bin/graphify') {
        const graph = writeGraph(h.root);
        writeFileSync(graph, '{invalid', 'utf8');
      }
      return call.command === 'git' ? ok('head\n') : ok();
    };
    await graphifyRepo(['build'], options(h, { MOONSHOT_API_KEY: 'key' }));
    assert.match(h.logs.at(-1) ?? '', /0 nodes, 0 edges \(0 EXTRACTED\)/);
  });

  it('requires a standing graph for update and query', async () => {
    const update = makeHarness('update-missing');
    await assert.rejects(
      graphifyRepo(['update'], options(update)),
      /no standing graph yet; run: graphify-repo\.sh build/,
    );
    const query = makeHarness('query-missing');
    await assert.rejects(
      graphifyRepo(['query', 'why'], options(query)),
      /no standing graph yet; run: graphify-repo\.sh build/,
    );
  });

  it('updates, prints only the last three merged lines, and refreshes the stamp', async () => {
    const h = makeHarness('update');
    writeGraph(h.root);
    h.response = (call) => {
      if (call.command === '/injected/bin/graphify') {
        return ok('ignored', 'ignored', 'one\ntwo\nthree\nfour\n');
      }
      return ok('new-head\n');
    };

    const result = await graphifyRepo(['update'], options(h));

    assert.equal(result, 'two\nthree\nfour\n');
    assert.equal(h.stdout.join(''), result);
    assert.deepEqual(h.calls[0].args, ['update', h.root]);
    assert.equal(
      readFileSync(join(h.root, 'graphify-out', '.hydra_indexed_commit'), 'utf8'),
      'new-head\n',
    );
  });

  it('does not refresh the stamp when update fails', async () => {
    const h = makeHarness('update-fail');
    writeGraph(h.root);
    h.response = () => ({ ...ok('', '', 'diagnostic\n'), exitCode: 1 });
    await assert.rejects(graphifyRepo(['update'], options(h)), /graphify update failed/);
    assert.equal(h.stdout.join(''), 'diagnostic\n');
    assert.equal(existsSync(join(h.root, 'graphify-out', '.hydra_indexed_commit')), false);
    assert.equal(h.calls.length, 1);
  });

  it('requires a nonempty query and forwards its stdout and stderr', async () => {
    const missing = makeHarness('query-empty');
    writeGraph(missing.root);
    await assert.rejects(
      graphifyRepo(['query'], options(missing)),
      /usage: graphify-repo\.sh query "<question>"/,
    );
    assert.deepEqual(missing.calls, []);

    const h = makeHarness('query');
    writeGraph(h.root);
    h.response = () => ok('answer\n', 'notice\n');
    const result = await graphifyRepo(['query', 'design intent', 'ignored'], options(h));
    assert.equal(result, 'answer\n');
    assert.deepEqual(h.calls[0].args, ['query', 'design intent']);
    assert.equal(h.stdout.join(''), 'answer\n');
    assert.equal(h.stderr.join(''), 'notice\n');
  });

  it('propagates query failures after forwarding diagnostics', async () => {
    const h = makeHarness('query-fail');
    writeGraph(h.root);
    h.response = () => ({ ...ok('', 'bad query\n'), exitCode: 2 });
    await assert.rejects(graphifyRepo(['query', 'q'], options(h)), /graphify query failed/);
    assert.equal(h.stderr.join(''), 'bad query\n');
  });
});
