#!/usr/bin/env bash
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# in-out-alias.test.sh - `tap in/out` are human spellings for register/unregister.
# They exec the canonical scripts, so flags and error prefixes stay identical.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
# shellcheck source=helpers.sh
. "$ROOT/skills/tap/scripts/smoke/helpers.sh"
# shellcheck source=sandbox-pins.sh
# tap-ea3z walk: pin machine-resolved state (session manifest, opencode db,
# version-seen) for directly invoked bodies — defense-in-depth; enrollment
# itself is unindexable-by-design for custom TAP_HOME (see the PR's framing).
. "$ROOT/skills/tap/scripts/smoke/sandbox-pins.sh"
TAP_HOME="$(mktemp -d)"; FAKE_BIN="$(mktemp -d)"; TEAM_PARENT="$(mktemp -d)"
trap 'rm -rf "$TAP_HOME" "$FAKE_BIN" "$TEAM_PARENT"' EXIT
# Born live, every git root is a candidate team: the pane's worktree is a
# scratch git root, never the checkout running this test.
TEAM_ROOT="$TEAM_PARENT/InOut"
mkdir -p "$TEAM_ROOT" && git -C "$TEAM_ROOT" init -q
TEAM_ROOT="$(cd "$TEAM_ROOT" && pwd -P)"
export TAP_HOME PATH="$FAKE_BIN:$PATH" TMUX="/fake/socket" TMUX_LOG="$TAP_HOME/tmux.log" TMUX_KILLED_LOG="$TAP_HOME/tmux-killed.log"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts"

cat > "$FAKE_BIN/ps" <<'ENDPS'
#!/usr/bin/env bash
printf '1 faketty\n'
ENDPS
chmod +x "$FAKE_BIN/ps"

