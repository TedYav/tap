#!/usr/bin/env bash
# reset-archives.test.sh - durable team-reset checkpoints (tap-9tqt / tap-kf9).
# Checkpoints live under $TAP_HOME/archive/team-reset/<bundle>/ with bus/ + COMPLETE.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_SCRATCH_ONLY="$WORK"
export TAP_SESSION_MANIFEST="$WORK/sessions.json"
printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"

archive_count() {
  if [ -d "$TAP_HOME/archive/team-reset" ]; then
    find "$TAP_HOME/archive/team-reset" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' '
  else
    echo 0
  fi
}

latest_archive() {
  find "$TAP_HOME/archive/team-reset" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | sort | tail -1
}

archive_from_output() {
  printf '%s\n' "$1" | sed -n 's/^tap team reset:   archive=//p' | tail -1
}

seed_bus() {
  mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp" "$TAP_HOME/input-backups"
  printf 'payload\n' > "$TAP_HOME/payloads/p1.md"
  printf 'receipt\n' > "$TAP_HOME/receipts/p1.done"
  printf 'tmp\n' > "$TAP_HOME/tmp/staged.md"
  printf 'sensitive\n' > "$TAP_HOME/input-backups/keep.md"
  # poll seat: archive smokes need a registry row without a pane target so
  # reset-stop's hard-gate (pane-backed nokill ⇒ refuse) does not abort.
  printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{"codex":{"status":"active","delivery":"poll"}}}\n' > "$TAP_HOME/registry.json"
  printf 'lock\n' > "$TAP_HOME/registry.json.lock"
  # tap-ncd4: every normally-operated bus carries this pane-effect authority
  # marker (tap_ensure_dirs stamps it on first write) — a real reset fixture
  # that omits it tests a bus shape that does not occur in production.
  printf 'bootstrapped_at_epoch=1\n' > "$TAP_HOME/.tap-bus-authority"
}

# 1. Populated bus → COMPLETE checkpoint under team-reset/; live traffic gone;
#    prior archive/ siblings preserved; input-backups ride the checkpoint.
# Bare reset is intentional: recoverability, not blast radius, governs the gate
# boundary (tap-7r9c).
export TAP_HOME="$WORK/repo/.tap/bus"
seed_bus
mkdir -p "$TAP_HOME/locks"
printf 'lock inode\n' > "$TAP_HOME/locks/pane-submit-fixture.lock"
lock_inode="$(python3 -c 'import os,sys; s=os.stat(sys.argv[1]); print(s.st_dev,s.st_ino)' "$TAP_HOME/locks/pane-submit-fixture.lock")"
mkdir -p "$TAP_HOME/archive/preexisting"
printf 'archive\n' > "$TAP_HOME/archive/preexisting/old.txt"
out="$("$TAP" team reset 2>&1)" || { echo "reset-archives: (1) bare reset failed" >&2; echo "$out" >&2; exit 1; }
[ "$(python3 -c 'import os,sys; s=os.stat(sys.argv[1]); print(s.st_dev,s.st_ino)' "$TAP_HOME/locks/pane-submit-fixture.lock")" = "$lock_inode" ] \
  || { echo "reset-archives: lock inode changed across reset" >&2; exit 1; }
