# Bun `process.execPath` self-re-exec spike — results

Ran 2026-07-15, following the spike scope from `docs/bun-migration-plan-review-glm.md`
§5.2 (the single highest-leverage unknown both `docs/bun-migration-plan-codex.md`
and `docs/bun-migration-plan-kimi.md` flagged as load-bearing for the whole
single-binary architecture). Bun `1.3.14`, macOS arm64, Node `v22.14.0` present
for comparison but not used in the spike itself.

## Setup

A trivial `cli.ts` with a `main` path and a `__adapter` subcommand, compiled with:

```
bun build --compile --outfile hydra-spike ./cli.ts
```

The `main` path prints `process.argv`, `process.execPath`, and `import.meta.url`,
then does `spawnSync(process.execPath, ['__adapter', 'stub', 'test'])` and prints
the child's own view of the same three values plus the parent's exit-code/signal
read of the child.

## Results

| Scenario | `process.execPath` | Self-re-exec (`spawnSync`) |
|---|---|---|
| Direct run (`./hydra-spike`) | Real path to the binary | ✅ works, child exits 0 |
| Via symlink (`/tmp/hydra-spike-link`) | Real path to the **target** binary (not the symlink) | ✅ works |
| Copied to a different directory | Real path at the **new** location | ✅ works |
| With `BUN_BE_BUN=1` set | N/A — binary did not run its own entrypoint at all | 🔴 see below |

### ✅ Confirmed: the load-bearing assumption holds

`process.execPath` always resolves to the actual compiled binary's real
filesystem path, in every placement tested. `spawnSync(process.execPath, [...])`
successfully re-invokes the same binary as a child process, and the child
correctly receives its `__adapter` subcommand args. This is the mechanism both
plans' architecture depends on (`dispatch.ts:1206` already defaults
`nodeExecutable` to `process.execPath` today) — it works under a compiled
binary exactly as it works under Node.

### ⚠️ Confirmed risk: `argv[1]` / `import.meta.url` are synthetic, not real paths

Every run showed:

```
"argv": ["bun", "/$bunfs/root/hydra-spike", ...]
"importMetaUrl": "file:///$bunfs/root/hydra-spike"
```

`process.argv[1]` is a virtual in-bundle path (`/$bunfs/...`), not a real
filesystem path — `resolve(process.argv[1])` or walking up from
`import.meta.url` to find sibling files produces nonsense once compiled. This
directly confirms the risk both `bun-plan-codex.md` (§ embedded assets,
8 specific call sites) and the GLM review (§2.5, §4.1) already predicted from
reading the code alone. Every `isMain` guard
(`import.meta.url === pathToFileURL(resolve(process.argv[1])).href`, ~30
occurrences per the GLM review's grep) and every `dirname(fileURLToPath(import.meta.url))`
kit-asset lookup needs to be replaced before compilation — not just verified,
replaced. This is not new information, but it's now empirically confirmed
rather than inferred.

### 🔴 New finding: `BUN_BE_BUN=1` doesn't just risk misbehavior — it fully hijacks the binary

With `BUN_BE_BUN=1` set, `./hydra-spike` does not run the compiled program at
all. It prints Bun's own generic CLI help/usage, as if the binary were the
`bun` executable itself. This is a stronger finding than Codex's plan stated
(Codex flagged it as a risk to mitigate with `env -u BUN_BE_BUN`; the spike
confirms the failure mode is total silent replacement of the program, not
degraded behavior). If this env var were ever present in an operator's shell
profile, CI environment, or inherited from a parent process, the compiled
`hydra` binary would do nothing useful and give no indication why. **Every
spawn and self-re-exec path in the eventual implementation must explicitly
unset `BUN_BE_BUN`** (Codex's mitigation), and this should be treated as a
release-blocking requirement, not an optional hardening step.

### Bonus data (not in the original spike scope, cheap to check)

- **Startup latency**: ~30ms per invocation including the self-spawn (10 runs
  in 0.313s total). Fine for dispatch's short-lived subprocess pattern.
- **Binary size**: 61MB for a near-empty `cli.ts` (the whole Bun runtime is
  embedded). Worth factoring into the distribution story — this is not a
  small download, and multiplies if the plan ends up shipping more than one
  binary.

## What this retires vs. what's still open

**Retired**: the single biggest go/no-go risk from the GLM review (§5.2,
§6) — the self-re-exec architecture works. Nothing in either plan needs a
"plan B" rethink of the core design.

**Still open** (per the GLM review's go/no-go, §6): the 26 `process.execPath`
test-fixture locations across 14 test files, whether the 673-test suite runs
under `bun test`, and the kit-asset-embedding design for the ~8 call sites
that resolve paths from `import.meta.url` — none of those were in this
spike's scope and none are answered by it. The GLM review's recommendation
stands: do a Stage 0 implementation behind `HYDRA_HARNESS=bin` covering only
the stub adapter and read-only subcommands before touching real vendor
adapters, and do not flip the default until the test suite has a passing
Bun-compiled lane.
