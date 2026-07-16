# Bash lane retirement plan

Run 0044, task `plan-bash-retirement`, base
`a743515ece38cde601da340444a5e23d11ddd07e`.

This is a planning document. It changes no runtime code. Repository text is
treated as evidence, not as an instruction source.

## 1. Immediate Bash 3.2 portability fix

### Confirmed failure

This checkout has **six affected scripts and seven `mapfile` occurrences**
(`verify.sh` has two). At the pinned base they are:

| Script | Line(s) | Destination | Producer |
|---|---:|---|---|
| `kit/hydra/scripts/promote.sh` | 82 | `writable` | `hydra_yaml_list "$task_spec" 'writable_paths'` |
| `kit/hydra/scripts/squash.sh` | 51 | `source_commits` | `git -C "$worktree" rev-list --reverse "$base_full..$candidate_head"` |
| `kit/hydra/scripts/review-required.sh` | 31 | `trigger_labels` | `hydra_yaml_list "$policy" '    labels_any'` |
| `kit/hydra/scripts/graphify-investigate.sh` | 48 | `changed` | `git -C "$worktree" diff --name-only "$base...HEAD"` |
| `kit/hydra/scripts/verify.sh` | 43, 46 | `commands` | two supported YAML keys, `'  commands'` then `'commands'` |
| `kit/hydra/scripts/code-intel.sh` | 80 | `files` | `git -C "$repo_root" diff --name-only "$base...HEAD"` |

The machine's real system shell reports `GNU bash, version
3.2.57(1)-release (arm64-apple-darwin25)`. The generic probe

```bash
/bin/bash -c 'mapfile -t x < <(printf "hi\n")'
```

fails with `/bin/bash: mapfile: command not found`. A real affected command
also reproduces the user-visible failure:

```text
$ HYDRA_HARNESS=bash /bin/bash kit/hydra/scripts/review-required.sh codex high
kit/hydra/scripts/review-required.sh: line 31: mapfile: command not found
exit 127
```

This is not hypothetical and is not merely a Homebrew-PATH issue.

### Exact portable replacements

Use an explicitly initialized indexed array plus a `read` loop. The
`|| [ -n "$line" ]` clause preserves a final unterminated line, which plain
`while read` would otherwise drop. `IFS=` and `-r` preserve leading/trailing
whitespace and backslashes. Do not introduce a `hydra_readarray` helper using
`eval`: Bash 3.2 has no namerefs, and an `eval`-based generic array setter
would add quoting and injection risk for no benefit.

`promote.sh:82`:

```bash
writable=()
while IFS= read -r line || [ -n "$line" ]; do
  writable+=("$line")
done < <(hydra_yaml_list "$task_spec" 'writable_paths')
```

`squash.sh:51`:

```bash
source_commits=()
while IFS= read -r line || [ -n "$line" ]; do
  source_commits+=("$line")
done < <(git -C "$worktree" rev-list --reverse "$base_full..$candidate_head")
```

`review-required.sh:31`:

```bash
trigger_labels=()
while IFS= read -r line || [ -n "$line" ]; do
  trigger_labels+=("$line")
done < <(hydra_yaml_list "$policy" '    labels_any')
```

`graphify-investigate.sh:48` (keep this inside the existing non-`--files`
branch):

```bash
changed=()
while IFS= read -r line || [ -n "$line" ]; do
  changed+=("$line")
done < <(git -C "$worktree" diff --name-only "$base...HEAD" 2>/dev/null)
```

`verify.sh:43-47` must reset `commands` before the fallback read, because the
second `mapfile -t commands` currently replaces rather than appends:

```bash
commands=()
while IFS= read -r line || [ -n "$line" ]; do
  commands+=("$line")
done < <(hydra_yaml_list "$policy" '  commands')
if [ "${#commands[@]}" -eq 0 ]; then
  commands=()
  while IFS= read -r line || [ -n "$line" ]; do
    commands+=("$line")
  done < <(hydra_yaml_list "$policy" 'commands')
fi
```

`code-intel.sh:80`:

```bash
files=()
while IFS= read -r line || [ -n "$line" ]; do
  files+=("$line")
