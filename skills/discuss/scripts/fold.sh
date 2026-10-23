#!/usr/bin/env bash
# fold.sh - apply explicit proposal payload files through the collab ledger.
#
# Several senders may propose on one thread. When metadata.json declares `peers`
# (a map of handle -> hyphen-free item-id alias, the driver included), a sender's
# `add` must use `<alias>-…` and an add from a sender outside the map is refused;
# the driver maps a late joiner before folding its payload. A thread without
# `peers` behaves as before. Across the payloads of one invocation, and against ledger events a payload
# could not have seen (folded after the payload was placed), two senders moving one
# item to different statuses are a CONFLICT: neither op applies, both are reported
# and stay pending, and the driver adjudicates with its own transition, then disposes
# the two ops (dispose.sh); like any unapplied op, a conflict stops the payload's
# ordered tail until it is disposed, because a later op may rest on its premise.

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
import datetime, json, os, re, subprocess, sys

collab_dir, script_dir, tid, driver, quiet_raw = sys.argv[1:6]
payload_paths = sys.argv[6:]
quiet = quiet_raw == "1"
sys.path.insert(0, script_dir)
from payload_meta import derive_at, load_dispositions, parse_payload, proposal_ops

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
ALIAS_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_]*\Z")  # no '-': the alias ends at the first '-'

def disposed_ops():
    # Disposed op keys count as processed. dispose.sh writes the record before the
    # bookmark, so reading it here keeps a crash between the two writes recoverable;
    # payload_meta validates every record, since a record is authority to clear work.
    try:
        return set(load_dispositions(thread_dir, tid, driver))
    except ValueError as exc:
        die(f"{exc} (fail loud)")

def load_peers():
    # Optional, additive. Absent -> None (legacy: free-form ids, as before). Present ->
    # a map of bare sender handle -> alias. Any other shape fails loud rather than
    # silently switching the rule off.
    with open(os.path.join(thread_dir, "metadata.json")) as fh:
        metadata = json.load(fh)
    if "peers" not in metadata:
        return None
    peers = metadata["peers"]
    if not isinstance(peers, dict) or not peers:
        die("metadata.json peers must be a non-empty object mapping sender handle -> alias "
            "(a list is not accepted; one shape only)")
    for handle, alias in peers.items():
        if not HANDLE_RE.match(handle or ""):
            die(f"metadata.json peers has an invalid handle {handle!r}")
        if not isinstance(alias, str) or not ALIAS_RE.match(alias):
            die(f"metadata.json peers alias for {handle!r} must match {ALIAS_RE.pattern} (got {alias!r})")
    aliases = list(peers.values())
    if len(set(aliases)) != len(aliases):
        die("metadata.json peers aliases must be unique")
    if driver not in peers:
        die(f"metadata.json peers must include the driver {driver!r}: the driver's own adds share the id namespace")
    return peers

refusals_path = os.path.join(thread_dir, "refusals.ndjson")

def record_refusal(label, source_id, from_handle, op, outcome, reason):
    # Every rejected or conflicted op is recorded before it is reported, so dispose.sh
    # can require proof that a fold refused exactly this op. Malformed ops are not
    # recorded: they are repaired, never disposed.
    record = {
        "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "thread_id": tid,
        "op": source_id,
        "payload_id": source_id.split("#", 1)[0],
        "from": from_handle,
        "kind": op.get("op") if isinstance(op, dict) else None,
        "item_id": op.get("item_id") if isinstance(op, dict) else None,
        "outcome": outcome,
        "reason": reason,
        "by": driver,
    }
    with open(refusals_path, "a") as fh:
        fh.write(json.dumps(record) + "\n")

def message_index():
    # {payload_id: (from, at)} for folded proposals; the conflict test needs the
    # sender and placed time behind an event's source_msg_id.
    out = {}
    if os.path.isdir(messages_dir):
        for name in os.listdir(messages_dir):
            if name.startswith(".") or not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(messages_dir, name)) as fh:
                    msg = json.load(fh)
            except ValueError:
                die(f"malformed message file {name} while indexing senders (fail loud)")
            if isinstance(msg, dict) and msg.get("id"):
                out[msg["id"]] = (msg.get("from") or "", msg.get("at") or "")
    return out


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
processed = load_processed() | disposed_ops()
peers = load_peers()

