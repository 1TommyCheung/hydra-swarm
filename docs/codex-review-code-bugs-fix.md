# Cross-Vendor Review: `code-bugs-fix`

**Overall verdict: ACCEPT.** The bootstrap-path and OpenCode monitor-banner fixes are functionally correct, the regression test would have caught the original TypeScript bug, the task-template and ignore-file updates match the current repository, and no stale executable path/model default remains in the reviewed implementations. No blocking findings were identified.

## Scope and method

Reviewed the base commit `2a37ec3561feb689a27ccf928f8136368a13f5c1` and the requested Bash, TypeScript, test, template, and ignore-file changes. Source files were treated as read-only. The focused `create-worktree` test file was also run locally with Node 22.

## 1. Bootstrap policy path

**Result: correct and in parity.**

- The policy is present at `kit/hydra/policies/bootstrap.yaml`; its resolved absolute path is under the current repository root at exactly that suffix.
- Bash obtains `repo_root` from `git rev-parse --show-toplevel` and constructs `"$repo_root/kit/hydra/policies/bootstrap.yaml"`.
- TypeScript obtains the same Git top-level by default and constructs `join(roots.repoRoot, 'kit', 'hydra', 'policies', 'bootstrap.yaml')`.
- Both implementations therefore select the same real file. Their existing file-existence guards now enter the bootstrap path instead of silently skipping it.

## 2. Regression-test strength

**Result: the new test genuinely proves the fix.**

The test does more than prove that some bootstrap command ran:

1. It creates a decoy policy at the obsolete `hydra/policies/bootstrap.yaml` location containing `old_path_step`.
2. It creates the real policy at `kit/hydra/policies/bootstrap.yaml` containing `correct_path_step`.
3. Its injected executor records the command passed through `bash -c`.
4. It requires `correct_path_step` to have executed and separately forbids `old_path_step`.

With the old implementation, the decoy would be selected: the positive assertion for `correct_path_step` would fail and the negative assertion for `old_path_step` would also fail. The test therefore cannot pass merely because an arbitrary bootstrap step executes. The focused test run passed all 17 tests, including this case.

The regression test directly exercises the TypeScript implementation. Bash parity for this one-line path construction was confirmed by source inspection rather than a new Bash integration test; that is sufficient for this change because both resolved constructions are explicit and identical.

## 3. OpenCode monitor model banner

**Result: correct, display-only fix.**

- `kit/hydra-ts/src/dispatch.ts` and `kit/hydra/scripts/dispatch.sh` now display `zai-coding-plan/glm-5.2` when `HYDRA_OPENCODE_MODEL` is unset.
- This matches the actual defaults in both `adapter-opencode.ts` and `adapters/opencode.sh`.
- In both dispatch implementations, the corrected local value is used only to build the monitor-pane banner. Worker execution remains in the adapter, and the existing environment override behavior is unchanged.
- The introducing diff changes only the banner default line in each dispatch implementation, so it does not alter worker arguments, process launch, or result handling.

## 4. Task template

**Result: current and sensible.**

- The template identifies itself and its schema at their current `kit/hydra/...` locations.
- Vendor guidance lists the four dispatchable vendors: Claude, Codex, OpenCode, and Kimi.
- Every newly listed repository protection path exists today and contains tracked files: `kit/hydra/`, `kit/hydra-ts/`, `.claude-plugin/`, and `skills/`.
- These paths protect the harness implementations, plugin metadata, and Hydra operating skill from an ordinary implementation task. Along with `.env*` and `secrets/**`, they are meaningful present-day boundaries, not aspirational paths copied from another layout.

## 5. `.gitignore`

**Result: no blocking or obvious repository-specific issue.**

- `git ls-files -ci --exclude-standard` returned no paths, so no currently tracked file is covered by a new ignore rule.
- `git status --short --ignored` showed only expected worktree-generated files (`.env.worktree` and `.hydra-task.yaml`) as ignored.
- Dependency, build-output, TypeScript metadata, environment, code-intelligence, agent-result, and log patterns are appropriate for artifacts used or described by this repository.
- The explicit `.env.agent` and `.env.worktree` rules are redundant with `.env*`, but harmless and useful as documentation.
- `.hydra-result.json` is not a missing global rule: worktree creation adds it to the per-worktree Git exclude file, and `git check-ignore` confirmed that protection in this worktree.

## 6. Stale-value and regression search

**Result: no stale executable value was missed.**

Targeted searches found no old `repo_root/hydra/policies/bootstrap.yaml` construction, no old TypeScript `join(repoRoot, 'hydra', 'policies', ...)` construction, and no `zhipu/glm-5.2` default in the reviewed create-worktree/dispatch sources or OpenCode adapters. Other current OpenCode execution/review defaults also consistently use `zai-coding-plan/glm-5.2`.

A repository-wide literal search does still find old strings in non-executable prose: the regression test's deliberate decoy/assertion, the two audit reports, roadmap/vendor documentation discussing the old value, and the first comment line of `kit/hydra/policies/bootstrap.yaml`, which still self-labels as `hydra/policies/bootstrap.yaml`. Those occurrences cannot affect path resolution or worker execution. The policy-header label is a minor documentation cleanup candidate, not a reason to reject this functional fix.

## Verification performed

- `test -f kit/hydra/policies/bootstrap.yaml` — passed.
- `/Users/tommycheung/.nvm/versions/node/v22.14.0/bin/node --experimental-strip-types --test kit/hydra-ts/test/create-worktree.test.ts` — passed: 17/17 tests.
- `git ls-files -ci --exclude-standard` — passed with no tracked ignored files.
- Targeted `rg` searches for the old path constructions and `zhipu/glm-5.2` in implementation sources — passed with no matches.

The separately reported full-suite result of 690/690 was not rerun as part of this advisory review.

## Final assessment

No source-code changes are required. Accept the reviewed base fix for promotion; optionally correct the bootstrap policy's stale header comment in a separate documentation-only change.