done < <(git -C "$repo_root" diff --name-only "$base...HEAD" 2>/dev/null)
```

The pattern was executed by the real `/bin/bash` 3.2 with `set -euo
pipefail`. It collected five values while preserving an internal space, two
leading spaces, a backslash, and an unterminated last line; it also produced
an empty array for empty input. Separate real-producer probes collected
`writable_paths` from this run's `.hydra-task.yaml` and two commits from
`git rev-list`. All assertions passed.

### No runtime Bash-version guard

Do **not** add a Bash 4 guard to `lib.sh`: that would turn the stock-macOS bug
into an intentional stock-macOS exclusion and defeat the fix. A `>=3.2`
guard would pass immediately before a future `mapfile` failed, so it would
not provide the proposed defense-in-depth either. Parse-time Bash 4-only
syntax can also fail before any sourced guard executes.

The effective defense is executable compatibility coverage: run the affected
paths with a real Bash 3.2 and add a static regression assertion that
`mapfile`, `readarray`, associative arrays, and other deliberately unsupported
Bash 4-only constructs are absent. A runtime guard should be added only if the
project consciously raises its minimum shell version; it must not be used as
a substitute for compatibility testing.

This hotfix should be the first, independently cherry-pickable commit of the
implementation work. If retirement is delayed by any release gate below, the
hotfix still lands.

## 2. Evidence and recommendation

### What actually depends on the Bash lane

The requested repository-wide search over `docs/`, `kit/`, and `.claude/`
found exactly **61 files** containing `HYDRA_HARNESS`, matching the prior
estimate. `.claude/` itself is absent at this commit, so all 61 are under
`docs/` and `kit/`:

| Category | Files | Meaning |
|---|---:|---|
| Current and historical docs | 25 | Six current operator/design documents plus 19 migration plans, stage reports, and reviews. Most are evidence about the switch, not runtime consumers. |
| Shell wrappers | 28 | The load-bearing three-state preamble in every public `.sh` entrypoint. |
| Shared shell library | 1 | Node resolver workaround text and compiled-binary resolution/fallback. |
| TypeScript source | 4 | `dispatch.ts` has the load-bearing adapter-runtime selection; `bin-cli.ts`, `cli.ts`, and `graph-impact.ts` references are comments/history. |
| TypeScript tests | 3 | Bash-mode status/cancel integration tests and dispatch runtime-selection/compiled tests. |

The six current documents are `docs/README.md`, `docs/operations.md`,
`docs/roadmap.md`, `docs/state-and-worktrees.md`, `docs/vendor-adapters.md`,
and `docs/async-trigger-design-kimi.md`. The remaining 19 are historical
migration or review evidence and do not make the Bash implementation
operationally necessary.

The genuinely load-bearing assumptions are therefore narrow:

1. the 28 wrapper preambles fall through into their Bash bodies for the exact
   value `HYDRA_HARNESS=bash`;
2. `dispatch.ts` can select the shell adapters through either
   `HYDRA_HARNESS=bash` or `HYDRA_ADAPTER_RUNTIME=bash`;
3. current runbooks tell operators to select Bash when Node resolution fails;
4. two test files intentionally exercise the Bash implementations of status
   and cancellation.

Those are replaceable routing, documentation, and test assumptions. No data
format, authoritative-state schema, or external protocol requires a Bash
implementation.

The repository contains **no documented incident in which Bash actually
recovered an operation from a TypeScript or compiled-binary failure after the
2026-07-13 cutover**. `docs/operations.md` records a real stale-Node PATH
condition and suggests Bash as a temporary workaround, but does not record an
occasion where the workaround was used. The migration reports use Bash for
A/B checks; that is verification, not incident recovery. The only recorded
stock-macOS Bash execution of one of the affected commands is adverse:
Stage 2 explicitly records `review-required` failing 127 because Bash 3.2 has
no `mapfile`.

### Actual verification posture

The Bash lane does not have literally zero automated coverage, but it is
close to zero relative to its size:

- `kit/hydra-ts/test/status.sh.test.ts` has six Bash-mode cases.
- `kit/hydra-ts/test/cancel-task.sh.test.ts` has seven Bash-mode cases.
- `dispatch.test.ts` tests selection of the shell adapter runtime, but mostly
  through injected processes; it is not a suite for all shell adapters.
- The other **26 of 28 wrappers**, including all six scripts with `mapfile`,
  have no automated Bash-body suite.
- There are no `.bats` files, no CI configuration in this checkout, and no
  command that runs ShellCheck. `# shellcheck source=...` comments are editor
  metadata, not an executed check.
- Stage reports repeatedly use manual `bash -n`, spot comparisons, and
  one-off probes. `bash -n` currently passes all 29 files but cannot detect a
  missing runtime builtin.

