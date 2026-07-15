# Bun migration — Stage 1 Phase 3: black-box harness for compiled binaries (`scripts/blackbox-compiled.ts`)

Run 0040, task `build-matrix-and-blackbox`, branch
`hydra/0040/build-matrix-and-blackbox` (base
`90f146e0fa2e532de6db3f8489d99c945f9e9029`). Delivers CI gate 5 of the plan
("Compiled black-box tests on the matching OS/architecture",
`docs/bun-migration-plan-codex.md:401-402`) and the no-network smoke test of
gate 7. Companion doc: `docs/bun-migration-stage3-build-matrix.md`.

## Design: target-agnostic by construction

`node --experimental-strip-types scripts/blackbox-compiled.ts
<path-to-binary> [--keep-scratch] [--timeout-ms=N]` (also `npm run
test:blackbox -- <path>`). The binary path is the **only** input. The binary
under test is an **opaque executable**: it is only ever spawned as a child
process with argv/env/cwd. Nothing about the host OS is probed or assumed,
so the identical harness runs against the native macOS build here and
against the Linux cross-compiled builds in the lead's container — that
portability matters more than anything this sandbox can prove about Linux.

Every invocation runs with a **scrubbed environment**:

- `PATH` = an empty scratch directory — no `node`, no `bun`, no `git`, no
  vendor CLIs, not even `sh` via PATH. This is the whole point of the gate:
  the compiled binary carries its own runtime and must never resolve dev
  tooling (and it doubles as the missing-executable mechanism for check 4).
- `HOME`, `HYDRA_STATE_ROOT`, `HYDRA_WORKTREE_ROOT`, `XDG_STATE_HOME`,
  `TMPDIR` = per-run scratch dirs, so all side effects are contained and
  nothing leaks into operator state (`hydra_state_root` discipline, same as
  the guard-neutralization task). The scratch tree is removed at the end
  (`--keep-scratch` keeps it for debugging).
- No API keys of any kind — combined with the fact that usage/dependency
  paths perform no network I/O, check 1 is a no-network smoke test by
  construction.
- 30 s per-invocation timeout (configurable): a hang is a FAIL, not a wait.

## The five checks

1. **`smoke[<name>]` (34 sub-checks)** — every routed subcommand with no
   args from a checkout-free scratch cwd. Each must produce **its own
   expected behavior**: expected exit code + expected signature substring,
   no crash markers, no signals, and — the regression test for the
   isMain-guard cascade fixed in
   `docs/bun-migration-stage2-guard-neutralization.md` — **no other
   subcommand's signature in the output** (signatures are mutually
   distinctive; the pre-fix cascade printed ~15 modules' usage lines for one
   invocation). Deviations from "usage error + exit 1" that are the
   subcommand's *correct* behavior are encoded as such: `otel-env` and
   `aggregate-usage` legitimately exit 0 (export lines / empty measured
   report), `promote`'s usage error exits 2 (pre-existing, documented in
   the bash-preamble doc), and `adapter-kimi`/`graphify-repo` print their
   dependency-gate errors under the scrubbed PATH.
