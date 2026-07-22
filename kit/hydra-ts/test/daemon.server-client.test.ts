import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { daemonRequest } from '../src/daemon/client.ts';
import { startDaemonServer } from '../src/daemon/server.ts';

const TEST_TMP = join(import.meta.dirname, 'tmp-daemon-server');
const SOCKET_PATH = join(TEST_TMP, 'hydra-daemon.sock');

function clean(): void {
  if (existsSync(TEST_TMP)) {
    rmSync(TEST_TMP, { recursive: true, force: true });
  }
}

describe('daemon server/client', () => {
  before(() => {
    clean();
    mkdirSync(TEST_TMP, { recursive: true });
  });

  after(() => {
    clean();
  });

  it('serves health and shutdown operations over unix socket', async () => {
    const handle = await startDaemonServer({ socketPath: SOCKET_PATH });
    const health = await daemonRequest('health', {}, { socketPath: SOCKET_PATH });
    assert.equal(health.status, 'ok');
    const stopped = await daemonRequest('shutdown', {}, { socketPath: SOCKET_PATH });
    assert.equal(stopped.status, 'shutting_down');
    await handle.closed;
    assert.equal(existsSync(SOCKET_PATH), false);
  });

  it('returns validation errors for malformed operation payloads', async () => {
    const handle = await startDaemonServer({ socketPath: SOCKET_PATH });
    await assert.rejects(
      daemonRequest(
        'create-run',
        { base_commit: 'abc' },
        { socketPath: SOCKET_PATH },
      ),
      /validation_error: missing required string field: run_id/,
    );
    await handle.close();
  });
});