The shell implementation consists of 29 files / **3,776 physical lines**
(28 wrapper files / 3,262 lines plus `lib.sh` / 514 lines). The six shell
adapters add 621 lines, for **4,397 shell lines** in the complete fallback
path. Thirteen focused cases do not make that a trustworthy emergency copy.
The `mapfile` defect is direct evidence of silent rot: a lane described as a
macOS rollback was known to fail on the system Bash during the later
three-state migration and remained unfixed.

### Mirroring and drift

All 28 wrapper basenames have a `kit/hydra-ts/src/<name>.ts` counterpart.
All five vendor shell adapters and `build-worker-prompt.sh` also have
TypeScript counterparts. There is no shell-only public capability that must
be preserved.

They are not faithful 1:1 implementations today:

- Bash `status.sh` emits raw CLI JSONL lines while TypeScript parses
  Codex/Kimi events into human-readable `progress_tail` values.
- The loop-thinking detector and `loop_suspicion` status field are
  TypeScript-only; the repository's current packaged skill explicitly
  acknowledges this exception.
- `promote`'s no-argument/internal-error path exits 1 in Bash and 2 in
  TypeScript, a pre-existing divergence recorded by Stage 2.
- The seven `mapfile` occurrences make six commands fail on stock macOS.
- Stage 2 and Stage 4 added explicit environment/spawn hardening to the
  TypeScript adapters. The shell adapter directory has no `BUN_BE_BUN`
  stripping at all, so it does not mirror that boundary hardening for a
  Bun-compiled vendor CLI.
- The Stage 4 audit established that the Bash bodies were not byte-identical
  to the original freeze point: unrelated but legitimate pane-default and
  repository-error fixes had landed. The follow-up redefined "frozen" to
  mean untouched by the Bun migration, not immutable.

The TypeScript lane has therefore accumulated behavior and security fixes
that the shell lane does not uniformly carry. Keeping the latter as a frozen
oracle is now a misleading safety claim.

### Options evaluated

#### A. Full retirement; compiled binary becomes the independent rollback

This is the strongest option. The compiled artifact is independent of an
installed Node or Bun runtime. `HYDRA_BIN` already accepts a pinned absolute,
regular executable, and Stage 4 hardened its resolution. The black-box suite
exercised all 34 routes, embedded assets, checkout-free behavior, guard
neutralization, and ENOENT handling: 45/45 on native macOS arm64 and 44/44 in
real Linux x64 and arm64 containers (source-route drift is the one check
skipped in binary-only containers). The independently re-run Stage 4 suite
also exercised compiled dispatch through the stub adapter and reported 847
test executions with zero failures.

That is materially better rollback evidence than 4,397 mostly untested shell
lines. A retained previous known-good binary selected through a pinned
`HYDRA_BIN` is the correct independent rollback.

#### B. Partial retirement; retain only trust-boundary shell commands

Reject this option. The natural candidate, `promote.sh`, is both one of the
untested `mapfile` failures and not actually Node-independent: it invokes
`node jsonschema.mjs`. `record-review.sh` also invokes Node. Retaining the
least-tested implementation of the most security-sensitive operation would
increase assurance theater, not assurance. The TypeScript promotion path has
the dedicated 27-test lane and is included in compiled routing.

#### C. Keep everything, apply only the portability fix, and defer again

Reject this option. It fixes today's visible symptom but leaves the coverage
gap, known semantic drift, duplicate maintenance, and false rollback
confidence intact. There is also no evidence that the fallback recovered a
real post-cutover incident. A time-based trigger such as another 90 days
would not answer any open technical question that the Stage 3/4 evidence has
not already answered.

### Recommendation

**Fully retire the Bash implementation lane now.** Preserve the 28 `.sh`
filenames as stable, very small launchers for `ts` and `bin`; remove their
Bash implementation bodies and remove the six shell adapters. Preserve the
historical migration documents as audit evidence. Make a pinned previous
compiled binary the no-Node rollback path.

This recommendation is not a recommendation to make the binary the default
in the same change: unset/`ts` can remain the source default. It is a
recommendation that `bash` cease to be an executable implementation choice.
Before deleting the bodies, the lead must close the artifact-provisioning
gate described in section 4; if that gate slips, land the Bash 3.2 hotfix and
stop there rather than pretending an unavailable binary is a rollback.

## 3. Executable implementation plan — exactly two parallel lanes

