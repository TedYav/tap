#!/usr/bin/env bash
# ledger.sh - driver-owned issue ledger for collab convergence.
#
# Append-only NDJSON at threads/<thread_id>/ledger.ndjson; an item's current state
# is its last event. The ledger is driver-owned thread-authoritative state, so
# every mutator gates at thread-lib.sh assert_driver before touching disk.
#
#   ledger.sh add <tid> <item_id> <status> <evidence_class> <evidence> <rationale> \
#                  --by <h> [--source-msg-id <id>]
#   ledger.sh transition <tid> <item_id> <new_status> [evidence_ref] [rationale] \
#                  --by <h> [--source-msg-id <id>]
#   ledger.sh list <tid> --by <h>        # current state, one JSON/line
#   ledger.sh source-ids <tid> --by <h>  # every source_msg_id on the ledger, one/line
#
# status         ∈ proposed|accepted|rejected_with_reason|resolved_by_revision|human_decision|deferred
# evidence_class ∈ evidence_bearing|assertion_only|judgment
# evidence       = citation-shaped (a message id + optional ref/file:line)
# rationale      = the disposition take (kept SEPARATE from evidence)
#
# FAIL-LOUD ANTI-SYCOPHANCY INVARIANT (F2/U7, relocated to the fold boundary in 0.2):
# a rejected_with_reason → accepted transition on an evidence_bearing item MUST carry
# an evidence_ref NEWER than the rejection (a real in-thread message that
# postdates it), else PROTOCOL ERROR. Judgment/assertion items are EXEMPT (F5). The
# guard lives in `transition` (so the driver's own accepts are guarded too) AND is
# replayed at read time over the event stream (so a forged ledger line cannot bypass
# it). The fold path enters through this same `transition`, so the guard fires there.
#
# SELF-CONTAINED EVIDENCE: the WRITE-time check validates evref against the
# thread-local message index and STAMPS the evidence message's
# `at`+`id` onto the accept event (evidence_msg_at/evidence_msg_id). The READ-time replay
# validates that IMMUTABLE stamp, so later message cleanup cannot brick the ledger.
# The forge-resistance posture is unchanged: the stamp
# was validated against the message index when written, and the replay still fails
# loud on a stale/missing/mismatched stamp.
#
# IDEMPOTENCY MARKER (NR-4/#12): add/transition accept an optional --source-msg-id <id>.
# When present it stamps "source_msg_id": <id> onto the appended event — the ledger-native
# record of WHICH proposal operation produced this event. fold.sh passes <payload-id>#<index>
# for a batch (zero-based), or the payload id for a legacy single-op body,
# so a crash-interrupted re-fold (applied-but-unacked) can detect the already-written event
# and skip the reapply. Absent (a driver's own direct op) → the field is simply absent,
# backward-tolerant like the NR-3 evidence stamp. The `source-ids` verb prints every
# source_msg_id on the thread ledger through the VALIDATED read path (events() →
# _validate_event_stream), so fold reads the bookmark set once per batch without a
# second write-ahead file to keep in step. The ledger is therefore the CRASH-SAFE
# bookmark -- not the only one: fold.sh also maintains
# threads/<tid>/processed_payload_ids; fold and is-converged recover from both for
# pending detection. Per-op keys record successful applies; a whole-payload key is
# saved only after every op applies. Since tap-yegvg it records ONLY applies: a malformed
# or ledger-rejected payload is deliberately left out, so it stays pending and
# is-converged.sh fails loud (exit 3 when unparseable) instead of the thread converging
# over a teammate's dropped proposal. Bookmarking a failure made its id unfoldable
# forever, even after the payload or the code was fixed.
#
# HOUSE IDIOM: thin bash wrapper sources thread-lib.sh, gates
# at the sink, then exec python3 -I - "$@" <<'PY' (quoted heredoc; argv reads only).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=skills/discuss/scripts/thread-lib.sh
. "$DIR/thread-lib.sh"

cmd="${1:-}"
[ -n "$cmd" ] || die "usage: ledger.sh {add|transition|list|source-ids} <thread_id> ... --by <h>"

