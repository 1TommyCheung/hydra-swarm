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

/** True inside a `bun build --compile` binary (observed in Test A). */
export function isCompiledBinary(): boolean {
  return import.meta.url.startsWith('file:///$bunfs/');
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
