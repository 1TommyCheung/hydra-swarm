# Hydra-Swarm — Roadmap

**Status:** Wave 2 operational since 2026-07-13. Waves 0–2 delivered; the front of
the roadmap is now packaging (Wave 3) and the hardening daemon. This file is a
*delivered changelog + forward plan*, not a design proposal — per-wave evidence
reports lived in the pre-extraction tree (`docs/hydra-reports/`) and were not
carried into this standalone repo.

## Delivered (Waves 0–2)

Dates are the day the wave's exit criteria were met in this repo.

### Wave 0 — evidence-gated integration loop · 2026-07-12
- Trust boundary (`promote.sh`): schema → git evidence → ownership audit →
  sandboxed verify → promote. Six rejection unit tests + a positive control.
- Claude + Codex subprocess adapters; worktree/branch lifecycle; harness-created
  squash; serialized cherry-pick integration + combined gate.
- **Hypothesis run (0002)** caught a planted semantic conflict at the combined
  gate that each candidate passed alone. See `wave0-completion.md`.
- Deviations recorded during the build: workers write `.hydra-result.json` in
  their own worktree (the adapter bridges it — workers never touch the state
  store), not into the inbox; a NUL glob sentinel bash silently drops; a linked
  worktree's git metadata lives in the git-common-dir *outside* the worktree.

### Wave 1 — intelligence and resilience · 2026-07-13
- GitNexus post-freeze indexes + manifests + freshness gate; `graph-impact.sh`
  as advisory-only risk input. **Deviation:** the harness index is built with
  `gitnexus analyze --skip-agents-md --skip-skills --name` (registers without
  mutating tracked files); `--index-only` was wrong (it also skips registration,
  leaving nothing to query).
- Versioned `resume()` amendment (`amend-task.sh`): v1→v2 with stale-version
  rejection, exercised end-to-end in run 0004. **Deviation:** Kimi/Codex have no
  true session resume, so delivery is cold-restart (the spec anticipated this).
  **Known gap:** the substantive spec edit is a hand edit before the version
  bump, so the amendment *content* is not fully reconstructable from the ledger
  (see the drift note in `architecture.md` §4.6).
- Risk-triggered cross-vendor review policy (`review-policy.yaml`,
  `review-required.sh`), formalized from Wave 0 convention.
- Timeouts, concurrency cap, budget accounting as ledger events (`dispatch.sh`,
  `record-usage.sh` → `agents/usage.jsonl`).
- Standing lead-recovery drill (`recovery-drill.sh`, 3/3).
- **OpenCode (GLM 5.2) adapter** — read-only explorer + long-diff reviewer.
  **Deviation:** the working model id is `zai-coding-plan/glm-5.2` (not
  `zhipu/glm-5.2`); the correct headless invocation is `opencode run --format
  json --auto`.
- Conditional `wave_1` bootstrap (gitnexus analyze), gated on `hydra/WAVE`.

### Wave 2 — all four heads + adaptive orchestration · 2026-07-13
- **Kimi K2.7 adapter** — visual_debugging + contained implementation under a
  macOS `sandbox-exec` confinement. **Deviations:** `kimi -p` already
  auto-approves tools (so `-y` is rejected *and* the OS sandbox is mandatory);
  the sandbox must allow `/dev/null` (git/bash open it) and the herdr socket dir.
- Graphify baseline + **investigation-not-verdict** policy
  (`graphify-baseline.sh`, `graphify-investigate.sh`): EXTRACTED edges open a
  blocking investigation, INFERRED/AMBIGUOUS are review questions only.
  **Deviations:** edges live under `.links` (networkx node-link JSON) with
  `confidence: EXTRACTED|INFERRED|AMBIGUOUS`; the semantic pass needs an LLM key
  (a Kimi coding-plan key works via an in-memory base-URL + `kimi-code-cli`
  User-Agent patch — installed package untouched).
- Live capability profiles (`aggregate-usage.sh` writes the `measured` class;
  four canonical seed profiles) + `allocate.sh` (recommend-only, human-gated).
- Observability: **herdr installed mid-wave → Layer-1 became real**. Ledger web
  renderer Layer-2 (`ledger-view.sh`), ledger-vs-live reconciliation emitting
  `observability_anomaly`, pane-hosted dispatch **and** reviewers
  (`review-dispatch.sh`). OTel export config is build-with-note (no collector).
  **Deviation:** the herdr vendor integrations only hook *session* lifecycle
  events, which never fire for one-shot `exec`/`-p` workers, so the harness
  pushes pane state itself (`hydra_herdr_state`).
