#!/usr/bin/env bash
# Defaults for smoke processes that resolve machine-wide state. TAP_INDEX_HOME,
# TAP_SESSION_MANIFEST, OPENCODE_DB_PATH and TAP_LOCK_DIR are pinned when unset OR
# EMPTY: their consumers read empty as unset and fall back to the real HOME
# (tap-zwh1). TAP_VERSION_SEEN_PATH is unset-only: its consumer (`??`) takes an
# empty path literally and has no HOME fallback, so empty is not a leak there.

# Same credential boundary as the Bun runner; fixtures opt in after sourcing.
. "$(dirname "${BASH_SOURCE[0]}")/../../../../scripts/test-secret-env.sh" || exit 1

tap_smoke_known_defect() {
  local bead="${1:-}" date="${2:-}" description="${3:-}" extra="${4:-}"
  if [[ ! "$bead" =~ ^tap-[a-z0-9]{5,}$ ]] \
    || [[ ! "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
    || [ -z "$description" ] || [ -n "$extra" ]; then
    echo "tap smoke: known-defect needs tap-xxxxx YYYY-MM-DD description" >&2
    return 64
  fi
  case "$description" in
    *$'\t'*|*$'\n'*) echo "tap smoke: known-defect description must be one TSV field" >&2; return 64 ;;
  esac
  printf 'KNOWN-DEFECT\t%s\t%s\t%s\n' "$bead" "$date" "$description"
}

# tap-fuz9: TMUX outranks TMUX_TMPDIR. The suite's env -i worker boundary
# already excludes TMUX/TMUX_PANE; this scrub protects a directly invoked body.
# It does not create a private default socket by itself. Use smoke-all --only
# for runner-equivalent debugging, or pass an explicit private socket to any
# destructive real-tmux call. The gate's load-bearing isolation is its admitted
# per-run TMUX_TMPDIR.
unset TMUX TMUX_PANE
# TAP_CLEAR_ID is inherited by EVERY descendant of a clear-launched harness, for
# the life of that process — so a suite run from a pane that `tap clear` created
# hands its own clear's nonce to every registration a test performs. That is not
# hypothetical: it reds clear-nonce-record.test.sh's absence arm from any cleared
# seat, and cleared seats are now routine (tap-36kb). A test's registrations must
# carry only the nonce the test itself set.
#
# THE COMMENT SHIPPED WITHOUT THIS LINE THE FIRST TIME (review gate) — a six-line
# rationale for a guard that was not there, in the fix FOR an environmental leak.
# Five registering smokes do not source this file at all (in-out-alias,
# register-collision, session-id-capture, init-idempotent, server-epoch-guard);
# none asserts clear_nonce today, so that is latent row pollution rather than a
# red, and it is tracked rather than left as a comment nobody owns.
unset TAP_CLEAR_ID

# register.ts directSessionIdentity and transcript/source capture, plus
# session-store.ts sessionDerive, consume these attribution inputs. The outer
# smoke-all env -i already excludes them; direct bodies need the same boundary.
# Tests may set explicit identities after sourcing, as they do with clear IDs.
# Keep this list aligned with runtime/bun/test/run.sh.
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID OPENCODE_SESSION_ID \
  CURSOR_CONVERSATION_ID ANTIGRAVITY_CONVERSATION_ID \
  TAP_HARNESS_SESSION_ID TAP_TRANSCRIPT_PATH TAP_SESSION_SOURCE
# Launch evidence (launch-evidence.ts): SessionStart binds a row through these,
# so a probe sourced inside a launched seat's pane must not inherit them.
unset TAP_LAUNCH_ROOT TAP_LAUNCH_ID

# A smoke NEVER reaches the real notifier. `tap escalate` invokes notify-user
# DIRECTLY (CONTRACT §Escalation), and notify-user sends an actual notification
# to the operator's PHONE. Five watch smokes drive the best-effort escalate call
# in lib.sh's _watch_notify_human, so an unpinned suite run would text a human
# once per fixture — on every smoke-all, including the merge gate.
#
# That muzzle used to exist by ACCIDENT: escalate resolved a target from
# ~/.tap/escalation.json, the fixtures redirect TAP_INDEX_HOME, so the file was
# absent and the verb exited before doing anything. Retiring the target ladder
# retired the accident with it. This pin makes the protection deliberate and
# located in the same place as the tmux one — in the smoke itself, so it holds
# however the file is invoked, not only under smoke-all's `env -i`.
#
# The default is a path that does NOT exist, so escalate takes its
# notify_user_missing arm and fails LOUD. Fail-safe polarity is the whole point:
# a test that forgot to stub the notifier must break visibly, because the
# opposite mistake is silent, lands on a real person's phone, and no green suite
# would ever reveal it. A smoke that genuinely exercises the notifier points
# this at its own recording stub — opting IN with a path you built is safe.
# UNCONDITIONAL, unlike every other pin in this file (review P1). The
# others are `unset-only` defaults so an operator can point a smoke at real
# state deliberately. This one must not honor an inherited value at all: the
# thing on the other end is a human's phone, and the inheriting process is a
# test. Both inherited forms bypass an unset-only guard — a non-empty
# TAP_NOTIFY_USER_BIN is preserved verbatim, and an empty one is "set" to a
# `+x` test while escalate's own `${TAP_NOTIFY_USER_BIN:-notify-user}` treats it
# as unset and falls through to the REAL notifier.
#
# A smoke that genuinely exercises the notifier sets its own stub AFTER sourcing
# this file (escalate.test.sh does exactly that), which is an explicit in-test
# choice rather than ambient inheritance from whatever shell launched the run.
TAP_NOTIFY_USER_BIN="/nonexistent/tap-smoke-must-stub-notify-user"
export TAP_NOTIFY_USER_BIN

# A smoke is a test child, even when its parent keeps real HOME for an
# authenticated live harness. The episodic-memory SessionStart hook can still
# discover real ~/.claude/projects and ~/.codex/sessions after XDG/TAP output
# roots are redirected. Its internal re-entry guard is plugin-specific (not a
# generic hook sandbox), but pinning it here prevents this test child from
# starting detached sync workers from those real inputs. This is unconditional
# test-child state; normal user sessions never source this file.
EPISODIC_MEMORY_SUMMARIZER_GUARD=1
export EPISODIC_MEMORY_SUMMARIZER_GUARD

# A smoke NEVER reads the operator's launcher config. The launcher resolves harness-level
# environment policy from `${XDG_CONFIG_HOME:-$HOME/.config}/tap/config.toml` on EVERY launch
# and resume, so any smoke that drives a launch inherits whatever the operator has seeded there.
# That coupling is not hypothetical either: the sanctioned rollout for this very feature has the
# operator add `[harness.codex.env]`, and the moment they do, an exact-match assertion on a
# rendered codex invocation gains an env key it never asked for. A typo'd table would likewise
# put a notice on stderr in every launcher-invoking smoke at once.
#
# UNCONDITIONAL, like the notifier pin above and unlike the unset-only defaults below, because
# unset-only is actively WRONG here: with XDG_CONFIG_HOME unset the launcher falls back to
# $HOME/.config, so honoring an inherited empty/unset value would read the real machine — the
# opposite of the protection. Pointing at a private empty directory models the fresh-system
# state (no config, tier 2 empty, no notice), which is the state a smoke should assume unless it
# says otherwise.
#
# A smoke that genuinely exercises config (session-presets) exports its own XDG_CONFIG_HOME
# AFTER sourcing this file — opting IN with a directory you built, the same pattern
# escalate.test.sh uses for the notifier.
# Residue, and why this is NOT a trap. Sourced by ~241 smokes, a per-source mktemp leaves ~241
# empty directories behind per suite run. An EXIT trap here would reap them, but a trap set in a
# SOURCED file silently replaces the sourcing script's own — and one smoke
# (smoke-sandbox-pin-inventory.test.sh) already installs its cleanup trap BEFORE sourcing this
# file, so the trap version would have disarmed the cleanup of the very test that inventories
# these pins. Nesting instead: under smoke-all the runner's sandbox is reaped wholesale, so the
# suite leaves nothing; a hand-run leaves exactly one directory, which is the existing
# precedent in this file rather than a new class of litter.
if [ -n "${TAP_SUITE_SANDBOX:-}" ] && [ -d "${TAP_SUITE_SANDBOX:-}" ]; then
  tap_smoke_xdg_root="$TAP_SUITE_SANDBOX/xdg.$$"
  if ! mkdir -p "$tap_smoke_xdg_root" 2>/dev/null; then
    unset tap_smoke_xdg_root
    exit 1
  fi
elif ! tap_smoke_xdg_root="$(mktemp -d "${TMPDIR:-/tmp}/tap-smoke-xdg.XXXXXX")"; then
  unset tap_smoke_xdg_root
  exit 1
fi
XDG_CONFIG_HOME="$tap_smoke_xdg_root"
export XDG_CONFIG_HOME
# tap-lcuft: CLAUDE_CONFIG_DIR moves the whole Claude config, sessions/ included.
# Unsetting it is not enough here: this carrier may run with the caller's real
# HOME, where `${CLAUDE_CONFIG_DIR:-~/.claude}` resolves to the operator's live
# config. Pin it inside the private config root instead; tests that need a
# specific value set it explicitly after sourcing.
CLAUDE_CONFIG_DIR="$tap_smoke_xdg_root/claude"
export CLAUDE_CONFIG_DIR
unset tap_smoke_xdg_root

if [ -z "${TAP_INDEX_HOME:-}" ] \
  || [ -z "${TAP_SESSION_MANIFEST:-}" ] \
  || [ -z "${OPENCODE_DB_PATH:-}" ] \
  || [ -z "${TAP_VERSION_SEEN_PATH+x}" ] \
  || [ -z "${TAP_LOCK_DIR:-}" ]; then
  if ! tap_smoke_sandbox_root="$(
    mktemp -d "${TMPDIR:-/tmp}/tap-smoke-sandbox.XXXXXX"
  )"; then
    unset tap_smoke_sandbox_root
    # This file is smoke-only. A test that cannot build its private state
    # boundary must stop, even when its caller does not enable errexit.
    exit 1
  fi

  if [ -z "${TAP_INDEX_HOME:-}" ]; then
    TAP_INDEX_HOME="$tap_smoke_sandbox_root/index"
    export TAP_INDEX_HOME
    # Born live (F1): a minted index starts as an empty 0.20 marker, because
    # native verbs refuse an absent one. An inherited index is left as given.
    mkdir -p "$TAP_INDEX_HOME" \
      && printf '{"schema":"0.20","teams":{}}\n' > "$TAP_INDEX_HOME/global-registry.json" \
      || exit 1
  fi
  if [ -z "${TAP_SESSION_MANIFEST:-}" ]; then
    TAP_SESSION_MANIFEST="$tap_smoke_sandbox_root/sessions.json"
    export TAP_SESSION_MANIFEST
  fi
  if [ -z "${OPENCODE_DB_PATH:-}" ]; then
    OPENCODE_DB_PATH="$tap_smoke_sandbox_root/opencode.db"
    export OPENCODE_DB_PATH
  fi
  if [ -z "${TAP_VERSION_SEEN_PATH+x}" ]; then
    TAP_VERSION_SEEN_PATH="$tap_smoke_sandbox_root/version-seen.json"
    export TAP_VERSION_SEEN_PATH
  fi

  # Empty also selects the runtime's HOME fallback; it is not a usable pin.
  if [ -z "${TAP_LOCK_DIR:-}" ]; then
    TAP_LOCK_DIR="$tap_smoke_sandbox_root/locks"
    export TAP_LOCK_DIR
  fi

  unset tap_smoke_sandbox_root
fi
