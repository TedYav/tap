#!/usr/bin/env bash
# D5: fixture-door — arms drive the public `tap crew add` door (:133 preset×cwd
# matrix, :238 timeout, :272/:276 detective workspace refusal+seam, :293
# preflight faults, :353 unreachable registry, :372 legacy store); the
# detective fixture at :255-266 builds its workspace with production helpers
# (resolveContext/createRun/prepareWorkerWorkspace), whose placement, bootstrap
# copy and evidence run dir are owned by runtime/bun/test/recovery-crew.test.ts:45;
# the direct-exec symlink-alias arm moved to the Bun owner crew-registry.test.ts.
# Refuse source before changing the caller's shell options or environment.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# tap-dduzi: crew recipe persistence uses the enrolled registry, not bus/registry.json.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d "${TMUX_TMPDIR:?run through smoke-all --only}/crew.XXXXXX")"
REAL_TMUX="$(command -v tmux)"
WORK="$(cd "$WORK" && pwd -P)"
SOCKET="$WORK/tmux.sock"
cleanup() { "$REAL_TMUX" -S "$SOCKET" kill-server 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/bin" "$WORK/CrewRegistry/.tap/bus" "$WORK/outside" "$WORK/index" "$WORK/config/tap"
export TAP_INDEX_HOME="$WORK/index" TAP_HOME="$WORK/CrewRegistry/.tap/bus" TAP_SELF=driver
mkdir -p "$TAP_INDEX_HOME" && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json"  # born live (F1)
export XDG_CONFIG_HOME="$WORK/config" REAL_TMUX SOCKET
export CREW_CAPTURE="$WORK/submission" CREW_WINDOWS="$WORK/windows"
# Keep real placement/registration observations; capture submission so no paid harness starts.
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
if [ "${1:-}" = -S ]; then [ "$2" = "$SOCKET" ] || exit 99; shift 2; fi
if [ "${1:-}" = new-window ]; then printf "new-window\n" >> "$CREW_WINDOWS"; fi
if [ "${1:-}" = send-keys ]; then
  printf '%s\n' "$*" >> "$CREW_CAPTURE"
  if [ -f "$CREW_CAPTURE.timeout" ]; then exec sleep 2; fi
  if [ "${CREW_REAL_SUBMIT:-}" = 1 ]; then exec "$REAL_TMUX" -S "$SOCKET" "$@"; fi
  exit 0
fi
exec "$REAL_TMUX" -S "$SOCKET" "$@"
TMUX
chmod +x "$WORK/bin/tmux"
# The crew lifetime contract requires an actual durable parent harness. Keep a
# harmless process with a harness name in the parent pane; child submission is
# still intercepted below, so the fixture never starts a paid agent.
ln -s /bin/sleep "$WORK/bin/codex-parent"
CREW_REAL_BUN="$(command -v bun)"
export CREW_REAL_BUN CREW_HELPER_FDS="$WORK/helper-fds"
cat > "$WORK/bin/bun" <<'BUN'
#!/usr/bin/env bash
case "${1:-}" in
  */launcher/crew-invocation.ts)
    for fd in 0 1 2; do
      if [ -t "$fd" ]; then printf 'tty:%s\n' "$fd" >> "$CREW_HELPER_FDS"; fi
    done
    printf 'prepared\n' >> "$CREW_HELPER_FDS"
    case "${CREW_HELPER_FAULT:-}" in
      structured)
        printf '%s\n' '{"ok":false,"error_class":"session_error","action":"tap help session","detail":"fixture refusal"}'
        exit 23 ;;
      empty) exit 24 ;;
    esac
    ;;
esac
if [ "${TAP_REGISTER_CREW_CAPTURE_ONLY:-}" = 1 ] && [ -n "${CREW_CAPTURE_KILL_PARENT_PID:-}" ]; then
  kill -TERM "$CREW_CAPTURE_KILL_PARENT_PID" 2>/dev/null || true
