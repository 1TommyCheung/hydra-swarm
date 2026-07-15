#!/usr/bin/env bash
# hydra/tests/doctor-test.sh — tests for kit/scripts/doctor.sh and doctor-fix.sh.
#
# Fully self-contained: redirects state into a throwaway dir, uses PATH fixtures
# to simulate missing tools and fake package managers, and never invokes a real
# package manager or npm install.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SELF_DIR/.." && pwd)"
DOCTOR="$SCRIPTS_DIR/doctor.sh"
DOCTOR_FIX="$SCRIPTS_DIR/doctor-fix.sh"
REPO_ROOT="$(cd "$SELF_DIR/../../.." && pwd)"
BASE_COMMIT="7a2756f99ce63a3825088deda33c5eb315e5f6ee"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/hydra-doctor.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
green() { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

# --- helpers ---------------------------------------------------------------

json_validate() {
  # Validate JSON using jq if available, otherwise python3.
  local file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq . "$file" >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$file" >/dev/null 2>&1
  else
    return 1
  fi
}

json_names() {
  # Print sorted check names from a doctor.sh --json file.
  local file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.[].name' "$file" | sort
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print("\n".join(sorted(x["name"] for x in json.load(sys.stdin))))' <"$file"
  else
    return 1
  fi
}

text_names() {
  # Extract check names from the default PASS/WARN/FAIL output.
  local file="$1"
  while IFS= read -r line; do
    case "$line" in
      PASS*)
        # PASS name (detail)  -> name before ' ('
        name="${line#PASS }"
        name="${name%% (*}"
        printf '%s\n' "$name"
        ;;
      WARN*|FAIL*)
        # WARN name: detail -> name before ': '
        name="${line#WARN }"
        name="${line#FAIL }"
        name="${name%%: *}"
        printf '%s\n' "$name"
        ;;
    esac
  done <"$file" | sort -u
}

make_fake_pm() {
  # make_fake_pm <dir> <name> <marker>
  # Create a fake package-manager binary that records invocation in marker.
  local dir="$1" name="$2" marker="$3"
  cat >"$dir/$name" <<EOF
#!/bin/sh
printf '%s' "$name" > "$marker"
exit 0
EOF
  chmod +x "$dir/$name"
}

make_fake_sudo() {
  # fake sudo that just executes its arguments (so apt/dnf commands run).
  # Note: when called as 'sudo apt-get ...', the script's $0 is 'sudo' and
  # $@ is already 'apt-get ...', so we must NOT shift.
  local dir="$1"
  cat >"$dir/sudo" <<'EOF'
#!/bin/sh
exec "$@"
EOF
  chmod +x "$dir/sudo"
}

make_fake_doctor() {
  # Writes a fake doctor.sh into the given dir. It tracks a marker file so the
  # second invocation reports the fixed check as passing.
  local dir="$1" marker="$2"
  cat >"$dir/doctor.sh" <<EOF
#!/bin/sh
[ "\$1" = "--json" ] || exit 0
if [ -f "$marker" ]; then
  printf '[{"name":"fakepkg","status":"pass","category":"none","detail":"fixed"}]\n'
else
  printf '[{"name":"fakepkg","status":"warn","category":"auto","fix":{"brew":"brew install fakepkg","apt":"sudo apt-get install -y fakepkg","dnf":"sudo dnf install -y fakepkg"},"detail":"missing"}]\n'
fi
EOF
  chmod +x "$dir/doctor.sh"
}

make_fake_doctor_srt_refuse() {
  # doctor.sh JSON where node is failing and srt is auto-fixable.
  # Format matches real doctor.sh --json output exactly: one object per line.
  local dir="$1"
  cat >"$dir/doctor.sh" <<'EOF'
#!/bin/sh
[ "$1" = "--json" ] || exit 0
printf '[\n  {"name":"node","status":"fail","category":"auto","fix":{"nvm_bootstrap":"echo bootstrap","nvm_install":"echo install"},"detail":"no node"},\n  {"name":"srt","status":"warn","category":"auto","fix":{"npm":"npm install -g @anthropic-ai/sandbox-runtime"},"detail":"srt missing"}\n]\n'
EOF
  chmod +x "$dir/doctor.sh"
}

