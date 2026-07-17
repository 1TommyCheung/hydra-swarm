import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from './lib.ts';

// ---------------------------------------------------------------------------
// Dispatch-time environment-domain derivation.
//
// Kimi (and other vendor) worker sandboxes are network-allowlisted. A worktree
// whose dev-environment needs a package registry or a git-hosted dependency
// gets 403'd unless the operator has hand-edited the baseline domains file.
// This module inspects the worktree's own manifests (package.json, lockfiles,
// .npmrc, Python project files) and derives the *well-known* hosts those
// manifests imply.
//
// SECURITY POSTURE: derivation only ever ADDS hosts from a small, fixed
// allowlist of known package-registry / source-hosting domains (npm, yarn,
// GitHub's git+tarball CDN, PyPI). It never reads arbitrary URLs out of file
// contents and adds them verbatim — every host that can be added is named in
// this file. `.npmrc` `registry=` values are the one exception (an operator
// already trusts their own npmrc to configure npm), and even those are
// parsed as hostnames only, never as full URLs with paths/credentials.
// ---------------------------------------------------------------------------

/** A derived domain paired with the manifest that triggered it, for logging. */
export interface DerivedDomain {
  domain: string;
  trigger: string;
}

const NPM_REGISTRY = 'registry.npmjs.org';
const YARN_REGISTRY = 'registry.yarnpkg.com';
const GITHUB_DOMAINS = ['github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'];
const PYPI_DOMAINS = ['pypi.org', 'files.pythonhosted.org'];

const MAX_WORKSPACE_DEPTH = 4;

function safeReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function safeReadJson(path: string): Record<string, unknown> | undefined {
  const raw = safeReadFile(path);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Depspec strings that indicate a git-hosted (rather than registry) dependency. */
function isGitDependencySpec(spec: string): boolean {
  if (spec.startsWith('git+') || spec.startsWith('github:')) return true;
  if (/^https:\/\/github\.com\//.test(spec)) return true;
  // shorthand: "owner/repo" or "owner/repo#ref" (not a semver range / npm tag).
  if (/^[\w.-]+\/[\w.-]+(#[\w./-]+)?$/.test(spec) && !spec.startsWith('.') && !spec.startsWith('/')) return true;
  return false;
}

function collectDepSpecs(pkg: Record<string, unknown>): string[] {
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const specs: string[] = [];
  for (const field of fields) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object') {
      for (const value of Object.values(deps as Record<string, unknown>)) {
        if (typeof value === 'string') specs.push(value);
      }
    }
  }
  return specs;
}

/** Resolve workspace package.json paths from root `workspaces` or pnpm-workspace.yaml globs (depth-limited, no full glob engine — just directory listing). */
function workspacePackageJsonPaths(root: string, rootPkg: Record<string, unknown> | undefined): string[] {
  const globs: string[] = [];

  const workspacesField = rootPkg?.workspaces;
  if (Array.isArray(workspacesField)) {
    for (const g of workspacesField) if (typeof g === 'string') globs.push(g);
  } else if (workspacesField && typeof workspacesField === 'object') {
    const packages = (workspacesField as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      for (const g of packages) if (typeof g === 'string') globs.push(g);
    }
  }

  const pnpmWorkspacePath = join(root, 'pnpm-workspace.yaml');
  const pnpmWorkspace = safeReadFile(pnpmWorkspacePath);
  if (pnpmWorkspace !== undefined) {
    let inPackages = false;
    for (const line of pnpmWorkspace.split('\n')) {
      if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/);
        if (m) { globs.push(m[1]); continue; }
        if (/^\S/.test(line)) inPackages = false;
      }
    }
  }

  const paths: string[] = [];
  for (const glob of globs) {
    // Only support the common trailing "/*" (one level of packages) form and
    // literal directories; depth-limited directory walk, no shell globbing.
    const starIdx = glob.indexOf('*');
    const base = starIdx === -1 ? glob : glob.slice(0, starIdx).replace(/\/$/, '');
    const baseAbs = join(root, base);
    if (!existsSync(baseAbs)) continue;
    if (starIdx === -1) {
      const pkgJson = join(baseAbs, 'package.json');
      if (existsSync(pkgJson)) paths.push(pkgJson);
      continue;
    }
    try {
      for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgJson = join(baseAbs, entry.name, 'package.json');
        if (existsSync(pkgJson)) paths.push(pkgJson);
      }
    } catch {
      // unreadable directory — skip.
    }
  }
  return paths.slice(0, 200); // sanity cap; depth-limited scan, not a full tree walk.
}

/** Parse `.npmrc` `registry=` / `@scope:registry=` lines into hostnames only. */
function npmrcRegistryHosts(worktreeRoot: string): string[] {
  const raw = safeReadFile(join(worktreeRoot, '.npmrc'));
  if (raw === undefined) return [];
  const hosts: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const m = trimmed.match(/^(?:@[\w.-]+:)?registry\s*=\s*(\S+)/);
    if (!m) continue;
    try {
      hosts.push(new URL(m[1]).hostname);
    } catch {
      // not a well-formed URL — skip rather than trust raw text.
    }
  }
  return hosts;
}