fi
exec "$CREW_REAL_BUN" "$@"
BUN
chmod +x "$WORK/bin/bun"
# Preparation stays hermetic; only the selected fixture model is available.
export OPENCODE_FIXTURE="$ROOT/runtime/bun/test/support/opencode-cli.ts"
export TAP_TEST_OPENCODE_MODEL="zai-coding-plan/glm-5.3" TAP_TEST_OPENCODE_LOG="$WORK/opencode-sessions"
cat > "$WORK/bin/opencode" <<'OPENCODE'
#!/bin/sh
case "$1" in --version|api) exec "${TAP_SMOKE_BUN:?}" "$OPENCODE_FIXTURE" "$@" ;; esac
exit 99
OPENCODE
chmod +x "$WORK/bin/opencode"
export PATH="$WORK/bin:$PATH"
cat > "$WORK/config/tap/config.toml" <<'TOML'
version = 2
[presets.glm53]
harness = "opencode"
params.model = "zai-coding-plan/glm-5.3"
[presets.claude-test]
harness = "claude"
params.model = "opus"
[presets.codex-test]
harness = "codex"
params.model = "gpt-5.6-sol"
[presets.naked]
harness = "codex"
TOML
chmod 600 "$WORK/config/tap/config.toml"
git -C "$WORK/CrewRegistry" init -q
git -C "$WORK/outside" init -q
"$REAL_TMUX" -S "$SOCKET" new-session -d -s CrewRegistry/driver -c "$WORK/CrewRegistry" "$WORK/bin/codex-parent 600"
export TMUX="$SOCKET,0,0"
TMUX_PANE="$("$REAL_TMUX" -S "$SOCKET" display-message -p -t CrewRegistry/driver '#{pane_id}')"
export TMUX_PANE
PARENT_EPOCH="$("$REAL_TMUX" -S "$SOCKET" display-message -p -t "$TMUX_PANE" '#{pid}:#{start_time}')"
export PARENT_EPOCH
CREW_TTY="$("$REAL_TMUX" -S "$SOCKET" display-message -p -t "$TMUX_PANE" '#{pane_tty}')"
export CREW_TTY
# The test runner is outside tmux; bind only its caller-terminal probe to the fixture pane.
cat > "$WORK/bin/ps" <<'PS'
#!/usr/bin/env bash
case "$*" in
  *'ppid='*'tty='*) printf '1 %s\n' "${CREW_TTY#/dev/}" ;;
  *) exec /bin/ps "$@" ;;
esac
PS
chmod +x "$WORK/bin/ps"
python3 - "$WORK" <<'PY'
import json,pathlib,os,sys
w=pathlib.Path(sys.argv[1]);root=w/'CrewRegistry';reg=root/'.tap/team-registry.json'
reg.write_text(json.dumps({'schema':'0.20','team':{'name':'CrewRegistry','worktree_root':str(root)},'seats':{
 'driver':{'delivery':'pane','harness':'codex','status':'active','instance':'driver|fixture',
           'pane_id':os.environ['TMUX_PANE'],'pane':'CrewRegistry/driver:0.0','session':'CrewRegistry/driver',
           'server_epoch':'srv:'+os.environ['PARENT_EPOCH'],'server_socket':os.environ['SOCKET']}}}))
outside=w/'outside'; (outside/'.tap').mkdir(); outside_reg=outside/'.tap/team-registry.json'
outside_reg.write_text(json.dumps({'schema':'0.20','team':{'name':'Outside','worktree_root':str(outside)},'seats':{}}))
(w/'index/global-registry.json').write_text(json.dumps({'schema':'0.20','teams':{
 'Outside':{'root':str(outside),'registry_location':str(outside_reg),'state':'registered'},
 'CrewRegistry':{'root':str(root),'registry_location':str(reg),'state':'registered'}}}))
