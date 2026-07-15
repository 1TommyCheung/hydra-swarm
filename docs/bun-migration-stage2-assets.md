# Bun migration — Stage 1 Phase 2: kit-asset resolution (asset-embedding)

Implements the asset-resolution design from `docs/bun-migration-spike-assets.md`
§9–§10 (run 0038, task `asset-embedding`, spec v1). The spike proved that all 8
`import.meta.url`-relative kit-asset call sites silently resolve to
`/hydra/...` at the filesystem root inside a `bun build --compile` binary
(selfDir becomes `/$bunfs/root`), and decided per site: **4 embed**, **4
checkout-relative**, **1 in-process call**. This document records what was
implemented per call site, the override-precedence evidence, the deliberate
deviations from the spike's literal §10 code block (with reasons), and what
remains unverifiable without an actual compile (deferred to Phase 3).

## New module: `kit/hydra-ts/src/kit-assets.ts`

Plain TS, no `with { type: ... }` import attributes (safe in every lane —
spike §7). Exports, per spike §10:

- `initEmbeddedAssets(map)` — called once at startup by the compiled entry
  point (`cli.ts`) only.
- `isCompiledBinary()` — `import.meta.url.startsWith('file:///$bunfs/')`.
- `kitAssetPath(rel)` — checkout-anchored path; first existing candidate of
  `<repo>/hydra/<rel>` (installed layout) and `<repo>/kit/hydra/<rel>` (dev
  checkout); else the installed-layout path so the ENOENT points where an
  operator should install/fix.
- `kitAssetText(rel)` — embedded map first, then the checkout file.

## Entry point: `kit/hydra-ts/src/cli.ts`

`cli.ts` is the ONLY module in the tree carrying `with: { type: 'text' }`
imports (enforced by a test in `test/kit-assets.test.ts`). Inside the existing
`if (isMain)` block, BEFORE `route()` runs any subcommand `main()`, it:

1. checks `isCompiledBinary()`, and only then
2. dynamically imports the 6 EMBED-set assets (`result.schema.json`,
   `review.schema.json`, and the 4 seed profile YAMLs — filenames confirmed via
   `ls kit/hydra/profiles/`: `claude-fable-5.yaml`, `codex-gpt-5.6-sol.yaml`,
   `opencode-glm-5.2.yaml`, `kimi-k2.7-code.yaml`) with
   `{ with: { type: 'text' } }`, and
3. calls `initEmbeddedAssets({ 'schemas/result.schema.json': …, 'profiles/…': … })`.

Purely additive: the routing table, `route()` signature, and the
`docs/bun-migration-stage1-cli.md` test contract are untouched.

**Deviation 1 — dynamic, not static, imports.** Spike §10's sketch shows
static top-level imports in cli.ts. That is impossible here: `cli.test.ts`
statically imports `../src/cli.ts` under plain Node, and the source lane
(`node --experimental-strip-types src/cli.ts`, package script
`build:cli-check`) executes it — Node 22/24 throw
`ERR_IMPORT_ATTRIBUTE_UNSUPPORTED` at load time for a static
`with { type: 'text' }` (reproduced: spike §7; re-verified this task with a
probe on Node v22.14.0). A dynamic `import(spec, { with: { type: 'text' } })`
guarded by `isCompiledBinary()` parses cleanly under Node (verified: probe
exits 0) and never executes in the source lane. Bun attributes therefore live
in cli.ts exactly as specified, just in dynamic form.

## Per-call-site changes

