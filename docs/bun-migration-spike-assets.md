# Bun compiled-binary kit-asset resolution spike — results

Spike item #3 from `docs/bun-migration-plan-codex.md` ("Needs a `bun build
--compile` spike to verify": "Do embedded YAML/JSON/text assets work with
synchronous `node:fs` reads, survive moving the executable away from the
repository…"), extended to the 8 `import.meta.url`-relative kit-asset call
sites the plan flags at `docs/bun-migration-plan-codex.md:90-96`. Follows the
Stage 0 self-re-exec spike (`docs/bun-migration-spike-results.md`), which
already proved `import.meta.url` becomes a synthetic `/$bunfs/...` path inside
a compiled binary.

Ran 2026-07-15. Environment:

- Bun `1.3.14` (`~/.bun/bin/bun`; not on the default PATH — all commands below
  ran with `export PATH="$HOME/.bun/bin:$PATH"` first)
- macOS 26.5.2, Darwin 25.5.0 arm64 (Apple Silicon)
- Node v22.14.0 and v24.16.0 (via nvm) used only for the source-lane
  compatibility check; `/usr/local/bin/node` is the known-shadowing v17.4.0
- Scratch dir `/tmp/hydra-asset-spike` (replica checkout layout, real kit
  assets copied verbatim from this worktree; NOT committed, safe to delete)

## 1. The 8 call sites (verified by reading the code)

All 8 use the identical pattern `dirname(fileURLToPath(import.meta.url))`
followed by `join(selfDir, '..', '..', 'hydra', ...)`:

| # | Call site | Function | Asset resolved (relative to checkout) |
|---|---|---|---|
| 1 | `kit/hydra-ts/src/allocate.ts:22-25` | `defaultProfilesDir()` | `kit/hydra/profiles/` (4 seeded vendor YAMLs; filenames at `allocate.ts:27-32`) |
| 2 | `kit/hydra-ts/src/create-worktree.ts:102-105` | `defaultWavePath()` | `kit/hydra/WAVE` |
| 3 | `kit/hydra-ts/src/graph-impact.ts:30-33` | `defaultFreshnessGatePath()` | `kit/hydra/scripts/freshness-gate.sh` — **executed by a child process**: `spawnSync('bash', [freshnessGatePath, runId, taskId])` at `graph-impact.ts:95` |
| 4 | `kit/hydra-ts/src/promote.ts:23-26` | `defaultSchemaPath()` | `kit/hydra/schemas/result.schema.json` |
| 5 | `kit/hydra-ts/src/promote.ts:28-31` | `defaultVerifyPolicyPath()` | `kit/hydra/policies/verification.yaml` (env override `HYDRA_VERIFY_POLICY` at `promote.ts:270`) |
| 6 | `kit/hydra-ts/src/record-review.ts:21-24` | `defaultSchemaPath()` | `kit/hydra/schemas/review.schema.json` |
| 7 | `kit/hydra-ts/src/integrate.ts:36-39` | `defaultVerifyPolicyPath()` | `kit/hydra/policies/verification.yaml` (env override `HYDRA_VERIFY_POLICY` at `integrate.ts:144`) |
| 8 | `kit/hydra-ts/src/review-required.ts:20-23` | `defaultPolicyPath()` | `kit/hydra/policies/review-policy.yaml` (option override `policyFile`, no env override) |

Relevant existing anchors and overrides:

- `lib.ts:33-41` `repoRoot()` = `git rev-parse --show-toplevel` from the
  process cwd; dies with a clear message outside a repo.
- `create-worktree.ts:278` already resolves a sibling policy checkout-relative:
  `join(roots.repoRoot, 'kit', 'hydra', 'policies', 'bootstrap.yaml')` — an
  in-codebase precedent for repo-root-anchored policy lookup.
- `create-worktree.ts:145` `HYDRA_WAVE` env override takes precedence over the
  WAVE file.
- `packaging.md:31`: "Never ships in the kit: the three per-project policy
  files (templates only)" = `verification.yaml`, `ownership.yaml`,
  `bootstrap.yaml`. `packaging.md:66-69`: install writes `hydra/WAVE` and the
  human-approved per-project `policies/verification.yaml` into the target repo.
- `freshness-gate.ts` exists — a TypeScript port exporting
  `freshnessGate(runId, taskId)` (`freshness-gate.ts:30`); Codex plan item 3
  (`docs/bun-migration-plan-codex.md:254-256`) already chose in-process calls
  over shelling out.

## 2. Test setup

Replica layout mirroring the real checkout, with real kit assets copied in:

```text
/tmp/hydra-asset-spike/
  kit/hydra/{WAVE, profiles/claude-fable-5.yaml, schemas/{result,review}.schema.json,
             policies/{verification,review-policy}.yaml, scripts/{freshness-gate.sh,probe-gate.sh}}
  kit/hydra-ts/src/{probe-current,probe-embed,probe-text,probe-inline,probe-checkout,probe-write}.ts
  bin/   <- compiled binaries land here
