#!/usr/bin/env bash
# focused-inventory: optout behavior test of the adoption sweep bound, not a tree scan
# register-adopt-sweep-bound.test.sh — review finding: the locked
# post-release adoption sweep spends ONE batched native subprocess for every
# released handle. The native owner's deadline decides BEFORE starting each
# handle, and a started handle always finishes and reports its REAL count —
# the parent never times out or kills the child after mutation begins, so a
# real adoption can no longer be misread as count 0.
#
# Arm 1 (one subprocess, fail-closed): an argv-recording bun shim answers the
# caps call then fails the single `adopt-batch`; the register must release all
# three forks, invoke seat-adopt exactly once with all three handles (never
# per-handle `adopt`), and warn loudly per handle with grants recorded and no
# epoch bump.
#
# Arm 2 (real batch drives bookkeeping): with the real owner, the same sweep
# rewrites each fork's unsettled mail, prints per-handle adopted lines, and
# bumps the seat epoch from the ACTUAL per-handle counts.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"

# Runner-scratch cleanup only, each root its own short guarded removal
# (r4056441343: no blanket recursive rm over unguarded variables).
ROOT1=""; BIN1=""; ROOT2=""; BIN2=""; ROOT3=""; BIN3=""
cleanup() {
  [ -n "${ROOT1:-}" ] && rm -rf -- "${ROOT1:?}"
  [ -n "${BIN1:-}" ] && rm -rf -- "${BIN1:?}"
  [ -n "${ROOT2:-}" ] && rm -rf -- "${ROOT2:?}"
  [ -n "${BIN2:-}" ] && rm -rf -- "${BIN2:?}"
  [ -n "${ROOT3:-}" ] && rm -rf -- "${ROOT3:?}"
  [ -n "${BIN3:-}" ] && rm -rf -- "${BIN3:?}"
  return 0
}
trap cleanup EXIT
ROOT1="$(mktemp -d)"; BIN1="$(mktemp -d)"
ORIG_PATH="$PATH"
export TMUX="/fake/socket"

stage_tmux_shim() {
  cat > "$1/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "list-panes" ] && {
  for p in 0.0 0.1 0.2 0.3; do
    case " ${FAKE_DEAD_PANES:-} " in *" ${FAKE_SESSION:-alpha}:$p "*) continue ;; esac
    printf '%s\t%s:%s\t%%%s\tcodex\t4242\t4242:100\t0\n' "${FAKE_SESSION:-alpha}" "${FAKE_SESSION:-alpha}" "$p" "$(printf '%s:%s' "${FAKE_SESSION:-alpha}" "$p" | cksum | cut -d' ' -f1)"
  done
  exit 0
}
[ "${1:-}" = "list-sessions" ] && { printf '%s\t4242:100\t1\n' "${FAKE_SESSION:-alpha}"; exit 0; }
[ "${1:-}" = "display-message" ] || exit 0
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
if [ -n "$target" ]; then
  case " ${FAKE_DEAD_PANES:-} " in *" $target "*) echo "can't find pane: $target" >&2; exit 1 ;; esac
fi
tpid()  { case "$target" in %*) printf '%s' "$target" ;; *) printf '%%%s' "$(printf '%s' "$target" | cksum | cut -d' ' -f1)" ;; esac; }
tsess() { local s="${target#%}"; printf '%s' "${s%%:*}"; }
case "$fmt" in
  *pane_id*session_name*pane_pid*pane_current_command*) if [ -n "$target" ]; then printf '%s\t%s\t4242\tcodex\t0\n' "$(tpid)" "$(tsess)"; else printf '%%900\t%s\t4242\tcodex\t0\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *pid*start_time*)       echo "4242:100" ;;
  *socket_path*)          echo "${TMUX:-/tmp/tmux-$(id -u)/default}" ;;
  *pane_id*pane_tty*session_name*) if [ -n "$target" ]; then printf '%s\t/dev/faketty\t%s\t4242:100\n' "$(tpid)" "$(tsess)"; else printf '%%900\t/dev/faketty\t%s\t4242:100\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *pane_id*session_name*) if [ -n "$target" ]; then printf '%s\t%s\n' "$(tpid)" "$(tsess)"; else printf '%%900\t%s\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *window_index*)         echo "${FAKE_SESSION:-alpha}:0.0" ;;
  *session_name*)         if [ -n "$target" ]; then tsess; echo; else echo "${FAKE_SESSION:-alpha}"; fi ;;
  *pane_id*)              if [ -n "$target" ]; then tpid; echo; else echo "%900"; fi ;;
  *pane_current_command*) echo "codex" ;;
  *pane_current_path*)    echo "${FAKE_TMUX_PATH:-$PWD}" ;;
  *) echo "" ;;
