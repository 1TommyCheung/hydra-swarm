import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { die, log, yamlList, yamlScalar } from './lib.ts';

// ---------------------------------------------------------------------------
// Worker dev-environment preflight.
//
// Field evidence (run ws9-import-plan, 2026-07-17): every worker-environment
// restriction so far has been discovered MID-TASK — registry/git-host 403s,
// a vendor CLI missing from the pane PATH, pnpm's in-worktree store tripping
// srt's mandatory .git/config+hooks deny, the global pnpm store DB
// unopenable under confinement, node_modules symlink workarounds then
// tripping promote.sh's ownership audit. Each one wasted worker cycles and
// needed lead intervention to hand-fix. The principle this module encodes:
// a write-role worker must be able to reach everything in its repo AND the
// dev toolchain the repo declares (package-manager caches, registries,
// git-dep hosts) — configured BEFORE dispatch, not discovered by failure.
//
// COMPOSITION: this module is designed to land ahead of two sibling PRs and
// pick up their work automatically once merged, without duplicating it:
//   - deriveEnvironmentDomains (env-domains.ts, "dispatch-env-domains"):
//     feature-detected via dynamic import. When present, it is authoritative
//     for manifest-derived domains; this module's `inlineDeriveDomains` is
//     used only when the import fails (e.g. this branch predates the merge).
//   - the per-task `npm_config_store_dir` fix
//     ("worker-git-metadata-confinement"): that PR inlines its store-dir
//     computation directly in adapter-kimi.ts rather than exporting a
//     function, so there is nothing to import. This module computes the
//     same TMPDIR-rooted, agentRunId-namespaced directory independently
//     (`hydra-pnpm-store-<agentRunId>`) so the two are compatible (same
//     path, idempotent mkdir) if both run for the same dispatch. Once that
//     PR merges, adapter-kimi.ts's own inline computation should be deleted
//     in favor of calling `prepareWorkerEnv()` here instead.
// ---------------------------------------------------------------------------

/** A `deriveEnvironmentDomains`-shaped export, matched structurally so we never import PR #3's types directly. */
type DeriveDomainsFn = (worktreeRoot: string) => string[];

const NPM_REGISTRY = 'registry.npmjs.org';
const YARN_REGISTRY = 'registry.yarnpkg.com';
const BUN_REGISTRY = 'bun.sh';
const GITHUB_DOMAINS = ['github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'];

const COMMON_INSTALL_ROOTS = ['.opencode/bin', '.kimi-code/bin', '.npm-global/bin', '.bun/bin'];

/** Package managers whose literal binary corepack can shim at invoke time. Bun is NOT one: corepack only shims npm/yarn/pnpm, so a missing bun must fail the preflight, not pass as 'corepack-shim' and die mid-task at the first `bun install`. */
const COREPACK_SHIMMABLE = new Set(['pnpm', 'yarn', 'npm']);

export interface PrepareWorkerEnvOptions {
  /** Namespaces per-task cache/store directories; typically the dispatch agent_run_id. */
  agentRunId: string;
  /** The assigned vendor's CLI binary name (e.g. 'kimi', 'codex', 'opencode'), verified alongside git/node/package-manager. Omit for vendors with no separate CLI binary (e.g. claude, running in-process). */
  vendorBin?: string;
  /** Override PATH used for resolution (tests); defaults to process.env.PATH. */
  pathEnv?: string;
  /** Override HOME used for common-install-root discovery (tests); defaults to process.env.HOME. */
  homeEnv?: string;
  /** Override TMPDIR used for store/cache dirs (tests); defaults to process.env.TMPDIR ?? '/tmp'. */
  tmpDir?: string;
  /** Injected existence check (tests) — real filesystem probe by default. */
  exists?: (path: string) => boolean;
  /** Injected file reader (tests) — real filesystem read by default. */
  readFile?: (path: string) => string;
  /** Injected `deriveEnvironmentDomains` for tests, bypassing the dynamic-import feature-detect entirely. */
  deriveEnvironmentDomains?: DeriveDomainsFn;
}

