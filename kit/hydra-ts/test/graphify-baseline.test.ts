import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  graphifyBaseline,
  type ExecFileSyncLike,
} from '../src/graphify-baseline.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-graphify-baseline');
const MOCK_GRAPHIFY = join(TEST_TMP, 'mock-bin', 'graphify');
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_REPO_ID = process.env.HYDRA_REPO_ID;

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setupStateRoot(runId: string): { stateRoot: string; source: string } {
  const stateRoot = join(TEST_TMP, `state-${runId}`);
  const source = join(stateRoot, 'source');
  mkdirSync(source, { recursive: true });
  mkdirSync(join(stateRoot, 'runs', `run-${runId}`, 'authoritative', 'ledger'), {
    recursive: true,
  });
  return { stateRoot, source };
}

function readLedger(stateRoot: string, runId: string): Record<string, unknown>[] {
  const ledgerPath = join(
    stateRoot,
    'runs',
    `run-${runId}`,
    'authoritative',
    'ledger',
    'events.jsonl',
  );
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function captureStdout<T>(
  fn: () => T | Promise<T>,
): Promise<{ output: string; result: T }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await fn();
    return { output: chunks.join(''), result };
  } finally {
    process.stdout.write = originalWrite;
  }
}

interface ExecCall {
  command: string;
  args: string[];
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    encoding?: string;
    stdio?: any;
  };
}

function defaultMockExec(calls: ExecCall[]): ExecFileSyncLike {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'bash' && args[1] === 'command -v -- "$1"') {
      return `${MOCK_GRAPHIFY}\n`;
    }
    if (command === 'graphify' && args[0] === 'extract') {
      const outDir = args[args.length - 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, 'graph.json'),
        JSON.stringify({
          nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
          links: [
            { confidence: 'EXTRACTED' },
            { confidence: 'INFERRED' },
            { confidence: 'EXTRACTED' },
          ],
        }),
        'utf8',
      );
      return '';
    }
    if (command === 'python3' && args[0] === '-') {
      const outDir = args[args.length - 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, 'graph.json'),
        JSON.stringify({
          nodes: [{ id: 'a' }, { id: 'b' }],
          links: [{ confidence: 'EXTRACTED' }, { confidence: 'INFERRED' }],
        }),
        'utf8',
      );
      return '';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

