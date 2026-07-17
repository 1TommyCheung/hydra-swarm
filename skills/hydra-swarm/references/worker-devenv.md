# Worker development environment

Field evidence (run ws9-import-plan, 2026-07-17): every worker-environment restriction so far has been discovered MID-TASK — registry/git-host 403s, a vendor CLI missing from the pane PATH, pnpm's in-worktree store tripping srt's mandatory `.git/config`+`.git/hooks` deny, the global pnpm store DB unopenable under confinement, node_modules symlink workarounds then tripping `promote.sh`'s ownership audit. Each one wasted worker cycles and needed lead intervention to hand-fix.

`prepareWorkerEnv()` in `kit/hydra-ts/src/worker-devenv.ts` closes that gap: it runs BEFORE a write-role worker spawns and guarantees three things up front instead of leaving them to be discovered by failure.

## What the dispatcher now guarantees

- **Network domains.** The worktree's own manifests (lockfiles, `package.json` git-hosted deps, bun/yarn config) are inspected and their well-known registry/git-hosting hosts are added to the sandbox allowlist automatically, merged with the operator's baseline and the task spec's `network_domains`.
- **Package-manager store/cache paths.** `npm_config_store_dir`, `npm_config_cache`, `BUN_INSTALL_CACHE_DIR`, and `YARN_CACHE_FOLDER` are all pointed at per-task directories under `TMPDIR`, namespaced by `agent_run_id`. This keeps every package manager's store (and any ephemeral git clones it creates while resolving git-hosted deps) outside the worktree and outside any `.git`-adjacent path, so it never trips srt's mandatory git-metadata deny or the ownership audit.
- **Reads vs writes.** srt's settings schema (`makeSrtSettings` in `adapter-kimi.ts`) has no `allowRead` allowlist — only `allowWrite`/`denyWrite`/`denyRead`. Reads are permitted everywhere by default; only writes are confined to the allowlisted roots. The corepack shim cache (`~/.cache/node/corepack`) does not need to be added anywhere for a worker to read cached shims from it — it would only need `allowWrite` if a task needed to populate/update that cache mid-run, which is out of scope for the default preflight.
- **Toolchain preflight.** Before spawn, `git`, `node`, and the repo's declared package manager (read from `package.json`'s corepack-style `packageManager` field, corepack shim accepted) plus the assigned vendor's own CLI binary are resolved against the SAME `PATH` the pane shell will get. A missing tool is a hard, fail-fast dispatch error with the exact remedy — an `ln -sf <found path> ~/.local/bin/<name>` command when the binary is discoverable in a common install root (`~/.opencode/bin`, `~/.kimi-code/bin`, `~/.npm-global/bin`, `~/.bun/bin`), or an explicit "not found anywhere checked" otherwise. This mirrors `/hydra-doctor`'s tone: name the fix, don't just report the failure.

## What a task spec should still declare

`network_domains` in the task spec remains the escape hatch for anything the manifest-derivation can't infer — an internal/exotic registry, a non-GitHub git host, an API the worker's own code needs to call at runtime that has nothing to do with its build toolchain. The preflight's manifest derivation only ever adds hosts from a small fixed allowlist of well-known package-registry/source-hosting domains; it does not read arbitrary URLs out of file contents.

## When a mid-task environment failure still happens

Treat it as a **preflight gap**, not something to work around by hand. Do not:

- hand-edit the sandbox baseline domains file to add a host mid-run;
- symlink a missing vendor/toolchain binary into a worker's writable path as a one-off fix;
- let a worker fall back to an in-worktree package-manager store to dodge a confinement error;
- symlink `node_modules` (or anything else) across writable-path boundaries to route around an ownership-audit rejection.

Any of those is a signal that `prepareWorkerEnv()` (or the task spec's `network_domains`) is missing a case. File it as a preflight gap — extend the derivation/verification logic or the task spec, so the next dispatch to a similar repo/task shape doesn't hit the same restriction mid-task.
