#!/usr/bin/env bash
# D5: public — refresh-exit-translation.test.sh:44-50,91,146: exercises behavior through the public CLI surface only
# tap-o4ae: fixture env must stay in this process — refuse `source`.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# refresh-exit-translation.test.sh — tap-utpn.
#
# `tap refresh` owns its exit surface. It is the POLICY layer over `tap clear`,
# and both verbs use 7 for DIFFERENT partial states:
#
#   tap clear   7 = the process was replaced and its return was NOT confirmed
#   tap refresh 7 = the clear COMPLETED and the RETIREMENT was refused
#
# Opposite next steps behind one number, so refresh translates the engine's 7
# into its own 8 rather than passing it through. Codes refresh has NOT claimed
# still pass through unchanged, which is what keeps its contracted "anything else
# is the underlying verb passed through" true — and that half needs pinning too,
# because a translation layer that swallows everything is as wrong as none.
#
# WHAT THIS FIXTURE DOES AND DOES NOT PROVE. Since tap-diagnostics-u3b the verb
# routes natively (bin/tap refresh), so the old copied-scripts trick cannot
# reach the engine. Since R7b the peer clear is in-process too (refresh awaits
# launcher/replace.ts's cmdClearNative), so the interposer is a fixture-local
# `bun` on PATH that preloads a module mock returning a chosen code; every
# other export of the module stays real. Still proves the TRANSLATION, and
# deliberately not that the engine returns 7 in the field: driving a real
# unverified rebind needs a harness that never re-registers and would cost the
# suite the full family ceiling (45s for claude). That side is already covered
# by the launcher's own clear-diagnosis tests, which call the classifier
# directly.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# shellcheck source=sandbox-pins.sh
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
REAL_BUN="$(command -v bun)"

# The engine interposer: a PATH-earlier `bun` that preloads a mock of the
# native clear entry (cmdClearNative) and passes everything else through.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/bun" <<SHIM
#!/bin/bash
exec "$REAL_BUN" --preload "$WORK/clear-stub.ts" "\$@"
SHIM
chmod +x "$WORK/bin/bun"
stub_engine() { # <exit code>
  cat > "$WORK/clear-stub.ts" <<STUB
import { mock } from "bun:test";
import * as real from "$ROOT/runtime/bun/src/launcher/replace.ts";
mock.module("$ROOT/runtime/bun/src/launcher/replace.ts", () => ({
  ...real,
  async cmdClearNative() { console.error("stub tap clear: exiting $1"); return $1; },
}));
STUB
}

# A registered peer seat, so refresh reaches its delegation rather than refusing
# earlier for an unknown handle.
BUS="$WORK/bus"
mkdir -p "$BUS/payloads" "$BUS/receipts"
REGISTRY="$WORK/team-registry.json"
INDEX="$WORK/index"
TEAMROOT="$WORK/team/utpn"
mkdir -p "$INDEX" "$TEAMROOT/.tap/bus/payloads" "$TEAMROOT/.tap/bus/receipts"
git -C "$TEAMROOT" init -q
python3 -B - "$INDEX" "$TEAMROOT" <<'PY'
import json, os, sys
index, root = sys.argv[1:3]
registry = os.path.join(root, ".tap", "team-registry.json")
with open(os.path.join(index, "global-registry.json"), "w") as fh:
    json.dump({"migrated": {}, "schema": "0.20", "teams": {"utpn": {
        "enrolled_at": "2026-08-15T00:00:00Z", "registry_location": registry,
        "root": root, "state": "registered"}}}, fh)
seat = {"base": "utpn", "delivery": "pane", "status": "active", "harness": "claude",
        "session": "utpn-peggy-0", "pane": "utpn-peggy-0:0.0", "pane_id": "%77777",
        "index": 1, "registered_from_worktree": root, "instance": "peggy|deadbeefdeadbeef"}
with open(registry, "w") as fh:
    json.dump({"schema": "0.20", "team": {"name": "utpn", "worktree_root": root},
               "seats": {"peggy": seat}}, fh)
PY

refresh_rc() { # <engine exit code> ; echoes "<refresh rc>|<stderr>"
  stub_engine "$1"
  local rc=0 err="$WORK/refresh.err"
  ( cd "$TEAMROOT" && env -u TMUX -u TMUX_PANE PATH="$WORK/bin:$PATH" \
      TAP_INDEX_HOME="$INDEX" TAP_HOME="$TEAMROOT/.tap/bus" \
      bash "$ROOT/bin/tap" refresh peggy >/dev/null 2>"$err" ) || rc=$?
  printf '%s|%s' "$rc" "$(tr '\n' ' ' < "$err")"
}

