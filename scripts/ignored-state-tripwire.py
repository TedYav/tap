#!/usr/bin/env python3
"""Snapshot and compare ignored checkout state without following symlinks."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat
import sys


def snapshot(root: Path) -> dict[str, int]:
    tap = root / ".tap"
    rows: dict[str, int] = {}
    try:
        tap_stat = tap.lstat()
    except FileNotFoundError:
        return rows
    except OSError as error:
        raise RuntimeError(f"cannot inspect {tap}: {error}") from error

    if not stat.S_ISDIR(tap_stat.st_mode) or stat.S_ISLNK(tap_stat.st_mode):
        rows[".tap"] = tap_stat.st_mtime_ns
        return rows

    def fail_walk(error: OSError) -> None:
        raise error

    for directory, names, files in os.walk(tap, followlinks=False, onerror=fail_walk):
        base = Path(directory)
        for name in sorted((*names, *files)):
            path = base / name
            rel = path.relative_to(root).as_posix()
            try:
                rows[rel] = path.lstat().st_mtime_ns
            except FileNotFoundError:
                # A concurrent removal supplies no stable after-state. A later
                # parent mtime or new path still trips; deletions are out of scope.
                continue
            except OSError as error:
                raise RuntimeError(f"cannot inspect {path}: {error}") from error
    return rows


def is_preexisting_live_state(path: str, before: dict[str, int]) -> bool:
    # ponytail: writes to an already-live TAP bus cannot be attributed to the
    # runner. Process-level auditing can cover that case if it becomes needed.
    if ".tap/bus" in before and (path == ".tap/bus" or path.startswith(".tap/bus/")):
        return True
    registry = {".tap/team-registry.json", ".tap/team-registry.json.lock"}
    return bool(registry.intersection(before)) and path in registry


def write_snapshot(root: Path, output: Path) -> None:
    output.write_text(json.dumps({"root": str(root), "paths": snapshot(root)}, sort_keys=True) + "\n")


def compare(before_path: Path, root: Path, window: str) -> int:
    before_doc = json.loads(before_path.read_text())
    if before_doc.get("root") != str(root) or not isinstance(before_doc.get("paths"), dict):
        raise RuntimeError("ignored-state snapshot does not match checkout root")
    before = before_doc["paths"]
    after = snapshot(root)
    mutations: list[tuple[str, str]] = []
    for path in sorted(after):
        if is_preexisting_live_state(path, before):
            continue
        if path not in before:
            mutations.append((path, "new"))
        elif before[path] != after[path]:
            mutations.append((path, "mtime-changed"))
    for path, change in mutations:
        print(f"ignored-state mutation: root={root} path={path} change={change} window={window}")
    return 1 if mutations else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot")
    snap.add_argument("root", type=Path)
    snap.add_argument("output", type=Path)
    check = sub.add_parser("compare")
    check.add_argument("before", type=Path)
    check.add_argument("root", type=Path)
    check.add_argument("window")
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        if args.command == "snapshot":
            write_snapshot(root, args.output)
            return 0
        return compare(args.before, root, args.window)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"ignored-state observation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
