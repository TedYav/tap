#!/usr/bin/env bash
# thread-lib.sh - single-writer driver gate for collab thread state.

_collab_threadlib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=skills/discuss/scripts/lib.sh
. "$_collab_threadlib_dir/lib.sh"

thread_dir() {
  python3 -I - "$COLLAB_DIR" "$1" <<'PY'
import os, re, sys
collab_dir, tid = sys.argv[1], sys.argv[2]
if not re.match(r"\A[A-Za-z0-9][A-Za-z0-9_-]*\Z", tid or ""):
    sys.exit(f"collab/thread: invalid thread_id {tid!r} (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$ - no path separators)")
print(os.path.join(collab_dir, "threads", tid))
PY
}

thread_opened_by() {
  python3 -I - "$COLLAB_DIR" "$1" <<'PY'
import json, os, re, sys
collab_dir, tid = sys.argv[1], sys.argv[2]
if not re.match(r"\A[A-Za-z0-9][A-Za-z0-9_-]*\Z", tid or ""):
    sys.exit(f"collab/thread: invalid thread_id {tid!r}")
meta = os.path.join(collab_dir, "threads", tid, "metadata.json")
try:
    with open(meta) as fh:
        metadata = json.load(fh)
except FileNotFoundError:
    sys.exit(f"collab/thread: thread {tid!r} is not open (no {meta})")
except ValueError:
    sys.exit(f"collab/thread: metadata for {tid!r} is corrupt (not valid JSON)")
opened_by = metadata.get("opened_by")
if not opened_by:
    sys.exit(f"collab/thread: metadata for {tid!r} has no opened_by")
print(opened_by)
PY
}

assert_driver() {
  if [ "$#" -lt 2 ]; then
    echo "collab/thread: assert_driver <thread_id> <writer_handle>" >&2
    return 2
  fi
  local tid="$1" who="$2" opened_by
  if ! opened_by="$(thread_opened_by "$tid")"; then
    return 1
  fi
  if [ "$who" != "$opened_by" ]; then
    echo "collab/thread: REJECT - writer '$who' is not the driver of thread '$tid' (opened_by='$opened_by'). Only the driver writes shared thread-state; a peer proposes via a payload file." >&2
    return 1
  fi
  return 0
}
