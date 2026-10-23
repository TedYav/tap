#!/usr/bin/env bash
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# The shell is test/CLI glue; the store and route decisions are native Bun.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
TAP="$ROOT/bin/tap"
mkdir -p "$WORK/config/tap" "$WORK/bin" "$WORK/index" "$WORK/.tap/bus"
export XDG_CONFIG_HOME="$WORK/config" TAP_INDEX_HOME="$WORK/index" TAP_HOME="$WORK/.tap/bus"
export TAP_BUN_ROUTE_TRACE="$WORK/trace"
cd "$WORK"

# The supported runner supplies sandbox HOME; only this command's store is used.
if "$TAP" calibrate example --json >"$WORK/out" 2>"$WORK/err"; then exit 1; fi
[ ! -s "$WORK/out" ]
[ "$(wc -l < "$WORK/err" | tr -d ' ')" = 1 ]
rg -q 'calibration.enabled.*tap config set calibration.enabled true' "$WORK/err"
[ ! -e "$HOME/.tap/calibration" ]
"$TAP" config set calibration.enabled true >"$WORK/config-receipt"

# Identity observation follows the existing whoami-caller-one-record fixture:
# one fake process-owning tty and a single consistent pane/session/generation.
cat > "$WORK/bin/ps" <<'PS'
#!/usr/bin/env bash
printf '1 ttys001\n'
PS
cat > "$WORK/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
case "$1" in
  list-panes) printf '%%5\t/dev/ttys001\n' ;;
  display-message)
    fmt="${@: -1}"
    fmt="${fmt//'#{pane_id}'/'%5'}"
    fmt="${fmt//'#{pane_tty}'/'/dev/ttys001'}"
    fmt="${fmt//'#{session_name}'/'example/writer'}"
    fmt="${fmt//'#{pid}:#{start_time}'/'4242:99'}"
    printf '%s\n' "$fmt" ;;
esac
TMUX
chmod +x "$WORK/bin/ps" "$WORK/bin/tmux"
export PATH="$WORK/bin:$PATH" TMUX="/fake/socket"
cat > "$WORK/.tap/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"example"},"seats":{"writer":{"harness":"codex","model":"example-model","status":"active","delivery":"pane","session":"example/writer","pane":"%5","pane_id":"%5","server_epoch":"srv:4242:99","harness_session_id":"019c6e27-e55b-73d1-87d8-4e01f1f75043"}}}
JSON
printf '{"schema":"0.20","teams":{"example":{"root":"%s","registry_location":"%s/.tap/team-registry.json","state":"registered"}}}\n' "$WORK" "$WORK" > "$WORK/index/global-registry.json"
printf 'Completed the fake CLI task with explicit stop conditions.\n' > "$WORK/note.md"
"$TAP" calibrate writer -f "$WORK/note.md" --json > "$WORK/written.json"
"$TAP" calibrate codex/example-model --json > "$WORK/rows.json"
python3 -B - "$WORK" "$HOME/.tap/calibration/observations.jsonl" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
row = json.loads((root / 'written.json').read_text())
assert row['by'] == 'example/writer'
assert row['route'] == 'codex/example-model'
assert row['ref'] == '019c6e27-e55b-73d1-87d8-4e01f1f75043'
assert 'effort' not in row
assert set(row) == {'id', 'at', 'route', 'by', 'ref', 'note'}
assert json.loads((root / 'rows.json').read_text()) == [row]
assert pathlib.Path(sys.argv[2]).read_text() == json.dumps(row, separators=(',', ':')) + '\n'
PY
"$TAP" calibrate writer > "$WORK/human"
rg -q 'example/writer, session' "$WORK/human"
if rg -q '019c6e27' "$WORK/human"; then exit 1; fi
printf 'Avoid this fake task\n' > "$WORK/avoid.md"
"$TAP" calibrate writer -f "$WORK/avoid.md" --ref example-ref --effort high > "$WORK/receipt" 2> "$WORK/hints"
rg -q 'name the cause' "$WORK/hints"
"$TAP" calibrate writer --all > "$WORK/all"
rg -q 'high.*Avoid this fake task.*example-ref' "$WORK/all"
printf ' \n' > "$WORK/empty"
if "$TAP" calibrate writer -f "$WORK/empty" --json >"$WORK/out" 2>"$WORK/err"; then exit 1; fi
rg -q '"error_class":"empty_note"' "$WORK/out"
[ ! -s "$WORK/err" ]
rg -q '^native calibrate$' "$WORK/trace"
if rg -q '^bash calibrate$' "$WORK/trace"; then exit 1; fi
echo 'calibrate: default-off refusal and native append/read round trip passed'
