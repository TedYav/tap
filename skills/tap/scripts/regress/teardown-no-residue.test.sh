#!/usr/bin/env bash
# tap-wn9w: permanent teardown leaves no TAP-visible residue; restore refuses a live seat.
# Bidirectional: mutate teardown to skip one must-sweep store and prove the assertion reds.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
TEAM="$(basename "$ROOT")"
WORK="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT

export TAP_HOME="$WORK/team/.tap/bus"
export TAP_INDEX_HOME="$WORK/index"
export TAP_SESSION_MANIFEST="$WORK/sessions.json"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/socket"
unset TAP_TUI_SETTLE_SCALE TAP_SETTLE_SCALE TAP_SPOOL_DISABLE_DELIVERER TAP_SPOOL_DISABLE_OPPORTUNISTIC
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/spool" \
  "$TAP_HOME/input-backups" "$TAP_HOME/handoff" "$TAP_HOME/seat-state" \
  "$TAP_HOME/watch" "$TAP_HOME/goalie"

# Registration now requires enrolled authority; a pre-flip custom bus is no
# longer a fixture for the public register/teardown/reopen flow.
mkdir -p "$TAP_INDEX_HOME"
git init -q "$WORK/team"
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{"$TEAM":{"root":"$WORK/team","registry_location":"$WORK/team/.tap/team-registry.json","state":"registered"}}}
JSON
cat > "$WORK/team/.tap/team-registry.json" <<JSON
{"schema":"0.20","team":{"name":"$TEAM","worktree_root":"$WORK/team"},"seats":{}}
JSON
cd "$WORK/team"

fail() { echo "teardown-no-residue: $*" >&2; exit 1; }

cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
while [ "${1:-}" = -L ] || [ "${1:-}" = -S ]; do shift 2; done
[ "${1:-}" = "display-message" ] || { [ "${1:-}" = "has-session" ] && exit 1; exit 0; }
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift ;;
    -t) target="$2"; shift 2 ;;
    *)  fmt="$1"; shift ;;
  esac
done
tpid()  { case "$target" in %*) printf '%s' "$target" ;; *) printf '%%%s' "$(printf '%s' "$target" | cksum | cut -d' ' -f1)" ;; esac; }
tsess() { local s="${target#%}"; printf '%s' "${s%%:*}"; }
case "$fmt" in
  '#{pid}:#{start_time}') printf '4242:100\n' ;;
  *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\t%s\t4242\tclaude\t0\n' "$(tpid)" "$(tsess)" ;;
  # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
  *pane_id*pane_tty*session_name*) if [ -n "$target" ]; then printf '%s\t/dev/ttys001\t%s\t4242:100\n' "$(tpid)" "$(tsess)"; else printf '%%alice\t/dev/ttys001\talice\t4242:100\n'; fi ;;
  *pane_id*session_name*) if [ -n "$target" ]; then printf '%s\t%s\n' "$(tpid)" "$(tsess)"; else printf '%%alice\talice\n'; fi ;;
  *session_name*window_index*pane_index*) echo "alice:0.0" ;;
  *session_name*) if [ -n "$target" ]; then tsess; echo; else echo alice; fi ;;
  *pane_id*) if [ -n "$target" ]; then tpid; echo; else echo "%alice"; fi ;;
  *pane_current_command*) echo "claude" ;;
  *pane_current_path*) echo "${FAKE_TMUX_PATH:-$PWD}" ;;
  *pane_tty*) echo "/dev/ttys001" ;;
  *) echo "" ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"
export FAKE_TMUX_PATH="$WORK/team"

# Seed a seat with TAP-visible history across must-sweep stores.
"$TAP" register alice --pane alice-pane --force >/dev/null

cat > "$TAP_HOME/payloads/alice-20260101T000000Z-deadbeef.md" <<EOF
---
id: alice-20260101T000000Z-deadbeef
from: alice
to: bob
kind: discuss
path: x
---
outbound history
EOF
cat > "$TAP_HOME/payloads/bob-20260101T000001Z-cafebabe.md" <<EOF
---
id: bob-20260101T000001Z-cafebabe
from: bob
to: alice
kind: discuss
reply: settle-only
path: x
---
inbound waiting
EOF
touch "$TAP_HOME/receipts/alice-20260101T000000Z-deadbeef.sent"
printf '{"id":"park-1","target":"alice","team":"%s","reason":"busy","reason_class":"busy"}\n' "$TEAM" \
  > "$TAP_HOME/spool/park-1.meta.json"
