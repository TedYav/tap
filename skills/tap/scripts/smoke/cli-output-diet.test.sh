#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# Fixed public receipt budgets across Bash and Bun, preserving payload bodies.
set -euo pipefail

# Mock-tmux smoke: the courier's real-TUI settle sleeps verify nothing against
# a synchronous mock — scale them down (smoke-speed PR2; default 1 in production).
export TAP_TUI_SETTLE_SCALE=0.1

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z walk: pin machine-resolved state (session manifest, opencode db,
# version-seen) for directly invoked bodies — defense-in-depth; enrollment
# itself is unindexable-by-design for custom TAP_HOME (see the PR's framing).
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
# Born live: an enrolled team root with its canonical bus (an absent marker
# opens no legacy door).
TEAM_ROOT="$(cd "$(mktemp -d)" && pwd -P)"; FAKE_BIN="$(mktemp -d)"
TAP_HOME="$TEAM_ROOT/.tap/bus"; mkdir -p "$TAP_HOME"
trap 'rm -rf "${TEAM_ROOT:?}" "${FAKE_BIN:?}"' EXIT
export TAP_HOME TAP_INDEX_HOME="$TEAM_ROOT/index" PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
export FAKE_TMUX_STATE="$TAP_HOME/fake-tmux"
unset TAP_SELF || true
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/tmux" <<EOF
#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_TMUX_STATE:?}"; mkdir -p "\$state"
cmd="\${1:-}"; shift || true
case "\$cmd" in
  # CONTRACT §Session-name authority: delivery fixtures prove the exact session,
  # numeric pane id, current generation, and expected harness together.
  list-sessions) printf 'sess\\t900:100\\n' ;;
  list-panes) printf 'sess\\tsonnet-pane\\t%%1001\\tcodex\\t4242\\t900:100\\t0\\nsess\\thermes-pane\\t%%1002\\tcodex\\t4242\\t900:100\\t0\\nsess\\tsuspended-pane\\t%%1003\\tcodex\\t4242\\t900:100\\t0\\nsess\\tsome-pane\\t%%1004\\tcodex\\t4242\\t900:100\\t0\\nsess\\tcodex-pane\\t%%1005\\tcodex\\t4242\\t900:100\\t0\\nsess\\tdurable-pane\\t%%1006\\tcodex\\t4242\\t900:100\\t0\\n' ;;
  display-message)
    target=""; fmt=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        -p) shift ;;
        -t) target="\${2:-}"; shift 2 ;;
        *)  fmt="\$1"; shift ;;
      esac
    done
    if [ "\$fmt" = '#{pid}:#{start_time}' ]; then printf '900:100\\n'; exit 0; fi
    if [ -z "\$target" ]; then echo "self:0.0"; exit 0; fi
    case "\$target" in
      sonnet-pane|%1001) pane_id=%1001 ;; hermes-pane|%1002) pane_id=%1002 ;;
      suspended-pane|%1003) pane_id=%1003 ;; some-pane|%1004) pane_id=%1004 ;;
      codex-pane|%1005) pane_id=%1005 ;; durable-pane|%1006) pane_id=%1006 ;; *) pane_id=%1007 ;;
    esac
    case "\$fmt" in
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\\tsess\\t4242\\tcodex\\t0\\n' "\$pane_id" ;;
      *pane_id*)              echo "\$pane_id" ;;
      *pane_pid*)             echo "4242" ;;
      *pane_in_mode*)         echo "0" ;;
      *pane_current_command*) echo "codex" ;;
      *pane_current_path*)    echo "$ROOT" ;;
      *) echo "" ;;
    esac ;;
  capture-pane)
    if [ -f "\$state/input" ]; then printf '› %s\n' "\$(cat "\$state/input")"; else printf '› \n'; fi ;;
  send-keys)
    if [ "\${1:-}" = "-t" ]; then shift 2; fi
    if [ "\${1:-}" = "-l" ]; then shift; [ "\${1:-}" = "--" ] && shift
      printf '%s' "\${1:-}" > "\$state/input"; printf '%s' "\${1:-}" >> "\$state/sentinels"; exit 0; fi
    if [ "\${1:-}" = "Enter" ]; then rm -f "\$state/input"; exit 0; fi ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"

