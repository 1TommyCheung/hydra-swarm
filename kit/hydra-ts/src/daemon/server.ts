import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { log } from '../lib.ts';
import {
  DAEMON_OPERATION_HANDLERS,
  defaultDaemonDeps,
  type DaemonOperationDeps,
  type OperationHandler,
} from './handlers.ts';
import {
  errorResponse,
  parseDaemonRequestLine,
  successResponse,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
  type DaemonOperation,
} from './protocol.ts';

export interface DaemonServerOptions {
  socketPath: string;
  handlers?: Partial<Record<DaemonOperation, OperationHandler>>;
  deps?: Partial<DaemonOperationDeps>;
}

export interface DaemonServerHandle {
  socketPath: string;
  close(): Promise<void>;
  closed: Promise<void>;
}

function writeResponse(socket: Socket, response: DaemonResponseEnvelope): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function classifyError(
  request: DaemonRequestEnvelope | undefined,
  error: unknown,
): DaemonResponseEnvelope {
  const requestId = request?.id ?? 'unknown';
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('missing required') || message.includes('invalid') || message.includes('unknown operation')) {
    return errorResponse(requestId, 'validation_error', message);
  }
  if (message.includes('does not exist') || message.includes('not found')) {
    return errorResponse(requestId, 'not_found', message);
  }
  if (message.includes('already exists') || message.includes('conflict')) {
    return errorResponse(requestId, 'conflict', message);
  }
  if (message.includes('precondition')) {
    return errorResponse(requestId, 'precondition_failed', message);
  }
  return errorResponse(requestId, 'internal_error', message);
}

export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServerHandle> {
  const socketPath = resolve(options.socketPath);
  const deps: DaemonOperationDeps = { ...defaultDaemonDeps(), ...(options.deps ?? {}) };
  const handlers = { ...DAEMON_OPERATION_HANDLERS, ...(options.handlers ?? {}) };

  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true });
  }
  mkdirSync(dirname(socketPath), { recursive: true });

  const sockets = new Set<Socket>();
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) break;
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === '') continue;
        let request: DaemonRequestEnvelope | undefined;
        try {
          request = parseDaemonRequestLine(line);
          const handler = handlers[request.op];
          const result = await handler(
            { payload: request.payload ?? {}, env: process.env },
            deps,
          );
          writeResponse(socket, successResponse(request.id, result));
          if (request.op === 'shutdown') {
            closing = true;
            setImmediate(() => {
              void closeServer(server, socketPath, sockets, resolveClosed);
            });
          }
        } catch (error) {
          writeResponse(socket, classifyError(request, error));
        }
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('error', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(socketPath, () => resolvePromise());
  });
  chmodSync(socketPath, 0o600);
  log(`daemon listening on ${socketPath}`);

  return {
    socketPath,
    closed,
    close: async () => {
      if (closing) return;
      closing = true;
      await closeServer(server, socketPath, sockets, resolveClosed);
    },
  };
}

async function closeServer(
  server: Server,
  socketPath: string,
  sockets: Set<Socket>,
  resolveClosed: () => void,
): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
  rmSync(socketPath, { force: true });
  resolveClosed();
}