```

## 3. Test A — the current pattern, compiled: **all 8 sites break**

`probe-current.ts` replicates the exact
`dirname(fileURLToPath(import.meta.url))` + `join(selfDir,'..','..','hydra',...)`
pattern for all 8 call sites.

```text
$ bun --version
1.3.14
$ bun build --compile kit/hydra-ts/src/probe-current.ts --outfile bin/probe-current
  [23ms]  bundle  1 modules
 [110ms] compile  bin/probe-current
$ ./bin/probe-current            # (a) from original build location
import.meta.url = file:///$bunfs/root/probe-current
selfDir         = /$bunfs/root
process.execPath= /private/tmp/hydra-asset-spike/bin/probe-current
cwd             = /private/tmp/hydra-asset-spike
MISSING  allocate.ts:22-25      profiles/ -> /hydra/profiles/claude-fable-5.yaml
MISSING  create-worktree.ts:102-105 WAVE -> /hydra/WAVE
MISSING  graph-impact.ts:30-33  freshness-gate.sh -> /hydra/scripts/freshness-gate.sh
MISSING  promote.ts:23-26       result.schema.json -> /hydra/schemas/result.schema.json
MISSING  promote.ts:28-31       verification.yaml -> /hydra/policies/verification.yaml
MISSING  record-review.ts:21-24 review.schema.json -> /hydra/schemas/review.schema.json
MISSING  integrate.ts:36-39     verification.yaml -> /hydra/policies/verification.yaml
MISSING  review-required.ts:20-23 review-policy.yaml -> /hydra/policies/review-policy.yaml
$ cp bin/probe-current /tmp/elsewhere/ && cd /tmp/elsewhere && ./probe-current   # (b) moved
import.meta.url = file:///$bunfs/root/probe-current
selfDir         = /$bunfs/root
process.execPath= /private/tmp/elsewhere/probe-current
cwd             = /private/tmp/elsewhere
MISSING  allocate.ts:22-25      profiles/ -> /hydra/profiles/claude-fable-5.yaml
MISSING  create-worktree.ts:102-105 WAVE -> /hydra/WAVE
MISSING  graph-impact.ts:30-33  freshness-gate.sh -> /hydra/scripts/freshness-gate.sh
MISSING  promote.ts:23-26       result.schema.json -> /hydra/schemas/result.schema.json
MISSING  promote.ts:28-31       verification.yaml -> /hydra/policies/verification.yaml
MISSING  record-review.ts:21-24 review.schema.json -> /hydra/schemas/review.schema.json
MISSING  integrate.ts:36-39     verification.yaml -> /hydra/policies/verification.yaml
MISSING  review-required.ts:20-23 review-policy.yaml -> /hydra/policies/review-policy.yaml
```

**Conclusion.** Inside a compiled binary, `selfDir` = `/$bunfs/root`, and
walking `../../` out of it escapes the virtual filesystem entirely: every call
site resolves to `/hydra/...` at the real filesystem root. All 8 are MISSING
in both placements — even though the real files still exist at the original
relative location next to the build directory. The breakage is total and
location-independent. (Note: none of the 8 sites fail loudly today — e.g.
`readWaveLevel` silently returns 0, `isSeedRelevant` silently returns false —
so without this fix the compiled binary would degrade silently, not crash.)

## 4. Test B — Bun 1.3.14 embedded-asset mechanisms: **work, with limits**

### B1/B3: `with { type: 'file' }` import + `Bun.embeddedFiles` + `node:fs` sync read

```text
$ bun build --compile kit/hydra-ts/src/probe-embed.ts --outfile bin/probe-embed
   [5ms]  bundle  4 modules
 [142ms] compile  bin/probe-embed
