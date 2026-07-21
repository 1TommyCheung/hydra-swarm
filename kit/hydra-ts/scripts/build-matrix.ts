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
//   bun-windows-arm64 bun-windows-x64
//
// Bun resolution matches the hydra_resolve_node() "pin/resolve/assert" spirit
// (kit/hydra/scripts/lib.sh): only controlled, explicit locations are probed
// ($HYDRA_BUN, then ~/.bun/bin/bun), the binary is executed once to assert and
// record its version, and there is deliberately NO fallback to a bare `bun`
// on PATH (the plan's build-time PATH-shadowing risk). Missing/unusable Bun is
// a loud error, never a silent fallback. HYDRA_BUN must be an ABSOLUTE path:
// a relative value would be existence-checked relative to the caller's cwd
// but executed via PATH resolution, so the checked binary would not
// necessarily be the one that runs (stage-4 review finding 2). Every
// candidate is therefore guaranteed absolute, so the exact path string that
// is existence-checked and version-asserted is the one execFileSync invokes
// for the build, with no PATH-dependent resolution in between.
//
// Cross-compiling a non-native target makes Bun download that target's
// runtime once (printed as `Downloading [...]`); that is expected, not an
// error. A target whose runtime cannot be downloaded (e.g. no network) fails
// that target only: it is omitted from the manifests (never faked), the
// summary marks it FAILED, and the script exits non-zero.
//
// Stale-artifact hygiene (stage-4 review finding 3): before each target's
// build, any prior-run binary (hydra-cli on Unix, hydra-cli.exe on Windows)
// and dist/<target>/manifest.json
// are removed, and the binary is built into a temporary path that is
// atomically renamed into place only on success (manifests are written the
// same way). A failed or interrupted build therefore never leaves a stale or
// partial artifact that looks like a fresh product of this run. The aggregate
// dist/manifest.json is written from THIS run's successes only; if every
// requested target fails, any prior-run aggregate is removed so a packaging
// step gets a loud ENOENT instead of silently shipping stale binaries.
//
// Usage:
//   node --experimental-strip-types scripts/build-matrix.ts [--targets=a,b,...]
//
// Output layout:
//   dist/<target>/hydra-cli[.exe] compiled executable
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
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HYDRA_TS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(HYDRA_TS_ROOT, 'dist');
const ENTRYPOINT = 'src/cli.ts';
const BUILD_FLAGS = ['--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'];

export const DEFAULT_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-windows-arm64',
  'bun-windows-x64',
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
 * its version. Never falls back to a bare `bun` on PATH. Every candidate is
 * an absolute path, so the string that is existence-checked and
 * version-asserted is exactly the string execFileSync invokes later — no
 * PATH-dependent resolution is possible in between.
 */
function resolveBun(): { path: string; version: string } {
  const candidates: string[] = [];
  const override = process.env.HYDRA_BUN;
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      die(
        `HYDRA_BUN must be an absolute path, got ${JSON.stringify(override)}. `
        + 'A relative value is existence-checked against the caller\'s cwd but '
        + 'executed via PATH resolution, so the binary that is checked is not '
        + 'necessarily the binary that runs (PATH-shadowing escape).',
      );
    }
    candidates.push(override);
  }
  // join(homedir(), ...) is absolute by construction — same invariant.
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

