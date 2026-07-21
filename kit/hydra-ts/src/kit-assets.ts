// kit-assets.ts — parsed by ALL lanes; must contain NO `with { type: ... }` imports.
//
// Stage 1 Phase 2 (Bun single-binary migration): asset-resolution primitives
// implementing docs/bun-migration-spike-assets.md §10. Two resolution modes:
//
//   - EMBED-set assets (trust-boundary schemas, seeded profiles) are read via
//     kitAssetText(): the embedded map injected by cli.ts at startup wins when
//     present (compiled binary), otherwise the checkout file is read (source
//     lane). Content frozen at build time is a feature for trust contracts.
//   - Operator-editable per-project files (WAVE, policies/*.yaml) are resolved
//     via kitAssetPath(): checkout-anchored, so an operator edits the file in
//     the repo and never recompiles.
//
// Deviation from the spike §10 code block, forced by binding constraints of
// the Stage-1 task (zero test regressions + existing test files read-only):
// when repoRoot() fails (cwd outside any git repository), the Node SOURCE lane
// falls back to the pre-Stage-1 source-file-relative layout. Three existing
// tests (allocate.test.ts, review-required.test.ts, promote.test.ts) run
// commands with cwd outside a repo and cannot be edited under this task's
// writable_paths. The compiled lane never takes the fallback: isCompiledBinary()
// re-throws repoRoot()'s clear error, preserving the spike §6 "fails loudly
// and correctly outside a repo" property. Inside a compiled binary the
// fallback would also be useless — selfDir is the virtual `/$bunfs/root`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './lib.ts';

let embedded: Record<string, string> | null = null;

/** Called once at startup by the compiled entry point (cli.ts) only. */
export function initEmbeddedAssets(map: Record<string, string>): void {
  embedded = map;
}

/**
 * True inside a `bun build --compile` binary (observed in Test A).
 *
 * Requires BOTH a Bun standalone virtual-root URL and a Bun-specific runtime
 * marker (`process.versions.bun`, a field only the Bun runtime sets; safe to
 * probe under Node, where it is simply absent). POSIX standalone modules use
 * `file:///$bunfs/...`; Bun 1.3.14 on Windows uses
 * `file:///B:/~BUN/root/...` (with the drive letter varying by build).
 *
 * The URL shape alone is not unique to compiled binaries: an ordinary Node
 * module physically checked out at a root-level `/$bunfs/...` path (legal,
 * e.g. in a root-run container) produces the same prefix, which made plain
 * Node suppress all 34 direct-invocation guards (Stage 4 review bug #3,
 * docs/bun-migration-stage4-fixes-runtime.md).
 *
 * On the real Windows Bun 1.3.14 runner the ~BUN virtual root does not reach
 * routed modules' import.meta.url (only cli.ts's), so every routed module's
 * direct-invocation main guard fired inside the compiled binary. Fallback:
 * the standalone virtual ENTRY path is still exposed through process.argv[1]
 * (`B:\~BUN\root\...`, either slash direction, drive letter varying by
 * build), and argv is process-global, so routed modules see it too. The
 * fallback keeps the Bun-marker gate and anchors the drive-rooted ~BUN/root
 * prefix, so ordinary Bun source runs (argv[1] = a real checkout path) and
 * near-miss paths (`~BUN` nested deeper, `~BUN-project`, `rootish`) stay
 * false.
 *
 * The parameters exist so tests can simulate exactly that collision without
 * root access; production callers keep the zero-arg form.
 */
export function isCompiledBinary(
  url: string = import.meta.url,
  versions: NodeJS.ProcessVersions = process.versions,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (typeof versions.bun !== 'string') return false;
  if (
    url.startsWith('file:///$bunfs/')
    || /^file:\/\/\/[A-Za-z]:\/~BUN\/root\//.test(url)
  ) return true;
  return typeof argv1 === 'string' && /^[A-Za-z]:[/\\]~BUN[/\\]root[/\\]/.test(argv1);
}

/**
 * Checkout-anchored kit path. Candidates cover the installed layout
 * (<repo>/hydra/..., packaging.md §2) and this dev checkout (<repo>/kit/hydra/...).
 * Returns the first existing candidate, else the installed-layout path so the
 * resulting ENOENT message points at where an operator should install/fix.
 *
 * When cwd is not inside any git repository, the compiled binary re-throws
 * repoRoot()'s error (loud failure by design); the Node source lane falls back
 * to the source-file-relative layout so dev commands work from any cwd.
 */
export function kitAssetPath(rel: string): string {
  let root: string;
  try {
    root = repoRoot();
  } catch (error) {
    if (isCompiledBinary()) throw error;
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hydra', rel);
  }
  for (const base of ['hydra', 'kit/hydra']) {
    const p = join(root, base, rel);
    if (existsSync(p)) return p;
  }
  return join(root, 'hydra', rel);
}

/** Content of an EMBED-set asset: embedded map first, then the checkout file. */
export function kitAssetText(rel: string): string {
  if (embedded && embedded[rel] !== undefined) return embedded[rel];
  return readFileSync(kitAssetPath(rel), 'utf8');
}