$ ./bin/probe-embed
[1] file import path   = /$bunfs/root/WAVE-bqgydbtw.
    readFileSync       = "2\n"
[2] text import        = "/$bunfs/root/WAVE-bqgydbtw."
[3] schema file path   = /$bunfs/root/result.schema-42xtypcr.json
    schema bytes       = 1638
[4] Bun.embeddedFiles  = 3 entries
    embedded: name=WAVE-bqgydbtw. type= size=2
    embedded: name=probe-gate-zmbaj80z.sh type=application/x-sh size=38
    embedded: name=result.schema-42xtypcr.json type=application/json;charset=utf-8 size=1639
[5] child-process exec of an embedded .sh (graph-impact.ts:95 pattern):
    embedded gate path = /$bunfs/root/probe-gate-zmbaj80z.sh
    spawn status       = 127 signal = null error = none
    child stdout       = ""
    child stderr       = "bash: /$bunfs/root/probe-gate-zmbaj80z.sh: No such file or directory\n"
```

Findings:

- `import p from './file' with { type: 'file' }` embeds the file; the default
  export is a `/$bunfs/root/<name>-<contenthash>.<ext>` path that
  `readFileSync` (sync `node:fs`) reads correctly (`"2\n"`; schema content
  intact — 1638 JS chars vs 1639 bytes on disk because the schema contains the
  multibyte `§`, proving real content, not a stub).
- The embedded path contains a content-hash suffix — code must always use the
  imported binding, never a hardcoded `/$bunfs/` path.
- **Gotcha:** importing the SAME file with both `with { type: 'file' }` and
  `with { type: 'text' }` makes the `file` import win for both bindings —
  `[2]` above returned the path string, not the content. Pick one type per
  asset.

### B2: `with { type: 'text' }` alone (no competing import on the same path)

```text
$ bun build --compile kit/hydra-ts/src/probe-text.ts --outfile bin/probe-text
  [26ms]  bundle  3 modules
 [137ms] compile  bin/probe-text
$ ./bin/probe-text
text import WAVE     = "2\n"
text import profile  = 1110 chars; first line: # hydra/profiles/claude-fable-5.yaml — seed profile (vendor-adapters.md §5)
```

The text import inlines file content as a plain JS string at build time —
same end result as generated constants (Test C) with zero codegen.

### B4: embedded content survives moving the binary AND deleting the source tree

```text
$ cp bin/probe-embed bin/probe-text /tmp/elsewhere/
$ mv /tmp/hydra-asset-spike/kit /tmp/hydra-asset-spike/kit.HIDDEN
$ cd /tmp/elsewhere && ./probe-embed     # output identical to section B1, all reads still OK
$ ./probe-text
text import WAVE     = "2\n"
text import profile  = 1110 chars; first line: # hydra/profiles/claude-fable-5.yaml — seed profile (vendor-adapters.md §5)
$ mv /tmp/hydra-asset-spike/kit.HIDDEN /tmp/hydra-asset-spike/kit   # restored
```

Embedded assets truly travel inside the binary; the on-disk originals are
never consulted.

### B5: child processes cannot see embedded files; embedded files are read-only

- B1 `[5]`: `spawnSync('bash', [embeddedPath])` → exit 127,
  `No such file or directory`. `/$bunfs/` exists only inside the Bun process.
  **This empirically kills any "embed freshness-gate.sh and exec it" design**
  and makes Codex plan item 3 (call `freshness-gate.ts` in-process) forced,
  not optional.
- Write probe (`probe-write.ts`: `writeFileSync(wavePath, '999\n')` on the
  imported `$bunfs` path):

```text
$ bun build --compile kit/hydra-ts/src/probe-write.ts --outfile bin/probe-write
   [4ms]  bundle  2 modules
  [91ms] compile  bin/probe-write
