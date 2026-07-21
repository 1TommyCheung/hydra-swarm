# Changelog

All notable changes to Hydra-Swarm. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions track
`.claude-plugin/plugin.json`. Deeper narrative history (design rationale,
run-by-run evidence) lives in `docs/roadmap.md`.

> **Versioning policy (2026-07-19):** versions move SLOWLY. Notable features
> bump the third segment (0.6.8 → 0.6.9); minor fixes, docs, and small
> hardening go to a fourth segment (0.6.8 → 0.6.8.1). No minor-version bump
> without operator sign-off.
>
> **Renumbering note (2026-07-19):** the releases originally published as
> 0.7.0/0.7.1/0.7.2/0.8.0/0.8.1 were re-aligned to 0.6.4–0.6.8 — the pace of
> minor bumps overstated the changes. Content is identical; the superseded
> tags/releases were retired and v0.6.8 republished.

## [0.6.8.3] — 2026-07-21

Runs 0057–0062: revise-loop fidelity and truth-of-record hardening,
delivering the fixes for issues #26, #29, #30, #31, and #32. Every lane was
cross-vendor reviewed and adversarially verified before integration.

### Added
- **File-first revision evidence transport** (#26): amended (revise-round)
  dispatches materialize the latest recorded verdict, every still-unresolved
  blocking finding across the full verdict history, a bounded human-readable
  render, and a SHA-256-hashed manifest into a read-only, git-excluded
  `.hydra-context/revision-evidence/` bundle inside the worker's own
  worktree. The worker prompt carries only compact manifest metadata (paths,
  SHA-256s, byte sizes, trust labels, short finding ids) — verdict history is
  **not** inlined into the prompt. Every bundle entry is provenance-checked
  against `review_verdict` ledger events, self-verified after write
  (sha256 + size, regular non-symlink files), and hard-budgeted (verdict/
  finding/byte caps with explicit truncation metadata, never an unbounded
  bundle). Ledger events: `revision_evidence_materialized`,
  `revision_evidence_skipped`, `revision_evidence_failed`.
- **Explicit append-only review provenance** (#32): `review-dispatch`
  requires `--task <task_id>` and stamps it on both `review_started` and
  `review_completed`; task identity is never inferred from review-id naming.
  `record-review` publishes each validated verdict as an append-only
  generation at `authoritative/reviews/<task>/<seq>-<reviewed_head>.json` —
  nothing is overwritten, the highest valid generation is authoritative, and
  the full historical verdict provenance stays in authoritative state.
  `run-log`'s Review column distinguishes reviewer-completed / verdict-
  recorded / verdict-pending instead of "(none recorded)". The
  recorded-`accept` requirement is enforced as lead protocol: `squash` gates
  on promotion and `integrate` on squash records — neither consults the
  review store itself.
- **Native binary release matrix**: the release workflow now builds six
  native artifacts (darwin-arm64/x64, linux-x64/arm64, and native Windows
  windows-arm64/x64 `.exe`) in one build job, verifies the staged set
  natively on Linux, macOS, **and Windows** runners, and publishes through a
  single artifact fan-in job — no platform ships unverified. `fetch-bin.sh`
  remains a Unix-only installer (Windows: WSL, or download the `.exe` +
  manifest directly).

### Fixed
- **Claude API-error truth** (#29): a structured Claude API error (including
  HTTP 429 usage limits) no longer records as a successful completion. The
  adapter classifies the Claude-owned response envelope (`is_error`,
  `api_error_status` — never assistant prose) into a per-attempt outcome
  sidecar (`success` | `usage_limited` | `terminal_failure`); API-error runs
  synthesize a failed drop instead of reading worker results, and 429/quota
  errors feed the existing usage-limit cooldown registry. Malformed sidecars
  fail closed.
- **Unique dispatch attempt identity** (#31): every dispatch invocation
  atomically claims a durable, unique attempt namespace before
  `task_started` (attempt 1 keeps `<run>-<task>-v<spec_version>`; retries
  append `-a2`, `-a3`, …), so a re-dispatch after a rejected promotion can
  never reuse an `agent_run_id` or overwrite the rejected inbox drop.
  `status`/`cancel-task` bind to the greatest validated attempt's
  `dispatch_instance_id`, so a late exit from an older attempt cannot
  complete or cancel a newer one.
- **Renderer budget + review-store durability hardening** (#30, the deferred
  run-0057 review findings): the shared worker-prompt renderer wraps
  untrusted reviewer text in non-forgeable evidence fences (dynamic
  backtick sizing, bidi/invisible-character neutralization), enforces
  per-field and total byte budgets with incremental truncation and
  trusted-side truncation notices; the review store gained fsynced atomic
  no-replace publishes (temp → fsync → `link(2)` → directory fsync),
  age-based crash-safe sequence ownership (never pid-liveness), and
  contention-proof fault-injection tests.
- **Vendor-owned resume semantics** (#26 anchoring loop, completing #20): a
  requested `delivery=resume` downgrades loudly, not silently — the ledger
  records `delivery_downgraded` with `no_prior_session`,
  `session_vendor_unknown`, `session_vendor_mismatch`, or
  `adapter_resume_unsupported`, and the effective delivery is chosen by the
  adapter's declared resume capability plus the captured session's vendor,
  never by naming conventions.

## [0.6.8.1] — 2026-07-19

Fixes to existing herdr-pane, dispatch, and amend-task functionality — no
new features. Runs 0051–0055, closing issues #18–#23.

### Fixed
- **herdr pane live feedback for all vendors** (#18): review-dispatch's
  live progress tail no longer skips OpenCode; Claude gets a heartbeat
  line when it can't stream, so no dispatch mode leaves a blank pane.
  Agent panes are shrunk (`HYDRA_HERDR_PANE_RATIO`, default 0.25) so the
  lead console keeps the majority of the terminal.
- **herdr panes stay pinned to their originating workspace** (#19): the
  lead's workspace is captured once per run and reused on every later
  pane spawn instead of re-querying "whatever is focused right now" —
  switching macOS Spaces mid-run no longer redirects where new panes
  land. Capture is atomic across concurrent dispatches (exclusive-create
  lock file) so a race can't silently overwrite the run's first-recorded
  workspace.
- **louder resume-fallback warning** (#20 tier 1): when `delivery=resume`
  falls back to a cold restart, the warning now names the vendor and
  states plainly that a full re-run (not a quick continuation) is about
  to happen, instead of one easy-to-miss generic line.
- **real Kimi session resume** (#20 tier 2): `adapter-kimi.ts` now
  resumes via the Kimi CLI's actual `-S, --session <id>` flag instead of
  always cold-restarting; `COMPILED_ADAPTERS.kimi.resume` flipped to
  `true`. Codex/OpenCode real resume remains unimplemented.
- **`amend-task` preserves amendment detail** (#21): a hand-edited
  `amendment_reason` is no longer silently discarded when a shorter CLI
  reason is supplied; the CLI also accepts `@file` for reason and (new)
  `amendment_check` arguments, so multi-line revise instructions don't
  depend on shell-quoting.
- **amended tasks get a machine-checkable completion gate** (#23): an
  optional `amendment_check` list of shell assertions is rendered as a
  mandatory verification block in the worker prompt, so a revise round
  can't be satisfied by "the pre-existing tests still pass" alone.
  `amendment_check` YAML list items are safely quoted/escaped on write.

### Added
- **Vendor usage-limit detection** (new; motivated by a live OpenCode/GLM
  provider outage that hung two dispatches for the full 50-minute
  timeout with no error surfaced): a new `agent_usage_limited` terminal
  ledger state, a detector for OpenCode's `--print-logs` diagnostic
  stream (hard-gated on the vendor SDK's own `AI_APICallError` marker,
  never on assistant-authored text), and a machine-global cooldown
  registry consulted before dispatch — a vendor known to be usage-limited
  refuses to even start a second dispatch, mirroring the existing
  "hydra never auto-substitutes" policy (no auto-reroute, no auto-retry
  scheduling — dropped by design). Claude/Codex/Kimi detectors remain a
  follow-up.

## [0.6.8] — 2026-07-19

### Changed
- **Docs split: official vs dev notes.** 49 machine-generated development
  artifacts (bun-migration stages, vendor design/review/research records)
  moved out of the repo into the machine-local, gitignored
  `docs/dev-notes/`. Production users do not need them; pre-split copies
  remain recoverable from git history. Official docs, run audit logs
  (`docs/hydra-dev-logs/`), and operator guidance stay tracked.

## [0.6.7] — 2026-07-19

Run 0048: worktree lifecycle management — closes the "worktrees grow forever"
gap (issue #12) with a document-then-delete design. 11 Kimi worker attempts,
7 Codex adversarial review rounds, 18 deletion-safety/fidelity findings
closed across both features before acceptance.

### Added
- **`hydra gc`** (#12): reaps worktrees+branches ONLY when the ledger proves
  integration — authoritative result + recorded integration SHA (candidate
  head / squash record) reachable from the default branch, proof paired to
  the current tip through the same squash-record evidence chain (no evidence
  borrowing, no cross-generation proof). Dry-run by default; `--apply`
  required; `--keep-last N`; `--json`. Deletion safety: NUL-framed git
  status parsing (no ' -> ' delimiter ambiguity), candidate paths validated
  against `git worktree list --porcelain` and bound to their exact
  `hydra/<run>/<task>` branch, default-branch discovery fails closed,
  revalidation before EACH destructive op, atomic compare-and-delete via
  `git update-ref --no-deref -d <ref> <expected-sha>`, `worktree_reaped` /
  `worktree_reap_partial` ledger events with rerun recovery.
- **`hydra run-log`**: renders a per-run lifecycle audit document to
  `docs/hydra-dev-logs/run-<id>.md` (`--out` / `HYDRA_DEV_LOG_DIR`
  override) from the ledger + authoritative tree: run header, per-task
  lifecycle (dispatch attempts, promote outcomes incl. rejection reasons,
  reviews, squash/integration, reaps), full event timeline, usage,
  explicit "(none recorded)" gaps, ledger-anomaly section. Injection-safe:
  strict id validation, canonicalized output paths, symlink refusal,
  markdown/control-byte neutralization, authoritative-vs-ledger divergence
  rendering. This is what makes aggressive gc safe: document, then delete.
- **Retention policy** (SKILL.md step 10 + operations.md): at run close,
  `run-log` then `gc --apply --keep-last 3`; monthly `git worktree prune`;
  PR-flow worktrees (unprovable by design) removed manually post-merge.

## [0.6.6] — 2026-07-17

### Added
- **Binary distribution via GitHub Releases.** A `v*` tag triggers
  `.github/workflows/release.yml`: build-matrix compiles all four targets
  (darwin-arm64/x64, linux-x64/arm64 — glibc; Windows via WSL — superseded
  in 0.6.8.3 by the six-target native matrix incl. Windows) with pinned
  Bun 1.3.14, blackbox-verifies the runner-native artifact, asserts
  tag == plugin.json version == binary self-report, and uploads binaries +
  provenance manifests + SHA256SUMS. Binaries are never committed to git.
- **`fetch-bin.sh`** downloads the release binary matching THIS plugin's
  version into a version-keyed cache
  (`~/.local/share/hydra-bin/v<version>/hydra-cli-<target>`), gated on:
  manifest sha256 match, binary self-reported version == plugin version, and
  target-triple match. Any gate fails → nothing installed, ts lane unaffected.
- **`hydra_resolve_bin` cache candidate**: `HYDRA_BIN` → checkout `dist/` →
  version-keyed cache → ts fallback. Keyed by the checkout's own plugin
  version, so a stale binary is structurally invisible rather than merely
  checked for.
- **Doctor: compiled-binary check** — reports the resolved binary and warns
  on version drift or a pre-0.6.5 build (no `version` subcommand), with
  `fetch`/`rebuild` auto-fix commands.

## [0.6.5] — 2026-07-17

### Added
- **`version` subcommand** (`hydra version [--json]`): reports the plugin
  version and runtime lane (`compiled`/`ts`). The compiled binary embeds the
  manifest at build time, so it reports the version it was *built* from —
  previously a binary's version could only be inferred from mtime or feature
  probes.
- **`help` subcommand** and a parameterized usage listing: every subcommand
  now shows its argument signature (`hydra help`, or any unknown subcommand).
- **HTML architecture diagram** at `docs/architecture-diagram.html` —
  self-contained, browser-openable pipeline diagram (lead → harness → four
  worker heads → trust boundary → convergence → human), with the v0.6.4
  head-detection and worker-environment features annotated.

## [0.6.4] — 2026-07-17

Head auto-detection, worker environment hardening, and a swarm-reviewed fix
pass over every open PR (run 0047: 4 Kimi workers + 3 Sonnet subagents).

### Added
- **Vendor-head auto-detection** (#7). `detect-heads` CLI (+ stable
  `detect-heads.sh` launcher) probes all four vendor CLIs, enumerates
  opencode's configured models (`opencode models`) plus its active model, and
  probes `srt` for Kimi write-capability. Snapshot written to the
  machine-global `~/.local/state/hydra/heads.json`; `run-init` auto-detects
  and appends a `heads_detected` ledger event.
- **Allocate availability filter made real** (#7). Vendors whose CLI is not
  installed are dropped before ranking (live-probe fallback when `heads.json`
  is absent). When *no* eligible vendor probes available, allocation degrades
  to unfiltered ranking with a warning and an `availability_degraded` flag —
  it is recommend-only and must not fail in scrubbed environments (caught by
  the compiled-binary blackbox harness, 45/45 after the fix).
- **Dispatch fail-with-suggestions** (#7). A task whose `assigned_vendor` CLI
  is missing fails fast naming the heads that ARE available and the best
  eligible substitute for the role. Never auto-substitutes — humans re-pin.
- **`opencode_model:` task-spec pin** (#7). Per-task opencode model selection
  with precedence task-spec → `HYDRA_OPENCODE_MODEL` → machine
  `opencode-model.json` → default; warns (does not die) when the pinned model
  is not in the detected model list.
- **`HYDRA_NODE_BIN` worker toolchain export** (#7). macOS `path_helper`
  rebuilds PATH inside vendor-CLI tool shells, letting a stale system node
  (v17 in the field incident) shadow the harness-resolved v22. New
  `resolve-node.ts` mirrors the shell launcher's resolution ladder; dispatch
  exports the resolved bin dir into every worker env and the worker prompt
  names the one-line PATH fix. Hardened after cross-review: pathless
  `command -v` output rejected; env values with shell metacharacters dropped
  before prompt interpolation.
- **Worker dev-environment preflight** (#8). `worker-devenv.ts` verifies
  network domains, package-manager store/cache dirs, and the toolchain
  (git/node/package manager/vendor bin) *before* spawn — a preflight failure
  names the missing tool and remedy instead of dying mid-task. Review fixes:
  a missing `bun` no longer passes as "corepack-shimmable" (corepack only
  shims npm/yarn/pnpm), and tool-dedupe uses own-property checks so tools
  named like `Object.prototype` keys are still probed.
- **Per-task pnpm store under tmp** (#6). srt's mandatory deny of
  `.git/config`/`.git/hooks` writes blocked `pnpm install` for git-hosted
  deps; the store now lives in a per-attempt tmp dir passed via
  `npm_config_store_dir`. Review fixes: the tmp base is canonicalized
  (`realpathSync`) because srt matches physical paths and macOS `TMPDIR`
  lives under a `/var` symlink — without this the fix silently did not work —
  and per-attempt stores are removed post-run instead of accumulating.

### Fixed
- `yamlList` now routes through the shared `parseInlineScalar()` — a quoted
  list item followed by a trailing comment or whitespace previously kept its
  closing quote and comment text, reaching bash as an unterminated quote.
  Found independently by two reviewers in run 0047.
- Superseded #6's inline pnpm-store computation in `adapter-kimi.ts` with the
  general `prepareWorkerEnv()` path during #8's integration; post-run cleanup
  now removes all four per-attempt store/cache dirs.

## [0.6.3] — 2026-07-17

### Fixed
- **Double-quoted YAML scalars kept their escape sequences** (#4).
  `yamlList`/`yamlScalar`/`yamlBlock` stripped surrounding quotes but never
  unescaped `\"`/`\\`, so a quoted verification-policy command reached bash
  with literal backslash-quotes and always failed, invisibly. Fixed via
  `unescapeYamlDoubleQuoted()`, applied only to actually-quoted values.
- **Comment-stripping ran before quote detection** (#4, found in review): a
  quoted value containing a literal `#` was truncated at the inner `#` before
  the closing quote was reached. The shared `parseInlineScalar()` helper now
  extracts the quoted body first and collapses three near-identical
  detect/strip/unescape copies.
- **`promote` swallowed the real error when `verify()` threw** (#4): the
  rejection pointed at an `observedJson` file that was never written. A
  diagnostic record is now persisted and the reject detail carries the cause.
- `result schema not found` now names the remediation (missing installed-kit
  layout) instead of a bare path (#4).

### Changed
- **Skill: vendor CLIs are never invoked directly** (#5). Raw
  `codex exec`/`opencode run`/`kimi -p`/`claude -p` shell calls are forbidden
  — even read-only consultations route through `review-dispatch.sh` (pane
  hosting, `review_started`/`review_completed` ledger events, raw session
  capture). Closed after the gap was observed live.

## [0.6.2] — 2026-07-17

### Fixed
- **Kimi sandbox: empty domain allowlist on a fresh machine** (#2). Without
  an operator baseline file the srt settings blocked Kimi's own provider
  endpoints and every dispatch died with `provider.connection_error`. Now
  falls back to the fixed provider-domain set.
- **Sandbox domains derived from the worktree's own manifests** (#3).
  `env-domains.ts` maps `package.json`/lockfiles/`.npmrc`/Python files to
  well-known registry/git-hosting domains (never arbitrary URLs from file
  contents) and unions them into the allowlist and persisted baseline. A
  baseline-persistence regression that would have reintroduced #2 on fresh
  machines was caught and fixed before merge.

## [0.6.1] — 2026-07-16

### Fixed
- `doctor.sh` dropped the obsolete `bash >= 4` preflight gate (the harness is
  TypeScript/Bun; the bash implementation lane was retired in run 0045) and a
  matching stale docs claim surfaced by a live Kimi diagnostic.

## [0.6.0] — 2026-07-16

### Changed
- **Bun single-binary is the default runtime.** Unset `HYDRA_HARNESS` prefers
  the compiled binary (`npm run build:bin` → `kit/hydra-ts/dist/hydra-cli`,
  gitignored, built per machine), falling back silently to the
  TypeScript/Node source lane only when no binary is resolvable. Explicit
  `HYDRA_HARNESS=bin` never falls back. Checksummed rollback binaries live at
  `~/.local/share/hydra-pinned-binaries/`.
- **Bash implementation lane retired** (run 0045). `HYDRA_HARNESS=bash` fails
  loudly instead of silently coercing.
- All 61 pre-existing `npm run typecheck` errors resolved; a 45-check
  compiled-binary blackbox harness (`test:blackbox`) guards the compiled
  lane.

## Earlier (pre-0.6.0, 2026-07-12 → 2026-07-16)

Waves 0–2, summarized — full history in `docs/roadmap.md`:

- **Wave 0** — the evidence-gated loop: task specs, worktree isolation,
  dispatch, the promote trust boundary (schema → Git evidence → ownership
  audit → sandboxed verify), squash, serialized integration.
- **Wave 1** — cross-vendor review contracts, capability profiles,
  divergence measurement, ledger-first recovery.
- **Wave 2** — all four heads (Claude, Codex, OpenCode/GLM, Kimi), srt
  sandboxing for Kimi's auto-approving write role, GitNexus/Graphify code
  intelligence, herdr pane hosting with live progress tails.
- **Post-Wave-2 hardening** — full TypeScript port of the bash harness,
  async completion triggers, `status`/`cancel-task`, the loop-thinking
  detector with auto-cancel, `/hydra-doctor` preflight with opt-in auto-fix,
  MIT license, repo extraction into a standalone plugin.