- Automated routing *recommendations* (`allocate.sh`) — never automatic pins.

### Post-Wave-2 hardening found by operating the system (this session)
- **Two new trust-boundary gates** surfaced by pane-hosting a real run:
  `no_commit` (head == base / empty diff — work left uncommitted, §2.1) and
  `not_completed` (a worker-declared `failed` drop must never promote). Boundary
  suite 6 → 9 cases.
- **Empty-objective bug** (highest-value fix): `build-worker-prompt.sh` read the
  YAML block-scalar objective with a same-line accessor, so every worker prompt
  carried an *empty* objective and only the acceptance criteria. Fixed with
  `hydra_yaml_block`. It masqueraded as three separate vendor failures.
- Dispatch signal-safety: killed dispatches now record `agent_cancelled` and
  reap the whole worker tree (no dangling `running` tasks, no orphaned agents).

### TypeScript harness cutover + entry-point hardening · 2026-07-13

- **Cutover evidence (run 0036):** a real supervised shakedown ran the unchanged
  `bash kit/hydra/scripts/<name>.sh` command surface with `HYDRA_HARNESS=ts` through
  run initialization, worktree creation, a herdr-pane-hosted Codex worker using
  the TypeScript adapter, promotion, squash, and dependency-ordered integration
  of two candidates with the combined verification gate. After that run passed,
  the human-authorized default flipped to TypeScript. Unset meant `ts` from
  this point through the Bash lane retirement below — see "Bun-as-default
  cutover" for the later change to what unset means today.
- **Post-cutover independent review (run 0038):** the three vendor reviews
  confirmed broad functional parity but exposed the stale-Node environment risk.
  Codex reproduced the critical boundary gap directly: all shell wrappers used
  bare `node`, so `/usr/local/bin/node` v17.4.0 could shadow nvm's Node 22 in a
  non-interactive environment and fail before TypeScript started. The earlier
  `process.execPath` fix protected adapter children, not this first hop.
- **Entry-point hardening (run 0039):** all 26 operational wrappers now call
  `hydra_resolve_node()`. It requires Node ≥22.6, checks `PATH`, then chooses the
  highest qualifying nvm install or a common Homebrew install, and emits an
  actionable error if none exists. The hostile-PATH reproduction passed after
  the fix; the full suite reported 577 tests. The cutover report and migration
  notes lived in the pre-extraction tree (`../hydra-reports/wave2-ts-cutover.md`
  and `../../hydra-ts/migration/`); they were not carried into this standalone repo.

### Bash lane retirement · 2026-07-16

- **Full retirement of the Bash implementation lane** (run 0045,
  `docs/bash-lane-retirement-plan.md`). The six shell vendor adapters under
  `kit/hydra/adapters/` were deleted; the 28 `kit/hydra/scripts/*.sh` filenames
  remain as small `ts`/`bin` launchers with no Bash bodies. `HYDRA_HARNESS=bash`
  and `HYDRA_ADAPTER_RUNTIME=bash` now fail loudly with an explicit retirement
  error and do **not** silently coerce to `ts`; `dispatch.ts`'s
  `resolveAdapterRuntime` also rejects any other unrecognized adapter-runtime
  value.
- **No-Node rollback** is a pinned, checksummed `bun build --compile` binary
  selected by `HYDRA_HARNESS=bin` / `HYDRA_BIN`, independent of an installed
  Node or Bun. The retained artifact is refreshed each time the pinned source
  commit changes (currently `v2`, `~/.local/share/hydra-pinned-binaries/v2/`,
  manifest alongside it); `v1` is kept as historical, not deleted. The Bash
  body suite (`status.sh`/`cancel-task.sh` Bash-mode cases) was replaced by
  launcher-routing and dispatch-runtime-selection coverage.
- **Rationale:** the shell lane was ~4.4k mostly-untested lines with known
  silent rot (six `mapfile` commands failed on stock macOS Bash 3.2), semantic
  drift from the TypeScript lane, and no recorded post-cutover incident it
  actually recovered. The compiled-binary black-box evidence (45/45 native
  macOS arm64) was materially stronger rollback evidence than the shell lane.

### Bun single-binary migration (Stage 1–4) + Bun-as-default cutover · 2026-07-16

