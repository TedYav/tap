#!/usr/bin/env bash
# dispose.sh - record that one pending proposal op must not apply, and bookmark it.
#
#   dispose.sh <thread_id> <payload-id>#<index> --reason <text> --by <driver>
#
# A fold leaves an op pending when the ledger refused it (a duplicate add) or when
# two senders contested one item (fold.sh CONFLICT). Nothing else can clear it: the
# copied proposal may not be edited (provenance) or deleted (content loss), and a
# re-fold re-refuses. The driver disposes the op instead: the reason is appended to
# threads/<tid>/dispositions.ndjson FIRST, then the op key joins
# processed_payload_ids. fold.sh and is-converged.sh read both, so a crash between
# the two writes still recovers, and a re-fold resumes the payload's tail.
#
# Disposing closes processing of ONE op. It does not close the finding behind it:
# an adjudicated conflict still needs the driver's own ledger transition citing both
# payloads, and a duplicate add still needs its content on the ledger under the id
# that landed. The canonical payload and its copy stay byte-identical.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=skills/discuss/scripts/thread-lib.sh
. "$DIR/thread-lib.sh"

tid="${1:?usage: dispose.sh <thread_id> <payload-id>#<index> --reason <text> --by <driver>}"
shift
op_key="${1:-}"
[ -n "$op_key" ] && [[ "$op_key" != --* ]] || die "dispose.sh: <payload-id>#<index> is required"
shift

by=""
reason=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --by)     by="${2:-}"; shift 2 ;;
    --reason) reason="${2:-}"; shift 2 ;;
    --*)      die "dispose.sh: unknown option '$1'" ;;
    *)        die "dispose.sh: unexpected positional '$1'" ;;
  esac
done
[ -n "$by" ] || die "dispose.sh: --by <driver> is required"
[ -n "$reason" ] || die "dispose.sh: --reason <text> is required; a disposition without a reason is not a record"
if ! assert_driver "$tid" "$by"; then
  exit 1  # assert_driver already printed the REJECT diagnostic
fi

exec python3 -I - "$COLLAB_DIR" "$DIR" "$tid" "$op_key" "$reason" "$by" <<'PY'
import datetime, fcntl, json, os, re, subprocess, sys

collab_dir, script_dir, tid, op_key, reason, driver = sys.argv[1:7]
sys.path.insert(0, script_dir)
from payload_meta import ID_RE, derive_at, load_dispositions, parse_payload, proposal_ops

def die(msg):
    sys.exit(f"collab/dispose: {msg}")

if not re.match(r"\A[A-Za-z0-9][A-Za-z0-9_-]*\Z", tid or ""):
    die(f"invalid thread_id {tid!r}")
if not reason.strip():
    die("--reason must not be blank; the readers refuse a blank record, so refuse it here before anything is written")

payload_id, _, index_raw = op_key.partition("#")
if not ID_RE.match(payload_id or ""):
    die(f"unsafe payload id in {op_key!r}")
if index_raw and not re.match(r"\A(0|[1-9][0-9]*)\Z", index_raw):
    die(f"op index in {op_key!r} must be a non-negative integer")

thread_dir = os.path.join(collab_dir, "threads", tid)
proposal_path = os.path.join(thread_dir, "proposals", f"{payload_id}.md")
if not os.path.isfile(proposal_path):
    die(f"no such saved proposal {proposal_path}; dispose names an op on a proposal the driver has saved")
try:
    parsed_id, body, metadata = parse_payload(proposal_path)
    ops = proposal_ops(body, parsed_id)
except (OSError, ValueError) as exc:
    die(f"proposal {payload_id} is unreadable ({exc}); repair the copy from the canonical bytes before disposing an op on it")
if parsed_id != payload_id:
    die(f"proposal file {proposal_path} carries id {parsed_id!r}, not {payload_id!r}")
if not derive_at(payload_id, body, metadata):
    # The same provenance bar fold applies: a copy whose body, from or kind differs from
    # the canonical payload names an op the peer may never have sent. Repair it first.
    die(f"proposal {payload_id} has no courier-owned provenance (the copy differs from the canonical payload "
        "or its placed receipt is missing); recopy the canonical bytes before disposing an op on it")
match = [(key, op) for key, op in ops if key == op_key]
if not match:
    die(f"no such op {op_key!r} on proposal {payload_id} (keys: {', '.join(k for k, _ in ops)}); nothing to dispose")
_, op = match[0]

def ledger_source_ids():
    rc = subprocess.run(
        ["bash", os.path.join(script_dir, "ledger.sh"), "source-ids", tid, "--by", driver],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, "COLLAB_DIR": collab_dir},
    )
    if rc.returncode != 0:
        sys.stderr.write(rc.stderr.decode("utf-8", "replace"))
        die("failed to read ledger source ids")
    return {line.strip() for line in rc.stdout.decode("utf-8", "replace").splitlines() if line.strip()}

