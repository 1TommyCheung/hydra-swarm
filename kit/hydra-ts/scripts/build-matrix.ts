// build-matrix.ts — Stage 1 Phase 3 reproducible-build matrix.
//
// Builds `src/cli.ts` into one compiled single-file executable per supported
// target with `bun build --compile`, then records provenance (source commit
// SHA, pinned Bun version, target, size, SHA-256) into manifest files, per
// docs/bun-migration-plan-codex.md "Reproducible build" and
// docs/bun-migration-stage3-build-matrix.md.
//
// Targets (glibc Linux; musl is explicitly OUT of scope — see the stage-3
// doc's follow-ups):
//   bun-darwin-arm64  bun-darwin-x64  bun-linux-x64  bun-linux-arm64
//
// Bun resolution matches the hydra_resolve_node() "pin/resolve/assert" spirit
// (kit/hydra/scripts/lib.sh): only controlled, explicit locations are probed
// ($HYDRA_BUN, then ~/.bun/bin/bun), the binary is executed once to assert and
// record its version, and there is deliberately NO fallback to a bare `bun`
// on PATH (the plan's build-time PATH-shadowing risk). Missing/unusable Bun is
// a loud error, never a silent fallback.
//
// Cross-compiling a non-native target makes Bun download that target's
// runtime once (printed as `Downloading [...]`); that is expected, not an
// error. A target whose runtime cannot be downloaded (e.g. no network) fails
// that target only: it is omitted from the manifests (never faked), the
// summary marks it FAILED, and the script exits non-zero.
//
// Usage:
//   node --experimental-strip-types scripts/build-matrix.ts [--targets=a,b,...]
//
// Output layout:
//   dist/<target>/hydra-cli       compiled executable
//   dist/<target>/manifest.json   per-artifact manifest (plan: "one manifest
//                                 per artifact")
//   dist/manifest.json            aggregate manifest for the whole run

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HYDRA_TS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(HYDRA_TS_ROOT, 'dist');
const ENTRYPOINT = 'src/cli.ts';
const OUTFILE_NAME = 'hydra-cli';
const BUILD_FLAGS = ['--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'];

const DEFAULT_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
] as const;

interface ArtifactManifest {
  schema_version: 1;
  source_sha: string;
  bun_version: string;
  bun_path: string;
  built_at: string;
  entrypoint: string;
  build_flags: string[];
  target: string;
  outfile: string;
  size_bytes: number;
  sha256: string;
}

function die(message: string): never {
  process.stderr.write(`build-matrix: error: ${message}\n`);
  process.exit(1);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the pinned Bun executable from controlled locations only and assert
 * its version. Never falls back to a bare `bun` on PATH.
 */
function resolveBun(): { path: string; version: string } {
  const candidates: string[] = [];
  if (process.env.HYDRA_BUN !== undefined && process.env.HYDRA_BUN !== '') {
    candidates.push(process.env.HYDRA_BUN);
  }
  candidates.push(join(homedir(), '.bun', 'bin', 'bun'));

  for (const candidate of candidates) {
    if (!existsSync(candidate) || !isExecutable(candidate)) continue;
    let version: string;
    try {
      version = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim();
    } catch (error) {
      die(`found Bun candidate at ${candidate} but could not execute it: ${error}`);
    }
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      die(`found Bun candidate at ${candidate} but 'bun --version' returned an unexpected value: ${JSON.stringify(version)}`);
    }
    return { path: candidate, version };
  }

  die(
    'no Bun executable found in controlled locations (probed: '
    + candidates.join(', ')
    + '). Install Bun to ~/.bun/bin/bun or set HYDRA_BUN to an absolute path. '
    + 'A bare `bun` from PATH is deliberately never used (build-time PATH-shadowing risk).',
  );
}

function sourceSha(): string {
  let sha: string;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HYDRA_TS_ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    die(`git rev-parse HEAD failed: ${error}`);
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    die(`git rev-parse HEAD returned an unexpected value: ${JSON.stringify(sha)}`);
  }
  return sha;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseTargets(argv: string[]): string[] {
  const flag = argv.find((arg) => arg.startsWith('--targets='));
  const unknown = argv.filter((arg) => !arg.startsWith('--targets='));
  if (unknown.length > 0) {
    die(`unknown argument(s): ${unknown.join(' ')} (only --targets=a,b,... is supported)`);
  }
  if (flag === undefined) return [...DEFAULT_TARGETS];
  const requested = flag.slice('--targets='.length).split(',').filter((part) => part !== '');
  const invalid = requested.filter((t) => !(DEFAULT_TARGETS as readonly string[]).includes(t));
  if (invalid.length > 0) {
    die(`unknown target(s): ${invalid.join(', ')} (supported: ${DEFAULT_TARGETS.join(', ')})`);
  }
  if (requested.length === 0) die('--targets= given but empty');
  return requested;
}

