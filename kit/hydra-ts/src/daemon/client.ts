import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import {
  DAEMON_PROTOCOL_VERSION,
  errorResponse,
  type DaemonOperation,
  type DaemonResponseEnvelope,
} from './protocol.ts';

export interface DaemonClientOptions {
  socketPath?: string;
  timeoutMs?: number;
}

export function daemonSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.HYDRA_DAEMON_SOCKET;
  if (!value || value.trim() === '') return undefined;
  return resolve(value);
}

export async function daemonRequest(
  op: DaemonOperation,
  payload: Record<string, unknown> = {},
  options: DaemonClientOptions = {},
): Promise<Record<string, unknown>> {
  const socketPath = options.socketPath ?? daemonSocketPath();
  if (!socketPath) {
    throw new Error('HYDRA_DAEMON_SOCKET is not set');
  }
  const timeoutMs = options.timeoutMs ?? 5000;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    const client = createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      client.end();
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => rejectPromise(new Error(`daemon request timed out (${timeoutMs}ms)`)));
    }, timeoutMs);

    client.on('connect', () => {
      const envelope = {
        version: DAEMON_PROTOCOL_VERSION,
        id,
        op,
        payload,
      };
      client.write(`${JSON.stringify(envelope)}\n`);
    });

    client.on('data', (chunk: string | Buffer) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      let response: DaemonResponseEnvelope;
      try {
        response = JSON.parse(line) as DaemonResponseEnvelope;
      } catch (error) {
        clearTimeout(timer);
        finish(() => rejectPromise(new Error(`invalid daemon response: ${(error as Error).message}`)));
        return;
      }
      clearTimeout(timer);
      if (!response.ok) {
        const fallback = errorResponse(id, 'internal_error', 'unknown daemon error');
        const err = response.error ?? fallback.error!;
        finish(() => rejectPromise(new Error(`${err.code}: ${err.message}`)));
        return;
      }
      finish(() => resolvePromise(response.result ?? {}));
    });

    client.on('error', (error) => {
      clearTimeout(timer);
      finish(() => rejectPromise(new Error(`daemon connection failed: ${error.message}`)));
    });

    client.on('end', () => {
      if (settled) return;
      clearTimeout(timer);
      finish(() => rejectPromise(new Error('daemon closed connection before responding')));
    });
  });
}