def refused_by_a_fold():
    # Proof that a fold refused exactly this op: fold.sh records every rejected or
    # conflicted op in refusals.ndjson before reporting it. An op no fold has refused
    # (untouched, or an unattempted tail) is not disposable; re-fold it first.
    path = os.path.join(thread_dir, "refusals.ndjson")
    if not os.path.exists(path):
        return None
    found = None
    with open(path) as fh:
        for number, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except ValueError:
                die(f"malformed refusal record {path}:{number} (fail loud)")
            if not isinstance(record, dict):
                die(f"refusal record {path}:{number} is not an object (fail loud)")
            if record.get("op") == op_key and record.get("thread_id") == tid and record.get("by") == driver \
                    and record.get("payload_id") == payload_id:
                found = record
    return found

def adjudicated_since(refusal):
    # A direct driver transition (no source_msg_id) on the contested item, written after the
    # refusal was recorded. The ledger is read through ledger.sh so its stream validation runs.
    item_id = refusal.get("item_id")
    since = refusal.get("at") or ""
    ledger_path = os.path.join(thread_dir, "ledger.ndjson")
    if not item_id or not os.path.exists(ledger_path):
        return False
    with open(ledger_path) as fh:
        for line in fh:
            if not line.strip():
                continue
            event = json.loads(line)
            if (event.get("id") == item_id and event.get("event") == "transition"
                    and not event.get("source_msg_id") and (event.get("at") or "") > since):
                return True
    return False

dispositions_path = os.path.join(thread_dir, "dispositions.ndjson")
processed_path = os.path.join(thread_dir, "processed_payload_ids")
lock_path = os.path.join(thread_dir, "dispositions.lock")

def read_dispositions():
    try:
        return load_dispositions(thread_dir, tid, driver)
    except ValueError as exc:
        die(f"{exc} (fail loud)")

def read_processed():
    if not os.path.exists(processed_path):
        return set()
    with open(processed_path) as fh:
        return {line.strip() for line in fh if line.strip()}

def save_processed(processed):
    tmp = f"{processed_path}.tmp.{os.getpid()}"
    with open(tmp, "w") as fh:
        for key in sorted(processed):
            fh.write(key + "\n")
    os.replace(tmp, processed_path)

lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o644)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    if op_key in ledger_source_ids():
        die(f"op {op_key!r} already applied to the ledger; an applied op is dispositioned by a ledger transition, not disposed")
    existing = read_dispositions().get(op_key)
    if existing is not None:
        die(f"op {op_key!r} already disposed at {existing.get('at')} ({existing.get('reason')!r}); a second disposition is refused")
    processed = read_processed()
    if op_key in processed:
        die(f"op {op_key!r} is already bookmarked as processed without a ledger stamp or a disposition record; inspect the thread before disposing it")
    refusal = refused_by_a_fold()
    if refusal is None:
        die(f"no fold has refused op {op_key!r} (no record in refusals.ndjson); only a rejected or conflicted op is disposable. "
            "Fold the proposal first; an unattempted tail op resumes on re-fold")
    if refusal.get("outcome") == "conflict":
        # A contest is settled by the driver's own transition on the item, never by which
        # side gets disposed first: disposing one side and re-folding would let the other
        # side apply unopposed. Require that adjudication, written after the refusal.
        if not adjudicated_since(refusal):
            die(f"op {op_key!r} is a conflict on item {refusal.get('item_id')!r} that the driver has not adjudicated: write your own "
                "ledger.sh transition on that item (rationale citing both op keys) after the conflict was reported, then dispose both sides")
    record = {
        "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "thread_id": tid,
        "op": op_key,
        "payload_id": payload_id,
        "from": metadata.get("from") or "",
        "kind": op.get("op") if isinstance(op, dict) else None,
        "item_id": op.get("item_id") if isinstance(op, dict) else None,
        "reason": reason,
        "refused": {"at": refusal.get("at"), "outcome": refusal.get("outcome")},
        "by": driver,
    }
    # Durable record first; the bookmark second. A crash between them leaves a
    # disposition that fold.sh and is-converged.sh already honor.
    with open(dispositions_path, "a") as fh:
        fh.write(json.dumps(record) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    processed.add(op_key)
    save_processed(processed)
finally:
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    os.close(lock_fd)

index_label = f" op[{index_raw}]" if index_raw else ""
print(f"collab/dispose: {tid} - DISPOSED payload {payload_id}{index_label}: {record['kind']} {record['item_id']} ({reason})")
print(f"COLLAB_DISPOSE thread={tid} driver={driver} op={op_key}")
PY