function buildTarget(
  target: string,
  bun: { path: string; version: string },
  sha: string,
  builtAt: string,
): ArtifactManifest | null {
  const outDir = join(DIST_DIR, target);
  const outfile = join(outDir, OUTFILE_NAME);
  mkdirSync(outDir, { recursive: true });

  process.stdout.write(`\n[build] ${target} -> ${relative(HYDRA_TS_ROOT, outfile)}\n`);
  // execFileSync returns normally only on exit 0; a non-zero exit throws with
  // the child's status attached. stdio: inherit keeps bun's own progress and
  // error output (including the one-time runtime `Downloading [...]` line for
  // cross-compiles) visible in the build log.
  let status = 0;
  try {
    execFileSync(
      bun.path,
      ['build', ...BUILD_FLAGS, `--target=${target}`, '--outfile', outfile, ENTRYPOINT],
      { cwd: HYDRA_TS_ROOT, stdio: 'inherit' },
    );
  } catch (error) {
    status = (error as { status?: number }).status ?? 1;
  }
  if (status !== 0) {
    process.stderr.write(
      `[build] ${target} FAILED (bun exited ${status}). Cross-compiling a non-native target\n`
      + `        downloads that target's Bun runtime once; without network access that\n`
      + `        download fails. This target is omitted from the manifest (never faked).\n`,
    );
    return null;
  }
  if (!existsSync(outfile) || statSync(outfile).size === 0) {
    process.stderr.write(`[build] ${target} FAILED (bun exited 0 but ${outfile} is missing/empty)\n`);
    return null;
  }

  const manifest: ArtifactManifest = {
    schema_version: 1,
    source_sha: sha,
    bun_version: bun.version,
    bun_path: bun.path,
    built_at: builtAt,
    entrypoint: ENTRYPOINT,
    build_flags: [...BUILD_FLAGS, `--target=${target}`],
    target,
    outfile: `${relative(HYDRA_TS_ROOT, outfile)}`,
    size_bytes: statSync(outfile).size,
    sha256: sha256File(outfile),
  };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`[build] ${target} ok: ${manifest.size_bytes} bytes, sha256 ${manifest.sha256}\n`);
  return manifest;
}

function main(argv: string[]): number {
  const targets = parseTargets(argv);
  const bun = resolveBun();
  const sha = sourceSha();
  const builtAt = new Date().toISOString();

  process.stdout.write(
    `build-matrix: bun ${bun.version} (${bun.path}), source ${sha.slice(0, 12)}, targets: ${targets.join(', ')}\n`,
  );

  const built: ArtifactManifest[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    const manifest = buildTarget(target, bun, sha, builtAt);
    if (manifest === null) failed.push(target);
    else built.push(manifest);
  }

  if (built.length > 0) {
    const aggregate = {
      schema_version: 1,
      source_sha: sha,
      bun_version: bun.version,
      bun_path: bun.path,
      built_at: builtAt,
      entrypoint: ENTRYPOINT,
      build_flags: [...BUILD_FLAGS],
      targets: built.map(({ target, outfile, size_bytes, sha256 }) => (
        { target, outfile, size_bytes, sha256 }
      )),
    };
    writeFileSync(join(DIST_DIR, 'manifest.json'), `${JSON.stringify(aggregate, null, 2)}\n`);
  }

  process.stdout.write('\nbuild-matrix summary\n');
  for (const target of targets) {
    const ok = built.find((m) => m.target === target);
    process.stdout.write(ok
      ? `  OK    ${target}  ${ok.size_bytes} bytes  sha256:${ok.sha256.slice(0, 16)}…\n`
      : `  FAIL  ${target}  (not built; omitted from manifest)\n`);
  }
  process.stdout.write(`manifests: ${built.length} per-target + ${built.length > 0 ? '1 aggregate' : '0 aggregate'} under dist/\n`);

  if (failed.length > 0) {
    process.stderr.write(`build-matrix: error: ${failed.length} target(s) failed: ${failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
