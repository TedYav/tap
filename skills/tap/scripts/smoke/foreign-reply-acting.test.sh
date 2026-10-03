#!/usr/bin/env bash
# tap-ltc8: post-flip foreign reply binds the sender team's ACTING registry, never
# the retired bus mirror. Pre-flip path-derived bus route stays in cross-team-reply.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

export TAP_SPOOL_DISABLE_DELIVERER=1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"

WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
export TAP_INDEX_HOME="$WORK/index"
mkdir -p "$TAP_INDEX_HOME" "$FAKE_BIN"

fail() { echo "foreign-reply-acting: $*" >&2; exit 1; }

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_TMUX_STATE:?}"; mkdir -p "$state"
cmd="${1:-}"; shift || true
target=""
case "$cmd" in
  # CONTRACT §Session-name authority: the selected acting registry is authorized
  # only by a current exact-session/pane/generation/harness observation.
  list-sessions)
    printf 'alpha/sentry\t123:456\nbeta/fable\t123:456\n' ;;
  list-panes)
    target=""; while [ "$#" -gt 0 ]; do case "$1" in -t) target="${2#=}"; shift 2 ;; *) shift ;; esac; done
    case "$target" in
      alpha/sentry) printf 'alpha/sentry\tsentry-pane\t%%801\tcodex\t4242\t123:456\t0\n' ;;
      beta/fable) printf 'beta/fable\tfable-pane\t%%802\tcodex\t4242\t123:456\t0\n' ;;
    esac ;;
  display-message)
    fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
    case "$fmt" in
      # Native observer probes: server identity, then the four-field pane record.
      # Answers must agree with the acting registries (%801/%802, srv:123:456).
      *pane_id*session_name*pane_pid*pane_current_command*)
        case "$target" in
          sentry-pane) printf '%s\t%s\t%s\t%s\t0\n' '%801' 'alpha/sentry' '4242' 'codex' ;;
          fable-pane)  printf '%s\t%s\t%s\t%s\t0\n' '%802' 'beta/fable' '4242' 'codex' ;;
          *)           printf '%s\t%s\t%s\t%s\t0\n' '%899' 'alpha/sentry' '4242' 'codex' ;;
        esac ;;
      '#{pid}:#{start_time}') echo '123:456' ;;
      *pane_id*)              case "$target" in sentry-pane) echo '%801' ;; fable-pane) echo '%802' ;; *) echo '%899' ;; esac ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "$state/input" ]; then printf '› %s\n' "$(cat "$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "${1:-}" = "-t" ]; then target="${2:-}"; shift 2; fi
    if [ "${1:-}" = "-l" ]; then shift; [ "${1:-}" = "--" ] && shift
      printf '%s' "${1:-}" > "$state/input"; printf '%s\n' "${1:-}" >> "$state/sent.log"; exit 0; fi
    if [ "${1:-}" = "Enter" ]; then rm -f "$state/input"; exit 0; fi ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"

ALPHA_ROOT="$WORK/alpha"; BETA_ROOT="$WORK/beta"
ALPHA_BUS="$ALPHA_ROOT/.tap/bus"; BETA_BUS="$BETA_ROOT/.tap/bus"
mkdir -p "$ALPHA_BUS/payloads" "$ALPHA_BUS/receipts" "$BETA_BUS/payloads" "$BETA_BUS/receipts"

# Acting registries (post-flip WHO authority) — sentry's CURRENT instance.
cat > "$ALPHA_ROOT/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": {"name": "alpha"},
  "seats": {
    "sentry": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "session": "alpha/sentry", "pane": "sentry-pane", "pane_id": "%801", "server_epoch": "srv:123:456",
      "instance": "sentry|fresh", "registered_at": "t"
    }
  }
}
JSON
cat > "$BETA_ROOT/.tap/team-registry.json" <<JSON
{
  "schema": "0.20",
  "team": {"name": "beta"},
  "seats": {
    "fable": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "session": "beta/fable", "pane": "fable-pane", "pane_id": "%802", "server_epoch": "srv:123:456",
      "instance": "fable|b1", "registered_at": "t"
    }
  }
}
JSON

# Retired bus mirrors — STALE predecessor instance on alpha (the bug bait).
cat > "$ALPHA_BUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "alpha", "worktree_root": "$ALPHA_ROOT"},
  "seats": {
    "sentry": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "sentry-pane", "pane_id": "%sentry",
      "instance": "sentry|PRED"
    }
  }
}
JSON
cat > "$BETA_BUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "beta", "worktree_root": "$BETA_ROOT"},
  "seats": {
    "fable": {
      "status": "active", "delivery": "pane", "harness": "codex",
      "pane": "fable-pane", "pane_id": "%fable",
      "instance": "fable|b1"
    }
  }
}
JSON

