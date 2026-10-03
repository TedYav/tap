#!/usr/bin/env bash
# focused-inventory: tree (tap-z5nl6)
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

# rm-command-shape inventory (tap-9hwl7): mechanical sweeper enforcing the
# 2026-09-18 rm-writing rule: every `rm` must be its own short command with a
# literal or `${VAR:?}`-guarded absolute path, never buried in a heredoc, a
# loop, or a pipeline, and never keyed on an unguarded variable path.
#
# It walks BOTH suite buckets — skills/tap/scripts/smoke/*.test.sh and
# skills/tap/scripts/regress/*.test.sh — because a repo-wide sweeper that
# scans only one bucket silently un-sanctions fixtures moved to the other.
#
# Shapes detected (one canonical hit per file|shape|line-content hash):
#   varfirst — `rm -rf|-fr|-r|-f` whose first path operand starts with an
#              unbraced `$VAR`/`$1` or an unguarded `${VAR}` (with any `/...`
#              suffix).
#   relative — the same commands whose first path operand is neither a
#              literal absolute path nor a `${VAR:?}`-guarded expansion.
#              Those two forms are the complete green-path allowlist.
#   heredoc  — any command word `rm` inside a heredoc body.
#   loop     — any command word `rm` on a line with a `for`/`while` token.
#   pipe     — any command word `rm` on a line carrying one or more single
#              `|` operators (`||` excluded).
#
# ACCEPTANCE EXEMPTION (stated reason, per the acceptance clause): the live
# tree carries 806 legacy hits (682 variable-first paths, 110 rm inside
# fixture-script heredocs, 11 relative paths, 3 pipeline lines) across 437
# pre-existing files
# at freeze time. Mass-editing them is out of scope for tap-9hwl7, so
# the legacy offender multiset is frozen as a RATCHET: the baseline file
# beside this test lists one "path|shape|sha256(line)" key per frozen
# occurrence. A key that is absent from the baseline, or occurs more often
# than frozen, reds with only the new offenders printed; a same-total swap
# (one legacy line deleted, one new offender added) therefore still reds.
# A key below its frozen count passes and reports the headroom, so deleting
# an rm line never fails a gate. Zero legacy hits remains allowed as the
# clean end state. Line numbers are excluded so unrelated line movement does
# not churn it.
#
# SELF-POLICING: this file lives in the walked smoke bucket and is scanned
# with the rest. Its fixtures are assembled from base64 constants rather
# than written as literal shell (a literal violating fixture here would be
# mistaken for executable shell by its own scan), so the live check below
# finding no new key is also the proof that this file itself carries none
# of the shapes. The one `rm` in this file's cleanup function
# is the sanctioned guarded form.
#
# Lower the freeze after legacy lines are fixed or deleted (optional; a
# stale-high baseline only leaves headroom unused). Rows for files that stay
# private belong in the sibling .private.txt overlay (loaded when present;
# denied to the public export):
#   python3 <the embedded scanner> "$ROOT" list \
#     "$ROOT"/skills/*/scripts/smoke "$ROOT"/skills/*/scripts/regress \
#     > skills/tap/scripts/smoke/rm-command-shape-inventory.baseline.txt
# Never regenerate to admit a NEW offender; guard it with ${VAR:?} instead.
#
# Known mechanical limits (kept intentionally simple, stdlib only): the
# scanner is a small shell lexer, not a complete parser. It joins backslash
# continuations and tracks command boundaries, quotes, comments, and heredocs;
# a multi-line loop body whose command line lacks a `for`/`while` token is not
# classified as a loop shape, and backtick substitutions are not expanded.

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

ok=0
bad=0
fail() { echo "rm-command-shape-inventory: FAIL $1" >&2; bad=$((bad + 1)); }
pass() { echo "rm-command-shape-inventory: ($1) $2"; ok=$((ok + 1)); }

cat > "$WORK/scan.py" <<'PY_SRC'
import hashlib
import re
import sys
from collections import Counter
from pathlib import Path