arc="$(archive_from_output "$out")"
[ -n "$arc" ] || { echo "reset-archives: (1) no archive created" >&2; exit 1; }
[ -f "$arc/COMPLETE" ] || { echo "reset-archives: (1) missing COMPLETE" >&2; exit 1; }
[ -f "$arc/bus/payloads/p1.md" ] || { echo "reset-archives: (1) payload not archived" >&2; exit 1; }
[ -f "$arc/bus/receipts/p1.done" ] || { echo "reset-archives: (1) receipt not archived" >&2; exit 1; }
[ -f "$arc/bus/registry.json" ] || { echo "reset-archives: (1) registry not archived" >&2; exit 1; }
[ -f "$arc/bus/input-backups/keep.md" ] || { echo "reset-archives: (1) input-backups not checkpointed" >&2; exit 1; }
[ ! -e "$arc/bus/tmp/staged.md" ] || { echo "reset-archives: (1) tmp should not be archived" >&2; exit 1; }
[ -f "$TAP_HOME/archive/preexisting/old.txt" ] || { echo "reset-archives: (1) existing archive should remain live" >&2; exit 1; }
# tap-ncd4: the pane-effect authority marker is preserve-fated — a normally
# stamped bus stays authorized across a reset (same bus, no re-earning), and
# the marker never rides the checkpoint (that would make an archived bundle
# from a DIFFERENT, unauthorized bus falsely look authorized on restore).
[ -f "$TAP_HOME/.tap-bus-authority" ] || { echo "reset-archives: (1) pane-effect authority marker did not survive the reset — every future send would refuse to redeliver" >&2; exit 1; }
[ ! -e "$arc/bus/.tap-bus-authority" ] || { echo "reset-archives: (1) authority marker should not ride the checkpoint (preserve, not checkpoint)" >&2; exit 1; }
[ -z "$(ls -A "$TAP_HOME/payloads" 2>/dev/null)" ] || { echo "reset-archives: (1) live payloads not empty" >&2; exit 1; }
[ ! -f "$TAP_HOME/registry.json" ] || { echo "reset-archives: (1) registry should not remain live" >&2; exit 1; }
grep -q "archive=$arc" <<<"$out" \
  || { echo "reset-archives: (1) summary missing archive path" >&2; echo "$out" >&2; exit 1; }
echo "reset-archives: 1/6 - bare reset archives state with exclusions: ok"

# 2. REPURPOSE (tap-9tqt): --keep-registry refuses; live bus untouched.
export TAP_HOME="$WORK/keep/.tap/bus"
seed_bus
if out="$("$TAP" team reset --keep-registry --yes 2>&1)"; then
  echo "reset-archives: (2) --keep-registry should refuse" >&2; echo "$out" >&2; exit 1
fi
[[ "$out" == *"keep-registry"* && "$out" == *"team down"* ]] \
  || { echo "reset-archives: (2) refusal must name team down" >&2; echo "$out" >&2; exit 1; }
[ -f "$TAP_HOME/registry.json" ] || { echo "reset-archives: (2) refusal mutated registry" >&2; exit 1; }
[ -f "$TAP_HOME/payloads/p1.md" ] || { echo "reset-archives: (2) refusal mutated payloads" >&2; exit 1; }
echo "reset-archives: 2/6 - --keep-registry refuses (down replacement); no mutation: ok"

# 3. Reset never deletes a prior archive: all four remain for an explicit purge.
export TAP_HOME="$WORK/prune/.tap/bus"
for n in 1 2 3 4; do
  seed_bus
  printf '%s\n' "$n" > "$TAP_HOME/payloads/p$n.md"
  TAP_RESET_ARCHIVE_SUFFIX="case-$n" "$TAP" team reset --yes >/dev/null
done
[ "$(archive_count)" = 4 ] || { echo "reset-archives: (3) expected 4 durable archives, got $(archive_count)" >&2; find "$TAP_HOME/archive/team-reset" -mindepth 1 -maxdepth 1 -type d >&2; exit 1; }
for n in 1 2 3 4; do
  [ -d "$TAP_HOME/archive/team-reset/19700101T000000Z-case-$n" ] \
    || { echo "reset-archives: (3) missing durable archive case-$n" >&2; exit 1; }
done
echo "reset-archives: 3/6 - archive history remains durable until explicit purge: ok"

# 4. Burst invariant (tap-kf9) under natural naming.
export TAP_HOME="$WORK/burst/.tap/bus"
for n in 1 2 3 4 5; do
  seed_bus
  printf 'content-%s\n' "$n" > "$TAP_HOME/payloads/p1.md"
  "$TAP" team reset --yes >/dev/null || { echo "reset-archives: (4) burst run $n failed" >&2; exit 1; }
done
[ "$(archive_count)" = 5 ] || { echo "reset-archives: (4) a 5-run burst must leave 5 archives, got $(archive_count)" >&2; find "$TAP_HOME/archive/team-reset" -mindepth 1 -maxdepth 1 -type d >&2; exit 1; }
for n in 1 2 3 4 5; do
  grep -rqx "content-$n" "$TAP_HOME/archive/team-reset" \
    || { echo "reset-archives: (4) burst discarded the archive holding content-$n" >&2; exit 1; }