# Split the driver flag out of the positional args.
# Every command (incl. read-only `list`) is gated, so --by is always required:
# the ledger is driver-owned, and a non-driver should not even enumerate it as if it
# owned it — reads route through the driver context.
by=""; source_msg_id=""
pos=()
shift  # drop cmd
while [ "$#" -gt 0 ]; do
  case "$1" in
    --by)            by="${2:-}"; shift 2 ;;
    --source-msg-id) source_msg_id="${2:-}"; shift 2 ;;
    *) pos+=("$1"); shift ;;
  esac
done
[ "${#pos[@]}" -ge 1 ] || die "ledger.sh $cmd: missing <thread_id>"
tid="${pos[0]}"
[ -n "$by" ]      || die "ledger.sh $cmd: --by <handle> is required (the driver)"

# SINGLE-WRITER SINK: only the live opened_by driver may touch this ledger.
if ! assert_driver "$tid" "$by"; then
  exit 1  # assert_driver already printed the REJECT diagnostic
fi

exec python3 -I - "$COLLAB_DIR" "$cmd" "$source_msg_id" "${pos[@]}" <<'PY'
import contextlib, fcntl, json, sys, os, datetime, re

collab_dir = sys.argv[1]
cmd = sys.argv[2]
# NR-4: the proposal message id whose op this is (or "" for a driver's own direct op).
# Stamped onto the event so a crash-interrupted re-fold can detect the already-applied op.
source_msg_id = sys.argv[3] or None
a = sys.argv[4:]   # a[0] = thread_id, then command-specific positional args

STATUSES = {"proposed", "accepted", "rejected_with_reason", "resolved_by_revision", "human_decision", "deferred"}
ECLASSES = {"evidence_bearing", "assertion_only", "judgment"}
OPEN = {"proposed", "accepted"}
HANDLE_RE = re.compile(r"\A[a-z0-9][a-z0-9_-]*\Z")
THREAD_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]*\Z")


def die(msg):
    sys.exit(f"collab/ledger: {msg}")


def tdir(tid):
    if not THREAD_RE.match(tid or ""):
        die(f"invalid thread_id {tid!r} (no path separators)")
    return os.path.join(collab_dir, "threads", tid)


def lpath(tid):
    return os.path.join(tdir(tid), "ledger.ndjson")


def lock_path(tid):
    return os.path.join(tdir(tid), "ledger.lock")


