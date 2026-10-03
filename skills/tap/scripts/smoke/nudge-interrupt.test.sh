#!/usr/bin/env bash
# tap-pkh9c: the PUBLIC `tap nudge --interrupt --harness opencode --team <t>`
# form, end to end through the real courier: a selected auto-permission
# OpenCode seat wedged on its spinner frame takes the double-Escape and then
# exactly one submitted note; an unselected control seat takes no keys; an
# interrupt whose key acceptance goes uncertain exits 5 and never replays.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
set -euo pipefail
export TAP_AUTOSETTLE_HOLD_SECONDS=0
export TAP_TUI_SETTLE_SCALE=0.1
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAPSH="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
cleanup() { [ "${KEEP_WORK:-}" = 1 ] || { rm -rf "${WORK:?}"; rm -rf "${FAKE_BIN:?}"; }; }
trap cleanup EXIT

REPO="$WORK/repo"; BUS="$REPO/.tap/bus"; STATE="$WORK/tmux"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$STATE" "$REPO"
INDEX="$WORK/index"; mkdir -p "$INDEX"
printf '{"schema":"0.20","teams":{"alpha":{"root":"%s","registry_location":"%s/.tap/registry.json","state":"registered"}}}\n' "$REPO" "$REPO" > "$INDEX/global-registry.json"
cat > "$REPO/.tap/registry.json" <<JSON
{ "schema": "0.20", "team": { "name": "alpha", "worktree_root": "$REPO" },
  "seats": {
    "lead":   { "pane": "sess:0.0", "pane_id": "%2000", "session": "sess", "server_epoch": "srv:4242:100", "instance": "lead|0", "harness": "codex", "status": "active", "registered_from_worktree": "$REPO" },
    "obi":    { "pane": "sess:0.1", "pane_id": "%2001", "session": "sess", "server_epoch": "srv:4242:100", "instance": "obi|1", "harness": "opencode", "permissions": "auto", "status": "active", "registered_from_worktree": "$REPO" },
    "cctrl":  { "pane": "sess:0.2", "pane_id": "%2002", "session": "sess", "server_epoch": "srv:4242:100", "instance": "cctrl|2", "harness": "claude", "status": "active", "registered_from_worktree": "$REPO" }
  } }
JSON

cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -u
state="${FAKE_TMUX_STATE:?}"
cmd="$1"; shift
pane_of() { case "$*" in *%2000*|*"sess:0.0"*) echo %2000;; *%2001*|*"sess:0.1"*) echo %2001;; *%2002*|*"sess:0.2"*) echo %2002;; *) echo "";; esac; }
cmd_of() { case "$1" in %2000) echo codex;; %2001) echo opencode;; %2002) echo claude;; esac; }
build_staged() {
  { while IFS= read -r line || [ -n "$line" ]; do printf '  ┃ %s\n' "$line"; done < "$state/staged$1.bytes"; printf '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n  16.0K (8%%)  ctrl+p commands · OpenCode 1.17.13\n'; } > "$state/frame.staged"
}
case "$cmd" in
  list-sessions) printf 'sess\t4242:100\n' ;;
  list-panes) printf 'sess\tsess:0.0\t%%2000\tcodex\t4242\t4242:100\t0\nsess\tsess:0.1\t%%2001\topencode\t4242\t4242:100\t0\nsess\tsess:0.2\t%%2002\tclaude\t4242\t4242:100\t0\n' ;;
  display-message)
    p="$(pane_of "$*")"
    fmt="${@: -1}"
    case "$fmt" in
      *start_time*) echo "4242:100" ;;
      *pane_in_mode*) echo "0" ;;
      *pane_id*session_name*pane_pid*pane_current_command*) printf '%s\tsess\t4242\t%s\t0\n' "${p:-%2000}" "$(cmd_of "${p:-%2000}")" ;;
      *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "${p:-%2000}" ;;
      *pane_id*) echo "${p:-%2000}" ;;
      *pane_current_command*) echo "$(cmd_of "${p:-%2000}")" ;;
      *pane_width*) echo "120" ;;
      *) echo "fixture" ;;
    esac ;;
  capture-pane)
    p="$(pane_of "$*")"
    m="$state/mode$p"
    [ -f "$m" ] || printf 'frame.spin\n' > "$m"
    case "$p" in
      %2001) f="$(cat "$m")"; cat "$state/$f" ;;
      *) printf '> \n' ;;
    esac ;;
  send-keys)
    printf '%s\n' "$*" >> "$state/send-keys.log"
    p="$(pane_of "$*")"
    case "${@: -1}" in
      Escape)
        [ "${FAKE_INTERRUPT_FAIL:-}" = "1" ] && exit 1
        printf 'frame.idle\n' > "$state/mode$p" ;;
      Enter|C-u|BSpace) printf 'frame.idle\n' > "$state/mode$p" ;;
      *)
        # Literal-key fallback (non-bracketed injection): the pasted text is
        # the final argv; stage it the same way the paste path does.
        case " $* " in *' -l '*)
          : > "$state/staged$p.bytes"
          printf '%s' "${@: -1}" >> "$state/staged$p.bytes"
          build_staged "$p" ;;
        esac ;;
    esac ;;
  load-buffer)
    # The door shifts the subcommand off, so this is -b NAME PATH.
    printf '%s\n' "$3" > "$state/buf$2" ;;
  paste-buffer)
    # Bracketed paste (opencode): chunks land in the draft; the staged frame
    # is rebuilt from the accumulated bytes so verification reads the wire.
    printf '%s\n' "paste-buffer $*" >> "$state/send-keys.log"
    p="$(pane_of "$*")"
    printf '%s' "$(cat "$(cat "$state/buf$2")")" >> "$state/staged$p.bytes"
    build_staged "$p"
    printf 'frame.staged\n' > "$state/mode$p" ;;
  # No-op like every other fake-tmux stub's delete-buffer arm (see
  # registry-acting-readers.test.sh) — nothing in this file asserts the
  # buffer file's absence, and an `rm` here would sit inside this heredoc
  # (rm-command-shape-inventory.test.sh flags any `rm` word appearing in
  # heredoc text). The scratch dir is reaped by the outer test's own cleanup.
  delete-buffer) exit 0 ;;
  resize-pane) exit 0 ;;
  *) exit 0 ;;
