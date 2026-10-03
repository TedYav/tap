#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "do not source; run this test through smoke-all --only" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export TAP_HOME="$WORK/bus" TAP_INDEX_HOME="$WORK/index"
export TAP_SPOOL_DISABLE_OPPORTUNISTIC=1 TAP_SPOOL_DISABLE_DELIVERER=1
mkdir -p "$TAP_HOME" "$WORK/repo" "$TAP_INDEX_HOME"
printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
cat > "$TAP_HOME/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"t","worktree_root":"$WORK/repo"},"seats":{"alice":{"delivery":"poll","status":"active","harness":"codex"},"peer":{"delivery":"poll","status":"active","harness":"codex"}}}
JSON
. "$ROOT/skills/tap/scripts/smoke/runtime-helpers.sh"
. "$ROOT/skills/tap/scripts/smoke/native-authority-fixture.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-park-fixture.sh"
. "$ROOT/skills/tap/scripts/smoke/spool-engine-fixture.sh"
spool_deadline() { # <id> <verb> [<args>...]: the native deadline door, argv as the drain passes it
  local id="$1" verb="$2" team acting; shift 2
  team="$(spool_team_fixture)"
  acting="$(acting_registry_fixture "$team" 2>/dev/null || true)"
  tap_bun_call spool-deadline "$id" spool-deadline.ts "$TAP_HOME" "$TAP_SPOOL" "$TAP_REGISTRY_EVENTS" \
    "$team" "${TAP_VERB:-tap}" "$acting" "$_TAP_SCRIPT_DIR" none "" "" "$(date +%s)" 1800 "$verb" "$@"
}
tap_ensure_dirs
mkdir -p "$TAP_HOME/spool"
fixture() {
  python3 - "$TAP_HOME" "$1" "$2" <<'PY'
import json,sys
from pathlib import Path
bus,ident,attempts=Path(sys.argv[1]),sys.argv[2],int(sys.argv[3])
p=bus/'spool'/f'{ident}.md'
p.write_bytes(f'---\nid: {ident}\nfrom: alice\nto: peer\nkind: discuss\nreply: expected\npath: {bus}/payloads/{ident}.md\n---\n'.encode()+b'Literal $() `body`\r\n\xE2\x98\x83\nno final newline')
(bus/'spool'/f'{ident}.meta.json').write_text(json.dumps({'id':ident,'attempts':attempts,'attempt_fence':1,'reason':'busy'}))
PY
}
fixture attempted 1
if bash "$ROOT/bin/tap" resend attempted --by alice --json > "$WORK/refusal" 2>&1; then
  echo 'resend allowed a recorded attempt' >&2; exit 1
fi
python3 - "$WORK/refusal" <<'PY'
import json,sys
raw=open(sys.argv[1]).read(); print(raw); v=json.loads(raw); assert v['error_class']=='delivery_attempted',v
PY
fixture never 0
cp "$TAP_HOME/spool/never.md" "$WORK/original"
bash "$ROOT/bin/tap" resend never --by alice --json > "$WORK/result"
python3 - "$TAP_HOME" "$WORK" <<'PY'
import json,sys
from pathlib import Path
bus,work=map(Path,sys.argv[1:])
r=json.load(open(work/'result')); new=r['id']; assert new!='never'
p=bus/'payloads'/f'{new}.md'
assert p.exists(),r
old=(work/'original').read_bytes(); newbytes=p.read_bytes()
assert newbytes.split(b'---\n',2)[2]==old.split(b'---\n',2)[2], 'body bytes changed'
assert b'resend_of: never\n' in newbytes
assert not (bus/'spool/never.md').exists(), 'old spool copy survives'
assert (bus/'archive/never.cancelled.md').read_bytes()==old
PY
refuses() {
  local id="$1" expected="$2"
  if bash "$ROOT/bin/tap" resend "$id" --by alice --json > "$WORK/refusal" 2>&1; then
    echo "unexpected resend success: $id" >&2; exit 1
  fi
  python3 - "$WORK/refusal" "$expected" <<'PY'
import json,sys
raw=open(sys.argv[1]).read()
assert json.loads(raw)['error_class']==sys.argv[2],raw
PY
}
refuses never already_resent
# Review counterexamples: neither invalid authority nor an interrupt-class
# envelope may consume the original before ordinary send refuses or interrupts.
fixture corruptflip 0
mkdir -p "$TAP_INDEX_HOME"
printf '{bad' > "$TAP_INDEX_HOME/global-registry.json"
refuses corruptflip invalid_flip
[ ! -e "$TAP_HOME/receipts/corruptflip.resent" ] && [ -f "$TAP_HOME/spool/corruptflip.md" ]
printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # restore the born-live marker
for shape in escalate urgency policy; do
  fixture "interrupt-$shape" 0
  python3 - "$TAP_HOME" "$shape" <<'PY'
from pathlib import Path
import json,sys
bus,shape=Path(sys.argv[1]),sys.argv[2]
p=bus/'spool'/f'interrupt-{shape}.md'
if shape=='escalate': p.write_bytes(p.read_bytes().replace(b'kind: discuss',b'kind: escalate'))
if shape=='urgency': p.write_bytes(p.read_bytes().replace(b'kind: discuss',b'kind: discuss\nurgency: urgent'))
if shape=='policy':
 p=bus/'spool'/f'interrupt-{shape}.meta.json'; v=json.loads(p.read_bytes());v['policy']='urgent';p.write_text(json.dumps(v))