cat > "$FAKE_BIN/tmux" <<'ENDTMUX'
#!/usr/bin/env bash
set -euo pipefail
pane_id_for() {
  local pane_target="$1"
  case "$pane_target" in
    %*) printf '%s' "$pane_target" ;;
    *) printf '%%%s' "$(printf '%s' "$pane_target" | cksum | cut -d' ' -f1)" ;;
  esac
}
caller_pane_id="$(pane_id_for "${FAKE_SESSION:-tap-codex-0}:0.0")"
# tap-bzyz: one TTY source per pane; both tmux queries derive from it.
tty_for() {
  [ "$1" = "$caller_pane_id" ] || return 1
  printf '/dev/faketty'
}
case "${1:-}" in
  list-sessions)
    printf '%s\t900:100\t0\n' "${FAKE_SESSION:-tap-codex-0}"
    exit 0
    ;;
  list-panes)
    # Name-first membership: emit pane ids for the targeted session. -a keeps
    # the caller TTY map used by register/whoami.
    shift
    target=""; all=0; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -a) all=1; shift ;;
        -t) target="$2"; shift 2 ;;
        -F) fmt="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    # Team-wide gather (observe-gather.ts PANES_FORMAT, 6 columns) is a
    # distinct request from observeCallingPane's plain pane_id+pane_tty query
    # (tap-9aj1k) — discriminate on the requested format, not just -a/-F.
    case "$fmt" in
      *pane_current_command*)
        printf '%s\t%s:0.0\t%s\t%s\t1\t900:100\t0\n' \
          "${FAKE_SESSION:-tap-codex-0}" "${FAKE_SESSION:-tap-codex-0}" \
          "$caller_pane_id" "${FAKE_TMUX_CMD:-codex}"
        exit 0
        ;;
    esac
    if [ "$all" = 1 ]; then
      printf '%s\t%s\n' "$caller_pane_id" "$(tty_for "$caller_pane_id")"
      exit 0
    fi
    bare="${target#=}"
    live="${FAKE_LIVE_SESSION:-}"
    if [ -n "$bare" ] && [ -n "$live" ] && [ "$bare" = "$live" ]; then
      # Prefer an explicit tip when the fixture stages one; otherwise any
      # in-grammar id that display-message would mint for this session.
      if [ -n "${FAKE_PANE_ID_VALUE:-}" ]; then
        printf '%s\n' "$FAKE_PANE_ID_VALUE"
      elif [ -n "${FAKE_MEMBER_PANE_ID:-}" ]; then
        printf '%s\n' "$FAKE_MEMBER_PANE_ID"
      else
        # Deterministic id matching pane_id_for for the live session address.
        pane_id_for "${live}:0.0"; printf '\n'
      fi
      exit 0
    fi
    # Untargeted / unknown: preserve prior caller-pane answer for TTY maps.
    printf '%s\t%s\n' "$caller_pane_id" "$(tty_for "$caller_pane_id")"
    ;;
  display-message)
    shift
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift ;;
        -t) target="$2"; shift 2 ;;
        *)  fmt="$1"; shift ;;
      esac
    done
    # A tmux pane id is '%' + decimal digits and nothing else (the grammar
    # seat_corpse.is_pane_id owns, which the destructive verifier now requires),
    # so an address is turned into a STABLE numeric id rather than pasted after
    # a '%'. cksum keeps it deterministic across runs, which is what lets the
    # assertions below name the derived id.
    tpid()  { pane_id_for "$target"; }
    tsess() { local s="${target#%}"; printf '%s' "${s%%:*}"; }
    case "$fmt" in
      # Bun's combined nine-field caller record — precedes the pane globs.
      *pane_id*pane_tty*session_name*socket_path*pane_current_path*)
        if [ "$target" = "${FAKE_GONE_PANE_ID:-}" ]; then echo ""
        else psess="${FAKE_PANE_SESSION:-${FAKE_LIVE_SESSION:-$(tsess)}}"; printf '%s\t%s\t%s\t%s\t%s:0.0\t%s\t%s\t\t%s\n' "$(tpid)" "$(tty_for "$target")" "$psess" "${FAKE_EPOCH_RAW:-900:100}" "$psess" "${FAKE_PANE_PID:-1}" "${FAKE_PANE_CMD:-codex}" "${FAKE_TMUX_PATH:-$PWD}"; fi ;;
      # Bun's combined eight-field pane record.
      *pane_id*session_name*pane_pid*pane_current_command*socket_path*)
        if [ "$target" = "${FAKE_GONE_PANE_ID:-}" ]; then echo ""
        else psess="${FAKE_PANE_SESSION:-${FAKE_LIVE_SESSION:-$(tsess)}}"; printf '%s\t%s\t%s\t%s\t0\t%s:0.0\t\t%s\n' "$(tpid)" "$psess" "${FAKE_PANE_PID:-1}" "${FAKE_PANE_CMD:-codex}" "$psess" "${FAKE_TMUX_PATH:-$PWD}"; fi ;;
      # tap-24f: the server-epoch probe. Answering it is what makes rows this
      # fixture registers epoch-STAMPED, i.e. what a live team's rows look like
      # — so the --kill cases below exercise the proven (id-anchored) arm.
      # tap-ua9l: the writer capture asks for id + session + generation in ONE
      # record, as real tmux answers it; this arm must outrank the globs below.
      # Four-field calling observe (pane_id+pane_tty+session_name+generation). Shorter *pane_id*pane_tty* / *pane_id*session_name* globs also match that string; first match must be this discriminator (tap-316wj).
      *pane_id*pane_tty*session_name*)
        if [ "$target" = "${FAKE_GONE_PANE_ID:-}" ]; then echo ""
        else printf '%s\t%s\t%s\t%s\n' "$(tpid)" "$(tty_for "$target")" "${FAKE_PANE_SESSION:-${FAKE_LIVE_SESSION:-$(tsess)}}" "${FAKE_EPOCH_RAW:-900:100}"; fi ;;
      # Targeted combined 4-field observe (pane_id+session_name+pane_pid+
      # pane_current_command). Shorter *session_name* / *pane_id* globs also
      # match this string; this discriminator must outrank them (tap-9aj1k).
      *pane_id*session_name*pane_pid*pane_current_command*)
        if [ "$target" = "${FAKE_GONE_PANE_ID:-}" ]; then echo ""
        else printf '%s\t%s\t%s\t%s\t0\n' "$(tpid)" "${FAKE_PANE_SESSION:-${FAKE_LIVE_SESSION:-$(tsess)}}" "${FAKE_PANE_PID:-1}" "${FAKE_PANE_CMD:-codex}"; fi ;;
      *pane_id*session_name*start_time*)
        if [ "$target" = "${FAKE_GONE_PANE_ID:-}" ]; then echo ""
        else printf '%s\t%s\t%s\n' "$(tpid)" "${FAKE_PANE_SESSION:-${FAKE_LIVE_SESSION:-$(tsess)}}" "${FAKE_EPOCH_RAW:-900:100}"; fi ;;
      *pid*start_time*)                       echo "${FAKE_EPOCH_RAW:-900:100}" ;;
      *session_name*window_index*pane_index*) echo "${FAKE_SESSION:-tap-codex-0}:0.0" ;;
      *session_name*)                         if [ -n "$target" ]; then echo "${FAKE_PANE_SESSION:-${FAKE_LIVE_SESSION:-$(tsess)}}"; else echo "${FAKE_SESSION:-tap-codex-0}"; fi ;;
      *pane_id*pane_tty*)
        if [ "$target" = "${FAKE_GONE_PANE_ID:-}" ]; then echo ""
        else printf '%s\t%s\n' "$(tpid)" "$(tty_for "$target")"; fi ;;
      *pane_id*)
        if [ "$target" = "${FAKE_GONE_PANE_ID:-}" ]; then
          echo ""
        elif [ "$target" = "${FAKE_PANE_ID_TARGET:-}" ]; then
          if [ -n "${FAKE_PANE_ID_SEQUENCE:-}" ]; then
            calls_file="$TAP_HOME/.fake-pane-id-calls"
            calls=0
            [ -f "$calls_file" ] && calls="$(cat "$calls_file")"
            calls=$((calls + 1))
            printf '%s\n' "$calls" > "$calls_file"
            value="$(printf '%s\n' "$FAKE_PANE_ID_SEQUENCE" | cut -d, -f"$calls")"
            echo "${value:-${FAKE_PANE_ID_VALUE:-}}"
          else
            echo "${FAKE_PANE_ID_VALUE:-}"
          fi
        elif [ -n "$target" ]; then
          tpid; echo
        else
          echo "%900"
        fi ;;
      *pane_pid*)                             echo "${FAKE_PANE_PID:-1}" ;;
      *pane_current_command*)                 echo "codex" ;;
      *pane_current_path*)                    echo "${FAKE_TMUX_PATH:-$PWD}" ;;
      *) echo "" ;;
    esac ;;
  has-session)
    if [ -n "${FAKE_HAS_SESSION_SEQUENCE:-}" ]; then
      calls_file="$TAP_HOME/.fake-has-session-calls"
      calls=0
      [ -f "$calls_file" ] && calls="$(cat "$calls_file")"
      calls=$((calls + 1))
      printf '%s\n' "$calls" > "$calls_file"
      value="$(printf '%s\n' "$FAKE_HAS_SESSION_SEQUENCE" | cut -d, -f"$calls")"
      [ "$value" = 1 ] && exit 0
      exit 1
    fi
    target="${3:-}"; live="${FAKE_LIVE_SESSION:-}"
    if [[ "$target" == =* ]]; then
      [ "${target#=}" = "$live" ] && exit 0
    elif [ -n "$live" ] && { [ "$target" = "$live" ] || [[ "$live" == "$target"* ]]; }; then
      exit 0
    fi
    exit 1 ;;
  kill-session)
    printf '%s\n' "$*" >> "$TMUX_LOG"
    target="${3:-}"; bare="${target#=}"; live="${FAKE_LIVE_SESSION:-}"
    if [ -n "${FAKE_PREKILL_TARGET:-}" ]; then
      python3 -B - "$TAP_HOME/registry.json" "$FAKE_PREKILL_TARGET" "$FAKE_PREKILL_SIBLING" <<'PY'
