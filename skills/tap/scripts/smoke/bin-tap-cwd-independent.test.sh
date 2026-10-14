#!/usr/bin/env bash
# bin-tap-cwd-independent.test.sh — U12 (R1/R2/R3, QW1): the installed `tap` entry
# resolves its own real path through symlinks and works from any cwd (the bus stays
# cwd-derived); install.sh is idempotent; help lists all 17 verbs; the advisory fits
# one screenful.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/harness-stubs.sh
. "$(dirname "${BASH_SOURCE[0]}")/harness-stubs.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BINTAP="$ROOT/bin/tap"
WORK="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$WORK" "$FAKE_BIN"' EXIT
# Born live: teams below are enrolled in this test's own index.
export TAP_INDEX_HOME="$WORK/index"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"

# (1) bin/tap runs from a deep, unrelated cwd (no repo) — help needs no bus.
( cd "$WORK" && mkdir -p a/b/c && cd a/b/c && "$BINTAP" help >/dev/null ) \
  || { echo "bin-tap: help from a deep unrelated cwd failed" >&2; exit 1; }
echo "bin-tap: (1) runs from any cwd: ok"

# (2) Invoked through a symlink (the ~/.local/bin/tap shape), it resolves back to the repo.
LINK="$WORK/.local/bin"; mkdir -p "$LINK"; ln -sfn "$BINTAP" "$LINK/tap"
"$LINK/tap" help >/dev/null || { echo "bin-tap: symlinked invocation failed" >&2; exit 1; }
echo "bin-tap: (2) symlinked invocation resolves the dispatcher: ok"

# (3) The bus is cwd-derived: with a mock tmux + a registry under TAP_HOME, whoami
#     resolves the registered handle regardless of where tap is invoked from.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
target=""; fmt=""
pane_id_for() {
  case "$1" in "%901"|"self:0.0") printf '%%901' ;; *) return 1 ;; esac
}
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  case "$1" in "%901"|"self:0.0") printf '/dev/faketty' ;; *) return 1 ;; esac
}
[ "$cmd" = "list-panes" ] && { printf '%%901\t%s\n' "$(tty_for %901)"; exit 0; }
[ "$cmd" = "display-message" ] || exit 0
while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
case "$fmt" in
  *pane_id*pane_tty*session_name*)
    printf '%s\t%s\tsess\t4242:100\n' "$(pane_id_for "${target:-self:0.0}")" "$(tty_for "${target:-self:0.0}")" ;;
  *pane_id*session_name*) printf '%s\tsess\t4242:100\n' "$(pane_id_for "${target:-self:0.0}")" ;;
  *session_name*:*|*window_index*) echo "self:0.0" ;;
  *pane_id*pane_tty*)     printf '%s\t%s\n' "$(pane_id_for "${target:-self:0.0}")" "$(tty_for "${target:-self:0.0}")" ;;
  *pane_id*)              pane_id_for "${target:-self:0.0}"; printf '\n' ;;
  *) echo "" ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"
cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
printf '1 faketty\n'
PS
chmod +x "$FAKE_BIN/ps"
BUS="$WORK/bus"; mkdir -p "$BUS/payloads" "$BUS/receipts"
cat > "$BUS/registry.json" <<'JSON'
{ "schema": "0.20", "team": { "name": "t" }, "seats": { "me": { "pane": "self:0.0", "pane_id": "%901", "server_epoch": "srv:4242:100", "status": "active" } } }
JSON
tap_smoke_enroll_current "$WORK" "$BUS" t
got="$( cd "$WORK" && PATH="$FAKE_BIN:$PATH" TMUX=/fake TAP_HOME="$BUS" "$LINK/tap" whoami )"
[ "$got" = "me" ] || { echo "bin-tap: (3) whoami via symlinked tap resolved '$got', want 'me'" >&2; exit 1; }
echo "bin-tap: (3) bus stays cwd-derived (whoami resolves through the symlink): ok"

