---
description: Run the Hydra-Swarm Wave 3 preflight check (shell, core tools, vendor CLIs, code intelligence, observability, sandbox, timeout fallback)
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/kit/scripts/doctor.sh)
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