TARGET = "r" "m"
FLAGS = {"-r", "-f", "-rf", "-fr"}
HEREDOC_OPEN = re.compile(
    r"(?<!<)<<-?[ \t]*(?:'([^']+)'|\"([^\"]+)\"|([^ \t;&|()<>]+))"
)
UNBRACED = re.compile(r"^\$[A-Za-z_0-9@*#?]")
OUTER_GUARD = re.compile(
    r"^(?:!?[A-Za-z_][A-Za-z0-9_]*(?:\[[^]]+\])?|[0-9]+|[@*#?$!_-]):\?"
)
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
COMMAND_PREFIX = {"if", "then", "elif", "while", "until", "do", "else", "time", "!",
                  "command", "builtin", "exec", "env", "nohup"}


def lexical(line):
    """Return shell-ish tokens, an operator skeleton, and heredoc openers."""
    toks = []
    cur = []
    skeleton = []
    heredocs = []
    i, n = 0, len(line)
    quote = None
    while i < n:
        c = line[i]
        if quote is not None:
            if c == quote:
                quote = None
            else:
                cur.append(c)
            i += 1
            continue
        if c in "\"'":
            quote = c
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            cur.append(line[i + 1])
            # The escaped character is literal text, not an operator: keep
            # only the backslash in the operator-counting skeleton so an
            # escaped `|` is never counted as a pipeline stage.
            skeleton.append(c)
            i += 2
            continue
        if c == "#" and not cur:
            break
        if c == "<" and not line.startswith("<<<", i):
            match = HEREDOC_OPEN.match(line, i)
            if match:
                heredocs.append(next(group for group in match.groups() if group is not None))
        if c in "|;&()":
            if cur:
                toks.append("".join(cur))
                cur = []
            toks.append(c)
            skeleton.append(c)
            i += 1
            continue
        if c in " \t":
            if cur:
                toks.append("".join(cur))
                cur = []
            skeleton.append(c)
            i += 1
            continue
        cur.append(c)
        skeleton.append(c)
        i += 1
    if cur:
        toks.append("".join(cur))
    return toks, "".join(skeleton), heredocs


def command_word(tok):
    if tok.startswith("$("):
        tok = tok[2:]
    return tok == TARGET


def outer_parameter(tok):
    if not tok.startswith("${"):
        return None
    depth = 0
    i = 2
    while i < len(tok):
        if tok.startswith("${", i):
            depth += 1
            i += 2
            continue
        if tok[i] == "}":
            if depth == 0:
                return tok[2:i]
            depth -= 1
        i += 1
    return None


def target_shape(tok):
    if tok.startswith("/"):
        return None
    if UNBRACED.match(tok):
        return "varfirst"
    outer = outer_parameter(tok)
    if outer is not None:
        return None if OUTER_GUARD.match(outer) else "varfirst"
    return "relative"


def command_indices(toks):
    """Locate command words while excluding arguments and array data."""
    found = []
    expect_command = True
    array_depth = 0
    i = 0
    while i < len(toks):
        tok = toks[i]
        if array_depth:
            if tok == "(":
                array_depth += 1
            elif tok == ")":
                array_depth -= 1
            i += 1
            continue
        if expect_command:
            if ASSIGN.match(tok) and i + 1 < len(toks) and toks[i + 1] == "(":
                array_depth = 1
                i += 2
                continue
            if ASSIGN.match(tok):
                i += 1
                continue
            if tok in COMMAND_PREFIX:
                i += 1
                continue
            if command_word(tok):
                found.append(i)
            expect_command = False
        if tok in {";", "|", "&", "(", ")"}:
            expect_command = True
        i += 1
    return found


def first_cleanup_target(toks, command_index):
    j = command_index + 1
    saw_cleanup_flag = False
    while j < len(toks):
        tok = toks[j]
        if tok == "--":
            j += 1
            break
        if tok == "-" or not tok.startswith("-"):
            break
        if tok in FLAGS or tok in {"--recursive", "--force"}:
            saw_cleanup_flag = True
        j += 1
    if not saw_cleanup_flag or j >= len(toks):
        return None
    return toks[j]


def continued(raw):
    count = 0
    for char in reversed(raw):
        if char != "\\":
            break
        count += 1
    return count % 2 == 1