- **Stage 1 — router + compiled entry point:** every one of the 33
  `isMain`-guarded modules was normalized to export `main(args)`, and
  `kit/hydra-ts/src/cli.ts` became the single real entry point for a compiled
  binary — a `bun build --compile` bundle collapses every module's
  `import.meta.url` to the same synthetic path, so per-file guards cannot
  distinguish the entry from an import; `cli.ts` routes 34 subcommands
  (including the 5 `adapter-<vendor>` compiled self-reexec targets) via a
  single table, and a later fix (`!isCompiledBinary()`) neutralized the
  redundant per-module guards a real compiled binary was found to still
  trigger.
- **Stage 2 — asset embedding + spawn/env hardening:** trust-boundary schemas
  and seeded vendor profiles are embedded at compile time
  (`kit-assets.ts`); operator-editable policy/WAVE files resolve
  checkout-relative so they never require a rebuild to edit. `BUN_BE_BUN`
  (a documented Bun CLI-hijack escape hatch) is stripped at every vendor and
  Herdr child spawn; `audit-ownership.ts`'s `GIT_CEILING_DIRECTORIES` fix
  covers a real Bun-vs-Node divergence where in-process `process.env`
  mutations are not inherited by spawned children under Bun.
- **Stage 3 — cross-platform proof:** a 4-target build matrix
  (darwin-arm64/x64, linux-x64/arm64) plus a target-agnostic black-box test
  harness. Real execution (not just cross-compile) was proven via Docker on
  both Linux architectures — 44/44 checks each, including the asset-embedding
  and spawn fixes holding under a genuinely different OS/libc. darwin-x64 was
  smoke-tested under Rosetta 2 (one known, understood, non-product AVX-warning
  discrepancy); real Intel hardware remains unverified.
- **Stage 4 — two rounds of independent adversarial review:** round 1 (Codex)
  rejected both the runtime and bash/build-tooling halves of the diff and
  found 8 real bugs — the most severe being that compiled `dispatch` could not
  actually launch any adapter at all (no self-reexec runtime existed) and every
  `bin`-mode wrapper was hijackable via a leaked `BUN_BE_BUN=1` (a reproduced
  exploit, not theoretical). All 8 were fixed in three parallel lanes. Round 2
  (OpenCode/GLM, substituted after Codex exhausted its usage quota mid-review)
  independently re-verified every fix against a real compiled binary and
  issued an unqualified accept — 847 test executions, 0 failures, including the
  previously-deferred compiled-dispatch end-to-end fixture actually running.
- **Bash lane retirement** (run 0045, see above) followed directly from this
  evidence: the compiled binary's rollback story was materially stronger than
  the untested shell lane it replaced.
- **`npm run typecheck` gate provisioned for the first time:** `tsc`/
  `@types/node` had never been installed in any sandbox that touched this
  repo during the migration, so the gate silently didn't run. Once installed,
  it surfaced 61 pre-existing errors (unrelated to the migration itself — a
  drift gap, not a regression); all 61 were fixed directly (three parallel
  Sonnet subagents, no Hydra dispatch needed for a same-day type-only cleanup)
  and the gate is now clean.
- **Bun-as-default cutover:** `hydra_launch()`'s unset-`HYDRA_HARNESS` case now
  prefers the compiled binary, falling back to `ts` silently only when no
  binary is resolvable yet (a fresh checkout with nothing pre-built must still
  work out of the box). An explicit `HYDRA_HARNESS=bin` keeps its hard-error
  contract — no silent downgrade for a deliberate operator choice. Explicit
  `ts` and the retired `bash` value are unchanged. Full suite (812/812
  concurrent, 27/27 promote, 45/45 black-box, the compiled-dispatch fixture
  running for real) and all four `HYDRA_HARNESS` resolution paths were
  spot-checked through real wrapper invocations before this landed.
- **Reproducing the test counts above:** `cd kit/hydra-ts && npm test` runs
  the concurrent + promote suites (`npm run test:concurrent` /
  `npm run test:promote` individually); `node --experimental-strip-types
  scripts/blackbox-compiled.ts <binary-path>` runs the 45-check black-box
  suite against any compiled artifact (`npm run build:bin` produces one).
  These are unit/integration/black-box launcher tests living in
  `kit/hydra-ts/test/` and `kit/hydra-ts/scripts/blackbox-compiled.ts`
  respectively — not evidence that requires the pre-extraction tree.

### Post-cutover cleanup · 2026-07-16 (v0.6.1)

