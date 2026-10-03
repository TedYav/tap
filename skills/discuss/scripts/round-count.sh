#!/usr/bin/env bash
# round-count.sh - collab thread round counter.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=skills/discuss/scripts/thread-lib.sh
. "$DIR/thread-lib.sh"

tid="${1:?usage: round-count.sh <thread_id> [--increment] --by <driver>}"
shift

do_increment=0
by=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --increment) do_increment=1; shift ;;
    --by)        by="${2:-}"; shift 2 ;;
    *)           die "round-count.sh: unknown argument '$1'" ;;
  esac
done

tdir="$(thread_dir "$tid")"
round_file="$tdir/round"
round_lock="$tdir/round.lock"

if [ "$do_increment" -eq 1 ]; then
  [ -n "$by" ] || die "round-count.sh: --by <driver> is required for --increment"
  if ! assert_driver "$tid" "$by"; then
    exit 1  # assert_driver already printed the REJECT diagnostic
  fi
fi

python3 -I - "$round_file" "$round_lock" "$do_increment" <<'PY'
import fcntl, os, re, secrets, sys

round_file, round_lock, do_increment = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
CANON = re.compile(r"\A(0|[1-9][0-9]*)\Z")

def die(msg):
    sys.exit(f"round-count.sh: {msg}")

def read_round():
    if not os.path.exists(round_file):
        return 0
    raw = open(round_file).read().strip()
    if not CANON.match(raw):
        die(f"corrupt round file {round_file} ({raw!r}) - value is not a canonical non-negative integer")
    return int(raw)

os.makedirs(os.path.dirname(round_file), exist_ok=True)
lock_fd = os.open(round_lock, os.O_RDWR | os.O_CREAT, 0o644)
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX if do_increment else fcntl.LOCK_SH)
    value = read_round()
    if do_increment:
        value += 1
        tmp = f"{round_file}.tmp.{os.getpid()}.{secrets.token_hex(4)}"
        with open(tmp, "w") as fh:
            fh.write(str(value))
        os.replace(tmp, round_file)
    print(value)
finally:
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    os.close(lock_fd)
PY
