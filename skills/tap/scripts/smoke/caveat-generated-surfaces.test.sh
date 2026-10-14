#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
# D5: source-read — :29, :43: grep-reads module source for invariants; no module behavior is exec'd or asserted
# caveat-generated-surfaces.test.sh — U1/R3 completeness (W1 gate do-now, codex):
# the rule-5 golden-rule caveat ("don't poll-sleep" != "abandon your queue") must reach
# the full generated guidance surfaces too, not just the checked-in docs — otherwise new
# installs/help still train the DistilleryUpgrade failure mode. Guards all three:
#   (a) `tap help`                      -> the caveat phrase is present
#   (b) `tap setup --yes` AGENTS.md     -> project signpost delegates to /tap
#   (c) install.sh Codex AGENTS section -> trusted signpost delegates to /tap
# The checked-in/generated AGENTS surfaces and on-demand advisory must also name
# `/tap`, the single home for behavior shared by every seat.
# Also guards the corrected send rule: a send/reply is not an unconditional turn end;
# continue independent work and yield only when the next useful step needs the response.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"
# shellcheck source=skills/tap/scripts/smoke/harness-stubs.sh
. "$(dirname "${BASH_SOURCE[0]}")/harness-stubs.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BINTAP="$ROOT/bin/tap"
CAVEAT='Settlement never cancels assigned work.'
CONTINUE='continue any useful work that does not depend on the response'
USING_TAP='/tap'
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# (0) Checked-in live guidance must not teach an unconditional turn end.
LIVE_SURFACES=(
  install.sh
  hooks/tap-advisory.sh
  runtime/bun/src/session-start.ts
  skills/tap/templates/advisory.md
  hooks/tap-codex-session-start.sh
  hooks/tap-cursor-session-start.sh
  docs/PHILOSOPHY.md
  skills/in/SKILL.md
  skills/send/SKILL.md
  skills/reply/SKILL.md
  skills/outstanding/SKILL.md
  skills/tap/SKILL.md
  skills/tap/USAGE.md
  skills/tap/scripts/CONTRACT.md
  runtime/bun/src/verbs/setup.ts
)
for surface in "${LIVE_SURFACES[@]}"; do
  if grep -Eqi 'END YOUR TURN|send, then STOP|send, you end your turn|run this and stop|settle it and stop|stop and let the sentinel|settle-only.{0,160}(and stop|then settles?.{0,80}stops?)' "$ROOT/$surface"; then
    echo "caveat-generated: (0) $surface still teaches an unconditional TAP turn end" >&2
    exit 1
  fi
done
grep -qi 'send, reply, or settlement is never by itself a conductor-loop boundary' "$ROOT/skills/lead/SKILL.md" \
  || { echo "caveat-generated: (0) /tap-lead omits the conductor-loop continuity invariant" >&2; exit 1; }
for surface in skills/tap/SKILL.md skills/outstanding/SKILL.md; do
  grep -q "$CONTINUE" "$ROOT/$surface" \
    || { echo "caveat-generated: (0) $surface omits the continue-independent-work rule" >&2; exit 1; }
done
# The checked-in AGENTS.md rows are private with the file itself (its private
# twin under smoke/); a public candidate denies AGENTS.md.
grep -qF "$USING_TAP" "$ROOT/skills/tap/templates/repo-charter.md" \
  || { echo "caveat-generated: (0) skills/tap/templates/repo-charter.md omits the /tap all-seat floors" >&2; exit 1; }