def scan(paths):
    hits = []
    counted = 0
    for p in paths:
        path = Path(p)
        files = sorted(path.rglob("*.test.sh")) if path.is_dir() else [path]
        for f in files:
            counted += 1
            delims = []
            in_body = False
            lines = f.read_text(errors="replace").splitlines()
            index = 0
            while index < len(lines):
                n = index + 1
                raw = lines[index]
                if not in_body:
                    while continued(raw) and index + 1 < len(lines):
                        raw = raw[:-1] + " " + lines[index + 1].lstrip()
                        index += 1
                stripped = raw.strip()
                if in_body:
                    # Heredoc bodies scan deliberately raw: fixture text is
                    # data, but it is exactly the burial the shape forbids.
                    if stripped == delims[0]:
                        delims.pop(0)
                        in_body = bool(delims)
                    else:
                        body_toks, _, _ = lexical(raw)
                        if command_indices(body_toks):
                            hits.append((str(f), n, "heredoc", raw))
                    index += 1
                    continue
                toks, skeleton, opened = lexical(raw)
                delims.extend(opened)
                if delims:
                    in_body = True
                rm_indices = command_indices(toks)
                for command_index in rm_indices:
                    target = first_cleanup_target(toks, command_index)
                    if target is None:
                        continue
                    shape = target_shape(target)
                    if shape is not None:
                        hits.append((str(f), n, shape, raw))
                if rm_indices and any(t in ("for", "while") for t in toks):
                    hits.append((str(f), n, "loop", raw))
                if rm_indices and skeleton.replace("||", "").count("|") >= 1:
                    hits.append((str(f), n, "pipe", raw))
                index += 1
    return counted, hits


def canonical(anchor, hits):
    canon = Counter()
    for f, n, shape, raw in hits:
        rel = str(Path(f).relative_to(anchor))
        canon[f"{rel}|{shape}|{hashlib.sha256(raw.encode()).hexdigest()}"] += 1
    return canon


def check(anchor, baseline_path, paths):
    # Per-key ratchet: a key absent from the baseline, or present more often
    # than frozen, is new and fails. A key below its frozen count passes and
    # is reported as headroom. An unreadable or empty baseline is refused
    # (exit 2) so a broken instrument never licenses a pass.
    try:
        with open(baseline_path, encoding="utf-8") as fh:
            frozen = Counter(line.rstrip("\n") for line in fh if line.strip())
    except OSError as exc:
        print(f"baseline unreadable: {exc}", file=sys.stderr)
        return 2
    if not frozen:
        print(f"baseline empty: {baseline_path}", file=sys.stderr)
        return 2
    # Private-only rows live in a sibling overlay naming files that stay
    # private, so those rows ship nowhere. Present in the private tree,
    # absent from the public candidate; absence is normal.
    overlay_path = Path(str(baseline_path).replace(".baseline.txt", ".private.txt", 1))
    if str(overlay_path) != str(baseline_path) and overlay_path.exists():
        try:
            with open(overlay_path, encoding="utf-8") as fh:
                frozen.update(line.rstrip("\n") for line in fh if line.strip())
        except OSError as exc:
            print(f"overlay unreadable: {exc}", file=sys.stderr)
            return 2
    counted, hits = scan(paths)
    if counted == 0:
        print("scan walked zero files", file=sys.stderr)
        return 2
    live = canonical(anchor, hits)
    new = 0
    for key in sorted(live):
        if key not in frozen:
            print(f"new {key}")
            new += live[key]
        elif live[key] > frozen[key]:
            print(f"grown {key} live={live[key]} frozen={frozen[key]}")
            new += live[key] - frozen[key]
    below = sum(max(0, frozen[k] - live.get(k, 0)) for k in frozen)
    print(f"hits {sum(live.values())}")
    print(f"frozen {sum(frozen.values())}")
    print(f"new-count {new}")
    print(f"below {below}")
    return 1 if new else 0