esac
exit 0
TMUX
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" FAKE_TMUX_STATE="$STATE" TAP_HOME="$BUS" TAP_INDEX_HOME="$INDEX"

printf '  ⣟ Working...\n  esc to interrupt · 16.0K (8%%)  ctrl+p commands · OpenCode 1.17.13\n' > "$STATE/frame.spin"
printf '  ┃\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n  16.0K (8%%)  ctrl+p commands · OpenCode 1.17.13\n' > "$STATE/frame.idle"
printf 'frame.spin\n' > "$STATE/mode%2001"

reset_state() {
  : > "$STATE/send-keys.log"
  rm -f "${BUS:?}/registry-events.log" "$STATE/staged%2001.bytes"
  printf 'frame.spin\n' > "$STATE/mode%2001"
}

# ---- (1) --dry-run previews the interruption and the note, no effects ----
if ! OUT="$(cd "$REPO" && bash "$TAPSH" nudge --interrupt --harness opencode --team alpha --reason 'internet drop' --from lead --dry-run 2>&1)"; then
  echo "nudge-interrupt: (1) dry-run failed: $OUT" >&2; exit 1
fi
printf '%s' "$OUT" | grep -q 'alpha/obi  target' || { echo "nudge-interrupt: (1) dry-run must list the selected target" >&2; printf '%s\n' "$OUT" >&2; exit 1; }
printf '%s' "$OUT" | grep -q 'Escape Escape' || { echo "nudge-interrupt: (1) dry-run must name the interruption" >&2; printf '%s\n' "$OUT" >&2; exit 1; }
printf '%s' "$OUT" | grep -qF 'note: Nudge: internet drop. Continue what you were working on.' || { echo "nudge-interrupt: (1) dry-run must show the exact note" >&2; printf '%s\n' "$OUT" >&2; exit 1; }
printf '%s' "$OUT" | grep -q 'cctrl' && { echo "nudge-interrupt: (1) control seat must not be selected" >&2; printf '%s\n' "$OUT" >&2; exit 1; }
[ ! -s "$STATE/send-keys.log" ] || { echo "nudge-interrupt: (1) dry-run took pane keys" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
echo "nudge-interrupt: (1) dry-run previews target, interruption and note without effects: ok"

# ---- (2) the interrupt: double-Escape, then exactly one note; control silent ----
reset_state
RC=0; OUT="$(cd "$REPO" && bash "$TAPSH" nudge --interrupt --harness opencode --team alpha --reason 'internet drop' --from lead 2>&1)" || RC=$?
[ "$RC" = 0 ] || { echo "nudge-interrupt: (2) rc=$RC: $OUT" >&2; exit "$RC"; }
printf '%s' "$OUT" | grep -qF 'alpha/obi  interrupted (delivered)' || { echo "nudge-interrupt: (2) outcome line must say interrupted: $OUT" >&2; exit 1; }
escape_lines="$(grep -c -- '-t %2001 .*Escape' "$STATE/send-keys.log" || true)"
[ "$escape_lines" = "1" ] || { echo "nudge-interrupt: (2) expected ONE interrupt key line, got $escape_lines" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
escapes="$(grep -- '-t %2001 .*Escape' "$STATE/send-keys.log" | head -1 | grep -o 'Escape' | wc -l | tr -d ' ')"
[ "$escapes" = "2" ] || { echo "nudge-interrupt: (2) OpenCode interrupt is a double-Escape, got $escapes tokens" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
paste_line="$(grep -n 'paste-buffer.*-t %2001' "$STATE/send-keys.log" | head -1 | cut -d: -f1)"
escape_line="$(grep -n -- '-t %2001 .*Escape' "$STATE/send-keys.log" | head -1 | cut -d: -f1)"
[ -n "$paste_line" ] && [ "$escape_line" -lt "$paste_line" ] || { echo "nudge-interrupt: (2) the note must paste AFTER the interrupt" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
notes="$(grep -cE -- '^(paste-buffer.*-t %2001)|(-t %2001 .*-l --)' "$STATE/send-keys.log" || true)"
[ "$notes" = "1" ] || { echo "nudge-interrupt: (2) exactly one note must be submitted (paste or literal keys), got $notes" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
grep -q 'agent-interrupt' "$STATE/staged%2001.bytes" || { echo "nudge-interrupt: (2) the submitted sentinel must carry the interrupt class" >&2; cat "$STATE/staged%2001.bytes" >&2; exit 1; }
grep -q -- '-t %2002' "$STATE/send-keys.log" && { echo "nudge-interrupt: (2) the unselected control seat received keys" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
grep -q 'action=urgent_interrupt' "$BUS/registry-events.log" || { echo "nudge-interrupt: (2) registry event missing" >&2; cat "$BUS/registry-events.log" >&2; exit 1; }
grep -q '"recovery":true' "$BUS/registry-events.log" || { echo "nudge-interrupt: (2) registry event must carry recovery:true" >&2; cat "$BUS/registry-events.log" >&2; exit 1; }
ID="$(grep -o 'note [^ ]* urgent agent-interrupt' "$STATE/staged%2001.bytes" | head -1 | cut -d' ' -f2)"
grep -qF 'Nudge: internet drop. Continue what you were working on.' "$BUS/payloads/$ID.md" || { echo "nudge-interrupt: (2) payload must carry the exact reasoned body" >&2; cat "$BUS/payloads/$ID.md" >&2; exit 1; }
echo "nudge-interrupt: (2) selected wedge takes double-Escape then one reasoned note; control untouched: ok"

# ---- (3) uncertain interrupt acceptance: exit 5, no replay, no paste ----
reset_state
RC=0; OUT="$(cd "$REPO" && FAKE_INTERRUPT_FAIL=1 bash "$TAPSH" nudge --interrupt --harness opencode --team alpha --reason 'internet drop' --from lead 2>&1)" || RC=$?
[ "$RC" = 5 ] || { echo "nudge-interrupt: (3) an unverified interrupt must exit 5, got $RC: $OUT" >&2; exit 1; }
printf '%s' "$OUT" | grep -qF 'alpha/obi  interrupted; note UNVERIFIED (possible effect' || { echo "nudge-interrupt: (3) outcome must refuse both lies: $OUT" >&2; exit 1; }
printf '%s' "$OUT" | grep -q 'interrupt input acceptance unconfirmed' || { echo "nudge-interrupt: (3) the interrupt fact must surface on the uncertain outcome: $OUT" >&2; exit 1; }
[ "$(grep -c -- '-t %2001 .*Escape' "$STATE/send-keys.log" || true)" = "1" ] || { echo "nudge-interrupt: (3) the interrupt must not be retried" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
grep -qE -- '^(paste-buffer.*-t %2001)|(-t %2001 .*-l --)' "$STATE/send-keys.log" && { echo "nudge-interrupt: (3) no note may follow an unconfirmed interrupt (paste or literal keys)" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
grep -q -- '-t %2002' "$STATE/send-keys.log" && { echo "nudge-interrupt: (3) control keyed in the failure arm" >&2; cat "$STATE/send-keys.log" >&2; exit 1; }
echo "nudge-interrupt: (3) unconfirmed interrupt exits 5 and never replays or pastes: ok"

echo "nudge-interrupt: all arms ok"