done
# The pre-burst content must sit whole in exactly one bundle's payload. Do not
# find that bundle by sorting names: a natural name is <second>-<pid>, so within
# one second a burst sorts its pids as strings ("...-10001" before "...-9998"),
# and the alphabetical first is not the chronological first.
first="$(grep -rlx content-1 "$TAP_HOME/archive/team-reset" || true)"
[ "$(printf '%s\n' "$first" | grep -c .)" = 1 ] && [ "${first##*/bus/payloads/}" = p1.md ] \
  || { echo "reset-archives: (4) the pre-burst content must survive in exactly one archive bundle's bus/payloads/p1.md, got: $first" >&2; exit 1; }
echo "reset-archives: 4/6 - a repeated-run burst never discards an earlier archive: ok"

# 5. A root with only a legacy store refuses before reset can archive or erase it.
# Root selection is the old_store boundary; an explicit arbitrary TAP_HOME is
# still a custom bus, regardless of its spelling.
export TAP_HOME="$WORK/legacy/tmp/tap"
seed_bus
export TAP_INDEX_HOME="$WORK/legacy-index"
mkdir -p "$TAP_INDEX_HOME"
cat > "$TAP_INDEX_HOME/global-registry.json" <<JSON
{"schema":"0.20","teams":{"legacy":{"root":"$WORK/legacy","registry_location":"$TAP_HOME/registry.json","state":"registered"}}}
JSON
if out="$(cd "$WORK/legacy" && env -u TAP_HOME -u TAP_REGISTRY "$TAP" team reset --yes --json 2>&1)"; then
  echo "reset-archives: (5) legacy-only root accepted reset" >&2; exit 1
fi
[[ "$out" == *'"old_store"'* ]] \
  || { echo "reset-archives: (5) expected old_store: $out" >&2; exit 1; }
[ "$(cat "$TAP_HOME/payloads/p1.md")" = payload ] \
  && [ "$(cat "$TAP_HOME/receipts/p1.done")" = receipt ] \
  && [ "$(cat "$TAP_HOME/input-backups/keep.md")" = sensitive ] \
  && [ -f "$TAP_HOME/registry.json" ] \
  && [ ! -e "$TAP_HOME/archive" ] \
  && [ ! -e "$WORK/legacy/.tap/bus" ] \
  || { echo "reset-archives: (5) refusal changed legacy evidence or created a bus" >&2; exit 1; }
echo "reset-archives: 5/6 - legacy-only root refuses reset without mutation: ok"

# Reuse a current bus's archive for the destructive-purge control.
export TAP_HOME="$WORK/burst/.tap/bus"
arc="$(latest_archive)"
# 6. Purge crosses the irreversible boundary: non-TTY still requires --yes and
# must preserve the exact archive on refusal (same tap-7r9c ruling, keep side).
archive_name="$(basename "$arc")"
# Born live, purge resolves the team through its registry, which the reset
# above archived; a live team re-registers before it purges.
printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{}}\n' > "$TAP_HOME/registry.json"
set +e
purge_out="$("$TAP" team purge "$archive_name" </dev/null 2>&1)"
purge_rc=$?
set -e
[ "$purge_rc" -ne 0 ] || { echo "reset-archives: (6) purge without --yes should refuse" >&2; echo "$purge_out" >&2; exit 1; }
[[ "$purge_out" == *"without confirmation"* && "$purge_out" == *"--yes"* ]] \
  || { echo "reset-archives: (6) purge refusal lost confirmation boundary" >&2; echo "$purge_out" >&2; exit 1; }
[ -d "$arc" ] || { echo "reset-archives: (6) refused purge removed its archive" >&2; exit 1; }
"$TAP" team purge "$archive_name" --yes >/dev/null
[ ! -e "$arc" ] || { echo "reset-archives: (6) confirmed purge left its archive" >&2; exit 1; }
echo "reset-archives: 6/6 - purge remains confirmation-gated and exact: ok"

echo "reset-archives: ok"