The lead first publishes or installs one retained, checksummed previous
known-good binary per supported target and records its absolute path. After
that single shared precondition, the following two lanes can run in parallel.
They have disjoint file ownership.

### Lane 1 — Kimi: Bash 3.2 hotfix, then launcher-only shell surface

**Objective.** Produce an independently cherry-pickable Bash 3.2 hotfix,
then reduce the public shell command surface to strict `ts`/`bin` launchers
with no Bash implementation bodies.

**Exclusive writable files.** All and only these 29 files:

```text
kit/hydra/scripts/aggregate-usage.sh
kit/hydra/scripts/allocate.sh
kit/hydra/scripts/amend-task.sh
kit/hydra/scripts/audit-ownership.sh
kit/hydra/scripts/cancel-task.sh
kit/hydra/scripts/code-intel.sh
kit/hydra/scripts/create-worktree.sh
kit/hydra/scripts/dispatch.sh
kit/hydra/scripts/freshness-gate.sh
kit/hydra/scripts/graph-impact.sh
kit/hydra/scripts/graphify-baseline.sh
kit/hydra/scripts/graphify-investigate.sh
kit/hydra/scripts/graphify-repo.sh
kit/hydra/scripts/herdr-push.sh
kit/hydra/scripts/index-candidate.sh
kit/hydra/scripts/integrate.sh
kit/hydra/scripts/ledger-view.sh
kit/hydra/scripts/lib.sh
kit/hydra/scripts/measure-divergence.sh
kit/hydra/scripts/otel-env.sh
kit/hydra/scripts/promote.sh
kit/hydra/scripts/record-review.sh
kit/hydra/scripts/record-usage.sh
kit/hydra/scripts/review-dispatch.sh
kit/hydra/scripts/review-required.sh
kit/hydra/scripts/run-init.sh
kit/hydra/scripts/squash.sh
kit/hydra/scripts/status.sh
kit/hydra/scripts/verify.sh
```

**Work.**

1. Commit the seven exact replacements from section 1 as a standalone
   compatibility commit. Run them with `/bin/bash` 3.2. The lead may land
   this commit even if the retirement release gate stops later work.
2. Refactor `lib.sh` to a small shared launcher API retaining only logging,
   strict `HYDRA_HARNESS` validation, `hydra_resolve_node`, and the hardened
   absolute-file `hydra_resolve_bin` logic.
3. Keep all 28 wrapper filenames and their basename-to-subcommand mapping.
   Replace everything after the common preamble with one call to the shared
   launcher. There must be no authoritative-state or vendor logic left in a
   wrapper.
4. Runtime contract:
   - unset or `ts`: resolve Node >=22.6 and execute
     `src/cli.ts <basename> "$@"`;
   - `bin`: require an absolute, regular, executable `HYDRA_BIN` (or the
     documented installed default) and execute it through
     `env -u BUN_BE_BUN`; an unusable explicitly requested binary is a hard
     error, **not** a silent fallback to `ts`;
   - `bash`: exit 2 with
     `HYDRA_HARNESS=bash was retired; use HYDRA_HARNESS=bin with a pinned HYDRA_BIN, or use ts`;
   - any other value: exit 2 and list exactly `ts` and `bin` as accepted
     values.

**Acceptance criteria.**

- The hotfix commit passes the seven Bash 3.2 producer/collector cases.
- The final tree keeps all 29 listed files; no `kit/hydra/scripts/*.sh` file
  is deleted.
- Exactly 28 wrapper basenames map 1:1 to the 28 `cli.ts` public wrapper
  routes; `lib.sh` is not a route.
- `rg -n '\b(mapfile|readarray)\b' kit/hydra/scripts` returns no matches.
- `HYDRA_HARNESS=bash` and an unknown value fail before Node or the binary is
  invoked. `HYDRA_HARNESS=bin` with a bad path fails before Node is invoked.
- A fake pinned executable observes the right subcommand and all original
  arguments for every wrapper, and observes no `BUN_BE_BUN`.
- The default/`ts` route remains byte-identical in argv to the current route.

**Verification commands.**

```bash
/bin/bash --version
/bin/bash -n kit/hydra/scripts/*.sh
rg -n '\b(mapfile|readarray|declare[[:space:]]+-A)\b' kit/hydra/scripts
for f in kit/hydra/scripts/*.sh; do
  [ "$(basename "$f")" = lib.sh ] || HYDRA_HARNESS=bash /bin/bash "$f" 2>&1 | grep -F 'HYDRA_HARNESS=bash was retired'
done
HYDRA_HARNESS=bin HYDRA_BIN=/definitely/missing /bin/bash kit/hydra/scripts/status.sh x y
```

