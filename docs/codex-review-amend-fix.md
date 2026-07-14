# Cross-vendor review: amendment reason prompt fix

**Overall verdict: ACCEPT.** The change closes the reported bug, preserves the
unamended prompt byte-for-byte in both implementations, and renders a non-empty
amendment reason conspicuously before the original objective. The TypeScript and
bash task sections use the same wording and structure. YAML serialization of
free-form amendment reasons still deserves a separate hardening change.

## Scope reviewed

- Base/fix commit: `91dd206191acbec14bb72a49ccaa8a826d8607ca`
- TypeScript renderer: `kit/hydra-ts/src/build-worker-prompt.ts`
- Bash renderer: `kit/hydra/adapters/build-worker-prompt.sh`
- TypeScript tests: `kit/hydra-ts/test/build-worker-prompt.test.ts`
- Amendment producer: `kit/hydra-ts/src/amend-task.ts`

## Findings

### 1. Unamended prompts are byte-identical

**Confirmed for both implementations.**

In TypeScript, the only task-section change is a conditional expression. When
`yamlScalar(specPath, 'amendment_reason')` returns an empty string for a missing
key, the false branch emits the exact pre-fix text:

```text
## Task <task> (run <run>, spec v<version>)
Objective: <objective>
```

No surrounding prompt text or newline placement changed. The added regression
test also compares the entire rendered unamended prompt with a fixed expected
string using `assert.equal`, so this is a byte-level assertion rather than a
substring check.

In bash, the new `else` branch builds the same two-line task section and inserts
it at the same location with the same blank lines as before. An executable
comparison rendered `kit/hydra/templates/task.example.yaml` with the current
script and with the script from the parent commit; the captured byte sequences
were equal (1,776 bytes excluding the command-substitution-stripped final
newline, SHA-256 `f4963ca2c03646bdbf0e75468107de4d67634e9ef5c76285d5d35c8bc2e3b263`).

### 2. Amended prompts make the new instruction primary

**Confirmed.** With a non-empty `amendment_reason`, both renderers produce this
ordering:

1. Task heading.
2. An all-caps `THIS TASK WAS AMENDED` banner describing the amendment as a
   required fix.
3. A labeled `Amendment reason: ...` line.
4. A blank line followed by the original `Objective: ...`.

The reason is therefore neither buried after the objective nor blended into it.
The banner and ordering clearly establish the amendment as the most recent and
controlling task-specific instruction.

### 3. Tests cover the original bug and the no-regression path

**Confirmed.** The new tests do more than check that rendering succeeds:

- The direct amendment test asserts that the exact reason text is contained in
  the prompt, that its index precedes the original objective, and that the
  amendment banner and label are present.
- The integration test passes the output of `rewriteTaskSpec()` to
  `buildWorkerPrompt()` and asserts that the actual reason text survives into
  the prompt.
- The unamended regression test uses full-string equality against the complete
  historical prompt.

The suite is TypeScript-only. There is no automated bash regression test and no
cross-implementation golden-output test, so future drift between the two copies
would not be caught automatically.

The TypeScript test file could not be executed in this review environment:
installed Node is v17.4.0 (without `--test` or `--experimental-strip-types`),
and package dependencies, including `tsc`, are absent. This does not change the
source-level conclusions above; the harness should re-run the tests in its
supported Node environment.

### 4. TypeScript and bash are consistent

**Confirmed.** The amended and unamended task sections have identical wording,
capitalization, punctuation, line wrapping, ordering, and blank-line structure
in the two implementations. For ordinary scalar amendment reasons, there is no
vendor-facing wording difference attributable to `HYDRA_HARNESS`.

The TypeScript implementation computes the conditional task section inline in
the return template, while bash computes `task_section` first. That is an
implementation detail and does not alter rendered output.

### 5. Edge cases

#### Missing versus empty

A missing key and a key parsed as the empty string both select the unamended
branch because TypeScript uses a truthiness check and bash uses `[ -n ... ]`.
Thus `amendment_reason:` and `amendment_reason: ""` do not display an amendment
banner. The public `amendTask()` entry point rejects an empty reason, so normal
amend dispatches cannot create this state. Direct `rewriteTaskSpec()` callers or
manually edited task specs can still create it.

#### YAML-significant content

`rewriteTaskSpec()` appends the reason as an unquoted plain scalar. The current
YAML-ish scalar behavior therefore does not preserve every free-form string:

- `Fix: preserve #hash` is read back as `Fix: preserve`; the inline comment is
  lost.
- An embedded newline is read only through the first line, and subsequent text
  can become unintended YAML content.
- Backslash escape handling in `rewriteTaskSpec()` can turn sequences such as
  `\\n` or `\\t` into actual control characters before serialization, creating
  the same multiline/control-character problem.
- A colon in the middle of a reason is preserved by the current accessor, but
  other YAML indicators can still make the emitted file invalid or change its
  meaning for a standards-compliant YAML consumer.

This is pre-existing metadata-serialization behavior rather than a regression
in the prompt-rendering change, but it can truncate the instruction now being
surfaced. A follow-up should serialize amendment metadata using a proper quoted
or block YAML scalar and add round-trip tests for `#`, quotes, backslashes,
control escapes, and multiline input.

#### Bash interpolation

Dollar signs, command-substitution syntax, backticks, quotes, and backslashes in
the already-parsed reason are expanded into `task_section` as data and are not
recursively evaluated by bash. A probe containing `$HOME`, `$(...)`, and
backticks rendered those sequences literally and created no marker files.
There is no shell-command execution issue in `build-worker-prompt.sh` from these
characters.

## Recommendation

Accept the fix. As a non-blocking follow-up, add a shared golden fixture that
compares TypeScript and bash output for amended and unamended specs, and harden
`amendment_reason` serialization so arbitrary user-provided reasons round-trip
without truncation or malformed YAML.
