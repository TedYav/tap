#!/usr/bin/env bash
# D5: fixture-door — the src tree is fixture state (:19 names it, :121 copies it, :126 mutates the stop.ts copy so the keep-self gate trips); the subject is the public `tap team reset --yes` refusal path, whose guards are owned natively by team-stop-plan.test.ts:68 (keep_self default) and the team-stop-* suites.
# tap-o4ae: fixture env (TMUX=/fake/socket, …) must stay in this process.
# Refuse `source` so an interactive shell cannot inherit top-level exports.
# Must run BEFORE any `set -o` so a refusal does not mutate caller options.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  echo "$(basename "${BASH_SOURCE[0]}"): do not source — run: bash $0" >&2
  return 1 2>/dev/null || exit 1
fi
# reset-keep-self-unobservable.test.sh — fable 070315 / opus 070009
# Default reset-stop sets keep_self=1; unobservable caller must NOT refuse
# citing unused self-last ordering. Mutation-proves the keep_self gate.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
STOP="$ROOT/runtime/bun/src/team/stop.ts"

fail() { echo "reset-unobs: $*" >&2; exit 1; }

# Source gate must consult keep_self (same condition as the self-last block).
grep -q 'if (!callerPaneId && identity.tmuxActive && !parsed.keepSelf) {' "$STOP" \
  || fail "guard missing keep_self gate — refuse must match self-last condition"

BUSROOT="$(mktemp -d)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$BUSROOT" "$FAKE_BIN" "${MUT_ROOT:-}"' EXIT
export TAP_HOME="$BUSROOT/.tap/bus"
export TAP_SCRATCH_ONLY="$BUSROOT"
export TAP_SESSION_MANIFEST="$BUSROOT/sessions.json"
export PATH="$FAKE_BIN:$PATH"
export TMUX="/fake/socket"
# Process ownership unobservable → tap_calling_pane_id empty (caller-identity (5)/(6)).
export FAKE_CALLER_TTY="?"

printf '{"dir_aliases":{},"sessions":[]}\n' > "$TAP_SESSION_MANIFEST"
mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp"

# Fake tmux: enough for reset/stop planning; NEVER answers a caller-pane binding.
# Intentionally does not make display-message without -t invent a pane id.
cat > "$FAKE_BIN/tmux" <<'TMUX'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
  has-session|kill-session) exit 0 ;;
  list-sessions) exit 0 ;;
  list-panes) exit 0 ;;  # empty → no tty→pane binding
  display-message)
    # No caller-pane invention. Targeted queries may return empty.
    exit 0
    ;;
  *) exit 0 ;;
esac
TMUX
chmod +x "$FAKE_BIN/tmux"

cat > "$FAKE_BIN/ps" <<'PS'
#!/usr/bin/env bash
# Honor FAKE_CALLER_TTY so ownership stays unobservable ("?").
# Reset-fence lstart (and anything else) must hit real ps — a blanket
# identity answer makes owner_start unreadable and refuses acquire.
case "$*" in
  *ppid*|*tty=*)
    printf '1 %s\n' "${FAKE_CALLER_TTY:-?}"
    exit 0
    ;;
esac
exec /bin/ps "$@"
PS
chmod +x "$FAKE_BIN/ps"

seed() {
  mkdir -p "$TAP_HOME/payloads" "$TAP_HOME/receipts" "$TAP_HOME/tmp"
  printf 'x\n' > "$TAP_HOME/payloads/p1.md"
  # poll: no kill targets; isolates the observability guard from pane hard-gates.
  printf '{"schema": "0.20", "team":{"name":"demo"},"seats":{"claude":{"status":"active","delivery":"poll"}}}\n' \
    > "$TAP_HOME/registry.json"
}

# (1) Default team reset with TMUX set + unobservable caller must succeed.
seed
set +e
out="$("$TAP" team reset --yes --allow-nonstandard-bus-path 2>&1)"
rc=$?
set -e
[ "$rc" = 0 ] || { echo "$out" >&2; fail "(1) default reset refused unobservable caller rc=$rc (keep_self gate broken?)"; }
grep -Eq 'caller_identity_unobservable|self-last ordering' <<<"$out" \
  && { echo "$out" >&2; fail "(1) reset cited unused self-last/unobservable guard"; }
