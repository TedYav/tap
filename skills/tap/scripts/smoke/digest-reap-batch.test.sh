#!/usr/bin/env bash
# digest-reap-batch.test.sh — tap-bof0u: one digest-GC traversal preserves
# terminality and retention behavior across the whole index inventory.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT

export TAP_HOME="$WORK/bus[meta]"
export TAP_SPOOL_NOW=200000 TAP_DIGEST_RETAIN_SECONDS=10
LIB="$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$LIB"
tap_ensure_dirs

digest_dir="$TAP_HOME/spool/digests"
mkdir -p "$digest_dir"

cat > "$TAP_RECEIPTS/done.done" <<'JSON'
{"id":"done","via":"direct"}
JSON
cat > "$TAP_RECEIPTS/cancelled.cancelled" <<'JSON'
{"id":"cancelled","via":"cancelled"}
JSON
cat > "$TAP_RECEIPTS/fallback-young.done" <<'JSON'
{"id":"fallback-young","via":"courier-auto"}
JSON
cat > "$TAP_RECEIPTS/fallback-old.done" <<'JSON'
{"id":"fallback-old","via":"courier-auto"}
JSON
touch -t 197001020000 "$TAP_RECEIPTS/fallback-old.done"
cat > "$TAP_RECEIPTS/settled-direct.done" <<'JSON'
{"id":"settled-direct","via":"direct"}
JSON
cat > "$TAP_RECEIPTS/split-a.done" <<'JSON'
{"id":"split-a","via":"direct"}
JSON
cat > "$TAP_RECEIPTS/split-b.done" <<'JSON'
{"id":"split-b","via":"direct"}
JSON

cat > "$digest_dir/terminal-done.json" <<'JSON'
{"items":[{"id":"done"}]}
JSON
cat > "$digest_dir/terminal-cancelled.json" <<'JSON'
{"items":[{"id":"cancelled"}]}
JSON
cat > "$digest_dir/live.json" <<'JSON'
{"items":[{"id":"live"}]}
JSON
cat > "$digest_dir/retention-young.json" <<'JSON'
{"injected_at_epoch":199995,"items":[{"id":"done"}]}
JSON
cat > "$digest_dir/retention-old.json" <<'JSON'
{"injected_at_epoch":199000,"items":[{"id":"done"}]}
JSON
cat > "$digest_dir/fallback-young.json" <<'JSON'
{"items":[{"id":"fallback-young","settled":true}]}
JSON
cat > "$digest_dir/fallback-old.json" <<'JSON'
{"items":[{"id":"fallback-old","settled":true}]}
JSON
cat > "$digest_dir/settled-no-fallback.json" <<'JSON'
{"items":[{"id":"settled-direct","settled":true}]}
JSON
cat > "$digest_dir/no-stamp-ordinary.json" <<'JSON'
{"items":[{"id":"done"}]}
JSON
cat > "$digest_dir/terminal-split-id.json" <<'JSON'
{"items":[{"id":"split-a split-b"}]}
JSON
for name in unlink-a unlink-m unlink-z; do
  cat > "$digest_dir/$name.json" <<JSON
{"items":[{"id":"done"}]}
JSON
done
printf '%s\n' '{not-json' > "$digest_dir/unreadable.json"
cat > "$digest_dir/malformed-items.json" <<'JSON'
{"items":null}
JSON

# Unstamped terminal indexes now owe the same minimum pointer lifetime.
# Age the cleanup cases; leave no-stamp-ordinary fresh as the retained control.
python3 - "$digest_dir" <<'PYAGE'
import os,sys
for name in ["terminal-done", "terminal-cancelled", "terminal-split-id", "unlink-a", "unlink-m", "unlink-z"]:
    os.utime(os.path.join(sys.argv[1], name+".json"), (100000,100000))
PYAGE

# The reaper is native (digest-index.ts). The fault is injected at the runtime
# boundary the courier actually crosses: the selected Bun shim counts the
# traversals and runs the real runtime with a preload that fails ONE unlink —
# the Bun analog of the Python `sitecustomize` this arm used to install.
DIGEST_REAL_BUN="${TAP_SMOKE_BUN:-$(command -v bun)}"
DIGEST_BUN_COUNT="$WORK/bun.count"
DIGEST_SITE_DIR="$FAKE_BIN"
export DIGEST_REAL_BUN DIGEST_BUN_COUNT DIGEST_SITE_DIR
printf '0\n' > "$DIGEST_BUN_COUNT"
cat > "$FAKE_BIN/fail-unlink.ts" <<'TS'
import { basename } from "node:path";
const fs = require("node:fs");
const real = fs.unlinkSync;
fs.unlinkSync = (path: string, ...rest: unknown[]) => {
  if (basename(String(path)) === process.env.DIGEST_FAIL_UNLINK) throw Object.assign(new Error(`EPERM: ${path}`), { code: "EPERM" });
  return real(path, ...rest);
};
TS
cat > "$FAKE_BIN/bun" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *"/digest-index.ts reap "*)
    count="$(cat "$DIGEST_BUN_COUNT")"
    printf '%s\n' "$((count + 1))" > "$DIGEST_BUN_COUNT"
    exec "$DIGEST_REAL_BUN" --preload "$DIGEST_SITE_DIR/fail-unlink.ts" "$@" ;;
esac
exec "$DIGEST_REAL_BUN" "$@"
SH
chmod +x "$FAKE_BIN/bun"
export PATH="$FAKE_BIN:$PATH" TAP_SMOKE_BUN="$FAKE_BIN/bun"
export DIGEST_FAIL_UNLINK=unlink-m.json
hash -r

set +e
tap_bun_call digest-index - digest-index.ts reap "$TAP_HOME/spool/digests" "$TAP_RECEIPTS"
reap_rc=$?
set -e

fail() { echo "digest-reap-batch: $*" >&2; exit 1; }
[ "$reap_rc" -eq 0 ] || fail "one unlink failure aborted the reap pass"
for name in terminal-done terminal-cancelled terminal-split-id retention-old fallback-old unreadable unlink-a unlink-z; do
  [ ! -f "$digest_dir/$name.json" ] || fail "reapable index survived: $name"
done
for name in live retention-young fallback-young settled-no-fallback malformed-items no-stamp-ordinary; do
  [ -f "$digest_dir/$name.json" ] || fail "protected index was reaped: $name"
done
[ -f "$digest_dir/unlink-m.json" ] || fail "index with failed unlink was removed"

bun_starts="$(cat "$DIGEST_BUN_COUNT")"
[ "$bun_starts" = 1 ] || fail "expected one native traversal, observed $bun_starts"

echo "digest-reap-batch: one traversal preserves terminality and retention: ok"
