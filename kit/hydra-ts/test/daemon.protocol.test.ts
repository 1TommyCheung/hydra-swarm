import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAEMON_PROTOCOL_VERSION,
  parseDaemonRequestLine,
  successResponse,
  errorResponse,
} from '../src/daemon/protocol.ts';

describe('daemon protocol', () => {
  it('parses a valid request envelope', () => {
    const request = parseDaemonRequestLine(JSON.stringify({
      version: DAEMON_PROTOCOL_VERSION,
      id: 'req-1',
      op: 'create-run',
      payload: { run_id: '0042' },
    }));
    assert.equal(request.id, 'req-1');
    assert.equal(request.op, 'create-run');
    assert.deepEqual(request.payload, { run_id: '0042' });
  });

  it('rejects invalid request envelopes', () => {
    assert.throws(
      () => parseDaemonRequestLine('not json'),
      /invalid JSON/,
    );
    assert.throws(
      () => parseDaemonRequestLine(JSON.stringify({ version: 2, id: 'x', op: 'health' })),
      /unsupported protocol version/,
    );
    assert.throws(
      () => parseDaemonRequestLine(JSON.stringify({ version: 1, id: '', op: 'health' })),
      /missing or invalid id/,
    );
    assert.throws(
      () => parseDaemonRequestLine(JSON.stringify({ version: 1, id: 'x', op: 'nope' })),
      /unknown operation/,
    );
  });

  it('builds success and error responses', () => {
    assert.deepEqual(successResponse('ok-1', { value: 1 }), {
      version: 1,
      id: 'ok-1',
      ok: true,
      result: { value: 1 },
    });
    assert.deepEqual(errorResponse('err-1', 'validation_error', 'bad payload'), {
      version: 1,
      id: 'err-1',
      ok: false,
      error: {
        code: 'validation_error',
        message: 'bad payload',
      },
    });
  });
});