PY
cd "$WORK/CrewRegistry"
mkdir -p "$WORK/CrewRegistry/nested" "$WORK/unselectable"
: > "$CREW_WINDOWS"
failures=0
for preset in glm53 claude-test codex-test; do
  for cwd in default outside nested unselectable; do
    if [ "$preset" != codex-test ] && { [ "$cwd" = nested ] || [ "$cwd" = unselectable ]; }; then continue; fi
    handle="$preset-$cwd"
    args=()
    case "$cwd" in
      outside|unselectable) args=(--cwd "$WORK/$cwd") ;;
      nested) args=(--cwd "$WORK/CrewRegistry/nested") ;;
    esac
    before_windows="$(wc -l < "$CREW_WINDOWS" 2>/dev/null || echo 0)"
    cp "$WORK/CrewRegistry/.tap/team-registry.json" "$WORK/registry.before"
    cp "$CREW_CAPTURE" "$WORK/keys.before" 2>/dev/null || : > "$WORK/keys.before"
    rc=0
    bash "$ROOT/scripts/tap.sh" crew add "$preset" "$handle" ${args[@]+"${args[@]}"} >"$WORK/$handle.log" 2>&1 || rc=$?
    printf '%s rc=%s\n' "$handle" "$rc"
    if [ "$cwd" = outside ] || [ "$cwd" = unselectable ]; then
      if [ "$rc" = 0 ] || ! grep -q "use --cwd within the launcher's team" "$WORK/$handle.log"; then
        echo 'cross-team crew cwd was not refused before launch'; cat "$WORK/$handle.log"; exit 1
      fi
      [ "$(wc -l < "$CREW_WINDOWS")" = "$before_windows" ] || { echo 'refusal created a pane'; exit 1; }
      [ "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["seats"]))' "$WORK/outside/.tap/team-registry.json")" = 0 ]
      cmp "$WORK/registry.before" "$WORK/CrewRegistry/.tap/team-registry.json"
      cmp "$WORK/keys.before" "$CREW_CAPTURE"
      continue
    fi
    if [ "$rc" != 0 ]; then cat "$WORK/$handle.log"; failures=$((failures+1)); continue; fi
    python3 - "$WORK" "$handle" "$preset" "$cwd" <<'PY'
import json,pathlib,subprocess,os,sys
w=pathlib.Path(sys.argv[1]);handle,preset,cwd=sys.argv[2:]
reg=json.loads((w/'CrewRegistry/.tap/team-registry.json').read_text());row=reg['seats'][handle]
assert row['crew'] is True,row
assert row['crew_owner']=='driver' and row['crew_owner_instance']=='driver|fixture',row
assert row['crew_identity_capture']['decision']=='unavailable',row
assert row['crew_identity_capture']['reason'],row
assert not row.get('harness_session_id'),row
harness={'glm53':'opencode','claude-test':'claude','codex-test':'codex'}[preset]
assert row['harness']==harness,row
assert row['preset']['name']==preset,row
assert row['model'],row
pane=row['pane_id']
observed=subprocess.check_output([os.environ['REAL_TMUX'],'-S',os.environ['SOCKET'],'display-message','-p','-t',pane,'#{session_name}\t#{pane_current_path}'],text=True).strip()
expected=w/'CrewRegistry'; expected=expected/'nested' if cwd=='nested' else expected
assert observed==f'CrewRegistry/driver\t{expected}',observed
assert harness in (w/'submission').read_text()
assert not (w/'CrewRegistry/.tap/bus/registry.json').exists()
PY
  done
done
[ "$failures" = 0 ]

# ── tap-eeibj: the cross-team refusal honours TAP_JSON ───────────────────────
# Same refusal as the outside-cwd arm above, asked for as JSON: the structured
# error is on stdout, stderr carries no prose, and nothing launched. The human
# render leads with detail and next:, not the class token, so the class is
# asserted on the JSON door and the guidance on the human one.
before_windows="$(wc -l < "$CREW_WINDOWS")"
cp "$WORK/CrewRegistry/.tap/team-registry.json" "$WORK/json-registry.before"
cp "$CREW_CAPTURE" "$WORK/json-keys.before"
rc=0
TAP_JSON=1 bash "$ROOT/scripts/tap.sh" crew add codex-test json-outside --cwd "$WORK/outside" >"$WORK/json-outside.out" 2>"$WORK/json-outside.err" || rc=$?
[ "$rc" = 1 ] || { echo "json outside cwd: want rc 1, got $rc"; cat "$WORK/json-outside.out" "$WORK/json-outside.err"; exit 1; }
python3 - "$WORK/json-outside.out" <<'PY' || { echo 'json outside cwd: stdout is not the structured crew_registry_mismatch refusal'; cat "$WORK/json-outside.out" "$WORK/json-outside.err"; exit 1; }
import json,sys
data=json.loads(open(sys.argv[1]).read())
assert data["ok"] is False and data["error_class"]=="crew_registry_mismatch", data
assert "launcher's team" in data["action"], data
assert "launcher uses" in data["detail"], data
PY
[ ! -s "$WORK/json-outside.err" ] || { echo 'json outside cwd: stderr carries prose'; cat "$WORK/json-outside.err"; exit 1; }
[ "$(wc -l < "$CREW_WINDOWS")" = "$before_windows" ] || { echo 'json refusal created a pane'; exit 1; }
cmp "$WORK/json-registry.before" "$WORK/CrewRegistry/.tap/team-registry.json"
cmp "$WORK/json-keys.before" "$CREW_CAPTURE"