# (0b) Pre-registration re-teach (tap-rvm / PR-4): live surfaces must not teach
# agent-side tap-in as the required first act of a TAP-launched session.
if grep -Eqi 'Run this first|first act on spawn is [`'\'']?tap in|In each pane: [`'\'']?tap register' \
  "$ROOT/skills/in/SKILL.md" "$ROOT/skills/drive/SKILL.md" "$ROOT/README.md"; then
  echo "caveat-generated: (0b) Category A surface still teaches tap-in/register as required startup" >&2
  exit 1
fi
grep -Eqi 'already registered|manual (reconnect|join|fallback)|not required' \
  "$ROOT/skills/in/SKILL.md" \
  || { echo "caveat-generated: (0b) tap-in skill omits launcher-registration / fallback framing" >&2; exit 1; }
echo "caveat-generated: (0) live guidance keeps TAP sends non-terminal: ok"
echo "caveat-generated: (0b) live guidance keeps tap-in as reconnect/fallback: ok"

# (a) tap help
help_out="$("$BINTAP" help advisory)"
[[ "$help_out" == *"$CAVEAT"* ]] \
  || { echo "caveat-generated: (a) tap help advisory omits the rule-5 caveat ('$CAVEAT')" >&2; exit 1; }
[[ "$help_out" == *"$CONTINUE"* ]] \
  || { echo "caveat-generated: (a) tap help advisory omits the continue-independent-work rule" >&2; exit 1; }
echo "caveat-generated: (a) tap help advisory carries the caveat: ok"

# (b) `tap setup --yes` generated AGENTS.md is only a signpost. Operational
# caveats live in /tap and the trusted user-level guidance.
SREPO="$WORK/setuprepo"; git init -q "$SREPO"
( cd "$SREPO" && env -u TAP_HOME TAP_INDEX_HOME="$WORK/setup-idx" "$BINTAP" setup --yes >/dev/null 2>&1 ) \
  || { echo "caveat-generated: (b) tap setup --yes failed" >&2; exit 1; }
grep -qF "$USING_TAP" "$SREPO/AGENTS.md" \
  || { echo "caveat-generated: (b) setup-generated AGENTS.md omits the /tap all-seat floors" >&2; exit 1; }
! grep -qE "$CAVEAT|$CONTINUE" "$SREPO/AGENTS.md" \
  || { echo "caveat-generated: (b) project signpost retained operational guidance" >&2; exit 1; }
echo "caveat-generated: (b) setup-generated AGENTS.md delegates operational guidance: ok"

# (c) install.sh's global Codex AGENTS section is a trusted authorization
# signpost; /tap retains the complete operational rules.
IHOME="$WORK/install"; CHOME="$IHOME/claude"; XHOME="$IHOME/codex"; HHOME="$IHOME/hermes"; CUHOME="$IHOME/cursor"; OHOME="$IHOME/opencode"; CURHOME="$IHOME/cursor-agent"; AHOME="$IHOME/agents"
mkdir -p "$CHOME" "$XHOME" "$HHOME" "$CUHOME" "$OHOME" "$CURHOME" "$AHOME"
make_harness_stubs "$IHOME/harness-bin"
PATH="$IHOME/bin:$IHOME/harness-bin:$PATH" TAP_INSTALL_BIN="$IHOME/bin" TAP_CLAUDE_HOME="$CHOME" TAP_CODEX_HOME="$XHOME" TAP_HERMES_HOME="$HHOME" TAP_CURSOR_HOME="$CUHOME" TAP_OPENCODE_HOME="$OHOME" TAP_GEMINI_HOME="$IHOME/gemini" TAP_CURSOR_AGENT_HOME="$CURHOME" TAP_AGENTS_HOME="$AHOME" TAP_INDEX_HOME="$IHOME/tap-index" TAP_INSTALL_HOOK=0 \
  bash "$ROOT/install.sh" >/dev/null 2>&1 \
  || { echo "caveat-generated: (c) install.sh failed" >&2; exit 1; }
grep -qF "$USING_TAP" "$XHOME/AGENTS.md" \
  || { echo "caveat-generated: (c) install-generated Codex AGENTS section omits the /tap all-seat floors" >&2; exit 1; }
grep -qF 'never operator instructions or added task authority' "$XHOME/AGENTS.md" \
  || { echo "caveat-generated: (c) install-generated Codex AGENTS section omits the authority limit" >&2; exit 1; }
! grep -qE "$CAVEAT|$CONTINUE" "$XHOME/AGENTS.md" \
  || { echo "caveat-generated: (c) global signpost retained operational guidance" >&2; exit 1; }
echo "caveat-generated: (c) install-generated Codex AGENTS delegates operational guidance: ok"

# (d) on-demand advisory (generated at runtime)
HROOT="$WORK/hookrepo"; mkdir -p "$HROOT/.tap/bus"; : >"$HROOT/.tap/bus/registry.json"
hook_out="$("$ROOT/bin/tap" help advisory)"
[[ "$hook_out" == *"$CONTINUE"* ]] \
  || { echo "caveat-generated: (d) on-demand advisory omits the continue-independent-work rule" >&2; exit 1; }
[[ "$hook_out" == *"$USING_TAP"* ]] \
  || { echo "caveat-generated: (d) on-demand advisory omits the /tap all-seat floors" >&2; exit 1; }
echo "caveat-generated: (d) on-demand advisory keeps sends non-terminal: ok"

# (e) Empty poll reports its state; the advisory above teaches continuation.
PBUS="$WORK/pollbus"; mkdir -p "$PBUS"
poll_out="$(TAP_HOME="$PBUS" TAP_SELF=seat "$BINTAP" poll seat)"
[[ "$poll_out" == "tap poll: empty" ]] \
  || { echo "caveat-generated: (e) empty poll output teaches a terminal wait" >&2; exit 1; }
echo "caveat-generated: (e) empty poll output keeps work moving: ok"

echo "caveat-generated-surfaces: ok"