cat > "$TAP_HOME/registry.json" <<'JSON'
{ "schema": "0.20", "team": { "name": "testteam" },
  "seats": {
    "sonnet": { "pane": "sonnet-pane", "pane_id": "%1001", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "hermes": { "pane": "hermes-pane", "pane_id": "%1002", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "active" },
    "ghost": { "delivery": "poll", "unattended": true, "status": "active", "reply_to": "ghost" },
    "pendingseat": { "status": "pending", "session": "testteam/pendingseat", "registered_at": "2026-07-10T00:00:00Z" },
    "suspendedseat": { "pane": "suspended-pane", "pane_id": "%1003", "session": "sess", "server_epoch": "srv:900:100", "harness": "codex", "status": "suspended", "status_reason": "test" }
  } }
JSON
tap_smoke_enroll_current "$TEAM_ROOT" "$TAP_HOME" testteam


# Fixed-ID public golden receipts and measured UTF-8 totals.
python3 -B - "$ROOT" "$TAP_HOME" <<'PYGOLD'
import json, os, pathlib, subprocess, sys
root,bus=map(pathlib.Path,sys.argv[1:])
env=dict(os.environ)
env['TAP_TUI_SETTLE_SCALE']='1'
config=bus/'config/tap';config.mkdir(parents=True,exist_ok=True)
(config/'config.toml').write_text('[delivery]\nnow_window_seconds = 0\n')
env['XDG_CONFIG_HOME']=str(config.parent)
bodyfile=bus/'body.txt';bodyfile.write_text('hello body\n')
measurements=[]
def check(label,args,expected,rc=0):
    r=subprocess.run([str(root/'bin/tap'),*args],env=env,text=True,capture_output=True)
    total=len((r.stdout+r.stderr).encode())
    measurements.append({'case':label,'stdout':len(r.stdout.encode()),'stderr':len(r.stderr.encode()),'total':total})
    if expected is not None:
        unbounded=0; budget=32
        if 'empty poll' in label: budget=16
        elif 'digest all' in label:
            unbounded=sum(len(i['id'].encode())+len(b'hermes')+len(b'hello body\n') for i in items);budget=224
        else:
            fixed_id=next((a for a in args if '-gold-' in a),'')
            unbounded=len(fixed_id.encode())
            if 'read' in label: unbounded+=len(b'beta/hermes' if 'foreign' in label else b'hermes')+len(b'hello body\n');budget=64
            elif 'progress' in label:budget=40
        measurements[-1]['metadata']=total-unbounded
        assert total-unbounded<=budget,(label,total-unbounded,budget)

    assert r.returncode==rc,(label,r.returncode,r.stdout,r.stderr)
    assert expected is None or r.stdout==expected,(label,r.stdout,expected)
    assert not r.stderr,(label,r.stderr)
    return r
runtime='bun'
ident=runtime+'-gold-send'
check(runtime+' send',['send','sonnet','--from','hermes','--ask','--delivery','now','--id',ident,'-f',str(bodyfile)],f'tap send: ok {ident}\n')
check(runtime+' read ask',['read',ident,'--by','sonnet'],f'tap read: ask {ident} from=hermes reply\nhello body\n')
check(runtime+' progress',['reply',ident,'--by','sonnet','--progress','--delivery','now','-f',str(bodyfile)],f'tap reply: progress {ident} (open)\n')
check(runtime+' reply',['reply',ident,'--by','sonnet','--delivery','now','-f',str(bodyfile)],f'tap reply: ok {ident}\n')
check(runtime+' presettled read',['read',ident,'--by','sonnet'],f'tap read: ask {ident} from=hermes already settled; nothing owed\nhello body\n')
# Poll sender and receiver exercise durable queues without pane claims.
reg=json.loads((bus/'registry.json').read_text())
reg['seats']['poller']={'status':'active','delivery':'poll'}
(bus/'registry.json').write_text(json.dumps(reg))
queued=runtime+'-gold-queued'
check(runtime+' queued',['send','poller','--from','hermes','--id',queued,'-f',str(bodyfile)],f'tap send: queued {queued}\n')
check(runtime+' assign',['assign','poller','--from','hermes','--id',runtime+'-gold-order','-f',str(bodyfile)],f'tap assign: queued {runtime}-gold-order\n')
original=runtime+'-gold-resend'
spool=bus/'spool';spool.mkdir(exist_ok=True)
oldpath=spool/(original+'.md')
oldpath.write_text(f'---\nid: {original}\nfrom: hermes\nto: poller\nkind: discuss\nreply: expected\npath: {bus}/payloads/{original}.md\n---\nhello body\n')
(spool/(original+'.meta.json')).write_text(json.dumps({'id':original,'attempts':0,'attempt_fence':1,'reason':'busy'}))
# Same-id retry: a send still parked for its first delivery coalesces into a
# one-line no-op under the same id. No successor id, no withdrawal, no retry row.
result=check(runtime+' resend',['resend',original,'--by','hermes'],None)
assert result.stdout==f'tap resend: {original} already queued\n',result.stdout
assert not (bus/'receipts'/(original+'.resent')).exists()
assert oldpath.exists() and json.loads((spool/(original+'.meta.json')).read_text()).get('retry') is None
measurements[-1]['metadata']=measurements[-1]['total']-len(original.encode())
assert measurements[-1]['metadata']<=32,measurements[-1]
# Isolated empty seat avoids confusing previous successful messages with emptiness.
reg['seats']['empty']={'status':'active','delivery':'poll'}
(bus/'registry.json').write_text(json.dumps(reg))
check(runtime+' empty poll',['poll','empty'],'tap poll: empty\n')
# A sender team qualifier remains visible on a routine read.
foreign=runtime+'-gold-foreign'
foreignpath=bus/'payloads'/f'{foreign}.md'
foreignpath.write_text(f'---\nid: {foreign}\nfrom: hermes\nfrom_team: beta\nto: sonnet\nkind: discuss\nreply: expected\npath: {foreignpath}\n---\nhello body\n')
check(runtime+' foreign read',['read',foreign,'--by','sonnet'],f'tap read: ask {foreign} from=beta/hermes reply\nhello body\n')
# Public done is a stateless tombstone: it names the replacement and cannot settle the ask.
refusal=subprocess.run([str(root/'bin/tap'),'done',foreign,'--by','sonnet'],env=env,text=True,capture_output=True)
assert refusal.returncode==1 and 'retired' in refusal.stderr and 'tap reply <id>' in refusal.stderr,(runtime,refusal)
assert not (bus/'receipts'/f'{foreign}.done').exists()
items=[]
for n in range(3):
    note=f'{runtime}-gold-note-{n}'
    path=bus/'payloads'/f'{note}.md'
    path.write_text(f'---\nid: {note}\nfrom: hermes\nto: sonnet\nkind: discuss\nreply: settle-only\npath: {path}\n---\nhello body\n')
    items.append({'id':note,'from':'hermes','reply':'settle-only','path':str(path)})
directory=bus/'spool/digests';directory.mkdir(parents=True,exist_ok=True)
digest=runtime+'-gold-digest'
(directory/(digest+'.json')).write_text(json.dumps({'digest_id':digest,'kind':'digest','to':'sonnet','to_team':'testteam','items':items}))
expected=''.join(f"tap read: note {i['id']} from=hermes settled\nhello body\n" for i in items)
check(runtime+' digest all',['read',digest,'--all','--by','sonnet'],expected)
(root/'tmp/output-diet-success').mkdir(parents=True,exist_ok=True)
(root/'tmp/output-diet-success'/'after.json').write_text(json.dumps(measurements,sort_keys=True))
print(json.dumps(measurements,sort_keys=True))
PYGOLD
