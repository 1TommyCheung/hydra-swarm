import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hydraVersion, main } from '../src/version.ts';
import { route } from '../src/cli.ts';

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'),
) as { version: string };

function captureStdout(fn: () => number | Promise<number>): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    chunks.push(String(chunk));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .then((code) => ({ code, stdout: chunks.join('') }))
    .finally(() => {
      (process.stdout as unknown as { write: typeof original }).write = original;
    });
}

describe('version', () => {
  it('reports the plugin manifest version and the source runtime', () => {
    const info = hydraVersion();
    assert.equal(info.version, manifest.version);
    assert.equal(info.runtime, 'ts');
  });

  it('main prints the human line, --json the structured shape', async () => {
    const plain = await captureStdout(() => main([]));
    assert.equal(plain.code, 0);
    assert.equal(plain.stdout, `hydra-swarm ${manifest.version} (ts)\n`);

    const json = await captureStdout(() => main(['--json']));
    assert.equal(json.code, 0);
    assert.deepEqual(JSON.parse(json.stdout), { version: manifest.version, runtime: 'ts' });
  });

  it('routes through the CLI as an extension subcommand', async () => {
    const { code, stdout } = await captureStdout(() => route(['version']));
    assert.equal(code, 0);
    assert.match(stdout, new RegExp(`^hydra-swarm ${manifest.version.replace(/\./g, '\\.')} \\(ts\\)\n$`));
  });

  it('help routes to the usage listing on stdout with exit 0 and includes signatures', async () => {
    const { code, stdout } = await captureStdout(() => route(['help']));
    assert.equal(code, 0);
    assert.ok(stdout.startsWith('Usage: hydra <subcommand> [args...]'));
    assert.ok(stdout.includes('  version\n'));
    assert.ok(stdout.includes('<run_id> <task_id> [--lines N] [--json]'));
    assert.ok(stdout.includes('<run_id> <review_id> <vendor> <prompt_file> [--image PATH]'));
  });
});
