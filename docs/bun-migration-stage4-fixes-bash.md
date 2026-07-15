# Bun migration Stage 4 fixes: Bash wrapper lane

Run 0042, task `fix-bash-wrapper-hijack`, base `446a3f4`. Addresses the
bash-lane findings of the run-0041 adversarial review
(`docs/bun-migration-stage4-review-bash-build.md`, verdict: reject):

- Finding 1 (BLOCKER): every `bin`-mode wrapper inherits `BUN_BE_BUN` — fixed.
- Finding 5 (MEDIUM): `hydra_resolve_bin()` accepts directories and relative
  paths — fixed.
- Finding 6 (MEDIUM): frozen bash lane not byte-identical to `f34de42` —
  resolved as a documentation clarification (no code revert; rationale below).

Findings 2, 3, and 4 of the same review live in `kit/hydra-ts/scripts/`
(TypeScript build/blackbox tooling) and are out of scope for this task's
writable paths; they are not touched here.

## Finding 1: `BUN_BE_BUN` stripped at every bin-mode exec line

### Root cause

Bun reads `BUN_BE_BUN` from its own process environment before the bundled
program starts, so nothing inside `src/cli.ts` can unset it after the fact.
Every wrapper's bin-mode exec line was plain
`exec "$HYDRA_BIN_PATH" <name> "$@"`, so an inherited `BUN_BE_BUN=1` diverted
the compiled binary into Bun's own CLI. The accepted plan
(`docs/bun-migration-plan-codex.md`) already specified the fix shape:
`exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" <name> "$@"`. The strip must happen
at the exec call itself, in bash, before the compiled binary starts. The
`ts`-mode exec line (`exec "$HYDRA_NODE" --experimental-strip-types
.../cli.ts <name> "$@"`) does not need the fix: Node is never susceptible to
the `BUN_BE_BUN` hijack.

### Reproduced before the fix (Bun 1.3.14, real compiled binary at
`/tmp/hydra-review-0041-cli`, 63,759,842-byte arm64 Mach-O — the same
artifact the reviewer built)

```text
$ HYDRA_HARNESS=bin HYDRA_BIN=/tmp/hydra-review-0041-cli \
    bash kit/hydra/scripts/status.sh review-missing task
hydra: error: instantiated task spec not found: .../run-review-missing/tasks/task.yaml
exit=1                                     # control: reaches Hydra

$ BUN_BE_BUN=1 HYDRA_HARNESS=bin HYDRA_BIN=/tmp/hydra-review-0041-cli \
    bash kit/hydra/scripts/status.sh review-missing task
error: Script not found "status"
exit=1                                     # HIJACK: Bun CLI mode, Hydra never runs
```

### Transformation (applied mechanically to all 28 wrappers)