- **`hydra doctor`'s stale Bash-4 preflight gate fixed.** Its shell check
  still required Bash 4+ — a leftover from when the (now-retired) Bash
  implementation lane needed `mapfile`. Left as-is, it would `FAIL` and
  block `hydra doctor`/setup on any stock Mac without Homebrew bash
  installed, even though nothing in the current harness needs Bash 4+
  (the launcher scripts were specifically verified against real
  `/bin/bash` 3.2 during the retirement work). Now reports the detected
  shell informationally with no minimum version enforced, consistent with
  `docs/bash-lane-retirement-plan.md`'s "No runtime Bash-version guard"
  principle. Verified: full 15-check `doctor.sh` suite passes clean under
  both bash 5.3 and real bash 3.2.
- Full doc/skill sweep confirmed the installed plugin cache
  (`~/.claude/plugins/cache/hydra-swarm/hydra-swarm/0.6.0`) matched
  `origin/master` byte-for-byte on the files checked, and no other stale
  `HYDRA_HARNESS=bash`, deleted-adapter-path, or `mapfile`/`readarray`
  references remained anywhere in `kit/hydra/scripts/` or the current
  (non-historical) docs.

### Kimi sandbox network-domain fixes · 2026-07-17 (v0.6.2)

- **PR #2 — empty allowlist on a fresh machine (merged).** On a machine
  without `~/.local/state/hydra/kimi-sandbox-domains.json` (or with an
  invalid one), the kimi adapter built an srt settings file with an
  **empty** `network.allowedDomains`, blocking the Kimi CLI's own provider
  endpoints — every dispatch died with `provider.connection_error` after
  Kimi's retry budget (~30s, zero tokens, no captured stderr). Found in
  the field on a different machine (DonFlow advisory run
  `lhf-standalone-advice`). Fixed: fall back to a fixed
  `KIMI_PROVIDER_DOMAINS` set (`api.kimi.com`, `api.moonshot.ai`,
  `api.moonshot.cn`) instead of `[]` when the baseline is missing/invalid;
  operator baselines keep full precedence when present.
- **PR #3 — derive sandbox domains from the worktree's own manifests
  (merged).** A second field incident (DonFlow `ws9-import-plan`,
  2026-07-17): a worktree needing `pnpm install` / `npx tsc` got 403'd
  against `registry.npmjs.org`, forcing a worker to hand-assemble
  `node_modules` via symlinks (which then tripped `promote.sh`'s ownership
  audit) rather than the operator hand-editing the baseline again. Added
  `kit/hydra-ts/src/env-domains.ts`: derives well-known registry/git-hosting
  domains from `package.json`/lockfiles/`.npmrc`/Python project files
  (fixed allowlist of hosts only — never trusts arbitrary URLs out of file
  contents verbatim), merges them into the allowlist (`baseline ∪ derived ∪
  task-spec`), and unions them into the persisted baseline so repeat
  dispatches to similar worktrees stop needing a manual edit.
- **Regression caught and fixed before merge, not after:** the lead's
  review of PR #3 found that its baseline-persistence call wrote only the
  *derived* domains, not the in-memory `KIMI_PROVIDER_DOMAINS` fallback
  from PR #2 — so a fresh machine's very first dispatch to a worktree with
  dependency manifests would write a baseline file missing
  `api.kimi.com`/`api.moonshot.*` entirely, and every dispatch after that
  first one would read the now-"valid" file and skip the fallback,
  silently reintroducing PR #2's exact bug. Reproduced directly (a real
  written-file check, not just code reading), fixed by persisting
  `[...baseline, ...derivedDomains]`, and covered by a new regression test
  verified to fail on the un-fixed code before being merged. Landed as an
  additional commit on the PR branch before merging, not a follow-up patch.

### YAML unescape + verify() diagnostics (PR #4) · 2026-07-17 (v0.6.3)

- **Double-quoted YAML scalars kept their escape sequences.** `yamlList`/
  `yamlScalar`/`yamlBlock` stripped surrounding double quotes but never
  unescaped `\"`/`\\`. A tracked verification-policy command quoted as
  `"ok=1; for f in proposals/*.md; do [ -s \"$f\" ] && ok=0; done; exit $ok"`
  reached bash with literal backslash-quotes and always failed, with no
  signal why (the JSON-echoed command looked correct at a glance). Fixed
  with `unescapeYamlDoubleQuoted()`, applied only to values that were
  actually double-quoted.
- **`promote` swallowed the real error when `verify()` threw.** When
  `verify()` died before writing its output (missing/unparseable policy,
  zero commands), promote rejected with a message pointing at an
  `observedJson` file that was never written, discarding the underlying
  error. Now a diagnostic record is written and the reject detail carries
  the real cause.