PY
  refuses "interrupt-$shape" interrupt_resend
  [ ! -e "$TAP_HOME/receipts/interrupt-$shape.resent" ] && [ -f "$TAP_HOME/spool/interrupt-$shape.md" ]
done
fixture legacy 0
python3 - "$TAP_HOME/spool/legacy.meta.json" <<'PY'
import json,sys
p=sys.argv[1]; v=json.load(open(p)); del v['attempt_fence']; json.dump(v,open(p,'w'))
PY
refuses legacy effect_unknown
fixture claimed 0
printf '{}' > "$TAP_HOME/spool/claimed.claim"
refuses claimed delivery_busy
fixture crash 0
[ "$(tap_bun_call attempt-evidence crash delivery-attempt.ts begin "$TAP_HOME" crash)" = created ]  # the courier's attempt mint
refuses crash delivery_attempted
fixture audit 0
printf '{}' > "$TAP_HOME/payloads/audit.attempts"
refuses audit delivery_attempted
fixture wrongsender 0
sed 's/from: alice/from: other/' "$TAP_HOME/spool/wrongsender.md" > "$WORK/other"
cp "$WORK/other" "$TAP_HOME/spool/wrongsender.md"
refuses wrongsender not_sender
fixture native 0
printf '{}' > "$TAP_HOME/spool/native.json"
refuses native effect_unknown
# Actual cancellation preserves the metadata needed by a later explicit resend.
fixture cancelled 0
bash "$ROOT/bin/tap" cancel cancelled --by alice --spooled --json > "$WORK/cancel"
[ -f "$TAP_HOME/archive/cancelled.meta.json" ]
bash "$ROOT/bin/tap" resend cancelled --by alice --json > "$WORK/cancel-resend"
# Actual terminalization keeps the same proof beside the promoted canonical.
fixture unrouted 0
[ "$(spool_deadline unrouted terminalize unrouted peer '' unrouted spool_terminal_unrouted)" = ok ]
bash "$ROOT/bin/tap" resend unrouted --by alice --json > "$WORK/unrouted-resend"
# Native single copy-mode refusal/cancel admission is covered by
# spool-drain-effects.test.ts, at the live redelivery entry point.
# Digest members also need markers before the single shared pane attempt.
# The digest walk runs in the native engine's fresh shell, beyond in-process
# overrides: a PATH mock pane whose first send-keys (the shared effect) checks
# both members' markers and then fails.
fixture digest-a 0
fixture digest-b 0
mkdir -p "$WORK/bin"
cat > "$WORK/bin/tmux" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  list-sessions) printf 'sess\t4242:100\t1\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%99\tcodex\t5701\t4242:100\t0\n' ;;
  display-message)
    case "${*: -1}" in
      '#{pid}:#{start_time}') printf '4242:100\n' ;;
      *pane_in_mode*) echo 0 ;;
      *pane_id*pane_current_command*) printf '%%99\tsess\t5701\tcodex\t0\n' ;;
      *pane_current_command*) echo codex ;;
      *pane_id*) echo %99 ;;
      *) echo ;;
    esac ;;
  capture-pane) printf '› \n' ;;
  send-keys)
    : > "$MOCK_WORK/digest-effect"
    for member in digest-a digest-b; do
      [ -f "$TAP_HOME/receipts/$member.attempted" ] || echo "$member missing pre-effect marker" > "$MOCK_WORK/digest-failure"
    done
    exit 1 ;;
esac
MOCK
chmod +x "$WORK/bin/tmux"
cat > "$TAP_HOME/registry.json" <<JSON
{"schema": "0.20", "team":{"name":"t","worktree_root":"$WORK/repo"},"seats":{"alice":{"delivery":"poll","status":"active","harness":"codex"},"peer":{"status":"active","harness":"codex","session":"sess","pane":"sess:0.0","pane_id":"%99","server_epoch":"srv:4242:100","boot_id":"boot:1"}}}
JSON
digest_rc=0
PATH="$WORK/bin:$PATH" MOCK_WORK="$WORK" TAP_BOOT_ID=boot:1 TMUX=/fake/socket \
  spool_engine_fixture digest "$TAP_HOME/registry.json" t peer sess:0.0 %99 digest-a digest-b > "$WORK/digest.log" 2>&1 || digest_rc=$?
[ "$digest_rc" != 0 ] || { cat "$WORK/digest.log"; echo 'digest reported success after a failed pane effect' >&2; exit 1; }
[ -f "$WORK/digest-effect" ] || { cat "$WORK/digest.log"; echo 'digest never reached the shared pane effect' >&2; exit 1; }
[ ! -e "$WORK/digest-failure" ] || { cat "$WORK/digest-failure"; exit 1; }
refuses digest-a delivery_attempted
refuses digest-b delivery_attempted
# Exercise proof creation through the actual park writer; old zero metadata
# must never be silently upgraded when that writer sees it again.
fixture born 0
mv "$TAP_HOME/spool/born.md" "$WORK/born.md"
rm "$TAP_HOME/spool/born.meta.json"
spool_park_fixture born "$WORK/born.md" peer t busy > /dev/null
python3 - "$TAP_HOME/spool/born.meta.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1])); assert v['attempt_fence']==1,v
PY
spool_park_fixture legacy "$TAP_HOME/spool/legacy.md" peer t busy > /dev/null
refuses legacy effect_unknown
echo 'resend: PASS'