def main():
    anchor = Path(sys.argv[1])
    mode = sys.argv[2]
    if mode == "check":
        return check(anchor, sys.argv[3], sys.argv[4:])
    counted, hits = scan(sys.argv[3:])
    canon = canonical(anchor, hits)
    if mode == "list":
        for k in sorted(canon):
            for _ in range(canon[k]):
                print(k)
        return 0
    # digest: sha256 over the sorted "<count> <sha256(canonical)>" multiset,
    # with the total hit count beside it; occurrence counts are inside the
    # digest input, so an added duplicate line alters the digest.
    frozen_input = "".join(f"{canon[k]} {hashlib.sha256(k.encode()).hexdigest()}\n" for k in sorted(canon))
    print(f"files {counted}")
    print(f"hits {sum(canon.values())}")
    print(f"digest {hashlib.sha256(frozen_input.encode()).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY_SRC

# The FROZEN_HITS history below predates the per-key baseline file, which
# replaced the single digest after the launcher cohort deletion (627 frozen keys at a74809ef7).
# FROZEN_HITS 808 = 806 + 4 heredoc-embedded fixture removals (self-wake-submit:99;
# draft-submit-boundary mock-tmux generator at 103/138/155) - 1 legacy hit from the identity-gate change
# removed - 1 varfirst hit removed. The prior 809's varfirst canonical key
# self.test.sh|varfirst|0c7d04a7006e1b6c4bcd8e1b172fdd2d9cace1dc0686843cd3e11665f9917523
# (the (c6) clear-receipt test's `rm -f "$FAKE_TMUX_STATE/input"
# "$FAKE_TMUX_STATE/send-log" "$FAKE_TMUX_STATE/enter-log"` cleanup line) had two
# occurrences; a later change deleted that whole (c6) test block from self.test.sh,
# removing one occurrence and leaving one duplicate elsewhere in the same file --
# the canonical key survives, its occurrence count drops by one, and the digest
# input changes accordingly. self-wake-submit.test.sh:99 is unrelated and unchanged.
# The ratchet moves only for hits the scanner cannot distinguish from the already
# tolerated heredoc class; var-first removals outside heredocs do not justify a bump.
#
# FROZEN_HITS 807 = 808 - 1: the change ("Close tap read on native Bun and retire its
# Bash body", d835b7d8e) deleted `rm -f "$target"` from
# skills/tap/scripts/smoke/read-verb.test.sh as part of retiring the old Bash
# tap-read.sh body it exercised. One legacy varfirst hit removed, no offenders added.
#
# FROZEN_HITS 808 = 807 + 1: a seat-state change (busy-footer arm, dbe9a404e) added a
# third `rm -f "$CORPUS/../.cbf-mention.txt"` failure-arm line to
# skills/tap/scripts/smoke/claude-busy-footer.test.sh, moving that file's varfirst
# multiset from one canonical key to two (+1 hit). The two new smokes
# (register-adopt-sweep-bound, strand-scan-failure) contribute zero hits: their
# cleanups are separate short ${VAR:?}-guarded rm commands.
#
# FROZEN_HITS 749 = 808 - 59: pure deletions, no offender added or changed.
# Three same-night PRs retired whole retired-subsystem test files along with
# their legacy cleanup fixtures: the change ("Move Goalie supervision to native
# Bun", 34038c74e) deleted goalie-lease-adapter.test.sh,
# goalie-quorum-staleness.test.sh, goalie-sensor-truth.test.sh; "Retire the
# unused lane custody overlay" (e2d74320b) deleted lane-choreography.test.sh,
# lane-worktree.test.sh, lane-emit-body-file.test.sh; "Retire the optional
# native delivery adapters" (12bb5f61e) deleted ccnative-door-fingerprint.test.sh,
# agy-driver-conformance.test.sh, agy-linux-boundary.test.sh,
# ccnative-config-root-routing.test.sh, ccnative-drain-crossing.test.sh,
# ccnative-driver.test.sh, ccnative-e2e-router.test.sh, door-version-guard.test.sh.
# Each deleted file's own legacy `rm` cleanup lines (varfirst/heredoc/etc.)
# leave the multiset with it; nothing survives to re-offend.
#
# FROZEN_HITS 748 = 749 - 1: the same orphaned change's own
# goalie-working-zero.test.sh left an unguarded `rm -f "$WAKE_PROBE"` varfirst
# cleanup (review finding). Guarded to `rm -f "${WAKE_PROBE:?}"`
# rather than frozen in; that is the one hit this ratchet removes. Confirmed
# via the embedded scanner run standalone against the current tree, matching
# CI's gate-run live count exactly (hits=748).
#
# FROZEN_HITS 746 = 748 - 2: the change ("Run team refresh without embedded
# Python children") rewrote team-refresh-parity.test.sh's fixture to stop
# spawning Python children, removing the two varfirst `rm` cleanup lines
# that guarded their tempdirs. Pure deletion, no offender added or changed
# — confirmed via `scan.py list` diffed against f367dd877, the two removed
# hits are both `team-refresh-parity.test.sh|varfirst|...`.
#
# FROZEN_HITS 745 = 746 - 1: the change ("Port tap cancel to native Bun") added
# four new unguarded `rm -f/-rf "$FOREIGN_REG"`/`"$hung"` lines to
# cancel-absent-registry.test.sh's new arms (6/7/8) alongside its
# pre-existing, already-frozen `rm -f "$FOREIGN_REG"` (arm 1). All five were
# guarded to `${VAR:?}` — both variables are literal `mktemp -d` paths —
# rather than freezing the four new ones in. That also cures the one
# pre-existing legacy hit at arm 1, netting -1 against the frozen count.
# Confirmed via the embedded scanner run standalone against the fixed tree.
#
# FROZEN_HITS 661 = 745 - 84: the R5 team-stop native-port migration deleted
# crew-late-collection.test.sh outright and trimmed team-only-driven.test.sh
# by ~2500 lines as their bash bodies moved to runtime/bun/src/team/stop*.ts.
# Pure deletion, no offender added or changed — confirmed via `scan.py list`
# diffed between this migration's parent (9e950a3bb) and its tip: all 84
# removed hits are in those two files, zero new hits anywhere (the migration's
# new/changed bash files — reset-stop-receipt-shape.test.sh, tap-team.sh,
# tap-team-reset.sh, team-stop-watch-lease.test.sh — are all clean).
# FROZEN_HITS 660 = 661 - 1: the register-verb native-port migration deleted
# agy-ls-descriptor.test.sh outright (its lone varfirst hit went with it).
# Pure deletion, no offender added or changed — confirmed via `scan.py list`
# diffed between this migration's parent (8b5983df1145) and its tip: the one
# removed hit is exactly that file, zero new hits anywhere (the migration's
# new files — register-authority.ts, verbs/register.ts — are Bun, outside
# this scanner's bash-only scope).
# FROZEN_HITS stays 660: R2's valid numeric pane-id repair changed one
# draft-submit-boundary heredoc line containing the same guarded cleanup.
# That cleanup is now a short standalone command. Only its line hash changes;
# restoring the prior canonical key reproduces the old frozen digest exactly.
# FROZEN_HITS 643 = 660 - 17: the change ("Move team reset and restore into Bun")
# deleted five regress/smoke fixtures outright — reset-component-authority.test.sh
# (3 varfirst), reset-fence-identity.test.sh (1 relative, 1 varfirst),
# reset-clear-fence-classified.test.sh (2 varfirst), reset-fence-release-contract.test.sh
# (6 relative, 2 varfirst) — 17 hits total. Pure deletion, no offender added or
# changed — confirmed via `scan.py list` diffed between this migration's parent
# (a88beb1d1287) and its tip: exactly those 17 lines drop out, zero new hits
# anywhere (the migration's new files — team/reset.ts, team/restore.ts,
# team/reset-components.ts — are Bun, outside this scanner's bash-only scope).
# FROZEN_HITS 641 = 643 - 2: PR B retires the roster-row-arity-controls
# cleanup and the Python detach-race interposition cleanup in team-only-driven.
# Comparing the canonical lists against 922c883721fd9402cccd39f3cb5e212c24370ef0
# proves these two deletions, with no added or changed offender.
# FROZEN_HITS 639 = 641 - 2: the change ("Move live spool drain orchestration to Bun")
# deleted two courier-digest varfirst lines; its one new bun-router arm.json
# removal now uses the sanctioned `${WORK:?}` guard instead of being frozen in.
# Comparing the canonical lists against c4723c0ad proves the two deletions,
# with no added or changed offender.
# FROZEN_HITS 634 = 639 - 5: the change ("Remove the unreachable non-tmux
# delivery-driver framework") deleted three driver-conformance and two
# driver-disposition-routing varfirst lines. Its one new driver-conformance
# config.toml removal now uses the sanctioned `${XDG_CONFIG_HOME:?}` guard
# instead of being frozen in. Comparing the canonical lists against 5a7bb3265
# proves the five deletions, with no added or changed offender.
# FROZEN_HITS 627 = 634 - 7: the change ("Delete dead launcher.py scan cohort,
# orphan CLI doors and retired flags") removed the broken Python ladder arms
# of regress/reset-fence-mutation-barrier.test.sh, taking seven varfirst
# lines with them. Comparing the canonical lists against ad48debc4 proves
# the seven deletions, with no added or changed offender.
BASELINE="$ROOT/skills/tap/scripts/smoke/rm-command-shape-inventory.baseline.txt"
REGEN="python3 <scanner> \"\$ROOT\" list <smoke+regress dirs> > ${BASELINE#"$ROOT"/}"
VIOLATE_B64='IyEvdXNyL2Jpbi9lbnYgYmFzaApybSAtcmYgIiRXT1JLL3N1YiIKcm0gLWZyICIke1RNUH0veCIKcm0gLXIgIiQxIgpybSAtZiAiJFRXRUxWRSIKcm0gLXJmICRXT1JLL3VucXVvdGVkCnJtIC1yZiAtLSAiJFZBUkRFRVAveCIKcm0gLXJmIC12ICIkVkVSQk9TRS94IgpybSAtcmYgIiR7V09SSyUke1NVRkZJWDo/fX0iCnJtIC1yZiBcCiAgIiRDT05USU5VRUQveCIKY2F0IDw8J1NDUklQVC1CT0RZJwpybSAtZiAiJHN0YXRlL2lucHV0IgpTQ1JJUFQtQk9EWQpjYXQgPDwxMjMKcm0gLWYgIiRzdGF0ZS9vdGhlciIKMTIzCmZvciBmIGluIGEgYjsgZG8gcm0gLXJmICIkZiI7IGRvbmUKd2hpbGUgZmFsc2U7IGRvIHJtIC1yZiAiJGFnYWluIjsgZG9uZQpwcmludGYgeCB8IHJtIC1mIC0KcHJpbnRmIHh8Y2F0fHJtIC1mIC0Kcm0gLXJmIC4vcmVsYXRpdmUvcGF0aApybSAtZiBjYWNoZS50eHQK'
GUARDED_B64='IyEvdXNyL2Jpbi9lbnYgYmFzaApybSAtcmYgIiR7V09SSzo/fS9jYWNoZSIKcm0gLWYgIiR7U1RBVEU6P30vbG9jayIKcm0gLXJmIC90bXAvbGl0ZXJhbC1wYXRoCnJtIC1mIC9hYnNvbHV0ZS9saXRlcmFsL2ZpbGUudHh0CnJtIC1yZiAtLSAiJHtXT1JLOj99L3giCnJtIC1yZiAtdiAiJHtXT1JLOj99L3ZlcmJvc2UiCiMgcm0gLXJmICROT1RfUkVBTCBmb3Igc3VyZSBpbiBhIGNvbW1lbnQKcHJpbnRmIHggfCBncmVwIHkKZXhwZWN0ZWQ9KHJtIC1yZiAiJFdPUksiKQpwcmludGYgJyVzXG4nICc8PFNDUklQVC1CT0RZJwpwcmludGYgJyVzXG4nIHJtIC1yZiAiJFdPUksiCnJtIC1yZiAiJHtXT1JLOj8ke1NVRkZJWDo/fX0iCg=='
ANCHOR='rm -f "${TAP_HOME:?}/payloads/${pane_only_id:?}.md"'
SMOKE_DIRS=( "$ROOT"/skills/*/scripts/smoke )
REGRESS_DIRS=( "$ROOT"/skills/*/scripts/regress )

smoke_bucket="$(python3 "$WORK/scan.py" "$ROOT" digest "${SMOKE_DIRS[@]}" | sed -n 's/^files //p')"
regress_bucket="$(python3 "$WORK/scan.py" "$ROOT" digest "${REGRESS_DIRS[@]}" | sed -n 's/^files //p')"
if [ "${smoke_bucket:-0}" -ge 1 ] && [ "${regress_bucket:-0}" -ge 1 ]; then
  pass "5" "scan enumerates both buckets: smoke=$smoke_bucket regress=$regress_bucket files"
else
  fail "5: scan enumerated smoke=$smoke_bucket regress=$regress_bucket — both buckets must be walked"
fi

check_rc=0
python3 "$WORK/scan.py" "$ROOT" check "$BASELINE" "${SMOKE_DIRS[@]}" "${REGRESS_DIRS[@]}" \
  > "$WORK/check.out" 2> "$WORK/check.err" || check_rc=$?
live_hits="$(sed -n 's/^hits //p' "$WORK/check.out")"
live_below="$(sed -n 's/^below //p' "$WORK/check.out")"
if [ "$check_rc" -eq 0 ] && [ -n "$live_hits" ] && [ -n "$live_below" ]; then
  if [ "$live_hits" -eq 0 ]; then
    pass "3" "live tree: zero legacy rm-shape hits — clean end state reached"
  elif [ "$live_below" -gt 0 ]; then
    pass "3" "live tree: $live_hits rm-shape hits, zero new; $live_below below freeze; lower the freeze at your convenience: $REGEN"
  else
    pass "3" "live tree: $live_hits rm-shape hits, all within the frozen legacy multiset, zero new"
  fi
elif [ "$check_rc" -eq 1 ]; then
  { echo "rm-command-shape-inventory: FAIL 3: new rm-shape offenders beyond the frozen baseline (use a literal or \${VAR:?}-guarded path):"
    grep -E '^(new|grown) ' "$WORK/check.out"; } >&2
  bad=$((bad + 1))
else
  { echo "rm-command-shape-inventory: FAIL 3: ratchet check could not run (rc=$check_rc):"
    cat "$WORK/check.err" "$WORK/check.out"; } >&2
  bad=$((bad + 1))
fi

mkdir "$WORK/fx"
python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))' "$VIOLATE_B64" > "$WORK/fx/fx-violate.test.sh"
python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))' "$GUARDED_B64" > "$WORK/fx/fx-guarded.test.sh"