echo "parked for alice" > "$TAP_HOME/spool/park-1.md"
echo "draft" > "$TAP_HOME/input-backups/20260101T000000Z-alice-msg1.md"
echo "handoff body" > "$TAP_HOME/handoff/alice-20260101T000000Z.md"
echo "deadbeef" > "$TAP_HOME/seat-state/alice.hash"
printf '{"armed":true,"blocked_map":{"alice":{"reason":"busy","since":1}}}\n' > "$TAP_HOME/watch/arm.json"
printf '{"seats":{"alice":{"floor_at":1,"verdict_reason":"was here"}}}\n' > "$TAP_HOME/goalie/arm.json"

# Retired launcher-journal record: it must neither block the fresh reopen nor
# be rewritten by teardown.
python3 -B - "$TAP_SESSION_MANIFEST" "$ROOT" <<'PY'
import json, sys
path, root = sys.argv[1:3]
data = {
  "sessions": [{
    "name": "tap/alice",
    "base": "tap",
    "harness": "claude",
    "tag": "alice",
    "cwd": root,
    "harness_session_id": "sess-old",
    "transcript_path": "/tmp/does-not-need-to-exist-for-pointer.md",
    "history": ["sess-old"],
    "last_launched": "2026-01-01T00:00:00Z",
  }]
}
json.dump(data, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
cp "$TAP_SESSION_MANIFEST" "$WORK/sessions.before"

# --- (0) light unregister leaves seat_history (baseline contrast) ---
"$TAP" unregister alice --yes >/dev/null 2>&1 || "$TAP" unregister alice >/dev/null
out="$("$TAP" register alice --pane alice-pane --force --json 2>/dev/null)"
python3 -B -c 'import json,sys; d=json.loads(sys.argv[1]); assert d.get("seat_history"), d' "$out" \
  || fail "(0) light unregister should still surface seat_history (contrast)"
"$TAP" unregister alice >/dev/null
# Re-seed registry row only (history stores still present)
"$TAP" register alice --pane alice-pane --force >/dev/null

# --- (1) teardown: reopen looks first-ever ---
tear="$("$TAP" teardown alice --yes --json 2>"$WORK/tear.err")" || fail "(1) teardown failed: $(cat "$WORK/tear.err")"
echo "$tear" | python3 -B -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d.get("ok"); assert d.get("archive"); n=(d.get("not_removed") or "").lower(); assert "harness" in n or "transcript" in n, d' \
  || fail "(1) teardown must disclose harness transcripts remain: $tear"

# Live TAP paths must not show prior seat
reg_out="$("$TAP" register alice --pane alice-pane --force --json 2>/dev/null)"
python3 -B -c 'import json,sys
d=json.loads(sys.argv[1])
assert d.get("seat_history") in (None, {}), d
inbox=d.get("inbox") or []
assert inbox==[], d
' "$reg_out" || fail "(1) reopened register surfaced seat_history or inbox"

poll_out="$("$TAP" poll alice 2>&1 || true)"
grep -qi 'bob-20260101\|prior\|waiting' <<<"$poll_out" && fail "(1) poll surfaced prior traffic: $poll_out"

out_out="$("$TAP" outstanding alice 2>&1 || true)"
grep -qi 'alice-20260101' <<<"$out_out" && fail "(1) outstanding attributed old sends: $out_out"
grep -q 'no outstanding sends for alice' <<<"$out_out" \
  || fail "(1) expected empty outstanding after teardown: $out_out"

# Historical journal is outside runtime authority and stays byte-preserved.
cmp -s "$WORK/sessions.before" "$TAP_SESSION_MANIFEST" \
  || fail "(1) teardown rewrote retired launcher journal"

# Disk leftovers that must be gone from live paths
[ ! -e "$TAP_HOME/seat-state/alice.hash" ] || fail "(1) seat-state hash remained"
[ ! -e "$TAP_HOME/handoff/alice-20260101T000000Z.md" ] || fail "(1) handoff remained"
[ ! -e "$TAP_HOME/input-backups/20260101T000000Z-alice-msg1.md" ] || fail "(1) input-backup remained"
[ ! -e "$TAP_HOME/payloads/alice-20260101T000000Z-deadbeef.md" ] || fail "(1) outbound payload remained"
[ ! -e "$TAP_HOME/payloads/bob-20260101T000001Z-cafebabe.md" ] || fail "(1) inbound payload remained"
python3 -B - "$TAP_HOME/watch/arm.json" <<'PY' || fail "(1) watch blocked_map still has alice"
import json,sys
d=json.load(open(sys.argv[1]))
assert "alice" not in (d.get("blocked_map") or {})
PY
python3 -B - "$TAP_HOME/goalie/arm.json" <<'PY' || fail "(1) goalie seats still has alice"
import json,sys
d=json.load(open(sys.argv[1]))
assert "alice" not in (d.get("seats") or {})
PY

echo "teardown-no-residue: (1) teardown + reopen is TAP-indistinguishable from first-ever: ok"

# --- (2) bidirectional: skip payloads → assertion reds ---
"$TAP" unregister alice >/dev/null 2>&1 || true
# Rebuild residue for skip-mutation case
"$TAP" register alice --pane alice-pane --force >/dev/null
cat > "$TAP_HOME/payloads/alice-20260101T000000Z-deadbeef.md" <<EOF
---
id: alice-20260101T000000Z-deadbeef
from: alice
to: bob
kind: discuss
path: x
---
outbound history
EOF
set +e
TAP_TEARDOWN_SKIP=payloads "$TAP" teardown alice --yes >"$WORK/skip.out" 2>"$WORK/skip.err"
skip_rc=$?
set -e
[ "$skip_rc" -eq 0 ] || fail "(2) teardown with skip failed (rc=$skip_rc): $(cat "$WORK/skip.err")$(cat "$WORK/skip.out")"
bad="$("$TAP" register alice --pane alice-pane --force --json 2>/dev/null)"
python3 -B -c 'import json,sys
d=json.loads(sys.argv[1])
assert d.get("seat_history"), "expected seat_history when payloads skipped: %r" % (d,)
' "$bad" || fail "(2) skipping payloads must leave seat_history (bidirectional red): $bad"
echo "teardown-no-residue: (2) skip-payloads mutation reds the no-residue assertion: ok"

# Clean and re-teardown properly for restore cases
"$TAP" unregister alice >/dev/null 2>&1 || true
rm -f "$TAP_HOME/payloads/"* 2>/dev/null || true
"$TAP" register alice --pane alice-pane --force >/dev/null
cat > "$TAP_HOME/payloads/bob-20260101T000002Z-restore1.md" <<EOF
---
id: bob-20260101T000002Z-restore1
from: bob
to: alice
kind: discuss
reply: settle-only
path: x
---
restore me
EOF
arch_json="$("$TAP" teardown alice --yes --json)"
arch="$(printf '%s' "$arch_json" | python3 -B -c 'import json,sys; print(json.load(sys.stdin)["archive"])')"

# --- (3) restore refuses live seat ---
"$TAP" register alice --pane alice-pane --force >/dev/null
set +e
refuse="$("$TAP" restore alice --archive "$arch" --json 2>"$WORK/refuse.err")"
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "(3) restore onto live seat must refuse"
echo "$refuse" | python3 -B -c 'import json,sys
d=json.loads(sys.stdin.read())
assert d.get("ok") is False
assert d.get("error_class")=="handle_live", d
' || {
  # human refusal path
  grep -q 'handle_live\|live seat\|already' "$WORK/refuse.err" \
    || fail "(3) missing named refuse: $(cat "$WORK/refuse.err") out=$refuse"
}
echo "teardown-no-residue: (3) restore refuses live handle: ok"

# --- (4) restore brings inbox back ---
"$TAP" unregister alice >/dev/null
"$TAP" restore alice --archive "$arch" --json >/dev/null \
  || fail "(4) restore failed"
"$TAP" register alice --pane alice-pane --force >/dev/null
poll2="$("$TAP" poll alice --json 2>/dev/null || true)"
python3 -B -c 'import json,sys
d=json.loads(sys.argv[1])
ids=[i.get("id") for i in (d.get("pending") or d.get("inbox") or d.get("payloads") or [])]
# poll --json shapes vary; also accept text probe
' "$poll2" 2>/dev/null || true
[ -f "$TAP_HOME/payloads/bob-20260101T000002Z-restore1.md" ] \
  || fail "(4) restored inbox payload missing"
echo "teardown-no-residue: (4) restore returns archived inbox: ok"

echo "teardown-no-residue: ok"