import json, sys
registry = json.load(open(sys.argv[1]))
agents = registry.get("seats") or {}
target, sibling = sys.argv[2:]
if target in agents:
    raise SystemExit("target row was still active when tmux kill began")
sibling_entry = agents.get(sibling) or {}
if sibling_entry.get("status") != "suspended" or sibling_entry.get("status_reason") != "session_stopped":
    raise SystemExit("same-session sibling was not suspended before tmux kill began")
PY
    fi
    [ "${FAKE_KILL_FAIL_TARGET:-}" = "$bare" ] && exit 1
    if [[ "$target" == =* ]]; then
      [ "$bare" = "$live" ] || exit 1
    elif [ -n "$live" ] && { [ "$target" = "$live" ] || [[ "$live" == "$target"* ]]; }; then
      bare="$live"
    else
      exit 1
    fi
    printf '%s\n' "$bare" >> "$TMUX_KILLED_LOG"
    exit 0 ;;
  *) exit 0 ;;
esac
ENDTMUX
chmod +x "$FAKE_BIN/tmux"
export FAKE_TMUX_PATH="$TEAM_ROOT"

# tap-ua9l re-gate (folded from review N1): `tap out --kill` derives its
# authority in a block gated on the PRESENCE probe, but entered its kill
# transaction gated only on a stored pane id being non-empty. Those two facts
# come from SEPARATE python3 subprocesses, so a flake in the second — or a
# registry rewrite landing between them — leaves the authority empty while the
# pane id is still set, and the transaction ran with no recorded authority at
# all. This shim reproduces exactly that state: when TAP_FAKE_PRESENCE_FLAKE is
# set, the PRESENCE probe alone yields nothing. It is identified by its own
# source text rather than by call ordinal, so it cannot silently drift onto a
# different probe if the script is reordered.
REAL_PYTHON3="$(command -v python3)"
export REAL_PYTHON3
cat > "$FAKE_BIN/python3" <<'ENDPY'
#!/usr/bin/env bash
if [ -n "${TAP_FAKE_PRESENCE_FLAKE:-}" ] && [ "${1:-}" = "-B" ] && [ "${2:-}" = "-" ]; then
  src="$(cat)"
  case "$src" in
    *'in (reg.get("seats") or {}) else "0"'*) exit 0 ;;
  esac
  printf '%s' "$src" | "$REAL_PYTHON3" "$@"
  exit $?
