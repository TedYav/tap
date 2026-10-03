#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reclaim-adoption.test.sh — tap-p6el: when register releases a stale fork handle
# (same-session proven corpse), the courier ADOPTS the fork's unsettled team-local
# mail into the reclaiming seat — rewrite to:=successor + forensic to_adopted_from,
# a registry grant, an N>=1 epoch bump — so settlement works WITHOUT --by <fork> and
# in_reply_to provenance survives on the original id. Fake-tmux fixture mirrors
# register-collision.test.sh (pane_id = %<cksum of target>; FAKE_DEAD_PANES = corpse).
set -euo pipefail
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
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN"' EXIT
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/ps" <<'ENDPS'
#!/usr/bin/env bash
printf '1 faketty\n'
ENDPS
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "list-panes" ] && {
  for p in 0.0 0.1 0.2 0.3; do
    case " ${FAKE_DEAD_PANES:-} " in *" ${FAKE_SESSION:-alpha}:$p "*) continue ;; esac
    printf '%s\t%s:%s\t%%%s\tcodex\t4242\t4242:100\t0\n' "${FAKE_SESSION:-alpha}" "${FAKE_SESSION:-alpha}" "$p" "$(printf '%s:%s' "${FAKE_SESSION:-alpha}" "$p" | cksum | cut -d' ' -f1)"
  done
  exit 0
}
[ "${1:-}" = "list-sessions" ] && { printf '%s\t4242:100\t1\n' "${FAKE_SESSION:-alpha}"; exit 0; }
[ "${1:-}" = "display-message" ] || exit 0
shift
target=""; fmt=""
while [ "$#" -gt 0 ]; do case "$1" in -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;; esac; done
if [ -n "$target" ]; then
  case " ${FAKE_DEAD_PANES:-} " in *" $target "*) echo "can't find pane: $target" >&2; exit 1 ;; esac
fi
tpid()  { case "$target" in %*) printf '%s' "$target" ;; *) printf '%%%s' "$(printf '%s' "$target" | cksum | cut -d' ' -f1)" ;; esac; }
tsess() { local s="${target#%}"; printf '%s' "${s%%:*}"; }
case "$fmt" in
  *pane_id*session_name*pane_pid*pane_current_command*) if [ -n "$target" ]; then printf '%s\t%s\t4242\tcodex\t0\n' "$(tpid)" "$(tsess)"; else printf '%%900\t%s\t4242\tcodex\t0\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *pid*start_time*)       echo "4242:100" ;;
  *socket_path*)          echo "${TMUX:-/tmp/tmux-$(id -u)/default}" ;;
  # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
  *pane_id*pane_tty*session_name*) if [ -n "$target" ]; then printf '%s\t/dev/faketty\t%s\t4242:100\n' "$(tpid)" "$(tsess)"; else printf '%%900\t/dev/faketty\t%s\t4242:100\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *pane_id*session_name*) if [ -n "$target" ]; then printf '%s\t%s\n' "$(tpid)" "$(tsess)"; else printf '%%900\t%s\n' "${FAKE_SESSION:-alpha}"; fi ;;
  *window_index*)         echo "${FAKE_SESSION:-alpha}:0.0" ;;
  *session_name*)         if [ -n "$target" ]; then tsess; echo; else echo "${FAKE_SESSION:-alpha}"; fi ;;
  *pane_id*)              if [ -n "$target" ]; then tpid; echo; else echo "%900"; fi ;;
  *pane_current_command*) echo "codex" ;;
  *pane_current_path*)    echo "${FAKE_TMUX_PATH:-$PWD}" ;;
  *) echo "" ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"
