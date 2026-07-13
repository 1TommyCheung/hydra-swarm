# hydra-ts — Hydra-Swarm harness (TypeScript)

Migration of the bash harness (`hydra/scripts`, `hydra/adapters`) to TypeScript/Node.
Rationale: the bash harness is invisible to GitNexus/Graphify (no bash parser) and
was the source of every reliability bug in Waves 0–2. TS is what the tooling is
built from — self-analyzable, typed, portable. The bash set stays FROZEN as the
reference until each module is ported + verified through the trust boundary.

Runs with zero build step: `node --experimental-strip-types` (Node ≥ 22.6).
Test: `npm test`. Ported by Hydra itself (Kimi implements, GLM reviews).
