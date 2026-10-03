#!/usr/bin/env bash
# strand-scan-failure.test.sh — tap-team refresh strand report: a transport
# failure must emit a scan-failed warning distinct from a proven-empty strand
# set (review follow-up). The refresh itself stays best-effort
# and successful in both arms.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
STRAND_ROOT="$(mktemp -d)"; TAP_HOME="$STRAND_ROOT"
STRAND_FAKE_BIN="$(mktemp -d)"
# Runner-scratch cleanup only, each root its own short guarded removal
# (r4056441343: no blanket recursive rm over unguarded variables).
cleanup() {
  rm -rf -- "${STRAND_ROOT:?}"
  rm -rf -- "${STRAND_FAKE_BIN:?}"
}
trap cleanup EXIT
export TAP_HOME PATH="$STRAND_FAKE_BIN:$PATH"
export TAP_SESSION_MANIFEST="$TAP_HOME/sessions.json"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$STRAND_FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  list-sessions)
    # demo/doomed is deliberately absent: its exact session is gone, so the
    # refresh trims the row and the strand report fires for it.
    names='demo/live demo/shared demo/legacy demo/revenant'
    for name in $names; do
      if [[ "$*" == *'start_time'* ]]; then printf '%s\t900:100\n' "$name"
      else printf '%s\n' "$name"
      fi
    done
    exit 0
    ;;
  list-panes)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -t) target="${2#=}"; shift 2 ;;
        -F) fmt="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$fmt" == *'start_time'* ]]; then
      case "$target" in
        demo/live)   printf 'demo/live\tdemo/live:0.0\t%%11\tcodex\t111\t900:100\t0\n' ;;
        demo/shared) printf 'demo/shared\tdemo/shared:0.0\t%%23\tcodex\t123\t900:100\t0\n' ;;
        *) exit 1 ;;
      esac
    fi
    exit 0
    ;;
esac
[ "${1:-}" = "display-message" ] || exit 0
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in -p) shift ;; -t) target="${2#=}"; shift 2 ;; *) fmt="$2"; shift ;; esac
done
case "$fmt" in
  *pane_id*) echo "%$(printf '%s' "$target" | cksum | cut -d' ' -f1)" ;;
  *) echo "" ;;
esac
TMUX
chmod +x "$STRAND_FAKE_BIN/tmux"

write_fixture() {
  cat > "$TAP_HOME/registry.json" <<'JSON'
{
  "schema": "0.20", "team": {"name": "demo"},
  "seats": {
    "live": {"status": "active", "delivery": "pane", "session": "demo/live", "pane": "demo/live:0.0", "pane_id": "%11", "harness": "codex"},
    "doomed": {"status": "active", "delivery": "pane", "session": "demo/doomed", "pane": "demo/doomed:0.0", "pane_id": "%12", "harness": "codex"}
  }
}
JSON
}

# Arm 1 — legitimate empty result: the trim fires the strand report, the real
# transport answers [] successfully, and NO scan-failed warning may appear.
write_fixture
out_err="$(mktemp)"
out="$("$TAP" team refresh 2>"$out_err")"
[[ "$out" == *"removed 'doomed'"* ]] || { echo "strand-scan: arm 1 — doomed seat not trimmed" >&2; echo "$out" >&2; exit 1; }
if grep -q "stranded-payload scan failed" "$out_err"; then
  echo "strand-scan: arm 1 — proven-empty scan was falsely reported as failed" >&2
  cat "$out_err" >&2; exit 1
fi
echo "strand-scan: (1) legitimate empty strand set stays silent and refresh succeeds: ok"

# Arm 2 — transport failure: the strand scan's own directory read fails;
# refresh must still succeed (best-effort) but name the scan failure
# explicitly instead of claiming an empty stranded set. A later change retired the
# Bash reporter's `bun ... stranded` child process — the scan is in-process
# now (seat-adopt.ts's eligibleIds), so the analogous failure is EACCES on
# the payloads directory rather than a sabotaged subprocess.
write_fixture
chmod 000 "$TAP_HOME/payloads"
out_err="$(mktemp)"
out="$("$TAP" team refresh 2>"$out_err")"
chmod 755 "$TAP_HOME/payloads"
[[ "$out" == *"removed 'doomed'"* ]] || { echo "strand-scan: arm 2 — doomed seat not trimmed" >&2; echo "$out" >&2; exit 1; }
grep -q "stranded-payload scan failed for 'doomed' (transport failure); stranded set unknown" "$out_err" \
  || { echo "strand-scan: arm 2 — missing distinct scan-failed warning" >&2; cat "$out_err" >&2; exit 1; }
if grep -q "strands 0 unsettled" "$out_err"; then
  echo "strand-scan: arm 2 — failure was masked as a zero-count strand set" >&2
  cat "$out_err" >&2; exit 1
fi
echo "strand-scan: (2) transport failure warns scan-failed, refresh stays successful: ok"

echo "strand-scan: ok"