export interface PreparedWorkerEnv {
  /** Baseline ∪ manifest-derived ∪ task-spec network_domains, deduped and sorted. */
  allowedDomains: string[];
  /** Env vars to pass into the worker's spawn (store/cache dirs, all under TMPDIR). */
  envOverrides: Record<string, string>;
  /** tool name -> resolved path (or 'corepack-shim' when satisfied only via corepack). */
  toolsVerified: Record<string, string>;
  /** Which domain source supplied the manifest-derived set. */
  domainSource: 'env-domains.ts' | 'inline-fallback';
  /** One-line summary for dispatch logs. */
  logLine: string;
}

function safeReadFile(readFile: (p: string) => string, path: string): string | undefined {
  try {
    return readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * Minimal inline stand-in for env-domains.ts's deriveEnvironmentDomains,
 * used only when that module cannot be imported (this branch predates its
 * merge). Intentionally conservative: npm/yarn/pnpm/bun lockfiles ->
 * registry hosts; git-hosted deps in the root package.json -> GitHub hosts.
 * Never throws — unreadable/malformed input is skipped, not fatal.
 */
export function inlineDeriveDomains(
  worktreeRoot: string,
  exists: (path: string) => boolean = existsSync,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string[] {
  const domains = new Set<string>();
  const has = (f: string): boolean => {
    try {
      return exists(join(worktreeRoot, f));
    } catch {
      return false;
    }
  };

  const hasPnpmLock = has('pnpm-lock.yaml');
  const hasYarnLock = has('yarn.lock');
  const hasNpmLock = has('package-lock.json');
  const hasPackageJson = has('package.json');
  const hasBunLock = has('bun.lock') || has('bun.lockb');
  const hasBunfig = has('bunfig.toml');

  if (hasPackageJson || hasPnpmLock || hasYarnLock || hasNpmLock) {
    domains.add(NPM_REGISTRY);
  }
  if (hasYarnLock) domains.add(YARN_REGISTRY);
  if (hasBunLock || hasBunfig) domains.add(BUN_REGISTRY);

  const pkgRaw = safeReadFile(readFile, join(worktreeRoot, 'package.json'));
  if (pkgRaw !== undefined) {
    try {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
      let hasGitDep = false;
      for (const field of fields) {
        const deps = pkg[field];
        if (!deps || typeof deps !== 'object') continue;
        for (const spec of Object.values(deps as Record<string, unknown>)) {
          if (typeof spec !== 'string') continue;
          if (spec.startsWith('git+') || spec.startsWith('github:') || /^https:\/\/github\.com\//.test(spec)) {
            hasGitDep = true;
            break;
          }
        }
        if (hasGitDep) break;
      }
      if (hasGitDep) for (const d of GITHUB_DOMAINS) domains.add(d);
    } catch {
      // malformed package.json — skip git-dep detection, registry hosts above still stand.
    }
  }

  return [...domains].sort();
}

/** Feature-detect env-domains.ts (PR "dispatch-env-domains"); fall back to the inline deriver when it isn't present on this branch yet. */
async function deriveDomains(
  worktreeRoot: string,
  options: PrepareWorkerEnvOptions,
): Promise<{ domains: string[]; source: PreparedWorkerEnv['domainSource'] }> {
  if (options.deriveEnvironmentDomains) {
    return { domains: options.deriveEnvironmentDomains(worktreeRoot), source: 'env-domains.ts' };
  }
  try {
    const mod = await import('./env-domains.ts') as { deriveEnvironmentDomains?: DeriveDomainsFn };
    if (typeof mod.deriveEnvironmentDomains === 'function') {
      return { domains: mod.deriveEnvironmentDomains(worktreeRoot), source: 'env-domains.ts' };
    }
  } catch {
    // module not present on this branch yet — degrade gracefully, do not fail dispatch over it.
  }
  return {
    domains: inlineDeriveDomains(worktreeRoot, options.exists, options.readFile),
    source: 'inline-fallback',
  };
}

/** Read a repo's declared package manager from `package.json`'s corepack-style `packageManager` field ("pnpm@8.15.0" -> "pnpm"). Defaults to 'npm' when unspecified or unreadable — Node ships npm, so it is always a safe minimum to verify. */
function declaredPackageManager(
  worktreeRoot: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string,
): string {
  if (!exists(join(worktreeRoot, 'package.json'))) return 'npm';
  const raw = safeReadFile(readFile, join(worktreeRoot, 'package.json'));
  if (raw === undefined) return 'npm';
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const pm = pkg.packageManager;
    if (typeof pm === 'string' && pm.length > 0) {
      const name = pm.split('@')[0];
      if (name) return name;
    }
  } catch {
    // malformed package.json — fall through to the npm default.
  }
  return 'npm';
}

function resolveOnPath(name: string, pathEnv: string, exists: (path: string) => boolean): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // unreadable PATH entry — skip.
    }
  }
  return undefined;
}