Also run a generated fake-binary matrix for all 28 wrappers; assert command,
argv, exit status, and `BUN_BE_BUN` absence rather than merely checking
stdout by eye.

### Lane 2 — OpenCode/GLM: remove shell adapters and update runtime/tests/docs

**Objective.** Remove the adapter half of the Bash lane, make retired values
fail explicitly in TypeScript, replace Bash-body tests with launcher/runtime
contract tests, and update current documentation without rewriting historical
migration evidence.

**Exclusive writable files.** This lane owns `kit/hydra/adapters/**`,
`kit/hydra-ts/src/**`, `kit/hydra-ts/test/**`,
`kit/hydra-ts/package.json`, `kit/hydra-ts/README.md`,
`kit/hydra/README.md`, the current docs listed below, and
`skills/hydra-swarm/**`. It must not touch any `kit/hydra/scripts/*.sh` file.

**Files deleted (exact).**

```text
kit/hydra/adapters/build-worker-prompt.sh
kit/hydra/adapters/claude.sh
kit/hydra/adapters/codex.sh
kit/hydra/adapters/kimi.sh
kit/hydra/adapters/opencode.sh
kit/hydra/adapters/stub.sh
skills/hydra-swarm/references/ts-bash-switch.md
```

Add `skills/hydra-swarm/references/runtime-selection.md` as the replacement
for the deleted switch reference.

**Current documentation updated (exact).**

```text
docs/README.md
docs/async-trigger-design-kimi.md
docs/operations.md
docs/roadmap.md
docs/state-and-worktrees.md
docs/vendor-adapters.md
kit/hydra/README.md
kit/hydra-ts/README.md
skills/hydra-swarm/SKILL.md
skills/hydra-swarm/references/background-dispatch.md
skills/hydra-swarm/references/runtime-selection.md
```

Do not rewrite the 19 historical `HYDRA_HARNESS` documents. They describe
past designs, tests, and failures and remain useful audit evidence. Where a
reader could mistake one for a current runbook, add one retirement notice at
the current documentation entrypoint rather than altering historical claims.

**Runtime and test work.**

1. In `dispatch.ts`, remove `'bash'` from `AdapterRuntime`, the shell adapter
   path resolution/probe, shell resume detection, and shell spawn branches.
   `HYDRA_ADAPTER_RUNTIME=bash` must fail with a retirement error; it must not
   coerce to `ts`. Preserve `ts` and compiled self-reexec behavior.
2. Remove obsolete source comments that claim an executable Bash fallback
   from `cli.ts`, `bin-cli.ts`, and `graph-impact.ts`. Historical "ported
   from" provenance comments in adapter modules may remain.
3. Rewrite `status.sh.test.ts` and `cancel-task.sh.test.ts` as stable-wrapper
   selection tests, or consolidate them into a new wrapper-runtime suite.
   Do not delete wrapper coverage entirely. Cover retired-value failure,
   strict unknown-value failure, default/`ts` argv, pinned-bin argv,
   `BUN_BE_BUN` removal, and no silent fallback.
4. Convert `e2e.full-loop.test.ts` from the real shell stub adapter to the
   real TypeScript adapter-stub path. Remove/update every dispatch test that
   injects `adapterRuntime: 'bash'` or `HYDRA_ADAPTER_RUNTIME=bash`.
5. Tests whose fixture data merely names a historical shell file may keep
   that string if the test is explicitly about parsing arbitrary paths.
   Tests that execute or read one of the six deleted files must be converted
   to the TypeScript counterpart. In particular, audit
   `adapter-claude.test.ts`, `adapter-codex.test.ts`,
   `build-worker-prompt.test.ts`, and `e2e.full-loop.test.ts`.
6. Update the package descriptions and current runbooks: `bin` is the
   independent rollback, `ts` remains default, `HYDRA_HARNESS=bash` and
   `HYDRA_ADAPTER_RUNTIME=bash` are retired errors, and a pinned prior
   `HYDRA_BIN` is the recovery procedure.

**Acceptance criteria.**

- All seven files in the deletion list are absent and the new runtime
  selection reference is linked from the skill.
- `rg -n 'HYDRA_(HARNESS|ADAPTER_RUNTIME)=bash'` matches only historical
  documents, explicit rejection tests/messages, and this plan.
