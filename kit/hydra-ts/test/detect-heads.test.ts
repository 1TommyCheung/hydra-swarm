import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KNOWN_HEADS,
  availableHeadNames,
  defaultStateDir,
  detectHeads,
  headsFilePath,
  probeHeads,
  readHeadsFile,
  type HeadsSnapshot,
  type ProbeExec,
} from '../src/detect-heads.ts';
import { DEFAULT_MODEL } from '../src/adapter-opencode.ts';
import { runInit } from '../src/run-init.ts';
import { route } from '../src/cli.ts';
import { ledger } from '../src/lib.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-detect-heads');

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYDRA_HEADS_FILE = process.env.HYDRA_HEADS_FILE;
const ORIGINAL_HYDRA_STATE_ROOT = process.env.HYDRA_STATE_ROOT;
const ORIGINAL_HYDRA_REPO_ID = process.env.HYDRA_REPO_ID;

function cleanTmp(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

function makeTempDir(prefix: string): string {
  const p = join(TEST_TMP, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function restoreEnv(): void {
  for (const [key, value] of [
    ['HOME', ORIGINAL_HOME],
    ['HYDRA_HEADS_FILE', ORIGINAL_HYDRA_HEADS_FILE],
    ['HYDRA_STATE_ROOT', ORIGINAL_HYDRA_STATE_ROOT],
    ['HYDRA_REPO_ID', ORIGINAL_HYDRA_REPO_ID],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface ExecCall {
  file: string;
  args: string[];
  options?: { timeoutMs?: number };
}

/**
 * Fake probe exec: `sh -c 'command -v <name>'` resolves from `paths` (null =
 * not on PATH, mirroring a non-zero exit), `opencode models` replays
 * `modelsOutput` (or throws it when it is an Error).
 */
function fakeExec(
  paths: Record<string, string | null>,
  modelsOutput: string | Error = '',
): { exec: ProbeExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ProbeExec = (file, args, options) => {
    calls.push({ file, args, options });
    if (file === 'sh' && args[0] === '-c') {
      const match = String(args[1]).match(/^command -v (\S+)$/);
      const name = match?.[1] ?? '';
      const resolved = paths[name];
      if (resolved) return `${resolved}\n`;
      const error = new Error(`command -v ${name} failed`) as Error & { status?: number };
      error.status = 1;
      throw error;
    }
    if (file === 'opencode' && args[0] === 'models') {
      if (modelsOutput instanceof Error) throw modelsOutput;
      return modelsOutput;
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  return { exec, calls };
}

function allAvailableSnapshot(): HeadsSnapshot {
  return {
    detected_at: '2026-01-01T00:00:00Z',
    heads: {
      claude: { available: true, path: '/usr/local/bin/claude' },
      codex: { available: true, path: '/usr/local/bin/codex' },
      opencode: {
        available: true,
        path: '/usr/local/bin/opencode',
        models: ['zai-coding-plan/glm-5.2'],
        active_model: 'zai-coding-plan/glm-5.2',
      },
      kimi: { available: true, path: '/usr/local/bin/kimi', srt_available: true, write_capable: true },
    },
  };
}

describe('probeHeads', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('probes every known head with command -v and records availability', () => {
    const stateDir = makeTempDir('state');
    const { exec, calls } = fakeExec({
      claude: '/usr/local/bin/claude',
      codex: '/opt/homebrew/bin/codex',
      opencode: null,
      kimi: null,
      srt: null,
    });

    const snapshot = probeHeads({ exec, stateDir, env: {} });

    const probes = calls.filter((c) => c.file === 'sh').map((c) => c.args[1]);
    assert.deepEqual(probes, [
      'command -v claude',
      'command -v codex',
      'command -v opencode',
      'command -v kimi',
      'command -v srt',
    ]);

    assert.deepEqual(snapshot.heads.claude, { available: true, path: '/usr/local/bin/claude' });
    assert.deepEqual(snapshot.heads.codex, { available: true, path: '/opt/homebrew/bin/codex' });
    assert.deepEqual(snapshot.heads.opencode, {
      available: false,
      path: null,
      models: [],
      active_model: DEFAULT_MODEL,
    });
    assert.equal(snapshot.heads.kimi.available, false);
    assert.equal(snapshot.heads.kimi.path, null);
    assert.equal(snapshot.heads.kimi.srt_available, false);
    assert.equal(snapshot.heads.kimi.write_capable, false);
    assert.match(snapshot.heads.kimi.reason ?? '', /kimi CLI not found on PATH/);
    assert.match(snapshot.detected_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('does not run opencode models when the opencode CLI is unavailable', () => {
    const stateDir = makeTempDir('state');
    const { exec, calls } = fakeExec({
      claude: null,
      codex: null,
      opencode: null,
      kimi: null,
      srt: null,
    });

    probeHeads({ exec, stateDir, env: {} });

    assert.equal(calls.some((c) => c.file === 'opencode'), false);
  });

  it('enumerates opencode models with the configured timeout', () => {
    const stateDir = makeTempDir('state');
    const { exec, calls } = fakeExec(
      { claude: null, codex: null, opencode: '/usr/bin/opencode', kimi: null, srt: null },
      'zai-coding-plan/glm-5.2\n\n\x1b[32manthropic/claude-sonnet\x1b[0m\nzai-coding-plan/glm-5.2\n',
    );

    const snapshot = probeHeads({ exec, stateDir, env: {}, modelsTimeoutMs: 4321 });

    const modelsCall = calls.find((c) => c.file === 'opencode');
    assert.ok(modelsCall);
    assert.deepEqual(modelsCall.args, ['models']);
    assert.equal(modelsCall.options?.timeoutMs, 4321);
    assert.deepEqual(snapshot.heads.opencode.models, [
      'zai-coding-plan/glm-5.2',
      'anthropic/claude-sonnet',
    ]);
    assert.equal(snapshot.heads.opencode.available, true);
    assert.equal(snapshot.heads.opencode.path, '/usr/bin/opencode');
  });

  it('keeps opencode available with an empty model list when enumeration fails', () => {
    const stateDir = makeTempDir('state');
    const { exec } = fakeExec(
      { claude: null, codex: null, opencode: '/usr/bin/opencode', kimi: null, srt: null },
      new Error('opencode models timed out'),
    );

    const snapshot = probeHeads({ exec, stateDir, env: {} });

    assert.equal(snapshot.heads.opencode.available, true);
    assert.deepEqual(snapshot.heads.opencode.models, []);
  });

  it('resolves the active opencode model with adapter precedence', () => {
    const stateDir = makeTempDir('state');
    writeFileSync(join(stateDir, 'opencode-model.json'), JSON.stringify({ model: 'file/model' }));
    const { exec } = fakeExec({ opencode: '/usr/bin/opencode' }, 'file/model\n');

    // HYDRA_OPENCODE_MODEL beats the durable file.
    let snapshot = probeHeads({ exec, stateDir, env: { HYDRA_OPENCODE_MODEL: 'env/model' } });
    assert.equal(snapshot.heads.opencode.active_model, 'env/model');

    // The durable file beats the adapter default.
    snapshot = probeHeads({ exec, stateDir, env: {} });
    assert.equal(snapshot.heads.opencode.active_model, 'file/model');

    // An empty env value falls through to the file.
    snapshot = probeHeads({ exec, stateDir, env: { HYDRA_OPENCODE_MODEL: '' } });
    assert.equal(snapshot.heads.opencode.active_model, 'file/model');

    // No env, no file -> the adapter default.
    const emptyState = makeTempDir('state-empty');
    snapshot = probeHeads({ exec, stateDir: emptyState, env: {} });
    assert.equal(snapshot.heads.opencode.active_model, DEFAULT_MODEL);
  });

  it('records kimi write_capable from the srt probe', () => {
    const stateDir = makeTempDir('state');
    const withSrt = fakeExec({ kimi: '/usr/bin/kimi', srt: '/usr/bin/srt' });
    let snapshot = probeHeads({ exec: withSrt.exec, stateDir, env: {} });
    assert.deepEqual(snapshot.heads.kimi, {
      available: true,
      path: '/usr/bin/kimi',
      srt_available: true,
      write_capable: true,
    });
    assert.equal('reason' in snapshot.heads.kimi, false);

    const withoutSrt = fakeExec({ kimi: '/usr/bin/kimi', srt: null });
    snapshot = probeHeads({ exec: withoutSrt.exec, stateDir, env: {} });
    assert.equal(snapshot.heads.kimi.available, true);
    assert.equal(snapshot.heads.kimi.srt_available, false);
    assert.equal(snapshot.heads.kimi.write_capable, false);
    assert.match(snapshot.heads.kimi.reason ?? '', /srt/);
  });
});

describe('detectHeads', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('persists the snapshot to heads.json under the state dir', () => {
    const stateDir = makeTempDir('state');
    const { exec } = fakeExec({
      claude: '/usr/local/bin/claude',
      codex: null,
      opencode: null,
      kimi: '/usr/bin/kimi',
      srt: '/usr/bin/srt',
    });

    const snapshot = detectHeads({ exec, stateDir, env: {} });

    const written = JSON.parse(readFileSync(join(stateDir, 'heads.json'), 'utf8'));
    assert.deepEqual(written, snapshot);
    assert.equal(written.heads.claude.available, true);
    assert.equal(written.heads.codex.available, false);
    assert.equal(written.heads.kimi.write_capable, true);
  });

  it('reads a snapshot back with readHeadsFile and tolerates bad files', () => {
    const stateDir = makeTempDir('state');
    const { exec } = fakeExec({ claude: '/usr/local/bin/claude' });
    const snapshot = detectHeads({ exec, stateDir, env: {} });

    assert.deepEqual(readHeadsFile(join(stateDir, 'heads.json')), snapshot);
    assert.equal(readHeadsFile(join(stateDir, 'missing.json')), null);

    writeFileSync(join(stateDir, 'broken.json'), 'not json', 'utf8');
    assert.equal(readHeadsFile(join(stateDir, 'broken.json')), null);

    writeFileSync(join(stateDir, 'wrong-shape.json'), '{"heads": "nope"}', 'utf8');
    assert.equal(readHeadsFile(join(stateDir, 'wrong-shape.json')), null);
  });
});

describe('state dir and heads file resolution', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('defaults to the machine-global ~/.local/state/hydra directory', () => {
    assert.equal(
      defaultStateDir({ HOME: '/home/test' }),
      join('/home/test', '.local/state/hydra'),
    );
    assert.equal(
      headsFilePath({ env: { HOME: '/home/test' } }),
      join('/home/test', '.local/state/hydra', 'heads.json'),
    );
  });

  it('honours HYDRA_HEADS_FILE and an explicit stateDir override', () => {
    assert.equal(
      headsFilePath({ env: { HOME: '/home/test', HYDRA_HEADS_FILE: '/tmp/custom-heads.json' } }),
      '/tmp/custom-heads.json',
    );
    assert.equal(
      headsFilePath({ stateDir: '/tmp/state', env: { HYDRA_HEADS_FILE: '/tmp/custom-heads.json' } }),
      join('/tmp/state', 'heads.json'),
    );
  });

  it('lists available head names in stable order', () => {
    const snapshot = allAvailableSnapshot();
    snapshot.heads.codex.available = false;
    assert.deepEqual(availableHeadNames(snapshot), ['claude', 'opencode', 'kimi']);
    assert.deepEqual(availableHeadNames(allAvailableSnapshot()), [...KNOWN_HEADS]);
  });
});

describe('detect-heads CLI', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  const DETECT_HEADS_TS = join(import.meta.dirname, '..', 'src', 'detect-heads.ts');

  function runCli(args: string[], home: string) {
    return spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', DETECT_HEADS_TS, ...args],
      { encoding: 'utf8', env: { ...process.env, HOME: home } },
    );
  }

  it('prints the snapshot with --json and writes the machine-global heads.json', () => {
    const home = makeTempDir('home');
    const result = runCli(['--json'], home);

    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout) as HeadsSnapshot;
    assert.match(snapshot.detected_at, /^\d{4}-\d{2}-\d{2}T/);
    for (const name of KNOWN_HEADS) {
      assert.equal(typeof snapshot.heads[name].available, 'boolean', `${name} availability`);
    }
    assert.equal(typeof snapshot.heads.opencode.active_model, 'string');
    assert.ok(Array.isArray(snapshot.heads.opencode.models));
    assert.equal(typeof snapshot.heads.kimi.srt_available, 'boolean');
    assert.equal(typeof snapshot.heads.kimi.write_capable, 'boolean');

    const written = JSON.parse(
      readFileSync(join(home, '.local/state/hydra/heads.json'), 'utf8'),
    ) as HeadsSnapshot;
    assert.deepEqual(written, snapshot);
  });

  it('prints a per-head summary without --json', () => {
    const home = makeTempDir('home');
    const result = runCli([], home);

    assert.equal(result.status, 0, result.stderr);
    for (const name of KNOWN_HEADS) {
      assert.ok(result.stdout.includes(`${name}: `), `summary must list ${name}`);
    }
  });

  it('rejects unknown arguments with a usage error', () => {
    const home = makeTempDir('home');
    const result = runCli(['--bogus'], home);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: detect-heads/);
  });

  it('routes through cli.ts as an extension subcommand', async () => {
    const home = makeTempDir('home');
    process.env.HOME = home;
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await route(['detect-heads', '--json']);
      assert.equal(code, 0);
      const snapshot = JSON.parse(chunks.join('')) as HeadsSnapshot;
      assert.ok(snapshot.heads.claude);
      assert.ok(existsSync(join(home, '.local/state/hydra/heads.json')));
    } finally {
      process.stdout.write = originalWrite;
      restoreEnv();
    }
  });
});

describe('run-init head detection', () => {
  const STATE_TMP = join(TEST_TMP, 'run-init-state');

  before(() => {
    mkdirSync(TEST_TMP, { recursive: true });
    process.env.HYDRA_STATE_ROOT = STATE_TMP;
    process.env.HYDRA_REPO_ID = 'detect-heads-test-repo';
  });

  after(() => {
    cleanTmp();
    restoreEnv();
  });

  function ledgerEvents(runId: string): Array<Record<string, string>> {
    return readFileSync(ledger(runId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>);
  }

  it('appends heads_detected after run_started when a detector is injected', () => {
    const runId = `heads-${Date.now()}-a`;
    const snapshot = allAvailableSnapshot();
    snapshot.heads.opencode.available = false;

    runInit(runId, 'base123', { detectHeads: () => snapshot });

    const events = ledgerEvents(runId);
    assert.equal(events.length, 2);
    assert.equal(events[0].event, 'run_started');
    assert.equal(events[1].event, 'heads_detected');
    assert.equal(events[1].run_id, runId);
    assert.equal(events[1].available, 'claude,codex,kimi');
    assert.equal(events[1].count, '3');
    assert.ok(events[1].time);
  });

  it('records available as none when no head is available', () => {
    const runId = `heads-${Date.now()}-b`;
    const snapshot = allAvailableSnapshot();
    for (const name of KNOWN_HEADS) {
      (snapshot.heads[name] as { available: boolean }).available = false;
    }

    runInit(runId, 'base123', { detectHeads: () => snapshot });

    const events = ledgerEvents(runId);
    assert.equal(events.length, 2);
    assert.equal(events[1].event, 'heads_detected');
    assert.equal(events[1].available, 'none');
    assert.equal(events[1].count, '0');
  });

  it('skips the event when the detector returns null', () => {
    const runId = `heads-${Date.now()}-c`;
    runInit(runId, 'base123', { detectHeads: () => null });
    assert.deepEqual(ledgerEvents(runId).map((e) => e.event), ['run_started']);
  });

  it('warns and continues when the detector throws', () => {
    const runId = `heads-${Date.now()}-d`;
    const chunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      runInit(runId, 'base123', {
        detectHeads: () => {
          throw new Error('probe exploded');
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.deepEqual(ledgerEvents(runId).map((e) => e.event), ['run_started']);
    assert.match(chunks.join(''), /head detection failed/);
    assert.match(chunks.join(''), /probe exploded/);
  });

  it('performs no detection by default (detection is wired at the CLI boundary)', () => {
    const runId = `heads-${Date.now()}-e`;
    runInit(runId, 'base123');
    assert.deepEqual(ledgerEvents(runId).map((e) => e.event), ['run_started']);
  });

  it('run-init CLI detects heads and appends heads_detected', () => {
    const home = makeTempDir('home');
    const runId = `heads-cli-${Date.now()}`;
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-strip-types',
        join(import.meta.dirname, '..', 'src', 'run-init.ts'),
        runId,
        'base123',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          HYDRA_STATE_ROOT: STATE_TMP,
          HYDRA_REPO_ID: 'detect-heads-test-repo',
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const events = ledgerEvents(runId);
    assert.deepEqual(events.map((e) => e.event), ['run_started', 'heads_detected']);
    assert.equal(typeof events[1].available, 'string');
    assert.ok(existsSync(join(home, '.local/state/hydra/heads.json')));
  });
});