esac
ENDTMUX
  chmod +x "$1/tmux"
}

stage_ps_shim() {
  printf '#!/usr/bin/env bash\nprintf %s\n' "'1 faketty\\n'" > "$1/ps"
  chmod +x "$1/ps"
}

has_agent() { python3 -B - "$1/registry.json" "$2" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
sys.exit(0 if sys.argv[2] in (reg.get("seats") or {}) else 1)
PY
}

register_forks() {
  local home="$1"
  mkdir -p "$home/team"
  git -C "$home/team" init -q
  tap_smoke_enroll_current "$home/team" "$home"
  cd "$home/team"
  FAKE_SESSION="alpha" TAP_HOME="$home" tap_smoke_quiet "$TAP" register fable-2 --pane alpha:0.1 \
    || { echo "adopt-batch: setup — fable-2 register failed" >&2; exit 1; }
  FAKE_SESSION="alpha" TAP_HOME="$home" tap_smoke_quiet "$TAP" register fable-3 --pane alpha:0.2 \
    || { echo "adopt-batch: setup — fable-3 register failed" >&2; exit 1; }
  FAKE_SESSION="alpha" TAP_HOME="$home" tap_smoke_quiet "$TAP" register fable-4 --pane alpha:0.3 \
    || { echo "adopt-batch: setup — fable-4 register failed" >&2; exit 1; }
}

addr_pane() { printf '%%%s' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"; }

# --- Arm 1: ONE subprocess, fail-closed per handle -------------------------
export TAP_HOME="$ROOT1"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"
REAL_BUN="$(command -v bun)"
export PATH="$BIN1:$PATH"
stage_tmux_shim "$BIN1"; stage_ps_shim "$BIN1"
cat > "$BIN1/bun" <<ENDSHIM
#!/usr/bin/env bash
case "\$1" in
  *seat-adopt.ts)
    printf '%s\n' "\$2" >> "$BIN1/adopt-calls.log"
    case "\$2" in
      caps) exec "$REAL_BUN" "\$@" ;;
      *) exit 1 ;;  # the batch transport fails outright: fail closed, loudly
    esac ;;
esac
exec "$REAL_BUN" "\$@"
ENDSHIM
chmod +x "$BIN1/bun"
FAKE_TMUX_PATH="$TAP_HOME/team" register_forks "$ROOT1"

set +e
OUT1="$(FAKE_SESSION="alpha" FAKE_TMUX_PATH="$TAP_HOME/team" FAKE_DEAD_PANES="alpha:0.1 alpha:0.2 alpha:0.3 $(addr_pane alpha:0.1) $(addr_pane alpha:0.2) $(addr_pane alpha:0.3)" \
       "$TAP" register fable --pane alpha:0.9 2>&1)"
rc1=$?
set -e
[ "$rc1" -eq 0 ] || { echo "adopt-batch: arm 1 register failed (rc $rc1)" >&2; echo "$OUT1" >&2; exit 1; }
has_agent "$ROOT1" fable    || { echo "adopt-batch: arm 1 — fable not registered" >&2; exit 1; }
for h in fable-2 fable-3 fable-4; do
  ! has_agent "$ROOT1" "$h" || { echo "adopt-batch: arm 1 — $h was not released" >&2; exit 1; }
  case "$OUT1" in *"released stale $h"*) ;; *) echo "adopt-batch: arm 1 — missing release record for $h" >&2; echo "$OUT1" >&2; exit 1 ;; esac
done
[ -f "$BIN1/adopt-calls.log" ] || { echo "adopt-batch: arm 1 — seat-adopt was never invoked" >&2; exit 1; }
grep -q '^caps$' "$BIN1/adopt-calls.log" || { echo "adopt-batch: arm 1 — caps call missing" >&2; cat "$BIN1/adopt-calls.log" >&2; exit 1; }
[ "$(grep -c '^adopt-batch$' "$BIN1/adopt-calls.log")" -eq 1 ] \
  || { echo "adopt-batch: arm 1 — expected exactly ONE adopt-batch call, got:" >&2; cat "$BIN1/adopt-calls.log" >&2; exit 1; }
[ "$(grep -c '^adopt$' "$BIN1/adopt-calls.log")" -eq 0 ] \
  || { echo "adopt-batch: arm 1 — per-handle adopt calls must not exist, got:" >&2; cat "$BIN1/adopt-calls.log" >&2; exit 1; }
