#!/usr/bin/env bash
# fold.sh - apply explicit proposal payload files through the collab ledger.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=skills/discuss/scripts/thread-lib.sh
. "$DIR/thread-lib.sh"

tid="${1:?usage: fold.sh <thread_id> <payload-file>... --by <driver>}"
shift

by=""
quiet=0
payloads=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --by) by="${2:-}"; shift 2 ;;
    --quiet) quiet=1; shift ;;
    --*) die "fold.sh: unknown option '$1'" ;;
    *) payloads+=("$1"); shift ;;
  esac
done

[ -n "$by" ] || die "fold.sh: --by <driver> is required"
if ! assert_driver "$tid" "$by"; then
  exit 1  # assert_driver already printed the REJECT diagnostic
fi

# ${payloads[@]+...} guards the empty-array case: under bash 3.2 with set -u a bare
# "${payloads[@]}" on an empty array is an unbound-variable error. env bash is 5.x here,
# so this is insurance rather than a live fix -- and a no-payload fold is a legitimate
# no-op call, not a misuse worth dying on.
exec python3 -I - "$COLLAB_DIR" "$DIR" "$tid" "$by" "$quiet" ${payloads[@]+"${payloads[@]}"} <<'PY'
import json, os, re, subprocess, sys

collab_dir, script_dir, tid, driver, quiet_raw = sys.argv[1:6]
payload_paths = sys.argv[6:]
quiet = quiet_raw == "1"
sys.path.insert(0, script_dir)
from payload_meta import derive_at, parse_payload, proposal_ops

def die(msg):
    sys.exit(f"collab/fold: {msg}")

if not re.match(r"\A[A-Za-z0-9][A-Za-z0-9_-]*\Z", tid or ""):
    die(f"invalid thread_id {tid!r}")

thread_dir = os.path.join(collab_dir, "threads", tid)
messages_dir = os.path.join(thread_dir, "messages")
processed_path = os.path.join(thread_dir, "processed_payload_ids")
os.makedirs(messages_dir, exist_ok=True)

def load_processed():
    if not os.path.exists(processed_path):
        return set()
    with open(processed_path) as fh:
        return {line.strip() for line in fh if line.strip()}

def save_processed(processed):
    os.makedirs(os.path.dirname(processed_path), exist_ok=True)
    tmp = f"{processed_path}.tmp.{os.getpid()}"
    with open(tmp, "w") as fh:
        for payload_id in sorted(processed):
            fh.write(payload_id + "\n")
    os.replace(tmp, processed_path)

HANDLE_RE = re.compile(r"\A[a-z0-9][a-z0-9_-]*\Z")  # must match ledger.sh's read-time check
ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_.-]*\Z")

def malformed_payload_id(path):
    payload_id = os.path.splitext(os.path.basename(path))[0]
    return payload_id if ID_RE.match(payload_id) else "<unknown>"

def write_message(payload_id, metadata, at):
    # The message record is the durable substrate the anti-sycophancy replay
    # validates evidence stamps against — so a colliding id must fail loud
    # (matching ledger.sh's duplicate-id posture), never silently rewrite
    # an already-recorded from/at.
    message = {
        "id": payload_id,
        "thread_id": tid,
        "trace": {"thread_id": tid},
        "kind": metadata.get("kind") or "proposal",
        "from": metadata.get("from") or "",
        "at": at,
    }
    if not message["from"]:
        message.pop("from")
    path = os.path.join(messages_dir, f"{payload_id}.json")
    if os.path.exists(path):
        with open(path) as fh:
            existing = json.load(fh)
        if {k: v for k, v in existing.items() if k != "at"} == {k: v for k, v in message.items() if k != "at"}:
            return  # identical re-record (crash-retry) — keep the original at
        die(f"message id collision for {payload_id!r}: an existing message record differs; refusing to rewrite it")
    with open(path, "w") as fh:
        json.dump(message, fh)

def ledger(args):
    return subprocess.run(
        ["bash", os.path.join(script_dir, "ledger.sh"), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "COLLAB_DIR": collab_dir},
    )

source_ids_rc = ledger(["source-ids", tid, "--by", driver])
if source_ids_rc.returncode != 0:
    sys.stderr.write(source_ids_rc.stderr.decode("utf-8", "replace"))
    die("failed to read ledger source ids")
ledger_source_ids = {line.strip() for line in source_ids_rc.stdout.decode("utf-8", "replace").splitlines() if line.strip()}
processed = load_processed()

applied = []
rejected = []
malformed = []
skipped = []