# ── U4 (tap-4b9e): crew add names the selected launch model, or refuses ──────
# The receipt and the registry row must carry the model selected for the
# launch; adhoc adds without --model and model-less presets are
# launch_arg_invalid before any window, key capture, or registry row exists.
u4_refuse() { # label [ENV=KV] args...
  local label="$1"; shift
  local env_kv=""
  case "$1" in *=*) env_kv="$1"; shift ;; esac
  before_windows="$(wc -l < "$CREW_WINDOWS" 2>/dev/null || echo 0)"
  cp "$WORK/CrewRegistry/.tap/team-registry.json" "$WORK/u4-registry.before"
  cp "$CREW_CAPTURE" "$WORK/u4-keys.before" 2>/dev/null || : > "$WORK/u4-keys.before"
  rc=0
  if [ -n "$env_kv" ]; then
    env "$env_kv" bash "$ROOT/scripts/tap.sh" "$@" >"$WORK/$label.log" 2>&1 || rc=$?
  else
    bash "$ROOT/scripts/tap.sh" "$@" >"$WORK/$label.log" 2>&1 || rc=$?
  fi
  if [ "$rc" = 0 ]; then echo "u4: $label launched without a validated model"; cat "$WORK/$label.log"; exit 1; fi
  if [ "$env_kv" = "TAP_JSON=1" ]; then
    grep -q 'launch_arg_invalid' "$WORK/$label.log" || { echo "u4: $label JSON refused with the wrong class"; cat "$WORK/$label.log"; exit 1; }
  else
    # The human render leads with detail and next:, not the class token.
    grep -q 'use a preset with params.model' "$WORK/$label.log" || { echo "u4: $label refusal lacks the model action"; cat "$WORK/$label.log"; exit 1; }
  fi
  grep -q 'explicit validated launch model' "$WORK/$label.log" || { echo "u4: $label detail does not name the model requirement"; cat "$WORK/$label.log"; exit 1; }
  [ "$(wc -l < "$CREW_WINDOWS")" = "$before_windows" ] || { echo "u4: $label created a pane"; exit 1; }
  cmp "$WORK/u4-registry.before" "$WORK/CrewRegistry/.tap/team-registry.json"
  cmp "$WORK/u4-keys.before" "$CREW_CAPTURE"
}
u4_refuse u4-adhoc TAP_JSON=1 crew add codex no-model
u4_refuse u4-preset crew add naked no-model-preset
# The receipt and the registry row are claims; the captured child launch
# command is what the seat will actually run. Snapshot the capture, run the
# add, then isolate the new exec line (the `send-keys -l -- exec env ...`
# invocation, never the trailing Enter). Codex carries the exact model token;
# OpenCode 2 carries the session whose native model was prepared before launch.
u4_launch() { # label model-token args...
  local label="$1" model_token="$2"; shift 2
  local before_lines exec_line
  before_lines="$(wc -l < "$CREW_CAPTURE" 2>/dev/null || echo 0)"
  rc=0
  bash "$ROOT/scripts/tap.sh" "$@" >"$WORK/$label.log" 2>&1 || rc=$?
  [ "$rc" = 0 ] || { echo "u4: $label add failed"; cat "$WORK/$label.log"; exit 1; }
  [ "$(wc -l < "$CREW_CAPTURE")" -eq "$((before_lines + 2))" ] || { echo 'crew launch must send one literal line and one Enter'; exit 1; }
  exec_line="$(tail -n +"$((before_lines + 1))" "$CREW_CAPTURE" | grep 'exec env' || true)"
  [ "$(printf '%s\n' "$exec_line" | grep -c 'exec env')" = 1 ] || { echo "u4: $label did not produce exactly one captured launch line"; tail -n +"$((before_lines + 1))" "$CREW_CAPTURE"; exit 1; }
  if [ "$label" = u4-preset ]; then
    python3 - "$exec_line" "$TAP_TEST_OPENCODE_LOG" "$model_token" <<'PY_MODEL'
import json, pathlib, shlex, sys
argv = shlex.split(sys.argv[1])
sessions = [json.loads(line) for line in pathlib.Path(sys.argv[2]).read_text().splitlines()]
assert "opencode" in argv and "--standalone" in argv and "--model" not in argv, argv
native_id = argv[argv.index("--session") + 1]
prepared = next(row for row in sessions if row["id"] == native_id)
assert prepared["model"] == dict(zip(("providerID", "id"), sys.argv[3].split("/", 1))), prepared
PY_MODEL
    return
  fi
  case "$exec_line" in
    "--model $model_token" | "--model $model_token "* | *" --model $model_token" | *" --model $model_token "*) ;;
    *) echo "u4: $label child argv does not carry --model $model_token"; printf '%s\n' "$exec_line"; exit 1 ;;
  esac
}
u4_launch u4-explicit gpt-5.6-sol crew add codex explicit-om --model gpt-5.6-sol
grep -q 'started CrewRegistry/explicit-om (codex, model=gpt-5.6-sol) in ' "$WORK/u4-explicit.log" || { echo 'u4: explicit-model receipt does not name the model'; cat "$WORK/u4-explicit.log"; exit 1; }
u4_launch u4-preset zai-coding-plan/glm-5.3 crew add glm53 receipt-model
grep -q 'started CrewRegistry/receipt-model (opencode, model=zai-coding-plan/glm-5.3) in ' "$WORK/u4-preset.log" || { echo 'u4: preset receipt does not name the preset-resolved model'; cat "$WORK/u4-preset.log"; exit 1; }
python3 - "$WORK" <<'PY'
import json,pathlib,sys
w=pathlib.Path(sys.argv[1])
reg=json.loads((w/'CrewRegistry/.tap/team-registry.json').read_text())
assert reg['seats']['explicit-om']['model']=='gpt-5.6-sol',reg['seats']['explicit-om']
assert reg['seats']['receipt-model']['model']=='zai-coding-plan/glm-5.3',reg['seats']['receipt-model']
assert f" in {reg['seats']['explicit-om']['pane']}\n" in (w/'u4-explicit.log').read_text()
PY
echo 'u4 — receipt/row model honesty and model-less refusal: ok'

