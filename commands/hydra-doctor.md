---
description: Run the Hydra-Swarm Wave 3 preflight check (shell, core tools, vendor CLIs, code intelligence, observability, sandbox, timeout fallback)
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/kit/scripts/doctor.sh), Bash(${CLAUDE_PLUGIN_ROOT}/kit/scripts/doctor-fix.sh)
---

Run the preflight script and report the result:

!`${CLAUDE_PLUGIN_ROOT}/kit/scripts/doctor.sh`

Read the PASS/WARN/FAIL lines above. Then:

1. If the script exited 0 (no FAIL lines), report that Hydra-Swarm is ready
   to install/run on this machine. List any WARN lines as "works, but
   degraded" notes (e.g. a missing vendor CLI just means that vendor is
   unavailable, not that the harness is broken) — do not alarm the user
   over non-fatal warnings.
2. If any FAIL line is present, the install is NOT ready. For each FAIL,
   give the exact one-line fix already embedded in the script's own output
   (it names the install command or root cause) — do not invent a fix that
   contradicts what the script said. Do not proceed with any install/setup
   step while a FAIL is outstanding.
3. Never silently swallow a FAIL and continue — treat it as a hard stop for
   any subsequent hydra-init/setup step, consistent with the trust-boundary
   principle that Hydra-Swarm refuses to run an unconfined auto-approving
   agent rather than degrade silently.

## Opt-in auto-remediation

Default behavior remains non-destructive: doctor.sh only reports. If the user
explicitly asks to auto-fix issues, you MAY offer a strictly opt-in,
per-fix-confirmed remediation flow using the structured output.

Inspect the machine-readable diagnostics first:

!`${CLAUDE_PLUGIN_ROOT}/kit/scripts/doctor.sh --json`

For each FAIL or fixable WARN, look at the `category` field:

- `category: auto` — a runnable, platform-specific remediation exists.
  You may offer to run it, one check at a time. Name the exact command
  `doctor-fix.sh` will execute, ask for explicit yes/no confirmation, and
  only then invoke `bash kit/scripts/doctor-fix.sh <check-name>` for that
  ONE check. After it returns, re-run `doctor.sh` and confirm the check now
  passes before offering the next fix. Respect dependency order: offer to fix
  `node` before offering to fix `srt`, because `srt` depends on a working npm.
  `doctor-fix.sh` will refuse the `srt` fix if `node` is not already passing,
  but offering it in the right order is clearer and avoids a needless refusal.

- `category: guide` — the check has a verified project URL and an install
  hint, but it must be installed manually. Print the URL and the install
  command from the JSON `url` and `detail` fields, and state clearly that
  this cannot be auto-run. Do NOT invoke `doctor-fix.sh` for these.

- `category: manual` — this cannot be scripted. Explain why (the JSON
  `note`/`detail` fields tell you the reason) and tell the user what manual
  action is required.

- `category: none` — the check already passes; nothing to do.

Do not batch fixes, do not skip confirmation, and never proceed with any
subsequent hydra-init/setup step while an unresolved FAIL remains,
auto-fixed or not, until `doctor.sh` reports it as passing.