[ ! -f "$TAP_HOME/registry.json" ] || fail "(1) reset did not cut registry"
[ -f "$TAP_HOME/payloads/p1.md" ] && fail "(1) reset did not cut payloads"
echo "reset-unobs: (1) default reset + TMUX + unobservable caller succeeds: ok"

# (2) Polarity: shutdown (keep_self=0) still refuses the same unobservable caller.
seed
set +e
sout="$("$TAP" team shutdown --yes 2>&1)"
src=$?
set -e
[ "$src" = 1 ] || { echo "$sout" >&2; fail "(2) unobservable shutdown should refuse, got rc=$src"; }
grep -Eq 'caller_identity_unobservable|not observable|self-last' <<<"$sout" \
  || { echo "$sout" >&2; fail "(2) shutdown refusal must cite unobservable caller"; }
echo "reset-unobs: (2) shutdown without --keep-self still refuses: ok"

# (3) Mutation-prove: strip the keep_self clause → case (1) must red.
MUT_ROOT="$(mktemp -d)"
mkdir -p "$MUT_ROOT/scripts" "$MUT_ROOT/skills/tap/scripts"
# Minimal tap.sh → skills path: copy what reset needs.
cp -a "$ROOT/scripts/tap.sh" "$MUT_ROOT/scripts/tap.sh"
# scripts/tap.sh now execs bin/tap — copy it the same way scripts/runtime are copied.
cp -a "$ROOT/bin" "$MUT_ROOT/bin"
# Prefer worktree scripts via TAP_SCRIPTS if supported; else symlink tree.
if grep -q 'TAP_SCRIPTS\|skills/tap/scripts' "$ROOT/scripts/tap.sh"; then
  :
fi
cp -a "$ROOT/skills/tap/scripts/." "$MUT_ROOT/skills/tap/scripts/"
# The dispatcher now loads Bun onboarding before its leaf command.
mkdir -p "$MUT_ROOT/runtime/bun"
cp -a "$ROOT/runtime/bun/src" "$MUT_ROOT/runtime/bun/src"
# bin/tap dispatches to runtime/bun/main.ts — copy it too.
cp -a "$ROOT/runtime/bun/main.ts" "$MUT_ROOT/runtime/bun/main.ts"
# fzf-tool.ts statically imports vendor/fzf/manifest.json relative to the repo root.
mkdir -p "$MUT_ROOT/vendor/fzf"
cp -a "$ROOT/vendor/fzf/manifest.json" "$MUT_ROOT/vendor/fzf/manifest.json"
# Point MUT tap at MUT scripts the same way the repo does (relative to repo root).
# Rewrite guard to the pre-fix form (no keep_self consult).
python3 -B - "$MUT_ROOT/runtime/bun/src/team/stop.ts" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
text = p.read_text()
old = "if (!callerPaneId && identity.tmuxActive && !parsed.keepSelf) {"
new = "if (!callerPaneId && identity.tmuxActive) {"
if old not in text:
    raise SystemExit("mutation target missing — guard shape changed")
p.write_text(text.replace(old, new, 1))
PY
seed
set +e
mout="$(cd "$MUT_ROOT" && TAP_HOME="$TAP_HOME" TAP_SCRATCH_ONLY="$TAP_SCRATCH_ONLY" \
  TAP_SESSION_MANIFEST="$TAP_SESSION_MANIFEST" TMUX="$TMUX" FAKE_CALLER_TTY="?" \
  PATH="$PATH" bash scripts/tap.sh team reset --yes --allow-nonstandard-bus-path 2>&1)"
mrc=$?
set -e
[ "$mrc" != 0 ] || { echo "$mout" >&2; fail "(3) MUTATION DID NOT RED — stripped keep_self gate still allowed reset"; }
grep -Eq 'caller_identity_unobservable|not observable|self-last' <<<"$mout" \
  || { echo "$mout" >&2; fail "(3) mutated refusal should cite unobservable/self-last"; }
echo "reset-unobs: (3) mutation (strip keep_self gate) reds: ok"

echo "reset-keep-self-unobservable: ok"
