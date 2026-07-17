# Changelog

All notable changes to Hydra-Swarm. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions track
`.claude-plugin/plugin.json`. Deeper narrative history (design rationale,
run-by-run evidence) lives in `docs/roadmap.md`.

## [0.7.1] — 2026-07-17

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
  worker heads → trust boundary → convergence → human), with the v0.7.0
  head-detection and worker-environment features annotated.

## [0.7.0] — 2026-07-17

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