describe('graphifyBaseline', () => {
  before(() => {
    cleanTmp();
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_REPO_ID = 'test-repo';
  });

  after(() => {
    cleanTmp();
    process.exitCode = ORIGINAL_EXIT_CODE;
    if (ORIGINAL_REPO_ID === undefined) {
      delete process.env.HYDRA_REPO_ID;
    } else {
      process.env.HYDRA_REPO_ID = ORIGINAL_REPO_ID;
    }
  });

  it('throws when runId is missing', () => {
    const calls: ExecCall[] = [];
    assert.throws(
      () =>
        graphifyBaseline('', 'src', 'kimi', {
          execFileSync: defaultMockExec(calls),
        }),
      /usage: graphifyBaseline/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'bash');
  });

  it('checks for graphify before validating arguments', () => {
    const calls: ExecCall[] = [];
    const exec: ExecFileSyncLike = (command, args, options) => {
      calls.push({ command, args, options });
      throw new Error('not found');
    };

    assert.throws(
      () => graphifyBaseline('', 'src', 'kimi', { execFileSync: exec }),
      /graphify CLI not found \(Wave 2 dependency\)/,
    );
    assert.equal(calls.length, 1);
  });

  it('exits 1 for an uncaught usage error, matching hydra_die', () => {
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, '../src/graphify-baseline.ts'),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `import { graphifyBaseline } from ${JSON.stringify(moduleUrl)};
         const execFileSync = (command) => {
           if (command === 'bash') return '/mock/bin/graphify\\n';
           throw new Error('unexpected external command');
         };
         graphifyBaseline('', 'src', 'kimi', { execFileSync });`,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(child.status, 1);
    assert.match(child.stderr, /usage: graphifyBaseline/);
  });

  it('skips the baseline when no Moonshot key is present', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const calls: ExecCall[] = [];

    const previousExitCode = process.exitCode;
    try {
      const result = graphifyBaseline(runId, source, 'kimi', {
        stateRoot,
        env: {},
        execFileSync: defaultMockExec(calls),
      });

      assert.deepEqual(result, { status: 'skipped_no_key', backend: 'kimi' });
      assert.equal(process.exitCode, 8);

      const ledger = readLedger(stateRoot, runId);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].event, 'graphify_baseline');
      assert.equal(ledger[0].status, 'skipped_no_key');
      assert.equal(ledger[0].backend, 'kimi');
      assert.equal(ledger[0].run_id, runId);
      assert.equal(
        existsSync(
          join(stateRoot, 'indexes', 'graphify', 'test-repo', `run-${runId}`),
        ),
        true,
      );

      // No graphify invocation when the key is missing.
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'bash');
    } finally {
      process.exitCode = previousExitCode ?? undefined;
    }
  });

  it('skips the baseline when no Anthropic key is present for claude', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const calls: ExecCall[] = [];

    const previousExitCode = process.exitCode;
    try {
      const result = graphifyBaseline(runId, source, 'claude', {
        stateRoot,
        env: {},
        execFileSync: defaultMockExec(calls),
      });

      assert.deepEqual(result, { status: 'skipped_no_key', backend: 'claude' });
      assert.equal(process.exitCode, 8);

      const ledger = readLedger(stateRoot, runId);
      assert.equal(ledger[0].status, 'skipped_no_key');
      assert.equal(ledger[0].backend, 'claude');
    } finally {
      process.exitCode = previousExitCode ?? undefined;
    }
  });

  it('does not accept a key belonging to the other backend', () => {
    const cases = [
      { backend: 'kimi' as const, env: { ANTHROPIC_API_KEY: 'ant-test' } },
      { backend: 'claude' as const, env: { MOONSHOT_API_KEY: 'msk-test' } },
    ];

    for (const { backend, env } of cases) {
      const runId = makeRunId();
      const { stateRoot, source } = setupStateRoot(runId);
      const calls: ExecCall[] = [];
      const previousExitCode = process.exitCode;
      try {
        const result = graphifyBaseline(runId, source, backend, {
          stateRoot,
          env,
          execFileSync: defaultMockExec(calls),
        });
        assert.equal(result.status, 'skipped_no_key');
        assert.equal(process.exitCode, 8);
        assert.deepEqual(calls.map((call) => call.command), ['bash']);
      } finally {
        process.exitCode = previousExitCode ?? undefined;
      }
    }
  });

  it('runs graphify with a Moonshot key and reports stats', async () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const calls: ExecCall[] = [];

    const { output, result } = await captureStdout(() =>
      graphifyBaseline(runId, source, 'kimi', {
        stateRoot,
        env: { MOONSHOT_API_KEY: 'msk-test' },
        execFileSync: defaultMockExec(calls),
      }),
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.backend, 'kimi');
    assert.equal(result.nodes, 3);
    assert.equal(result.edges, 3);
    assert.equal(result.extracted, 2);
    assert.equal(result.inferred, 1);
    assert.equal(
      result.graphPath,
      join(
        stateRoot,
        'indexes',
        'graphify',
        'test-repo',
        `run-${runId}`,
        'graph.json',
      ),
    );
    assert.equal(output.trim(), result.graphPath);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, 'bash');
    assert.equal(calls[1].command, 'graphify');
    assert.deepEqual(calls[1].args, [
      'extract',
      source,
      '--backend',
      'kimi',
      '--out',
      dirname(result.graphPath!),
    ]);
    assert.equal(calls[1].options?.cwd, source);

    const ledger = readLedger(stateRoot, runId);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].event, 'graphify_baseline');
    assert.equal(ledger[0].status, 'ok');
    assert.equal(ledger[0].backend, 'kimi');
    assert.equal(ledger[0].nodes, '3');
    assert.equal(ledger[0].edges, '3');
    assert.equal(ledger[0].extracted, '2');
    assert.equal(ledger[0].inferred, '1');
  });

  it('runs graphify with an Anthropic key', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const calls: ExecCall[] = [];

    const result = graphifyBaseline(runId, source, 'claude', {
      stateRoot,
      env: { ANTHROPIC_API_KEY: 'ant-test' },
      execFileSync: defaultMockExec(calls),
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.backend, 'claude');
    assert.equal(calls[1].command, 'graphify');
    assert.equal(calls[1].args[3], 'claude');
  });

  it('uses the Kimi coding-plan override path when GRAPHIFY_KIMI_BASE_URL is set', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const calls: ExecCall[] = [];

    const env = {
      MOONSHOT_API_KEY: 'msk-test',
      GRAPHIFY_KIMI_BASE_URL: 'https://api.kimi.com/coding',
      GRAPHIFY_KIMI_MODEL: 'kimi-custom',
    };
    const result = graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env,
      execFileSync: defaultMockExec(calls),
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.backend, 'kimi');
    assert.equal(result.nodes, 2);

    // The Bash source performs the dependency gate and then resolves the
    // interpreter beside graphify for the override invocation.
    assert.equal(calls.length, 3);
    assert.equal(calls[0].command, 'bash');
    assert.equal(calls[1].command, 'bash');
    assert.equal(calls[2].command, 'python3');
    assert.deepEqual(calls[2].args.slice(0, 2), ['-', source]);
    assert.ok(calls[2].options?.input?.includes('GRAPHIFY_KIMI_BASE_URL'));
    assert.ok(calls[2].options?.input?.includes('kimi-for-coding'));
    assert.equal(calls[2].options?.env, env);
    assert.equal(calls[2].options?.cwd, source);
  });

  it("prefers graphify's executable sibling python3 for the Kimi override", () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const binDir = join(TEST_TMP, `graphify-bin-${runId}`);
    const graphifyPath = join(binDir, 'graphify');
    const pythonPath = join(binDir, 'python3');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(pythonPath, '#!/bin/sh\n', 'utf8');
    chmodSync(pythonPath, 0o755);

    const calls: ExecCall[] = [];
    const exec: ExecFileSyncLike = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'bash') return `${graphifyPath}\n`;
      if (command === pythonPath && args[0] === '-') {
        const outDir = args[args.length - 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, 'graph.json'),
          JSON.stringify({ nodes: [], links: [] }),
          'utf8',
        );
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env: {
        MOONSHOT_API_KEY: 'msk-test',
        GRAPHIFY_KIMI_BASE_URL: 'https://api.kimi.com/coding',
      },
      execFileSync: exec,
    });

    assert.equal(result.status, 'ok');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].command, pythonPath);
  });

  it('maps Kimi override extraction failures to the Bash hydra_die message', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const exec: ExecFileSyncLike = (command) => {
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'python3') throw new Error('python failed');
      throw new Error(`unexpected command: ${command}`);
    };

    assert.throws(
      () =>
        graphifyBaseline(runId, source, 'kimi', {
          stateRoot,
          env: {
            MOONSHOT_API_KEY: 'msk-test',
            GRAPHIFY_KIMI_BASE_URL: 'https://api.kimi.com/coding',
          },
          execFileSync: exec,
        }),
      /graphify extract \(override\) failed/,
    );
  });

  it('computes stats from .edges when .links is absent', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const calls: ExecCall[] = [];

    const exec: ExecFileSyncLike = (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'graphify' && args[0] === 'extract') {
        const outDir = args[args.length - 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, 'graph.json'),
          JSON.stringify({
            nodes: [{ id: 'a' }, { id: 'b' }],
            edges: [
              { confidence: 'EXTRACTED' },
              { confidence: 'INFERRED' },
            ],
          }),
          'utf8',
        );
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env: { MOONSHOT_API_KEY: 'msk-test' },
      execFileSync: exec,
    });

    assert.equal(result.edges, 2);
    assert.equal(result.extracted, 1);
    assert.equal(result.inferred, 1);
  });

  it('falls back to .edges when .links is false, matching jq alternative semantics', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const exec: ExecFileSyncLike = (command, args) => {
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'graphify') {
        const outDir = args[args.length - 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, 'graph.json'),
          JSON.stringify({
            nodes: {},
            links: false,
            edges: [{ confidence: 'EXTRACTED' }],
          }),
          'utf8',
        );
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env: { MOONSHOT_API_KEY: 'msk-test' },
      execFileSync: exec,
    });

    assert.equal(result.nodes, 0);
    assert.equal(result.edges, 1);
    assert.equal(result.extracted, 1);
    assert.equal(result.inferred, 0);
  });

  it('treats null link entries like jq when counting confidence values', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const exec: ExecFileSyncLike = (command, args) => {
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'graphify') {
        const outDir = args[args.length - 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, 'graph.json'),
          JSON.stringify({
            nodes: [],
            links: [null, { confidence: 'EXTRACTED' }],
          }),
          'utf8',
        );
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env: { MOONSHOT_API_KEY: 'msk-test' },
      execFileSync: exec,
    });

    assert.equal(result.edges, 2);
    assert.equal(result.extracted, 1);
    assert.equal(result.inferred, 0);
  });

  it('maps graphify extraction failures to the Bash hydra_die message', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const exec: ExecFileSyncLike = (command) => {
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'graphify') throw new Error('spawn ENOENT');
      throw new Error(`unexpected command: ${command}`);
    };

    assert.throws(
      () =>
        graphifyBaseline(runId, source, 'kimi', {
          stateRoot,
          env: { MOONSHOT_API_KEY: 'msk-test' },
          execFileSync: exec,
        }),
      /graphify extract failed/,
    );
  });

  it('dies when graphify produces no graph.json', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);

    const exec: ExecFileSyncLike = (command, args, options) => {
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'graphify' && args[0] === 'extract') {
        // Do nothing; leave outDir empty.
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    assert.throws(
      () =>
        graphifyBaseline(runId, source, 'kimi', {
          stateRoot,
          env: { MOONSHOT_API_KEY: 'msk-test' },
          execFileSync: exec,
        }),
      /graphify produced no graph\.json/,
    );
  });

  it('reports zero stats when graph.json is not valid JSON, matching jq fallbacks', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);

    const exec: ExecFileSyncLike = (command, args) => {
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'graphify' && args[0] === 'extract') {
        const outDir = args[args.length - 1];
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'graph.json'), 'not-json', 'utf8');
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env: { MOONSHOT_API_KEY: 'msk-test' },
      execFileSync: exec,
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.nodes, 0);
    assert.equal(result.edges, 0);
    assert.equal(result.extracted, 0);
    assert.equal(result.inferred, 0);

    const ledger = readLedger(stateRoot, runId);
    assert.equal(ledger[0].status, 'ok');
    assert.equal(ledger[0].nodes, '0');
    assert.equal(ledger[0].edges, '0');
  });

  it('creates a stable pointer to the discovered graph.json', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);

    const exec: ExecFileSyncLike = (command, args) => {
      if (command === 'bash') return `${MOCK_GRAPHIFY}\n`;
      if (command === 'graphify' && args[0] === 'extract') {
        const outDir = args[args.length - 1];
        const nested = join(outDir, 'graphify-out');
        mkdirSync(nested, { recursive: true });
        writeFileSync(
          join(nested, 'graph.json'),
          JSON.stringify({ nodes: [{ id: 'a' }], links: [{ confidence: 'EXTRACTED' }] }),
          'utf8',
        );
        return '';
      }
      throw new Error(`unexpected command: ${command}`);
    };

    const result = graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env: { MOONSHOT_API_KEY: 'msk-test' },
      execFileSync: exec,
    });

    const stablePointer = join(
      stateRoot,
      'indexes',
      'graphify',
      'test-repo',
      `run-${runId}`,
      'graph.json',
    );
    assert.equal(result.graphPath, stablePointer);
    assert.equal(existsSync(stablePointer), true);
    const target = readlinkSync(stablePointer);
    assert.ok(target.includes('graphify-out'));
  });

  it('resolves a relative source path against cwd', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const cwd = dirname(source);
    const rel = source.slice(cwd.length + 1);
    const calls: ExecCall[] = [];

    const result = graphifyBaseline(runId, rel, 'kimi', {
      cwd,
      stateRoot,
      env: { MOONSHOT_API_KEY: 'msk-test' },
      execFileSync: defaultMockExec(calls),
    });

    assert.equal(result.status, 'ok');
    assert.equal(calls[1].args[1], source);
    assert.equal(calls[1].options?.cwd, source);
  });

  it('uses the injected execFileSync for all external calls', () => {
    const runId = makeRunId();
    const { stateRoot, source } = setupStateRoot(runId);
    const calls: ExecCall[] = [];

    graphifyBaseline(runId, source, 'kimi', {
      stateRoot,
      env: { MOONSHOT_API_KEY: 'msk-test' },
      execFileSync: defaultMockExec(calls),
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, 'bash');
    assert.equal(calls[1].command, 'graphify');
  });
});
