#!/usr/bin/env bash
# tap resend re-rings the SAME message (delivery decision-v1): through the public
# bin/tap door, an unread delivered send is re-parked as a retry row under its
# own id; a read message is a recorded no-op; a send still queued coalesces.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "do not source; run this test through smoke-all --only" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus" TAP_INDEX_HOME="$WORK/index"
export TAP_SPOOL_DISABLE_OPPORTUNISTIC=1 TAP_SPOOL_DISABLE_DELIVERER=1
mkdir -p "$TAP_HOME"/{spool,payloads,receipts,archive} "$WORK/repo" "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
cat > "$TAP_HOME/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"t","worktree_root":"$WORK/repo"},"seats":{"alice":{"delivery":"poll","status":"active","harness":"codex"},"peer":{"delivery":"pane","status":"active","harness":"codex","pane":"t:0.0","pane_id":"%9","server_epoch":"srv:1:1"}}}
JSON
fail() { echo "resend-same-id: FAIL — $*" >&2; exit 1; }
payload() { # <dir> <id>
  printf -- '---\nid: %s\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\n---\nbody %s\n' "$2" "$2" > "$TAP_HOME/$1/$2.md"
}

# (1) Delivered but unread: the same id is re-parked as a retry row; custody moves to the spool.
payload payloads sent1
printf '{"id":"sent1","effect":"possible"}\n' > "$TAP_HOME/receipts/sent1.attempted"
printf '{"id":"sent1","status":"sent","delivery":"pane"}\n' > "$TAP_HOME/receipts/sent1.sent"
bash "$ROOT/bin/tap" resend sent1 --by alice --json > "$WORK/one" || fail "(1) resend exited $?: $(cat "$WORK/one")"
python3 - "$TAP_HOME" "$WORK/one" <<'PY' || exit 1
import json, sys
from pathlib import Path
bus, out = Path(sys.argv[1]), json.load(open(sys.argv[2]))
assert out["status"] == "queued" and out["id"] == "sent1" and out["ordinal"] == 1, out
meta = json.loads((bus / "spool" / "sent1.meta.json").read_text())
assert meta["reason"] == "retry" and meta["retry"] == out["retry"] and meta["retry_ordinal"] == 1, meta
assert (bus / "spool" / "sent1.md").read_text().endswith("body sent1\n")
assert not (bus / "payloads" / "sent1.md").exists(), "canonical must move, never duplicate"
assert not (bus / "receipts" / "sent1.resent").exists()
rows = [json.loads(l) for l in (bus / "receipts" / "sent1.retries.jsonl").read_text().splitlines()]
assert [(r["event"], r["retry"], r["prior"]["state"], r["prior"]["attempts"]) for r in rows] == [("request", out["retry"], "unobserved", 1)], rows
PY
echo "resend-same-id: (1) an unread delivered send re-parks as a retry row under its own id: ok"

# (2) A second resend coalesces into the queued retry: no new row, no new record.
bash "$ROOT/bin/tap" resend sent1 --by alice > "$WORK/two" || fail "(2) coalesce exited $?"
grep -q '^tap resend: sent1 already queued$' "$WORK/two" || fail "(2) $(cat "$WORK/two")"
[ "$(wc -l < "$TAP_HOME/receipts/sent1.retries.jsonl" | tr -d ' ')" = 1 ] || fail "(2) coalescing wrote a record"
echo "resend-same-id: (2) a second resend coalesces: ok"

# (3) Already read by the recipient: a recorded no-op, exit 0, the reply pointer named.
payload payloads read1
printf '{"id":"read1","effect":"possible"}\n' > "$TAP_HOME/receipts/read1.attempted"
printf '{"id":"read1","by":"peer","at":"2026-10-12T10:00:00Z"}\n' > "$TAP_HOME/receipts/read1.read"
bash "$ROOT/bin/tap" resend read1 --by alice > "$WORK/three" || fail "(3) suppressed resend exited $?"
grep -q "^tap resend: read1 already read; follow up: tap send peer -f <file>$" "$WORK/three" || fail "(3) $(cat "$WORK/three")"
[ ! -e "$TAP_HOME/spool/read1.md" ] || fail "(3) a read message was re-parked"
grep -q '"event": *"suppressed"' "$TAP_HOME/receipts/read1.retries.jsonl" || fail "(3) no suppressed record"
echo "resend-same-id: (3) a read message is a recorded no-op: ok"

# (4) Still queued for its first delivery: coalesces, nothing written.
payload spool queued1
printf '{"id":"queued1","attempts":0,"attempt_fence":1,"reason":"busy"}\n' > "$TAP_HOME/spool/queued1.meta.json"
bash "$ROOT/bin/tap" resend queued1 --by alice > "$WORK/four" || fail "(4) exited $?"
grep -q '^tap resend: queued1 already queued$' "$WORK/four" || fail "(4) $(cat "$WORK/four")"
[ ! -e "$TAP_HOME/receipts/queued1.retries.jsonl" ] || fail "(4) coalescing wrote a record"
echo "resend-same-id: (4) a send still queued coalesces: ok"

# (5) Only the original sender may resend.
if bash "$ROOT/bin/tap" resend read1 --by peer --json > "$WORK/five" 2>&1; then fail "(5) a non-sender resend succeeded"; fi
grep -q '"error_class":"not_sender"' "$WORK/five" || fail "(5) $(cat "$WORK/five")"
echo "resend-same-id: (5) a non-sender is refused: ok"