fx_rc=0
python3 "$WORK/scan.py" "$WORK/fx" check "$BASELINE" "$WORK/fx/fx-violate.test.sh" > "$WORK/fx.out" 2>&1 || fx_rc=$?
fx_hits="$(sed -n 's/^hits //p' "$WORK/fx.out")"
fx_new="$(sed -n 's/^new-count //p' "$WORK/fx.out")"
fx_shapes="$(python3 "$WORK/scan.py" "$WORK/fx" list "$WORK/fx/fx-violate.test.sh" | cut -d'|' -f2 | sort | uniq -c | tr '\n' ' ')"
# "Reds" = every fixture hit is new against the real baseline, so the ratchet
# refuses (rc 1) with this fixture's shapes as offenders.
if [ "$fx_rc" -eq 1 ] && [ "${fx_hits:-0}" -eq 21 ] && [ "${fx_new:-0}" -eq 21 ] \
  && [ "$fx_shapes" = "   2 heredoc    2 loop    2 pipe    4 relative   11 varfirst " ]; then
  pass "1" "violating fixture reds the ratchet for every shape: $fx_shapes"
else
  { echo "rm-command-shape-inventory: FAIL 1: fixture red mismatch (hits=${fx_hits:-?} shapes=${fx_shapes})"; } >&2
  bad=$((bad + 1))