/**
 * Write `data` to `path` via a temp file + atomic rename (same directory, so
 * same filesystem): a reader never observes a partially written file, and an
 * interrupted run leaves either the old file or the new one, never a stub.
 */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function parseTargets(argv: string[]): string[] {
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

export function outfileNameForTarget(target: string): string {
  return target.startsWith('bun-windows-') ? 'hydra-cli.exe' : 'hydra-cli';
}

export function artifactPaths(
  target: string,
  distDir = DIST_DIR,
): { outDir: string; outfile: string; manifestPath: string } {
  const outDir = join(distDir, target);
  return {
    outDir,
    outfile: join(outDir, outfileNameForTarget(target)),
    manifestPath: join(outDir, 'manifest.json'),
  };
}

interface BuildTargetOptions {
  distDir?: string;
  hydraRoot?: string;
  executeBuild?: (bunPath: string, args: string[], cwd: string) => void;
}

function executeBunBuild(bunPath: string, args: string[], cwd: string): void {
  execFileSync(bunPath, args, { cwd, stdio: 'inherit' });
}

/** Remove every published or temporary artifact that could be mistaken for this run. */
function cleanTargetArtifacts(outDir: string): void {
  if (!existsSync(outDir)) return;
  for (const name of readdirSync(outDir)) {
    if (
      name === 'hydra-cli'
      || name === 'hydra-cli.exe'
      || name === 'manifest.json'
      || name.startsWith('hydra-cli.tmp-')
      || name.startsWith('hydra-cli.exe.tmp-')
      || name.startsWith('manifest.json.tmp-')
    ) {
      rmSync(join(outDir, name), { force: true });
    }
  }
}

export function buildTarget(
  target: string,
  bun: { path: string; version: string },
  sha: string,
  builtAt: string,
  options: BuildTargetOptions = {},
): ArtifactManifest | null {
  const distDir = options.distDir ?? DIST_DIR;
  const hydraRoot = options.hydraRoot ?? HYDRA_TS_ROOT;
  const executeBuild = options.executeBuild ?? executeBunBuild;
  const { outDir, outfile, manifestPath } = artifactPaths(target, distDir);
  // Keep .exe last even on the unpublished temporary path. Bun's Windows
  // compiler expects an executable extension and may otherwise append one,
  // which would make the subsequent atomic rename look for the wrong file.
  const tmpOutfile = target.startsWith('bun-windows-')
    ? join(outDir, `hydra-cli.tmp-${process.pid}.exe`)
    : `${outfile}.tmp-${process.pid}`;
  mkdirSync(outDir, { recursive: true });

  // Stale-artifact hygiene (stage-4 review finding 3): remove any prior-run
  // binary and manifest for THIS target before building, and build into a
  // temp path that is renamed into place only on success. A failed or
  // interrupted build never leaves a stale or partial artifact that looks
  // like a fresh product of this run — the target directory is left empty.
  cleanTargetArtifacts(outDir);

  process.stdout.write(`\n[build] ${target} -> ${relative(hydraRoot, outfile)}\n`);
  // execFileSync returns normally only on exit 0; a non-zero exit throws with
  // the child's status attached. stdio: inherit keeps bun's own progress and
  // error output (including the one-time runtime `Downloading [...]` line for
  // cross-compiles) visible in the build log.
  let status = 0;
  try {
    executeBuild(
      bun.path,
      ['build', ...BUILD_FLAGS, `--target=${target}`, '--outfile', tmpOutfile, ENTRYPOINT],
      hydraRoot,
    );
  } catch (error) {
    status = (error as { status?: number }).status ?? 1;
  }
  if (status !== 0) {
    rmSync(tmpOutfile, { force: true }); // drop any partial output
    process.stderr.write(
      `[build] ${target} FAILED (bun exited ${status}). Cross-compiling a non-native target\n`
      + `        downloads that target's Bun runtime once; without network access that\n`
      + `        download fails. This target is omitted from the manifest (never faked).\n`,
    );
    return null;
  }
  if (!existsSync(tmpOutfile) || statSync(tmpOutfile).size === 0) {
    rmSync(tmpOutfile, { force: true });
    process.stderr.write(`[build] ${target} FAILED (bun exited 0 but ${outfile} is missing/empty)\n`);
    return null;
  }
  renameSync(tmpOutfile, outfile); // atomic publish: the final path only ever appears complete

  const manifest: ArtifactManifest = {
    schema_version: 1,
    source_sha: sha,
    bun_version: bun.version,
    bun_path: bun.path,
    built_at: builtAt,
    entrypoint: ENTRYPOINT,
    build_flags: [...BUILD_FLAGS, `--target=${target}`],
    target,
    outfile: `${relative(hydraRoot, outfile)}`,
    size_bytes: statSync(outfile).size,
    sha256: sha256File(outfile),
  };
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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

  const aggregatePath = join(DIST_DIR, 'manifest.json');
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
    writeFileAtomic(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  } else if (existsSync(aggregatePath)) {
    // Zero successes (stage-4 review finding 3): a prior run's aggregate must
    // not stay behind looking current. Removal is loud for any packaging
    // step (ENOENT) where a stale file would be silently shippable.
    rmSync(aggregatePath);
    process.stderr.write(
      'build-matrix: warning: all targets failed; removed stale prior-run dist/manifest.json '
      + 'so it cannot be packaged as if it were a product of this run\n',
    );
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