BATCH_LINE="$(grep '^adopt-batch$' "$BIN1/adopt-calls.log" || true)"
[ -n "$BATCH_LINE" ] || { echo "adopt-batch: arm 1 — no adopt-batch call" >&2; exit 1; }
for h in fable-2 fable-3 fable-4; do
  case "$OUT1" in
    *"adoption owner unavailable; payload(s) addressed to $h"*) : ;;
    *) echo "adopt-batch: arm 1 — no fail-closed warning for $h" >&2; echo "$OUT1" >&2; exit 1 ;;
  esac
done
case "$OUT1" in *"adopted "*payload*from*) echo "adopt-batch: arm 1 — failed transport must not claim adoptions" >&2; echo "$OUT1" >&2; exit 1 ;; esac
python3 -B - "$ROOT1/registry.json" <<'PY' || exit 1
import json, sys
reg = json.load(open(sys.argv[1]))
row = (reg.get("seats") or {}).get("fable") or {}
grants = row.get("adopted_handles") or []
assert set(["fable-2", "fable-3", "fable-4"]) <= set(grants), f"grants missing: {grants}"
assert not row.get("session_epoch"), f"epoch must not move without mail: {row.get('session_epoch')}"
PY
echo "adopt-batch: arm 1 — one batched subprocess, all three handles failed closed loudly: ok"

# --- Arm 2: the real batch drives grants/epoch from actual counts ----------
ROOT2="$(mktemp -d)"; BIN2="$(mktemp -d)"
mkdir -p "$ROOT2/payloads" "$ROOT2/receipts"
stage_tmux_shim "$BIN2"; stage_ps_shim "$BIN2"
export PATH="$BIN2:$ORIG_PATH"
export TAP_HOME="$ROOT2"
FAKE_TMUX_PATH="$TAP_HOME/team" register_forks "$ROOT2"
# Unsettled mail for two of the three doomed forks (empty to_team = local).
cat > "$ROOT2/payloads/mail-a.md" <<'EOF'
---
id: mail-a
from: ops
to: fable-2
kind: discuss
reply: expected
---

hand me this
EOF
cat > "$ROOT2/payloads/mail-b.md" <<'EOF'
---
id: mail-b
from: ops
to: fable-3
kind: discuss
reply: expected
---

and this
EOF

set +e
OUT2="$(FAKE_SESSION="alpha" FAKE_TMUX_PATH="$TAP_HOME/team" FAKE_DEAD_PANES="alpha:0.1 alpha:0.2 alpha:0.3 $(addr_pane alpha:0.1) $(addr_pane alpha:0.2) $(addr_pane alpha:0.3)" \
       "$TAP" register fable --pane alpha:0.9 2>&1)"
rc2=$?
set -e
[ "$rc2" -eq 0 ] || { echo "adopt-batch: arm 2 register failed (rc $rc2)" >&2; echo "$OUT2" >&2; exit 1; }
# Real counts drive the bookkeeping: per-handle adopted lines with the epoch.
case "$OUT2" in
  *"adopted 1 payload(s) from fable-2; seat epoch ->"*) : ;;
  *) echo "adopt-batch: arm 2 — fable-2 mail not reported adopted" >&2; echo "$OUT2" >&2; exit 1 ;;
esac
case "$OUT2" in
  *"adopted 1 payload(s) from fable-3; seat epoch ->"*) : ;;
  *) echo "adopt-batch: arm 2 — fable-3 mail not reported adopted" >&2; echo "$OUT2" >&2; exit 1 ;;
esac
grep -q "^to: fable$" "$ROOT2/payloads/mail-a.md" || { echo "adopt-batch: arm 2 — mail-a not rewritten to fable" >&2; exit 1; }
grep -q "^to_adopted_from: fable-2$" "$ROOT2/payloads/mail-a.md" || { echo "adopt-batch: arm 2 — mail-a forensics missing" >&2; exit 1; }
python3 -B - "$ROOT2/registry.json" <<'PY' || exit 1
import json, sys
reg = json.load(open(sys.argv[1]))
row = (reg.get("seats") or {}).get("fable") or {}
assert set(["fable-2", "fable-3", "fable-4"]) <= set(row.get("adopted_handles") or []), row.get("adopted_handles")
# Pre-flip rows carry no instance, so Cluster E predecessor-instance stamps
# cannot exist here; adoption-grant-instance.test.sh covers them flip-live.
assert int(row.get("session_epoch") or 0) >= 2, f"epoch must reflect two mail-moving adoptions: {row.get('session_epoch')}"
PY
echo "adopt-batch: arm 2 — real per-handle counts drove rewrites, grants, and epoch: ok"