fi

guarded_hits="$(python3 "$WORK/scan.py" "$WORK/fx" digest "$WORK/fx/fx-guarded.test.sh" | sed -n 's/^hits //p')"
if [ "${guarded_hits:--1}" -eq 0 ]; then
  pass "2" "guarded/literal controls pass: 0 hits"
else
  fail "2: guarded fixture flagged: hits=$guarded_hits"
fi

# (6) Ratchet control over synthetic baselines built from the violating
# fixture's own list: removal passes, a same-total swap and a grown key fail,
# and a missing or empty baseline is refused rather than read as zero new.
ratchet() { # <baseline> -> prints "rc new-count below"
  local rc=0
  python3 "$WORK/scan.py" "$WORK/fx" check "$1" "$WORK/fx/fx-violate.test.sh" > "$WORK/r6.out" 2>&1 || rc=$?
  printf '%s %s %s' "$rc" "$(sed -n 's/^new-count //p' "$WORK/r6.out")" "$(sed -n 's/^below //p' "$WORK/r6.out")"
}
python3 "$WORK/scan.py" "$WORK/fx" list "$WORK/fx/fx-violate.test.sh" > "$WORK/b-exact"
{ cat "$WORK/b-exact"; echo "gone.test.sh|varfirst|0000"; } > "$WORK/b-removed"
{ sed 1d "$WORK/b-exact"; echo "gone.test.sh|varfirst|0000"; } > "$WORK/b-swap"
sed 1d "$WORK/b-exact" > "$WORK/b-grown"
: > "$WORK/b-empty"
r_exact="$(ratchet "$WORK/b-exact")"; r_removed="$(ratchet "$WORK/b-removed")"
r_swap="$(ratchet "$WORK/b-swap")"; r_grown="$(ratchet "$WORK/b-grown")"
r_empty="$(ratchet "$WORK/b-empty")"; r_missing="$(ratchet "$WORK/b-absent")"
if [ "$r_exact" = "0 0 0" ] && [ "$r_removed" = "0 0 1" ] && [ "$r_swap" = "1 1 1" ] \
  && [ "$r_grown" = "1 1 0" ] && [ "${r_empty%% *}" = 2 ] && [ "${r_missing%% *}" = 2 ]; then
  pass "6" "ratchet: removal passes below freeze; same-total swap and grown key red; empty/missing baseline refused"