make_fake_doctor_srt_proceed() {
  # doctor.sh JSON where node is passing and srt is auto-fixable.  A marker file
  # lets the second invocation (re-verify) report srt as fixed.
  local dir="$1" marker="$2"
  cat >"$dir/doctor.sh" <<EOF
#!/bin/sh
[ "\$1" = "--json" ] || exit 0
if [ -f "$marker" ]; then
  printf '[\\n  {"name":"node","status":"pass","category":"none","detail":"node ok"},\\n  {"name":"srt","status":"pass","category":"none","detail":"srt installed"}\\n]\\n'
else
  printf '[\\n  {"name":"node","status":"pass","category":"none","detail":"node ok"},\\n  {"name":"srt","status":"warn","category":"auto","fix":{"npm":"npm install -g @anthropic-ai/sandbox-runtime"},"detail":"srt missing"}\\n]\\n'
fi
EOF
  chmod +x "$dir/doctor.sh"
}

make_fake_doctor_guide() {
  # doctor.sh JSON where vendor cli: codex is guide.
  local dir="$1"
  cat >"$dir/doctor.sh" <<'EOF'
#!/bin/sh
[ "$1" = "--json" ] || exit 0
printf '[{"name":"vendor cli: codex","status":"warn","category":"guide","url":"https://github.com/openai/codex","detail":"not found"}]\n'
EOF
  chmod +x "$dir/doctor.sh"
}

# --- 1. --json emits valid JSON -------------------------------------------
"$DOCTOR" --json >"$TMP/json.out"
if json_validate "$TMP/json.out"; then
  green "--json produces valid JSON"
else
  red "--json produces invalid JSON"
fi

# --- 2. --json contains same check names as default output -----------------
"$DOCTOR" >"$TMP/text.out"
json_names "$TMP/json.out" >"$TMP/json.names"
text_names "$TMP/text.out" >"$TMP/text.names"
if diff -q "$TMP/json.names" "$TMP/text.names" >/dev/null 2>&1; then
  green "--json names match default output names"
else
  red "--json names differ from default output names"
  echo "--- json names ---"; cat "$TMP/json.names"
  echo "--- text names ---"; cat "$TMP/text.names"
fi

# --- 3. --json is valid on a machine missing tools -------------------------
# Simulate a stripped PATH that excludes jq/git/node/srt etc.
mkdir -p "$TMP/minimal-bin"
ln -sf /bin/true "$TMP/minimal-bin/true"
ln -sf /bin/false "$TMP/minimal-bin/false"
ln -sf /bin/sh "$TMP/minimal-bin/sh"
PATH="$TMP/minimal-bin" "$DOCTOR" --json >"$TMP/json-minimal.out" 2>/dev/null
if json_validate "$TMP/json-minimal.out"; then
  green "--json valid with stripped PATH"
else
  red "--json invalid with stripped PATH"
fi

# --- 4. doctor-fix.sh refuses guide/manual checks -------------------------
make_fake_doctor_manual() {
  # doctor.sh JSON where srt live smoke is manual.
  local dir="$1"
  cat >"$dir/doctor.sh" <<'EOF'
#!/bin/sh
[ "$1" = "--json" ] || exit 0
printf '[{"name":"srt live smoke","status":"fail","category":"manual","detail":"confinement not working"}]\n'
EOF
  chmod +x "$dir/doctor.sh"
}

FIXTURE="$TMP/fixture-guide"
mkdir -p "$FIXTURE"
make_fake_doctor_guide "$FIXTURE"
cp "$DOCTOR_FIX" "$FIXTURE/doctor-fix.sh"
chmod +x "$FIXTURE/doctor-fix.sh"
marker="$TMP/guide-marker"
make_fake_pm "$FIXTURE" npm "$marker"
if PATH="$FIXTURE:/bin:/usr/bin" HOME="$TMP" "$FIXTURE/doctor-fix.sh" "vendor cli: codex" >/dev/null 2>&1; then
  red "doctor-fix.sh accepted a guide check"
elif [ -f "$marker" ]; then
  red "doctor-fix.sh executed a command on a guide check"
else
  green "doctor-fix.sh refuses guide check without executing anything"
fi

FIXTURE="$TMP/fixture-manual"
mkdir -p "$FIXTURE"
make_fake_doctor_manual "$FIXTURE"
cp "$DOCTOR_FIX" "$FIXTURE/doctor-fix.sh"
chmod +x "$FIXTURE/doctor-fix.sh"
marker="$TMP/manual-marker"
make_fake_pm "$FIXTURE" npm "$marker"
if PATH="$FIXTURE:/bin:/usr/bin" HOME="$TMP" "$FIXTURE/doctor-fix.sh" "srt live smoke" >/dev/null 2>&1; then
  red "doctor-fix.sh accepted a manual check"
