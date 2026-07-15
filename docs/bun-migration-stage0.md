# Bun migration — Stage 0 (spike router)

Stage 0 delivers a minimal compiled binary that proves the load-bearing
self-re-exec assumption from `docs/bun-migration-plan-codex.md` and
`docs/bun-migration-spike-results.md` without changing any operator-facing
workflow.

## What was added

- `kit/hydra-ts/src/bin-cli.ts` — a tiny standalone router with two commands:
  - `status` — prints a fixed JSON status object and, via a real self-spawn,
    includes a `selfReexecCheck` object proving the compiled binary can
    re-execute itself.
  - `__adapter stub <verb> [args...]` — a stub adapter that prints its own
    `process.argv`, `process.execPath`, and `import.meta.url`.
- `npm run build:bin` in `kit/hydra-ts/package.json` — compiles the router with
  `bun build --compile --outfile dist/hydra-bin-stage0 src/bin-cli.ts`.
- `kit/hydra-ts/.gitignore` — ignores `dist/` so build artifacts are never
  committed.
- `kit/hydra-ts/test/bin-cli.test.ts` — real-subprocess tests that compile the
  binary and verify `status`, self-re-exec, relocation, and unknown-subcommand
  behavior. The file skips cleanly with a console message when Bun is not on
  `PATH`.

## Build and run locally

1. Install Bun separately (it is intentionally not an npm dependency).
2. In `kit/hydra-ts`:
   ```bash
   npm run build:bin
   ./dist/hydra-bin-stage0 status
   ```
3. Observe JSON output with `ok: true`, `runtime: "bun-cli-stage0"`, and a
   populated `selfReexecCheck` object.

## Operator impact

- `HYDRA_HARNESS` and the existing shell wrappers are **untouched**.
- The default remains TypeScript (`HYDRA_HARNESS=ts` or unset).
- No production vendor dispatch uses the binary.
- The existing `npm test` / `test:concurrent` / `test:promote` scripts and their
  behavior are unchanged.

## Stage 1 next

Stage 0 only settles the compiled-runtime mechanics. Stage 1 (see
`docs/bun-migration-plan-codex.md` § "Stage 1 — explicit opt-in") will add the
three-state `HYDRA_HARNESS=bin` preamble, wire production subcommands through the
router, and introduce the adapter registry so real vendor dispatch can opt in.
