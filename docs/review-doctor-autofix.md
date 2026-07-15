# Review: doctor auto-remediation (`review-doctor-autofix`, run 0028)

**Reviewer:** claude (cross-vendor advisory review)
**Candidate commit:** `b596b59` — "doctor-autofix: opt-in --json mode, doctor-fix.sh, and tests"
**Base (pre-change):** `7a2756f9` (purely diagnostic `doctor.sh`, no JSON, no fix executor)
**Reviewed files:** `kit/scripts/doctor.sh`, `kit/scripts/doctor-fix.sh`,
`kit/scripts/tests/doctor-test.sh`, `commands/hydra-doctor.md`, `docs/operations.md`

---

## Overall verdict: **REJECT (revise)**

The change gets the hard part right: **every safety property holds.** The
category hard-refusal is enforced unconditionally inside `doctor-fix.sh` itself
(a caller bug cannot bypass it), the default output is byte-identical to the
pre-change version, the URLs are all correct, the `eval` only ever runs trusted
hardcoded commands, and every error path fails *closed*. From a pure
"can this mutate the host in an unintended way" standpoint the answer is **no**.

**However, the change must be revised before merge for two reasons:**

1. **The `srt` auto-fix is completely non-functional.** `doctor-fix.sh:79-81`
   contain broken dead code (a command substitution that throws a runtime
   syntax error) which, under `set -e`, aborts the script *before* the real
   dependency check at `doctor-fix.sh:83-91` can run. The net effect is that
   `doctor-fix.sh srt` **always** crashes when `srt` is in the `warn`/`auto`
   state — the fix can never actually be applied. It fails *safe* (never runs
   `npm`), but a shipped feature is silently dead.

2. **The `srt` dependency-gating test is a false positive.** Test #6
   ("refuses srt fix when node is not passing") passes — but for the wrong
   reason: it observes the syntax-error crash and reads it as a successful
   refusal. It does **not** exercise the actual dependency check at line 91.
   This is precisely the kind of green-but-misleading coverage that undermines
   the "safety properties matter a lot" mandate for the first host-mutating
   script in the project.

Neither issue is a safety regression (nothing unsafe ever executes), but
shipping a broken feature behind a test that claims to verify a safety-critical
code path is a form of silent degradation the codebase's own philosophy rejects.

---

## Findings by verification point

### 1. Guide/manual hard-refusal — **PASS (safety property holds)**

Traced in the actual code, not just the tests. `doctor-fix.sh` re-queries
`doctor.sh --json` itself and extracts the category, then refuses before *any*
command is built or executed:

- `doctor-fix.sh:66-73` — fetch the check object and extract `category`.
- `doctor-fix.sh:75` — `[ "$category" = "auto" ] || die "this check is not auto-fixable; category is $category"`

This `die` runs **before** `build_command` (`:152`) and **before** `eval`
(`:156`). The enforcement is unconditional and lives inside `doctor-fix.sh`,
so a caller bug in `commands/hydra-doctor.md` (e.g. passing a `guide` check
name) **cannot bypass it**. Independently reproduced against the real
`doctor.sh`: `doctor-fix.sh "vendor cli: codex"` (guide) and `doctor-fix.sh herdr`
(manual) both exit 1 without executing anything.

### 2. Default (no-flag) output regression — **PASS (independently verified)**

Verified by running both versions in the same environment, not by trusting the
test's claim:

```
$ bash <(git show 7a2756f9:kit/scripts/doctor.sh) > base.out
$ bash kit/scripts/doctor.sh > current.out
$ cmp base.out current.out && echo BYTE-IDENTICAL
BYTE-IDENTICAL
$ shasum -a 256 base.out current.out
f3199043bff380542658032817b51b7baf6a06ddb50472253a82528039587470  base.out
f3199043bff380542658032817b51b7baf6a06ddb50472253a82528039587470  current.out
```

The opt-in JSON path is fully gated behind `json_mode` (`doctor.sh:17-27`):
`fail`/`warn`/`pass` short-circuit with `[ "$json_mode" -eq 1 ] || return 0`,
and `json_emit`/`print_json` are no-ops unless `--json` is set. Default output is
byte-identical (matching SHA-256).

### 3. Platform detection — **PASS**

`select_fix_command` (`doctor-fix.sh:102-126`) probes `command -v brew` →
`apt-get` → `dnf` in that order and, for the detected manager, emits the
matching key (`brew`/`apt`/`dnf`) from the fix object. It **dies cleanly**
rather than guessing or silently no-opping:

- brew present but no `brew` key → `die "no Homebrew fix available for '$check_name'"` (`:109`)
- no manager at all → `die "no supported package manager found (brew, apt-get, or dnf)"` (`:125`)

Independently reproduced: a `brew`-on-PATH-but-no-brew-key fixture dies with the
Homebrew message and exit 1 (does not fall through to `dnf`); a no-manager
fixture dies with the "no supported package manager" message. Detection is by
binary presence (not `uname`), which is the correct, robust choice.

