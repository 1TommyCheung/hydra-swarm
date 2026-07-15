# Bun migration — Stage 1 Phase 3: multi-target build matrix (`scripts/build-matrix.ts`)

Run 0040, task `build-matrix-and-blackbox`, branch
`hydra/0040/build-matrix-and-blackbox` (base
`90f146e0fa2e532de6db3f8489d99c945f9e9029`). Implements the "Build and CI plan"
section of the accepted plan (`docs/bun-migration-plan-codex.md:346-406`) and
**lifts its macOS-only phase-1 deferral by explicit request**: the plan scoped
distribution to `bun-darwin-arm64`/`bun-darwin-x64` and deferred Linux
("needs sandbox, libc, process, and shell test matrices"); this task adds the
Linux **glibc** targets to the matrix and builds the black-box harness that
exercises them (see `docs/bun-migration-stage3-blackbox.md`).

## What the script does

`kit/hydra-ts/scripts/build-matrix.ts`, invoked via
`npm run build:matrix` (`node --experimental-strip-types
scripts/build-matrix.ts [--targets=a,b,...]`):

1. **Resolves Bun the `hydra_resolve_node` way** (pin/resolve/assert, see
   `kit/hydra/scripts/lib.sh:67`): probes only controlled locations —
   `$HYDRA_BUN` if set, then `~/.bun/bin/bun` — executes `<bun> --version`,
   asserts a `\d+.\d+.\d+` shape, and records it. There is **deliberately no
   fallback to a bare `bun` on PATH** (the plan's build-time PATH-shadowing
   risk); if no candidate exists or is executable, the script fails loudly
   naming every probed location.
2. Records the source commit (`git rev-parse HEAD`, validated as 40 hex).
3. For each target (default all four; `--targets=` filters, validated):
   `bun build --compile --no-compile-autoload-dotenv
   --no-compile-autoload-bunfig --target=<target> --outfile
   dist/<target>/hydra-cli src/cli.ts` with `stdio: inherit` so Bun's own
   output (including the one-time `Downloading [...]` line when a
   cross-compile runtime is fetched — expected, not an error) stays in the
   build log.
4. Per successfully built artifact: size in bytes + SHA-256, written to a
   **per-target manifest** `dist/<target>/manifest.json` (matching the plan's
   "one manifest per artifact": source SHA, pinned Bun version, target, size,
   SHA-256) **plus one aggregate** `dist/manifest.json` for the whole run.
   Both-manifests was my call (the spec allows either); per-target files
   travel with each artifact, the aggregate gives CI one file to read.
5. A target that fails (e.g. cross-compile runtime download blocked) is
   **omitted from the manifests — never faked** — the summary marks it FAIL
   and the script exits non-zero.

## Targets

`bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`
(glibc). **musl is explicitly out of scope** (follow-up: add
`bun-linux-x64-musl`/`bun-linux-arm64-musl` once a musl execution
environment exists to verify against; the plan defers musl for the same
"test matrix first" reason Linux originally was).

## Matrix result in this sandbox (macOS arm64, Bun 1.3.14, network blocked)

Real `npm run build:matrix` output (exit 1 — one target unreachable here):

```
build-matrix: bun 1.3.14 (/Users/tommycheung/.bun/bin/bun), source 90f146e0fa2e, targets: bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64

[build] bun-darwin-arm64 -> dist/bun-darwin-arm64/hydra-cli
  [34ms]  bundle  46 modules
 [148ms] compile  .../kit/hydra-ts/dist/bun-darwin-arm64/hydra-cli
[build] bun-darwin-arm64 ok: 63759842 bytes, sha256 65d26de0d4218e7b018bd41a663c4b7e39d50be81e0c81b29dc262800f760e37

[build] bun-darwin-x64 -> dist/bun-darwin-x64/hydra-cli
   [9ms]  bundle  46 modules
Network error downloading executable for 'bun-darwin-x64-v1.3.14'. Check your internet connection and proxy settings.
[build] bun-darwin-x64 FAILED (bun exited 1). Cross-compiling a non-native target
        downloads that target's Bun runtime once; without network access that
        download fails. This target is omitted from the manifest (never faked).

[build] bun-linux-x64 -> dist/bun-linux-x64/hydra-cli
   [9ms]  bundle  46 modules
 [108ms] compile  .../kit/hydra-ts/dist/bun-linux-x64/hydra-cli bun-linux-x64-v1.3.14
[build] bun-linux-x64 ok: 94898304 bytes, sha256 ff19326f0f619d3821e225c70581443d117c201169103f952a5b7b4fcefc05c9

[build] bun-linux-arm64 -> dist/bun-linux-arm64/hydra-cli
   [8ms]  bundle  46 modules
 [118ms] compile  .../kit/hydra-ts/dist/bun-linux-arm64/hydra-cli bun-linux-aarch64-v1.3.14
[build] bun-linux-arm64 ok: 93956240 bytes, sha256 5bcf4f1e97ff4e5353a9fa369f793d36e9034bc866b2697e1489300d6f1dd27a

build-matrix summary
  OK    bun-darwin-arm64  63759842 bytes  sha256:65d26de0d4218e7b…
  FAIL  bun-darwin-x64  (not built; omitted from manifest)
  OK    bun-linux-x64  94898304 bytes  sha256:ff19326f0f619d38…
  OK    bun-linux-arm64  93956240 bytes  sha256:5bcf4f1e97ff4e53…
manifests: 3 per-target + 1 aggregate under dist/
build-matrix: error: 1 target(s) failed: bun-darwin-x64
```