- **Found in review before merge: comment-stripping ran before quote
  detection.** `yamlScalar` and `yamlBlock`'s inline branch stripped a
  trailing `# comment` *before* checking whether the value was
  double-quoted, so a quoted value containing a literal `#` (e.g.
  `"release notes (see issue #42)"`) was truncated at the inner `#` before
  the closing quote was ever reached — undermining the PR's own fix for
  exactly this class of bug. Fixed by extracting the quoted body first
  (respecting escaped quotes) via a shared `parseInlineScalar()` helper,
  which also collapsed three near-identical copies of the
  detect/strip/unescape logic into one; comment-stripping now only ever
  runs on unquoted material. Covered by new regression tests in
  `lib.test.ts`.

### Head auto-detection + worker node toolchain (PR #7, run 0047) · 2026-07-17 (v0.7.0)

- **HYDRA_NODE_BIN worker PATH fix.** Field incident (Jon_test_redcat run
  0002): macOS `path_helper` rebuilds PATH inside vendor-CLI tool shells with
  `/usr/local/bin` ahead of version managers, so a stale node v17 shadowed the
  harness-resolved v22 and the Kimi worker burned turns prepending the nvm bin
  dir to every command. New `resolve-node.ts` mirrors the shell launcher's
  resolution ladder; dispatch exports `HYDRA_NODE_BIN` into every worker env;
  the worker prompt names the toolchain and the one-line PATH fix. Hardened
  after Sonnet cross-review (pathless `command -v` output; hostile env values
  dropped before shell interpolation).
- **Head auto-detection (Kimi-implemented, run 0047).** `detect-heads.ts`
  probes all four vendor CLIs, enumerates opencode's configured models plus
  the active one, probes srt for kimi write-capability, and writes a
  machine-global `~/.local/state/hydra/heads.json` snapshot (same dir
  convention as `kimi-sandbox-domains.json`). CLI `detect-heads [--json]` +
  stable launcher; run-init appends a `heads_detected` ledger event;
  allocate's availability filter is now real (drops uninstalled vendors,
  live-probe fallback); dispatch fail-with-suggestions when a task's
  `assigned_vendor` CLI is missing (names available heads and the best
  eligible substitute — never auto-substitutes); optional task-spec
  `opencode_model:` pin with documented precedence and a stale-list warning.
- **Trust boundary catch:** the worker's first promote attempt was REJECTED —
  it had symlinked `node_modules` to a sibling task's worktree to get tsc,
  and the ownership audit flagged the symlink escaping the worktree. Debris
  removed, re-promoted clean; committed content was always in-scope.

### Wave 3 preflight tooling — first real artifact · 2026-07-13

- **`srt` replaces `sandbox-exec` for Kimi sandboxing** (run 0041, commit
  `15d48de`) — migrated Kimi's OS sandbox from macOS-only `sandbox-exec` to
  Anthropic's `srt` (`@anthropic-ai/sandbox-runtime`), which uses Seatbelt on
  macOS and bubblewrap on Linux behind the identical CLI/config. This closes the
  Linux portability gap for Kimi's write role; `firejail`/`bwrap` direct support
  was never implemented.
- **`hydra-swarm` plugin skeleton + working `/hydra-doctor`** (commit
  `b2a1c43`) — a Claude Code plugin skeleton with manifest
  (`.claude-plugin/plugin.json` plus `.claude-plugin/marketplace.json`), slash command
  (`commands/hydra-doctor.md`), and a tested preflight script
  (`kit/scripts/doctor.sh`). The script implements all seven
  `hydra doctor` check classes (shell, core tools, vendor CLIs, code
  intelligence, observability, `srt` sandbox, timeout fallback), reports fatal
  `FAIL` vs advisory `WARN`, and exits non-zero only on fatal failures. The
  plugin currently contains **only** the doctor script and command; kit
  extraction, `hydra-setup`/`hydra-init`, policy templates, global ledger
  migration, and bundle export/import are still not built.

## Resolved open decisions (from ledger evidence, 2026-07-13)

1. **External state root** — `~/.local/state/` remains the default; overridable
   via `HYDRA_STATE_ROOT`. *Unchanged; re-affirmed.*
2. **GLM 5.2 promotion to implementer** — **RESOLVED: promoted, availability-
   gated.** GLM took a real write role (`opencode.json` `hydra-implementer`
   profile, `opencode.sh start`). It works when the endpoint is healthy; the
   Z.AI coding endpoint returned transient 500s during run 0015 (the exact
   config succeeds on retry). Route around unavailability via `allocate.sh`.
