import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCompiledBinary, kitAssetText } from './kit-assets.ts';
import { repoRoot } from './lib.ts';

// The plugin manifest is the single version source of truth. A compiled
// binary cannot read the checkout (it may run outside any repo), so cli.ts
// embeds the manifest text at build time under the 'plugin.json' asset key —
// which also means a stale binary reports the version it was BUILT from, not
// whatever checkout it happens to sit near. That is the point: before this
// command, a binary's version could only be inferred from its mtime or by
// feature-probing.

export interface VersionInfo {
  version: string;
  runtime: 'compiled' | 'ts';
}

function manifestText(): string | null {
  if (isCompiledBinary()) {
    try {
      return kitAssetText('plugin.json');
    } catch {
      return null;
    }
  }
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json'),
  ];
  try {
    candidates.push(join(repoRoot(), '.claude-plugin', 'plugin.json'));
  } catch {
    // outside a git repo: the source-relative candidate still covers the dev checkout
  }
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

export function hydraVersion(): VersionInfo {
  const runtime = isCompiledBinary() ? 'compiled' : 'ts';
  const text = manifestText();
  if (text === null) return { version: 'unknown', runtime };
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return {
      version: typeof parsed.version === 'string' && parsed.version ? parsed.version : 'unknown',
      runtime,
    };
  } catch {
    return { version: 'unknown', runtime };
  }
}

export function main(args: string[] = process.argv.slice(2)): number {
  const info = hydraVersion();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(info)}\n`);
  } else {
    process.stdout.write(`hydra-swarm ${info.version} (${info.runtime})\n`);
  }
  return 0;
}

const isMain = !isCompiledBinary() && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  process.exitCode = main();
}