else
  fail "6: ratchet control mismatch (exact=$r_exact removed=$r_removed swap=$r_swap grown=$r_grown empty=$r_empty missing=$r_missing)"
fi

LIVE_TARGET="$ROOT/skills/tap/scripts/regress/nudge-submit-verify.test.sh"
MUT_ROOT="$WORK/mutation"
MUT_TARGET="$MUT_ROOT/skills/tap/scripts/regress/nudge-submit-verify.test.sh"
mkdir -p "$(dirname "$MUT_TARGET")"
cp "$LIVE_TARGET" "$MUT_TARGET"
anchor_count="$( (grep -F "$ANCHOR" "$MUT_TARGET" | wc -l | tr -d ' ') || true )"
if [ "$anchor_count" -eq 1 ]; then
  pass "4a" "mutation anchor occurs exactly once in the corpus"
else
  fail "4a: mutation anchor occurs ${anchor_count:-?} times, expected 1"
fi
mut_rc=0
python3 - "$MUT_TARGET" "$ANCHOR" > "$WORK/mut.err" 2>&1 <<'MUT_SRC' || mut_rc=$?
import sys

path, anchor = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = fh.read()
if data.count(anchor) != 1:
    sys.exit("anchor not unique in the copied corpus")
with open(path, "w", encoding="utf-8") as fh:
    fh.write(data.replace(anchor, anchor.replace(":?", "", 1), 1))