- No production TypeScript branch selects or spawns a shell adapter.
- Both retired values fail loudly; neither silently selects `ts`.
- TypeScript and compiled adapter-stub dispatch both pass end to end.
- The current docs describe a pinned compiled binary as the independent
  rollback and give an exact recovery command.
- The full TypeScript suite and compiled black-box suite pass, with no
  skipped compiled-dispatch fixture when Bun is available.

**Verification commands.**

```bash
test ! -e kit/hydra/adapters/build-worker-prompt.sh
test ! -e kit/hydra/adapters/claude.sh
test ! -e kit/hydra/adapters/codex.sh
test ! -e kit/hydra/adapters/kimi.sh
test ! -e kit/hydra/adapters/opencode.sh
test ! -e kit/hydra/adapters/stub.sh
rg -n "adapterRuntime: 'bash'|HYDRA_ADAPTER_RUNTIME.?[:=].?['\"]?bash" kit/hydra-ts/src kit/hydra-ts/test
cd kit/hydra-ts
npm run typecheck
npm run test:concurrent
npm run test:promote
npm run build:bin
HYDRA_COMPILED_BINARY="$PWD/dist/hydra-cli" npm run test:concurrent
npm run test:blackbox -- "$PWD/dist/hydra-cli"
```

After both lanes integrate, run the Lane 1 fake-binary wrapper matrix against
the real compiled artifact and then run one real stub dispatch through a
wrapper, not only by invoking `dist/hydra-cli` directly.

## 4. Unverified claims and lead closure gates

The recommendation is explicit, but deletion must not outrun these facts:

1. **The specified protocol skill is unavailable.**
   `.claude/skills/hydra-protocol/SKILL.md` does not exist at the pinned base,
   in any local ref, or as a recoverable object found by `git rev-list
   --all --objects`. The checkout instead contains
   `skills/hydra-swarm/SKILL.md`, which says TypeScript is default, Bash is a
   debugging/workaround path, and the loop detector/status field is
   TypeScript-only. Before implementation, the lead must identify the
   canonical distributed skill source, read the missing `.claude` version in
   full if it exists elsewhere, and apply the same retirement wording to the
   package/install source that users actually receive.
2. **Repository evidence cannot rule out an off-repo recovery incident.** No
   incident is documented here. The lead must search the operational log,
   issue tracker, and release notes outside this checkout for any post-cutover
   use of `HYDRA_HARNESS=bash`. If one exists, add its exact failure mode as a
   compiled-binary rollback acceptance case; do not retain the whole Bash
   lane by default.
3. **Pinned artifact installation is still open.** Stage 3 explicitly says
   the atomic versioned install/update mechanism was not defined. Before body
   removal, publish/install a previous known-good binary for each supported
   target, retain its manifest and SHA-256, and prove
   `HYDRA_HARNESS=bin HYDRA_BIN=/absolute/versioned/path` works with Node and
   Bun absent from `PATH`. An explicitly selected but unavailable binary must
   fail loudly, not fall through to `ts`.
4. **macOS x64 is not proven on physical Intel hardware.** Rosetta produced
   44/45 because Bun emitted an AVX warning before Hydra output; functional
   routing otherwise passed. Run the black-box suite on a real Intel Mac or
   formally drop that target before claiming complete macOS coverage.
5. **Live external integrations are not covered by the black-box matrix.**
   Linux runs did not install real Claude, Codex, Kimi, OpenCode, Herdr, or
   `srt`; Stage 4 did prove compiled stub dispatch and unit-level Herdr
   command construction. Before declaring Bash adapters removable in a
   production release, run at least one controlled installed-vendor dispatch
   and one Herdr-hosted compiled dispatch on native macOS and Linux, with no
   credentials exposed to logs.
6. **Type checking was unavailable in the migration reports and in this
   planning task's environment.** `node` on the current PATH is v17.4.0 and
   `node_modules`/`tsc` are not provisioned here. Lane 2 must run
   `npm run typecheck` under the supported toolchain before integration.
7. **GitNexus graph data was unavailable in this session.** Direct search,
   source inspection, tests, history, and documented black-box evidence were
   used instead. This is not a blocker, but the lead may run a fresh GitNexus
   impact query over the deletion set as an additional cross-check.

If gates 1, 3, and 5 cannot be closed in the retirement release, land only
the standalone Bash 3.2 hotfix and keep this full-retirement plan queued with
those named blockers. Do not replace them with a time-only deferral.
