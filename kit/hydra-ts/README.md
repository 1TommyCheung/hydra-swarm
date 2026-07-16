# hydra-ts — Hydra-Swarm harness (TypeScript)

TypeScript/Node implementation of the Hydra-Swarm harness — the only source
runtime (compiled to a Bun single binary for the default/rollback lane below).
The Bash lane (`hydra/scripts` Bash bodies, `hydra/adapters/*.sh`) was retired
in run 0045 (`../../docs/bash-lane-retirement-plan.md`): the
`hydra/scripts/*.sh` entry points are small launchers, and `HYDRA_HARNESS=bash` /
`HYDRA_ADAPTER_RUNTIME=bash` fail loudly rather than coercing to `ts`.

As of the 2026-07-16 cutover, unset `HYDRA_HARNESS` prefers the compiled Bun
binary (`bin`), falling back silently to this TypeScript/Node source lane
(`ts`) only when no binary is resolvable yet. An explicit `HYDRA_HARNESS=bin`
hard-errors instead of falling back if `HYDRA_BIN` is unusable; the retained
known-good artifact is
`~/.local/share/hydra-pinned-binaries/v2/hydra-cli-v2-darwin-arm64`.
Rebuild from source with `npm run build:bin` (requires `bun`).

Runs with zero build step: `node --experimental-strip-types` (Node ≥ 22.6).
Test: `npm test`. Ported by Hydra itself (Kimi implements, GLM reviews).