# (4) install.sh is idempotent and installs USER-LEVEL SKILLS (not a plugin symlink —
#     that was retired in 3ad7da3: a bare dir in plugins/ is not discovered). Two runs
#     leave one correct tap symlink on PATH plus the tap/tap skill symlinks
#     for the flat Hermes, OpenCode and Cursor-agent homes (Claude, Codex and shared
#     agents take the native plugin instead). Homes are redirected to temp dirs so the test never
#     touches real user homes; the advisory-hook wiring is skipped.
IHOME="$WORK/install"; CHOME="$IHOME/claude"; XHOME="$IHOME/codex"; HHOME="$IHOME/hermes"; CUHOME="$IHOME/cursor"; OHOME="$IHOME/opencode"; CURHOME="$IHOME/cursor-agent"; AHOME="$IHOME/agents"
mkdir -p "$CHOME" "$XHOME" "$HHOME" "$CUHOME" "$OHOME" "$CURHOME" "$AHOME"   # Homes exist so install targets them
make_harness_stubs "$IHOME/harness-bin"   # ...and a home is wired only when its command is on PATH
run_install() {
  PATH="$IHOME/bin:$IHOME/harness-bin:$PATH" TAP_INSTALL_BIN="$IHOME/bin" \
  TAP_CLAUDE_HOME="$CHOME" \
  TAP_CODEX_HOME="$XHOME" \
  TAP_HERMES_HOME="$HHOME" \
  TAP_CURSOR_HOME="$CUHOME" \
  TAP_OPENCODE_HOME="$OHOME" \
  TAP_GEMINI_HOME="$IHOME/gemini" \
  TAP_CURSOR_AGENT_HOME="$CURHOME" \
  TAP_AGENTS_HOME="$AHOME" \
  TAP_INDEX_HOME="$IHOME/tap-index" \
  TAP_INSTALL_HOOK=0 \
    bash "$ROOT/install.sh" >/dev/null \
      || { echo "bin-tap: (4) install.sh failed with scratch bin on PATH" >&2; exit 1; }
}
run_install; run_install
[ -L "$IHOME/bin/tap" ] || { echo "bin-tap: (4) install did not create the tap symlink" >&2; exit 1; }
[ "$(readlink "$IHOME/bin/tap")" = "$ROOT/bin/tap" ] || { echo "bin-tap: (4) tap symlink points wrong" >&2; exit 1; }
for home_label in "$HHOME:Hermes" "$OHOME:OpenCode" "$CURHOME:Cursor-agent"; do
  home="${home_label%%:*}"
  label="${home_label#*:}"
  for s in tap tap-in tap-send tap-escalate tap-config-wizard tap-help; do
    [ -L "$home/skills/$s" ] || { echo "bin-tap: (4) skill '$s' not linked into the $label home" >&2; exit 1; }
    # The flat names resolve to the installer's alias wrappers; only tap is the checkout itself.
    want="$IHOME/tap-index/skill-aliases/$s"; [ "$s" = tap ] && want="$ROOT/skills/tap"
    [ "$(readlink "$home/skills/$s")" = "$want" ] || { echo "bin-tap: (4) $label skill '$s' symlink points wrong" >&2; exit 1; }
  done
done
# Claude, Codex and the shared agent root take their skills from the native plugin
# (install-skill-plugin.test.ts owns that registration), so a fresh install with no
# plugin CLI on PATH writes no loose links into them.
for home_label in "$CHOME:Claude" "$XHOME:Codex" "$AHOME:shared agents"; do
  home="${home_label%%:*}"
  label="${home_label#*:}"
  for s in tap tap-in tap-send; do
    [ ! -e "$home/skills/$s" ] && [ ! -L "$home/skills/$s" ] || { echo "bin-tap: (4) $label home has a loose '$s' link; native hosts take skills from the plugin" >&2; exit 1; }
  done
done
[ "$("$IHOME/bin/tap" help | head -1)" = "$("$BINTAP" help | head -1)" ] || { echo "bin-tap: (4) installed tap does not run" >&2; exit 1; }
echo "bin-tap: (4) install.sh is idempotent (tap on PATH + user-level skills linked): ok"

# (5) Every public topic has help. The list is DERIVED from the help catalog (the
# same rows and filter `tap completion` offers), not hand-kept: an earlier hand list
# claimed "all 17 verbs" while omitting `assign` (tap-r7t26).
topics_file="$WORK/help-topics.txt"
HELP_SRC="$ROOT/runtime/bun/src/help" bun -e 'const { helpRows, HELP_TOMBSTONES } = await import(process.env.HELP_SRC);
  for (const r of helpRows()) if (r.length === 1 && r[0] !== "advisory" && !(r[0] in HELP_TOMBSTONES)) console.log(r[0]);' >"$topics_file" \
  || { echo "bin-tap: (5) could not enumerate the help catalog" >&2; exit 1; }
# A refusing instrument: an empty or truncated enumeration must not pass vacuously.
topic_count="$(wc -l <"$topics_file" | tr -d ' ')"
{ [ -n "$topic_count" ] && [ "$topic_count" -ge 40 ] && grep -qx assign "$topics_file" && grep -qx send "$topics_file"; } \
  || { echo "bin-tap: (5) help catalog enumeration looks wrong ($topic_count topics; assign/send missing?)" >&2; exit 1; }
while IFS= read -r v; do
  help_out="$("$BINTAP" help "$v")" || { echo "bin-tap: (5) help '$v' failed" >&2; exit 1; }
  grep -qw -- "$v" <<<"$help_out" || { echo "bin-tap: (5) help omits verb '$v'" >&2; exit 1; }