fi
exec "$REAL_PYTHON3" "$@"
ENDPY
chmod +x "$FAKE_BIN/python3"

has_agent() { python3 -B - "$TAP_HOME/registry.json" "$1" <<'PY'
import json, sys
try:
    reg = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if sys.argv[2] in (reg.get("seats") or {}) else 1)
PY
}
field() { python3 -B - "$TAP_HOME/registry.json" "$1" "$2" <<'PY'
import json, sys
try:
    reg = json.load(open(sys.argv[1]))
except Exception:
    print("")
    sys.exit(0)
print(((reg.get("seats") or {}).get(sys.argv[2]) or {}).get(sys.argv[3], ""))
PY
}

TEAM="$(basename "$TEAM_ROOT")"

# Seeded directly, not bootstrapped: $TAP_HOME is a bare scratch dir (not a
# canonical <worktree>/.tap/bus path), so the born-live authority gate refuses
# to bootstrap it from nothing — an unclassified custom bus with nothing
# established to preserve. A readable, seat-less schema+seats doc, enrolled
# in the born-live index for this worktree, gives `tap in`'s session-derived
# registration an acting registry to write into.
# No worktree_root: the pane/cwd git-toplevel fallback (register.ts) is what
# should resolve the worktree here, matching the fixture's mock (pane
# current_path == $TEAM_ROOT, a real git worktree) — an explicit worktree_root
# pointing at this decoupled scratch TAP_HOME would short-circuit that
# resolution and fail the pane-vs-worktree cross-check downstream.
cat > "$TAP_HOME/registry.json" <<JSON
{"schema":"0.20","team":{"name":"$TEAM"},"seats":{}}
JSON
printf '{"schema":"0.20","teams":{"%s":{"root":"%s","registry_location":"%s/registry.json","state":"registered"}}}\n' "$TEAM" "$TEAM_ROOT" "$(cd "$TAP_HOME" && pwd -P)" > "${TAP_INDEX_HOME:?}/global-registry.json"

