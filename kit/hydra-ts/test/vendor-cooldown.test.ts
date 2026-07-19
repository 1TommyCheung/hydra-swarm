import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FALLBACK_COOLDOWN_MS,
  activeCooldown,
  cooldownFilePath,
  cooldownKey,
  recordCooldown,
} from '../src/vendor-cooldown.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-vendor-cooldown');

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HYDRA_COOLDOWN_FILE = process.env.HYDRA_COOLDOWN_FILE;

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
    ['HYDRA_COOLDOWN_FILE', ORIGINAL_HYDRA_COOLDOWN_FILE],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const T0 = Date.parse('2026-07-19T18:00:00.000Z');
const FUTURE = '2026-07-19T18:37:11.000Z';
const PAST = '2026-07-19T17:00:00.000Z';

describe('cooldownFilePath', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('prefers an explicit stateDir over every other resolution', () => {
    const stateDir = makeTempDir('state');
    assert.equal(
      cooldownFilePath({ stateDir, env: { HYDRA_COOLDOWN_FILE: '/elsewhere.json' } }),
      join(stateDir, 'vendor-cooldowns.json'),
    );
  });

  it('honors the HYDRA_COOLDOWN_FILE env override', () => {
    assert.equal(
      cooldownFilePath({ env: { HYDRA_COOLDOWN_FILE: '/tmp/override.json' } }),
      '/tmp/override.json',
    );
  });

  it('defaults to the machine-global ~/.local/state/hydra dir', () => {
    assert.equal(
      cooldownFilePath({ env: { HOME: '/home/operator' } }),
      '/home/operator/.local/state/hydra/vendor-cooldowns.json',
    );
  });
});

describe('cooldownKey', () => {
  it('keeps distinct vendor/provider/model combinations in distinct buckets', () => {
    const keys = new Set([
      cooldownKey('opencode'),
      cooldownKey('opencode', 'zai-coding-plan'),
      cooldownKey('opencode', 'zai-coding-plan', 'glm-5.2'),
      cooldownKey('opencode', 'other-provider', 'glm-5.2'),
      cooldownKey('codex'),
    ]);
    assert.equal(keys.size, 5);
  });

  it('never conflates an absent component with its literal string name', () => {
    assert.notEqual(cooldownKey('opencode'), cooldownKey('opencode', 'undefined'));
    assert.notEqual(cooldownKey('opencode'), cooldownKey('opencode', 'null'));
    assert.notEqual(cooldownKey('opencode', 'zai'), cooldownKey('opencode', 'zai', 'undefined'));
  });
});