export FAKE_TMUX_PATH="$ROOT"
fake_pid() { printf '%%%s' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"; }
field() { python3 -B - "$TAP_HOME/registry.json" "$1" "$2" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: print(""); sys.exit(0)
print(((reg.get("seats") or {}).get(sys.argv[2]) or {}).get(sys.argv[3], ""))
PY
}
has_agent() { python3 -B - "$TAP_HOME/registry.json" "$1" <<'PY'
import json, sys
try: reg = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
sys.exit(0 if sys.argv[2] in (reg.get("seats") or {}) else 1)
PY
}
pfield() { awk -v k="$2" 'NR>1&&/^---$/{exit} $0 ~ "^"k":"{sub("^"k":[ \t]*","");print;exit}' "$TAP_HOME/payloads/$1.md"; }

mail() { # <id> <to> [<from>] [<to_team>]
  local id="$1" to="$2" frm="${3:-sender}" tt="${4:-alpha}"
  { printf '%s\n' '---' "id: $id" "from: $frm" "to: $to" "kind: discuss" "reply: expected" \
      "path: $TAP_HOME/payloads/$id.md"
    [ -n "$tt" ] && printf 'to_team: %s\n' "$tt"
    printf '%s\n' '---' '' "body of $id"; } > "$TAP_HOME/payloads/$id.md"
}

# --- stage: register the FORK fable-2 in session alpha, then plant its mail ----
# Session-qualified addresses (alpha:0.N) so both seats resolve to session "alpha"
# (the fake derives session from the part before ':'); same-session is the release gate.
FIXTURE_ROOT="$TAP_HOME/team"
mkdir -p "$FIXTURE_ROOT"
git -C "$FIXTURE_ROOT" init -q
export FAKE_TMUX_PATH="$FIXTURE_ROOT"
tap_smoke_enroll_current "$FIXTURE_ROOT" "$TAP_HOME"
cd "$FIXTURE_ROOT"
FAKE_SESSION="alpha" tap_smoke_quiet "$TAP" register fable-2 --pane alpha:0.1 \
  || { echo "reclaim-adoption: setup — fork register failed" >&2; exit 1; }
has_agent fable-2 || { echo "reclaim-adoption: setup — fable-2 not registered" >&2; exit 1; }

# The local team is derived from the fixture cwd — read it so the team-gate cases are honest.
LOCAL_TEAM="$(python3 -B -c 'import json,sys;print((json.load(open(sys.argv[1])).get("team") or {}).get("name",""))' "$TAP_HOME/registry.json")"
[ -n "$LOCAL_TEAM" ] || { echo "reclaim-adoption: setup — could not read local team" >&2; exit 1; }

mail m-adopt   fable-2 sender "$LOCAL_TEAM"   # team-local unsettled -> ADOPT
mail m-adopt2  fable-2 sender "$LOCAL_TEAM"   # second adopt -> exercises the --by fork refusal
mail m-settled fable-2 sender "$LOCAL_TEAM"   # settled -> NEVER touched
: > "$TAP_HOME/receipts/m-settled.done"
mail m-foreign fable-2 sender "${LOCAL_TEAM}-FOREIGN"  # foreign to_team -> NEVER adopt (18so)
mail m-out     someone fable-2 "$LOCAL_TEAM"  # outbound from=fable-2 -> NEVER reassign
mail m-other   grok-2  sender "$LOCAL_TEAM"   # different handle -> untouched

# --- act: register fable on a NEW pane in the SAME session -> releases the corpse
# fork (its pane + pane_id are dead) -> adoption fires under the release flock.
FORK_PANE_ID="$(fake_pid alpha:0.1)"
OUT="$(FAKE_SESSION="alpha" FAKE_DEAD_PANES="alpha:0.1 $FORK_PANE_ID" \
       "$TAP" register fable --pane alpha:0.2 2>&1)" \
  || { echo "reclaim-adoption: reclaim register failed" >&2; echo "$OUT" >&2; exit 1; }

# (1) the fork row was released; fable is registered.
has_agent fable   || { echo "reclaim-adoption: (1) fable not registered" >&2; exit 1; }
! has_agent fable-2 || { echo "reclaim-adoption: (1) stale fork fable-2 was not released" >&2; exit 1; }

# ── tap-52ys: 7 of 9 arms removed (ratified 2026-08-14) ─────────────────────
# Two arms carry the invariant: a stale fork is released and its mail adopted,
# and a LIVE sibling is never released (the destructive direction). The rest
# permuted the bookkeeping — epoch counts, --by refusals, XWT buses, the
# 8-handle cap.
#
# Accepted gap, named: adoption-grant epoch recording, the handle_adopted
# refusal message, cross-worktree fork mail, and the surplus-fork cap.

echo "reclaim-adoption: (1) reclaim releases the stale fork, seat returns as fable: ok"

# (2) the fork's unsettled team-local mail was adopted; controls untouched.
[ "$(pfield m-adopt to)" = "fable" ] || { echo "reclaim-adoption: (2) m-adopt to not rewritten to fable (got '$(pfield m-adopt to)')" >&2; exit 1; }
[ "$(pfield m-adopt to_adopted_from)" = "fable-2" ] || { echo "reclaim-adoption: (2) m-adopt missing forensic to_adopted_from" >&2; exit 1; }
[ -n "$(pfield m-adopt adopted_at)" ] || { echo "reclaim-adoption: (2) m-adopt missing adopted_at" >&2; exit 1; }
[ "$(pfield m-settled to)" = "fable-2" ] || { echo "reclaim-adoption: (2) settled payload was rewritten (must not touch settled history)" >&2; exit 1; }
[ "$(pfield m-foreign to)" = "fable-2" ] || { echo "reclaim-adoption: (2) foreign to_team payload was adopted (18so violation)" >&2; exit 1; }
[ "$(pfield m-out to)" = "someone" ] || { echo "reclaim-adoption: (2) outbound from=fork was reassigned" >&2; exit 1; }
[ "$(pfield m-other to)" = "grok-2" ] || { echo "reclaim-adoption: (2) unrelated handle's mail was touched" >&2; exit 1; }
echo "reclaim-adoption: (2) fork mail adopted (to->fable + to_adopted_from); settled/foreign/outbound/unrelated untouched: ok"


# (7) BOTH-LIVE invariant (spine #3 / §12.3): a still-LIVE sibling is never released, so
# its mail is NEVER adopted. Adoption is a consequence of release, not a separate race.
FAKE_SESSION="alpha" tap_smoke_quiet "$TAP" register grok-2 --pane alpha:0.3 \
  || { echo "reclaim-adoption: (7) setup — grok-2 register failed" >&2; exit 1; }
mail m-live grok-2 sender "$LOCAL_TEAM"
# Register grok in the SAME session while grok-2's pane stays ALIVE (not in FAKE_DEAD_PANES).
FAKE_SESSION="alpha" tap_smoke_quiet "$TAP" register grok --pane alpha:0.4 \
  || { echo "reclaim-adoption: (7) grok register failed" >&2; exit 1; }
has_agent grok-2 || { echo "reclaim-adoption: (7) live sibling grok-2 was released (must be kept)" >&2; exit 1; }
[ "$(pfield m-live to)" = "grok-2" ] || { echo "reclaim-adoption: (7) a LIVE fork's mail was adopted (no release => no adoption)" >&2; exit 1; }
case "$(field grok adopted_handles)" in *grok-2*) echo "reclaim-adoption: (7) grok wrongly granted adoption over a live grok-2" >&2; exit 1 ;; esac
echo "reclaim-adoption: (7) both-live — a live sibling is never released, its mail never adopted: ok"

echo "reclaim-adoption: ok"