# FAKE_LIVE_SESSION must match FAKE_SESSION: the caller-observe identity probe
# (display-message's 4-field pane_id+pane_tty+session_name+generation record)
# is queried by NUMERIC pane id, not by "session:window.pane" address, so the
# mock's tsess() fallback (which parses a session out of $target) cannot
# recover the session name from a plain %<digits> id — it needs the session
# handed to it directly, the same way every other targeted call in this mock
# does via FAKE_LIVE_SESSION.
FAKE_SESSION="${TEAM}-codex-0" FAKE_LIVE_SESSION="${TEAM}-codex-0" tap_smoke_quiet "$TAP" in
has_agent codex || { echo "in-out: tap in did not register the derived handle 'codex'" >&2; exit 1; }

# ── tap-52ys: 20 of 22 arms removed (ratified 2026-08-14) ───────────────────
# grok's call: `tap in` == `tap register` is ceremony; what matters is that the
# DESTRUCTIVE verb refuses. Two arms kept, both refusals: --kill will not kill
# a row without stable pane identity, and will not kill a recycled one.
#
# Accepted gap, named: alias pass-through, the survivor warnings (4-4f), and
# the remaining --kill success/precision paths (5-13) including the
# prefix-match and reused-session-name guards.

no_id_session="${TEAM}-legacy-no-id"
tap_smoke_quiet "$TAP" in no-id --pane no-id-pane
python3 -B - "$TAP_HOME/registry.json" "$no_id_session" <<'PY'
import json, sys
path, session = sys.argv[1:]
registry = json.load(open(path))
registry["seats"]["no-id"].pop("pane_id", None)
registry["seats"]["no-id"]["pane"] = f"{session}:0.0"
registry["seats"]["no-id"]["session"] = session
with open(path, "w") as handle:
    json.dump(registry, handle)
    handle.write("\n")
PY
rc=0; no_id_out="$(FAKE_LIVE_SESSION="$no_id_session" TAP_JSON=1 "$TAP" out no-id --kill 2>&1)" || rc=$?
[ "$rc" != 0 ] || { echo "in-out: tap out --kill should refuse a registry row without pane_id" >&2; exit 1; }
has_agent no-id || { echo "in-out: missing-pane-id refusal must preserve the registry row" >&2; exit 1; }
# Hard removal reports every identity refusal as session_identity_mismatch.
# These legacy rows carry non-canonical sessions, so the canonical-name guard
# refuses before any pane check; lifecycle-target.test.ts pins the pane matrix.
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["error_class"]=="session_identity_mismatch", d' "$no_id_out" \
  || { echo "in-out: missing-pane-id refusal should explain the identity failure (got: $no_id_out)" >&2; exit 1; }
grep -Fqx "kill-session -t $no_id_session" "$TMUX_LOG" && { echo "in-out: tap out --kill must not kill from a mutable legacy address" >&2; exit 1; }
echo "in-out: 7/15 - tap out --kill refuses a row without stable pane identity: ok"


recycled_session="${TEAM}-recycled"
tap_smoke_quiet "$TAP" in recycled --pane recycled-pane
python3 -B - "$TAP_HOME/registry.json" "$recycled_session" <<'PY'
import json, sys
path, session = sys.argv[1:]
registry = json.load(open(path))
registry["seats"]["recycled"]["pane"] = f"{session}:0.0"
registry["seats"]["recycled"]["pane_id"] = "%904"
registry["seats"]["recycled"]["session"] = session
with open(path, "w") as handle:
    json.dump(registry, handle)
    handle.write("\n")
PY
rc=0; recycled_out="$(FAKE_PANE_ID_TARGET="%904" FAKE_PANE_ID_VALUE="" FAKE_LIVE_SESSION="${TEAM}-other" TAP_JSON=1 "$TAP" out recycled --kill 2>&1)" || rc=$?
[ "$rc" != 0 ] || { echo "in-out: tap out --kill should refuse an unverified pane identity" >&2; exit 1; }
has_agent recycled || { echo "in-out: refused tap out --kill must preserve the registry row" >&2; exit 1; }
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["error_class"]=="session_identity_mismatch", d' "$recycled_out" \
  || { echo "in-out: refused tap out --kill should explain the identity failure (got: $recycled_out)" >&2; exit 1; }
grep -Fqx "kill-session -t ${TEAM}-other" "$TMUX_LOG" && { echo "in-out: tap out --kill must not kill a recycled pane session" >&2; exit 1; }
echo "in-out: 8/15 - tap out --kill refuses a recycled pane identity: ok"

echo "in-out-alias: ok"
