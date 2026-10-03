# A wedged agent pane for nudge-interrupt-live.test.ts, sourced by a bash binary
# copied under the family's name (so tmux reports the family as the pane's
# command). It paints the family's own mid-turn frame and is genuinely stuck:
# typed and pasted bytes are dropped and Enter does nothing, until the family's
# interrupt key arrives (claude/codex/agy Escape, opencode Escape Escape,
# cursor C-c). Then it paints the family's idle composer, echoes what is typed
# into it, and on Enter appends the composer line to $WEDGE_DIR/submitted and
# clears it. hermes has no key: its working frame accepts input, and a submit
# is the interrupt. WEDGE_KEY=none makes a pane no key can free (the honesty
# row: delivery must then report UNVERIFIED, never "interrupted (delivered)").
# Usage: <family> wedged-harness.sh <family> <dir>
family="$1"; WEDGE_DIR="$2"
key="${WEDGE_KEY:-}"
if [ -z "$key" ]; then
  case "$family" in opencode) key=escape2 ;; cursor) key=ctrl-c ;; hermes) key=none-needed ;; *) key=escape ;; esac
fi
stty raw -echo -isig 2>/dev/null
state=work; text=""; escapes=0
# Rules are built once: a repaint must cost no subshell, or a long paste
# outruns the courier's verify window on a loaded machine.
rule_of() { local out="" i; for ((i = 0; i < $2; i++)); do out+="$1"; done; printf '%s' "$out"; }
RULE_DASH="$(rule_of ─ 80)"; RULE_LOW="$(rule_of ▄ 80)"; RULE_HIGH="$(rule_of ▀ 80)"; RULE_OC="$(rule_of ▀ 60)"
paint() {
  printf '\033[H\033[2J'
  case "$family:$state" in
    claude:work) printf '✽ Crafting… (3m 12s · ↓ 4.9k tokens)\r\n\r\n%s\r\n❯ \r\n%s\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\r\n' "$RULE_DASH" "$RULE_DASH" ;;
    claude:idle) printf '✻ Churned for 3m 23s\r\n\r\n%s\r\n❯ %s\r\n%s\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n' "$RULE_DASH" "$text" "$RULE_DASH" ;;
    codex:work) printf '• Working (53s • esc to interrupt)\r\n\r\n› \033[2mAsk Codex to do anything\033[0m\r\n \r\n  gpt-6-astra high · tap\r\n' ;;
    codex:idle) printf '• Done.\r\n\r\n› %s\r\n \r\n  gpt-6-astra high · tap\r\n' "${text:-$'\033[2mAsk Codex to do anything\033[0m'}" ;;
    agy:work) printf '⣽  Working...\r\n%s\r\n>\r\n%s\r\nesc to cancel\r\n' "$RULE_DASH" "$RULE_DASH" ;;
    agy:idle) printf '%s\r\n> %s\r\n%s\r\n? for shortcuts\r\n' "$RULE_DASH" "$text" "$RULE_DASH" ;;
    cursor:work) printf ' ⠘⠆ Running  34 tokens\r\n %s\r\n  \033[2m→ \033[0;7mA\033[0;2mdd a follow-up\033[0m\r\n %s\r\n  Grok 4.7 256K High\r\n' "$RULE_LOW" "$RULE_HIGH" ;;
    cursor:idle) printf '  Cursor Agent\r\n\r\n %s\r\n  → %s\r\n %s\r\n  Grok 4.7 256K High\r\n' "$RULE_LOW" "${text:-$'\033[2mPlan, search, build anything\033[0m'}" "$RULE_HIGH" ;;
    hermes:work) printf ' ⚕ deepseek-v4-pro │ 55.8K/1M │ 5%%\r\n%s\r\nops-hermes ❯ %s\r\n%s\r\n' "$RULE_DASH" "${text:-$'\033[3;38;5;136mmsg=interrupt · /queue · /bg · /steer · Ctrl+C cancel\033[0m'}" "$RULE_DASH" ;;
    hermes:idle) printf ' ⚕ deepseek-v4-pro │ 50K/1M │ 5%% │ ✓ 0s\r\n%s\r\nops-hermes ❯ %s\r\n%s\r\n' "$RULE_DASH" "$text" "$RULE_DASH" ;;
    opencode:work) printf '  ┃\r\n  ┃  Build · DeepSeek V4 Flash · medium\r\n  ╹%s\r\n   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt\r\n' "$RULE_OC" ;;
    opencode:idle) printf '  ┃ %s\r\n  ┃\r\n  ┃  Build · DeepSeek V4 Flash · medium\r\n  ╹%s\r\n  16.0K (8%%)  ctrl+p commands · OpenCode 1.17.13\r\n' "$text" "$RULE_OC" ;;
  esac
  printf '%s\n' "$state" > "$WEDGE_DIR/state"
}
# bash's `read -n` keeps ISIG on, so C-c arrives as SIGINT rather than a byte:
# the trap feeds it through the same key handler.
key_in() {
  local ch="$1"
  if [ "$state" = work ] && [ "$key" != none-needed ]; then
    case "$key:$ch" in
      escape:$'\e') state=idle ;;
      escape2:$'\e') escapes=$((escapes + 1)); [ "$escapes" -ge 2 ] && state=idle ;;
      ctrl-c:$'\x03') state=idle ;;
    esac
    [ "$state" = idle ] && { printf 'interrupted\n' >> "$WEDGE_DIR/keys"; paint; }
    return
  fi
  case "$ch" in
    $'\r'|$'\n') printf '%s\n' "$text" >> "$WEDGE_DIR/submitted"; text=""; state=idle ;;
    $'\e'|$'\x03') : ;;
    $'\x7f'|$'\b') text="${text%?}" ;;
    $'\x15') text="" ;;
    *) text="$text$ch" ;;
  esac
  # Paint once the pending input is drained, as a TUI batches a paste.
  read -t 0 || paint
}
trap "key_in $'\x03'" INT
paint
while :; do
  IFS= read -rsn1 -d '' ch; rc=$?
  if [ "$rc" -eq 0 ]; then key_in "$ch"; elif [ "$rc" -le 128 ]; then exit 0; fi
done