| # | Site | Change | Override precedence (evidence) |
|---|---|---|---|
| 1 | `allocate.ts:22-25` profiles | `defaultProfilesDir()` removed; seed content via `kitAssetText('profiles/<file>')`; new local `readSeedText`/`yamlScalarText` helpers keep the old existsSync/yamlScalar semantics on text | `profilesDir` consulted first (kit-assets.test.ts "(a) profilesDir override still wins" — marker `cost_hint` from the override dir beats the real seed) |
| 2 | `create-worktree.ts:102-105` WAVE | `defaultWavePath()` → `kitAssetPath('WAVE')` | `HYDRA_WAVE` env and `options.wavePath` win: existing `create-worktree.test.ts` wave env tests unchanged and passing; new "(a) wavePath option overrides the checkout WAVE" test proves an override `0` beats the real checkout WAVE `2` (with a `2` control) |
| 3 | `graph-impact.ts:30-33,95` freshness-gate.sh | Default is now the in-process `freshnessGate(runId, taskId)` from `freshness-gate.ts:30`; `defaultFreshnessGatePath()` removed. `freshness-gate.sh` untouched for the frozen `HYDRA_HARNESS=bash` lane | See Deviation 2 below — the `freshnessGatePath` dep is retained as an explicit test hook (6 pre-existing tests exercise it, all passing). New test: with no dep, the real in-process gate yields exit 8 + `stale_omitted` |
| 4 | `promote.ts:23-26` result.schema.json | Schema read via `kitAssetText('schemas/result.schema.json')`; `validateDrop` now takes schema text; error messages and the drop→spec→schema check order preserved | `options.schema` wins: new test — a drop valid per the real schema is rejected `schema_invalid` only because the override schema demands an extra field |
| 5 | `promote.ts:28-31` verification.yaml | `defaultVerifyPolicyPath()` → `kitAssetPath('policies/verification.yaml')` | `HYDRA_VERIFY_POLICY` and `options.verifyPolicy` win: new end-to-end test reaching step 5 with an injected verifier captures `policy === '/custom/operator-verification.yaml'` when the env is set, and `kitAssetPath('policies/verification.yaml')` (real checkout file) when unset |
| 6 | `record-review.ts:21-24` review.schema.json | Schema read via `kitAssetText('schemas/review.schema.json')`; `schemaPath` option read first; `cannot read/parse schema` rejection path preserved | `schemaPath` wins: new test — override schema requiring an absent field rejects an otherwise-valid verdict; default case records successfully against the real schema |
| 7 | `integrate.ts:36-39` verification.yaml | `defaultVerifyPolicyPath()` → `kitAssetPath('policies/verification.yaml')` | `HYDRA_VERIFY_POLICY` / `HYDRA_SMOKE_POLICY` win: pre-existing `integrate.test.ts` tests 'uses non-empty verify and smoke policy overrides' and 'treats empty policy overrides as unset' (whose expected default equals the kitAssetPath result from this checkout) — read-only under this task's writable_paths, still passing where git can init |
| 8 | `review-required.ts:20-23` review-policy.yaml | `defaultPolicyPath()` → `kitAssetPath('policies/review-policy.yaml')` | `policyFile` wins: new test — override policy with `risk_at_least: low` requires review at `low` where the real policy does not; default case reproduces the real policy's `critical → required, reviewer codex` |

**Deviation 2 — `freshnessGatePath` dep retained in graph-impact.ts.** The
spec text says to remove the `spawnSync('bash', [freshnessGatePath, ...])`
call and the "now-unused freshnessGatePath default-resolution code". The
default-resolution code (`defaultFreshnessGatePath()`) IS removed and the
default IS the in-process call — the spec's core goal (a compiled binary never
needs the `.sh`). But six pre-existing `graph-impact.test.ts` tests inject
`freshnessGatePath` mock scripts, and that file is NOT in this task's
writable_paths, so the dep is kept as an explicit, documented test hook:
when `deps.freshnessGatePath` is provided it is still executed out-of-process;
when omitted, the in-process gate runs. This preserves the binding
"zero regressions" constraint without touching read-only files.

**Deviation 3 — source-lane fallback in `kitAssetPath`.** Three pre-existing
tests (`allocate.test.ts`, `review-required.test.ts`, `promote.test.ts` — all
read-only here) run commands with cwd OUTSIDE any git repository and rely on
the old source-file-relative resolution. Spec-verbatim `kitAssetPath` dies
there via `repoRoot()`, which would regress them. So when `repoRoot()` fails,
the Node source lane falls back to the pre-Stage-1
`dirname(fileURLToPath(import.meta.url))/../../hydra/<rel>` layout; the
compiled lane re-throws `repoRoot()`'s error, keeping the spike §6 "fails
loudly and correctly outside a repo" property (a fallback is useless in a
binary anyway — selfDir is the virtual `/$bunfs/root`). Verified manually:
`allocate` and `review-required` from `/tmp` (outside any repo) behave exactly
as before the change.