# --- Arm 3: a partial batch applies finished counts and warns unknown --------
# r4056441341 isolation control: fork fable-2 finishes (real count drives its
# adopted line + epoch), fable-3 is reported `failed` (unknown outcome — must
# warn UNKNOWN, never "NOT adopted"), fable-4 is missing from the response
# entirely (transport-shaped unavailable warning). Grants still record every
# released handle; only real counts move the epoch.
ROOT3="$(mktemp -d)"; BIN3="$(mktemp -d)"
mkdir -p "$ROOT3/payloads" "$ROOT3/receipts"
stage_tmux_shim "$BIN3"; stage_ps_shim "$BIN3"
export PATH="$BIN3:$ORIG_PATH"
export TAP_HOME="$ROOT3"
FAKE_TMUX_PATH="$TAP_HOME/team" register_forks "$ROOT3"
cat > "$ROOT3/payloads/mail-a.md" <<'EOF'
---
id: mail-a
from: ops
to: fable-2
kind: discuss
reply: expected
---

only this one moves
EOF
cat > "$BIN3/bun" <<ENDSHIM
#!/usr/bin/env bash
case "\$1" in
  *seat-adopt.ts)
    case "\$2" in
      caps) exec "$REAL_BUN" "\$@" ;;
      adopt-batch)
        printf '{"handles":{"fable-2":{"adopted_ids":["mail-a"],"count":1,"remainder":[]}},"skipped":[],"failed":["fable-3"]}\\n'
        exit 0 ;;
      *) exec "$REAL_BUN" "\$@" ;;
    esac ;;
esac
exec "$REAL_BUN" "\$@"
ENDSHIM
chmod +x "$BIN3/bun"

set +e
OUT3="$(FAKE_SESSION="alpha" FAKE_TMUX_PATH="$TAP_HOME/team" FAKE_DEAD_PANES="alpha:0.1 alpha:0.2 alpha:0.3 $(addr_pane alpha:0.1) $(addr_pane alpha:0.2) $(addr_pane alpha:0.3)" \
       "$TAP" register fable --pane alpha:0.9 2>&1)"
rc3=$?
set -e
[ "$rc3" -eq 0 ] || { echo "adopt-batch: arm 3 register failed (rc $rc3)" >&2; echo "$OUT3" >&2; exit 1; }
case "$OUT3" in
  *"adopted 1 payload(s) from fable-2; seat epoch ->"*) : ;;
  *) echo "adopt-batch: arm 3 — fable-2's finished count did not drive its adopted line/epoch" >&2; echo "$OUT3" >&2; exit 1 ;;
esac
case "$OUT3" in
  *"adoption of fable-3 ended in an unknown state"*"may be PARTIALLY adopted"*) : ;;
  *) echo "adopt-batch: arm 3 — fable-3 must warn UNKNOWN, never empty" >&2; echo "$OUT3" >&2; exit 1 ;;
esac
if echo "$OUT3" | grep "were NOT adopted" | grep -q "fable-3"; then
  echo "adopt-batch: arm 3 — failed handle must not be claimed empty/NOT adopted" >&2; echo "$OUT3" >&2; exit 1
fi
case "$OUT3" in
  *"adoption owner unavailable; payload(s) addressed to fable-4 were NOT adopted"*) : ;;
  *) echo "adopt-batch: arm 3 — missing fable-4 result must warn unavailable" >&2; echo "$OUT3" >&2; exit 1 ;;
esac
# mail-a was NOT really rewritten (the shim faked the batch), and the parent
# must not pretend otherwise: the payload keeps its original addressee.
grep -q "^to: fable-2$" "$ROOT3/payloads/mail-a.md" || { echo "adopt-batch: arm 3 — shim world must not rewrite mail" >&2; exit 1; }
python3 -B - "$ROOT3/registry.json" <<'PY' || exit 1
import json, sys
reg = json.load(open(sys.argv[1]))
row = (reg.get("seats") or {}).get("fable") or {}
assert set(["fable-2", "fable-3", "fable-4"]) <= set(row.get("adopted_handles") or []), row.get("adopted_handles")
epoch = int(row.get("session_epoch") or 0)
assert epoch == 1, f"exactly the finished count moves the epoch: {epoch}"
PY
echo "adopt-batch: arm 3 — finished counts applied, unknown outcomes warned, never zero-claimed: ok"
echo "adopt-batch: ok"