describe('recordCooldown/activeCooldown', () => {
  before(() => mkdirSync(TEST_TMP, { recursive: true }));
  after(() => {
    cleanTmp();
    restoreEnv();
  });

  it('round-trips a vendor+provider+model cooldown with an atomic write', () => {
    const stateDir = makeTempDir('state');
    recordCooldown(
      { vendor: 'opencode', provider: 'zai-coding-plan', model: 'glm-5.2', retryAt: FUTURE, rawError: 'Usage limit reached for 5 hour' },
      { stateDir, now: () => T0 },
    );

    const cooldown = activeCooldown('opencode', 'zai-coding-plan', 'glm-5.2', { stateDir, now: () => T0 });
    assert.deepEqual(cooldown, { retryAt: FUTURE, rawError: 'Usage limit reached for 5 hour' });

    // The write is atomic: the target parses and no tmp sibling is left behind.
    const file = JSON.parse(readFileSync(cooldownFilePath({ stateDir }), 'utf8')) as { cooldowns: Record<string, unknown> };
    assert.equal(Object.keys(file.cooldowns).length, 1);
    assert.deepEqual(readdirSync(stateDir), ['vendor-cooldowns.json']);
  });

  it('a bare vendor query finds cooldowns recorded with provider/model detail', () => {
    const stateDir = makeTempDir('state');
    recordCooldown(
      { vendor: 'opencode', provider: 'zai-coding-plan', model: 'glm-5.2', retryAt: FUTURE, rawError: 'limited' },
      { stateDir, now: () => T0 },
    );
    const cooldown = activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 });
    assert.equal(cooldown?.retryAt, FUTURE);
  });

  it('does not conflate buckets across vendors or across provider/model queries', () => {
    const stateDir = makeTempDir('state');
    recordCooldown({ vendor: 'opencode', provider: 'zai', model: 'glm-5.2', retryAt: FUTURE, rawError: 'limited' }, { stateDir, now: () => T0 });
    recordCooldown({ vendor: 'codex', rawError: 'codex limited' }, { stateDir, now: () => T0 });

    assert.equal(activeCooldown('claude', undefined, undefined, { stateDir, now: () => T0 }), null);
    assert.equal(activeCooldown('opencode', 'other-provider', undefined, { stateDir, now: () => T0 }), null);
    assert.equal(activeCooldown('opencode', 'zai', 'other-model', { stateDir, now: () => T0 }), null);
    // The vendor-only codex bucket is distinct from any provider-qualified query.
    assert.equal(activeCooldown('codex', 'openai', undefined, { stateDir, now: () => T0 }), null);
    const codexCooldown = activeCooldown('codex', undefined, undefined, { stateDir, now: () => T0 });
    assert.equal(codexCooldown?.rawError, 'codex limited');
  });

  it('keeps "no provider known" distinct from the literal string undefined', () => {
    const stateDir = makeTempDir('state');
    recordCooldown({ vendor: 'opencode', rawError: 'no provider known' }, { stateDir, now: () => T0 });
    recordCooldown({ vendor: 'opencode', provider: 'undefined', retryAt: FUTURE, rawError: 'literal undefined provider' }, { stateDir, now: () => T0 });

    const literal = activeCooldown('opencode', 'undefined', undefined, { stateDir, now: () => T0 });
    assert.equal(literal?.rawError, 'literal undefined provider');
    const file = JSON.parse(readFileSync(cooldownFilePath({ stateDir }), 'utf8')) as { cooldowns: Record<string, unknown> };
    assert.equal(Object.keys(file.cooldowns).length, 2);
  });

  it('a future retryAt is active and expires on the injected clock without any clear step', () => {
    const stateDir = makeTempDir('state');
    recordCooldown(
      { vendor: 'opencode', retryAt: FUTURE, rawError: 'limited' },
      { stateDir, now: () => T0 },
    );

    const beforeReset = activeCooldown('opencode', undefined, undefined, {
      stateDir,
      now: () => Date.parse(FUTURE) - 1000,
    });
    assert.equal(beforeReset?.retryAt, FUTURE);
    // Once the clock passes the vendor's own reset time the cooldown is gone.
    assert.equal(
      activeCooldown('opencode', undefined, undefined, { stateDir, now: () => Date.parse(FUTURE) + 1000 }),
      null,
    );
  });

  it('a cooldown recorded with an already-past retryAt is immediately inactive', () => {
    const stateDir = makeTempDir('state');
    recordCooldown({ vendor: 'opencode', retryAt: PAST, rawError: 'limited' }, { stateDir, now: () => T0 });
    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 }), null);
  });

  it('falls back to the named FALLBACK_COOLDOWN_MS window when no retryAt is known', () => {
    assert.equal(FALLBACK_COOLDOWN_MS, 15 * 60 * 1000);
    const stateDir = makeTempDir('state');
    recordCooldown({ vendor: 'opencode', rawError: 'limited, reset unknown' }, { stateDir, now: () => T0 });

    const withinWindow = activeCooldown('opencode', undefined, undefined, {
      stateDir,
      now: () => T0 + FALLBACK_COOLDOWN_MS - 1000,
    });
    assert.ok(withinWindow);
    // The reset time is genuinely unknown — the hit carries no retryAt.
    assert.equal(withinWindow.retryAt, undefined);
    assert.equal(withinWindow.rawError, 'limited, reset unknown');
    // The fallback window expires on its own rather than blocking forever.
    assert.equal(
      activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 + FALLBACK_COOLDOWN_MS + 1000 }),
      null,
    );
  });

  it('treats an unparseable retryAt as unknown and applies the fallback window', () => {
    const stateDir = makeTempDir('state');
    recordCooldown({ vendor: 'opencode', retryAt: 'not a timestamp', rawError: 'limited' }, { stateDir, now: () => T0 });

    const withinWindow = activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 + 1000 });
    assert.ok(withinWindow);
    assert.equal(withinWindow.retryAt, undefined);
    assert.equal(
      activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 + FALLBACK_COOLDOWN_MS + 1000 }),
      null,
    );
  });

  it('tracks cooldowns for multiple vendors independently in one file', () => {
    const stateDir = makeTempDir('state');
    recordCooldown({ vendor: 'opencode', retryAt: FUTURE, rawError: 'opencode limited' }, { stateDir, now: () => T0 });
    recordCooldown({ vendor: 'claude', retryAt: PAST, rawError: 'claude limited' }, { stateDir, now: () => T0 });

    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 })?.rawError, 'opencode limited');
    assert.equal(activeCooldown('claude', undefined, undefined, { stateDir, now: () => T0 }), null);
  });

  it('refreshes an existing entry for the same key instead of duplicating it', () => {
    const stateDir = makeTempDir('state');
    recordCooldown({ vendor: 'opencode', retryAt: PAST, rawError: 'first' }, { stateDir, now: () => T0 });
    recordCooldown({ vendor: 'opencode', retryAt: FUTURE, rawError: 'second' }, { stateDir, now: () => T0 + 1000 });

    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 + 1000 })?.rawError, 'second');
    const file = JSON.parse(readFileSync(cooldownFilePath({ stateDir }), 'utf8')) as { cooldowns: Record<string, unknown> };
    assert.equal(Object.keys(file.cooldowns).length, 1);
  });

  it('fails open when the cooldown file is missing', () => {
    const stateDir = makeTempDir('state');
    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 }), null);
  });

  it('fails open when the cooldown file is corrupt or misshapen', () => {
    const stateDir = makeTempDir('state');
    const path = cooldownFilePath({ stateDir });

    writeFileSync(path, '{ not json', 'utf8');
    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 }), null);

    writeFileSync(path, '["not", "an", "object"]', 'utf8');
    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 }), null);

    writeFileSync(path, '{"cooldowns": [1, 2, 3]}', 'utf8');
    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 }), null);
  });

  it('recovers from a corrupt file on the next record instead of throwing', () => {
    const stateDir = makeTempDir('state');
    writeFileSync(cooldownFilePath({ stateDir }), '{ not json', 'utf8');

    recordCooldown({ vendor: 'opencode', retryAt: FUTURE, rawError: 'limited' }, { stateDir, now: () => T0 });
    assert.equal(activeCooldown('opencode', undefined, undefined, { stateDir, now: () => T0 })?.retryAt, FUTURE);
  });

  it('never throws when the cooldown file cannot be written', () => {
    const blocker = join(makeTempDir('state'), 'blocker');
    writeFileSync(blocker, 'a file, not a directory', 'utf8');
    // mkdir of the parent dir fails because `blocker` exists as a file.
    assert.doesNotThrow(() =>
      recordCooldown(
        { vendor: 'opencode', retryAt: FUTURE, rawError: 'limited' },
        { env: { HYDRA_COOLDOWN_FILE: join(blocker, 'vendor-cooldowns.json') }, now: () => T0 },
      ),
    );
  });
});