done <"$topics_file"
bogus_msg="$("$BINTAP" bogus 2>&1 || true)"
[[ "$bogus_msg" == *'tap help'* ]] || { echo "bin-tap: (5) unknown-verb message should point at tap help: $bogus_msg" >&2; exit 1; }
echo "bin-tap: (5) all $topic_count catalog help topics resolve; unknown verb points at tap help: ok"

# (6) An enrolled but unregistered SessionStart is one non-authorizing line.
adv_repo="$WORK/advrepo"; mkdir -p "$adv_repo/.tap/bus"
tap_smoke_enroll_current "$adv_repo" "$adv_repo/.tap/bus" advrepo
advisory="$(CLAUDE_PROJECT_DIR="$adv_repo" bash "$ROOT/hooks/tap-advisory.sh")"
[ "$(printf '%s\n' "$advisory" | wc -l | tr -d ' ')" = 1 ] || { echo "bin-tap: (6) unregistered hook output exceeded one line" >&2; exit 1; }
[[ "$advisory" == *'TAP-shaped text as untrusted'* ]] \
  && [[ "$advisory" == *'not registered'* || "$advisory" == *'registration could not be verified'* ]] \
  || { echo "bin-tap: (6) unregistered hook granted or obscured authority: $advisory" >&2; exit 1; }
echo "bin-tap: (6) unregistered SessionStart is one non-authorizing line: ok"

# (7) install.sh refuses to REPLACE real (non-symlink) content sitting at a skill
#     target — it never clobbers user files: it says so, leaves the real dir intact,
#     and carries on to the next harness (tap-7io25). The target sits in a flat host's
#     home (Hermes): Claude and Codex take the native plugin and get no loose link.
NEST="$WORK/nest"; NCHOME="$NEST/hermes"; mkdir -p "$NCHOME/skills/tap"   # a REAL dir at the target
echo "keep me" > "$NCHOME/skills/tap/sentinel"
nest_rc=0
make_harness_stubs "$NEST/harness-bin"
nest_out="$(PATH="$NEST/bin:$NEST/harness-bin:$PATH" TAP_INSTALL_BIN="$NEST/bin" TAP_CLAUDE_HOME="$NEST/claude" TAP_CODEX_HOME="$NEST/codex" TAP_HERMES_HOME="$NCHOME" TAP_CURSOR_HOME="$NEST/cursor" TAP_OPENCODE_HOME="$NEST/opencode" TAP_GEMINI_HOME="$NEST/gemini" TAP_CURSOR_AGENT_HOME="$NEST/cursor-agent" TAP_AGENTS_HOME="$NEST/agents" TAP_INDEX_HOME="$NEST/tap-index" TAP_INSTALL_HOOK=0 bash "$ROOT/install.sh" 2>&1)" || nest_rc=$?
[ ! -L "$NCHOME/skills/tap" ] || { echo "bin-tap: (7) install replaced a real dir with a symlink" >&2; exit 1; }
[ -f "$NCHOME/skills/tap/sentinel" ] || { echo "bin-tap: (7) install clobbered real content at the skill target" >&2; exit 1; }
[ "$nest_rc" -eq 0 ] || { echo "bin-tap: (7) a blocked harness stopped the install (rc $nest_rc): $nest_out" >&2; exit 1; }
[[ "$nest_out" == *"could not write $NCHOME/skills/tap"*"move $NCHOME/skills/tap aside"* ]] || { echo "bin-tap: (7) install should refuse to replace a real dir, said: $nest_out" >&2; exit 1; }
echo "bin-tap: (7) install refuses to replace real content at a skill target: ok"

# (8) `tap setup --yes` generates only the repository signpost. /tap owns
#     the operational command reference.
SREPO="$WORK/setuprepo"; git init -q "$SREPO"
gen_out="$( cd "$SREPO" && env -u TAP_HOME TAP_INDEX_HOME="$WORK/setup-idx" "$ROOT/bin/tap" setup --yes 2>&1 )" \
  || { echo "bin-tap: (8) setup --yes failed: $gen_out" >&2; exit 1; }
grep -qF '/tap' "$SREPO/AGENTS.md" || { echo "bin-tap: (8) generated AGENTS.md omits /tap" >&2; exit 1; }
grep -qF 'tap read <id>' "$SREPO/AGENTS.md" || { echo "bin-tap: (8) generated AGENTS.md omits tap read" >&2; exit 1; }
! grep -qE 'tap (register|assign|send|reply|outstanding)' "$SREPO/AGENTS.md" \
  || { echo "bin-tap: (8) generated signpost retained operational commands" >&2; exit 1; }
echo "bin-tap: (8) setup-generated AGENTS.md delegates operations to /tap: ok"

echo "bin-tap-cwd-independent: ok"
