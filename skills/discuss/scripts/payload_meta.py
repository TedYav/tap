"""Strict TAP payload metadata parser for fold.sh and is-converged.sh."""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path


ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_.-]*\Z")


def proposal_ops(body: str, payload_id: str) -> list[tuple[str, object]]:
    """Return ordered (bookmark, op) pairs; legacy single-op JSON keeps its id."""
    if body.startswith("{"):
        raw = body
    else:
        blocks = re.findall(r"^```json[ \t]*\n(.*?)^```[ \t]*$", body, re.M | re.S)
        if len(blocks) != 1 or len(re.findall(r"^```json[ \t]*$", body, re.M)) != 1:
            raise ValueError('expected one JSON object or one fenced json block containing {"ops": [...]}')
        raw = blocks[0]
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("payload body must be a JSON object")
    if "ops" not in value:
        return [(payload_id, value)]
    if set(value) != {"ops"} or not isinstance(value["ops"], list) or not value["ops"]:
        raise ValueError('batch must contain only a non-empty "ops" array')
    # '#' cannot occur in a TAP payload id, so op keys cannot collide with legacy ids.
    return [(f"{payload_id}#{index}", op) for index, op in enumerate(value["ops"])]

def derive_at(payload_id: str, body: str, metadata: dict[str, str]) -> str | None:
    """Send-time provenance for the anti-sycophancy freshness guard, or None.

    The caller controls both frontmatter `at` and `tap send --id`, so neither can
    order evidence safely. The courier-owned `path` points to the canonical payload;
    its sibling `.placed` receipt is the transport's authoritative placement record.
    Validate both identities plus the peer-authored body/from/kind, then use that
    courier-created file's high-resolution mtime; its JSON `at` field has only
    whole-second precision.
    """
    raw_path = (metadata.get("path") or "").strip()
    canonical = Path(raw_path)
    if not canonical.is_absolute() or canonical.parent.name != "payloads" or canonical.name != f"{payload_id}.md":
        return None
    try:
        canonical_id, canonical_body, canonical_metadata = parse_payload(str(canonical))
        if canonical_id != payload_id or canonical_metadata.get("path") != str(canonical):
            return None
        if canonical_body != body:
            return None
        if any((canonical_metadata.get(field) or "") != (metadata.get(field) or "") for field in ("from", "kind")):
            return None
        receipt_path = canonical.parent.parent / "receipts" / f"{payload_id}.placed"
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("id") != payload_id or receipt.get("via") != "courier":
            return None
        datetime.datetime.strptime(receipt.get("at", ""), "%Y-%m-%dT%H:%M:%SZ")
        seconds, nanos = divmod(receipt_path.stat().st_mtime_ns, 1_000_000_000)
        stamp = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).replace(microsecond=nanos // 1_000)
    except (OSError, OverflowError, ValueError, TypeError, AttributeError):
        return None
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_payload(path: str) -> tuple[str, str, dict[str, str]]:
    raw = Path(path).read_text()
    lines = raw.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("missing frontmatter")

    metadata: dict[str, str] = {}
    body_start = None
    for index, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            body_start = index + 1
            break
        if ":" in line:
            key, value = line.split(":", 1)
            metadata[key.strip()] = value.strip()

    if body_start is None:
        raise ValueError("unterminated frontmatter")

    payload_id = metadata.get("id", "")
    if not payload_id:
        raise ValueError("missing id")
    if not ID_RE.match(payload_id):
        raise ValueError(f"unsafe id {payload_id!r}")

    return payload_id, "\n".join(lines[body_start:]).strip(), metadata