MUT_SRC
if [ "$mut_rc" -ne 0 ] || [ -s "$WORK/mut.err" ]; then
  fail "4b: mutation failed: $(cat "$WORK/mut.err")"
else
  python3 "$WORK/scan.py" "$ROOT" list "$LIVE_TARGET" > "$WORK/live.list"
  python3 "$WORK/scan.py" "$MUT_ROOT" list "$MUT_TARGET" > "$WORK/mut.list"
  diff "$WORK/live.list" "$WORK/mut.list" > "$WORK/mut.diff" 2>/dev/null || true
  added="$(grep -c '^>' "$WORK/mut.diff" || true)"
  removed="$(grep -c '^<' "$WORK/mut.diff" || true)"
  anchor_new="$(grep -c '^> skills/tap/scripts/regress/nudge-submit-verify.test.sh|varfirst|' "$WORK/mut.diff" || true)"
  if [ "${added:-0}" -eq 1 ] && [ "${removed:-0}" -eq 0 ] && [ "$anchor_new" -eq 1 ]; then
    pass "4c" "removing :? from the guarded rm turns the scan red with exactly one new varfirst hit"
  else
    { echo "rm-command-shape-inventory: FAIL 4c: mutated corpus not red as expected (added=${added:-?} removed=${removed:-?} anchor=$anchor_new)"; cat "$WORK/mut.diff"; } >&2
    bad=$((bad + 1))
  fi
fi

echo "rm-command-shape-inventory: ok=$ok bad=$bad"
[ "$bad" -eq 0 ]