- `bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-arm64` **built** (the two
  Linux runtimes were already in Bun's local cache from earlier runs on this
  machine, so their one-time download was not needed).
- `bun-darwin-x64` **failed honestly**: its runtime was not cached and this
  sandbox has no network access (`Network error downloading executable for
  'bun-darwin-x64-v1.3.14'`). No manifest entry exists for it. The lead (with
  network/Docker) completes the matrix by re-running the same command.
- File-type spot check (`file(1)`): darwin binary is `Mach-O 64-bit
  executable arm64`; both Linux binaries are `ELF 64-bit LSB executable`
  (x86-64 / ARM aarch64), `dynamically linked, interpreter
  /lib64/ld-linux-x86-64.so.2` resp. `/lib/ld-linux-aarch64.so.1` — i.e.
  **glibc**, as required (a musl static binary would have no ld-linux
  interpreter).

## Aggregate manifest (real, this sandbox)

`dist/manifest.json` after the run above (per-target
`dist/<target>/manifest.json` files carry the same fields flat; checksum
independently confirmed with `shasum -a 256`):

```json
{
  "schema_version": 1,
  "source_sha": "90f146e0fa2e532de6db3f8489d99c945f9e9029",
  "bun_version": "1.3.14",
  "bun_path": "/Users/tommycheung/.bun/bin/bun",
  "built_at": "2026-07-15T16:28:13.814Z",
  "entrypoint": "src/cli.ts",
  "build_flags": [
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig"
  ],
  "targets": [
    {
      "target": "bun-darwin-arm64",
      "outfile": "dist/bun-darwin-arm64/hydra-cli",
      "size_bytes": 63759842,
      "sha256": "65d26de0d4218e7b018bd41a663c4b7e39d50be81e0c81b29dc262800f760e37"
    },
    {
      "target": "bun-linux-x64",
      "outfile": "dist/bun-linux-x64/hydra-cli",
      "size_bytes": 94898304,
      "sha256": "ff19326f0f619d3821e225c70581443d117c201169103f952a5b7b4fcefc05c9"
    },
    {
      "target": "bun-linux-arm64",
      "outfile": "dist/bun-linux-arm64/hydra-cli",
      "size_bytes": 93956240,
      "sha256": "5bcf4f1e97ff4e5353a9fa369f793d36e9034bc866b2697e1489300d6f1dd27a"
    }
  ]
}
```

## Test-suite verification (full `kit/hydra-ts` suite, zero regressions)