/**
 * Derive the network domains a worktree's dev environment likely needs, from
 * its own manifests (package.json / lockfiles / .npmrc / Python project
 * files). Never throws: unreadable or malformed inputs are skipped, not
 * fatal — this is a best-effort assist over the operator's baseline.
 */
export function deriveEnvironmentDomainsDetailed(worktreeRoot: string): DerivedDomain[] {
  const found = new Map<string, string>(); // domain -> trigger

  const add = (domain: string, trigger: string): void => {
    if (!found.has(domain)) found.set(domain, trigger);
  };

  try {
    const hasPackageJson = existsSync(join(worktreeRoot, 'package.json'));
    const hasPnpmLock = existsSync(join(worktreeRoot, 'pnpm-lock.yaml'));
    const hasYarnLock = existsSync(join(worktreeRoot, 'yarn.lock'));
    const hasNpmLock = existsSync(join(worktreeRoot, 'package-lock.json'));

    if (hasPackageJson || hasPnpmLock || hasYarnLock || hasNpmLock) {
      const trigger = hasPnpmLock ? 'pnpm-lock.yaml' : hasYarnLock ? 'yarn.lock' : hasNpmLock ? 'package-lock.json' : 'package.json';
      add(NPM_REGISTRY, trigger);
    }
    if (hasYarnLock) add(YARN_REGISTRY, 'yarn.lock');

    const rootPkg = safeReadJson(join(worktreeRoot, 'package.json'));
    const manifestPaths = [
      ...(rootPkg ? [join(worktreeRoot, 'package.json')] : []),
      ...workspacePackageJsonPaths(worktreeRoot, rootPkg),
    ].slice(0, 1 + MAX_WORKSPACE_DEPTH * 50);

    for (const manifestPath of manifestPaths) {
      const pkg = manifestPath === join(worktreeRoot, 'package.json') ? rootPkg : safeReadJson(manifestPath);
      if (!pkg) continue;
      const specs = collectDepSpecs(pkg);
      const name = (pkg.name as string | undefined) ?? manifestPath;
      for (const spec of specs) {
        if (isGitDependencySpec(spec)) {
          for (const d of GITHUB_DOMAINS) add(d, `git dep ${name} (${spec})`);
          break; // one trigger note per manifest is enough
        }
      }
    }
  } catch {
    // package.json / lockfile scan failed entirely — fall through to other sources.
  }

  try {
    for (const host of npmrcRegistryHosts(worktreeRoot)) {
      add(host, '.npmrc registry');
    }
  } catch {
    // .npmrc parse failed — skip.
  }

  try {
    const hasRequirements = existsSync(join(worktreeRoot, 'requirements.txt'));
    const hasPyproject = existsSync(join(worktreeRoot, 'pyproject.toml'));
    if (hasRequirements || hasPyproject) {
      const trigger = hasRequirements ? 'requirements.txt' : 'pyproject.toml';
      for (const d of PYPI_DOMAINS) add(d, trigger);
    }
  } catch {
    // python manifest probe failed — skip.
  }

  return [...found.entries()]
    .map(([domain, trigger]) => ({ domain, trigger }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Sorted, deduped domain list — the plain form most callers want. */
export function deriveEnvironmentDomains(worktreeRoot: string): string[] {
  return deriveEnvironmentDomainsDetailed(worktreeRoot).map((d) => d.domain);
}

/** Render a one-line summary of derived domains for dispatch logs. */
export function formatDerivedDomainsLog(derived: DerivedDomain[]): string | undefined {
  if (derived.length === 0) return undefined;
  const parts = derived.map((d) => `+${d.domain} (${d.trigger})`);
  return `env-domains: ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Baseline persistence: union derived domains into the operator's baseline
// file so repeat dispatches to the same/similar worktrees stop needing a
// re-derive or a manual edit.
// ---------------------------------------------------------------------------

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Union `derivedDomains` into the baseline JSON at `baselinePath`, preserving
 * any other fields the file already has. Writes atomically (tmp + rename).
 * A missing or malformed baseline file is treated as an empty one — the
 * derived domains still get written out, they are never dropped for that
 * reason. Never throws: on unrecoverable write failure this is a no-op (the
 * in-memory merged allowlist for this dispatch is unaffected either way).
 */
export function persistDerivedDomains(baselinePath: string, derivedDomains: string[]): void {
  if (derivedDomains.length === 0) return;
  try {
    let existing: Record<string, unknown> = {};
    const raw = safeReadFile(baselinePath);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
      } catch {
        // malformed baseline JSON — start from empty rather than crash; the
        // union below still produces a valid file with the derived domains.
        existing = {};
      }
    }
    const existingDomains = Array.isArray(existing.allowedDomains)
      ? (existing.allowedDomains as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    const merged = [...new Set([...existingDomains, ...derivedDomains])].sort();
    const next = { ...existing, allowedDomains: merged };
    writeAtomic(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`env-domains: failed to persist derived domains to ${baselinePath}: ${message}`);
  }
}

export default { deriveEnvironmentDomains, deriveEnvironmentDomainsDetailed, formatDerivedDomainsLog, persistDerivedDomains };