$ ./bin/probe-write
WRITE FAILED as expected: ENOENT
```

Embedded assets are effectively read-only (matching the plan's "Never try to
write an embedded asset", `docs/bun-migration-plan-codex.md:279`).

## 5. Test C — build-time inlined string constants: **works**

`gen-assets.ts` reads real kit files and emits
`kit/hydra-ts/src/assets.gen.ts` with `export const KIT_WAVE = "2\n"` etc.;

```text
$ bun gen-assets.ts
generated kit/hydra-ts/src/assets.gen.ts: 3204 bytes
$ bun build --compile kit/hydra-ts/src/probe-inline.ts --outfile bin/probe-inline
   [3ms]  bundle  2 modules
 [108ms] compile  bin/probe-inline
$ ./bin/probe-inline                     # (a) original location
inlined WAVE          = "2\n"
inlined schema bytes  = 1638
schema JSON.parse ok  = true
inlined profile bytes = 1110
profile first line    = # hydra/profiles/claude-fable-5.yaml — seed profile (vendor-adapters.md §5)
$ cp bin/probe-inline /tmp/elsewhere/ && mv /tmp/hydra-asset-spike/kit{,.HIDDEN}
$ cd /tmp/elsewhere && ./probe-inline    # (b) moved + source hidden — identical output
inlined WAVE          = "2\n"
inlined schema bytes  = 1638
schema JSON.parse ok  = true
inlined profile bytes = 1110
profile first line    = # hydra/profiles/claude-fable-5.yaml — seed profile (vendor-adapters.md §5)
```

Works, but redundant: B2's `with { type: 'text' }` achieves the same with no
codegen step and no generated file to drift. Tradeoff of either inlining
approach: content is frozen at build time — an operator cannot edit the asset
without recompiling. That is exactly why inlining is right for trust contracts
and wrong for per-project config (verdicts below).

## 6. Test D — checkout-relative resolution via `repoRoot()`: **works**

`probe-checkout.ts` anchors on `git rev-parse --show-toplevel` (the exact
`lib.ts:33-41` mechanism), then looks up `hydra/policies/verification.yaml`
(installed-repo layout per `packaging.md:66`) and `kit/hydra/...` (this dev
checkout's layout). Binary lives in `/tmp/elsewhere`, far from any checkout.

```text
$ bun build --compile kit/hydra-ts/src/probe-checkout.ts --outfile bin/probe-checkout
   [9ms]  bundle  1 modules
 [118ms] compile  bin/probe-checkout
$ cp bin/probe-checkout /tmp/elsewhere/
$ cd $WORKTREE && /tmp/elsewhere/probe-checkout     # (a) cwd inside this dev checkout
cwd                = /Users/tommycheung/worktrees/hydra-swarm/run-0035-bun-spike-assets
repoRoot           = /Users/tommycheung/worktrees/hydra-swarm/run-0035-bun-spike-assets
process.execPath   = /private/tmp/elsewhere/probe-checkout
absent  /Users/tommycheung/worktrees/hydra-swarm/run-0035-bun-spike-assets/hydra/policies/verification.yaml
FOUND   /Users/tommycheung/worktrees/hydra-swarm/run-0035-bun-spike-assets/kit/hydra/policies/verification.yaml
        first line: # hydra/policies/verification.yaml (tracked)
$ cd /tmp/target-repo && git init -q . && cp .../verification.yaml hydra/policies/ && /tmp/elsewhere/probe-checkout
cwd                = /private/tmp/target-repo        # (b) simulated INSTALLED target repo
repoRoot           = /private/tmp/target-repo
process.execPath   = /private/tmp/elsewhere/probe-checkout
FOUND   /private/tmp/target-repo/hydra/policies/verification.yaml
        first line: # hydra/policies/verification.yaml (tracked)