# A timed-out literal send is a possible effect: retain the row/window and
# stop before Enter or rollback. Exercise the shared adapter's explicit pin.
before_lines="$(wc -l < "$CREW_CAPTURE")"
: > "$CREW_CAPTURE.timeout"
rc=0
TAP_JSON=1 TAP_TMUX_SOCKET_PATH="$SOCKET" TAP_TMUX_TIMEOUT_SECONDS=1 \
  bash "$ROOT/scripts/tap.sh" crew add codex-test timeout-seat >"$WORK/timeout.out" 2>"$WORK/timeout.err" || rc=$?
mv "$CREW_CAPTURE.timeout" "$CREW_CAPTURE.timeout-finished"
[ "$rc" = 1 ] || { echo 'crew timeout did not refuse'; cat "$WORK/timeout.out"; exit 1; }
[ "$(wc -l < "$CREW_CAPTURE")" -eq "$((before_lines + 1))" ] || { echo 'crew timeout sent another key'; exit 1; }
python3 - "$WORK" <<'PY'
import json,os,pathlib,subprocess,sys
w=pathlib.Path(sys.argv[1]); refusal=json.loads((w/'timeout.out').read_text())
assert refusal['error_class']=='server_unresponsive',refusal
row=json.loads((w/'CrewRegistry/.tap/team-registry.json').read_text())['seats']['timeout-seat']
assert "tmux kill-window -t '"+row['pane_id']+"'" in refusal['action'],refusal
assert 'do not retry a possible effect' in refusal['action'],refusal
assert (w/'timeout.err').read_text()=='', (w/'timeout.err').read_text()
alive=subprocess.check_output([os.environ['REAL_TMUX'],'-S',os.environ['SOCKET'],'display-message','-p','-t',row['pane_id'],'#{pane_id}'],text=True).strip()
assert alive==row['pane_id'],(alive,row)
PY
# Detective uses its production workspace helper: scratch stays enrolled while
# recovery evidence remains in the debug root. Submission is captured above, not paid.
cat > "$WORK/detective-workspace.ts" <<'TS'
const repo = process.argv[2];
const {resolveContext} = await import(repo + "/runtime/bun/src/context.ts");
const {createRun, runDirectory} = await import(repo + "/runtime/bun/src/recovery/state.ts");
const {prepareWorkerWorkspace} = await import(repo + "/runtime/bun/src/recovery/crew.ts");
const ctx = resolveContext();
const run = createRun({team:ctx.team, handle:"driver", registry:ctx.registryPath,
  pane:process.env.TMUX_PANE, paneId:process.env.TMUX_PANE, session:"CrewRegistry/driver",
  instance:"driver|fixture", harness:"daemon"}, "report-only", [], "", process.pid);