3. **Kimi write-role policy** — **RESOLVED: write role allowed under a full OS
   sandbox only.** Kimi implements well greenfield/contained (run 0006 debounce,
   0009 hi) but is weak at *revise-existing* refactors (run 0015 v3/v4 no-ops —
   partly the empty-objective bug, partly its seed weakness). Keep it off
   subtle refactors; prefer it for fresh contained modules and visual_debugging.
4. **Scorecard-driven allocation** — **RESOLVED: recommend-only, human-gated.**
   `allocate.sh` recommends, never auto-pins; uses `measured` at n≥8 else seeded
   priors. Current n is still small (Claude 5, Codex 4, Kimi 3), so seeded
   priors drive allocation today — as designed.
5. **Graphify graph: run-scoped vs committed** — **run-scoped external artifact**
   (default kept); stored under `indexes/graphify/<repo-id>/run-<id>/`.
6. **Minimum integration gate commands per project** — *still open*; Wave 0–2
   projects set them per run via `HYDRA_VERIFY_POLICY` / the task `verification:`
   list. A tracked per-project floor is a Wave 3 packaging item.
7. **Retention of external run state / worktrees** — *still open*; nothing is
   auto-pruned yet (15 runs retained). Revisit at packaging.
8. **Local-branch-only vs PR preparation** — *still open, local-branch-only
   holds.* All integration branches stay local; merge/push is human-authorized.
9. **Daemon trigger** — *still open.* The protocol boundary held through Wave 2;
   the daemon is justified by team size > 1 lead or a multi-tenant state store.

### License decision — MIT, matching CrewAI · 2026-07-14
- **License:** plain MIT for the core Hydra-Swarm framework. No code-level
  commercial restriction, no PolyForm/BSL/Elastic carve-out.
- **Precedent:** CrewAI uses the same model — MIT-licensed core framework with
  monetization via a separate enterprise/control-plane product, proven at scale
  (5.2M monthly downloads).
- **Future monetization:** recorded as a separate enterprise/control-plane
  product (e.g. managed run history, cross-repo capability ledger dashboard,
  governance/observability) to be built and licensed separately later — not a
  restriction on this repo's code.
- **Reasoning trail:** see run 0002 research consult documents
  `docs/license-research-codex.md`, `docs/license-research-kimi.md`, and
  `docs/license-research-opencode.md`.

### Task #31 — async completion trigger + hang detection · 2026-07-14
- **Async completion trigger:** replaced watcher-script polling with blocking
  dispatch plus caller backgrounding. `dispatch.sh --background` now only selects
  whether the CLI process awaits the worker; it does not change how the worker
  itself runs. The recommended pattern is to call `dispatch.sh <run> <task>`
  without `--background` and let the caller's own background-execution mechanism
  carry the command. This removes stale-sentinel false completions (a real
  failure mode: a watcher matched a leftover `.exit` file from a prior round).
- **Operational commands:** added `status.sh` (`kit/hydra/scripts/status.sh`) for
  read-only, one-shot status (ledger state, elapsed time vs timeout/hard-cap
  budgets, advisory dispatch liveness, progress tail, recent ledger events), and
  `cancel-task.sh` (`kit/hydra/scripts/cancel-task.sh`) as the only supported
  clean cancellation path. `cancel-task.sh` resolves the dispatch process via
  pidfile or validated process discovery, sends SIGTERM, waits for the
  dispatcher's terminal ledger write, and escalates to SIGKILL only as a last
  resort. It never mutates state itself.
- **Loop-thinking detector:** automatic two-stage monitoring for Codex/Kimi/OpenCode
  dispatches, comparing streaming capture patterns against Git worktree progress.
  On detection it appends `agent_loop_suspected`; if the pattern persists through
  a confirmation window it appends `agent_loop_confirmed` and auto-cancels via the
  same clean path as manual cancellation. Claude is excluded because it has no
  streaming capture. Set `HYDRA_LOOP_DETECTOR=0` to disable for sessions where
  false positives are expected.
- **Cross-vendor adversarial review:** three rounds of review for the
  auto-cancellation feature, closing stale Stage-2 clock, Rule-B failure
  recency, and untracked-file fail-open paths before release.
- **Reasoning trail:** see `docs/async-trigger-design-codex.md`,
  `docs/async-trigger-design-kimi.md`, `docs/loop-detector-design-codex.md`,
  and `docs/codex-review-loop-detector-fix2.md`.

## Now: the front of the roadmap

### Wave 3 — packaging & portability (`packaging.md`) — **next**