Exactly as the original Stage 2 preamble task did, a small guarded script
applied the edit rather than 28 hand edits. Full logic:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for f in kit/hydra/scripts/*.sh; do
  [ "$f" = "kit/hydra/scripts/lib.sh" ] && continue
  # guard: exactly one bin-mode exec line, not already stripped
  [ "$(grep -c 'exec "\$HYDRA_BIN_PATH"' "$f")" -eq 1 ] || exit 1
  ! grep -q 'env -u BUN_BE_BUN' "$f" || exit 1
  sed -i '' 's|exec "\$HYDRA_BIN_PATH"|exec env -u BUN_BE_BUN "\$HYDRA_BIN_PATH"|' "$f"
  # guard: transform landed exactly once and file still parses
  [ "$(grep -c 'exec env -u BUN_BE_BUN "\$HYDRA_BIN_PATH"' "$f")" -eq 1 ] || exit 1
  bash -n "$f" || exit 1
done
```

Result: `28 files changed, 28 insertions(+), 28 deletions(-)` — one line per
wrapper, the ts-mode line untouched in every file.

### Verified individually after the fix

Every one of the 28 wrappers' bin-mode exec lines now reads
`exec env -u BUN_BE_BUN "$HYDRA_BIN_PATH" <name> "$@"`
(grep-verified one by one, `<name>` equals the wrapper basename in each):

- `aggregate-usage.sh:19`, `allocate.sh:24`, `amend-task.sh:25`,
  `audit-ownership.sh:24`, `cancel-task.sh:11`, `code-intel.sh:35`,
  `create-worktree.sh:24`, `dispatch.sh:21`, `freshness-gate.sh:17`,
  `graph-impact.sh:25`, `graphify-baseline.sh:22`,
  `graphify-investigate.sh:28`, `graphify-repo.sh:30`, `herdr-push.sh:28`,
  `index-candidate.sh:26`, `integrate.sh:26`, `ledger-view.sh:19`,
  `measure-divergence.sh:21`, `otel-env.sh:16`, `promote.sh:29`,
  `record-review.sh:20`, `record-usage.sh:20`, `review-dispatch.sh:25`,
  `review-required.sh:20`, `run-init.sh:17`, `squash.sh:25`, `status.sh:15`,
  `verify.sh:31`.

Runtime evidence after the fix (same binary, same scenario as above):

```text
$ BUN_BE_BUN=1 HYDRA_HARNESS=bin HYDRA_BIN=/tmp/hydra-review-0041-cli \
    bash kit/hydra/scripts/status.sh review-missing task
hydra: error: instantiated task spec not found: .../run-review-missing/tasks/task.yaml
exit=1                        # reaches Hydra — identical to the clean control

$ HYDRA_HARNESS=bin HYDRA_BIN=/tmp/hydra-review-0041-cli bash kit/hydra/scripts/otel-env.sh
exit=0                        # clean bin lane still works
$ BUN_BE_BUN=1 HYDRA_HARNESS=bin HYDRA_BIN=/tmp/hydra-review-0041-cli bash kit/hydra/scripts/otel-env.sh
exit=0                        # bin lane works with BUN_BE_BUN inherited
```

## Finding 5: `hydra_resolve_bin()` requires an absolute, regular, executable file

### Root cause

`kit/hydra/scripts/lib.sh`'s `hydra_resolve_bin()` accepted any path passing
`[ -x "$path" ]`. `-x` is also true for a searchable directory, and nothing
required an absolute path.

### Reproduced before the fix

```text
$ HYDRA_HARNESS=bin HYDRA_BIN=/tmp bash kit/hydra/scripts/status.sh review-missing task
kit/hydra/scripts/status.sh: line 15: /tmp: is a directory
kit/hydra/scripts/status.sh: line 15: exec: /tmp: cannot execute: Undefined error: 0
exit=126                                   # raw bash crash, no clean fallback

$ HYDRA_HARNESS=bin HYDRA_BIN=../../../../../tmp/hydra-review-0041-cli \
    bash kit/hydra/scripts/status.sh review-missing task   # from the repo root
hydra: error: instantiated task spec not found: ...
exit=1                                     # relative override ACCEPTED and run;
                                           # its meaning depends on the caller's cwd
```

### Fix (`kit/hydra/scripts/lib.sh`)

One shared helper applied to BOTH the `HYDRA_BIN`-override branch and the
default-candidate branch (the default candidate is absolute by construction,
but using the same check keeps the two branches consistent):

```bash
_hydra_bin_is_usable() {
  case "$1" in
    /*) ;;
    *) return 1 ;;          # relative path: reject
  esac
  [ -f "$1" ] && [ -x "$1" ]  # regular executable FILE (not a directory)
}
```

Both branches now call `_hydra_bin_is_usable` instead of bare `[ -x ... ]`,
and both warnings now say "is missing, not a regular file, or not executable"
instead of "not found".

### Verified after the fix (all four cases warn and fall back to the ts lane;
the ts lane then produces Hydra's normal missing-task-spec error — never a
raw bash crash)

```text
(a) HYDRA_BIN=/definitely/missing/hydra-cli
    hydra: warn: ... is missing, not a regular file, or not executable, falling back to ts
    hydra: error: instantiated task spec not found: ...      exit=1
(b) HYDRA_BIN=/tmp            (directory)
    hydra: warn: ... is missing, not a regular file, or not executable, falling back to ts
    hydra: error: instantiated task spec not found: ...      exit=1   (was: exit=126 crash)
(c) HYDRA_BIN=<mktemp file>   (existing, non-executable regular file)
    hydra: warn: ... is missing, not a regular file, or not executable, falling back to ts
    hydra: error: instantiated task spec not found: ...      exit=1
(d) HYDRA_BIN=../../../../../tmp/hydra-review-0041-cli   (relative, would resolve)
    hydra: warn: ... is missing, not a regular file, or not executable, falling back to ts
    hydra: error: instantiated task spec not found: ...      exit=1   (now rejected)
```

Positive regression check: an absolute, regular, executable `HYDRA_BIN`
(`/tmp/hydra-review-0041-cli`) still resolves and runs (see finding 1
after-fix evidence — the binary executed and reached Hydra's own error).

## Finding 6: frozen-lane contract — documentation clarification, no revert

### Attribution confirmed independently

`git log --oneline f34de42..HEAD -- kit/hydra/scripts/dispatch.sh
kit/hydra/scripts/review-dispatch.sh` shows the `HYDRA_HERDR_PANES` default
change (`:-0` → `:-1`) and the `hydra_repo_root()` error-text change came
from commit `1930ecb` ("fix: default herdr pane hosting on; actionable
not-a-git-repo error"), merged as PR #1
(`fix/panes-default-and-repo-error`) at merge commit `d537090`, whose
merge-base is `f34de42` itself. The Bun migration's bash preamble commit
(`b5991ea`, run 0038) landed strictly after that merge. These edits are a
separate, earlier, already-merged pull request that predates this Bun
migration session's work entirely, and they fixed a real, unrelated bug
(herdr pane hosting defaulting off when it should default on, per the
project's own documented guidance in
`.claude/skills/hydra-protocol/SKILL.md`: "Set `HYDRA_HARNESS_PANES=1` by
default... unsetting it was a mistake made once this session").

### Decision: no revert

Reverting PR #1 to satisfy a literal "byte-identical to `f34de42`" reading
would reintroduce an already-diagnosed-and-fixed defect (herdr panes
defaulting off) purely for cosmetic byte equality. This task therefore makes
NO change to `dispatch.sh` / `review-dispatch.sh`'s `HYDRA_HERDR_PANES`
default or `lib.sh`'s `hydra_repo_root()` error text. (Both files do appear
in this task's diff for exactly one unrelated line: the finding-1
`env -u BUN_BE_BUN` exec-line fix, which every wrapper received.)

### The "frozen bash lane" contract, stated precisely

"Frozen" means the bash implementation body is not touched **by the Bun
migration work itself** (Stages 1/2/3/4) — the migration may add the
three-state routing preamble at the top of each wrapper, but must not
otherwise alter the bash lane's logic. It does NOT mean the bash lane is
frozen against all future maintenance for all time: ordinary bug fixes to
the bash lane (such as PR #1's panes-default fix) remain legitimate and
expected; they are simply out of scope for, and not caused by, this
migration. Byte-identity claims should be evaluated against the migration's
own commits, not against unrelated maintenance history that precedes them.

## Verification run for this task

- `bash -n` over all 29 shell files (28 wrappers + `lib.sh`): **29/29 pass**
  (matches the review's baseline check).
- Finding 1 reproduced before the fix (hijack confirmed:
  `error: Script not found "status"`) and after the fix (reaches Hydra,
  output identical to the clean control; `otel-env.sh` exits 0 with and
  without `BUN_BE_BUN=1`). Verified with a real Bun 1.3.14 compiled binary
  — `bun` was available in this environment (`~/.bun/bin/bun`), so the
  inspection-only fallback was not needed.
- Finding 5's directory and relative-path scenarios reproduced before the
  fix (exit=126 raw crash; relative override executed) and re-run after the
  fix (clean warning + ts fallback in all four cases: missing, directory,
  non-executable file, relative path).
- `cd kit/hydra-ts && npm test` (resolver-selected Node v24.16.0 from
  `~/.nvm/versions/node/v24.16.0`; the PATH default `node` is v17.4.0 and
  cannot run the suite at all):
  - **Environment caveat, stated plainly:** in THIS worktree the suite cannot
    run meaningfully — a macOS endpoint-security-style policy on the
    `worktrees/hydra-swarm/` path denies every file creation inside any
    nested `.git/` directory (reproduced with plain `cp`: any source file
    copied into a freshly created `.git/hooks/` fails with `Operation not
    permitted`, while the same copy to a non-`.git` directory succeeds, and
    `git init` in `/tmp` works fine). Test fixtures that `git init` a repo
    therefore die with exit 128 (808 tests: 733 pass / 72 fail / 3 cancelled
    — all environmental, none assertion failures). This is a sandbox
    restriction, not a code signal, and it is why the suite was compared
    A/B outside the worktree instead.
  - **A/B comparison (the actual evidence the suite is unaffected):** two
    `/tmp` copies — `git archive HEAD kit` (pristine base) and the modified
    tree — each `git init`-ed so repo-dependent suites work, both run with
    Node v24.16.0:
    - base:     `test:concurrent` 808 tests / **805 pass / 3 fail**;
      `test:promote` **27/27 pass**
    - modified: `test:concurrent` 808 tests / **805 pass / 3 fail**;
      `test:promote` **27/27 pass**
    - the failing-test NAME sets are byte-identical between base and
      modified, and are exactly the review's documented baseline: the three
      macOS `ps`-visibility cases in `test/status.sh.test.ts` ("reports
      disagreement when a queued task has no live dispatch process",
      "does not report disagreement when a queued task has a live validated
      dispatch process", "reports disagreement when a live process runs a
      dispatcher for the wrong run/task"). No new failure name appeared.
  - This lane touches no TypeScript files (`kit/hydra-ts` is byte-identical
    between base and modified, diff-verified); the suite outcome is identical
    to the established advisory baseline.

Environment note: sandbox is macOS arm64 (`bash` 3.2 system shell); the
sed transform used BSD `sed -i ''`. `bun` 1.3.14 was available at
`~/.bun/bin/bun` and the reviewer's compiled artifact survived at
`/tmp/hydra-review-0041-cli`, so all runtime reproductions used a real
compiled binary rather than inspection-only reasoning.