console.log(JSON.stringify({cwd:prepareWorkerWorkspace(ctx,run), evidence:runDirectory(run.id)}));
TS
"${TAP_SMOKE_BUN:-bun}" "$WORK/detective-workspace.ts" "$ROOT" > "$WORK/detective-workspace.json"
worker_cwd="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["cwd"])' "$WORK/detective-workspace.json")"
evidence_cwd="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["evidence"])' "$WORK/detective-workspace.json")"
before_windows="$(wc -l < "$CREW_WINDOWS")"
cp "$CREW_CAPTURE" "$WORK/detective-keys.before"
rc=0
bash "$ROOT/scripts/tap.sh" crew add codex-test detective-wrong --cwd "$evidence_cwd" > "$WORK/detective-wrong.log" 2>&1 || rc="$?"
[ "$rc" != 0 ] && grep -q "use --cwd within the launcher's team" "$WORK/detective-wrong.log" || { echo 'detective evidence cwd admitted'; exit 1; }
[ "$(wc -l < "$CREW_WINDOWS")" = "$before_windows" ] || { echo 'detective refusal created a pane'; exit 1; }
cmp "$WORK/detective-keys.before" "$CREW_CAPTURE"
bash "$ROOT/scripts/tap.sh" crew add codex-test detective-seam --cwd "$worker_cwd" > "$WORK/detective-seam.log" 2>&1 || { cat "$WORK/detective-seam.log"; exit 1; }
[ -f "$evidence_cwd/run.json" ] && [ -f "$evidence_cwd/worker-bootstrap.md" ]
cmp "$evidence_cwd/worker-bootstrap.md" "$worker_cwd/AGENTS.md"
python3 - "$WORK" "$worker_cwd" "$evidence_cwd" <<'PY_CHECK'
import json,pathlib,sys,subprocess,os
w,cwd,evidence=map(pathlib.Path,sys.argv[1:])
assert cwd.is_relative_to(w/'CrewRegistry'),cwd
assert evidence.is_relative_to(w/'index/debug/recovery'),evidence
row=json.loads((w/'CrewRegistry/.tap/team-registry.json').read_text())['seats']['detective-seam']
actual=subprocess.check_output([os.environ['REAL_TMUX'],'-S',os.environ['SOCKET'],'display-message','-p','-t',row['pane_id'],'#{pane_current_path}'],text=True).strip()
assert actual==str(cwd),(actual,cwd)
PY_CHECK
# Generic preflight failures still reach final preparation and its rollback.
for fault in structured empty; do
  calls_before="$(wc -l < "$CREW_HELPER_FDS")"
  windows_before="$(wc -l < "$CREW_WINDOWS")"
  rc=0
  CREW_HELPER_FAULT="$fault" bash "$ROOT/scripts/tap.sh" crew add codex-test "fault-$fault" >"$WORK/fault-$fault.out" 2>"$WORK/fault-$fault.err" || rc=$?
  expected=23; [ "$fault" = empty ] && expected=24
  [ "$rc" = "$expected" ] || { cat "$WORK/fault-$fault.err"; echo 'preparation exit changed'; exit 1; }
  [ "$(wc -l < "$CREW_HELPER_FDS")" -eq "$((calls_before+2))" ] || { echo 'generic preflight fault did not reach final preparation'; exit 1; }
  [ "$(wc -l < "$CREW_WINDOWS")" -eq "$((windows_before+1))" ] || { echo 'generic fault did not exercise rollback'; exit 1; }
  python3 - "$WORK" "$fault" <<'PY_FAULT'