for path in payload_paths:
    try:
        payload_id, body, metadata = parse_payload(path)
    except (OSError, ValueError) as exc:
        payload_id = malformed_payload_id(path)
        malformed.append((payload_id, str(exc)))
        continue
    if payload_id in processed or payload_id in ledger_source_ids:
        # Skip BEFORE any disk write, so a crash-retry re-fold is a true no-op.
        processed.add(payload_id)
        skipped.append((payload_id, "already processed"))
        continue
    from_handle = metadata.get("from") or ""
    if from_handle and not HANDLE_RE.match(from_handle):
        # Enforce the read boundary's invariant at the write boundary: a poison
        # `from` would otherwise crash the driver's own later evidence replay.
        malformed.append((payload_id, f"invalid from handle {from_handle!r}"))
        continue
    at = derive_at(payload_id, body, metadata)
    if not at:
        malformed.append((payload_id,
                          "no courier-owned send-time provenance: the canonical TAP payload or its "
                          "matching `.placed` receipt is missing, unreadable, or inconsistent"))
        continue
    write_message(payload_id, metadata, at)
    try:
        ops = proposal_ops(body, payload_id)
    except ValueError as exc:
        malformed.append((payload_id, str(exc)))
        continue

    stopped = False
    for index, (source_id, op) in enumerate(ops):
        label = payload_id if source_id == payload_id else f"{payload_id} op[{index}]"
        if stopped:
            skipped.append((label, "not attempted after earlier failure; still pending"))
            continue
        if source_id in processed or source_id in ledger_source_ids:
            processed.add(source_id)
            skipped.append((label, "already processed"))
            continue
        if not isinstance(op, dict):
            malformed.append((label, "operation must be a JSON object"))
            stopped = True
            continue
        fields = ("op", "item_id", "status", "evidence_class", "evidence", "rationale", "new_status", "evidence_ref")
        invalid = next((field for field in fields if field in op and not isinstance(op[field], str)), None)
        if invalid:
            malformed.append((label, f"{invalid} must be a string"))
            stopped = True
            continue
        kind = op.get("op")
        item_id = op.get("item_id") or ""
        if not item_id:
            malformed.append((label, "missing item_id"))
            stopped = True
            continue
        if kind == "add":
            rc = ledger(["add", tid, item_id, op.get("status") or "proposed",
                         op.get("evidence_class") or "", op.get("evidence") or "", op.get("rationale") or "",
                         "--by", driver, "--source-msg-id", source_id])
        elif kind == "transition":
            evidence_ref = op.get("evidence_ref") or ""
            if evidence_ref == payload_id or evidence_ref.startswith(f"{payload_id}@"):
                rejected.append((label, item_id, "reversal evidence must cite a message that pre-exists the proposal"))
                stopped = True
                continue
            rc = ledger(["transition", tid, item_id, op.get("new_status") or "", evidence_ref,
                         op.get("rationale") or "", "--by", driver, "--source-msg-id", source_id])
        else:
            malformed.append((label, f"unknown op {kind!r}"))
            stopped = True
            continue

        if rc.returncode == 0:
            # The ledger stamp survives a crash before save_processed. Failed ops
            # never get either bookmark (tap-yegvg); their ordered tail stays pending.
            processed.add(source_id)
            applied.append((label, kind, item_id, rc.stdout.decode("utf-8", "replace").strip()))
        else:
            rejected.append((label, item_id, rc.stderr.decode("utf-8", "replace").strip()))
            stopped = True
    if not stopped:
        processed.add(payload_id)

save_processed(processed)

if not quiet:
    for payload_id, kind, item_id, detail in applied:
        print(f"collab/fold: {tid} - APPLIED payload {payload_id}: {kind} {item_id} ({detail})")
    for payload_id, item_id, reason in rejected:
        print(f"collab/fold: {tid} - REJECTED payload {payload_id} for {item_id}: {reason}")
    for payload_id, reason in malformed:
        print(f"collab/fold: {tid} - SKIPPED malformed payload {payload_id}: {reason}")
    for payload_id, reason in skipped:
        print(f"collab/fold: {tid} - SKIPPED payload {payload_id}: {reason}")
    print(f"COLLAB_FOLD thread={tid} driver={driver} applied={len(applied)} rejected={len(rejected)} malformed={len(malformed)} skipped={len(skipped)}")

# A fold that could not apply what it was handed did not succeed. Exiting 0 let a
# silent failure read as a no-op to any caller checking status (tap-yegvg). Nothing
# unapplied is bookmarked, so the payload stays visibly pending and a repaired file
# re-folds normally.
if rejected or malformed:
    sys.exit(1)
PY
