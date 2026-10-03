#!/usr/bin/env bash
# is-converged.sh - deterministic collab convergence check.
#
# Exit codes:
#   0 converged
#   1 keep looping
#   2 round cap reached
#   3 non-driver caller, or unreadable thread state (fail loud, never OPEN)

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=skills/discuss/scripts/thread-lib.sh
. "$DIR/thread-lib.sh"

tid="${1:?usage: is-converged.sh <thread_id> [round_cap] --by <driver>}"
shift

round_cap=8
by=""
if [ "${1:-}" != "" ] && [[ "${1:-}" != --* ]]; then
  round_cap="$1"
  shift
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --by) by="${2:-}"; shift 2 ;;
    --*)  die "is-converged.sh: unknown option '$1'" ;;
    *)    die "is-converged.sh: unexpected positional '$1'" ;;
  esac
done

[ -n "$by" ] || die "is-converged.sh: --by <driver> is required"
if ! assert_driver "$tid" "$by"; then
  exit 3  # assert_driver already printed the REJECT diagnostic
fi

exec python3 -I - "$COLLAB_DIR" "$DIR" "$tid" "$round_cap" "$by" <<'PY'
import json, os, re, subprocess, sys

collab_dir, script_dir, tid, round_cap_raw, driver = sys.argv[1:6]
OPEN = {"proposed", "accepted"}
sys.path.insert(0, script_dir)
from payload_meta import parse_payload, proposal_ops

def die(msg):
    sys.exit(f"collab/is-converged: {msg}")

if not re.match(r"\A[A-Za-z0-9][A-Za-z0-9_-]*\Z", tid or ""):
    die(f"invalid thread_id {tid!r}")
if not re.match(r"\A(0|[1-9][0-9]*)\Z", round_cap_raw or ""):
    die(f"round_cap must be a non-negative integer, got {round_cap_raw!r}")
round_cap = int(round_cap_raw)
thread_dir = os.path.join(collab_dir, "threads", tid)

ledger_rc = subprocess.run(
    ["bash", os.path.join(script_dir, "ledger.sh"), "list", tid, "--by", driver],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env={**os.environ, "COLLAB_DIR": collab_dir},
)
if ledger_rc.returncode != 0:
    # Unreadable/corrupt ledger is ERROR (exit 3), never OPEN — a driver must
    # not loop forever on a broken thread (loop-contract.md termination table).
    sys.stderr.write(ledger_rc.stderr.decode("utf-8", "replace"))
    sys.stderr.write(f"collab/is-converged: ledger unreadable for {tid!r} - fail loud, not OPEN\n")
    sys.exit(3)

open_items = []
total_items = 0
for line in ledger_rc.stdout.decode("utf-8", "replace").splitlines():
    if not line.strip():
        continue
    item = json.loads(line)
    total_items += 1
    if item.get("status") in OPEN or item.get("open"):
        open_items.append(item.get("id", "<unknown>"))

processed_path = os.path.join(thread_dir, "processed_payload_ids")
processed = set()
if os.path.exists(processed_path):
    with open(processed_path) as fh:
        processed = {line.strip() for line in fh if line.strip()}

# An append may survive a crash before fold saves its bookmark file. Recover the
# same per-op source stamps fold uses, through the ledger's validated read path.
sources_rc = subprocess.run(
    ["bash", os.path.join(script_dir, "ledger.sh"), "source-ids", tid, "--by", driver],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env={**os.environ, "COLLAB_DIR": collab_dir},
)
if sources_rc.returncode != 0:
    sys.stderr.write(sources_rc.stderr.decode("utf-8", "replace"))
    sys.exit(3)
processed.update(sources_rc.stdout.decode("utf-8", "replace").splitlines())

proposal_dir = os.path.join(thread_dir, "proposals")
pending = []
if os.path.isdir(proposal_dir):
    for name in sorted(os.listdir(proposal_dir)):
        if name.startswith("."):
            continue
        path = os.path.join(proposal_dir, name)
        if not os.path.isfile(path):
            continue
        processed_stem = os.path.splitext(name)[0]
        if processed_stem in processed:
            continue
        try:
            pid, body, _ = parse_payload(path)
            if pid in processed:
                continue
            ops = proposal_ops(body, pid)
        except (OSError, ValueError) as exc:
            sys.stderr.write(f"collab/is-converged: unreadable proposal {path}: {exc}\n")
            sys.exit(3)
        if any(source_id not in processed for source_id, _ in ops):
            pending.append(pid)

round_path = os.path.join(thread_dir, "round")
current_round = 0
if os.path.exists(round_path):
    raw = open(round_path).read().strip()
    if not re.match(r"\A(0|[1-9][0-9]*)\Z", raw):
        die(f"corrupt round file {round_path} ({raw!r})")
    current_round = int(raw)

if total_items == 0:
    print(f"COLLAB_OPEN thread={tid} open=0 pending={len(pending)} round={current_round} items=0")
    sys.exit(1)

if not open_items and not pending:
    print(f"COLLAB_CONVERGED thread={tid} open=0 pending=0 round={current_round}")
    sys.exit(0)

if current_round >= round_cap:
    print(f"COLLAB_CAP_REACHED thread={tid} open={len(open_items)} pending={len(pending)} round={current_round} cap={round_cap}")
    sys.exit(2)

print(f"COLLAB_OPEN thread={tid} open={len(open_items)} pending={len(pending)} round={current_round} cap={round_cap}")
sys.exit(1)
PY
