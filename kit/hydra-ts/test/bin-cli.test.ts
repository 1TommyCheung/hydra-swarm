// Real-subprocess test for the Stage 0 compiled binary router.
// Builds src/bin-cli.ts with `bun build --compile` and exercises the resulting
// executable exactly as an operator would. Skips cleanly when Bun is absent.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const KIT_DIR = new URL('..', import.meta.url).pathname;
const BINARY_NAME = 'hydra-bin-stage0';

function bunAvailable(): boolean {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.trim().length > 0;
}

function buildBinary(outfile: string): void {
  const result = spawnSync(
    'bun',
    ['build', '--compile', '--outfile', outfile, 'src/bin-cli.ts'],
    { cwd: KIT_DIR, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `bun build failed (status ${result.status}): ${result.stderr ?? '(no stderr)'}`,
    );
  }
}

function runStatus(binary: string, cwd?: string): { status: number | null; json: unknown } {
  const result = spawnSync(binary, ['status'], {
    encoding: 'utf8',
    cwd,
  });
  let json: unknown = null;
  if (result.stdout) {
    try {
      json = JSON.parse(result.stdout.trim());
    } catch {
      // leave json as null; assertions below will fail with a clear message
    }
  }
  return { status: result.status, json };
}

describe('bin-cli compiled binary', { concurrency: 1 }, () => {
  if (!bunAvailable()) {
    it('skipped because bun is not on PATH', () => {
      console.log('SKIP: bun not found on PATH; compiled binary tests not run');
    });
    return;
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), `hydra-bin-cli-${process.pid}-`));
  const binaryPath = join(tmpRoot, BINARY_NAME);

  before(() => {
    buildBinary(binaryPath);
    assert.ok(existsSync(binaryPath), 'compiled binary must exist');
    assert.notEqual(statSync(binaryPath).mode & 0o111, 0, 'compiled binary must be executable');
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it(
    '`status` prints valid JSON with a self-re-exec check',
    { timeout: 60000 },
    () => {
      const { status, json } = runStatus(binaryPath);

      assert.equal(status, 0, 'status subcommand must exit 0');
      assert.ok(json && typeof json === 'object', 'status must print a JSON object');
      const report = json as Record<string, unknown>;
      assert.equal(report.ok, true);
      assert.equal(report.runtime, 'bun-cli-stage0');
      assert.ok(
        report.selfReexecCheck && typeof report.selfReexecCheck === 'object',
        'status must include selfReexecCheck',
      );
      const child = report.selfReexecCheck as Record<string, unknown>;
      assert.ok(
        typeof child.execPath === 'string' && child.execPath.length > 0,
        'child execPath must be a non-empty string',
      );
      assert.ok(
        existsSync(child.execPath),
        `child execPath must point at a real file: ${child.execPath}`,
      );
    },
  );

  it(
    'process.execPath resolves correctly when the binary is copied to another directory',
    { timeout: 60000 },
    () => {
      const movedDir = mkdtempSync(join(tmpRoot, 'moved-'));
      const movedBinary = join(movedDir, BINARY_NAME);
      copyFileSync(binaryPath, movedBinary);

      const { status, json } = runStatus(movedBinary, movedDir);

      assert.equal(status, 0, 'moved binary status must exit 0');
      assert.ok(json && typeof json === 'object', 'moved binary must print JSON');
      const report = json as Record<string, unknown>;
      const child = report.selfReexecCheck as Record<string, unknown>;
      assert.ok(
        typeof child.execPath === 'string',
        'moved binary self-reexec must report an execPath',
      );
      assert.equal(
        realpathSync(child.execPath),
        realpathSync(movedBinary),
        'moved binary self-reexec execPath must resolve to the moved copy',
      );
    },
  );

  it('unknown subcommand exits 2 with usage on stderr', { timeout: 30000 }, () => {
    const result = spawnSync(binaryPath, ['no-such-subcommand'], { encoding: 'utf8' });
    assert.equal(result.status, 2, 'unknown subcommand must exit 2');
    assert.ok(
      result.stderr && result.stderr.trim().length > 0,
      'unknown subcommand must print a non-empty stderr message',
    );
  });
});
