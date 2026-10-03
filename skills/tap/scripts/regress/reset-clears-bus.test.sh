#!/usr/bin/env bash
# reset-clears-bus.test.sh — recoverable team reset (tap-9tqt).
# Proves: reset checkpoints+clears traffic and registry; --keep-registry is
# refused (use team down); path-shape guard refuses without
# --allow-nonstandard-bus-path; --force is confirmation-only and does NOT
# override the path guard (fail-closed vs the old meaning); idempotent on a
# clean bus.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
BUSROOT="$(mktemp -d)"
trap 'rm -rf "$BUSROOT"' EXIT
export TAP_HOME="$BUSROOT/.tap/bus"
export TAP_SCRATCH_ONLY="$BUSROOT"
export TAP_SESSION_MANIFEST="$BUSROOT/sessions.json"
printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/input-backups" "$TAP_HOME/tmp"

seed() {
  mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/input-backups" "$TAP_HOME/tmp"
  printf 'x\n' > "$TAP_HOME/payloads/p1.md"
  printf 'x\n' > "$TAP_HOME/receipts/p1.done"
  printf 'x\n' > "$TAP_HOME/input-backups/b1.md"
  printf 'x\n' > "$TAP_HOME/tmp/inline-1.md"
  # poll: reset-stop hard-gates pane-backed unverified seats; archive/clear
  # smokes only need a registry row that does not invent a kill target.
  printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{"claude":{"status":"active","delivery":"poll"}}}\n' > "$TAP_HOME/registry.json"
}

# 1. plain reset (--yes) clears traffic + registry into a COMPLETE checkpoint.
seed
out="$("$TAP" team reset --yes 2>&1)" || { echo "reset: plain reset failed" >&2; echo "$out" >&2; exit 1; }
[ -z "$(ls -A "$TAP_HOME/payloads" 2>/dev/null)" ] || { echo "reset: payloads not cleared" >&2; exit 1; }
[ -z "$(ls -A "$TAP_HOME/receipts" 2>/dev/null)" ] || { echo "reset: receipts not cleared" >&2; exit 1; }
[ ! -f "$TAP_HOME/registry.json" ] || { echo "reset: registry not removed" >&2; exit 1; }
BUNDLE="$(ls "$TAP_HOME/archive/team-reset" | head -1)"
[ -n "$BUNDLE" ] && [ -f "$TAP_HOME/archive/team-reset/$BUNDLE/COMPLETE" ] \
  || { echo "reset: missing COMPLETE checkpoint" >&2; exit 1; }
[ -d "$TAP_HOME/payloads" ] && [ -d "$TAP_HOME/receipts" ] && [ -d "$TAP_HOME/tmp" ] \
  || { echo "reset: bus dirs not recreated" >&2; exit 1; }
# input-backups are now checkpointed (full-team reinit), not preserved live.
[ ! -e "$TAP_HOME/input-backups/b1.md" ] || { echo "reset: input-backups should have been checkpointed away" >&2; exit 1; }
[[ "$out" == *"tap in"* ]] || { echo "reset: success receipt must name tap in rejoin" >&2; echo "$out" >&2; exit 1; }
# prior_reset_generation recorded in meta (null/absent on first reset is fine as key).
python3 -B - "$TAP_HOME/archive/team-reset/$BUNDLE/meta.json" <<'PY'
import json, sys
meta = json.load(open(sys.argv[1]))
assert meta.get("kind") == "team-reset", meta
assert "prior_reset_generation" in meta, meta
PY
# --json dry-run + success emit structured schema with rejoin.
jsd="$("$TAP" team reset --dry-run --json 2>/dev/null)" \
  || { echo "reset: --dry-run --json failed" >&2; exit 1; }
python3 -B -c 'import json,sys; d=json.loads(sys.argv[1]); assert d.get("dry_run") is True and d.get("rejoin")=="tap in", d' "$jsd" \
  || { echo "reset: dry-run json schema wrong" >&2; echo "$jsd" >&2; exit 1; }
seed
js="$("$TAP" team reset --yes --json 2>/dev/null)" \
  || { echo "reset: --yes --json failed" >&2; exit 1; }
python3 -B -c 'import json,sys; d=json.loads(sys.argv[1]); assert d.get("ok") and d.get("rejoin")=="tap in" and d.get("bundle_id") and d.get("archive"), d' "$js" \
  || { echo "reset: success json schema wrong" >&2; echo "$js" >&2; exit 1; }
echo "reset: 1/4 — reset checkpoints+clears; COMPLETE; tap in rejoin; --json schema: ok"

# 2. REPURPOSE: --keep-registry refuses; team down is the preserve-identity door.
seed
if out="$("$TAP" team reset --keep-registry --yes 2>&1)"; then
  echo "reset: --keep-registry should refuse" >&2; echo "$out" >&2; exit 1
fi
[[ "$out" == *"keep-registry"* && "$out" == *"team down"* ]] \
  || { echo "reset: --keep-registry refusal must name team down" >&2; echo "$out" >&2; exit 1; }
[ -f "$TAP_HOME/registry.json" ] || { echo "reset: refusal mutated registry" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/p1.md" ] || { echo "reset: refusal mutated payloads" >&2; exit 1; }
echo "reset: 2/4 — --keep-registry refuses; points at team down; no mutation: ok"

# 3. path guard: nonstandard TAP_HOME refuses; --force does NOT override (fail-closed);
#    --allow-nonstandard-bus-path does.
BOGUS="$BUSROOT/not-a-bus"
mkdir -p "$BOGUS/payloads" "$BOGUS/receipts" "$BOGUS/tmp"
printf '{"schema": "0.20", "team":{"name":"x"},"seats":{}}\n' > "$BOGUS/registry.json"
printf 'x\n' > "$BOGUS/payloads/marker.md"
if TAP_HOME="$BOGUS" "$TAP" team reset --yes >/dev/null 2>&1; then
  echo "reset: footgun guard did not refuse a non-.tap/bus path" >&2; exit 1
fi
[ -f "$BOGUS/payloads/marker.md" ] || { echo "reset: refused path was still wiped!" >&2; exit 1; }
# Amendment 4: --force on reset is a loud unknown_option (not a confirm synonym).
force_out="$(TAP_HOME="$BOGUS" "$TAP" team reset --force 2>&1 || true)"
case "$force_out" in
  *unknown_option*|*"unknown option"*) ;;
  *) echo "reset: --force must refuse unknown_option; got: $force_out" >&2; exit 1 ;;
esac
[ -f "$BOGUS/payloads/marker.md" ] || { echo "reset: --force path still wiped!" >&2; exit 1; }
TAP_HOME="$BOGUS" TAP_SCRATCH_ONLY="$BUSROOT" "$TAP" team reset --yes --allow-nonstandard-bus-path >/dev/null 2>&1 \
  || { echo "reset: --allow-nonstandard-bus-path did not override the guard" >&2; exit 1; }
[ ! -f "$BOGUS/payloads/marker.md" ] || { echo "reset: allow path did not clear traffic" >&2; exit 1; }
echo "reset: 3/4 — path guard refuses; --force fail-closed; --allow-nonstandard-bus-path overrides: ok"

# 4. idempotent: reset on an already-empty bus exits 0.
"$TAP" team reset --yes >/dev/null 2>&1 || { echo "reset: second reset (empty bus) failed" >&2; exit 1; }
echo "reset: 4/4 — idempotent on an empty bus: ok"

echo "reset-clears-bus: ok"