function findInCommonRoots(name: string, home: string, exists: (path: string) => boolean): string | undefined {
  for (const root of COMMON_INSTALL_ROOTS) {
    const candidate = join(home, root, name);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // unreadable candidate — skip.
    }
  }
  return undefined;
}

/**
 * Resolve every required toolchain binary via the SAME PATH the pane shell
 * will get, and die fast (at dispatch, not mid-task) with the exact remedy
 * when one is missing — mirroring hydra-doctor's tone: name the install/
 * link command, don't just say "not found".
 */
function verifyToolchain(
  worktreeRoot: string,
  vendorBin: string | undefined,
  options: PrepareWorkerEnvOptions,
): Record<string, string> {
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const home = options.homeEnv ?? process.env.HOME ?? '';

  const packageManager = declaredPackageManager(worktreeRoot, exists, readFile);
  const required = ['git', 'node', packageManager, ...(vendorBin ? [vendorBin] : [])];

  const verified: Record<string, string> = {};
  for (const tool of required) {
    // Own-property check, not truthiness: on a plain object a tool named like
    // an Object.prototype key ('constructor', 'toString', ...) would read as
    // already-verified and skip the probe entirely.
    if (Object.hasOwn(verified, tool)) continue; // dedupe (e.g. vendorBin === packageManager never happens, but git/node could repeat if misconfigured)

    const resolved = resolveOnPath(tool, pathEnv, exists);
    if (resolved) {
      verified[tool] = resolved;
      continue;
    }

    // corepack shim: a repo's packageManager field is satisfied at invoke
    // time by `corepack <tool>` even when the literal binary is absent, as
    // long as corepack itself is on PATH.
    if (COREPACK_SHIMMABLE.has(tool) && resolveOnPath('corepack', pathEnv, exists)) {
      verified[tool] = 'corepack-shim';
      continue;
    }

    const foundElsewhere = findInCommonRoots(tool, home, exists);
    if (foundElsewhere) {
      die(
        `worker-devenv: required tool '${tool}' not on PATH but found at ${foundElsewhere} — `
        + `remedy: ln -sf ${foundElsewhere} ~/.local/bin/${tool}`,
      );
    }
    die(
      `worker-devenv: required tool '${tool}' not found on PATH (checked PATH and `
      + `${COMMON_INSTALL_ROOTS.map((r) => `~/${r}`).join(', ')}) — install it before dispatch; `
      + `this is a preflight failure, not a mid-task one`,
    );
  }
  return verified;
}