applied = []
rejected = []
malformed = []
skipped = []
conflicted = []

# Pass 1: parse and validate every payload and derive its courier placement time, so
# that with `peers` declared the batch applies in placed order and can be preflighted
# for cross-sender conflicts; without `peers` it applies in argument order, as before.
batch = []
for path in payload_paths:
    try:
        payload_id, body, metadata = parse_payload(path)
    except (OSError, ValueError) as exc:
        malformed.append((malformed_payload_id(path), str(exc)))
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
    try:
        ops = proposal_ops(body, payload_id)
    except ValueError as exc:
        write_message(payload_id, metadata, at)
        malformed.append((payload_id, str(exc)))
        continue
    batch.append((at, payload_id, metadata, from_handle, ops))
if peers is not None:
    # Placed order is an n-party rule too; a thread without `peers` keeps the caller's
    # argument order, exactly as before.
    batch.sort(key=lambda entry: (entry[0], entry[1]))

def op_target(op):
    # (item_id, new_status) for a well-formed transition, else None.
    if not isinstance(op, dict) or op.get("op") != "transition":
        return None
    item_id, new_status = op.get("item_id"), op.get("new_status")
    if not isinstance(item_id, str) or not item_id or not isinstance(new_status, str) or not new_status:
        return None
    return item_id, new_status

# Pass 2: preflight. Within this invocation, one item moved to different statuses by
# different senders is contested; every involved op is a CONFLICT and none applies.
positions = {}  # item_id -> {sender: set(statuses)}
for at, payload_id, metadata, from_handle, ops in batch:
    for source_id, op in ops:
        if source_id in processed or source_id in ledger_source_ids:
            continue
        target = op_target(op)
        if target:
            positions.setdefault(target[0], {}).setdefault(from_handle, set()).add(target[1])
notes = []
distinct_senders = {entry[3] for entry in batch}
if peers is None and len(distinct_senders) > 1:
    # A driver who forgot `peers` on an n-peer thread gets no n-party protection; say so.
    notes.append(f"{len(distinct_senders)} distinct proposal senders ({', '.join(sorted(distinct_senders))}) on a thread "
                 "without metadata.json peers; n-party rules (prefixes, conflicts) are off")
contested = set()
if peers is not None:  # n-party semantics are declared by `peers`; a legacy thread folds as before
    for item_id, by_sender in positions.items():
        statuses = set().union(*by_sender.values())
        if len(by_sender) > 1 and len(statuses) > 1:
            contested.add(item_id)

# Against the ledger: an item whose latest transition came from another sender's
# payload folded after this payload was placed is one this sender could not have seen.
# A different status there is a contest, not a reversal.
latest = {}  # item_id -> (status, source_msg_id, at)
events_path = os.path.join(thread_dir, "ledger.ndjson")
if os.path.exists(events_path):
    with open(events_path) as fh:
        for line in fh:
            if line.strip():
                event = json.loads(line)
                if event.get("event") == "transition":  # an add is creation, never a position
                    latest[event.get("id")] = (event.get("status"), event.get("source_msg_id"), event.get("at"))
senders = message_index()

def unseen_contest(from_handle, placed_at, op):
    target = op_target(op)
    if not target:
        return None
    item_id, new_status = target
    current = latest.get(item_id)
    if not current:
        return None
    status, source_msg_id, event_at = current
    if status == new_status:
        return None
    if source_msg_id:
        source_payload = source_msg_id.split("#", 1)[0]
        source_from = senders.get(source_payload, ("", ""))[0]
    else:
        source_from = driver  # a direct driver op: a seed or an adjudication
    if not source_from or source_from == from_handle:
        return None
    if not event_at or event_at <= placed_at:
        return None
    return (f"{item_id} is {status!r} by {source_from} ({source_msg_id}, folded {event_at}) "
            f"after this payload was placed {placed_at}; proposes {new_status!r}")

