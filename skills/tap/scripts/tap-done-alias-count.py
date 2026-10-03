#!/usr/bin/env python3
"""Count non-fixture alias hits; absent or malformed evidence is not zero use."""
import argparse
import datetime
import json
import pathlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("log", type=pathlib.Path)
parser.add_argument("--since", help="inclusive ISO timestamp at the start of the release window")
args = parser.parse_args()
try:
    since = datetime.datetime.fromisoformat(args.since.replace("Z", "+00:00")) if args.since else None
    count = 0
    for line in args.log.read_text().splitlines():
        event = json.loads(line)
        if not isinstance(event, dict) or event.get("action") != "done_alias_hit" or type(event.get("fixture")) is not bool or not isinstance(event.get("at"), str):
            raise ValueError("invalid alias audit record")
        at = datetime.datetime.fromisoformat(event["at"].replace("Z", "+00:00"))
        if not event["fixture"] and (since is None or at >= since):
            count += 1
except (OSError, ValueError, KeyError, TypeError) as exc:
    parser.exit(2, f"alias evidence unavailable: {exc}\n")
print(count)