**Test placement.** The per-call-site override/default tests required by the
spec live in `kit/hydra-ts/test/kit-assets.test.ts` (the only writable test
file) rather than in each module's own test file. Pre-existing tests were not
modified anywhere.

## Verification performed (this environment)

- Baseline captured BEFORE any change: concurrent suite 787 tests / 711 pass /
  73 fail / 3 cancelled; `promote.test.ts` 27 tests / 2 pass / 25 fail. ALL
  baseline failures share one environmental cause: this sandbox denies
  creating `.git/` inside the worktree (`git init` → EPERM copying template
  hooks / writing `.git/config`; it works under `os.tmpdir()`). Affected
  suites: adapter-claude, kimiStart, auditOwnership, freshnessGate,
  indexCandidate, integrate, deriveDropFromGit, reviewDispatch, squash,
  status.sh bash fallback, and most of promote.
- After the change (same sandbox): concurrent 808 tests (787 + 21 new) with
  the failing set byte-identical to baseline (same 10 suites, same 75 failing
  subtests, multiplicity preserved — verified by diffing the TAP failure
  lists both ways). `promote.test.ts` identical to baseline (2 pass / 25
  fail, same subtests). `test/kit-assets.test.ts`: 21/21 pass.
- Corroborating run in an UNRESTRICTED location (detached scratch worktree
  under /tmp at the final commit, where git can init): concurrent 808 tests /
  805 pass / 3 fail; `promote.test.ts` 27/27 pass. The 3 failures are all in
  `status.sh.test.ts` ("spawned dispatcher should become visible via ps" —
  process-visibility sandboxing), proven pre-existing by running the same
  file at the base commit in an identical scratch worktree (same 3 fail).
  Net: baseline pass count + 21 new tests, zero regressions.
- Manual plain-Node runs (`node --experimental-strip-types`, Node v22.14.0):
  `allocate` (real seed cost_hints from the checkout), `review-required`
  (real policy), `record-review` (records against the real schema),
  `promote` (reaches `stale_spec`, proving the real default schema loaded),
  `graph-impact` (exit 8 + `stale_omitted` via the in-process gate — the
  exact pre-change observable), and `cli.ts allocate`/`cli.ts review-required`
  through the router. Fallback lane: `allocate` + `review-required` from
  `/tmp` outside any repo behave exactly as pre-change.
- `npm run typecheck`: NOT run — the npm registry is unreachable from this
  environment (403) and no `tsc` exists on the machine. TypeScript strictness
  was confirmed visually against sibling files; `@ts-ignore` guards annotate
  the Bun-only asset specifiers in cli.ts, which tsc cannot resolve (no
  `resolveJsonModule`, unknown `.yaml` modules).

## NOT verifiable without `bun build --compile` (deferred to Phase 3)

- `isCompiledBinary() === true` and the `import.meta.url === file:///$bunfs/…`
  detection inside a real binary.
- That `bun build --compile` EMBEDS assets referenced by **dynamic**
  `import(literal, { with: { type: 'text' } })` — the spike validated STATIC
  text imports only (§4 Test B2). If the bundler does not trace dynamic
  literal specifiers, Phase 3 must switch cli.ts to a form it does trace
  (e.g. a dedicated eagerly-bundled assets module imported only from the
  compiled entry). This is the single most important Phase-3 check.
- That embedded content is actually served by `kitAssetText` from the map in a
  moved binary with the source tree deleted (spike §4 B4 procedure), and the
  black-box "runs from an unrelated cwd with the checkout absent" CI gate
  (`docs/bun-migration-plan-codex.md:457-458`).
- The compiled-lane loud failure of `kitAssetPath` outside a repo (the
  fallback is source-lane-only by construction, but that needs a binary to
  prove).
- macOS signing/notarization survival of embedded assets, `--minify`/
  `--bytecode` interactions, and Windows/Linux `/$bunfs/` behavior (spike §11
  — still open there too).
