# hydra-ts — Hydra-Swarm harness (TypeScript)

TypeScript/Node implementation of the Hydra-Swarm harness — the only source
runtime. The Bash lane (`hydra/scripts` Bash bodies, `hydra/adapters/*.sh`) was
retired in run 0045 (`../../docs/bash-lane-retirement-plan.md`): the
`hydra/scripts/*.sh` entry points are small launchers that exec this
implementation by default (`ts`), and `HYDRA_HARNESS=bash` /
`HYDRA_ADAPTER_RUNTIME=bash` fail loudly rather than coercing to `ts`.

The independent no-Node rollback is a pinned `bun build --compile` binary
selected with `HYDRA_HARNESS=bin` and `HYDRA_BIN`; the retained known-good
artifact is `~/.local/share/hydra-pinned-binaries/v1/hydra-cli-v1-darwin-arm64`.
Rebuild from source with `npm run build:bin` (requires `bun`).

Runs with zero build step: `node --experimental-strip-types` (Node ≥ 22.6).
Test: `npm test`. Ported by Hydra itself (Kimi implements, GLM reviews).