2. **`cwd-independence[…]` (7 sub-checks)** — a **copy** of the binary in
   the scratch tree, run from an empty cwd with the checkout absent:
   - `allocate` exits 0 with the real seeded ranking — the 3 ranked
     vendors' `cost_hint` strings are asserted against values read **live
     from the checkout's `kit/hydra/profiles/*.yaml`** (fallback: literals
     recorded at the base commit), proving the 4 embedded seed profiles are
     served from inside the binary.
   - `record-review` with a schema-valid verdict exits 0 ("review
     recorded") and with an invalid verdict exits 5 ("review verdict
     rejected (schema)") — the embedded `review.schema.json` is loaded AND
     enforced, not silently skipped.
   - `review-required`, `create-worktree`, `integrate`, `promote` all fail
     **loudly** with the `repoRoot()`-style "not inside a git repository"
     error (correct exit 1; 2 for promote) — the checkout-relative assets
     (policy YAMLs, WAVE) never silently default and never crash.
3. **`unknown-subcommand`** — exit 1, empty stdout, usage banner plus all
   34 routed names on stderr.
4. **`enoent[…]` (2 sub-checks)** — missing-executable semantics
   (`docs/bun-migration-stage2-spawn-audit.md`): `adapter-kimi start …`
   with 5 arg slots (its `requireKimi` dependency gate spawns `sh -c
   'command -v kimi'`, which fails under the scrubbed PATH) and
   `graphify-repo` (`findExecutable('graphify')` gate) both exit 1 with the
   clear "CLI not found" error, no hang, no wrong code.
5. **Summary table** — check name, PASS/FAIL, one-line detail; exit
   non-zero if anything failed.

**Drift guard (`routes-drift` check):** the subcommand list is read **live
from the source tree's `src/cli.ts` `routes` object** by text-parsing it
(never importing cli.ts) and compared against the harness's expectation
table — any drift is a hard FAIL, so the table cannot silently go stale.
The expected values themselves were derived empirically at the base commit
under exactly this harness's env and **cross-checked byte-for-byte against
the Node source lane: 34/34 identical** (compiled binary vs `node
--experimental-strip-types src/cli.ts <name>`, same scrubbed env). When the
source tree is unreachable the harness says so and falls back to the
embedded table (the risk the spec asked to flag, flagged in the header
comment with the regeneration procedure).

## Full real output — `bun-darwin-arm64` build in this sandbox

Binary: `dist/bun-darwin-arm64/hydra-cli`, 63,759,842 bytes, SHA-256
`65d26de0d4218e7b018bd41a663c4b7e39d50be81e0c81b29dc262800f760e37`
(manifest in the build-matrix doc). Command:
`node --experimental-strip-types scripts/blackbox-compiled.ts
dist/bun-darwin-arm64/hydra-cli` — **exit 0, 45/45 checks passed**:

```
PASS  routes-drift  — table matches all 34 routes in src/cli.ts
PASS  smoke[adapter-claude]  — exit 1, signature ok, no cross-subcommand output (48ms)
PASS  smoke[adapter-codex]  — exit 1, signature ok, no cross-subcommand output (38ms)
PASS  smoke[adapter-kimi]  — exit 1, signature ok, no cross-subcommand output (50ms)
PASS  smoke[adapter-opencode]  — exit 1, signature ok, no cross-subcommand output (36ms)
PASS  smoke[adapter-stub]  — exit 1, signature ok, no cross-subcommand output (35ms)
PASS  smoke[aggregate-usage]  — exit 0, signature ok, no cross-subcommand output (34ms)
PASS  smoke[allocate]  — exit 1, signature ok, no cross-subcommand output (34ms)
PASS  smoke[amend-task]  — exit 1, signature ok, no cross-subcommand output (34ms)
PASS  smoke[audit-ownership]  — exit 1, signature ok, no cross-subcommand output (33ms)
PASS  smoke[build-worker-prompt]  — exit 1, signature ok, no cross-subcommand output (35ms)
PASS  smoke[cancel-task]  — exit 1, signature ok, no cross-subcommand output (34ms)
PASS  smoke[code-intel]  — exit 1, signature ok, no cross-subcommand output (54ms)
PASS  smoke[create-worktree]  — exit 1, signature ok, no cross-subcommand output (36ms)
PASS  smoke[dispatch]  — exit 1, signature ok, no cross-subcommand output (43ms)
PASS  smoke[freshness-gate]  — exit 1, signature ok, no cross-subcommand output (41ms)
PASS  smoke[graph-impact]  — exit 1, signature ok, no cross-subcommand output (38ms)
PASS  smoke[graphify-baseline]  — exit 1, signature ok, no cross-subcommand output (36ms)
PASS  smoke[graphify-investigate]  — exit 1, signature ok, no cross-subcommand output (41ms)
PASS  smoke[graphify-repo]  — exit 1, signature ok, no cross-subcommand output (33ms)
PASS  smoke[herdr-push]  — exit 1, signature ok, no cross-subcommand output (35ms)
PASS  smoke[index-candidate]  — exit 1, signature ok, no cross-subcommand output (40ms)
PASS  smoke[integrate]  — exit 1, signature ok, no cross-subcommand output (34ms)
PASS  smoke[ledger-view]  — exit 1, signature ok, no cross-subcommand output (31ms)
PASS  smoke[measure-divergence]  — exit 1, signature ok, no cross-subcommand output (34ms)
PASS  smoke[otel-env]  — exit 0, signature ok, no cross-subcommand output (33ms)
PASS  smoke[promote]  — exit 2, signature ok, no cross-subcommand output (36ms)
PASS  smoke[record-review]  — exit 1, signature ok, no cross-subcommand output (34ms)
PASS  smoke[record-usage]  — exit 1, signature ok, no cross-subcommand output (41ms)
PASS  smoke[review-dispatch]  — exit 1, signature ok, no cross-subcommand output (39ms)
PASS  smoke[review-required]  — exit 1, signature ok, no cross-subcommand output (34ms)
PASS  smoke[run-init]  — exit 1, signature ok, no cross-subcommand output (33ms)
PASS  smoke[squash]  — exit 1, signature ok, no cross-subcommand output (36ms)
PASS  smoke[status]  — exit 1, signature ok, no cross-subcommand output (33ms)
PASS  smoke[verify]  — exit 1, signature ok, no cross-subcommand output (33ms)
PASS  cwd-independence[allocate-embeds-profiles]  — exit 0 with seeded ranking from EMBEDDED profiles, checkout absent
PASS  cwd-independence[record-review-embeds-schema]  — valid verdict recorded via EMBEDDED review.schema.json, checkout absent
PASS  cwd-independence[record-review-schema-enforced]  — invalid verdict rejected (exit 5) — embedded schema is enforced, not skipped
PASS  cwd-independence[review-required-loud-outside-repo]  — exit 1 with clear repoRoot()-style error (checkout-relative asset)
PASS  cwd-independence[create-worktree-loud-outside-repo]  — exit 1 with clear repoRoot()-style error (checkout-relative asset)
PASS  cwd-independence[integrate-loud-outside-repo]  — exit 1 with clear repoRoot()-style error (checkout-relative asset)
PASS  cwd-independence[promote-loud-outside-repo]  — exit 2 with clear repoRoot()-style error (checkout-relative asset)
PASS  unknown-subcommand  — exit 1, empty stdout, usage banner + all 34 names on stderr
PASS  enoent[adapter-kimi-start]  — missing dependency reported cleanly: exit 1, "kimi CLI not found (Wave 2 dependency)", no hang (47ms)
PASS  enoent[graphify-repo]  — missing dependency reported cleanly: exit 1, "graphify CLI not found (Wave 2 dependency)", no hang (38ms)

45/45 checks passed
```

(The full run also prints a formatted summary table — same 45 lines,
re-flowed — before the `45/45 checks passed` line; elided here to avoid
duplication.)

## What this run proves (and what it does not)

Proven for the compiled artifact on the one target executable here:

- The **guard-cascade regression is dead** on the compiled lane: 34/34
  subcommands produce exactly their own output (the pre-fix binary printed
  44 lines from ~15 modules for one invocation and wrote stray state).
- **Dynamic-import asset embedding works** — the #1 open Phase-3 risk from
  `docs/bun-migration-stage2-assets.md:140-144` ("if the bundler does not
  trace dynamic literal specifiers, Phase 3 must switch cli.ts"). Bun
  1.3.14 does trace them: seed profiles and `review.schema.json` are served
  from a relocated binary with the checkout absent, and the schema is
  enforced.
- **Checkout-relative assets fail loudly** outside a repo, exactly per the
  spike §6 design.
- Unknown-subcommand contract and ENOENT process semantics hold.
- The binary runs with **no node/bun/git/sh on PATH** — runtime PATH
  independence confirmed.

## Findings worth recording (pre-existing, not introduced here)

- `promote`'s outside-repo error is printed with a doubled prefix
  (`hydra: error: hydra: error: not inside a git repository …`) — cosmetic
  wart in the source lane's error wrapping, visible identically under Node.
- `promote` from a checkout-free cwd hits `repoRoot()` **before** reading
  the embedded `result.schema.json`, so it cannot serve as a black-box
  witness for that embed; `record-review` covers the schema-embed proof.

## What remains unverified in this sandbox (honest list)

- **Linux execution**: the `bun-linux-x64`/`bun-linux-arm64` binaries are
  built and checksummed but were never run here (no Docker, no Linux
  environment). The lead runs THIS harness, as-is, against them in a
  container. Linux-specific risks still open per the plan: sandbox (srt),
  libc edge cases, process discovery (`pgrep`/`ps` visibility), shell
  matrices.
- **`bun-darwin-x64`** (not buildable here — network-blocked runtime
  download) and any x64-mac execution.
- **musl targets** — out of scope, not attempted (needs a musl execution
  matrix first).
- **Windows** — out of scope per the plan (Bash, Unix sockets, signals,
  paths, vendor sandboxes all undesigned).
- **macOS signing/notarization/quarantine/JIT entitlements** — unsigned
  local builds only; Gatekeeper behavior for downloaded artifacts untested.
- The plan's stale-`node`/stale-`bun` **PATH-shim fixture lane** (gate 5's
  full form) is approximated here by an empty PATH; a lane with actively
  failing shims is a suggested follow-up.
- `doctor`/`doctor --json` (plan gate 7) does not exist yet — no
  `src/doctor.ts`; expected in the later doctor-port phase
  (`docs/bun-migration-stage1-cli.md:102-105`).

## Verification performed (this environment)

- Harness run above: 45/45, exit 0, against the real local
  `bun-darwin-arm64` build.
- Expectation-table derivation: 34/34 subcommands byte-identical between
  the compiled binary and the Node source lane under the harness env.
- `npm test` (full kit/hydra-ts suite, Node v22.14.0): see the build-matrix
  doc's verification section — this task adds scripts only, no `src/` or
  `test/` changes; the suite is unaffected.
- All scratch state removed after the runs (`rmSync` in a `finally`;
  `HYDRA_STATE_ROOT` was pointed at the scratch tree for every binary
  invocation, so nothing was written to `~/.local/state/*-hydra/`).