import json,pathlib,subprocess,os,sys
w=pathlib.Path(sys.argv[1]);handle='fault-'+sys.argv[2]
assert handle not in json.loads((w/'CrewRegistry/.tap/team-registry.json').read_text())['seats']
names=subprocess.check_output([os.environ['REAL_TMUX'],'-S',os.environ['SOCKET'],'list-windows','-t','CrewRegistry/driver','-F','#{window_name}'],text=True).splitlines()
assert handle not in names,names
PY_FAULT
done
grep -q 'fixture refusal' "$WORK/fault-structured.err"
grep -q 'launch preparation failed (exit 24)' "$WORK/fault-empty.err"

# Submit a real line through a fixture harness in a private tmux pane. Both
# Bun preparation children remain detached from that terminal.
cat > "$WORK/bin/sh" <<'LOGIN_SHELL'
#!/bin/sh
# A POSIX login-shell fixture whose startup preserves the isolated PATH.
PATH="${0%/*}:$PATH"; export PATH
if [ "${1:-}" = -lic ]; then shift; exec /bin/sh -c "$@"; fi
exec /bin/sh "$@"
LOGIN_SHELL
cat > "$WORK/bin/codex" <<'HARNESS'
#!/bin/bash
# PENDIN is consumed by the first read, even without TAP. Start a stable mode.
stty -echo -icanon -pendin min 1 time 0
stty -g > "$CREW_ACCEPTANCE.mode-before"
printf 'ready\n' > "$CREW_ACCEPTANCE.ready"
IFS= read -r -t 10 line
printf '%s\n' "$line" > "$CREW_ACCEPTANCE.submitted"
stty -g > "$CREW_ACCEPTANCE.mode-after"
HARNESS
chmod +x "$WORK/bin/sh" "$WORK/bin/codex"
runtime=bun
receipt="$WORK/terminal-$runtime"
terminal_rc=0
TAP_LAUNCH_SHELL="$WORK/bin/sh" CREW_REAL_SUBMIT=1 CREW_ACCEPTANCE=ambient \
  bash "$ROOT/scripts/tap.sh" crew add codex "terminal-$runtime" --model gpt-5.6-sol \
    --env "CREW_ACCEPTANCE=$receipt" > "$receipt.caller" 2>&1 || terminal_rc=$?
for i in {1..100}; do [ -f "$receipt.ready" ] && break; sleep 0.1; done
[ -f "$receipt.ready" ] && [ "$terminal_rc" = 0 ] || { cat "$receipt.caller"; echo 'fixture harness did not start'; exit 1; }
grep -q 'overriding ambient ENV' "$receipt.caller" || { echo 'final preparation stderr was not relayed'; cat "$receipt.caller"; exit 1; }
crew_pane="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["seats"][sys.argv[2]]["pane_id"])' "$WORK/CrewRegistry/.tap/team-registry.json" "terminal-$runtime")"
"$REAL_TMUX" -S "$SOCKET" send-keys -t "$crew_pane" -l -- accepted-by-crew
"$REAL_TMUX" -S "$SOCKET" send-keys -t "$crew_pane" Enter
for i in {1..100}; do [ -f "$receipt.mode-after" ] && break; sleep 0.1; done
[ "$(cat "$receipt.submitted")" = accepted-by-crew ] || { echo 'Enter did not submit to fixture harness'; exit 1; }
cmp "$receipt.mode-before" "$receipt.mode-after" || { cat "$receipt.mode-before" "$receipt.mode-after" "$CREW_HELPER_FDS"; exit 1; }
if grep -q 'tty:' "$CREW_HELPER_FDS"; then echo 'Bun preparation inherited the caller tty'; cat "$CREW_HELPER_FDS"; exit 1; fi
echo 'crew native door: isolated terminal submission and non-TTY preparation verified'