@contextlib.contextmanager
def ledger_lock(tid, exclusive=True):
    os.makedirs(tdir(tid), exist_ok=True)
    fd = os.open(lock_path(tid), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def now():
    # Sub-second precision so a reversal's evidence can be ordered against the rejection it
    # answers (the guard requires evidence newer than the rejection).
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_at(s):
    if not s:
        return None
    s = s.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None


def evidence_message_id(evidence_ref):
    return evidence_ref.split("@", 1)[0]


def _scan_messages_for_thread(tid):
    # {message_id: at} for every message indexed under this thread. Evidence must
    # resolve to a real in-thread message so arbitrary strings cannot back an
    # evidence_ref. The index accepts either thread_id or trace.thread_id for payloads
    # copied from different transports.
    out = {}
    messages_dir = os.path.join(tdir(tid), "messages")

    def consider_file(path):
        try:
            with open(path) as fh:
                raw = fh.read()
        except FileNotFoundError:
            return
        try:
            msg = json.loads(raw)
        except ValueError:
            die(f"malformed FINAL message file {path} while validating evidence_ref — fail loud")
        if not isinstance(msg, dict):
            die(f"non-object FINAL message file {path} while validating evidence_ref — fail loud")
        trace = msg.get("trace")
        msg_tid = msg.get("thread_id") or (trace.get("thread_id") if isinstance(trace, dict) else None)
        if msg_tid != tid:
            return
        if msg.get("from") is not None and not HANDLE_RE.match(msg.get("from") or ""):
            die(f"invalid from handle at {path}: {msg.get('from')!r} (validating evidence_ref)")
        mid = msg.get("id")
        if not mid:
            die(f"missing id at {path} (validating evidence_ref)")
        at = msg.get("at")
        if not at:
            die(f"missing at at {path} (validating evidence_ref)")
        if mid in out and out[mid] != at:
            # Distinct ids are collision-free by construction, so a duplicate id
            # with a DIFFERENT at is forged/corrupt state. Silent last-write-wins would
            # let a forged future-dated duplicate backdate the freshness guard — fail loud.
            die(f"duplicate message id {mid!r} with conflicting at ({out[mid]!r} vs {at!r}) at {path} "
                f"— ambiguous evidence ordering on the evidence path")
        out[mid] = at

    if os.path.isdir(messages_dir):
        for name in os.listdir(messages_dir):
            if name.startswith(".") or not name.endswith(".json"):
                continue
            consider_file(os.path.join(messages_dir, name))
    return out


def _antisycophancy_prior(prior, evref, eclass):
    # The BUS-FREE, prior-events-only half of the anti-sycophancy invariant, shared by the
    # write path AND the read-time replay. `prior` = the item's events BEFORE this accept.
    # Returns (exempt, err, last_rej):
    #   exempt=True  → the guard does not apply (judgment/assertion, or never rejected) — no
    #                  evidence required; callers stamp nothing.
    #   err set      → a guard violation that needs no message lookup (missing evref, or an evref already
    #                  on the table at rejection time). last_rej is None.
    #   else         → caller must check freshness; last_rej is the most-recent rejection index.
    rej = [i for i, e in enumerate(prior) if e.get("status") == "rejected_with_reason"]
    if eclass != "evidence_bearing" or not rej:
        return True, None, None
    if not evref:
        return (False,
                "accepting an evidence_bearing item that was rejected_with_reason MUST carry an "
                "evidence_ref to a message newer than the most-recent rejection (anti-sycophancy guard)",
                None)
    last_rej = max(rej)
    seen = set()
    for e in prior[: last_rej + 1]:
        if e.get("evidence"):
            seen.add(e["evidence"])
        if e.get("evidence_ref"):
            seen.add(e["evidence_ref"])
    if evref in seen:
        return (False,
                f"evidence_ref {evref!r} was already on the table at rejection time; a reversal needs visible NEW evidence",
                None)
    return False, None, last_rej


def _antisycophancy_write(prior, evref, tid, eclass):
    # WRITE-TIME anti-sycophancy check (NR-3): validates evref against the LIVE BUS — the
    # freshness check is trustworthy here precisely because the evidence message is still on
    # the message index when the accept is first folded. Returns
    # (err, stamp): on success stamp = {"evidence_msg_at", "evidence_msg_id"} to be written
    # onto the accept event so the read path is self-contained.
    # An exempt item yields (None, None) — nothing to stamp.
    exempt, err, last_rej = _antisycophancy_prior(prior, evref, eclass)
    if exempt or err:
        return err, None
    ref_mid = evidence_message_id(evref)
    thread_msgs = _scan_messages_for_thread(tid)
    if ref_mid not in thread_msgs:
        return f"evidence_ref {evref!r} must point to a message id in thread {tid}; arbitrary unseen strings are not evidence", None
    rej_dt = parse_at(prior[last_rej].get("at"))
    msg_dt = parse_at(thread_msgs[ref_mid])
    if rej_dt is None or msg_dt is None or msg_dt <= rej_dt:
        return (f"evidence_ref {evref!r} (message {ref_mid} at {thread_msgs[ref_mid]}) is not newer than the "
                f"most-recent rejection at {prior[last_rej].get('at')}; a reversal needs evidence that postdates it", None)
    return None, {"evidence_msg_at": thread_msgs[ref_mid], "evidence_msg_id": ref_mid}


def _antisycophancy_replay(prior, ev, eclass):
    # READ-TIME anti-sycophancy replay: validates the accept event `ev` against its OWN
    # IMMUTABLE STAMP (evidence_msg_at/evidence_msg_id), never a mutable external queue.
    # The stamp was validated against the message index at write time; the
    # replay re-checks every chain property it could not have produced and fails loud on a
    # stale/missing/mismatched stamp, so the guard is RE-ANCHORED, not defanged. Returns an
    # error string on violation, else None. `prior` = the item's events BEFORE this accept.
    evref = ev.get("evidence_ref")
    exempt, err, last_rej = _antisycophancy_prior(prior, evref, eclass)
    if exempt or err:
        return err
    ref_mid = evidence_message_id(evref)
    stamp_id = ev.get("evidence_msg_id")
    stamp_at = ev.get("evidence_msg_at")
    if not stamp_id or not stamp_at:
        return (f"evidence_ref {evref!r} accept is MISSING its write-time stamp "
                f"(evidence_msg_at/evidence_msg_id); a legitimate post-NR-3 accept always carries it")
    if stamp_id != ref_mid:
        return (f"stamped evidence_msg_id {stamp_id!r} != the evidence_ref message id {ref_mid!r} "
                f"(forged/mismatched stamp)")
    rej_dt = parse_at(prior[last_rej].get("at"))
    msg_dt = parse_at(stamp_at)
    if rej_dt is None or msg_dt is None or msg_dt <= rej_dt:
        return (f"evidence_ref {evref!r} (stamped at {stamp_at}) is not newer than the most-recent "
                f"rejection at {prior[last_rej].get('at')}; a reversal needs evidence that postdates it")
    return None


def _validate_event_stream(p, evs):
    # Validate the event STREAM, not just per-line JSON: a hand-edited/forged valid-JSON line
    # appended directly (not via the API) must be detectable corruption, so it cannot become a
    # new "truth" that bypasses the transition-time guards.
    history = {}
    for i, e in enumerate(evs, 1):
        if not isinstance(e, dict):
            die(f"corrupt ledger {p} (event #{i}): not an object")
        ev, iid, status, eclass = e.get("event"), e.get("id"), e.get("status"), e.get("evidence_class")
        if ev not in ("add", "transition"):
            die(f"corrupt ledger {p} (event #{i}): event must be add|transition, got {ev!r}")
        if not iid:
            die(f"corrupt ledger {p} (event #{i}): missing id")
        if status not in STATUSES:
            die(f"corrupt ledger {p} (event #{i}, {iid}): bad status {status!r}")
        if eclass not in ECLASSES:
            die(f"corrupt ledger {p} (event #{i}, {iid}): bad evidence_class {eclass!r}")
        prior = history.get(iid, [])
        if ev == "add":
            if prior:
                die(f"corrupt ledger {p}: duplicate add for {iid} (create-only)")
        else:
            if not prior:
                die(f"corrupt ledger {p}: transition before add for {iid}")
            if e.get("from") != prior[-1].get("status"):
                die(f"corrupt ledger {p}: {iid} transition from {e.get('from')!r} != previous status {prior[-1].get('status')!r} (forged/out-of-order)")
            if eclass != prior[-1].get("evidence_class"):
                die(f"corrupt ledger {p}: {iid} evidence_class changed {prior[-1].get('evidence_class')!r} -> {eclass!r}")
            if status == "accepted":
                # READ-TIME: replay against the event's OWN immutable stamp, never an
                # external queue that may be cleaned up later.
                err = _antisycophancy_replay(prior, e, eclass)
                if err:
                    die(f"corrupt ledger {p}: forged accept for {iid} bypasses the anti-sycophancy guard — {err}")
        history.setdefault(iid, []).append(e)


def events(tid):
    p = lpath(tid)
    out = []
    if os.path.exists(p):
        for ln, line in enumerate(open(p), 1):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                die(f"malformed ledger line {p}:{ln} (fail loud)")
        _validate_event_stream(p, out)
    return out


def current(tid):
    st = {}
    for e in events(tid):
        st[e["id"]] = e
    return st


def append(tid, ev):
    # Caller must hold ledger_lock(tid): the transition guards depend on a serialized
    # events() → append() span, not just an atomic line append.
    with open(lpath(tid), "a") as f:
        f.write(json.dumps(ev) + "\n")


if cmd == "add":
    if len(a) != 6:
        die("usage: ledger.sh add <tid> <item_id> <status> <evidence_class> <evidence> <rationale> --by <driver>")
    tid, iid, status, eclass, evidence, rationale = a[0], a[1], a[2], a[3], a[4], a[5]
    if status not in STATUSES:
        die(f"invalid status '{status}' (valid: {sorted(STATUSES)})")
    if eclass not in ECLASSES:
        die(f"invalid evidence_class '{eclass}' (valid: {sorted(ECLASSES)})")
    with ledger_lock(tid):
        if iid in current(tid):
            die(f"item '{iid}' already exists in thread {tid} — use `transition` to change "
                f"state, never re-`add` (a re-add could silently downgrade evidence_class past the guard)")
        ev = {"event": "add", "at": now(), "thread_id": tid, "id": iid, "status": status,
              "evidence_class": eclass, "evidence": evidence, "rationale": rationale}
        # NR-4: stamp the producing proposal's id so a crash-interrupted re-fold is idempotent.
        if source_msg_id is not None:
            ev["source_msg_id"] = source_msg_id
        append(tid, ev)
    print(f"ledger {tid}: added {iid} [{status}/{eclass}]")

elif cmd == "transition":
    if len(a) < 3:
        die("usage: ledger.sh transition <tid> <item_id> <new_status> [evidence_ref] [rationale] --by <driver>")
    tid, iid, new = a[0], a[1], a[2]
    evref = a[3] if len(a) > 3 and a[3] else None
    rationale = a[4] if len(a) > 4 and a[4] else None
    if new not in STATUSES:
        die(f"invalid status '{new}' (valid: {sorted(STATUSES)})")
    with ledger_lock(tid):
        item_events_all = events(tid)
        cur = {}
        for event in item_events_all:
            cur[event["id"]] = event
        if iid not in cur:
            die(f"unknown item '{iid}' in thread {tid} (add it first)")
        item = cur[iid]
        old = item["status"]
        eclass = item.get("evidence_class")
        # Anti-sycophancy guard at the WRITE boundary. It fires whenever an evidence_bearing item
        # that was EVER rejected_with_reason is transitioned to accepted — not only on a direct
        # rejected_with_reason -> accepted hop (an intermediate -> proposed would otherwise slip it).
        # Judgment/assertion items are exempt (F5). The fold path enters through here, so the guard
        # relocates to the fold boundary for peer-proposed accepts. NR-3: the write-time check
        # validates evref against the LIVE BUS (trustworthy — the evidence is still present at fold
        # time) and RETURNS the evidence message's at+id so we STAMP them onto the accept event; the
        # read-time replay then validates that immutable stamp instead of re-scanning external state.
        item_events = [e for e in item_events_all if e["id"] == iid]
        stamp = None
        if new == "accepted":
            err, stamp = _antisycophancy_write(item_events, evref, tid, eclass)
            if err:
                die(f"PROTOCOL ERROR — {iid}: {err}")
        ev = {"event": "transition", "at": now(), "thread_id": tid, "id": iid, "status": new,
              "evidence_class": eclass, "evidence_ref": evref, "rationale": rationale, "from": old}
        # Stamp the evidence message's at+id onto a guarded accept so the ledger is self-contained
        # (NR-3) — only present when the guard actually ran on an evidence_bearing reversal.
        if stamp is not None:
            ev.update(stamp)
        # NR-4: stamp the producing proposal's id so a crash-interrupted re-fold is idempotent.
        # Additive and composes with the NR-3 stamp — a proposal-produced accept carries both.
        if source_msg_id is not None:
            ev["source_msg_id"] = source_msg_id
        append(tid, ev)
    print(f"ledger {tid}: {iid} {old} -> {new}")

elif cmd == "list":
    if len(a) < 1:
        die("usage: ledger.sh list <thread_id> --by <driver>")
    tid = a[0]
    with ledger_lock(tid, exclusive=False):
        for iid, e in current(tid).items():
            print(json.dumps({"id": iid, "status": e["status"],
                              "evidence_class": e.get("evidence_class"), "open": e["status"] in OPEN}))

elif cmd == "source-ids":
    # NR-4: print every source_msg_id present on the thread ledger, one per line — the
    # idempotency bookmark set. Routed through events() so the read is VALIDATED
    # (_validate_event_stream); a forged/torn ledger fails loud here, never silently
    # yields a half-set that would let a reapply slip the guard. fold reads this ONCE per
    # batch and checks membership in-memory (no subprocess-per-proposal). Events with no
    # stamp (a driver's own direct op) contribute nothing — they were never proposals.
    if len(a) < 1:
        die("usage: ledger.sh source-ids <thread_id> --by <driver>")
    tid = a[0]
    emitted = set()
    with ledger_lock(tid, exclusive=False):
        for e in events(tid):
            sid = e.get("source_msg_id")
            if sid and sid not in emitted:
                emitted.add(sid)
                print(sid)

else:
    die(f"unknown command '{cmd}' (use add|transition|list|source-ids)")
PY