### 4. srt dependency-ordering safety — **DEFECT (feature broken; fails safe)**

The *intent* and the *real check* are correct, but they are unreachable due to
broken dead code immediately above them.

`doctor-fix.sh:77-92`:
```bash
if [ "$check_name" = "srt" ]; then
  node_status="$(fetch_check_obj | { while IFS= read -r line; do      # :79
    case "$line" in *'"name":"node"'*) printf '%s' "$line"; break ;; esac
  done })"                                                           # :81  <-- BROKEN
  # Re-fetch specifically for node.
  node_obj=""
  while IFS= read -r line; do                                        # :84  <-- real logic
    case "$line" in *'"name":"node"'*) node_obj="$line"; break ;; esac
  done < <("$DOCTOR" --json)
  node_status=""
  if [ -n "$node_obj" ]; then
    node_status="$(json_get_str "$node_obj" status 2>/dev/null || true)"
  fi
  [ "$node_status" = "pass" ] || die "refusing srt fix..."           # :91  <-- the actual gate
fi
```

Lines `:79-81` are dead code that is *also* a runtime defect:
- It is **dead**: the `$( ... | { while...done })` assignment runs in a subshell
  pipe, so even if it parsed it could not affect the outer `node_status` (which
  is unconditionally reset to `""` at `:87`). `fetch_check_obj` also returns the
  *srt* object (it keys on `$check_name`), so the inner `case` searching for
  `"name":"node"` can never match.
- It is **broken**: the command substitution throws a runtime syntax error on
  bash 5.3.3 (`command substitution: ... syntax error near unexpected token
  'newline'`). This error is **not** caught by `bash -n` (which reports the file
  clean). Under `set -e` the script aborts at `:79-81` and never reaches the
  real gate at `:91`.

Definitive reproduction with a realistic multi-line fake doctor (`node: pass`,
`srt: warn/auto`):
```
$ bash kit/scripts/doctor-fix.sh srt
.../doctor-fix.sh: command substitution: line 82: syntax error near unexpected token `newline'
.../doctor-fix.sh: line 81: line: unbound variable
[exit=1]   # npm never runs
```

Deleting lines `:79-81` from a scratch copy makes the srt fix execute correctly
(npm runs when node is passing; the gate at `:91` refuses when node is failing).
So the real logic at `:83-91` is correct — it is just shadowed by the broken
block above it.

**Safety characterization:** this fails *closed*. `npm` is never invoked
incorrectly. The property "srt fix refuses when node is not passing" holds
**vacuously** (the srt fix refuses unconditionally, even when node is healthy).
That is safe but not functional.

### 5. node/nvm two-step idempotency — **PASS**

`build_command` node case (`doctor-fix.sh:131-142`) branches on
`[ -s "$nvm_dir/nvm.sh" ]` (exists and non-empty):

- **First run** (no `nvm.sh`): `else` branch → `nvm_bootstrap` (curl install)
  `&&` source `&&` `nvm install 22 && nvm alias default 22`.
- **Re-run** (`nvm.sh` present): `if` branch → **skips bootstrap**, emits only
  `export NVM_DIR=... && source && nvm install 22 && nvm alias default 22`.

Independently reproduced both branches via a fake-doctor fixture: with
`nvm.sh` absent the built command contains the bootstrap curl; with `nvm.sh`
present the bootstrap is omitted and only the source+install+alias remains.
Correctly idempotent. (`nvm install 22`/`nvm alias default 22` are themselves
idempotent.)

### 6. Install URLs for `guide` checks — **PASS (all five exact)**

Extracted from `doctor.sh --json` with the tools forced missing (stripped
PATH) and compared to the expected values:

| Check | Emitted URL (`doctor.sh`) | Expected | Match |
|---|---|---|---|
| codex (`:135`) | `https://github.com/openai/codex` | same | yes |
| opencode (`:140`) | `https://github.com/opencode-ai/opencode` | same | yes |
| kimi (`:145`) | `https://github.com/MoonshotAI/kimi-code` | same | yes |
| gitnexus (`:173`) | `https://github.com/abhigyanpatwari/GitNexus` | same | yes |
| graphify (`:181`) | `https://github.com/safishamsi/graphify` | same | yes |

No mismatches.

### 7. `commands/hydra-doctor.md` narration — **PASS**

- **Per-fix confirmation (not blanket yes-to-all):** `:42-44` — "ask for
  explicit yes/no confirmation ... for that ONE check. After it returns,
  re-run `doctor.sh` ... before offering the next fix." `:60-61` — "Do not
  batch fixes, do not skip confirmation."
- **Dependency order:** `:45-47` — "offer to fix `node` before offering to fix
  `srt`", and notes `doctor-fix.sh` will refuse srt if node isn't passing.
- **No auto-run for guide/manual:** `:49-52` — guide: "Do NOT invoke
  `doctor-fix.sh` for these"; `:54-56` — manual: "this cannot be scripted."