**Goal:** install the proven kit on a *second* repo at full capability, and carry
measured evidence across machines and repos. Preflight tooling (`hydra doctor`)
is now built and tested; the remaining Wave 3 items (kit repo, `hydra-setup`,
bundle export/import, global ledger, per-project verification floor, retention
policy) are still design-only. Scope is informed by a portability audit
(2026-07-13) of what actually pins Hydra to this machine.

**What the audit found (drives Wave 3 scope):**
- The harness itself is trivially portable — **zero hardcoded paths**, all
  locations env-overridable (`HYDRA_STATE_ROOT`/`WORKTREE_ROOT`/`REPO_ID`).
- The friction is the *ecosystem*: 10 external CLIs + 4 vendor logins + Graphify
  API keys + the global herdr integrations — none of which clone with the repo.
- **bash 4+ requirement removed.** The retired Bash lane needed `mapfile` (5
  scripts) and so required Bash 4+ while macOS ships 3.2; the `ts`/`bin`
  launchers have no such dependency. `hydra doctor`'s own preflight check
  still gated on Bash 4+ for a full day after the lane retirement (a stale
  leftover check, not a real dependency) — it would FAIL and block setup on
  any stock Mac without Homebrew bash installed; fixed 2026-07-16 to report
  the detected shell informationally with no minimum version, verified clean
  under both bash 5.3 and real `/bin/bash` 3.2.
- **Kimi write-role portability** was a real cross-platform gap under
  `sandbox-exec` (macOS-only); now closed by migrating to `srt`, which works on
  both macOS and Linux with the same CLI/config.
- **Run history / measured profiles don't clone** — the recovery bundle is
  documented (`state-and-worktrees` §2) but the export/import scripts don't exist.
- The **global capability ledger** (`packaging.md` §4) is designed but not built —
  measured data is currently per-repo under `<state>/agents/`.

**Deliverables:**
1. **`hydra-kit` repo** — extract the project-agnostic files (scripts, schemas,
   adapters, skills, hooks, universal rules, *seeded* profiles), version-tagged,
   with `kit.manifest.yaml` (checksums + min tested CLI versions).
2. **`hydra-setup` skill** — install / upgrade / doctor modes; supersedes
   `wave0-implementation.md` for new installs.
3. **`hydra doctor` preflight** — **built and tested** as a Claude Code plugin
   command at the repo root. Originally checked bash ≥ 4 (that gate was
   removed 2026-07-16, see "Post-cutover cleanup" below — it now reports the
   detected shell informationally with no minimum enforced); `jq`, `git`, and
   Node ≥ 22.6;
   each vendor CLI present (headless smoke per CLI, non-fatal individually);
   Graphify/`gitnexus` present (non-fatal); `herdr` present (non-fatal); `srt`
   sandbox available and enforcing (Seatbelt on macOS, bubblewrap on Linux, else
   Kimi write-role is refused, on the record); plus a timeout fallback. Exits
   non-zero only on fatal failures.
4. **Run-bundle export/import** (`bundle-export.sh` / `bundle-import.sh`) — closes
   the Tier-3 gap: a sanitized bundle (run.yaml, tasks, promoted results, reviews,
   verification, `events.jsonl`; **excludes** credentials, sessions, raw
   transcripts) that reconstructs a run on another machine.
5. **Global capability ledger migration** — move `measured` evidence to
   `~/.local/state/hydra/global/agents/` with `repo_id` tagging and stricter
   cross-repo confound guards (`packaging.md` §4); `aggregate-usage.sh` gains a
   global mode. Per-repo `overrides/` win for local pins.
6. **Per-project verification floor** — resolves open decision #6: a tracked
   minimum gate the kit ships as `verification.yaml.template` and the install
   self-check enforces.
7. **Retention policy** — resolves open decision #7: prune/keep rules for external
   run state + worktrees (nothing is pruned today; 15 runs retained).

**Wave 3 exit criteria:**
1. Kit installs on a second repo; the six boundary rejection tests + a headless
   smoke per configured vendor pass **in that environment**.
2. A supervised shakedown run (1 task, 1 worker) completes on repo #2.
3. `hydra doctor` correctly reports a missing dependency and refuses to install.
4. A bundle exported from repo #1 imports and reconstructs on another machine
   (recovery drill passes against the imported state).
5. Measured evidence from two repos aggregates in the global ledger, with the
   cross-repo confound guard demonstrably suppressing an easy-task-only vendor.

