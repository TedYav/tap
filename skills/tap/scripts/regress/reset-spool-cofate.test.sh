#!/usr/bin/env bash
# reset-spool-cofate.test.sh — v0.19: entire spool (including parked) checkpoints;
# unclassified components refuse (no warn-preserve).
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_SPOOL_DISABLE_DELIVERER=1
export TAP_SCRATCH_ONLY="$WORK"
export TAP_SESSION_MANIFEST="$WORK/sessions.json"
printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"

archive_from_output() {
  printf '%s\n' "$1" | sed -n 's/^tap team reset:   archive=//p' | tail -1
}

seed_spool_entry() { # <id> <sender> <body>
  local id="$1" sender="$2" body="$3"
  mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/spool"
  printf '%s\n' \
    "---" \
    "id: $id" \
    "from: $sender" \
    "to: receiver" \
    "kind: discuss" \
    "reply: expected" \
    "---" \
    "$body" > "$TAP_HOME/payloads/$id.md"
  cp "$TAP_HOME/payloads/$id.md" "$TAP_HOME/spool/$id.md"
  printf '{"id":"%s","target":"receiver","team":"test","reason":"busy"}\n' "$id" \
    > "$TAP_HOME/spool/$id.meta.json"
}

# 1. Settled AND parked spool entries all ride the COMPLETE checkpoint; live spool empty.
export TAP_HOME="$WORK/cofate/.tap/bus"
mkdir -p "$TAP_HOME/receipts" "$TAP_HOME/archive"
printf '{"schema": "0.20", "team":{"name":"cofate"},"seats":{"alice":{"status":"active","delivery":"poll"}}}\n' \
  > "$TAP_HOME/registry.json"
seed_spool_entry settled-done alice "settled done body"
seed_spool_entry parked-one carol "parked body"
printf 'done receipt bytes\n' > "$TAP_HOME/receipts/settled-done.done"

out="$("$TAP" team reset --yes 2>&1)" || {
  echo "reset-spool-cofate: (1) reset failed" >&2
  echo "$out" >&2
  exit 1
}
arc="$(archive_from_output "$out")"
[ -n "$arc" ] || { echo "reset-spool-cofate: (1) no archive path" >&2; exit 1; }
[ -f "$arc/COMPLETE" ] || { echo "reset-spool-cofate: (1) missing COMPLETE" >&2; exit 1; }
[ -f "$arc/bus/spool/settled-done.md" ] || { echo "reset-spool-cofate: (1) settled spool not checkpointed" >&2; exit 1; }
[ -f "$arc/bus/spool/parked-one.md" ] || { echo "reset-spool-cofate: (1) parked spool not checkpointed" >&2; exit 1; }
[ -f "$arc/bus/receipts/settled-done.done" ] || { echo "reset-spool-cofate: (1) receipt not co-checkpointed" >&2; exit 1; }
[ ! -e "$TAP_HOME/spool/settled-done.md" ] && [ ! -e "$TAP_HOME/spool/parked-one.md" ] \
  || { echo "reset-spool-cofate: (1) live spool not cleared" >&2; exit 1; }
echo "reset-spool-cofate: 1/2 - entire spool checkpoints (parked included); live cleared: ok"

# 2. Unclassified component REFUSES (no warn-preserve); bus byte-identical.
export TAP_HOME="$WORK/unknown/.tap/bus"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/unexpected-component"
printf 'payload\n' > "$TAP_HOME/payloads/x.md"
printf 'keep\n' > "$TAP_HOME/unexpected-component/keep"
printf '{"schema": "0.20", "team":{"name":"u"},"seats":{}}\n' > "$TAP_HOME/registry.json"
before="$(cksum "$TAP_HOME/payloads/x.md" "$TAP_HOME/unexpected-component/keep" | paste -sd, -)"
if out="$("$TAP" team reset --yes 2>&1)"; then
  echo "reset-spool-cofate: (2) unknown component must refuse" >&2
  echo "$out" >&2
  exit 1
fi
[[ "$out" == *unclassified_component* || "$out" == *unexpected-component* ]] \
  || { echo "reset-spool-cofate: (2) refusal must name unclassified component" >&2; echo "$out" >&2; exit 1; }
after="$(cksum "$TAP_HOME/payloads/x.md" "$TAP_HOME/unexpected-component/keep" | paste -sd, -)"
[ "$before" = "$after" ] || { echo "reset-spool-cofate: (2) refuse mutated bus" >&2; exit 1; }
[ ! -d "$TAP_HOME/archive/team-reset" ] || {
  _n="$(find "$TAP_HOME/archive/team-reset" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  [ "$_n" = 0 ] || { echo "reset-spool-cofate: (2) refuse must not leave a checkpoint" >&2; exit 1; }
}
echo "reset-spool-cofate: 2/2 - unclassified refuses; no mutation: ok"

echo "reset-spool-cofate: ok"