This task adds two scripts and two `package.json` entries — no `src/` or
`test/` changes — so the suite must be completely unaffected. Verified, not
assumed (Node v22.14.0, matching run 0039's baseline):

- **In-worktree** `npm test`: 808 tests / 733 pass / 72 fail / 3 cancelled —
  the exact pre-existing in-worktree signature every prior run documents
  (this sandbox denies `.git/` writes inside the worktree, so all
  `git init`-fixture tests EPERM; `test:promote` is not reached because
  `test:concurrent` exits non-zero — pre-existing).
- **Controlled comparison** (same method as run 0039: full-tree copies under
  /tmp, `git init`'ed, escaping the sandboxed path): base commit
  `90f146e0` vs this task's tree, run **sequentially**:
  - base: 808 tests / 805 pass / 3 fail
  - head: 808 tests / 805 pass / 3 fail
  - failing-test name sets diffed: **byte-identical** — the 3 known
    `status.sh` bash-fallback process-visibility failures ("live dispatch
    process visible via `ps`" family), pre-existing on the base commit.
  - Net: **zero regressions**.
  - (First attempt ran both copies in parallel and produced differing
    failure sets — all `git commit -m initial` fixture-setup flakes from
    the concurrent load; the sequential rerun above is the authoritative
    comparison.)
- Baseline-count honesty note: the task spec cites "810 tests". What
  reproduces here is **808 discovered by `test:concurrent`**, with
  `test:promote` (27 tests) unreachable behind the `&&` when the concurrent
  lane exits non-zero — the same short-circuit prior stage docs record.
  Run 0039's doc itself reports both shapes across environments
  (810/807/3 in one, 808/805/3 + promote 27/27 in another). The operative
  fact in every shape: base and head are identical.

The black-box harness run (45/45, exit 0) against the
`bun-darwin-arm64` artifact above is in
`docs/bun-migration-stage3-blackbox.md`, including its full output.

## What remains unverified / open follow-ups

- **`bun-darwin-x64` not built here** (network-blocked runtime download) —
  lead completes it; the script already handles it with no code change.
- **No Linux execution in this sandbox** (no Docker): the two Linux ELF
  binaries were built and checksummed but never run here. The lead runs
  `scripts/blackbox-compiled.ts` (target-agnostic, see the blackbox doc)
  against them in a container.
- **musl targets** not attempted (out of scope; needs a musl test matrix
  first).
- **Windows** not attempted (plan: needs a design for Bash, Unix sockets,
  signals, paths, vendor sandboxes).
- **macOS signing/notarization/quarantine/JIT entitlements** still open
  (plan lines 378-382): these are unsigned local builds, not distribution
  proof.
- Install/update mechanism (atomic versioned dir + stable link) still to be
  defined before the binary becomes default.
- CI gates 1-3 and 6-7 of the plan (`tsc --noEmit`, Bun source lane,
  signing verification, fixture-vendor tests) are not wired by this task;
  this task delivers gate 4 (compile + manifest) and the harness for gate 5.
- `npm run typecheck` was NOT run here: no `node_modules` in the worktree
  and the npm registry is unreachable from this sandbox (pre-existing
  restriction documented in every prior stage doc). Both new scripts are
  plain TS exercised at runtime by the runs above.

## Lead verification (post-integration, real network + Docker access)

Performed after this task's candidate was merged to master, on
commit `18772b4` (this doc's own commit):

- **All 4 targets built successfully**, including the `bun-darwin-x64`
  artifact the sandboxed worker could not reach (network-blocked runtime
  download there; unblocked here). Manifest: `dist/manifest.json` (real
  SHA-256/size/commit/bun-version per target, regenerable via
  `npm run build:matrix -- --targets=bun-darwin-arm64,bun-darwin-x64,bun-linux-x64,bun-linux-arm64`).
- **`bun-darwin-arm64` (native)**: `blackbox-compiled.ts` → 45/45 PASS,
  including `routes-drift` (source tree present) — this is also the first
  real confirmation that Phase 2's asset-embedding design
  (`docs/bun-migration-stage2-assets.md`) actually works in a genuine
  compiled binary, not just in theory: `cwd-independence[allocate-embeds-profiles]`
  and the two `record-review-embeds-schema*` checks prove the 4 EMBED-set
  assets are read correctly from inside the binary with the checkout tree
  entirely absent.
- **`bun-linux-x64` and `bun-linux-arm64` (real execution, not just
  cross-compile)**: run via Docker (`node:22-bookworm-slim`,
  `--platform linux/amd64` and `linux/arm64` respectively) with the binary
  as the sole mounted executable and the harness run from the host against
  it → **44/44 PASS on both architectures** (`routes-drift` gracefully
  skipped per its documented design when the source tree isn't mounted
  into the container — not a failure). This is the decisive evidence that
  was explicitly deferred by both this task and the original plan's Linux
  scope-cut: **the compiled binary runs correctly on real Linux, both
  x86-64 and arm64, including the Phase 2 asset-embedding and Phase 2
  guard-neutralization fixes holding under a genuinely different OS/libc**.
- **`bun-darwin-x64` under Rosetta 2** (no physical Intel Mac available):
  functionally correct (44/45 — see below for the one exception), including
  usage/exit-code correctness. **One known, understood, non-product
  discrepancy**: Rosetta 2 does not expose AVX CPUID flags to translated
  x86-64 processes, regardless of whether the binary is the default or
  `-baseline` Bun target (`bun-darwin-x64-baseline` was independently built
  and shows the identical warning under Rosetta) — Bun's own runtime
  startup prints `warn: CPU lacks AVX support, strange crashes may occur`
  to stderr before any hydra output, which breaks exactly one harness check
  (`unknown-subcommand`'s exact-stderr-prefix match) that assumes hydra's
  own usage banner is the first line. This is a Rosetta *emulation*
  artifact, not a hydra-cli or build-config defect — genuine Intel
  hardware (virtually all Intel Macs since ~2011) exposes AVX natively and
  would not trigger this warning. **`bun-darwin-x64` therefore remains
  formally unverified on real hardware** (no Intel Mac available in this
  environment) — the Rosetta run is strong circumstantial evidence of
  correctness but is not a substitute for real-hardware CI, consistent
  with the plan's existing "smoke each on matching hardware" requirement.
  Follow-up worth considering: switch the `bun-darwin-x64` target to the
  `-baseline` variant in the shipped build matrix regardless, since it
  removes an entire class of "requires AVX" risk on any x86-64 host
  (including older/virtualized ones) at negligible cost for a CLI tool
  that is not numerically performance-sensitive — not yet done, this is a
  recommendation, not a change made here.

Net effect on the plan's Linux deferral: the original scope-cut rationale
("Linux needs sandbox, libc, process, and shell test matrices") has now
been substantively addressed for the process/spawn/libc dimensions that
this migration's own black-box suite covers (ENOENT mapping, cwd
independence, asset embedding, guard neutralization) on both Linux
architectures, via real container execution, not supposition. What is
still NOT covered on Linux: live vendor CLI dispatch (claude/codex/kimi/
opencode binaries are not installed in the test containers), herdr
integration, and any macOS-specific shell/tooling assumptions elsewhere in
the bash fallback lane (which is explicitly out of scope for Linux — the
bash lane remains a frozen macOS-oriented rollback path, not a
cross-platform target).