# Live flip + both teams enrolled at acting locations.
python3 -B - "$TAP_INDEX_HOME" "$ALPHA_ROOT" "$BETA_ROOT" <<'PY'
import json, pathlib, sys
idx, alpha, beta = map(pathlib.Path, sys.argv[1:4])
(idx / "global-registry.json").write_text(json.dumps({
  "schema": "0.20",
  "teams": {
    "alpha": {
      "root": str(alpha),
      "registry_location": str(alpha / ".tap" / "team-registry.json"),
      "state": "registered",
    },
    "beta": {
      "root": str(beta),
      "registry_location": str(beta / ".tap" / "team-registry.json"),
      "state": "registered",
    },
  },
}) + "\n")
PY

INBOUND_ID="bob-20260731T000000Z-ltc8in0001"
INBOUND="$ALPHA_BUS/payloads/${INBOUND_ID}.md"
cat > "$INBOUND" <<EOF
---
id: $INBOUND_ID
from: sentry
from_team: alpha
to: fable
to_team: beta
kind: discuss
reply: expected
path: $INBOUND
---
cross-team question
EOF

# --- (a) live + enrolled: bind acting instance, not bus PRED ---------------------
export FAKE_TMUX_STATE="$ALPHA_ROOT/fake-tmux"; mkdir -p "$FAKE_TMUX_STATE"
: > "$FAKE_TMUX_STATE/sent.log"
TAP_HOME="$BETA_BUS" "$TAP" reply "$INBOUND" --by fable --team beta -m "acting bind" \
  >"$WORK/reply.out" 2>"$WORK/reply.err" \
  || fail "(a) reply failed: $(cat "$WORK/reply.err")$(cat "$WORK/reply.out")"
[ -f "$ALPHA_BUS/receipts/${INBOUND_ID}.done" ] \
  || fail "(a) inbound not settled on sender bus"

# Outbound reply lives on beta bus; recipient_instance must be sentry|fresh.
out_payload="$(find "$BETA_BUS/payloads" -maxdepth 1 -name '*.md' ! -name '_*' | head -1)"
[ -n "$out_payload" ] || fail "(a) no outbound reply payload on beta bus"
rinst="$(python3 -c 'import sys; from pathlib import Path
p=Path(sys.argv[1]).read_text().split("---",2)
import re
m=re.search(r"(?m)^recipient_instance:\s*(\S+)", p[1])
print(m.group(1) if m else "")
' "$out_payload")"
[ "$rinst" = "sentry|fresh" ] \
  || fail "(a) recipient_instance want sentry|fresh (acting), got '$rinst' — bus PRED still bound?"
[ "$rinst" != "sentry|PRED" ] || fail "(a) bound the retired bus PRED instance"
echo "foreign-reply-acting: (a) live+enrolled binds acting instance (not bus PRED): ok"

# --- (b) live + unenrolled sender team: refuse, do not use bus mirror -----------
# Drop alpha from global enrollment; leave bus mirror present (the trap).
python3 -B - "$TAP_INDEX_HOME" "$BETA_ROOT" <<'PY'
import json, pathlib, sys
idx, beta = map(pathlib.Path, sys.argv[1:3])
(idx / "global-registry.json").write_text(json.dumps({
  "schema": "0.20",
  "teams": {
    "beta": {
      "root": str(beta),
      "registry_location": str(beta / ".tap" / "team-registry.json"),
      "state": "registered",
    },
  },
}) + "\n")
PY
INBOUND_ID2="bob-20260731T000000Z-ltc8in0002"
INBOUND2="$ALPHA_BUS/payloads/${INBOUND_ID2}.md"
cat > "$INBOUND2" <<EOF
---
id: $INBOUND_ID2
from: sentry
from_team: alpha
to: fable
to_team: beta
kind: discuss
reply: expected
path: $INBOUND2
---
should refuse
EOF
: > "$FAKE_TMUX_STATE/sent.log"
set +e
TAP_HOME="$BETA_BUS" "$TAP" reply "$INBOUND2" --by fable --team beta -m "should refuse" \
  >"$WORK/refuse.out" 2>"$WORK/refuse.err"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(b) unenrolled sender must refuse under live marker"
grep -Eiq 'unreachable_team|acting registry|retired bus' "$WORK/refuse.err" "$WORK/refuse.out" \
  || fail "(b) refuse must name acting/unreachable: err=$(cat "$WORK/refuse.err") out=$(cat "$WORK/refuse.out")"
[ ! -f "$ALPHA_BUS/receipts/${INBOUND_ID2}.done" ] \
  || fail "(b) must not settle when acting resolve refused"
# No outbound that stamped PRED
if [ -n "$(find "$BETA_BUS/payloads" -maxdepth 1 -name '*.md' ! -name '_*' -newer "$INBOUND2" -print -quit 2>/dev/null)" ]; then
  for p in "$BETA_BUS/payloads"/*.md; do
    grep -q 'sentry|PRED' "$p" 2>/dev/null && fail "(b) outbound stamped bus PRED after refuse path"
  done
fi
echo "foreign-reply-acting: (b) live+unenrolled refuses (no bus-mirror fallback): ok"

echo "foreign-reply-acting: ok"
