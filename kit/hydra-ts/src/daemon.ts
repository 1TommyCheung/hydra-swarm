import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonRequest, daemonSocketPath } from './daemon/client.ts';
import { startDaemonServer } from './daemon/server.ts';
import { die, log } from './lib.ts';
import { isCompiledBinary } from './kit-assets.ts';

function usage(): never {
  die('usage: daemon <start|health|stop> [--socket <path>]');
}

function parseSocket(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--socket') continue;
    const value = args[index + 1];
    if (!value) usage();
    return resolve(value);
  }
  return undefined;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (!command) usage();
  const explicitSocket = parseSocket(args.slice(1));
  const socket = explicitSocket ?? daemonSocketPath();

  if (command === 'start') {
    if (!socket) {
      die('daemon start requires --socket <path> or HYDRA_DAEMON_SOCKET');
    }
    const handle = await startDaemonServer({ socketPath: socket });
    const shutdown = async (): Promise<void> => {
      await handle.close();
      process.exitCode = 0;
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
    process.on('SIGHUP', () => { void shutdown(); });
    await handle.closed;
    return 0;
  }

  if (command === 'health') {
    if (!socket) die('daemon health requires --socket <path> or HYDRA_DAEMON_SOCKET');
    const result = await daemonRequest('health', {}, { socketPath: socket });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  if (command === 'stop') {
    if (!socket) die('daemon stop requires --socket <path> or HYDRA_DAEMON_SOCKET');
    const result = await daemonRequest('shutdown', {}, { socketPath: socket });
    log(`daemon: ${String(result.status ?? 'stopping')}`);
    return 0;
  }

  usage();
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = await main();
}