absent  /private/tmp/target-repo/kit/hydra/policies/verification.yaml
$ cd /tmp/elsewhere && ./probe-checkout; echo "exit code: $?"   # (c) outside any repo
FATAL: not inside a git repository (cwd: /private/tmp/elsewhere)
exit code: 1
```

**Conclusion.** A compiled binary anywhere on disk reliably finds
checkout-anchored files when run with cwd inside the checkout — which is
already how hydra commands operate (state root, ledger, run dir all derive
from `repoRoot()` today). It fails loudly and correctly outside a repo. This
is the right mechanism for operator-editable, per-project files; it is NOT a
fallback for kit-internal defaults, because criterion "runs from outside the
checkout" (`docs/bun-migration-plan-codex.md:570`) must hold for those.

## 7. Node source-lane compatibility check (decisive for the design)

The migration keeps the Node `--experimental-strip-types` source lane as a
rollback, so any embed mechanism must not break Node parsing. It does:

```text
$ ~/.nvm/versions/node/v22.14.0/bin/node --experimental-strip-types ./node-text-import.ts
TypeError [ERR_IMPORT_ATTRIBUTE_UNSUPPORTED]: Import attribute "type" with value "text" is not supported
exit: 1
$ ~/.nvm/versions/node/v24.16.0/bin/node --experimental-strip-types ./node-text-import.ts
TypeError [ERR_IMPORT_ATTRIBUTE_UNSUPPORTED]: Import attribute "type" with value "text" is not supported in file:///private/tmp/WAVE
exit: 1
```

Both supported Node versions reject `with { type: 'text' }` (and likewise
`'file'`). **Any module containing a Bun asset import attribute must be
reachable only from the compiled entry point** (`cli.ts`), never from the
per-command modules the source lane executes. Compiled-lane detection is
trivial and was observed directly in Test A:
`import.meta.url.startsWith('file:///$bunfs/')`.

## 8. Mechanism summary

| Mechanism | Compiled, moved, source deleted | Child-process visible | Operator-editable without rebuild | Node source-lane safe |
|---|---|---|---|---|
| A. Current `import.meta.url` walk | ❌ resolves to `/hydra/...`, all MISSING | — | — | ✅ (but broken when compiled) |
| B1. `with { type: 'file' }` | ✅ sync `readFileSync` via `/$bunfs/` path | ❌ (exit 127) | ❌ (write → ENOENT) | ❌ attribute unsupported |
| B2. `with { type: 'text' }` | ✅ string constant | n/a (no path) | ❌ frozen at build | ❌ attribute unsupported |
| C. Generated string constants | ✅ | n/a | ❌ frozen at build | ✅ (plain TS) but needs codegen step |
| D. Checkout-relative via `repoRoot()` | ✅ when cwd in checkout (both layouts found) | ✅ real path on disk | ✅ edit the file, no rebuild | ✅ already the `lib.ts` pattern |

Binary size note: every probe binary was 63,446,114 bytes (~60.5 MiB)
regardless of embedded content — embedded text assets are negligible against
the bundled runtime, consistent with the prior spike's 61MB observation.

## 9. Verdict per call site

Axis (per task): **embed at compile time** vs **require checkout-relative
resolution**, decided by whether an installed operator would ever edit that
asset without recompiling.

| # | Call site / asset | Verdict | Reasoning |
|---|---|---|---|
| 1 | `allocate.ts:22-25` — 4 seeded profile YAMLs | **EMBED** | Kit-owned seeded priors (`packaging.md:30` "Ships in the kit: … seeded vendor profiles"); drift is handled by kit upgrades (`packaging.md:133`), not operator edits. Measured data already lives in `HYDRA_STATE_ROOT`, unaffected. Test override `profilesDir` preserved. |
| 2 | `create-worktree.ts:102-105` — `WAVE` | **CHECKOUT-RELATIVE** | WAVE is per-install state written by the installer (`packaging.md:66` "write `hydra/WAVE = 2`") and bumped by kit upgrades — it describes the *installed kit in the repo*, not the running binary. An embedded WAVE would misreport the wave of a repo installed at an older kit. `HYDRA_WAVE` override preserved. **Refines Codex plan line 244, which listed WAVE under "embed".** Bonus: checkout-relative needs no new anchor — `resolveRoots` already computes `repoRoot`. |
| 3 | `graph-impact.ts:30-33` — `freshness-gate.sh` | **CHECKOUT-RELATIVE in principle; implement as IN-PROCESS TS CALL** | Embed is empirically impossible: child `bash` cannot open `/$bunfs/` paths (B5, exit 127). Checkout-relative works but keeps a bash subprocess whose only job is what `freshness-gate.ts:30` already does in-process. Stage 1 should make graph-impact call `freshnessGate(runId, taskId)` directly (Codex plan item 3); keep the `.sh` solely for the frozen `HYDRA_HARNESS=bash` lane. |
| 4 | `promote.ts:23-26` — `result.schema.json` | **EMBED** | Trust-boundary validation contract; an operator must NOT be able to weaken result validation by editing a file. Freezing it into the signed binary is a security improvement, not a limitation. Test override `schemaPath` preserved. |
| 5 | `promote.ts:28-31` — `verification.yaml` | **CHECKOUT-RELATIVE** | Per-project active config: `packaging.md:31` "Never ships in the kit: the three per-project policy files"; `packaging.md:69` it is the repo's own definition of "passed", human-approved. This repo's own copy says "Swap for `pnpm typecheck`…" — operators edit it routinely. `HYDRA_VERIFY_POLICY` override preserved. |
| 6 | `record-review.ts:21-24` — `review.schema.json` | **EMBED** | Same trust-contract reasoning as #4. Test override `schemaPath` preserved. |
| 7 | `integrate.ts:36-39` — `verification.yaml` | **CHECKOUT-RELATIVE** | Same asset, same reasoning as #5. `HYDRA_VERIFY_POLICY` / `HYDRA_SMOKE_POLICY` overrides preserved. |
| 8 | `review-required.ts:20-23` — `review-policy.yaml` | **CHECKOUT-RELATIVE** | Not one of packaging.md's three per-project files (ships tracked in the kit), but it is operator-meaningful policy — risk thresholds, trigger labels, and vendor pairing are project judgment calls, commented like config, unlike the schema contracts. Precedent: its sibling `bootstrap.yaml` (same `policies/` directory) is already resolved checkout-relative at `create-worktree.ts:278`. Embedding would freeze per-project tuning behind a rebuild for zero trust-boundary gain (a weaker policy only weakens review coverage for the repo's own maintainers). Keep the existing `policyFile` option override. **Refines Codex plan line 246.** |

Net: 4 embed (1, 4, 6 + the four profile files as a set), 4 checkout-relative
(2, 5, 7, 8), 1 in-process call (3).

## 10. Recommended Stage 1 mechanism (concrete design)

Two primitives in one new module `kit/hydra-ts/src/kit-assets.ts` (plain TS,
no import attributes — safe in every lane):

```ts
// kit-assets.ts — parsed by ALL lanes; must contain NO `with { type: ... }` imports.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 */
export function kitAssetPath(rel: string): string {
  const root = repoRoot();
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
```

The compiled entry point — and ONLY it — carries the Bun asset imports, so
the Node source lane (Test 7) never parses them:

```ts
// cli.ts (compiled entry; never executed by the Node source lane)
import resultSchema from '../../hydra/schemas/result.schema.json' with { type: 'text' };
import reviewSchema from '../../hydra/schemas/review.schema.json' with { type: 'text' };
import profileClaude from '../../hydra/profiles/claude-fable-5.yaml' with { type: 'text' };
import profileCodex from '../../hydra/profiles/codex-gpt-5.6-sol.yaml' with { type: 'text' };
import profileOpencode from '../../hydra/profiles/opencode-glm-5.2.yaml' with { type: 'text' };
import profileKimi from '../../hydra/profiles/kimi-k2.7-code.yaml' with { type: 'text' };
import { initEmbeddedAssets } from './kit-assets.ts';

initEmbeddedAssets({
  'schemas/result.schema.json': resultSchema,
  'schemas/review.schema.json': reviewSchema,
  'profiles/claude-fable-5.yaml': profileClaude,
  'profiles/codex-gpt-5.6-sol.yaml': profileCodex,
  'profiles/opencode-glm-5.2.yaml': profileOpencode,
  'profiles/kimi-k2.7-code.yaml': profileKimi,
});
```

Per-call-site edits (minimal, mechanical):

- **#1 allocate.ts**: replace `defaultProfilesDir()`/seed-path reads with
  `kitAssetText('profiles/' + SEED_FILES[vendor])`; keep `profilesDir`
  override consulted first (tests).
- **#4 promote.ts / #6 record-review.ts**: read the schema via
  `kitAssetText('schemas/result.schema.json' | 'schemas/review.schema.json')`;
  keep `schemaPath` override first.
- **#2 create-worktree.ts**: `defaultWavePath()` →
  `kitAssetPath('WAVE')`; `HYDRA_WAVE` precedence unchanged.
- **#5 promote.ts / #7 integrate.ts**: `defaultVerifyPolicyPath()` →
  `kitAssetPath('policies/verification.yaml')`; `HYDRA_VERIFY_POLICY`
  precedence unchanged.
- **#8 review-required.ts**: `defaultPolicyPath()` →
  `kitAssetPath('policies/review-policy.yaml')`; `policyFile` option
  precedence unchanged.
- **#3 graph-impact.ts**: replace `spawnSync('bash', [freshnessGatePath, ...])`
  (`graph-impact.ts:95`) with an in-process `freshnessGate(runId, taskId)`
  call from `freshness-gate.ts:30`; keep `freshnessGatePath` dep only as long
  as the bash lane needs it, and keep `freshness-gate.sh` for
  `HYDRA_HARNESS=bash`.

Design rules this spike established (all empirical):

1. Never import the same asset with two different `with { type: ... }`
   attributes — the `file` type silently wins for both (B1 `[2]`).
2. Never hardcode `/$bunfs/` paths (content-hash suffixes, B1) and never pass
   one to a child process (B5) or write one (B5, ENOENT).
3. `with { type: 'text' }` modules must stay behind the compiled entry point;
   Node 22 and 24 both refuse the attribute (Test 7). No codegen step is
   needed — text imports make Test C's generated constants redundant.
4. Keep every existing override (`HYDRA_VERIFY_POLICY`, `HYDRA_WAVE`,
   `profilesDir`, `schemaPath`, `policyFile`) ahead of the new defaults, per
   `docs/bun-migration-plan-codex.md:250-253`.
5. Per the plan's CI gates, add a black-box test per embedded default that
   runs the binary from an unrelated cwd with the checkout tree absent
   (`docs/bun-migration-plan-codex.md:457-458`) — exactly the procedure of
   Test B4/C(b) above, which is copy-pasteable into that lane.

## 11. What this retires vs. what's still open

**Retired:** the asset half of spike item #3 — sync `node:fs` reads of
embedded YAML/JSON/text work and survive relocating the binary and deleting
the source tree. The 8 call sites' failure mode is confirmed total (not
partial or path-dependent). A concrete, lane-safe mechanism exists for every
site, and the two plan items this spike refines (embed WAVE, embed
review-policy.yaml) are now evidence-based rather than guessed.

**Still open:** macOS signing/notarization survival of embedded assets (the
second half of plan item #3 — untestable here without a signing identity);
whether `--minify`/`--bytecode` builds change text-import behavior (probes
used the plan's plain build); the `promote.sh`/`record-review.sh` frozen-bash
bare-Node validator calls (out of scope, plan item 12 already records them);
and Windows/Linux behavior of `/$bunfs/` (deferred with those targets per the
plan).
