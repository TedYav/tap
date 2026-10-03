#!/usr/bin/env bash
# .81: late human text must not receive the courier's Enter or draft cleanup.
# Run through smoke-all --only; all pane operations below are a file-backed mock.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus" TAP_INDEX_HOME="$WORK/index"
export TAP_SPOOL_DISABLE_DELIVERER=1 TAP_TUI_SETTLE_SCALE=0
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-park-fixture.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-engine-fixture.sh"
tap_ensure_dirs
FIXTURE="$ROOT/skills/tap/scripts/smoke/fixtures/submit-verify/claude-draft-cursor-at-start.ansi"
FRAME="$WORK/frame"
failures=0
bad() { echo "draft-submit-boundary: FAIL $*" >&2; failures=$((failures + 1)); }
frame() {
  python3 -B - "$FIXTURE" "$FRAME" "$1" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
old='\x1b[7mh\x1b[0mello world draft'
assert old in s
Path(sys.argv[2]).write_text(s.replace(old,sys.argv[3]))
PY
}
reset_frame() {
  frame "$1"
  printf 0 > "$WORK/enters"
  : > "$WORK/keys"
  rm -f "${WORK:?}/late-second" "${WORK:?}/swallow-first" "${WORK:?}/late-first" "${WORK:?}/arm-after-inject" "${WORK:?}/capture-fail" "${WORK:?}/identity-flip" "${WORK:?}/pane-gone" "${WORK:?}/stale-redraw" "${WORK:?}/stale-paints"
  rm -rf "${WORK:?}/bus/input-backups"
}
# Composer reads for assertions use the native reader over a fixture frame.
band() {
  local v
  v="$(cat "$FRAME" | TAP_PANE_WIDTH="$(tmux display-message -p -t %7 '#{pane_width}' 2>/dev/null || true)" \
    bun "$ROOT/runtime/bun/test/support/pending-input-cli.ts" %7 claude --frame)" || return 3
  case "$v" in text$'\037'*) printf '%s' "${v#text?}" ;; *) return 3 ;; esac
}
# The clobber door's Bun effects spawn the LITERAL tmux binary through PATH, so
# the mock is a PATH script, not a shell function (the shape other smokes use):
# every arm below exercises the same bytes whether the caller is lib.sh or the
# door. Optional marker files arm the deterministic interleaves.
export TAP_MOCK_WORK="$WORK" TAP_MOCK_FRAME="$FRAME" TAP_MOCK_FIXTURE="$FIXTURE"
mkdir -p "$WORK/bin"
cat > "$WORK/bin/tmux" <<'MOCK'
#!/usr/bin/env bash
set -u
WORK="${TAP_MOCK_WORK:?}" FRAME="${TAP_MOCK_FRAME:?}" FIXTURE="${TAP_MOCK_FIXTURE:?}"
mock_frame() {
  python3 -B - "$FIXTURE" "$FRAME" "$1" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
old='\x1b[7mh\x1b[0mello world draft'
assert old in s
Path(sys.argv[2]).write_text(s.replace(old,sys.argv[3]))
PY
}
case "$1" in
  list-sessions)
    # The native identity check (observe.ts) resolves session and server epoch from these.
    printf 'sess\t4242:100\t1\n' ;;
  list-panes)
    printf 'sess\tsess:0.0\t%%7\tclaude\t5701\t4242:100\t0\n' ;;
  capture-pane)
    [ ! -f "$WORK/capture-fail" ] || exit 1
    # Armed late human draft: fires on the first capture once THIS transaction's
    # digest index is published (readiness also captures, before publication),
    # i.e. at submit. The arm file names a member id: an earlier case's retained
    # index (policy-clobber keeps its own) must not fire it during readiness.
    if [ -s "$WORK/inject-after-index" ] \
      && grep -qsF "\"$(cat "$WORK/inject-after-index")\"" "$WORK"/bus/spool/digests/*.json; then
      mv -f "$WORK/inject-after-index" "$WORK/inject-fired"
      mock_frame S
      : > "$WORK/draft-after-index"
    fi
    # A delayed TUI repaint: while paints remain, every capture still shows the
    # stale pre-recovery frame; only then does the re-injected FRAME become
    # visible.
    if [ -f "$WORK/stale-paints" ]; then
      paints="$(cat "$WORK/stale-paints")"
      if [ "$paints" -gt 0 ]; then
        printf '%s' $((paints - 1)) > "$WORK/stale-paints"
        case " $* " in
          *' -e '*) cat "$WORK/stale-redraw" ;;
          *) python3 -B - "$WORK/stale-redraw" <<'PY'
import re,sys
print(re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',open(sys.argv[1]).read()),end='')
PY
          ;;
        esac
        exit 0
      fi
      rm -f "${WORK:?}/stale-paints"
    fi
    case " $* " in
      *' -e '*) cat "$FRAME" ;;
      *) python3 -B - "$FRAME" <<'PY'
import re,sys
print(re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',open(sys.argv[1]).read()),end='')
PY
      ;;
    esac ;;
  display-message)
    case "${@: -1}" in
      *pane_in_mode*) printf '0\n' ;;
      # The Bun reader's 4-field compound (pane_id, session, pid, command).
      *pane_id*pane_current_command*)
        [ ! -f "$WORK/pane-gone" ] || exit 1
        pid='%7'
        if [ -f "$WORK/identity-flip" ]; then
          flips=$(cat "$WORK/identity-flip" 2>/dev/null || echo 0)
          flips=$((flips + 1))
          printf '%s' "$flips" > "$WORK/identity-flip"
          # The band read carries no paneId comparison; the drift appears at
          # the SECOND pane observation — the clear loop's authorization,
          # which alone compares against the bound pane id.
          [ "$flips" = 2 ] && pid='%8'
        fi
        printf '%s\tsess\t4242\tclaude\t0\n' "$pid" ;;
      # lib.sh's own observe compound keeps its historical 3 fields.
      *pane_id*session_name*) [ ! -f "$WORK/pane-gone" ] || exit 1; printf '%%7\tsess\t4242:100\n' ;;
      # The server-identity probe (no target): pid:start_time. Keep this after
      # compound records, whose final field contains the same expansion.
      *'#{pid}:#{start_time}'*) printf '4242:100\n' ;;
      *pane_id*)
        [ ! -f "$WORK/pane-gone" ] || exit 1
        pid='%7'
        if [ -f "$WORK/identity-flip" ]; then
          rm -f "${WORK:?}/identity-flip"
          pid='%8'
        fi
        printf '%s\n' "$pid" ;;
      *pane_current_command*) printf 'claude\n' ;;
      *pane_width*) printf '200\n' ;;
      *) printf 'sess\n' ;;
    esac ;;
  send-keys)
    printf '%s\n' "$*" >> "$WORK/keys"
    case "${@: -1}" in
      Enter)
        n=$(( $(cat "$WORK/enters") + 1 )); printf '%s' "$n" > "$WORK/enters"
        if [ "$n" != 1 ] || [ ! -f "$WORK/swallow-first" ]; then mock_frame ''; fi ;;
      C-u|BSpace) mock_frame '' ;;
      *) case " $* " in *' -l '*)
        mock_frame "${@: -1}"
        # A delayed repaint arms stale paints for captures after this inject.
        if [ -f "$WORK/stale-redraw" ]; then printf 2 > "$WORK/stale-paints"; fi
      ;; esac ;;
    esac ;;
  *) exit 0 ;;
esac
MOCK
chmod +x "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH"

# The real digest transaction must honor the configured draft policy at the pane.
# tap_bound_pane_identity_state (via observe.ts's native tap_seat_observed_record)
# confirms liveness against session/server_epoch/boot_id, not pane/pane_id alone;
# these must match what the fake tmux's new list-sessions case reports (session
# "sess", epoch "srv:4242:100" -- observe.ts's serverEpochFromRaw prefixes the raw
# pid:start_time with "srv:") or identity resolves gone/stale and the whole digest
# transaction refuses before ever reaching submit -- readiness="gone" is what
# "expired note draft did not deliver" traces to. TAP_BOOT_ID is honored directly
# by the native snapshot; TAP_SERVER_EPOCH is not (server epoch is read from the
# live tmux session, not env), so only TAP_BOOT_ID needs exporting here.
export XDG_CONFIG_HOME="$WORK/config" TAP_BOOT_ID="boot:1"
mkdir -p "$XDG_CONFIG_HOME/tap"
# observe.ts's native liveness snapshot cross-checks the registry row's "pane"
# against the OBSERVED window.pane address from a real list-panes row (sess:0.0),
# never the bare pane_id -- passing %7 for both fields (as elsewhere in this file,
# where only direct tmux -t targeting is exercised) resolves pane_drift here.
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"t"},"seats":{"peer":{"harness":"claude","pane":"sess:0.0","pane_id":"%7","status":"active","session":"sess","server_epoch":"srv:4242:100","boot_id":"boot:1"}}}
JSON
for behavior in warn clobber; do
  reset_frame 'recover this draft'
  printf '[injection]\nbehavior="%s"\n' "$behavior" > "$XDG_CONFIG_HOME/tap/config.toml"
  id="policy-$behavior"
  printf -- '---\nid: %s\nfrom: sender\nto: peer\nkind: discuss\nreply: settle-only\n---\nbody\n' "$id" > "$WORK/$id.md"
  TAP_AUTOSETTLE_HOLD_SECONDS=0 spool_park_fixture "$id" "$WORK/$id.md" peer t pending-input busy '' \
    sess:0.0 %7 '' autosettle 30 "$TAP_HOME/registry.json" >/dev/null
  python3 -B - "$TAP_SPOOL/$id.meta.json" <<'PYMETA'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['draft_deadline_epoch']=1
with open(p,'w') as f: json.dump(d,f)
PYMETA
  rc=0
  spool_engine_fixture digest "$TAP_HOME/registry.json" '' peer sess:0.0 %7 "$id" > "$WORK/policy.log" 2>&1 || rc=$?
  if [ "$behavior" = warn ]; then
    [ "$rc" != 0 ] && [ "$(cat "$WORK/enters")" = 0 ] && [ ! -s "$WORK/keys" ] || bad 'warn affected an occupied pane'
    [ -f "$TAP_SPOOL/$id.md" ] || bad 'warn lost queued note'
  else
    [ "$rc" = 0 ] || { cat "$WORK/policy.log" >&2; bad 'expired note draft did not deliver'; }
    [ "$(cat "$WORK/enters")" -gt 0 ] || bad 'clobber never submitted note'
    backup="$(find "$TAP_INPUT_BACKUPS" -name '*.md' -type f -print -quit)"
    [ -n "$backup" ] && grep -q 'recover this draft' "$backup" || bad 'clobber lost original draft'
  fi
done

# Real digest transaction: publish two ordinary parks, observe an empty composer,
# then type one character after the real index write and before shared submission.
reset_frame ''
cat > "$TAP_HOME/registry.json" <<'JSON'
{"schema": "0.20", "team":{"name":"t"},"seats":{"peer":{"harness":"claude","pane":"sess:0.0","pane_id":"%7","status":"active","session":"sess","server_epoch":"srv:4242:100","boot_id":"boot:1"}}}
JSON
for id in late-digest-a late-digest-b; do
  printf -- '---\nid: %s\nfrom: sender\nto: peer\nkind: discuss\nreply: expected\n---\nbody %s\n' "$id" "$id" > "$WORK/$id.md"
  TAP_AUTOSETTLE_HOLD_SECONDS=0 spool_park_fixture "$id" "$WORK/$id.md" peer t window '' '' \
    sess:0.0 %7 '' standard '' "$TAP_HOME/registry.json" >/dev/null
 done
# Use the production readiness predicate; only its bound identity was pinned above.
#
# THE SEAM IS THE SUBMIT, NOT THE INDEX WRITE. This arm types a human draft into the
# window between publication and submission, and it used to reach that window by wrapping
# `tap_digest_write_index`. That write now happens inside `spool-digest-inject.ts`, where a
# Bash wrapper cannot intercept it — a stub of a function the port moved would silently
# stop firing, which is how a retired seam survives a sweep that only reads `smoke/`.
# The submit runs in the retained owner's fresh shell, beyond any Bash wrapper
# here; the PATH mock types the draft instead (see its capture-pane arm).
printf 'late-digest-a' > "$WORK/inject-after-index"
rc=0
spool_engine_fixture digest "$TAP_HOME/registry.json" '' peer sess:0.0 %7 late-digest-a late-digest-b \
  > "$WORK/digest.log" 2>&1 || rc=$?
[ -f "$WORK/draft-after-index" ] || { cat "$WORK/digest.log" >&2; bad 'digest control never reached the submit request'; }
[ "$rc" != 0 ] || bad 'digest accepted despite a late human draft'
[ "$(cat "$WORK/enters")" = 0 ] || bad 'digest submitted the late human draft'
[ ! -s "$WORK/keys" ] || bad 'digest cleared or typed over the late human draft'
[ "$(band)" = S ] || bad 'digest changed the late human draft'
for id in late-digest-a late-digest-b; do
  [ -f "$TAP_SPOOL/$id.md" ] && [ -f "$TAP_SPOOL/$id.meta.json" ] || bad "$id lost spool custody on pre-effect refusal"
  [ ! -f "$TAP_RECEIPTS/$id.sent" ] && [ ! -f "$TAP_RECEIPTS/$id.done" ] || bad "$id falsely claimed delivery or settlement"
done
[ "$failures" = 0 ] || exit 1
echo 'draft-submit-boundary: pre-inject draft custody and post-inject containment hold'