# A missing enrolled store must not fall back to a bus decoy or create a window.
cp "$WORK/CrewRegistry/.tap/team-registry.json" "$TAP_HOME/registry.json"
mv "$WORK/CrewRegistry/.tap/team-registry.json" "$WORK/saved-registry.json"
before="$("$REAL_TMUX" -S "$SOCKET" list-windows -t CrewRegistry/driver -F '#{window_id}')"
cp "$CREW_WINDOWS" "$WORK/windows.before"
rc=0
bash "$ROOT/scripts/tap.sh" crew add glm53 unreachable >"$WORK/unreachable.log" 2>&1 || rc=$?
[ "$rc" != 0 ] || { echo 'unreachable registry accepted'; exit 1; }
cmp "$WORK/windows.before" "$CREW_WINDOWS"
[ "$before" = "$("$REAL_TMUX" -S "$SOCKET" list-windows -t CrewRegistry/driver -F '#{window_id}')" ]
cmp "$WORK/saved-registry.json" "$TAP_HOME/registry.json"
[ ! -e "$WORK/CrewRegistry/.tap/team-registry.json" ]
# An agents-only store refuses crew add by name. Born live, there is no
# pre-flip machine to route to the bus registry: the enrolled store itself
# carries the old shape.
mv "$WORK/saved-registry.json" "$WORK/CrewRegistry/.tap/team-registry.json"
python3 - "$WORK/CrewRegistry/.tap/team-registry.json" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);r=json.loads(p.read_text())
# old-shape fixture: turns the store into the agents axis; asserts crew add refuses it
r['agents']=r.pop('seats');r.pop('schema',None);p.write_text(json.dumps(r))
PY
# Checkpoint C's seats-only boundary (register-authority.ts legacyAgentsAxisStore)
# refuses ANY write against an agents-only store, crew add included.
legacy_rc=0
bash "$ROOT/scripts/tap.sh" crew add codex-test legacy-default >"$WORK/legacy.log" 2>&1 || legacy_rc=$?
[ "$legacy_rc" != 0 ] || { echo 'crew add must refuse an agents-only store'; cat "$WORK/legacy.log"; exit 1; }
grep -q 'is an old TAP registry format' "$WORK/legacy.log" || { echo 'crew add on legacy store did not name the old-store refusal'; cat "$WORK/legacy.log"; exit 1; }

# Restore the current fixture store, then end the parent during post-add capture.
# The helper owns child cleanup; the caller must not emit a success receipt.
python3 - "$WORK/CrewRegistry/.tap/team-registry.json" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);r=json.loads(p.read_text());r['seats']=r.pop('agents');r['schema']='0.20';p.write_text(json.dumps(r))
PY
capture_parent_pid="$("$REAL_TMUX" -S "$SOCKET" display-message -p -t "$TMUX_PANE" '#{pane_pid}')"
capture_exit=0
CREW_CAPTURE_KILL_PARENT_PID="$capture_parent_pid" \
  bash "$ROOT/scripts/tap.sh" crew add codex-test parent-exits-during-capture > "$WORK/parent-exits-capture.log" 2>&1 || capture_exit=$?
[ "$capture_exit" != 0 ] || { echo 'crew add succeeded after its parent exited during capture'; cat "$WORK/parent-exits-capture.log"; exit 1; }
grep -q 'during native identity capture' "$WORK/parent-exits-capture.log" || { cat "$WORK/parent-exits-capture.log"; exit 1; }
if grep -q 'tap crew add: started' "$WORK/parent-exits-capture.log"; then cat "$WORK/parent-exits-capture.log"; exit 1; fi
echo 'crew native door: parent exit during capture refuses success'
