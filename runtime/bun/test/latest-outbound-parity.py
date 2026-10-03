"""Frozen legacy oracle for the outbound-batch parity guard.

Builds the malformed-control fixture matrix the deleted
skills/tap/scripts/smoke/context-batch-parity.test.sh owned and computes the
expected batch with the legacy algorithm (tap_frontmatter parsing, Python
strip/int semantics, code-point tuple ordering). Lives in Python on purpose:
reimplementing it in TypeScript would replicate the module under test and
void the parity property. Prints one JSON document:
{seats, cases: [{payloads, spool, clock, expected: {seat: [epoch, ident]}}]}.
"""
import glob, json, os, sys
from pathlib import Path

sys.path.insert(0, os.environ["TAP_REPO_ROOT"] + "/skills/tap/scripts/smoke")
from tap_frontmatter import frontmatter, list_payload_paths

work = Path(sys.argv[1])
team, now = "local", 1700000000
p, s = work / "payloads", work / "spool"
p.mkdir(parents=True); s.mkdir(parents=True)
seats = set()

def put(directory, name, sender=None, stamp=now - 10, extra="", raw=None):
    path = directory / (name + ".md")
    if sender: seats.add(sender)
    if raw is None:
        raw = "---\n" + (f"from: {sender}\n" if sender else "") + extra + "---\nbody\n"
    path.write_bytes(raw.encode("utf-8"))
    os.utime(path, (stamp, stamp))
    return path

# Independent seats keep malformed controls from hiding behind other winners.
put(p, "canonical", "canonical", stamp=now - 2)
put(s, "parked", "parked", stamp=now - 3)
put(p, "older", "both", stamp=now - 20)
put(s, "newer", "both", stamp=now - 1)
put(p, "same-id", "duplicate", stamp=now - 20)
put(s, "same-id", "duplicate", stamp=now - 1)
put(p, "z-first", "seconds", stamp=now - 1.8)
put(s, "a-second", "seconds", stamp=now - 1.1)
put(p, "future", "future", stamp=now + 3600)
put(p, "b-future", "clamped-tie", stamp=now + 1)
put(s, "a-future", "clamped-tie", stamp=now + 500)
put(p, "zero", "zero", stamp=0)
put(p, "negative", "negative", stamp=-1.8)
put(p, "negative-fraction", "negative-fraction", stamp=-0.5)
put(p, "tie-\ue000", "unicode", stamp=now - 1)
put(s, "tie-\U00010000", "unicode", stamp=now - 1)
put(p, "z", "ascii-tie", stamp=now - 1)
put(s, "a", "ascii-tie", stamp=now - 1)
put(p, "filename-id", "id-mismatch", extra="id: bogus-header-id\n")
put(p, "unstamped", "unstamped")
put(p, "empty-team", "empty-team", extra="from_team: \n")
put(p, "own-team", "own-team", extra="from_team: local\n")
put(p, "foreign-team", "foreign-team", extra="from_team: foreign\n")
put(p, "malformed-team", "malformed-team", extra="from_team:foreign\n")
put(p, "duplicate-team", "duplicate-team", extra="from_team: foreign\nfrom_team: local\n")
put(p, "duplicate-from", "last-from", raw="---\nfrom: first-from\nfrom: last-from\n---\n")
seats.add("first-from")
put(p, "no-fence", "no-fence", raw="from: no-fence\n")
put(p, "missing-close", "missing-close", raw="---\nfrom: missing-close\n")
put(p, "bad-field", "bad-field", raw="---\nfrom:bad-field\n---\n")
put(p, "crlf", "crlf", raw="---\r\nfrom:\t crlf \r\n---\r\n")
put(p, "python-strip", "python-strip", raw="---\nfrom: \x1c\x1dpython-strip\x1e\x1f\nfrom_team: \x85local\x1c\n---\n")
put(p, "bom-value", "\ufeffbom-value", raw="---\nfrom: \ufeffbom-value\n---\n")
put(p, "lone-cr", "lone-cr", raw="---\rfrom: lone-cr\rfrom_team: local\r---\r")
put(p, "body-field", "body-field", raw="---\n---\nfrom: body-field\n")
put(p, "missing-from")
put(p, "_draft", "draft")
put(s, "_spool-draft", "draft")
put(p, ".hidden", "hidden")
put(p, "wrong-extension", "extension").rename(p / "wrong-extension.MD")
put(p, "probe", "probe", extra="kind: probe\n")
put(p, "notice", "notice", extra="kind: notice\n")
put(s, "progress", "progress", extra="kind: progress\n")
put(p, "prototype", "__proto__")
put(s, "constructor", "constructor")
(p / "directory.md").mkdir()
(p / "dangling.md").symlink_to(p / "absent.md")
seats.add("absent")

# Frozen algorithm from supervision-lib.sh's PYOUT, deliberately seat-by-seat.
# Keep this independent of the new module and avoid invoking production TAP.
def legacy(payloads, spool, seat, clock):
    latest = (0, "")
    for directory in (payloads, spool):
        for ident, path in list_payload_paths(directory) or ():
            meta = frontmatter(path)
            if meta.get("from") != seat or meta.get("from_team", "") not in ("", team):
                continue
            try:
                stamp = min(int(os.path.getmtime(path)), clock)
            except OSError:
                continue
            latest = max(latest, (stamp, ident))
    return latest

def case(payloads, spool, clock):
    return {
        "payloads": str(payloads), "spool": str(spool), "clock": clock,
        "expected": {seat: list(legacy(Path(payloads), Path(spool), seat, clock)) for seat in sorted(seats)},
    }

document = {
    "seats": sorted(seats),
    "cases": [
        case(p, s, now),
        case(p, s, -1),
        case(p / "missing", s / "missing", now),
        case(p, s / "missing", now),
    ],
}
print(json.dumps(document))
