#!/usr/bin/env bash
# D5: fixture-door — send-recipient-fence.test.sh:28,48-53: the module references here only build or seed fixture state; every assertion is on the surrounding shell behavior, none on the module's own
# send-recipient-fence.test.sh — fenced recipient refuses before sender-bus
# staging (sol 054244). Sparse sender must stay byte-identical for -m and -f.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=skills/tap/scripts/smoke/runtime-helpers.sh
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_SCRATCH_ONLY="$WORK"

SENDER="$WORK/sender/.tap/bus"
RECIP="$WORK/recip/.tap/bus"
mkdir -p "$SENDER" "$RECIP/payloads" "$RECIP/receipts"

printf '%s\n' '{"schema": "0.20", "team":{"name":"sender"},"seats":{"bob":{"status":"active","delivery":"poll","harness":"daemon"}}}' \
  > "$SENDER/registry.json"
printf '%s\n' '{"schema": "0.20", "team":{"name":"recip"},"seats":{"alice":{"status":"active","delivery":"poll","harness":"daemon"}}}' \
  > "$RECIP/registry.json"

# Live fence on recipient (this shell owns it).
export TAP_HOME="$RECIP"
bun "$_TAP_SCRIPT_DIR/../../../runtime/bun/src/reset.ts" acquire "$TAP_HOME" --owner-pid "$$" --bundle-id "bundle-recip-fence" >/dev/null
unset TAP_HOME

snapshot_sender() {
  # Sorted path+content fingerprint; empty dirs included via find.
  (cd "$SENDER" && find . -print0 | sort -z | xargs -0 sh -c '
    for p; do
      if [ -f "$p" ]; then
        printf "F %s " "$p"
        cksum <"$p" | awk "{print \$1\" \"\$2}"
      else
        printf "D %s\n" "$p"
      fi
    done
  ' _)
}

BODY="$WORK/body.txt"
printf '%s\n' 'recipient-fence probe body' > "$BODY"

export TAP_HOME="$SENDER"
BEFORE="$(snapshot_sender)"

if "$TAP" send recip/alice -m "inline probe" --from bob \
  --remote-registry "$RECIP/registry.json" >"$WORK/m.out" 2>&1; then
  echo "send-recipient-fence: -m should refuse fenced recipient" >&2
  cat "$WORK/m.out" >&2
  exit 1
fi
grep -Eq 'team_reset_fenced|mid-reset' "$WORK/m.out" \
  || { echo "send-recipient-fence: -m refusal must name fence" >&2; cat "$WORK/m.out" >&2; exit 1; }

AFTER_M="$(snapshot_sender)"
[ "$BEFORE" = "$AFTER_M" ] \
  || { echo "send-recipient-fence: -m mutated sparse sender bus" >&2
       printf 'BEFORE:\n%s\nAFTER:\n%s\n' "$BEFORE" "$AFTER_M" >&2; exit 1; }

if "$TAP" send recip/alice -f "$BODY" --from bob \
  --remote-registry "$RECIP/registry.json" >"$WORK/f.out" 2>&1; then
  echo "send-recipient-fence: -f should refuse fenced recipient" >&2
  cat "$WORK/f.out" >&2
  exit 1
fi
grep -Eq 'team_reset_fenced|mid-reset' "$WORK/f.out" \
  || { echo "send-recipient-fence: -f refusal must name fence" >&2; cat "$WORK/f.out" >&2; exit 1; }

AFTER_F="$(snapshot_sender)"
[ "$BEFORE" = "$AFTER_F" ] \
  || { echo "send-recipient-fence: -f mutated sparse sender bus" >&2
       printf 'BEFORE:\n%s\nAFTER:\n%s\n' "$BEFORE" "$AFTER_F" >&2; exit 1; }

echo "send-recipient-fence: ok"