- `allowed-tools` (`:3`) correctly restricts the command to the two scripts.

### 8. Test coverage — **PARTIAL: real assertions + mocked PMs, but one false positive**

Good: the tests are self-contained, redirect state into a temp dir, and use
**fake** package-manager binaries (`make_fake_pm`, `make_fake_sudo`) — **no test
invokes a real `brew`/`apt`/`dnf`/`npm`/`curl`**. The guide/manual refusal
tests (#4) and platform-detection tests (#5) use genuine two-condition
assertions (non-zero exit **and** no marker file written), and the byte-identical
default-output test (#7) diffs against the base commit.

**Defect — Test #6 (srt gating) is a false positive.** Its fake doctor
(`doctor-test.sh:112-122`) emits **single-line** JSON:
```
[{node...fail...auto...},{srt...warn...auto...}]
```
Because `json_get_str` (`doctor-fix.sh:33-39`) returns the **first** match of
`"category":"`, and `node` precedes `srt` on that one line, `doctor-fix.sh`
reads `category="auto"` (node's), passes the `:75` gate, enters the srt block,
and **crashes at the broken `:79-81`** before reaching the real check at
`:91`. The test sees `exit != 0` + no `npm` marker and reports PASS "refuses srt
fix when node is not passing" — but the refusal was the syntax-error crash, not
the dependency gate. The test does not verify what its name claims.

Recommended fix: have the srt fixture emit **multi-line** JSON (one object per
line, matching real `doctor.sh` output) and add the inverse case (node **passing**
→ srt fix **proceeds**). With the current candidate that inverse case would
fail, proving the test currently proves nothing about the gate.

### 9. Shell injection / quoting / command integrity — **PASS (with minor notes)**

- `eval "$cmd"` (`:156`) executes a string built only from values in the fix
  JSON object, which is emitted by `doctor.sh` from **hardcoded** trusted
  strings. `$check_name` selects the `case` branch but is **never interpolated
  into the eval'd string**, so a crafted check name cannot inject commands.
- The only semi-dynamic value reaching `eval` is `$nvm_dir`
  (`${NVM_DIR:-$HOME/.nvm}`, node case `:136/:140`). If `NVM_DIR` contained
  shell metacharacters it would flow into the `eval`; this is a pre-existing
  trust assumption on the local environment, not a candidate-introduced hole.
  Worth a hardening note (quote/validate `NVM_DIR`) but not blocking.
- `json_get_str`/`json_get_obj` use parameter expansion only — no `eval` of
  data. `json_escape` (`doctor.sh:29-35`) escapes `\` and `"` for the
  controlled single-line values.
- Minor latent fragility: the re-verify grep (`:159`)
  `grep -q "\"name\":\"$check_name\".*\"status\":\"pass\""` interpolates
  `$check_name` into a regex. All current check names are literal (no regex
  metacharacters), so it is correct today, but a future name containing `.`,
  `[`, `*`, etc. could mismatch. Consider `grep -F -q "\"name\":\"$check_name\""`
  followed by a status check, or `jq`.
- Variables are consistently quoted; no glob-splitting hazards found.

---

## Required revisions before merge

1. **Delete `doctor-fix.sh:79-81`** (the broken dead-code command
   substitution). The correct, working dependency check already exists at
   `:83-91`; nothing of value is lost. After deletion, verify `doctor-fix.sh srt`
   runs `npm` when `node` is passing and refuses when `node` is failing.
2. **Fix Test #6 to be a true positive**: emit multi-line JSON from the srt
   fixture and add the node-passing-→-srt-proceeds case so the gate at `:91`
   is actually exercised (currently no test ever reaches it).

## Optional hardening (non-blocking)

3. Validate/quote `NVM_DIR` before interpolating into the `eval` string.
4. Replace the regex-interpolating re-verify `grep` (`:159`) with a fixed-string
   match or `jq`.

## Verification commands run by this reviewer

| Command | Result |
|---|---|
| `bash <(git show 7a2756f9:kit/scripts/doctor.sh) vs kit/scripts/doctor.sh` (default, `cmp`/`shasum`) | byte-identical (same SHA-256) |
| `bash kit/scripts/tests/doctor-test.sh` | 10/10 pass (reproduced) |
| `doctor-fix.sh "vendor cli: codex"` / `herdr` against real doctor.sh | both refused, exit 1, nothing executed |
| srt path, multi-line fake, node passing, **unmodified** candidate | syntax-error crash at `:79-81`, npm never runs |
| srt path, multi-line fake, node passing, **`:79-81` deleted** | npm runs (fix executes) |
| srt path, official-test single-line fake (node failing) | crash at `:79-81`; test reads as pass (false positive) |
| node idempotency: `nvm.sh` present vs absent | bootstrap correctly skipped when present |
| URLs via stripped-PATH `doctor.sh --json` | all 5 match expected exactly |
| `bash -n kit/scripts/doctor-fix.sh` | reports clean (does **not** catch the `:79-81` runtime defect) |