# Pass 3: apply in placed order. A conflicted op is reported and left pending and,
# like a rejected or malformed op, stops the payload's ordered tail: a later op may
# rest on the contested one's premise, and the ops format declares no dependencies.
# Adjudicate, dispose, re-fold; the tail then resumes.
for at, payload_id, metadata, from_handle, ops in batch:
    write_message(payload_id, metadata, at)
    stopped = False
    for index, (source_id, op) in enumerate(ops):
        label = payload_id if source_id == payload_id else f"{payload_id} op[{index}]"
        if stopped:
            skipped.append((label, "not attempted after an earlier failure or conflict; still pending"))
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
        if kind == "transition":
            if item_id in contested:
                others = ", ".join(sorted(sender for sender in positions.get(item_id, {}) if sender != from_handle))
                proposed = op.get("new_status")
                reason = (f"{from_handle} proposes {proposed!r}; {others} propose(s) a different status in this batch; "
                          "neither applied, driver adjudicates")
                record_refusal(label, source_id, from_handle, op, "conflict", reason)
                conflicted.append((label, item_id, reason))
                stopped = True
                continue
            # The unseen-event test is part of the n-party contract: a thread that
            # declares no peers keeps today's last-writer-wins behavior unchanged.
            reason = unseen_contest(from_handle, at, op) if peers is not None else None
            if reason:
                reason = f"{reason}; not applied, driver adjudicates"
                record_refusal(label, source_id, from_handle, op, "conflict", reason)
                conflicted.append((label, item_id, reason))
                stopped = True
                continue
        if kind == "add":
            if peers is not None:
                alias = peers.get(from_handle)
                if alias is None:
                    reason = (f"add from {from_handle!r}, a sender outside metadata.json peers; the driver maps "
                              "a late joiner (handle -> alias) before folding its payload")
                    record_refusal(label, source_id, from_handle, op, "rejected", reason)
                    rejected.append((label, item_id, reason))
                    stopped = True
                    continue
                if not item_id.startswith(alias + "-") or len(item_id) <= len(alias) + 1:
                    reason = (f"add id must use this sender's prefix '{alias}-' (metadata.json peers); "
                              "another sender's or a free-form id would collide")
                    record_refusal(label, source_id, from_handle, op, "rejected", reason)
                    rejected.append((label, item_id, reason))
                    stopped = True
                    continue
            rc = ledger(["add", tid, item_id, op.get("status") or "proposed",
                         op.get("evidence_class") or "", op.get("evidence") or "", op.get("rationale") or "",
                         "--by", driver, "--source-msg-id", source_id])
        elif kind == "transition":
            evidence_ref = op.get("evidence_ref") or ""
            if evidence_ref == payload_id or evidence_ref.startswith(f"{payload_id}@"):
                reason = "reversal evidence must cite a message that pre-exists the proposal"
                record_refusal(label, source_id, from_handle, op, "rejected", reason)
                rejected.append((label, item_id, reason))
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
            # A later payload in this batch may now contest this event.
            if kind == "transition":
                latest[item_id] = (op.get("new_status"), source_id, "9999")  # folded now: after every placed time
            senders[payload_id] = (from_handle, at)
        else:
            reason = rc.stderr.decode("utf-8", "replace").strip()
            record_refusal(label, source_id, from_handle, op, "rejected", reason)
            rejected.append((label, item_id, reason))
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
    for payload_id, item_id, reason in conflicted:
        print(f"collab/fold: {tid} - CONFLICT payload {payload_id} on {item_id}: {reason}")
    for note in notes:
        print(f"collab/fold: {tid} - NOTE {note}")
    print(f"COLLAB_FOLD thread={tid} driver={driver} applied={len(applied)} rejected={len(rejected)} malformed={len(malformed)} skipped={len(skipped)} conflicted={len(conflicted)}")

# A fold that could not apply what it was handed did not succeed. Exiting 0 let a
# silent failure read as a no-op to any caller checking status (tap-yegvg). Nothing
# unapplied is bookmarked, so the payload stays visibly pending and a repaired file
# re-folds normally.
if rejected or malformed or conflicted:
    sys.exit(1)
PY