**Wave 3 open decisions:**
- **Cross-platform sandbox** — resolved by adopting `srt`
  (`@anthropic-ai/sandbox-runtime`), which gives a single cross-platform tool
  with Seatbelt on macOS and bubblewrap on Linux. Direct `firejail`/`bwrap`
  support is no longer planned.
- **Kit distribution** — private git repo (clone/tag) vs `npm`/`brew` package.
- **Global-ledger strictness** — how aggressively cross-repo confound guards
  down-weight a vendor that only saw easy tasks in one repo.

### Hardening milestone — harness daemon
Replace the Wave 0 privileged-lead protocol boundary with a real capability
boundary: a local daemon owning the state directory under separated privileges,
exposing narrow operations only:

```text
create-run · register-task · record-dispatch · promote-result
record-verification · record-review · close-run
```

The lead gets read-only promoted views and cannot write ledger files. Because
every mutation already flows through script interfaces (`run-init`, `promote`,
`squash`, `integrate`, `record-review`, `record-usage`, `amend-task`), this
migration changes the *owner* of the scripts, not their callers.

### Later enhancements
- Standalone `hydra` CLI (moves the caller; scripts/schemas/state survive).
- OpenCode **warm server** (`opencode serve` + `--attach`) for TUI-free, cold-
  start-free reviewer/implementer runs (vendor-adapters §4).
- MCP-based adapters; Agent-SDK adapters for programmatic permission callbacks.
- herdr as the default Layer-1 monitor for every run; a live OTel collector.
- Amendment *content* recorded to the ledger so `resume()` is fully
  reconstructable (closes the §4.6 drift gap).
- Verification against a clean checkout of `head_commit` rather than the dirty
  worktree, so untracked files cannot influence the gate (closes the drift the
  `no_commit` gate only partially covers).
- Ownership-audit case-collision check (trust §5) — currently omitted.
- Design references to track, not adopt wholesale: **gnap**, **wit**,
  **swarm-protocol**, **MartinLoop** (run-receipt benchmark for exit reports).

## Success criteria (cumulative) — status at Wave 2 exit

| # | Criterion | Status |
|---|---|---|
| 1 | Wave 0 exit criteria | ✅ `wave0-completion.md` |
| 2 | Replacement lead resumes from Git + state store alone | ✅ standing drill 3/3 + Codex-led reconstruction (run 0006) |
| 3 | No agent-reported verification is ever the sole basis for acceptance | ✅ harness re-runs `verify.sh` every promotion |
| 4 | Spec amendments reconstructable; results match latest version | ⚠️ version + stale-reject ✅; amendment *content* not yet ledgered (later enhancement) |
| 5 | Ownership violations caught at the audit even when hooks bypassed | ✅ boundary tests 3/4; +`no_commit`/`not_completed` gates |
| 6 | Graph evidence never independently blocks or approves | ✅ GitNexus advisory + Graphify investigation-not-verdict |
| 7 | Per-vendor `claim_vs_verified_divergence` measured | ✅ Claude 0.20 (n=5), Codex 0.00 (n=4), Kimi 0.00 (n=3) — small n |
| 8 | A Codex-led run succeeds | ✅ Codex reconstructed run 0006 and drove the next step from the ledger |

## Doc-maintenance checklist (run at each wave exit)

The system's rule is *evidence over claims*; the docs obey it too. At each wave
exit, before tagging:

- [ ] **README** — bump version/status; state the hypothesis verdict with the
      run id + measured numbers it rests on.
- [ ] **roadmap** — move the wave from planned → delivered with a date and
      *deviations + why*; resolve or re-date open decisions from ledger evidence.
- [ ] **vendor-adapters** — re-verify both matrices against current vendor docs;
      bump `last_verified`; annotate seeded priors with `measured` (n, rate) or
      retire them.
- [ ] **wave<N>-implementation** — freeze as historical; do not rewrite (destroys
      provenance).
- [ ] **normative docs** (architecture, trust, state, contracts, code-
      intelligence) — drift audit: reconcile each claim against
      `kit/hydra/scripts/` reality; fix the code or amend the doc, never leave them
      silently disagreeing. Prefer running the audit *as a hydra review* (a
      whole-repo docs-vs-code analysis, findings gated by a human).
- [ ] **exit report** — snapshot exit criteria + ledger proof + measured stats +
      hypothesis verdict + known limitations. (In the pre-extraction tree these
      lived in `docs/hydra-reports/`; this standalone repo has not committed a
      per-wave report directory yet.)
- [ ] **operations** — update the runbook for any new failure modes or env vars.