elif [ -f "$marker" ]; then
  red "doctor-fix.sh executed a command on a manual check"
else
  green "doctor-fix.sh refuses manual check without executing anything"
fi

# --- 5. doctor-fix.sh detects brew/apt/dnf correctly -----------------------
test_pm() {
  local pm="$1"
  local FIXTURE="$TMP/fixture-$pm"
  mkdir -p "$FIXTURE"
  marker="$TMP/$pm-marker"
  rm -f "$marker"
  make_fake_doctor "$FIXTURE" "$marker"
  cp "$DOCTOR_FIX" "$FIXTURE/doctor-fix.sh"
  chmod +x "$FIXTURE/doctor-fix.sh"
  make_fake_pm "$FIXTURE" "$pm" "$marker"
  make_fake_sudo "$FIXTURE"
  # Provide only the target PM in PATH.
  PATH="$FIXTURE:/bin:/usr/bin" HOME="$TMP" "$FIXTURE/doctor-fix.sh" fakepkg >/dev/null 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ] && [ -f "$marker" ] && [ "$(cat "$marker")" = "$pm" ]; then
    green "doctor-fix.sh selects $pm when $pm is the only package manager"
  else
    red "doctor-fix.sh did not select $pm correctly (rc=$rc marker=$(cat "$marker" 2>/dev/null || echo '<none>'))"
  fi
}
test_pm brew
test_pm apt-get
test_pm dnf

# --- 6. doctor-fix.sh refuses srt when node is failing ---------------------
FIXTURE="$TMP/fixture-srt-refuse"
mkdir -p "$FIXTURE"
make_fake_doctor_srt_refuse "$FIXTURE"
cp "$DOCTOR_FIX" "$FIXTURE/doctor-fix.sh"
chmod +x "$FIXTURE/doctor-fix.sh"
marker="$TMP/srt-refuse-marker"
rm -f "$marker"
make_fake_pm "$FIXTURE" npm "$marker"
if PATH="$FIXTURE:/bin:/usr/bin" HOME="$TMP" "$FIXTURE/doctor-fix.sh" srt >/dev/null 2>&1; then
  red "doctor-fix.sh ran srt fix while node is failing"
elif [ -f "$marker" ]; then
  red "doctor-fix.sh executed npm for srt fix while node is failing"
else
  green "doctor-fix.sh refuses srt fix when node is not passing"
fi

# --- 7. doctor-fix.sh proceeds with srt when node is passing ---------------
FIXTURE="$TMP/fixture-srt-proceed"
mkdir -p "$FIXTURE"
marker="$TMP/srt-proceed-marker"
rm -f "$marker"
make_fake_doctor_srt_proceed "$FIXTURE" "$marker"
cp "$DOCTOR_FIX" "$FIXTURE/doctor-fix.sh"
chmod +x "$FIXTURE/doctor-fix.sh"
make_fake_pm "$FIXTURE" npm "$marker"
if PATH="$FIXTURE:/bin:/usr/bin" HOME="$TMP" "$FIXTURE/doctor-fix.sh" srt >/dev/null 2>&1; then
  if [ -f "$marker" ]; then
    green "doctor-fix.sh proceeds with srt fix when node is passing"
  else
    red "doctor-fix.sh succeeded but did not run npm for srt fix"
  fi
else
  red "doctor-fix.sh refused or failed the srt fix even though node is passing"
fi

# --- 8. Default output is byte-identical to base commit ---------------------
git -C "$REPO_ROOT" show "$BASE_COMMIT:kit/scripts/doctor.sh" >"$TMP/doctor-base.sh"
chmod +x "$TMP/doctor-base.sh"
"$TMP/doctor-base.sh" >"$TMP/base.out"
"$DOCTOR" >"$TMP/current.out"
if diff -q "$TMP/base.out" "$TMP/current.out" >/dev/null 2>&1; then
  green "default doctor.sh output is byte-identical to base commit"
else
  red "default doctor.sh output differs from base commit"
  diff "$TMP/base.out" "$TMP/current.out" || true
fi

echo
echo "----------------------------------------"
printf 'doctor tests: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