/** Per-task package-manager store/cache directories, all rooted under TMPDIR so they never land inside the worktree or any `.git`-adjacent path. */
function storeEnvOverrides(agentRunId: string, tmpDir: string): { envOverrides: Record<string, string>; primaryStoreDir: string } {
  const pnpmStoreDir = join(tmpDir, `hydra-pnpm-store-${agentRunId}`);
  const npmCacheDir = join(tmpDir, `hydra-npm-cache-${agentRunId}`);
  const bunCacheDir = join(tmpDir, `hydra-bun-cache-${agentRunId}`);
  const yarnCacheDir = join(tmpDir, `hydra-yarn-cache-${agentRunId}`);

  for (const dir of [pnpmStoreDir, npmCacheDir, bunCacheDir, yarnCacheDir]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    envOverrides: {
      // Same env var + naming pattern as the "worker-git-metadata-confinement"
      // fix (PR #6): pnpm reads npm_config_store_dir, keeping its store (and
      // every ephemeral git clone underneath it) outside the worktree and
      // outside any `.git`-adjacent path, so it never trips srt's mandatory
      // .git/config+hooks deny nor the promote.sh ownership audit.
      npm_config_store_dir: pnpmStoreDir,
      npm_config_cache: npmCacheDir,
      BUN_INSTALL_CACHE_DIR: bunCacheDir,
      YARN_CACHE_FOLDER: yarnCacheDir,
    },
    primaryStoreDir: pnpmStoreDir,
  };
}

/**
 * Prepare a write-role worker's development environment BEFORE spawn:
 * network domains, package-manager store/cache directories, and a
 * fail-fast toolchain check. Call this from an adapter's `start` (or from
 * dispatch.ts generically) right before invoking srt/the vendor CLI.
 *
 * NOTE on reads vs writes under srt (verified against makeSrtSettings in
 * adapter-kimi.ts): srt's SrtSettings only has `filesystem.allowWrite` /
 * `denyWrite` / `denyRead` — there is no `allowRead` allowlist, so reads are
 * permitted everywhere by default and only writes are confined to
 * `allowWrite` roots. That means the corepack cache
 * (`~/.cache/node/corepack`) does NOT need to be added to allowWrite for a
 * worker to read cached shims from it; it only would if corepack needed to
 * populate/update that cache mid-task, which is out of scope here.
 */
export async function prepareWorkerEnv(
  worktreeRoot: string,
  taskSpec: string,
  options: PrepareWorkerEnvOptions,
): Promise<PreparedWorkerEnv> {
  if (!worktreeRoot || !taskSpec || !options.agentRunId) {
    die('usage: prepareWorkerEnv(worktreeRoot, taskSpec, { agentRunId, ... })');
  }

  // TMPDIR routinely contains a symlink component (/var -> /private/var on
  // macOS) and srt allowWrite matching works on PHYSICAL paths — store/cache
  // dirs built from the raw value would sit outside every effective write
  // root and the sandboxed install would EPERM anyway (the exact bug fixed in
  // PR #6's adapter-kimi inline computation). Canonicalize the default here;
  // an explicitly injected options.tmpDir (tests) is taken as-is.
  let tmpDir = options.tmpDir;
  if (!tmpDir) {
    const tmpRaw = process.env.TMPDIR ?? '/tmp';
    mkdirSync(tmpRaw, { recursive: true });
    tmpDir = realpathSync(tmpRaw);
  }

  // 1. Toolchain preflight — fail fast, before anything else runs.
  const toolsVerified = verifyToolchain(worktreeRoot, options.vendorBin, options);

  // 2. Network domains: baseline is the caller's concern (operator-curated
  // file, vendor-specific); this module only adds manifest-derived + task
  // network_domains on top.
  const { domains: derivedDomains, source: domainSource } = await deriveDomains(worktreeRoot, options);
  const taskDomains = yamlList(taskSpec, 'network_domains');
  const allowedDomains = [...new Set([...derivedDomains, ...taskDomains])].sort();

  // 3. Writable store/cache paths, all under TMPDIR.
  const { envOverrides, primaryStoreDir } = storeEnvOverrides(options.agentRunId, tmpDir);

  const taskId = yamlScalar(taskSpec, 'task_id') || '(unknown task)';
  const logLine = `worker-devenv: task=${taskId} domains=+${allowedDomains.length} (${domainSource}) `
    + `store=${primaryStoreDir} tools=${Object.keys(toolsVerified).join(',')}`;
  log(logLine);

  return { allowedDomains, envOverrides, toolsVerified, domainSource, logLine };
}

export default { prepareWorkerEnv, inlineDeriveDomains };
