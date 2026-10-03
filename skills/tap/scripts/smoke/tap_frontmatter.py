"""Frozen Python payload-frontmatter oracle for parity tests (tap-n9s).

Production readers are native (runtime/bun/src/payload-fields.ts,
seat-refresh.ts). This module keeps the retired Python scanner's exact
semantics so parity tests can run the pre-cutover bodies verbatim.

A line is a `key: value` field only when the colon is immediately followed
by a space or tab (`^key:[ \\t]`, as `tap_envelope_field`'s awk requires), so
a writer-smuggled `from_team:evil` is never a field. A repeated key returns
the LAST match.
"""
import glob
import os


def frontmatter(path):
    """Parse the opening ---/--- frontmatter block of `path` into a dict.
    Returns {} for a missing/unreadable file or one that doesn't open with
    a fence."""
    fields = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            first = next(fh, "").rstrip("\r\n")
            if first != "---":
                return fields
            for line in fh:
                line = line.rstrip("\r\n")
                if line == "---":
                    break
                key, sep, rest = line.partition(":")
                if sep and rest[:1] in (" ", "\t"):
                    fields[key] = rest.strip()
    except OSError:
        return {}
    return fields


def addressed_to_local(fields, handle, local_team=""):
    """True iff this payload is inbound for handle on local_team (tap-18so / tap-w66z).

    Empty ``to_team`` is the legacy handle-only contract. A stamped foreign
    ``to_team`` is sender-bus outbound relay and must never read as local inbox,
    even when the bare ``to`` handle collides with a seat on this team.
    """
    if fields.get("to") != handle:
        return False
    to_team = (fields.get("to_team") or "").strip()
    if to_team and to_team != (local_team or "").strip():
        return False
    return True


def list_payload_paths(payloads_dir):
    """Yield (id, path) for every non-draft (`*.md`, not `_*.md`) payload,
    sorted by filename."""
    if not os.path.isdir(payloads_dir):
        return
    for path in sorted(glob.glob(os.path.join(payloads_dir, "*.md"))):
        base = os.path.basename(path)
        if base.startswith("_"):
            continue
        yield base[:-3], path