check() { # <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    printf 'refresh-exit-translation: %s -> %s: ok\n' "$1" "$2"
  else
    printf 'refresh-exit-translation: %s expected [%s] got [%s]\n' "$1" "$3" "$2" >&2
    FAILED=1
  fi
}

# THE TRANSLATION. The engine's 7 must not surface as refresh's 7.
RESULT="$(refresh_rc 7)"
check "engine 7 becomes refresh 8" "${RESULT%%|*}" "8"

# And it must say the seat WAS cleared. The failure branch beside it tells the
# operator the seat is UNCHANGED, which for this state is false in the most
# expensive direction: they would stop looking at a pane that needs looking at.
if printf '%s' "${RESULT#*|}" | grep -q "WAS cleared"; then
  echo "refresh-exit-translation: engine 7 reports the clear HAPPENED: ok"
else
  echo "refresh-exit-translation: engine 7 did not tell the operator the seat was cleared" >&2
  printf '%s\n' "${RESULT#*|}" >&2
  FAILED=1
fi
if printf '%s' "${RESULT#*|}" | grep -q -i "UNCHANGED"; then
  echo "refresh-exit-translation: engine 7 wrongly reported the seat UNCHANGED" >&2
  FAILED=1
else
  echo "refresh-exit-translation: engine 7 does not claim the seat is unchanged: ok"
fi

# PASSTHROUGH, the other half. Codes refresh has not claimed keep their meaning —
# a layer that renumbers everything is as wrong as one that renumbers nothing.
# 2 is the engine's `clear_in_progress`, which means nothing changed.
check "engine 2 passes through" "$(refresh_rc 2 | cut -d'|' -f1)" "2"
check "engine 1 passes through" "$(refresh_rc 1 | cut -d'|' -f1)" "1"
check "engine 0 succeeds"       "$(refresh_rc 0 | cut -d'|' -f1)" "0"

# ── THE SECOND TRANSLATION SITE (--fresh, Phase B) ───────────────────────────
# There are TWO places refresh translates, and until this arm existed only the
# default path was pinned. Proven by the review gate rather than argued: disabling
# the --fresh site left the FULL 122-file suite green, so deleting that branch
# would ship an engine 7 into the UNCHANGED failure message — the expensive-
# direction lie this PR's own rationale names — with nothing red anywhere.
#
# A translation with two sites and one arm is a translation with one site.
FRESH_ERR="$WORK/fresh.err"
fresh_rc() { # <engine exit code> ; echoes "<refresh rc>"
  stub_engine "$1"
  local rc=0
  ( cd "$TEAMROOT" && env -u TMUX -u TMUX_PANE PATH="$WORK/bin:$PATH" \
      TAP_INDEX_HOME="$INDEX" TAP_HOME="$TEAMROOT/.tap/bus" \
      bash "$ROOT/bin/tap" refresh peggy --fresh >/dev/null 2>"$FRESH_ERR" ) || rc=$?
  printf '%s' "$rc"
}
check "engine 7 becomes refresh 8 under --fresh" "$(fresh_rc 7)" "8"
if grep -q "WAS cleared" "$FRESH_ERR"; then
  echo "refresh-exit-translation: --fresh engine 7 reports the clear HAPPENED: ok"
else
  echo "refresh-exit-translation: --fresh engine 7 did not say the seat was cleared" >&2
  cat "$FRESH_ERR" >&2
  FAILED=1
fi
# Retirement must NOT have run: an unconfirmed return is not a verified clear, so
# the seat keeps its instance and no tombstone exists. Asserting the exit code
# alone would pass on an implementation that translated the code AFTER retiring.
if [ -d "$TEAMROOT/.tap/team-history" ] && [ -n "$(ls -A "$TEAMROOT/.tap/team-history" 2>/dev/null)" ]; then
  echo "refresh-exit-translation: --fresh retired the instance despite an unconfirmed clear" >&2
  FAILED=1
else
  echo "refresh-exit-translation: --fresh retires nothing on an unconfirmed clear: ok"
fi

[ "$FAILED" = 0 ] || exit 1
echo "refresh-exit-translation: ok"
