#!/usr/bin/env bash
# smoke-all.sh — run the full smoke suite with file-level parallelism.
#
# Usage: bash scripts/smoke-all.sh [-j N] [--only <file> | --list <path>]
#   -j N   concurrency (default: min(12, cpu cores); -j 1 = sequential)
#   --only run one shell or Bun test through the same isolation boundary
#   --list run newline-separated repo-relative test paths; emits a subset receipt
# Full runs without a tty require TAP_RUNNER_ALLOW=1 from the caller (including CI).
# Run the gate unpiped: its exit code is authoritative; piped stdout is display-only.
#
# The machine-wide suite slot is advisory. Its launcher records the first run;
# a concurrent ordinary run continues at reduced concurrency. Controlled
# measurement probes still acquire-or-refuse. TAP_SUITE_SLOT=bypass remains a
# loud disaster-recovery escape.
#
# The classic sequential one-liner still runs the same smoke bodies:
#   for s in skills/*/scripts/smoke/*.test.sh; do bash "$s" || exit $?; done
# It does NOT enter the suite's environment boundary. Use `--only <file>` for
# single-file debugging with the same isolation as the gate. Direct destructive
# real-tmux calls still require an explicit private socket.
#
# Every worker has a private HOME, tmux namespace, temporary directory, and pins:
# TAP_INDEX_HOME (born live: an empty 0.20 marker), TAP_SESSION_MANIFEST, OPENCODE_DB_PATH,
# TAP_LOCK_DIR, and TAP_VERSION_SEEN_PATH. The entry owns their parent roots; worker setup
# mints the private descendants. Per-test overrides win. TAP_HOME stays absent
# at the shell boundary, preserving busless controls.
# (isolation audit + measurements: 526s sequential vs ~53s at
# -j 12 on a 12-core machine, zero behavior change to any test).
#
# The sequential one-liner remains a body-level debugging tool, not gate evidence.
#
# Unlike the one-liner (first failure stops the loop), this runs ALL files
# and reports every failure, replaying each failing file's full output.

# --probe <file> [-- args...] is the probe mode behind scripts/probe.sh (tap-7r3fn.161).
# It runs ONE saved tmp/<seat>/ file (.sh, .py or .ts) through the same entry,
# per-file worker roots, tmux guard, session reaping and post-wave predicates as
# --only, with a fresh scratch cwd and TAP_PROBE_CHECKOUT naming the reviewed
# checkout. No suite membership, gate slot, receipt or merge evidence.
# Exit: an isolation or state-predicate failure wins (1); otherwise the probe's own status.

# tap-sdqz: the gate is a reproducible experiment, so the launching shell does
# not get to choose its PATH, locale, terminal mode, harness homes, or test
# feature flags. Keep this list literal: an inherited variable not named here
# cannot cross the entry boundary.
SMOKE_ALL_FIXED_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SMOKE_TMUX_SOCKET_LIMIT=104

# The final green is the evidence reviewers quote. Lead with the checkout
# receipt, then reach the success token, so no canonical line prefix can cite
# success before identity. Keep local base drift on that same line.
# This is observational only: never fetch or mutate refs from the gate.
smoke_gate_receipt() {
  local root="$1" scratch="$2"
  local head head_after tree worktree_state git_observation
  local remote_main merge_base merge_base_status behind overlap path escaped separator
  local branch_raw="$scratch/branch-paths.raw" main_raw="$scratch/main-paths.raw"
  local branch_paths="$scratch/branch-paths" main_paths="$scratch/main-paths"
  local overlap_paths="$scratch/overlap-paths"
  local dirty_paths dirty_line dirty_count dirty_total dirty_sep pinned_head pinned_tree _straddle_reason

  head=""
  if ! head="$(git -C "$root" rev-parse --verify HEAD 2>/dev/null)" || [ -z "$head" ]; then
    # tap-1f45b: an unresolvable HEAD is not missing information
    # when the suite started from a resolvable pin -- it is affirmative evidence
    # the checkout moved under the run. This path returned BEFORE the straddle
    # comparison, so such a run could reach a green receipt reading
    # `head=unavailable`. Record the straddle here, at the earliest exit that
    # can observe it.
    if [ -r "$scratch/start-pin" ]; then
      read -r pinned_head pinned_tree <"$scratch/start-pin" || true
      if [ -n "${pinned_head:-}" ] && [ "$pinned_head" != "unpinnable" ]; then
        printf 'start-head=%s start-tree=%s receipt-head=unresolvable receipt-tree=unresolvable\n' \
          "$pinned_head" "${pinned_tree:-unpinnable}" >"$scratch/straddled"
      fi
    fi
    if [ -e "$root/.git" ]; then
      printf '%s' 'tested-tree=unverified head=unavailable worktree=unknown git-observation=failed; local origin/main unavailable (freshness caller-owned): drift=unknown'
    else
      printf '%s' 'tested-tree=unversioned head=unavailable worktree=unknown; local origin/main unavailable (freshness caller-owned): drift=unknown'
    fi
    return
  fi

  git_observation=""
  if git -C "$root" status --porcelain --untracked-files=all >"$scratch/worktree-status" 2>/dev/null; then
    head_after="$(git -C "$root" rev-parse --verify HEAD 2>/dev/null || true)"
    if [ -z "$head_after" ]; then
      # An empty second read is an observation failure, not an observed move
      # (tap-fxcqb): the two labels stay apart so the receipt says which it is.
      tree="unverified"
      worktree_state="unknown"
      git_observation="head-unavailable"
    elif [ "$head_after" != "$head" ]; then
      tree="unverified"
      worktree_state="unknown"
      git_observation="head-moved"
    elif [ -s "$scratch/worktree-status" ]; then
      tree="uncommitted"
      worktree_state="dirty"
    else
      tree="$(git -C "$root" rev-parse --verify "${head}^{tree}" 2>/dev/null || true)"
      if [ -n "$tree" ]; then
        worktree_state="clean"
      else
        tree="unverified"
        worktree_state="unknown"
        git_observation="failed"
      fi
    fi
  else
    tree="unverified"
    worktree_state="unknown"
    git_observation="failed"
  fi

  # tap-1f45b: a run that STRADDLES two checkouts tested a mixture of both and
  # certifies neither. Compared here rather than at the call site so the check
  # reuses this function's own head observation instead of opening a third
  # rev-parse window between the observation and the comparison.
  #
  # HEAD is the load-bearing comparison: for a clean checkout `tested-tree` is
  # `HEAD^{tree}`, a function of HEAD, so a moved tree cannot hide behind a
  # still HEAD. The tree is compared only when this receipt observed a clean
  # one — a run whose own redirected output dirties the checkout reports
  # `uncommitted`, and comparing that against a start-time hash would redden
  # every such run for a difference the receipt already names as `dirty`.
  #
  # TWO WINDOWS WORTH NAMING, ONE OF THEM STILL OPEN, and naming them matters
  # more than the coverage does, because a detector that reports the wrong
  # answer confidently is worse than the gap it closes:
  #
  #   * DISCOVERY→PIN. The file list is built and preflighted before the pin is
  #     taken. A checkout moving in that window changes WHICH FILES RUN, and the
  #     pin then records the post-move head, so the comparison sees no straddle
  #     and the receipt is clean. Narrow (no workers have started) but real.
  #   * THE RECEIPT'S OWN WINDOW (covered). `head` is read, then `status`, then
  #     `head_after`. The straddle comparison below looks at both samples: a
  #     second read that differs from the first refuses as
  #     `reason=moved-inside-receipt` (alongside `git-observation=head-moved`),
  #     and a second read that fails refuses as `reason=receipt-head-unreadable`
  #     (alongside `git-observation=head-unavailable`, or `failed` when `status`
  #     itself failed). Either way the STRADDLED line fires; an unreadable
  #     re-read is reported as that, not as a move.
  #
  # The DISCOVERY→PIN window is handled by the same upstream rule as the three
  # siblings below: do not write to a worktree while a suite reads it. It is not
  # closed here.
  # THE INVARIANT, stated once so the arms below are derived rather than
  # enumerated: a receipt may be green only if the head the suite STARTED from
  # is the head it ENDED on, and both are resolvable. Any state that cannot
  # establish that -- moved, unresolvable, unborn, orphan -- refuses.
  #
  # Written as an invariant on purpose. The first version
  # enumerated the cases it had thought of and left two: a HEAD that moves
  # between this function's OWN two rev-parse samples, and a HEAD that will not
  # resolve at all. Fixing those two by name would have left the third.
  if [ -r "$scratch/start-pin" ]; then
    read -r pinned_head pinned_tree <"$scratch/start-pin" || true
    _straddle_reason=""
    if [ "${pinned_head:-}" = "unpinnable" ]; then
      # `unpinnable` is an ENDPOINT STATE, not an exemption. The
      # invariant reads "the head the suite STARTED from is the head it ENDED
      # on, and both resolve"; an unborn or orphan start whose finish resolves
      # fails it as squarely as a moved head does -- a commit landed inside the
      # worker window, which is the condition this refusal exists for. Reaching
      # this point already proves the finish resolved, because an unresolvable
      # one returns above. The symmetric case -- unpinnable start, unresolvable
      # finish -- stays silent there: two ends agreeing on "no commit" is the
      # checkout this check has nothing to say about, not a straddle.
      _straddle_reason="unpinnable-start"
    elif [ -n "${pinned_head:-}" ]; then
      # Compare against BOTH samples. `head` is the first reading and
      # `head_after` the second; the existing head-moved observation already
      # proves they can differ, and comparing only the first meant the runner
      # could OBSERVE the move and still emit no straddle -- a detector that
      # sees the condition and discards the observation.
      if [ "$pinned_head" != "$head" ]; then
        _straddle_reason="start!=receipt"
      elif [ -z "${head_after:-}" ]; then
        # No second sample (the read or the `status` before it failed): the
        # checkout could not be re-read, which is not the same as it moving.
        _straddle_reason="receipt-head-unreadable"
      elif [ "$head_after" != "$head" ]; then
        _straddle_reason="moved-inside-receipt"
      elif [ -n "${pinned_tree:-}" ] && [ "$pinned_tree" != "unpinnable" ] \
        && [ "$worktree_state" = "clean" ] && [ "$pinned_tree" != "$tree" ]; then
        _straddle_reason="tree-moved"
      fi
    fi
    if [ -n "$_straddle_reason" ]; then
      printf 'start-head=%s start-tree=%s receipt-head=%s receipt-tree=%s reason=%s\n' \
        "${pinned_head:-unpinnable}" "${pinned_tree:-unpinnable}" "$head" \
        "${tree:-unresolvable}" "$_straddle_reason" >"$scratch/straddled"
    fi
  fi

  printf 'tested-tree=%s head=%s worktree=%s' "$tree" "$head" "$worktree_state"
  if [ "$worktree_state" = "dirty" ]; then
    # "dirty" alone sends the reader to `git status`; naming the paths ends
    # the investigation in one line (tap-8sez) — a run's own captured output
    # file landing in the tree it just tested is the common case this catches.
    dirty_total="$(wc -l <"$scratch/worktree-status" | tr -d ' ')"
    dirty_paths="[" dirty_sep="" dirty_count=0
    while IFS= read -r dirty_line && [ "$dirty_count" -lt 5 ]; do
      path="${dirty_line:3}"
      escaped="${path//\\/\\\\}"
      escaped="${escaped//\"/\\\"}"
      dirty_paths="${dirty_paths}${dirty_sep}\"${escaped}\""
      dirty_sep=","
      dirty_count=$((dirty_count + 1))
    done <"$scratch/worktree-status"
    if [ "$dirty_total" -gt 5 ]; then
      dirty_paths="${dirty_paths}${dirty_sep}\"+$((dirty_total - 5)) more\""
    fi
    dirty_paths="${dirty_paths}]"
    printf ' dirty-paths=%s' "$dirty_paths"
  fi
  if [ -n "$git_observation" ]; then
    printf ' git-observation=%s' "$git_observation"
  fi

  remote_main="$(git -C "$root" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)"
  if [ -z "$remote_main" ]; then
    printf '%s' '; local origin/main unavailable (freshness caller-owned): drift=unknown'
    return
  fi

  merge_base=""
  if merge_base="$(git -C "$root" merge-base "$head" "$remote_main" 2>/dev/null)"; then
    if [ -z "$merge_base" ]; then
      printf '; local origin/main@%s (freshness caller-owned): drift=unknown git-observation=failed' "$remote_main"
      return
    fi
  else
    merge_base_status=$?
    if [ "$merge_base_status" -eq 1 ]; then
      printf '; local origin/main@%s (freshness caller-owned): drift=no-local-merge-base' "$remote_main"
    else
      printf '; local origin/main@%s (freshness caller-owned): drift=unknown git-observation=failed' "$remote_main"
    fi
    return
  fi

  behind="$(git -C "$root" rev-list --count "$head..$remote_main" 2>/dev/null || true)"
  case "$behind" in
    ''|*[!0-9]*)
      printf '; local origin/main@%s (freshness caller-owned): drift=unknown' "$remote_main"
      return
      ;;
    0)
      printf '; local origin/main@%s (freshness caller-owned): behind=0' "$remote_main"
      return
      ;;
  esac

  if ! git -c core.quotePath=true -C "$root" diff --no-ext-diff --no-renames \
    --name-only "$merge_base..$head" >"$branch_raw" 2>/dev/null \
    || ! LC_ALL=C sort -u "$branch_raw" >"$branch_paths" \
    || ! git -c core.quotePath=true -C "$root" diff --no-ext-diff --no-renames \
      --name-only "$merge_base..$remote_main" >"$main_raw" 2>/dev/null \
    || ! LC_ALL=C sort -u "$main_raw" >"$main_paths" \
    || ! LC_ALL=C comm -12 "$branch_paths" "$main_paths" >"$overlap_paths"; then
    printf '; BASE DRIFT vs local origin/main@%s (freshness caller-owned): behind=%s overlap=unknown (path observation failed; disjoint files may still interact)' \
      "$remote_main" "$behind"
    return
  fi
  overlap="["
  separator=""
  while IFS= read -r path; do
    escaped="${path//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    overlap="${overlap}${separator}\"${escaped}\""
    separator=","
  done <"$overlap_paths"
  overlap="${overlap}]"

  printf '; BASE DRIFT vs local origin/main@%s (freshness caller-owned): behind=%s overlap=%s (prioritization only; disjoint files may still interact)' \
    "$remote_main" "$behind" "$overlap"
}

# tap-8sez: redirecting the run's own output into the tree it is about to
# test (the obvious `cd trees/tap/X && bash scripts/smoke-all.sh > gate.log
# 2>&1`) dirties the worktree the receipt reports on — the suite is honest,
# the invocation is the defect. Warn at startup, before the ~190s run, not
# after it (lsof missing/failing degrades to no warning, never a refusal —
# the receipt already tells the truth about a dirty tree either way).
smoke_warn_output_in_tree() {
  local root="$1" fd target
  for fd in 1 2; do
    target="$(lsof -a -p "$$" -d "$fd" -Fn 2>/dev/null | awk '/^n/{sub(/^n/,""); print; exit}')"
    [ -n "$target" ] || continue
    case "$target" in
      "$root"/*)
        echo "smoke-all: WARNING: fd $fd is redirected to '$target', inside the tree under test ($root) — this run's own output will dirty the worktree=clean anchor it is about to report. Redirect outside the tree instead, e.g.: bash scripts/smoke-all.sh > /tmp/gate.log 2>&1" >&2
        ;;
    esac
  done
}

smoke_bounded() { # <seconds> <cmd...> — run cmd with a hard wall bound; exit 124 at the bound.
# tap-4df9t: the EXIT trap may run while a tmux server is wedged (stopped or stuck
# accepting but never answering); a client against it blocks forever. The bound is
# hard even then: at expiry the wrapper SIGKILLs the child, allows one more second
# for a clean exit, and if the child is stuck in the kernel past SIGKILL (D-state,
# unkillable) it abandons that orphan with os._exit(124) instead of waiting — this
# runner's EXIT trap cannot park on it. Child stdout goes to an unlinked temp file
# and is re-emitted only after the wait, so an abandoned child can never hold a
# $(...) pipe write end open either. The lsof root is a local /tmp/tap-tmux.* tree,
# so its bound is a slow-scan guard; a bound expiry degrades through the same
# paths an lsof error already does.
  local s="$1"
  shift
  "${TAP_PYTHON:-python3}" -I -B -c 'import os, subprocess, sys, tempfile
bound = float(sys.argv[1])
with tempfile.TemporaryFile() as out:
    try:
        p = subprocess.Popen(sys.argv[2:], stdout=out)
    except OSError as exc:
        print("smoke_bounded: exec failed: %s" % exc, file=sys.stderr)
        raise SystemExit(127)
    try:
        rc = p.wait(timeout=bound)
    except subprocess.TimeoutExpired:
        p.kill()
        try:
            p.wait(timeout=1)
        except subprocess.TimeoutExpired:
            os._exit(124)  # unkillable child (kernel-stuck): abandon, never wait
        rc = 124
    out.seek(0)
    sys.stdout.buffer.write(out.read())
    sys.stdout.buffer.flush()
    raise SystemExit(rc)' "$s" "$@"
}

smoke_remove_tmux_root() {
  local root="$1" physical lsof_out lsof_rc
  [ -d "$root" ] || return 0
  case "$root" in /tmp/tap-tmux.*|/private/tmp/tap-tmux.*) ;; *) return 1 ;; esac
  physical="$(cd "$root" && pwd -P)" || return 1
  if lsof_out="$(smoke_bounded 30 lsof -Fn +D "$physical" 2>/dev/null)"; then
    lsof_rc=0
  else
    lsof_rc=$?
  fi
  if [ -n "$lsof_out" ]; then
    echo "smoke-all: retaining owned tmux root: $root" >&2
    return 1
  fi
  case "$lsof_rc" in
    0|1) rm -rf "$root" ;;
    *) echo "smoke-all: retaining tmux root after lsof error $lsof_rc: $root" >&2; return 1 ;;
  esac
}

smoke_escape_lint() {
  local python="${TAP_PYTHON:-python3}" root="${SMOKE_ALL_ROOT:-${ROOT:-}}"
  "$python" -B "$root/skills/tap/scripts/smoke/smoke_hermeticity_lint.py" "$@"
}

smoke_operator_state_snapshot() {
  local root="$1" output="$2"
  "${TAP_PYTHON:-python3}" -I -B - "$root" "$output" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import sys

root, output = map(Path, sys.argv[1:])
files = {}
if root.exists():
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(root).as_posix()
            if (path.name == "global-registry.json" or path.name.endswith("team-registry.json")
                    or re.fullmatch(r"input-protection/[0-9a-f]{64}\.json", rel)):
                data = path.read_bytes()
                # Hash and rows describe the same observation, even during writes.
                # An input-protection record keeps its bytes so a post-wave
                # deletion can be attributed to the tmux server that owns it.
                entry = {"hash": hashlib.sha256(data).hexdigest(), "text": None}
                try:
                    entry["text"] = data.decode("utf-8")
                except UnicodeError:
                    pass  # Keep the hash so different unreadable bytes still trigger.
            else:
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                entry = digest.hexdigest()
            files[path.relative_to(root).as_posix()] = entry
        except (OSError, UnicodeError):
            files[path.relative_to(root).as_posix()] = "READ-ERROR"
output.write_text(json.dumps(files, sort_keys=True), encoding="utf-8")
PY
}

smoke_fixture_identity_snapshot() {
  local run_root="$1" handles="$2" panes="$3" roots="$4"
  "${TAP_PYTHON:-python3}" -I -B - "$run_root" "$handles" "$panes" "$roots" <<'PY'
import json
from pathlib import Path
import sys

run_root, handles_path, panes_path, roots_path = map(Path, sys.argv[1:])
run_root = run_root.resolve()

def existing(path):
    return {line.strip() for line in path.read_text().splitlines() if line.strip()}

handles = existing(handles_path)
panes = existing(panes_path)
roots = existing(roots_path)
for path in run_root.rglob("team-registry.json"):
    try:
        resolved = path.resolve()
        if run_root not in resolved.parents:
            continue
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        continue
    if not isinstance(data, dict):
        continue
    seats = data.get("seats") or data.get("agents") or {}
    if not isinstance(seats, dict):
        continue
    for handle, raw in seats.items():
        if handle:
            handles.add(str(handle))
        row = raw if isinstance(raw, dict) else {}
        for key in ("pane", "pane_id"):
            if row.get(key):
                panes.add(str(row[key]))
        for key in ("registered_from_worktree", "root"):
            if row.get(key):
                roots.add(str(row[key]))

for path, values in ((handles_path, handles), (panes_path, panes), (roots_path, roots)):
    path.write_text("".join(f"{value}\n" for value in sorted(values)), encoding="utf-8")
PY
}

smoke_operator_state_predicate() {
  local before="$1" after="$2" operator_root="$3" run_root="$4"
  local pids="$5" handles="$6" redirected="$7" panes="$8" roots="$9" peer_owned="${10}"
  local sessions="${11:-$pids}" operator_socket="${12:-}"
  "${TAP_PYTHON:-python3}" -I -B - \
    "$before" "$after" "$operator_root" "$run_root" "$pids" "$handles" "$redirected" \
    "$panes" "$roots" "$peer_owned" "$sessions" "$operator_socket" <<'PY'
import hashlib
import os
import json
import re
from pathlib import Path
import sys

# tap-dsbpf.1: pane-submit names are pane-keyed (lockPath sanitizes
# [^A-Za-z0-9_.-] to _). Obligation is TAP's own namespace: family
# obligation-<key>.lock(.held.<pid>.<rand>)?, then MINTED_ID is the only
# courier shape <sender>-<YYYYMMDDTHHMMSSZ>-<12hex>. A non-minted key is
# a temporal note, not actor evidence (K11); sender is inferred
# from minted keys only. Production durable notices also use custom ids. Generic lock names have no pid/handle producer.
# Generic lockf held markers (`<path>.lock.held.<pid>.<rand>`, K12) parse
# the held pid structurally. Content is JSON by value or digit-boundary.
# lockf bodies are empty; handle attribution is minted sender equality.
# Bun .lock.held.<pid>.<rand> remains live until markers relocate to OS temp; keep this parser as legacy/defensive coverage afterward.
#
# Lossy sanitizer: two raw panes collide only if they differ solely in
# characters outside [A-Za-z0-9_.-]. Sanitized-key equality recovers the
# raw pane(s) for a temporal note (K9); it is not an actor test. Pane
# targets recycle across tmux servers and this artifact records no
# server identity (ruling-670-pane-lock-attribution.md). A genuine
# escaped pane-submit without a pid witness therefore notes rather than
# reds. Other attributable escape arms remain. Re-check if a production
# caller ever keys pane-submit by pane_id (courier/deliver/owner pass
# the pane string today).
# ASCII only: JS replace is UTF-16 code units, Python is code points.
LOCK_HELD_SUFFIX = r"\.held\.(\d+)\.([0-9a-z]{1,8})"
PANE_LOCK_NAME = re.compile(rf"^pane-submit-(.+?)\.lock(?:{LOCK_HELD_SUFFIX})?$")
OBLIGATION_LOCK_NAME = re.compile(
    rf"^obligation-(.+)\.lock(?:{LOCK_HELD_SUFFIX})?$"
)
GENERIC_HELD = re.compile(rf"^.+\.lock{LOCK_HELD_SUFFIX}$")
# Bun staging files (fsatomic.ts stagingPath, tap-c7whh): `.tap.<pid36>.<8
# hex>.tmp`, renamed onto their destination in the same directory. A live
# operator process's staging file vanishing mid-wave is its own rename, so a
# non-wave pid notes; a wave pid still fails. The PID is BASE 36.
STAGING_NAME = re.compile(r"^\.tap\.([0-9a-z]+)\.([0-9a-f]{8})\.tmp$")
MINTED_ID = re.compile(r"^(.+)-(\d{8}T\d{6}Z)-([0-9a-f]{12})$")

def sanitize_key(s):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", s)

def pid_in_text(body, wave_pid):
    try:
        obj = json.loads(body)
    except (json.JSONDecodeError, ValueError, TypeError):
        return re.search(rf"(?<!\d){re.escape(wave_pid)}(?!\d)", body) is not None
    want_int = int(wave_pid) if wave_pid.isdigit() else None
    stack = [obj]
    while stack:
        cur = stack.pop()
        if cur == wave_pid or (want_int is not None and cur == want_int):
            return True
        if isinstance(cur, dict):
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return False

def held_pid_is_wave(held_pid):
    if not held_pid:
        return False
    if held_pid in pids:
        return True
    try:
        # A holder can fork after the census; only original worker sessions
        # authorize attribution, not a descendant PID later used as a new SID.
        sid = os.getsid(int(held_pid))
        try:
            os.getsid(sid)
        except ProcessLookupError:
            return str(sid) in sessions
        # All workers returned before attribution. A live leader is PID reuse.
        return False  # live leader supplies no new wave evidence
    except (ValueError, ProcessLookupError, PermissionError, OverflowError, OSError):
        return False

before_path, after_path, operator_root, run_root, pids_path, handles_path, redirected_path, panes_path, roots_path, peer_owned_path, sessions_path = map(Path, sys.argv[1:12])
operator_socket = os.path.realpath(sys.argv[12]) if sys.argv[12] else ""
operator_root = operator_root.resolve()
run_root = run_root.resolve()
before_files = json.loads(before_path.read_text(encoding="utf-8"))
after_files = json.loads(after_path.read_text(encoding="utf-8"))
if before_files == after_files:
    print("operator-state hash-trigger: unchanged")
    raise SystemExit(0)

changed = {path for path in before_files | after_files if before_files.get(path) != after_files.get(path)}
deleted = before_files.keys() - after_files.keys()
pids = {line.strip() for line in pids_path.read_text().splitlines() if line.strip()}
sessions = {line.strip() for line in sessions_path.read_text().splitlines() if line.strip()}
sessions.discard(os.environ.get("TAP_SUITE_SLOT_PID", ""))
handles = {line.strip() for line in handles_path.read_text().splitlines() if line.strip()}
panes = {line.strip() for line in panes_path.read_text().splitlines() if line.strip()}
roots = {line.strip() for line in roots_path.read_text().splitlines() if line.strip()}
redirected = {line.strip().lstrip("/") for line in redirected_path.read_text().splitlines() if line.strip()}
# tap-h37qp: deletions a concurrent suite owns. Suppresses the deletion arm
# only; every actor-matching arm below still applies to these paths.
#
# EXACT match, not a suffix match. A peer suite can only ever own the canonical
# locks/smoke-all.lease.json, so the match must be as narrow as the thing that
# justifies it. A suffix match exempted any path ENDING in that name -- e.g. a
# worker deleting archive/locks/smoke-all.lease.json -- which is a real
# protected-state deletion walking past the guard. Buying attribution by
# blinding the arm looks identical to success in a green receipt.
peer_owned = {line.strip().lstrip("/") for line in peer_owned_path.read_text().splitlines() if line.strip()}

# tap-cc7iu: a live courier removes a pane's input-protection record when the
# pane's pending cohort is delivered, its composer goes bare, the pane dies or
# its server restarts -- usually while grace is still in the future, so grace
# timing is no evidence either way. The record's name is
# sha256(physical tmux socket + NUL + pane), computed by every TAP path that
# writes or deletes it from that process's own socket. A wave worker runs on a
# private tmux namespace, so TAP code in a wave can only name records keyed to
# the wave's socket; reaching the operator's socket is an escape the tmux
# guard owns. A deleted record whose retained bytes name a pane that hashes,
# with the operator's socket, to its own file name therefore notes.
#
# Like the held-marker arm, this gives up detecting a raw unlink of that exact,
# genuine operator-keyed record by an escaped wave. A wipe is the realistic
# shape of that escape, so the exemption is off when the directory is gone, or
# when every record (three or more) that existed before the wave is gone.
# A courier keyed by TAP_TMUX_SOCKET_PATH or TAP_TMUX_SOCKET instead of the
# operator's TMUX keys differently from the recorded socket and stays red:
# conservative, not an escape.
IP_RECORD = re.compile(r"^input-protection/([0-9a-f]{64})\.json$")
ip_before = {rel for rel in before_files if IP_RECORD.fullmatch(rel)}
ip_after = {rel for rel in after_files if IP_RECORD.fullmatch(rel)}
ip_wipe = ""
if ip_before and not (operator_root / "input-protection").is_dir():
    ip_wipe = "input-protection directory gone after the wave"
elif len(ip_before) >= 3 and not ip_before & ip_after:
    ip_wipe = f"every prior input-protection record gone ({len(ip_before)})"

def operator_keyed_pane(rel):
    """(pane, None) when the deleted record is keyed to the operator's server, else (None, why)."""
    match = IP_RECORD.fullmatch(rel)
    if ip_wipe:
        return None, ip_wipe
    if not operator_socket:
        return None, "no operator tmux socket recorded"
    entry = before_files.get(rel)
    text = entry.get("text") if isinstance(entry, dict) else None
    if not isinstance(text, str):
        return None, "record bytes not retained"
    try:
        record = json.loads(text)
    except ValueError:
        return None, "record unparseable"
    pane = record.get("pane") if isinstance(record, dict) else None
    if not isinstance(pane, str) or not pane:
        return None, "record has no pane"
    key = hashlib.sha256(f"{operator_socket}\0{pane}".encode("utf-8")).hexdigest()
    if key != match.group(1):
        return None, f"name is not keyed to the operator tmux socket for pane {pane}"
    return pane, None

violations = []
notes = []

for rel in sorted(changed):
    path = operator_root / rel
    # tap-mg1yk: this match is deliberately LOOSE, and the looseness is safe.
    # Widening what counts as redirected only makes detection more conservative
    # (more violations reported). Widening the adjacent exemptions below
    # (peer_owned, deleted handling) is NOT safe: each one hides an escape.
    is_redirected = any(rel == item or rel.endswith("/" + item) for item in redirected)
    if is_redirected:
        violations.append(f"redirected-path: {rel}")
    if rel in deleted:
        is_peer_owned = rel in peer_owned
        # Kernel-lock handshake markers disappear on normal release. A peer's
        # marker disappearing cannot identify this wave as its deleting actor.
        # Like the suite lease, this gives up detecting an escaped deletion of
        # that exact peer artifact; permanent locks and wave markers still fail.
        held = GENERIC_HELD.fullmatch(path.name) or re.fullmatch(LOCK_HELD_SUFFIX, path.name)
        if held and not held_pid_is_wave(held.group(1)) and not is_redirected:
            notes.append(f"note peer held-marker released: {rel}")
            continue
        staging = STAGING_NAME.fullmatch(path.name)
        if staging and not held_pid_is_wave(str(int(staging.group(1), 36))) and not is_redirected:
            notes.append(f"note peer staging released: {rel}")
            continue
        if IP_RECORD.fullmatch(rel) and not is_redirected and not is_peer_owned:
            pane, why = operator_keyed_pane(rel)
            if pane:
                notes.append(f"note operator-server input-protection released: {rel} (pane {pane})")
            else:
                violations.append(f"protected operator state deleted: {rel} "
                                  f"(input-protection: {why}; a live courier releases operator-keyed "
                                  f"records, so check the record's server before suspecting an escape)")
            continue
        if not is_redirected and not is_peer_owned:
            violations.append(f"protected operator state deleted: {rel}")
        continue
    if not path.is_file():
        continue
    try:
        if path.name == "global-registry.json" or path.name.endswith("team-registry.json"):
            text = after_files[rel]["text"]
            if text is None:
                raise UnicodeError("registry is not UTF-8")
        else:
            text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError, KeyError, TypeError):
        violations.append(f"operator-state unreadable: {rel}")
        continue
    if path.name == "global-registry.json" or path.name.endswith("team-registry.json"):
        kind = "global-registry" if path.name == "global-registry.json" else "team-registry"
        try:
            documents = [json.loads(before_files[rel]["text"]) if rel in before_files else {},
                         json.loads(text)]
            rows = []
            for document in documents:
                if kind == "global-registry":
                    entries = document.get("teams", {})
                else:
                    entries = document.get("seats", document.get("agents", {}))
                if not isinstance(entries, dict) or any(not isinstance(row, dict) for row in entries.values()):
                    raise ValueError("registry rows must be objects")
                rows.append(entries)
            old_rows, new_rows = rows
            changed_rows = {key: row for key, row in new_rows.items()
                            if key not in old_rows or old_rows[key] != row}
        except (ValueError, AttributeError, KeyError, TypeError):
            violations.append(f"{kind} malformed: {rel}")
            continue
    if path.name == "global-registry.json":
        for team, row in changed_rows.items():
            root_raw = str((row or {}).get("root") or "")
            registry_raw = str((row or {}).get("registry_location") or "")
            root = Path(root_raw).resolve() if root_raw else None
            registry = Path(registry_raw).resolve() if registry_raw else None
            if root and (root == run_root or run_root in root.parents):
                violations.append(f"global-registry wave-root: {team} {root}")
            elif not root or not root.exists() or not registry or not registry.exists():
                violations.append(f"global-registry non-seat root: {team} {root_raw}")
    if path.name.endswith("team-registry.json"):
        old_document, new_document = documents
        changed_metadata = {key: value for key, value in new_document.items()
                            if key not in ("seats", "agents")
                            and (key not in old_document or old_document[key] != value)}
        text = json.dumps([changed_rows, changed_metadata], ensure_ascii=False)
        for handle in sorted(handles):
            if handle in text:
                violations.append(f"team-registry wave handle: {handle} {rel}")
        for pane in sorted(panes):
            if pane in text:
                violations.append(f"team-registry wave pane: {pane} {rel}")
        for root in sorted(roots):
            if root in text:
                violations.append(f"team-registry wave-root: {root} {rel}")
        for pid in sorted(pids):
            if pid in text:
                violations.append(f"team-registry wave pid: {pid} {rel}")
        if str(run_root) in text:
            violations.append(f"team-registry wave-root: {rel}")
    if path.name.endswith(".lock") or ".lock.held." in path.name:
        pane_m = PANE_LOCK_NAME.fullmatch(path.name)
        obl_m = OBLIGATION_LOCK_NAME.fullmatch(path.name)
        generic_held_m = None if pane_m or obl_m else GENERIC_HELD.fullmatch(path.name)
        if pane_m:
            key = pane_m.group(1)
            held_pid = pane_m.group(2)
            # recovered as the raw pane(s) that sanitize to this key.
            for pane in sorted(panes):
                if sanitize_key(pane) == key:
                    notes.append(f"note lock pane-key match (server identity not recorded in lock artifacts; pane targets recycle across servers): {pane} {rel}")
            if held_pid_is_wave(held_pid):
                violations.append(f"lock wave pid: {held_pid} {rel}")
        elif obl_m:
            key = obl_m.group(1)
            held_pid = obl_m.group(2)
            minted_m = MINTED_ID.fullmatch(key)
            if not minted_m:
                notes.append(f"note lock non-minted obligation id (no wave witness from key): {key} {rel}")
            else:
                sender = minted_m.group(1)
                for handle in sorted(handles):
                    if sender == handle:
                        violations.append(f"lock wave handle: {handle} {rel}")
            if held_pid_is_wave(held_pid):
                violations.append(f"lock wave pid: {held_pid} {rel}")
        else:
            if generic_held_m and held_pid_is_wave(generic_held_m.group(1)):
                violations.append(f"lock wave pid: {generic_held_m.group(1)} {rel}")
        if not pane_m:
            for pid in sorted(pids):
                already = obl_m and held_pid_is_wave(obl_m.group(2)) and pid == obl_m.group(2)
                if not already and generic_held_m:
                    already = held_pid_is_wave(generic_held_m.group(1)) and pid == generic_held_m.group(1)
                if already:
                    continue
                if pid_in_text(text, pid):
                    violations.append(f"lock wave pid: {pid} {rel}")

if notes:
    print("\n".join(notes))
if violations:
    print("\n".join(violations))
    raise SystemExit(1)
print("operator-state semantic: no attributable violation")
PY
}

# tap-dsbpf.1 descendant pid census (ruling-670-descendant-pid-attribution.md).
# Workers start as session leaders so the recorded pid is the sid. After the
# wave, live pids whose getsid matches a recorded worker sid join SMOKE_WAVE_PIDS.
# TAP_SUITE_SLOT_PID stays an exact-membership row and is not a session id.
# Residuals: children dead before snapshot stay unattributable; a deliberate
# setsid/double-fork leaves the session (same class as known reconstruction notes).
# The pid is recorded (and published to SMOKE_WAVE_SELF for tests) BEFORE
# setsid(): an interrupt between the two leaves a recorded worker that is still in
# the runner's session, never a detached worker cleanup cannot see (r3909244230).
# The shim stays the session leader, waits the smoke child, and appends its pid
# to SMOKE_WAVE_DONE while that pid is still allocated (r3916183747). Sid
# persistence is the feature: a live grandchild still reports the recorded sid
# after the leader exits; smoke_all_cleanup reaps those sessions at EXIT (r3908057407).
SMOKE_WAVE_SESSION_EXEC_PY='import os, sys, subprocess, signal
# Async dispatch inherits these ignored; restore trap-capable worker shells.
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGQUIT, signal.SIG_DFL)
pid = os.getpid()
open(os.environ["SMOKE_WAVE_PIDS"], "a", encoding="utf-8").write("%s\n" % pid)
self_path = os.environ.get("SMOKE_WAVE_SELF")
if self_path:
    open(self_path, "w", encoding="utf-8").write("%s\n" % pid)
os.setsid()
path = sys.argv[1]
probe_argv = sys.argv[2] if len(sys.argv) > 2 else None
if probe_argv is not None:
    # Probe mode (smoke-all --probe): interpreter by extension, literal argv, a
    # fresh scratch cwd under the per-file TMPDIR, the checkout as an input path.
    # Never an eval or -c payload.
    try:
        import tempfile
        with open(probe_argv, "rb") as fh:
            argv = [os.fsdecode(a) for a in fh.read().split(b"\0")[:-1]]
        ext = os.path.splitext(path)[1]
        interpreter = {
            ".sh": ["bash"],
            ".py": [os.environ.get("TAP_PYTHON") or "python3", "-B"],
            ".ts": [os.environ.get("TAP_SMOKE_BUN") or "bun", "run"],
        }[ext]
        cwd = tempfile.mkdtemp(prefix="probe.", dir=os.environ["TMPDIR"])
        env = dict(os.environ, TAP_PROBE_CHECKOUT=os.environ["SMOKE_ALL_ROOT"])
        proc = subprocess.run(interpreter + [path] + argv, cwd=cwd, env=env)
    except (OSError, KeyError) as exc:
        print("probe: error=interpreter_unavailable: %s" % exc, file=sys.stderr)
        print("probe: recovery: install the interpreter or use another extension", file=sys.stderr)
        proc = subprocess.CompletedProcess([], 127)
elif path.endswith(".sh"):
    proc = subprocess.run(["bash", path])
else:
    root = os.environ["SMOKE_ALL_ROOT"]
    env = dict(os.environ, TAP_POC_REF_BIN=root + "/scripts/tap.sh")
    proc = subprocess.run(["bash", root + "/runtime/bun/test/run.sh", path],
                          cwd=root + "/runtime/bun", env=env)
rc = proc.returncode
if rc is None:
    rc = 1
elif rc < 0:
    rc = 128 + (-rc)
done_path = os.environ.get("SMOKE_WAVE_DONE")
if done_path:
    open(done_path, "a", encoding="utf-8").write("%s\n" % pid)
barrier = os.environ.get("SMOKE_WAVE_DONE_BARRIER")
if barrier:
    fd = os.open(barrier, os.O_WRONLY)
    os.close(fd)
rc_file = os.environ.get("SMOKE_WAVE_LEADER_RC")
if rc_file:
    open(rc_file, "w", encoding="utf-8").write("%s\n" % rc)
raise SystemExit(rc)
'
export SMOKE_WAVE_SESSION_EXEC_PY

smoke_wave_session_exec() {
  "${TAP_PYTHON:-python3}" -I -B -c "$SMOKE_WAVE_SESSION_EXEC_PY" "$1"
}

smoke_wave_pid_census() {
  local pids_file="$1"
  "${TAP_PYTHON:-python3}" -I -B - "$pids_file" <<'PY'
import os, subprocess, sys
from pathlib import Path

path = Path(sys.argv[1])
recorded = []
seen = set()
if path.is_file():
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if raw and raw not in seen:
            seen.add(raw)
            recorded.append(raw)
slot = os.environ.get("TAP_SUITE_SLOT_PID", "").strip()
sids = set()
for raw in recorded:
    if raw == slot:
        continue
    try:
        sids.add(int(raw))
    except ValueError:
        continue
added = []
for field in subprocess.check_output(["ps", "-axo", "pid="], text=True).split():
    try:
        pid = int(field)
    except ValueError:
        continue
    spid = str(pid)
    if spid in seen:
        continue
    try:
        if os.getsid(pid) in sids:
            added.append(spid)
            seen.add(spid)
    except (ProcessLookupError, PermissionError, OverflowError, OSError):
        continue
if added:
    with path.open("a", encoding="utf-8") as fh:
        fh.write("".join("%s\n" % item for item in added))
PY
}

# r3908057407 (ruling-670-unit-c-exit-reap.md): an interrupted runner must not
# leave setsid'd workers running against a sandbox it is about to delete. The
# shim moved every worker out of the terminal's foreground group, so Ctrl-C
# never reaches them; the EXIT trap is the only path that does.
#
# Two exits, decided by the wave-complete marker (R-C1), never by a heuristic:
# - complete (marker present): both xargs returned, so every worker LEADER is
#   dead by construction. A live pid whose getsid is a recorded worker pid is a
#   wave descendant (reap) — unless that session's leader pid is itself alive,
#   which after completion can only be pid reuse by a stranger: KEEP the whole
#   session (the 08-23/24 incident class).
# - interrupted (marker absent): a live leader is a running worker — unless that
#   worker already recorded completion in wave-done, in which case its leader is
#   dead by construction and a live pid there is reuse: KEEP (r3909244208).
# Targets are recomputed on every poll with one predicate: live members of a
# recorded (non-reused) session — the census instrument, ps + getsid — plus any
# recorded non-reused pid that is itself alive (a worker in the record→setsid
# window has no session of its own yet). TERM goes only to pids not yet
# signalled, so a helper forked by a worker's TERM handler is picked up by the
# next poll; after ~2 s the last enumerated set is KILLed, then one bounded
# re-sweep KILLs anything that arrived meanwhile (two KILL rounds in all).
# Never a name, a path, a pattern, or a pgid-only kill. Residual, deliberately
# unguarded: a targeted pid that exits and is reused by a stranger inside the
# ≤2.2 s signalling window could receive the signal meant for the worker.
# TAP_SUITE_SLOT_PID is an exact-membership row, not a session: skipped.
smoke_wave_session_reap() { # <pids-file> <wave-complete-marker> <wave-done-file>
  local pids_file="$1" marker="$2" done_file="$3"
  [ -s "$pids_file" ] || return 0
  "${TAP_PYTHON:-python3}" -I -B - "$pids_file" "$marker" "$done_file" <<'PY'
import os, signal, subprocess, sys, time
from pathlib import Path

pids_path, marker, done_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
complete = marker.exists()
done = set()
if done_path.is_file():
    for line in done_path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if raw.isdigit():
            done.add(int(raw))
slot = os.environ.get("TAP_SUITE_SLOT_PID", "").strip()
sids = set()
for line in pids_path.read_text(encoding="utf-8").splitlines():
    raw = line.strip()
    if raw and raw != slot and raw.isdigit():
        sids.add(int(raw))
if not sids:
    raise SystemExit(0)

def live_pids():
    out = []
    for field in subprocess.check_output(["ps", "-axo", "pid="], text=True).split():
        try:
            out.append(int(field))
        except ValueError:
            continue
    return out

def members(alive):
    found = []
    for pid in alive:
        if pid == os.getpid():
            continue
        try:
            # spelled differently from the census's membership line on purpose:
            # operator-state-predicate.test.sh anchors a mutant on that exact text
            member_sid = os.getsid(pid)
        except (ProcessLookupError, PermissionError, OverflowError, OSError):
            continue
        if member_sid in sids:
            found.append(pid)
    return found

alive = live_pids()
# A recorded leader still alive after ITS worker finished is a reused pid: either the
# whole wave completed (marker) or that worker recorded completion (wave-done).
# A live leader with neither is a running worker on an interrupted wave.
reused = {sid for sid in sids if sid in alive and (complete or sid in done)}
sids -= reused
if not sids:
    raise SystemExit(0)

def send(targets, sig):
    for pid in targets:
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            continue

# Targets: every live member of a recorded session, plus every recorded pid that
# is itself alive — a worker that has recorded its pid but not yet left the
# runner's session has no session of its own to enumerate, and it is ours by
# construction (a stranger's reuse was removed above). No name, path, or pattern.
def targets(alive):
    found = members(alive)
    for sid in sids:
        if sid in alive and sid != os.getpid() and sid not in found:
            found.append(sid)
    return found

signalled = set()
current = targets(alive)
if not current:
    raise SystemExit(0)
for _ in range(20):
    arrivals = [pid for pid in current if pid not in signalled]
    send(arrivals, signal.SIGTERM)
    signalled.update(arrivals)
    time.sleep(0.1)
    current = targets(live_pids())  # re-enumerate: arrivals join, the dead drop out
    if not current:
        break
if current:
    send(current, signal.SIGKILL)
    signalled.update(current)
    time.sleep(0.1)
    current = targets(live_pids())  # bounded re-sweep
    if current:
        send(current, signal.SIGKILL)
        signalled.update(current)
        time.sleep(0.1)
        current = targets(live_pids())  # after the second KILL round
# stderr: the EXIT trap runs after the terminal ok-line, which must stay last on stdout.
print("smoke-all: reaped %d worker-session pid(s)%s" % (
    len(signalled), "" if not current else " (%d still live after KILL)" % len(current)), file=sys.stderr)
PY
}

# Top-level (outside smoke_all_main) so wave-session-reap.test.sh can drive the
# real cleanup path with the runner sourced. Order (R-C3): reap recorded worker
# sessions FIRST, then stop this run's tmux servers, then remove tmux root,
# OUTDIR and sandbox — a reaped worker cannot re-create a path after rm -rf.
# The parent owns a child before that child can publish its session ledger.
# Consult Bash's live jobs so an already reaped PID cannot authorize a signal.
smoke_signal_live_child() { # <pid> <signal>
  local child
  [ -n "$1" ] || return 0
  while IFS= read -r child; do
    [ "$child" != "$1" ] || kill -"$2" "$1" 2>/dev/null || true
  done < <(jobs -pr)
}

smoke_all_cleanup() {
  local outdir="$1" sandbox="$2" tmux_root="$3" socket
  # Stop dispatch and its wrappers before sampling worker sessions: a wrapper
  # not yet in wave-pids must not create a new worker after the final census.
  smoke_signal_live_child "${SMOKE_DISPATCH_PID:-}" TERM
  smoke_wave_session_reap "$outdir/dispatch-pids" "$outdir/wave-complete" "$outdir/dispatch-done"
  if [ -n "${SMOKE_DISPATCH_PID:-}" ]; then
    wait "$SMOKE_DISPATCH_PID" 2>/dev/null || true
  fi
  smoke_wave_session_reap "$outdir/wave-pids" "$outdir/wave-complete" "$outdir/wave-done"
  if [ -d "$tmux_root" ]; then
    while IFS= read -r socket; do
      case "$socket" in "$tmux_root"/*) smoke_bounded 10 tmux -S "$socket" kill-server 2>/dev/null || true ;; esac
    done < <(find "$tmux_root" -type s -print 2>/dev/null)
  fi
  smoke_remove_tmux_root "$tmux_root" || true
  rm -rf "$outdir"
  case "$sandbox" in */smoke-all-sandbox.*) rm -rf "$sandbox" ;; esac
}


smoke_tmux_state_snapshot() {
  local tmux_bin="$1" socket="$2" output="$3" tmp="$3.tmp"
  : >"$tmp"
  if [ -n "$socket" ]; then
    "$tmux_bin" -S "$socket" list-sessions -F '#{session_name}' >"$tmp" 2>/dev/null || : >"$tmp"
  fi
  mv "$tmp" "$output"
}

smoke_tmux_state_predicate() {
  local before="$1" after="$2" attributed="$3" before_sorted after_sorted session name failed=0
  before_sorted="$(mktemp "${TMPDIR:-/tmp}/smoke-tmux-before.XXXXXX")"
  after_sorted="$(mktemp "${TMPDIR:-/tmp}/smoke-tmux-after.XXXXXX")"
  LC_ALL=C sort -u "$before" >"$before_sorted"
  LC_ALL=C sort -u "$after" >"$after_sorted"
  while IFS= read -r session; do
    [ -n "$session" ] || continue
    echo "NOTE tmux session disappeared during wave (temporal-only): $session"
  done < <(LC_ALL=C comm -23 "$before_sorted" "$after_sorted")
  while IFS= read -r session; do
    [ -n "$session" ] || continue
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      if [ "$session" = "$name" ]; then
        echo "tmux fixture session appeared: $session" >&2
        failed=1
        break
      fi
    done <"$attributed"
  done < <(LC_ALL=C comm -13 "$before_sorted" "$after_sorted")
  rm -f "$before_sorted" "$after_sorted"
  [ "$failed" -eq 0 ] && echo "tmux-state semantic: no attributable violation"
  [ "$failed" -eq 0 ]
}

smoke_install_tmux_guard() {
  local guard_dir="$1" real_tmux="$2" suite_root="$3" marker="$4" python
  mkdir -p "$guard_dir" "$suite_root"
  suite_root="$(cd "$suite_root" && pwd -P)"
  python="$(command -v "${TAP_PYTHON:-python3}")"
  printf '%s\n' "$real_tmux" >"$guard_dir/real-tmux"
  printf '%s\n' "$suite_root" >"$guard_dir/suite-root"
  printf '%s\n' "$marker" >"$guard_dir/marker"
  printf '%s\n' "$python" >"$guard_dir/python"
  printf '%s\n' "$SMOKE_TMUX_SOCKET_LIMIT" >"$guard_dir/socket-limit"
  : >"$guard_dir/session-names"
  # Runner-owned provenance for tap-7r3fn.31(b). The classifier downstream must
  # not read a failing test's own output — printing tmux's wording is not the
  # same as hitting it — so the one place that sees the real binary's stderr
  # writes the record, keyed to the file that was running.
  : >"$guard_dir/fork-refusals"
  # One encoder for the guard's escape record: the shim that writes it, the
  # classifier that looks a file up and the FAIL block that replays it all run
  # this file, so a file key can never be spelled two ways. Fields are tab
  # separated; backslash, tab, newline and carriage return are escaped inside
  # each field (backslash first, so a literal backslash-t stays distinct from a
  # tab) and argv words also escape the space, which keeps every record one
  # unambiguous line that an argument cannot extend into another file's record.
  cat >"$guard_dir/escape-record.py" <<'ESCAPE_RECORD'
import os
import sys

TAG = "TMUX-ESCAPE"


def enc(text, space=False):
    text = text.replace("\\", "\\\\").replace("\t", "\\t")
    text = text.replace("\n", "\\n").replace("\r", "\\r")
    return text.replace(" ", "\\x20") if space else text


def records(marker, file):
    key = enc(file)
    with open(marker, "rb") as handle:
        for raw in handle.read().split(b"\n"):
            fields = os.fsdecode(raw).split("\t")
            if len(fields) == 6 and fields[0] == TAG and fields[1] == key:
                yield fields


def main(argv):
    mode, marker = argv[1], argv[2]
    if mode == "record":
        file, effective, root, limit = argv[3:7]
        words = " ".join(enc(word, True) for word in argv[7:])
        line = "\t".join([TAG, enc(file), enc(effective), enc(root), enc(limit), words])
        fd = os.open(marker, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            os.write(fd, os.fsencode(line + "\n"))
        finally:
            os.close(fd)
        return 0
    found = list(records(marker, argv[3]))
    if mode == "has":
        return 0 if found else 1
    if mode == "replay":
        for _, _, effective, root, limit, words in found[:5]:
            print(f"smoke-all: tmux guard record: rejected effective socket {effective} "
                  f"(root={root} limit={limit}) argv: {words}")
        if len(found) > 5:
            print(f"smoke-all: tmux guard record: {len(found) - 5} more rejected calls not shown")
        return 0
    return 2


# An uncaught exception would exit 1, which the classifier reads as "no record".
# Any failure here exits 2 so an unreadable marker reds the file instead.
try:
    status = main(sys.argv)
except BaseException as error:
    print(f"escape-record: {type(error).__name__}: {error}", file=sys.stderr)
    status = 2
sys.exit(status)
ESCAPE_RECORD
  cat >"$guard_dir/tmux" <<'GUARD'
#!/usr/bin/env bash
set -u
guard_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
real_tmux="$(cat "$guard_dir/real-tmux")"
suite_root="$(cat "$guard_dir/suite-root")"
marker="$(cat "$guard_dir/marker")"
python="$(cat "$guard_dir/python")"
socket_limit="$(cat "$guard_dir/socket-limit")"
effective="" name="" bad_name=0
args=("$@")
while [ "$#" -gt 0 ]; do
  case "$1" in
    -S) [ "$#" -ge 2 ] && effective="$2"; shift 2 ;;
    -S?*) effective="${1#-S}"; shift ;;
    -L)
      [ "$#" -ge 2 ] && name="$2"
      case "$name" in */*|.|..) bad_name=1 ;; esac
      effective="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$name"
      shift 2
      ;;
    -L?*)
      name="${1#-L}"
      case "$name" in */*|.|..) bad_name=1 ;; esac
      effective="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$name"
      shift
      ;;
    --) break ;;
    *) shift ;;
  esac
done
if [ -z "$effective" ]; then
  if [ -n "${TMUX:-}" ]; then
    effective="${TMUX%%,*}"
  else
    effective="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/default"
  fi
fi
effective="$($python -I -B -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$effective")"
case "$effective" in "$suite_root"/*) private=1 ;; *) private=0 ;; esac
if [ "$bad_name" -eq 1 ] || [ "$private" -ne 1 ] || [ "${#effective}" -ge "$socket_limit" ]; then
  # The marker is the evidence channel that survives a caller swallowing this
  # stderr, so it carries the same facts. If the record helper itself fails, a
  # bare attribution still lands: the escape must red its file either way.
  "$python" -I -B "$guard_dir/escape-record.py" record "$marker" "${SMOKE_SUITE_FILE:--}" \
    "$effective" "$suite_root" "$socket_limit" "${args[@]}" 2>/dev/null \
    || printf 'TMUX-ESCAPE\t%s\t-\t-\t-\t(unrecorded)\n' "${SMOKE_SUITE_FILE:--}" >>"$marker"
  echo "SMOKE-TMUX-ESCAPE: rejected effective socket $effective (root=$suite_root limit=$socket_limit)" >&2
  exit 97
fi
creating=0 created_name=""
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[$i]}" = new-session ] || [ "${args[$i]}" = new ]; then
    creating=1
  elif [ "$creating" -eq 1 ] && [[ "${args[$i]}" =~ ^-[AdDEPX]*s$ ]] \
      && [ "$((i + 1))" -lt "${#args[@]}" ]; then
    created_name="${args[$((i + 1))]}"
  elif [ "$creating" -eq 1 ] && [[ "${args[$i]}" =~ ^-[AdDEPX]*s(.+)$ ]]; then
    created_name="${BASH_REMATCH[1]}"
  fi
done
# A tmux server that cannot fork a child fails with ENXIO, which tmux prints as
# "fork failed: Device not configured" — the machine's pty or process ceiling,
# not a verdict on whichever file asked for a pane. Recording it needs the real
# binary's stderr, and reading stderr means holding it until the call returns.
#
# So the capture is scoped to the SPAWN subcommands and nothing else: those are
# short-lived by construction, while a long-lived call (attach, wait-for,
# control mode) would have its stderr buffered to its own exit, which is a
# behavior change this record is not worth. stdout is never redirected, so
# `new-session -P` still streams its pane id to the caller.
spawning=0
for arg in "${args[@]}"; do
  case "$arg" in
    new-session|new|respawn-pane|respawn-window|split-window|new-window) spawning=1; break ;;
  esac
done
if [ "$spawning" -eq 1 ]; then
  err="$(mktemp "${TMPDIR:-/tmp}/smoke-tmux-err.XXXXXX")"
  "$real_tmux" "${args[@]}" 2>"$err"
  rc=$?
  # The literal wording, matched with -F: a broader match ("Device not
  # configured" alone, or any mention of fork) would record an unrelated device
  # error as a load story and hand a real failure a rerun.
  if [ "$rc" -ne 0 ] && grep -qF 'fork failed: Device not configured' "$err"; then
    printf 'TMUX-FORK-REFUSAL\t%s\t%s\n' "${SMOKE_SUITE_FILE:--}" "${args[*]}" >>"$guard_dir/fork-refusals"
  fi
  cat "$err" >&2
  rm -f "$err"
else
  "$real_tmux" "${args[@]}"
  rc=$?
fi
[ "$rc" -eq 0 ] && [ -n "$created_name" ] && printf '%s\n' "$created_name" >>"$guard_dir/session-names"
exit "$rc"
GUARD
  chmod +x "$guard_dir/tmux"
}

smoke_known_defect_receipt() {
  local log line prefix bead date description extra count=0 ids=""
  for log in "$@"; do
    [ -f "$log" ] || continue
    while IFS= read -r line; do
      case "$line" in KNOWN-DEFECT*) ;; *) continue ;; esac
      IFS="$(printf '\t')" read -r prefix bead date description extra <<EOF
$line
EOF
      if [ "$prefix" != KNOWN-DEFECT ] \
        || [[ ! "$bead" =~ ^tap-[a-z0-9]{5,}$ ]] \
        || [[ ! "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
        || [ -z "$description" ] || [ -n "$extra" ]; then
        return 1
      fi
      count=$((count + 1))
      case " $ids " in *" $bead "*) ;; *) ids="${ids:+$ids }$bead" ;; esac
    done <"$log"
  done
  if [ "$count" -eq 0 ]; then
    printf '%s\n' 'known-defect: 0'
  else
    printf 'known-defect: %s (%s)\n' "$count" "$ids"
  fi
}

# A red receipt's `known-defect: N (ids)` can read as failure attribution, but
# it is a census of markers across every completed worker log, passing or
# failing. Red summaries say so inside the existing parenthetical; the green
# line's bytes are pinned by parsers and the protocol page and never move
# (tap-nz9e5).
red_known_defect_census() {
  local raw="$1"
  case "$raw" in
    "known-defect: 0") printf '%s\n' 'known-defect: 0 (all-files census)' ;;
    "known-defect: "*")") printf '%s\n' "${raw%\)}; observed across all files, not failure attribution)" ;;
    *) printf '%s\n' "$raw" ;;
  esac
}

# tap-kg3fb: the red summary names WHICH files failed, not only how many, so a
# reader of just that line (stderr, a CI log tail) needs no SMOKE-FAIL block.
# Failing worker files come from column 2 of the fail ledger, then one
# `post-wave:<class>` per distinct post-wave predicate (those fail the run
# without failing a file). Deduped, in ledger order, capped so a mass failure
# cannot produce a huge line. The segment sits BEFORE the known-defect census:
# ci-gate-verdict.py and regress-record.py END-anchor the `— N/M FAILED ... (Ns,
# -j J)` tail, so nothing may be appended after it.
red_failing_segment() {
  local fail_file="$1" post_file="$2"
  {
    [ ! -s "$fail_file" ] || awk -F'\t' 'NF >= 2 { print $2 }' "$fail_file"
    [ ! -s "$post_file" ] || awk -F'\t' '$1 != "" { print "post-wave:" $1 }' "$post_file"
  } | awk -v cap=20 '!seen[$0]++ { n++; if (n <= cap) out = out (out == "" ? "" : " ") $0 }
    END { if (n > 0) { printf "; failing: %s", out; if (n > cap) printf " (+%d more)", n - cap } }'
}

smoke_terminal_success_line() {
  local suite="$1" receipt="$2" declared="$3" skip_files="$4" known="$5"
  local total="$6" wall="$7" jobs="$8"
  printf '%s: %s; %s; declared-skips=%s skip-files=%s — ok — all %s files passed (%ss, -j %s)\n' \
    "$suite" "$receipt" "$known" "$declared" "$skip_files" "$total" "$wall" "$jobs"
}

smoke_probe_load1m() {
  "${TAP_PYTHON:-python3}" -I -B -c 'import os; print(f"{os.getloadavg()[0]:.2f}")'
}

# tap-7r3fn.31(b). The tmux server refusing to fork a child is the machine's
# ceiling — a pty or per-user process limit — surfacing as ENXIO, which tmux
# prints as "Device not configured". It says nothing about the file that
# happened to ask for a pane at that moment: the same bytes pass on a quiet
# box. Two sightings on 2026-09-04, one of them a gate arm at load 15.3 with a
# 24-seat team live (tap-7r3fn.31).
#
# The record is written by the runner's own tmux shim (smoke_install_tmux_guard
# above), which is the last thing between a test and the real binary and the
# only place the refusal is observed rather than reported. A file that fails
# for its own reasons keeps failing for its own reasons, and no output a test
# produces can put it in this class.
# Keyed to the FAILING FILE, and read from the shim's ledger rather than the
# file's own output. A test that prints the wording — a fixture, a doc test, a
# quoted incident report — is an ordinary red and stays one.
smoke_load_transient_refusal() {
  local rel="$1" ledger="${SMOKE_ALL_TMUX_GUARD:-}/fork-refusals"
  [ -n "${SMOKE_ALL_TMUX_GUARD:-}" ] && [ -f "$ledger" ] || return 1
  awk -F'\t' -v rel="$rel" \
    '$1 == "TMUX-FORK-REFUSAL" && $2 == rel { found = 1 } END { exit found ? 0 : 1 }' \
    "$ledger"
}

# Full unattended runs require deliberate caller authorization. Keep this ahead
# of sandbox/slot creation; --only and help remain usable by background tooling.
# --probe refusals: a stable error id, the cause, and one recovery line.
smoke_probe_refuse() { # <id> <cause> <recovery> [exit-code]
  printf 'probe: error=%s: %s\nprobe: recovery: %s\n' "$1" "$2" "$3" >&2
  return "${4:-64}"
}

# Resolve the probe source BEFORE any chdir. Sets SMOKE_PROBE_PATH to the
# checkout-logical path of the resolved file. The tmp/<seat>/ rule is workflow
# discipline (a symlink cannot lead out of it), not the safety boundary: the
# boundary is the sandbox, and paths under the real home stay legal.
smoke_probe_resolve() { # <checkout-root> <file>
  local root="$1" file="$2" real tmp_real lex rest seat
  SMOKE_PROBE_PATH=""
  [ -n "$file" ] || { smoke_probe_refuse bad_args "no probe file given" "bash scripts/probe.sh tmp/<seat>/<name>.sh [-- args]"; return; }
  [ -e "$file" ] || { smoke_probe_refuse missing_file "no such file: $file" "save the probe under tmp/<seat>/ and pass its path"; return; }
  [ -f "$file" ] || { smoke_probe_refuse not_regular "not a regular file: $file" "pass a saved .sh, .py or .ts file, not a directory or device"; return; }
  real="$(python3 -I -B -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$file")" && [ -n "$real" ] \
    && tmp_real="$(python3 -I -B -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$root/tmp")" && [ -n "$tmp_real" ] \
    || { smoke_probe_refuse isolation_failed "could not resolve the probe path" "rerun; if it repeats, check python3 on the fixed PATH" 1; return; }
  [ -f "$real" ] || { smoke_probe_refuse not_regular "symlink target is not a regular file: $real" "point the probe at a regular file"; return; }
  # The seat is the directory the caller NAMED; the resolved target must stay
  # inside it, so a symlink cannot reach another seat's files.
  lex="$(python3 -I -B -c 'import os, sys; print(os.path.abspath(sys.argv[1]))' "$file")" && [ -n "$lex" ] \
    || { smoke_probe_refuse isolation_failed "could not resolve the probe path" "rerun; if it repeats, check python3 on the fixed PATH" 1; return; }
  seat=""
  case "$lex" in
    "$root"/tmp/*/*) rest="${lex#"$root"/tmp/}"; seat="${rest%%/*}" ;;
    "$tmp_real"/*/*) rest="${lex#"$tmp_real"/}"; seat="${rest%%/*}" ;;
  esac
  if [ -z "$seat" ]; then
    smoke_probe_refuse path_outside_tmp "$file is not under $root/tmp/<seat>/" "copy the probe to tmp/<seat>/ in the reviewed checkout"; return
  fi
  case "$real" in
    "$tmp_real/$seat"/*) ;;
    *) smoke_probe_refuse path_outside_tmp "$file resolves to $real, outside $root/tmp/$seat/" "copy the probe into tmp/$seat/ in the reviewed checkout"; return ;;
  esac
  case "$real" in
    *.sh|*.py|*.ts) ;;
    *) smoke_probe_refuse unsupported_extension "unsupported extension: $real" "use a .sh, .py or .ts file"; return ;;
  esac
  # The dispatcher substitutes this path through xargs -I, which mishandles
  # quotes, backslashes and long arguments; --list applies the same alphabet.
  case "${real#"$tmp_real"/}" in
    *[!A-Za-z0-9_./-]*) smoke_probe_refuse unsafe_path "path has characters outside [A-Za-z0-9_./-]: $real" "rename the file under tmp/<seat>/"; return ;;
  esac
  SMOKE_PROBE_PATH="$root/tmp/${real#"$tmp_real"/}"
}

smoke_runner_admit() {
  local arg focused=0 parent="$PPID" row next command depth=0 mode
  for arg in "$@"; do
    # A probe's own arguments are data: stop scanning at --probe.
    case "$arg" in --probe) focused=1; break ;; --only|-h|--help) focused=1 ;; esac
  done
  [ "$focused" = 0 ] || return 0
  mode=interactive
  if ! [ -t 0 ] && ! [ -t 1 ] && ! [ -t 2 ]; then
    mode=unattended
  fi
  printf 'smoke-all: invocation pid=%s mode=%s\n' "$$" "$mode" >&2
  # Executable identity only: command arguments can contain credentials or
  # submitted prompts. PIDs preserve the route to deeper operator inspection.
  while [ "$parent" -gt 0 ] && [ "$depth" -lt 32 ]; do
    row="$(ps -p "$parent" -o ppid= -o comm= 2>/dev/null)" || break
    read -r next command <<< "$row"
    printf 'smoke-all: ancestor pid=%s ppid=%s executable=%s\n' "$parent" "$next" "$command" >&2
    case "$next" in ''|*[!0-9]*) break ;; esac
    [ "$next" != "$parent" ] || break
    parent="$next"; depth=$((depth + 1))
  done
  if [ "$mode" = unattended ] && [ "${TAP_RUNNER_ALLOW:-}" != 1 ]; then
    echo 'smoke-all: refusing unattended full suite; an authorized caller must set TAP_RUNNER_ALLOW=1 (use --only for a focused check)' >&2
    return 78
  fi
}

smoke_all_entry() {
  smoke_runner_admit "$@" || return $?
  set -u
  set -o pipefail

  local script root inherited excluded admitted clean_bash candidate utf8_locale charmap
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  root="$(cd "$(dirname "$script")/.." && pwd)"
  # shellcheck source=skills/tap/scripts/smoke/smoke-preflight.sh
  . "$root/skills/tap/scripts/smoke/smoke-preflight.sh"

  # Help is observational only and must not take the slot or require the suite
  # interpreter floors.
  local arg
  for arg in "$@"; do
    case "$arg" in
      --probe) break ;;
      -h|--help) sed -n '2,28p' "$script" | sed 's/^# \{0,1\}//'; return 0 ;;
    esac
  done

  # Capture before env -i so the cited-log evidence survives sanitation.
  inherited="$(smoke_env_inherited)"
  excluded=""
  local name value
  # These two caller inputs share the exact false-green geometry tap-sdqz
  # observed: production has a fallback and the Python suite asserts its value.
  # They are safe scalar preferences, never credentials, so the cited header can
  # prove which ambient value the clean gate survived without logging arbitrary
  # excluded environment data.
  for name in CLAUDE_CODE_SCROLL_SPEED CLAUDE_CODE_TMUX_TRUECOLOR; do
    if [ -n "${!name+x}" ]; then
      value="${!name}"
      [ "${#value}" -le 48 ] || value="${value:0:45}..."
      excluded="${excluded:+$excluded }$name=$value"
    fi
  done

  # The clean child still needs a capable shell. Check the actual invoker before
  # using any bash-4-only suite machinery, so `/bin/bash smoke-all.sh` on macOS
  # refuses rather than quietly re-execing through a newer PATH bash.
  if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
    echo "smoke-preflight: bash >= 4.0 required (running under bash $BASH_VERSION)" >&2
    echo "smoke-preflight: on macOS: brew install bash, then run /opt/homebrew/bin/bash scripts/smoke-all.sh" >&2
    return 1
  fi

  # Preserve the refuse-not-fallback contract before the override becomes
  # one admitted value among the clean child's configuration.
  if [ -n "${TAP_PYTHON+x}" ]; then
    smoke_assert_python "$TAP_PYTHON" || {
      echo "smoke-all: refusing to run the suite through TAP_PYTHON='$TAP_PYTHON' (see above); unset it or point it at a real Python >= 3.12" >&2
      return 1
    }
    # Validation happens on the caller's PATH, but the clean child intentionally
    # receives a different one. Preserve the executable that actually passed the
    # floor check, not a bare command name the fixed PATH may resolve differently
    # (or not at all).
    candidate="$(command -v -- "$TAP_PYTHON" 2>/dev/null || true)"
    [ -n "$candidate" ] && [ -x "$candidate" ] || {
      echo "smoke-all: TAP_PYTHON='$TAP_PYTHON' passed as shell state but is not an external executable" >&2
      return 1
    }
    case "$candidate" in
      /*) ;;
      *) candidate="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")" ;;
    esac
    TAP_PYTHON="$candidate"
  fi

  # Promote only declared identity. Observational identity remains the slot
  # launcher's job and is never relabelled as caller-declared.
  local suite_seat="${TAP_SUITE_SEAT:-}"
  if [ -z "$suite_seat" ]; then
    if [ -n "${TAP_SELF:-}" ]; then
      suite_seat="$TAP_SELF"
    elif [ -n "${TAP_HANDLE:-}" ]; then
      suite_seat="$TAP_HANDLE"
    fi
  fi

  [ -n "${HOME:-}" ] || {
    echo "smoke-all: HOME is required by the suite sandbox" >&2
    return 1
  }

  # Preserve the locale pin's established scope: character classification needs
  # UTF-8, while collation, numbers, time, and messages stay in the deterministic
  # C locale. Resolve a name the host actually provides before env -i; an
  # unavailable UTF-8 name silently degrades Bash's glyph matching to bytes.
  # Input-band readers name NBSP explicitly; the locale only owes UTF-8
  # character handling, not libc-specific POSIX whitespace classification.
  utf8_locale=""
  for candidate in en_US.UTF-8 UTF-8 C.UTF-8 C.utf8; do
    charmap="$(LC_ALL='' LANG=C LC_CTYPE="$candidate" /usr/bin/locale charmap 2>/dev/null || true)"
    case "$charmap" in
      [Uu][Tt][Ff]-8|[Uu][Tt][Ff]8)
        utf8_locale="$candidate"
        break
        ;;
    esac
  done
  [ -n "$utf8_locale" ] || {
    echo "smoke-all: no UTF-8 locale (tried en_US.UTF-8, UTF-8, C.UTF-8, C.utf8)" >&2
    return 1
  }

  # Every invocation owns HOME and the tmux default namespace. Preserve the
  # operator lock location before replacing HOME: the advisory slot is the one
  # intentional machine-wide path and must stay shared across worktrees.
  local operator_home operator_tmux_socket
  operator_home="$(cd "$HOME" && pwd -P)" || return 1
  if [ -n "${TMUX:-}" ]; then
    operator_tmux_socket="${TMUX%%,*}"
  else
    operator_tmux_socket="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/default"
  fi
  if [ -z "${TAP_SUITE_LOCK_HOME+x}" ]; then
    TAP_SUITE_LOCK_HOME="$operator_home/.tap/locks"
  fi
  # An unchecked allocation left the next writes aimed at /operator-tap-home.
  if ! TAP_SUITE_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/smoke-all-sandbox.XXXXXX")" || [ -z "$TAP_SUITE_SANDBOX" ]; then
    if [ "${1:-}" = --probe ]; then
      smoke_probe_refuse isolation_failed "could not allocate the sandbox under ${TMPDIR:-/tmp}" "set TMPDIR to an existing directory outside every checkout" 1
    else
      echo "smoke-all: could not allocate the suite sandbox under ${TMPDIR:-/tmp}" >&2
    fi
    return 1
  fi
  printf '%s\n' "$operator_home/.tap" >"$TAP_SUITE_SANDBOX/operator-tap-home"
  printf '%s\n' "$operator_tmux_socket" >"$TAP_SUITE_SANDBOX/operator-tmux-socket"
  HOME="$TAP_SUITE_SANDBOX/home"
  # tmux appends /tmux-UID/<-L name>; keep its unique root short enough for the
  # 104-byte macOS sun_path ceiling, independent of the descriptive HOME root.
  if ! TMUX_TMPDIR="$(mktemp -d /tmp/tap-tmux.XXXXXX)"; then
    rm -rf "$TAP_SUITE_SANDBOX"
    return 1
  fi
  local tmux_root_physical tmux_budget_path
  tmux_root_physical="$(cd "$TMUX_TMPDIR" && pwd -P)"
  tmux_budget_path="$tmux_root_physical/f.XXXXXX/tmux-$(id -u)/tap-selfstop-123456"
  [ "${#tmux_budget_path}" -lt "$SMOKE_TMUX_SOCKET_LIMIT" ] || {
    echo "smoke-all: tmux socket budget exceeded (${#tmux_budget_path} >= $SMOKE_TMUX_SOCKET_LIMIT): $tmux_budget_path" >&2
    smoke_remove_tmux_root "$TMUX_TMPDIR" || true
    rm -rf "$TAP_SUITE_SANDBOX"
    return 1
  }
  TAP_INDEX_HOME="$TAP_SUITE_SANDBOX/index"
  TAP_SESSION_MANIFEST="$TAP_SUITE_SANDBOX/sessions.json"
  OPENCODE_DB_PATH="$TAP_SUITE_SANDBOX/opencode.db"
  TAP_VERSION_SEEN_PATH="$TAP_SUITE_SANDBOX/version-seen.json"
  mkdir -p "$HOME" "$TAP_INDEX_HOME" "$TMUX_TMPDIR"

  # The report names exactly what crosses. Values here are paths, pins, and
  # suite controls—not arbitrary ambient data or credentials.
  admitted="HOME=$HOME PATH=$SMOKE_ALL_FIXED_PATH TERM=dumb LANG=C LC_CTYPE=$utf8_locale TZ=UTC EPISODIC_MEMORY_SUMMARIZER_GUARD=1"

  local -a clean_env=(
    /usr/bin/env -i
    "HOME=$HOME"
    "PATH=$SMOKE_ALL_FIXED_PATH"
    "TERM=dumb"
    "LANG=C"
    "LC_CTYPE=$utf8_locale"
    "TZ=UTC"
    "EPISODIC_MEMORY_SUMMARIZER_GUARD=1"
  )
  # GitHub uses this non-secret identifier to reap job processes on cancellation.
  # Keep it across env -i so a cancelled job cannot leave a suite on the host.
  if [ -n "${RUNNER_TRACKING_ID:-}" ]; then
    clean_env+=("RUNNER_TRACKING_ID=$RUNNER_TRACKING_ID")
    admitted="$admitted RUNNER_TRACKING_ID=$RUNNER_TRACKING_ID"
  fi
  if [ -n "${TAP_PYTHON+x}" ]; then
    clean_env+=("TAP_PYTHON=$TAP_PYTHON")
    admitted="$admitted TAP_PYTHON=$TAP_PYTHON"
  fi
  # Admit an absolute Bun for smokes that need it (e.g. opencode-sessionstart-bind).
  # Capture before PATH sanitation — ~/.bun/bin is outside SMOKE_ALL_FIXED_PATH.
  if [ -z "${TAP_SMOKE_BUN+x}" ]; then
    _smoke_bun="$(command -v bun 2>/dev/null || true)"
    [ -n "$_smoke_bun" ] && TAP_SMOKE_BUN="$_smoke_bun"
  fi
  if [ -n "${TAP_SMOKE_BUN:-}" ] && [ -x "${TAP_SMOKE_BUN}" ]; then
    clean_env+=("TAP_SMOKE_BUN=$TAP_SMOKE_BUN")
    admitted="$admitted TAP_SMOKE_BUN=$TAP_SMOKE_BUN"
  fi
  # Install-shaped smokes stage the pinned fzf, which otherwise downloads from
  # GitHub in every worker's discarded HOME (a 504 there cost a gate 24 files).
  # Resolve the account's verified archive once -- fzf-archive-pin.sh reads the
  # passwd home, so the sandbox HOME cannot hide it -- and admit the path.
  # install-fzf.ts still checks its sha256; with no cache nothing is admitted
  # and installs download as before.
  local fzf_pin fzf_archive=""
  fzf_pin="$(dirname "$script")/../skills/tap/scripts/smoke/fzf-archive-pin.sh"
  if [ -f "$fzf_pin" ] && [ -n "${TAP_SMOKE_BUN:-}" ]; then
    fzf_archive="$(PATH="$(dirname "$TAP_SMOKE_BUN"):$PATH" bash -c '. "$1" && printf %s "${TAP_FZF_TEST_ARCHIVE:-}"' _ "$fzf_pin" 2>/dev/null || true)"
  fi
  if [ -n "$fzf_archive" ] && [ -f "$fzf_archive" ]; then
    clean_env+=("TAP_FZF_TEST_ARCHIVE=$fzf_archive")
    admitted="$admitted TAP_FZF_TEST_ARCHIVE=$fzf_archive"
  fi
  if [ -n "${TAP_SUITE_LOCK_HOME+x}" ]; then
    clean_env+=("TAP_SUITE_LOCK_HOME=$TAP_SUITE_LOCK_HOME")
    admitted="$admitted TAP_SUITE_LOCK_HOME=$TAP_SUITE_LOCK_HOME"
  fi
  if [ -n "$suite_seat" ]; then
    clean_env+=("TAP_SUITE_SEAT=$suite_seat")
    admitted="$admitted TAP_SUITE_SEAT=$suite_seat"
  fi
  if [ -n "${TAP_SUITE_SLOT+x}" ]; then
    clean_env+=("TAP_SUITE_SLOT=$TAP_SUITE_SLOT")
    admitted="$admitted TAP_SUITE_SLOT=$TAP_SUITE_SLOT"
  fi
  if [ -n "${TAP_SUITE_SLOT_PROBE+x}" ]; then
    clean_env+=("TAP_SUITE_SLOT_PROBE=$TAP_SUITE_SLOT_PROBE")
    admitted="$admitted TAP_SUITE_SLOT_PROBE=$TAP_SUITE_SLOT_PROBE"
  fi
  if [ -n "${SMOKE_ALL_MIN_FILES+x}" ]; then
    clean_env+=("SMOKE_ALL_MIN_FILES=$SMOKE_ALL_MIN_FILES")
    admitted="$admitted SMOKE_ALL_MIN_FILES=$SMOKE_ALL_MIN_FILES"
  fi
  # tap-52ys: which suite directory to run (smoke = the merge gate, regress =
  # the operator-run optional suite). MUST cross the entry boundary: env -i
  # would otherwise strip it and silently run the GATE set under the regress
  # runner's name — a wrong-suite run that reports as a right one.
  if [ -n "${TAP_SUITE_DIR+x}" ]; then
    clean_env+=("TAP_SUITE_DIR=$TAP_SUITE_DIR")
    admitted="$admitted TAP_SUITE_DIR=$TAP_SUITE_DIR"
  fi
  # tap-42v8: LPT is opt-in. Admit the flag through hermetic entry so a
  # caller-set TAP_SUITE_LPT=1 survives env -i (otherwise the opt-in is a no-op).
  if [ -n "${TAP_SUITE_LPT+x}" ]; then
    clean_env+=("TAP_SUITE_LPT=$TAP_SUITE_LPT")
    admitted="$admitted TAP_SUITE_LPT=$TAP_SUITE_LPT"
  fi
  # The opt-in's timing table crosses with it, or the flag always falls back.
  if [ -n "${TAP_SUITE_LPT_TABLE+x}" ]; then
    clean_env+=("TAP_SUITE_LPT_TABLE=$TAP_SUITE_LPT_TABLE")
    admitted="$admitted TAP_SUITE_LPT_TABLE=$TAP_SUITE_LPT_TABLE"
  fi
  # tap-x8ns / tap-lesh: mint a per-run sandbox for every HOME-resolved machine
  # path and admit all four through the entry allowlist. Deny ambient values —
  # inheriting the caller's index/manifest/db/version-seen would re-open the
  # hermeticity hole. Live-arm smokes mint their own fixture markers via
  # per-test overrides after inherit.
  # This per-run TAP_INDEX_HOME stays marker-absent; each worker gets its own born-live index.
  # Prefix is load-bearing: the EXIT trap only deletes paths matching it.
  # Point at sandbox paths but leave the files ABSENT — post-flip production has
  # no launcher manifest (and no opencode db on a clean machine). Seeding an
  # empty sessions.json would flip doctor/init existence branches the real
  # machine never takes. version-seen.json is the same shape (tap-lesh): path
  # set, file absent — expanduser("~") must never see the operator store.
  clean_env+=("TAP_SUITE_SANDBOX=$TAP_SUITE_SANDBOX")
  clean_env+=("TAP_INDEX_HOME=$TAP_INDEX_HOME")
  clean_env+=("TAP_SESSION_MANIFEST=$TAP_SESSION_MANIFEST")
  clean_env+=("OPENCODE_DB_PATH=$OPENCODE_DB_PATH")
  clean_env+=("TAP_VERSION_SEEN_PATH=$TAP_VERSION_SEEN_PATH")
  clean_env+=("TMUX_TMPDIR=$TMUX_TMPDIR")
  admitted="$admitted TAP_SUITE_SANDBOX=$TAP_SUITE_SANDBOX TAP_INDEX_HOME=$TAP_INDEX_HOME TAP_SESSION_MANIFEST=$TAP_SESSION_MANIFEST OPENCODE_DB_PATH=$OPENCODE_DB_PATH TAP_VERSION_SEEN_PATH=$TAP_VERSION_SEEN_PATH TMUX_TMPDIR=$TMUX_TMPDIR"

  clean_bash=""
  for candidate in \
    /opt/homebrew/bin/bash \
    /usr/local/bin/bash \
    /usr/bin/bash \
    /bin/bash
  do
    if [ -x "$candidate" ]; then
      clean_bash="$candidate"
      break
    fi
  done
  [ -n "$clean_bash" ] || {
    echo "smoke-all: no bash executable found in the fixed suite PATH" >&2
    return 1
  }

  # Source detection is the internal boundary—there is no ambient marker a
  # caller can forge to skip env -i. Direct execution always enters here;
  # the clean child sources this file and calls the body explicitly.
  # env -i already excludes both values from workers. This explicit scrub is
  # entry defense in depth; admitted TMUX_TMPDIR above is the isolation mechanism.
  unset TMUX TMUX_PANE
  local entry_pid="" rc=0 entry_signal=0
  trap 'entry_signal=143; smoke_signal_live_child "$entry_pid" TERM' TERM
  trap 'entry_signal=130; smoke_signal_live_child "$entry_pid" INT' INT
  trap 'entry_signal=129; smoke_signal_live_child "$entry_pid" HUP' HUP
  # Async shell children otherwise inherit SIGINT ignored. Reset it before
  # exec so the clean Bash body's own signal traps still handle Ctrl-C.
  "${clean_env[@]}" "${TAP_PYTHON:-python3}" -I -B -c '
import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGQUIT, signal.SIG_DFL)
os.execv(sys.argv[1], sys.argv[1:])
' "$clean_bash" -c '
    . "$1"
    shift
    smoke_all_main "$@"
  ' _ "$script" "$inherited" "$excluded" "$admitted" "$@" &
  entry_pid=$!
  # A signal during launch was recorded before the PID became available.
  case "$entry_signal" in
    143) smoke_signal_live_child "$entry_pid" TERM ;;
    130) smoke_signal_live_child "$entry_pid" INT ;;
    129) smoke_signal_live_child "$entry_pid" HUP ;;
  esac
  # wait is interruptible; a trap forwards to the recorded child and then waits
  # for its cleanup before deleting the sandbox it still owns.
  while :; do
    wait "$entry_pid"; rc=$?
    [ "$(jobs -pr)" = "$entry_pid" ] || break
  done
  trap - TERM INT HUP
  [ "$entry_signal" = 0 ] || rc="$entry_signal"
  case "$TAP_SUITE_SANDBOX" in
    "${TMPDIR:-/tmp}"/smoke-all-sandbox.*) rm -rf "$TAP_SUITE_SANDBOX" ;;
  esac
  smoke_remove_tmux_root "$TMUX_TMPDIR" || true
  return "$rc"
}

smoke_all_main() {
set -u
set -o pipefail

TAP_ENV_INHERITED="$1"
TAP_ENV_EXCLUDED_ASSERTED_DEFAULTS="$2"
TAP_ENV_ADMITTED="$3"
shift 3

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IGNORED_STATE_TRIPWIRE="$ROOT/scripts/ignored-state-tripwire.py"

# shellcheck source=skills/tap/scripts/smoke/smoke-preflight.sh
. "$ROOT/skills/tap/scripts/smoke/smoke-preflight.sh"

# Once only: the slot launcher marks both acquired and contended children as
# checked, which prevents the re-invoked body from printing this warning twice.
if [ "${TAP_SUITE_SLOT_CHECKED:-0}" != "1" ]; then
  smoke_warn_output_in_tree "$ROOT"
fi

# Help must not take the machine-wide slot.
#
# tap-h37qp: neither must a ONE-FILE run. The slot is acquired below, before
# argument parsing, so `--only <file>` used to print `suite-slot: advisory slot
# acquired` before this script knew it was running one file. A 3-second focused
# run then entered the same machine-wide contention as a 350-second gate, and a
# peer's ordinary lease release inside that window fired the post-wave
# operator-state guard on whichever run was still going.
#
# Detected HERE, in the same pre-acquisition scan `-h` already uses, rather than
# by moving the acquisition below the parser: the parser is 60 lines further on
# and the acquisition `exec`s, so relocating it would reorder the hermetic-entry
# boundary. This scan is deliberately LOOSER than the parser — it only asks
# whether `--only` appears at all, and the parser below still owns validation,
# the missing-argument error, and the unknown-flag refusal. A malformed
# `--only` therefore skips the slot and is refused by the parser, which is the
# correct order: refusing an argument needs no machine-wide lease.
#
# THAT CLAUSE IS THE JUSTIFICATION, not a description of what happens. A reader
# who meets a loose scan beside a stricter parser will want to collapse the
# duplication — and the only way to collapse it is to move validation up here or
# push this check down there, the second of which reintroduces exactly the
# acquisition-before-parse ordering this comment exists to fix. The duplication
# is the point: the slot decision must be answerable before any argument is
# validated, because validating an argument is not work that needs the machine.
_only_seen=0
for _arg in "$@"; do
  case "$_arg" in
    --probe) _only_seen=1; break ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --only) _only_seen=1 ;;
  esac
done

# tap-52ys: this runner drives BOTH suites. The set it runs is a directory,
# not a manifest — skills/*/scripts/smoke/ is the merge gate, and
# skills/*/scripts/regress/ is the optional operator-run suite. A file's
# bucket is where it lives, so there is no list to drift out of sync and no
# per-file marker to forget. regress-all.sh sets TAP_SUITE_DIR=regress and
# execs this script; everything below (slot, hermetic entry, ledger, receipt)
# is shared and unaware of which suite it is running.
SUITE_DIR="${TAP_SUITE_DIR:-smoke}"
case "$SUITE_DIR" in
  smoke) SUITE_NAME="smoke-all" ;;
  regress) SUITE_NAME="regress-all" ;;
  *) echo "smoke-all: TAP_SUITE_DIR must be 'smoke' or 'regress', got '$SUITE_DIR'" >&2; exit 64 ;;
esac

# Observe the advisory slot before scheduling. The Python launcher either
# holds the flock or marks the child contended; controlled probes still refuse.
case "${TAP_SUITE_SLOT:-}" in
  bypass)
    echo "smoke-all: WARNING: TAP_SUITE_SLOT=bypass — suite slot NOT acquired (disaster recovery only)" >&2
    ;;
  *)
    # TAP_SUITE_SLOT_HELD=1 means a suite-slot-run parent already holds the
    # flock and re-invoked us — skip re-acquire. Exception: PROBE mode must
    # always exercise acquire (suite-slot.test.sh), even when nested under a
    # live outer suite that exported HELD into the worker environment — otherwise
    # the probe skips the launcher and runs the full suite nested (tap-ejpf).
    _need_slot=0
    if [ "${TAP_SUITE_SLOT_PROBE:-}" = "1" ]; then
      _need_slot=1
    elif [ "${TAP_SUITE_SLOT_CHECKED:-0}" != "1" ]; then
      _need_slot=1
    fi
    # tap-h37qp: a one-file run needs no machine-wide lease. PROBE mode is
    # deliberately NOT exempted above — suite-slot.test.sh must still exercise
    # acquire, and it drives the probe rather than --only.
    if [ "$_only_seen" = 1 ] && [ "${TAP_SUITE_SLOT_PROBE:-}" != "1" ]; then
      _need_slot=0
    fi
    if [ "$_need_slot" = 1 ]; then
      # tap-h3p4: an INHERITED TAP_PYTHON is exec'd here, before the preflight's
      # floor check ever runs. `TAP_PYTHON=true` made this whole script exit 0
      # with ZERO output and ZERO tests: `true` ignores its arguments and
      # succeeds, so the suite "passed" without running. The merge gate reads
      # that as green.
      #
      # smoke_assert_python already exists for exactly this -- its own comment
      # names `TAP_PYTHON=true` -- and this path simply never called it. Refuse
      # rather than fall back: a caller who set TAP_PYTHON meant it, and
      # silently substituting python3 would hide the broken override instead of
      # reporting it.
      PY="${TAP_PYTHON:-python3}"
      smoke_assert_python "$PY" || {
        echo "smoke-all: refusing to run the suite through TAP_PYTHON='$PY' (see above); unset it or point it at a real Python >= 3.12" >&2
        exit 1
      }
      # The entry boundary already promoted declared identity and removed any
      # caller-forged HELD/PID state. The slot parent adds fresh internal state,
      # then invokes the same sourceable body without reopening the ambient
      # environment.
      exec "$PY" -B "$ROOT/scripts/suite-slot-run.py" -- bash -c '
        . "$1"
        shift
        smoke_all_main "$@"
      ' _ "${BASH_SOURCE[0]}" "$TAP_ENV_INHERITED" "$TAP_ENV_EXCLUDED_ASSERTED_DEFAULTS" "$TAP_ENV_ADMITTED" "$@"
    fi
    ;;
esac

JOBS=""
ONLY=""
SELECTED_LIST=""
PROBE_SET=0
PROBE=""
PROBE_ARGV=()
while [ $# -gt 0 ]; do
  case "$1" in
    # Everything after the file is the probe's own literal argv, so no later
    # token is parsed as a runner flag.
    --probe) PROBE_SET=1; shift
        PROBE="${1:-}"; [ $# -eq 0 ] || shift
        [ "${1:-}" != -- ] || shift
        PROBE_ARGV=("$@"); set -- ;;
    -j) [ $# -ge 2 ] || { echo "smoke-all: -j needs a number (usage: bash scripts/smoke-all.sh [-j N])" >&2; exit 64; }
        JOBS="$2"; shift 2 ;;
    -j*) JOBS="${1#-j}"; shift ;;
    --only) [ -z "$ONLY" ] || { echo "smoke-all: --only was given more than once; it takes one file (pass several with --list <path>)" >&2; exit 64; }
        [ $# -ge 2 ] && [ -n "$2" ] || { echo "smoke-all: --only needs one nonempty smoke file" >&2; exit 64; }
        ONLY="$2"; shift 2 ;;
    --list) [ $# -ge 2 ] && [ -n "$2" ] && [ -z "$SELECTED_LIST" ] || { echo "smoke-all: --list needs one nonempty list path" >&2; exit 64; }
        SELECTED_LIST="$2"; shift 2 ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "smoke-all: unknown argument '$1' (usage: bash scripts/smoke-all.sh [-j N])" >&2; exit 64 ;;
  esac
done
[ -z "$ONLY" ] || [ -z "$SELECTED_LIST" ] || { echo 'smoke-all: --only and --list are mutually exclusive' >&2; exit 64; }
if [ "$PROBE_SET" = 1 ]; then
  [ -z "$ONLY$SELECTED_LIST$JOBS" ] || { smoke_probe_refuse bad_args "--probe takes no other runner flag" "bash scripts/probe.sh tmp/<seat>/<name>.sh [-- args]"; exit 64; }
  smoke_probe_resolve "$ROOT" "$PROBE" || exit $?
  # Scratch must sit outside every enrolled checkout; an operator TMPDIR inside
  # a worktree would put the probe's cwd there.
  _probe_sandbox="$(python3 -I -B -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$TAP_SUITE_SANDBOX")" && [ -n "$_probe_sandbox" ] \
    && _probe_root="$(python3 -I -B -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$ROOT")" && [ -n "$_probe_root" ] \
    || { smoke_probe_refuse isolation_failed "could not resolve the sandbox path" "rerun; if it repeats, check python3 on the fixed PATH" 1; exit 1; }
  case "$_probe_sandbox/" in
    "$_probe_root"/*) smoke_probe_refuse isolation_failed "sandbox $_probe_sandbox is inside the checkout $_probe_root" "unset TMPDIR or point it outside every checkout" 1; exit 1 ;;
  esac
  # Outside EVERY checkout, not only this one: a sandbox inside another git
  # tree would dirty it for the length of the probe.
  if git -C "$_probe_sandbox" rev-parse --show-toplevel >/dev/null 2>&1; then
    smoke_probe_refuse isolation_failed "sandbox $_probe_sandbox is inside a git checkout" "unset TMPDIR or point it outside every checkout" 1; exit 1
  fi
fi
_suite_cores="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
case "$_suite_cores" in ''|*[!0-9]*) _suite_cores=4 ;; esac
case "$JOBS" in
  '') JOBS=$(( _suite_cores < 12 ? _suite_cores : 12 )) ;;
  *[!0-9]*|0) echo "smoke-all: -j must be a positive integer, got '$JOBS'" >&2; exit 64 ;;
esac

_suite_load="${TAP_SUITE_LOAD1M:-$(smoke_probe_load1m)}"
_suite_high_load="$(awk -v load1m="$_suite_load" -v cores="$_suite_cores" 'BEGIN { print (load1m >= cores) ? 1 : 0 }')"
if [ "${TAP_SUITE_SLOT_CONTENDED:-0}" = "1" ] || [ "$_suite_high_load" = "1" ]; then
  _suite_reduced=$(( (_suite_cores + 1) / 2 ))
  [ "$JOBS" -le "$_suite_reduced" ] || JOBS="$_suite_reduced"
fi
_suite_load_line="smoke-all: suite-load load1m=$_suite_load cores=$_suite_cores contended=${TAP_SUITE_SLOT_CONTENDED:-0} jobs=$JOBS"
echo "$_suite_load_line"

# Scheduling hint ONLY — known-slow files start first so wall time tracks the
# longest file rather than an unlucky tail. Correctness never depends on this
# list: files not listed here run after it in glob order, stale entries are
# skipped silently.
#
# Start measured long files before the glob remainder. In the September 5 CI
# receipts, team-refresh-parity took 95–98s. Replaying the measured durations
# places it about 145s into the run and makes it the final ordinary worker,
# even though courier-busy-hold took longer.
# This refresh keeps the existing static ordering policy and legacy priorities.
SLOW_FIRST="
bun-router
courier-busy-hold
team-refresh-parity
courier-auto-settle
delivery-window-drain
team-only-driven
pane-state-detector
wave-session-reap
goalie-working-zero
health-differential
session-pytest
register-collision
reply-settles-after-send
submit-verify
command-mode
defer-spool
"

OUTDIR="$(mktemp -d)"
# Only stop sockets beneath and remove paths minted by this invocation.
trap 'trap "" INT TERM HUP; smoke_all_cleanup "$OUTDIR" "${TAP_SUITE_SANDBOX:-}" "${TMUX_TMPDIR:-}"' EXIT
# A signal must still run the EXIT trap: workers are outside the terminal's
# foreground group, so cleanup is the only thing that reaches them (R-C1).
trap 'exit 130' INT
trap 'exit 143' TERM
[ -n "${TAP_INDEX_HOME:-}" ] && [ -n "${TAP_SESSION_MANIFEST:-}" ] && [ -n "${OPENCODE_DB_PATH:-}" ] && [ -n "${TAP_VERSION_SEEN_PATH:-}" ] || {
  echo "smoke-all: HOME-resolved sandbox vars missing after hermetic entry — entry allowlist gap (need TAP_INDEX_HOME TAP_SESSION_MANIFEST OPENCODE_DB_PATH TAP_VERSION_SEEN_PATH)" >&2
  exit 1
}
mkdir -p "$TAP_INDEX_HOME" "$TMUX_TMPDIR"
export TAP_SUITE_SANDBOX TAP_INDEX_HOME TAP_SESSION_MANIFEST OPENCODE_DB_PATH TAP_VERSION_SEEN_PATH TMUX_TMPDIR
echo "smoke-all: run ownership roots below; worker-roots receipts name each private allocation"
echo "smoke-all: TAP_INDEX_HOME=$TAP_INDEX_HOME (per-run; marker absent; workers get born-live per-file indexes)"
echo "smoke-all: TAP_SESSION_MANIFEST=$TAP_SESSION_MANIFEST"
echo "smoke-all: OPENCODE_DB_PATH=$OPENCODE_DB_PATH"
echo "smoke-all: TAP_VERSION_SEEN_PATH=$TAP_VERSION_SEEN_PATH"

LIST="$OUTDIR/list"
: > "$LIST"
# Match Bun discovery in runtime/bun, including colocated tests. Do not import
# files to list them: test module setup can itself have effects.
BUN_LIST="$OUTDIR/bun-list"
: > "$BUN_LIST"
if [ "$SUITE_DIR" = smoke ] && [ "$PROBE_SET" = 0 ]; then
  python3 -I -B - "$ROOT/runtime/bun" > "$BUN_LIST" <<'PY'
import os, re, sys
root = sys.argv[1]
for directory, dirs, files in os.walk(root):
    dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "node_modules")
    for name in sorted(files):
        if not re.search(r"[._](test|spec)\.(?:[cm]?[jt]s|[jt]sx)$", name):
            continue
        path = os.path.join(directory, name)
        if not os.path.isfile(path) or os.path.islink(path) or not re.fullmatch(r"[A-Za-z0-9_./-]+", os.path.relpath(path, root)):
            raise SystemExit("smoke-all: Bun test must be an ordinary file with a safe relative path: " + path)
        print(path)
PY
  [ "$?" = 0 ] || exit 64
fi
if [ "$PROBE_SET" = 1 ]; then
  # A probe is not a suite member: the resolver above already vetted the file.
  printf '%s\n' "$SMOKE_PROBE_PATH" >"$LIST"
  SUITE_NAME="probe"
elif [ -n "$ONLY" ] || [ -n "$SELECTED_LIST" ]; then
  _selected_input="$OUTDIR/selected-input"
  if [ -n "$ONLY" ]; then
    printf '%s\n' "$ONLY" >"$_selected_input"
    SUITE_NAME="$SUITE_DIR-one"
  else
    [ -f "$SELECTED_LIST" ] && cat "$SELECTED_LIST" >"$_selected_input" || { echo "smoke-all: unreadable selection list: $SELECTED_LIST" >&2; exit 64; }
    SUITE_NAME="$SUITE_DIR-selected"
  fi
  while IFS= read -r _selected_file || [ -n "$_selected_file" ]; do
    if [ -n "$SELECTED_LIST" ]; then
      case "$_selected_file" in ''|/*|*[!A-Za-z0-9_./-]*) echo "smoke-all: invalid repo-relative selected path: $_selected_file" >&2; exit 64 ;; esac
    fi
    case "$_selected_file" in /*) _only_candidate="$_selected_file" ;; *) _only_candidate="$ROOT/$_selected_file" ;; esac
    [ -f "$_only_candidate" ] || { echo "smoke-all: selected file not found: $_selected_file" >&2; exit 64; }
    if [ -n "$SELECTED_LIST" ] && [ -L "$_only_candidate" ]; then
      echo "smoke-all: selected test must be an ordinary file: $_selected_file" >&2; exit 64
    fi
    _only_physical="$(cd "$(dirname "$_only_candidate")" && pwd -P)/$(basename "$_only_candidate")"
    _root_physical="$(cd "$ROOT" && pwd -P)"
    _only_path="$ROOT/${_only_physical#"$_root_physical"/}"
    _selected_member=0
    for _suite_file in "$ROOT"/skills/*/scripts/"$SUITE_DIR"/*.test.sh; do
      if [ "$_suite_file" = "$_only_path" ]; then _selected_member=1; break; fi
    done
    grep -qxF "$_only_path" "$BUN_LIST" && _selected_member=1
    [ "$_selected_member" = 1 ] || { echo "smoke-all: selected path is not a suite member: $_selected_file" >&2; exit 64; }
    if grep -qxF "$_only_path" "$LIST"; then
      echo "smoke-all: duplicate selected test: $_selected_file" >&2; exit 64
    fi
    printf '%s\n' "$_only_path" >>"$LIST"
    [ -z "$SELECTED_LIST" ] || printf '%s: selected-file=%s rule=explicit-list\n' "$SUITE_NAME" "${_only_path#"$ROOT"/}"
  done <"$_selected_input"
else
  for name in $SLOW_FIRST; do
    for s in "$ROOT"/skills/*/scripts/"$SUITE_DIR"/"$name".test.sh; do
      [ -f "$s" ] && printf '%s\n' "$s" >> "$LIST"
    done
  done
  for s in "$ROOT"/skills/*/scripts/"$SUITE_DIR"/*.test.sh; do
    [ -f "$s" ] || continue   # empty glob leaves the literal pattern
    # Its Bun children now occupy this same pool. Keep the aggregate available
    # only for explicit invocations, never run every child a second time here.
    [ "$s" != "$ROOT/skills/tap/scripts/smoke/bun-suite.test.sh" ] || continue
    grep -qxF "$s" "$LIST" || printf '%s\n' "$s" >> "$LIST"
  done
  cat "$BUN_LIST" >> "$LIST"
fi

ESCAPE_LINT="$OUTDIR/tmux-escape-lint"
LINT_LIST="$OUTDIR/lint-list"
: >"$LINT_LIST"
for s in "$ROOT"/skills/*/scripts/{smoke,regress}/*.test.sh; do
  [ -f "$s" ] && printf '%s\n' "$s" >>"$LINT_LIST"
done
mapfile -t _lint_files <"$LINT_LIST"
# The suite-source lint polices suite files, not the boundary; a probe skips it.
if [ "$PROBE_SET" = 1 ]; then
  : >"$ESCAPE_LINT"
elif smoke_escape_lint "${_lint_files[@]}" >"$ESCAPE_LINT" 2>&1; then
  if [ -s "$ESCAPE_LINT" ]; then
    echo "smoke-all: reconstruction notes (detection only; post-wave predicates own effects)"
    cat "$ESCAPE_LINT"
  fi
else
  echo "smoke-all: refusing unsafe suite source before workers" >&2
  cat "$ESCAPE_LINT" >&2
  exit 1
fi

# Longest-processing-time scheduling (tap-42v8): OPT-IN via TAP_SUITE_LPT=1 with
# TAP_SUITE_LPT_TABLE naming a Markdown timing table (rows: | `path` | seconds |).
# Default is SLOW_FIRST order (hand list of known-slow files, then glob
# remainder) — not pure discovery/alphabetical. An earlier always-on LPT packed
# unknowns first and overrode SLOW_FIRST by measured duration, which made the
# merge gate nondeterministic. Keep the table and reorder code; the flag is
# how we measure whether to come back (re-enable criteria: full-skills
# baseline, pane races fixed, five consecutive LPT runs green with identical
# empty failing sets on an idle machine; reconcile SLOW_FIRST vs table rather
# than stacking a third schedule).
# Three states, three DISTINCT announces — never share an observable across
# flag-off and flag-on+parse-failed (silent-fallback defect through a new door).
LPT_TABLE="${TAP_SUITE_LPT_TABLE:-}"
LPT_ORDER="$OUTDIR/lpt-order"
LPT_META="$OUTDIR/lpt-meta"
if [ "${TAP_SUITE_LPT:-}" != "1" ]; then
  echo "smoke-all: LPT opt-in unset — using default (SLOW_FIRST) order"
elif [ -z "$LPT_TABLE" ] || [ ! -f "$LPT_TABLE" ]; then
  echo "smoke-all: LPT opt-in set but table absent/unparsed at $LPT_TABLE — using default (SLOW_FIRST) order"
elif python3 -I -B - "$LIST" "$LPT_TABLE" "$ROOT" "$LPT_META" >"$LPT_ORDER" <<'PY'
import re, sys
list_path, table_path, root, meta_path = sys.argv[1:]
root = root.rstrip("/") + "/"
known = {}
for line in open(table_path, encoding="utf-8"):
    match = re.match(r"\| `([^`]+)` \| ([0-9]+) \|", line)
    if match:
        known[match.group(1)] = int(match.group(2))
paths = [line.rstrip("\n") for line in open(list_path, encoding="utf-8") if line.strip()]

def rel(path: str) -> str:
    return path[len(root):] if path.startswith(root) else path

unknown = [p for p in paths if rel(p) not in known]
known_paths = [p for p in paths if rel(p) in known]
if not known:
    open(meta_path, "w", encoding="utf-8").write("unparsed\n")
    sys.exit(2)
for path in unknown + sorted(known_paths, key=lambda p: (-known[rel(p)], paths.index(p))):
    print(path)
open(meta_path, "w", encoding="utf-8").write(f"{len(known_paths)} {len(paths)}\n")
PY
then
  read -r lpt_known lpt_total <"$LPT_META" || true
  mv "$LPT_ORDER" "$LIST"
  echo "smoke-all: LPT order active (${lpt_known:-?}/${lpt_total:-?} files from $LPT_TABLE)"
else
  rm -f "$LPT_ORDER"
  echo "smoke-all: LPT opt-in set but table absent/unparsed at $LPT_TABLE — using default (SLOW_FIRST) order"
fi

total="$(wc -l < "$LIST" | tr -d ' ')"
[ "$total" -gt 0 ] || { echo "$SUITE_NAME: no test files found under $ROOT/skills/*/scripts/$SUITE_DIR/" >&2; exit 1; }

# Discovery-shrink tripwire: the per-file ledger only
# protects against EXECUTION drops — a broken glob or LIST build that silently
# discovers too few files would otherwise green the gate on a partial suite.
# Floor, not exact count, so adding tests never touches this line. Override
# exists solely for self-tests of this script against tiny synthetic trees.
#
# The mixed pool starts with 559 files. Its 500-file floor detects loss of
# either discovery branch. Re-derive the floor when the set changes on purpose;
# a floor above the real count deliberately refuses every full run.
if [ -n "$ONLY" ] || [ -n "$SELECTED_LIST" ] || [ "$PROBE_SET" = 1 ]; then
  MIN_FILES=1
else
  case "$SUITE_DIR" in
    smoke)   MIN_FILES="${SMOKE_ALL_MIN_FILES:-500}" ;; # 368 shell + 191 Bun at introduction
    regress) MIN_FILES="${SMOKE_ALL_MIN_FILES:-50}" ;;
  esac
fi
[ "$total" -ge "$MIN_FILES" ] || {
  echo "$SUITE_NAME: discovery shrink — found only $total test files, expected >= $MIN_FILES; refusing to gate on a partial suite" >&2
  exit 1
}

# Interpreter floors (tap-w0t3): assert python >= 3.12 AND bash >= 4 before
# running any test. The 3.12 test floor is what the benign-vocab lint's f-string
# scan needs (FSTRING_MIDDLE); macOS also ships bash 3.2 (/bin/bash) and an old
# python (/usr/bin/python3) that break smokes (mapfile, 'str | None' syntax).
# RUNTIME support for launcher.py stays 3.10+ — this floor is the TEST suite's.
# Fail loud with the named fix so per-box reds don't recur in every lane's evidence.
smoke_preflight_check || exit 1

# Export the resolved python (>= 3.12) so smokes that invoke launcher.py or run
# unittest use the floor-compliant interpreter instead of bare python3 (which
# may be an older system python). Smokes reference it as ${TAP_PYTHON:-python3}.
# Entry already validates and absolutizes an explicit interpreter. Preserve it:
# resolving again here would discard a virtualenv and its test dependencies.
TAP_PYTHON="${TAP_PYTHON:-$(smoke_resolve_python)}"
export TAP_PYTHON

echo "smoke-all: $total files, -j $JOBS"
# tap-h3p4: on stdout, beside the header, so a contaminated run is visible in
# the CITED LOG rather than requiring the reader to know what was in someone's
# shell an hour ago.
if [ -n "$TAP_ENV_INHERITED" ]; then
  echo "smoke-all: inherited TAP_* from the launching shell: $TAP_ENV_INHERITED"
else
  echo "smoke-all: inherited TAP_*: none"
fi
if [ -n "$TAP_ENV_EXCLUDED_ASSERTED_DEFAULTS" ]; then
  echo "smoke-all: excluded asserted-default env: $TAP_ENV_EXCLUDED_ASSERTED_DEFAULTS"
else
  echo "smoke-all: excluded asserted-default env: none"
fi
echo "smoke-all: admitted entry env: $TAP_ENV_ADMITTED"
echo "smoke-all: resolved worker env: TAP_PYTHON=$TAP_PYTHON"
SMOKE_ALL_REAL_TMUX="$(command -v tmux 2>/dev/null || true)"
[ -n "$SMOKE_ALL_REAL_TMUX" ] || { echo "smoke-all: tmux not found in fixed PATH" >&2; exit 1; }
SMOKE_ALL_TMUX_GUARD="$TAP_SUITE_SANDBOX/tmux-guard"
SMOKE_TMUX_ESCAPE_MARKER="$OUTDIR/tmux-escapes.tsv"
: >"$SMOKE_TMUX_ESCAPE_MARKER"
smoke_install_tmux_guard "$SMOKE_ALL_TMUX_GUARD" "$SMOKE_ALL_REAL_TMUX" \
  "$TMUX_TMPDIR" "$SMOKE_TMUX_ESCAPE_MARKER"
export SMOKE_ALL_TMUX_GUARD SMOKE_TMUX_ESCAPE_MARKER

SMOKE_OPERATOR_TAP_HOME="$(cat "$TAP_SUITE_SANDBOX/operator-tap-home")"
SMOKE_OPERATOR_TMUX_SOCKET="$(cat "$TAP_SUITE_SANDBOX/operator-tmux-socket")"
SMOKE_OPERATOR_BEFORE="$OUTDIR/operator-state-before.json"
SMOKE_OPERATOR_AFTER="$OUTDIR/operator-state-after.json"
SMOKE_TMUX_BEFORE="$OUTDIR/operator-tmux-before"
SMOKE_TMUX_AFTER="$OUTDIR/operator-tmux-after"
SMOKE_FIXTURE_SESSION_NAMES="$SMOKE_ALL_TMUX_GUARD/session-names"
SMOKE_WAVE_PIDS="$OUTDIR/wave-pids"
SMOKE_WAVE_HANDLES="$OUTDIR/wave-handles"
SMOKE_WAVE_PANES="$OUTDIR/wave-panes"
SMOKE_WAVE_ROOTS="$OUTDIR/wave-roots"
SMOKE_REDIRECTED_PATHS="$OUTDIR/redirected-paths"
SMOKE_PEER_OWNED_PATHS="$OUTDIR/peer-owned-paths"
: >"$SMOKE_WAVE_PIDS"
: >"$OUTDIR/wave-done"
: >"$SMOKE_WAVE_HANDLES"
: >"$SMOKE_WAVE_PANES"
: >"$SMOKE_WAVE_ROOTS"
: >"$SMOKE_REDIRECTED_PATHS"
# tap-h37qp: paths a CONCURRENT SUITE legitimately deletes. This is NOT the
# redirected-paths list, which reports its own violation class; this one
# suppresses the deletion arm outright.
#
# Every other arm of smoke_operator_state_predicate establishes THIS wave as
# the actor by matching one of its identifiers: a wave pid or handle inside a
# lock, this run's root in a registry row. Its success line says so — "no
# attributable violation". The deletion arm alone has no actor test: the file
# is gone, therefore this run deleted it.
#
# For locks/smoke-all.lease.json that inference is false under concurrency.
# suite_slot.py owns the path (LEASE_NAME, its only writer) and clear_lease()
# unlinks it in a finally on every holding exit, while TAP_SUITE_LOCK_HOME is
# shared machine-wide — so a peer suite finishing inside this run's window
# removes it and the survivor reports a violation it did not commit. That
# produced rc=1 with every file passing on two RETAIN-LIST receipts on
# 2026-08-27.
#
# WHAT THIS GIVES UP, stated rather than left to be found: a real sandbox
# escape deleting exactly this path is no longer caught by this arm. The arm
# could not distinguish that from a peer's correct release anyway, so it was
# never evidence — only noise that occasionally coincided with truth.
#
# Scope is the lease ONLY. smoke-all.lock is documented permanent by design
# (suite_slot.py: release "never unlinks this path"), so its disappearance is
# genuinely anomalous and must keep firing.
: >"$SMOKE_PEER_OWNED_PATHS"
printf '%s\n' "locks/smoke-all.lease.json" >>"$SMOKE_PEER_OWNED_PATHS"
[ -n "${TAP_SUITE_SEAT:-}" ] && printf '%s\n' "$TAP_SUITE_SEAT" >"$SMOKE_WAVE_HANDLES"
case "${TAP_SUITE_SLOT_PID:-}" in ''|*[!0-9]*) ;; *) printf '%s\n' "$TAP_SUITE_SLOT_PID" >>"$SMOKE_WAVE_PIDS" ;; esac
smoke_operator_state_snapshot "$SMOKE_OPERATOR_TAP_HOME" "$SMOKE_OPERATOR_BEFORE" || {
  echo "smoke-all: could not snapshot operator TAP home before workers: $SMOKE_OPERATOR_TAP_HOME" >&2
  exit 1
}
smoke_tmux_state_snapshot "$SMOKE_ALL_REAL_TMUX" "$SMOKE_OPERATOR_TMUX_SOCKET" "$SMOKE_TMUX_BEFORE"

start="$(date +%s)"

# tap-1f45b: pin the checkout BEFORE the wave so a straddled run can be
# detected, and write the pin under OUTDIR — an instrument that dirties the
# tree it measures reports its own footprint as the mutation. An unversioned
# or unreadable checkout writes the `unpinnable` sentinel, which is an ENDPOINT
# STATE rather than an exemption: it compares equal to a finish
# that is also unresolvable — the checkout this check has nothing to say about,
# which the receipt already admits as `unversioned`/`unverified` — and straddles
# against a finish that resolves, because a head appearing inside the worker
# window is a commit landing under the run.
if ! printf '%s %s\n' \
  "$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null || printf 'unpinnable')" \
  "$(git -C "$ROOT" rev-parse --verify 'HEAD^{tree}' 2>/dev/null || printf 'unpinnable')" \
  >"$OUTDIR/start-pin"; then
  echo "smoke-all: could not record the pre-wave checkout pin" >&2
  exit 1
fi

IGNORED_STATE_BEFORE="$OUTDIR/ignored-state-before.json"
IGNORED_STATE_FAILURES="$OUTDIR/ignored-state-failures.out"
IGNORED_STATE_SUMMARY="$OUTDIR/ignored-state-summary"
: >"$IGNORED_STATE_FAILURES"
if [ ! -f "$IGNORED_STATE_TRIPWIRE" ] \
  || ! "${TAP_PYTHON:-python3}" -B "$IGNORED_STATE_TRIPWIRE" snapshot "$ROOT" "$IGNORED_STATE_BEFORE"; then
  echo "$SUITE_NAME: could not snapshot ignored checkout state before workers: $ROOT/.tap" >&2
  exit 1
fi

# Each worker buffers its file's output and appends one line to the pass/fail
# ledger (single short O_APPEND writes — atomic under concurrency).
# BSD xargs -I caps the replaced arg at ~255 bytes and both BSD/GNU
# special-case quotes/backslashes: fine while test paths stay short and
# strictly [a-z0-9-]-named, which the suite's naming convention enforces.
export SMOKE_ALL_OUT="$OUTDIR" SMOKE_ALL_ROOT="$ROOT" SMOKE_WAVE_PIDS
export SMOKE_ALL_TIMINGS="$OUTDIR/timings"
# CHANGE SCOPING (tap-x45ge): the RUNNER resolves the git-side decision ONCE, so
# no test re-derives it and they cannot disagree. Every ambiguity resolves to
# `run` -- coverage-safe fail-open.
#
# `scoped` requires ALL of: git usable, origin/main resolvable, a merge-base with
# it, a clean tree, HEAD != merge-base, and no explicit selection. Anything else is `run`.
#
# The clean-tree test captures `git status` as its OWN && term before testing
# the text. `[ -z "$(git status)" ]` returns the PREDICATE's status, not the
# command's, so a git that fails while printing nothing reads as a clean tree
# and would silently enter `scoped` -- a coverage hole in the one direction
# this design must never fail. Falsified with a stub returning 73: the old
# form reported clean.
#
# HEAD==base stays a RUN condition. That is the packet's existing fail-open
# safety behaviour and it is NOT a coverage claim: nothing here asserts that any
# particular invocation runs the whole set.
SCOPE_STATE="run"
SCOPE_PATHS="$OUTDIR/changed-paths"
SCOPE_BASE=""
: > "$SCOPE_PATHS" || { echo "$SUITE_NAME: could not create changed-path ledger" >&2; exit 1; }
if [ -z "$ONLY" ] && [ -z "$SELECTED_LIST" ] && [ "$PROBE_SET" = 0 ] \
   && _scope_head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" \
   && _scope_remote="$(git -C "$ROOT" rev-parse origin/main 2>/dev/null)" \
   && _scope_base="$(git -C "$ROOT" merge-base "$_scope_head" "$_scope_remote" 2>/dev/null)" \
   && _scope_status="$(git -C "$ROOT" status --porcelain --untracked-files=all 2>/dev/null)" \
   && [ -z "$_scope_status" ] \
   && [ "$_scope_head" != "$_scope_base" ] \
   && git -c core.quotePath=true -C "$ROOT" diff --no-ext-diff --no-renames --name-only "$_scope_base".."$_scope_head" 2>/dev/null >"$SCOPE_PATHS"; then
  SCOPE_STATE="scoped"
  SCOPE_BASE="$_scope_base"
  echo "$SUITE_NAME: change scoping — scoped at merge-base ${_scope_base%"${_scope_base#???????}"}, $(wc -l < "$SCOPE_PATHS" | tr -d ' ') changed paths"
else
  : > "$SCOPE_PATHS"
  echo "$SUITE_NAME: change scoping — run (no scoping: explicit selection, unresolved base, dirty tree, or HEAD==base)"
fi
export SCOPE_STATE SCOPE_PATHS SCOPE_BASE

# SERIAL PARTITION (tap-x45ge). One discovered list, two phases through the SAME
# worker: ordinary files at -P $JOBS, then `*-serial.test.sh` at -P 1.
#
# The claim this phase makes is exactly "no sibling workers from THIS gate
# invocation" -- not a quiet box. Nothing here locks, retries, waits for load, or
# otherwise reasons about other processes on the machine, and it must not: a file
# that still false-reds with no siblings is falsified out to human disposition
# rather than answered by growing a scheduler.
#
# No third directory, no manifest, no header parser: the partition is a suffix
# test on the same $LIST every other consumer sees, so --only and both sweepers
# are untouched, the discovery-shrink floor still counts every file, and the
# per-file ledger still accounts for every one.
SERIAL_LIST="$OUTDIR/list.serial"
ORDINARY_LIST="$OUTDIR/list.ordinary"
grep -E -- '-serial\.test\.sh$'  "$LIST" >"$SERIAL_LIST"   || :
grep -E -v -- '-serial\.test\.sh$' "$LIST" >"$ORDINARY_LIST" || :
_serial_n="$(wc -l < "$SERIAL_LIST" | tr -d ' ')"
_ordinary_n="$(wc -l < "$ORDINARY_LIST" | tr -d ' ')"
[ "$(( _serial_n + _ordinary_n ))" -eq "$total" ] || {
  echo "$SUITE_NAME: partition lost files — $_ordinary_n ordinary + $_serial_n serial != $total discovered" >&2
  exit 1
}
echo "$SUITE_NAME: serial partition — $_ordinary_n at -P $JOBS, then $_serial_n sibling-free at -P 1"

# Probe argv travels in a NUL-delimited file under OUTDIR, never through xargs
# or a shell string. The worker hands the file to the session shim as an
# explicit argument; the dispatch shim never sees it.
if [ "$PROBE_SET" = 1 ]; then
  : >"$OUTDIR/probe-argv" || { echo "$SUITE_NAME: could not create the probe argv file" >&2; exit 1; }
  for _probe_arg in ${PROBE_ARGV[@]+"${PROBE_ARGV[@]}"}; do
    printf '%s\0' "$_probe_arg" >>"$OUTDIR/probe-argv" || { echo "$SUITE_NAME: could not record probe argv" >&2; exit 1; }
  done
  export SMOKE_PROBE_ARGV="$OUTDIR/probe-argv"
fi
_smoke_worker_body='
  s="$1"
  rel="${s#"$SMOKE_ALL_ROOT"/}"
  log="$SMOKE_ALL_OUT/$(printf "%s" "$rel" | tr "/" "_").out"
  # PER-FILE MACHINE INDEX. TAP_INDEX_HOME used to be one directory per RUN,
  # shared by every worker, and `sandbox-pins.sh` deliberately DEFERS to an
  # inherited value -- so sourcing it gave a test no isolation here, and 220 of
  # 347 smokes shared one index. That was inert only while nothing published a
  # flip marker: the first test to register at a canonical git root writes
  # global-registry.json, and from that moment every sibling reads the machine
  # as post-flip, resolves its own ephemeral team as `unreachable`, and refuses
  # with "acting registry unreachable — refusing tap team against a bus decoy".
  # It presents as intermittence because it depends on file order.
  #
  # The isolation belongs HERE rather than in a list of tests that must remember
  # to pin: an enumeration is wrong the next time someone adds a test, and a
  # missing entry is invisible until scheduling changes. Same reasoning as the
  # tmux server boundary -- isolate the environment, do not classify the calls.
  # Minted per INVOCATION, not derived from the file name: a slug-derived path
  # is reused if the same file is ever run twice in one invocation, and would
  # then hand the second run whatever state the first left behind. mktemp is
  # also concurrent-safe by construction, which a shared-parent mkdir race is
  # not (review refinement).
  #
  # NOTE FOR EDITORS: this whole body is a SINGLE-QUOTED shell string, so an
  # apostrophe here terminates it and the file stops parsing hundreds of lines
  # later. Keep prose in this block apostrophe-free.
  # BORN LIVE. Native verbs refuse an absent machine marker (F1), so the
  # per-file index starts with the empty 0.20 marker.
  # FAIL CLOSED. An unchecked allocation is worse than no isolation at all: the
  # body runs with plain bash -c and no errexit, so a failed mktemp left
  # TAP_INDEX_HOME EMPTY in worker_env, the smoke still executed, and a PASS row
  # was appended. sandbox-pins.sh does not repair that -- its guards test whether
  # the variable is UNSET, and an explicitly empty value is preserved -- so
  # consumers fall back to the HOME-resolved index and the sibling contamination
  # this change exists to remove comes back, reported as a pass
  # (measured: worker status 0, worker executed,
  # index empty, PASS ledger written).
  #
  # A setup failure is therefore recorded as a FAILURE of this file, through the
  # same ledger every other failure uses, and the body never runs.
  if ! smoke_file_root="$(mktemp -d "$TAP_SUITE_SANDBOX/f.XXXXXX" 2>/dev/null)" \
     || [ -z "$smoke_file_root" ] || [ ! -d "$smoke_file_root" ] \
     || ! smoke_file_tmux="$(mktemp -d "$TMUX_TMPDIR/f.XXXXXX" 2>/dev/null)" \
     || [ -z "$smoke_file_tmux" ] || [ ! -d "$smoke_file_tmux" ] \
     || ! mkdir -p "$smoke_file_root/home" "$smoke_file_root/index" "$smoke_file_tmux/tmp" \
     || ! printf "%s\n" "{\"schema\":\"0.20\",\"teams\":{}}" > "$smoke_file_root/index/global-registry.json"; then
    {
      echo "smoke-all: could not allocate per-file state under $TAP_SUITE_SANDBOX and $TMUX_TMPDIR"
      echo "smoke-all: refusing to run $rel without independent state roots"
    } > "$log" 2>&1
    printf "%s\t%s\t%s\n" "setup" "$rel" "$log" >> "$SMOKE_ALL_OUT/fail"
    exit 1
  fi
  started_ns="$(python3 -I -c "import time; print(time.monotonic_ns())")"
  worker_env=(
    env -i
    "HOME=$smoke_file_root/home"
    "PATH=$SMOKE_ALL_TMUX_GUARD:$PATH"
    "TERM=$TERM"
    "LANG=$LANG"
    "LC_CTYPE=$LC_CTYPE"
    "TZ=$TZ"
    "SMOKE_SUITE_FILE=$rel"
    "SMOKE_ALL_ROOT=$SMOKE_ALL_ROOT"
    "SMOKE_TMUX_ESCAPE_MARKER=$SMOKE_TMUX_ESCAPE_MARKER"
    "SMOKE_WAVE_PIDS=$SMOKE_WAVE_PIDS"
    "SMOKE_WAVE_DONE=$SMOKE_ALL_OUT/wave-done"
    "SMOKE_SCOPE_STATE=$SCOPE_STATE"
    "SMOKE_SCOPE_PATHS=$SCOPE_PATHS"
    "SMOKE_SCOPE_BASE=$SCOPE_BASE"
    "TAP_INDEX_HOME=$smoke_file_root/index"
    "TAP_LOCK_DIR=$smoke_file_root/locks"
    "TAP_SESSION_MANIFEST=$smoke_file_root/sessions.json"
    "OPENCODE_DB_PATH=$smoke_file_root/opencode.db"
    "TAP_VERSION_SEEN_PATH=$smoke_file_root/version-seen.json"
    "TMUX_TMPDIR=$smoke_file_tmux"
    "TMPDIR=$smoke_file_tmux/tmp"
  )
  # Keep the ownership root and guard run-scoped; mutable state is per file.
  # TMPDIR uses the short tmux tree so socket fixtures retain their path budget.
  printf "smoke-all: worker-roots file=%s HOME=%s TAP_INDEX_HOME=%s TAP_LOCK_DIR=%s TAP_SESSION_MANIFEST=%s OPENCODE_DB_PATH=%s TAP_VERSION_SEEN_PATH=%s TMUX_TMPDIR=%s TMPDIR=%s TAP_HOME=unset TMUX=unset TMUX_PANE=unset\n" \
    "$rel" "$smoke_file_root/home" "$smoke_file_root/index" "$smoke_file_root/locks" "$smoke_file_root/sessions.json" \
    "$smoke_file_root/opencode.db" "$smoke_file_root/version-seen.json" "$smoke_file_tmux" "$smoke_file_tmux/tmp" > "$log.roots" || {
      echo "smoke-all: could not record per-file roots for $rel" > "$log" 2>&1
      printf "%s\t%s\t%s\n" "setup" "$rel" "$log" >> "$SMOKE_ALL_OUT/fail"
      exit 1
    }
  # TAP_SUITE_LPT is intentionally entry-only (tap-i2mg): workers do not
  # schedule, and admitting it here would let a future nested smoke-all
  # without env -i inherit LPT invisibly from the outer suite.
  for name in \
    TAP_PYTHON \
    TAP_SMOKE_BUN \
    TAP_FZF_TEST_ARCHIVE \
    TAP_SUITE_SANDBOX \
    EPISODIC_MEMORY_SUMMARIZER_GUARD \
    RUNNER_TRACKING_ID \
    TAP_SUITE_LOCK_HOME \
    TAP_SUITE_SEAT \
    TAP_SUITE_SLOT \
    TAP_SUITE_SLOT_PROBE \
    TAP_SUITE_SLOT_HELD \
    TAP_SUITE_SLOT_PID \
    SMOKE_ALL_MIN_FILES \
    SMOKE_ALL_TIMINGS
  do
    if [ -n "${!name+x}" ]; then
      worker_env+=("$name=${!name}")
    fi
  done
  rc=0
  _smoke_py="$(command -v "${TAP_PYTHON:-python3}")"
  "${worker_env[@]}" "$_smoke_py" -I -B -c "$SMOKE_WAVE_SESSION_EXEC_PY" "$s" ${SMOKE_PROBE_ARGV:+"$SMOKE_PROBE_ARGV"} </dev/null > "$log" 2>&1 || rc=$?
  # A probe log is the probe own output: the Bun test adapter below skips it.
  case "${SMOKE_PROBE_ARGV+probe:}$s" in
    probe:*|*.sh) ;;
    *)
      # Preserve the aggregate adapter convention: a passing title mentioning
      # skipped behavior is not an undeclared skip. Failure lines stay exact.
      if sed "/^(pass) /s/\$/: ok/" "$log" > "$log.formatted"; then
        mv "$log.formatted" "$log" || rc=1
      else rc=1; fi ;;
  esac
  if [ -s "$SMOKE_TMUX_ESCAPE_MARKER" ] \
     && { "$_smoke_py" -I -B "$SMOKE_ALL_TMUX_GUARD/escape-record.py" has "$SMOKE_TMUX_ESCAPE_MARKER" "$rel"; [ "$?" -ne 1 ]; }; then
    printf "%s\t%s\t%s\n" "tmux-escape" "$rel" "$log" >> "$SMOKE_ALL_OUT/fail"
  elif [ "$rc" -eq 0 ]; then
    printf "%s\t%s\n" "$rel" "$log" >> "$SMOKE_ALL_OUT/pass"
  else
    printf "%s\t%s\t%s\n" "$rc" "$rel" "$log" >> "$SMOKE_ALL_OUT/fail"
  fi
  finished_ns="$(python3 -I -c "import time; print(time.monotonic_ns())")"
  printf "%s\t%d\n" "$rel" "$(( (finished_ns - started_ns) / 1000000 ))" >> "$SMOKE_ALL_TIMINGS"
'
# The worker body runs from a file, never from xargs argv (tap-ctop0). BSD
# xargs -I substitutes its placeholder inside EVERY utility argument and refuses
# a substituted argument over 255 bytes, so a body passed as `bash -c "$body"`
# died on its first literal brace pair with every worker unlaunched and zero
# ledger rows. Only the short test path is substituted now.
printf '%s\n' "$_smoke_worker_body" > "$OUTDIR/worker.sh" || {
  echo "$SUITE_NAME: could not write the worker body to $OUTDIR/worker.sh" >&2
  exit 1
}
# Dispatch has its own recorded session so pre-registration wrappers are owned
# before they create worker sessions. Reuse the same ledger and reaper rules.
cat > "$OUTDIR/dispatch.sh" <<'DISPATCH'
#!/usr/bin/env bash
export SMOKE_WAVE_PIDS="$SMOKE_ALL_OUT/wave-pids"
export SMOKE_WAVE_DONE="$SMOKE_ALL_OUT/wave-done"
xargs -P "$SMOKE_DISPATCH_JOBS" -I {} bash "$SMOKE_DISPATCH_WORKER" {} < "$SMOKE_DISPATCH_LIST"
DISPATCH
SMOKE_DISPATCH_PID=""
for _dispatch_list in "$ORDINARY_LIST" "$SERIAL_LIST"; do
  _dispatch_jobs="$JOBS"
  _dispatch_window="parallel"
  _dispatch_n="$_ordinary_n"
  if [ "$_dispatch_list" = "$SERIAL_LIST" ]; then
    _dispatch_jobs=1
    _dispatch_window="serial"
    _dispatch_n="$_serial_n"
  fi
  if [ -n "$ONLY" ]; then
    _dispatch_window="$_dispatch_window:${ONLY#"$ROOT"/}"
  else
    _dispatch_window="$_dispatch_window:${_dispatch_n}-tests"
  fi
  # Defer cancellation until the asynchronous launch has assigned its child.
  # Cleanup can then reach it even before its session ledger exists.
  _dispatch_signal=0
  trap '_dispatch_signal=143' TERM
  trap '_dispatch_signal=130' INT
  trap '_dispatch_signal=129' HUP
  SMOKE_WAVE_PIDS="$OUTDIR/dispatch-pids" SMOKE_WAVE_DONE="$OUTDIR/dispatch-done" \
    SMOKE_DISPATCH_JOBS="$_dispatch_jobs" SMOKE_DISPATCH_LIST="$_dispatch_list" \
    SMOKE_DISPATCH_WORKER="$OUTDIR/worker.sh" \
    "${TAP_PYTHON:-python3}" -I -B -c "$SMOKE_WAVE_SESSION_EXEC_PY" "$OUTDIR/dispatch.sh" &
  SMOKE_DISPATCH_PID=$!
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  [ "$_dispatch_signal" = 0 ] || exit "$_dispatch_signal"
  wait "$SMOKE_DISPATCH_PID"
  SMOKE_DISPATCH_PID=""
  _ignored_phase="$OUTDIR/ignored-state-${_dispatch_window%%:*}.out"
  if ! "${TAP_PYTHON:-python3}" -B "$IGNORED_STATE_TRIPWIRE" compare \
      "$IGNORED_STATE_BEFORE" "$ROOT" "$_dispatch_window" >"$_ignored_phase" 2>&1; then
    cat "$_ignored_phase" >>"$IGNORED_STATE_FAILURES"
  fi
  if ! "${TAP_PYTHON:-python3}" -B "$IGNORED_STATE_TRIPWIRE" snapshot "$ROOT" "$IGNORED_STATE_BEFORE"; then
    printf 'ignored-state observation failed: could not refresh baseline after window=%s\n' \
      "$_dispatch_window" >>"$IGNORED_STATE_FAILURES"
  fi
done
_ignored_mutations="$(grep -c '^ignored-state mutation:' "$IGNORED_STATE_FAILURES" 2>/dev/null || true)"
_ignored_observation_failures="$(grep -c '^ignored-state observation failed:' "$IGNORED_STATE_FAILURES" 2>/dev/null || true)"
if [ -s "$IGNORED_STATE_FAILURES" ]; then
  printf 'ignored-state-roots: 1 checked, %s new or changed, %s observation failure(s)\n' \
    "${_ignored_mutations:-0}" "${_ignored_observation_failures:-0}" >"$IGNORED_STATE_SUMMARY"
else
  printf 'ignored-state-roots: 1 checked, 0 new or changed\n' >"$IGNORED_STATE_SUMMARY"
fi
# Preserve session authority before the census appends descendant PIDs.
cp "$SMOKE_WAVE_PIDS" "$OUTDIR/wave-sessions"
smoke_wave_pid_census "$SMOKE_WAVE_PIDS"
# Wave complete: every worker leader has returned. From here a live recorded
# leader is pid reuse, and smoke_all_cleanup keeps that session (R-C1).
: >"$OUTDIR/wave-complete"

POST_WAVE_FAIL="$OUTDIR/post-wave-fail"
: >"$POST_WAVE_FAIL"
[ ! -s "$IGNORED_STATE_FAILURES" ] \
  || printf '%s\t%s\n' ignored-state "$IGNORED_STATE_FAILURES" >>"$POST_WAVE_FAIL"
smoke_fixture_identity_snapshot \
  "$TAP_SUITE_SANDBOX" "$SMOKE_WAVE_HANDLES" "$SMOKE_WAVE_PANES" "$SMOKE_WAVE_ROOTS"
smoke_operator_state_snapshot "$SMOKE_OPERATOR_TAP_HOME" "$SMOKE_OPERATOR_AFTER" || {
  printf '%s\t%s\n' operator-state "$OUTDIR/operator-state.out" >>"$POST_WAVE_FAIL"
  echo "operator-state snapshot failed: $SMOKE_OPERATOR_TAP_HOME" >"$OUTDIR/operator-state.out"
}
smoke_tmux_state_snapshot "$SMOKE_ALL_REAL_TMUX" "$SMOKE_OPERATOR_TMUX_SOCKET" "$SMOKE_TMUX_AFTER"
if [ -f "$SMOKE_OPERATOR_AFTER" ]; then
  if smoke_operator_state_predicate \
      "$SMOKE_OPERATOR_BEFORE" "$SMOKE_OPERATOR_AFTER" "$SMOKE_OPERATOR_TAP_HOME" \
      "$TAP_SUITE_SANDBOX" "$SMOKE_WAVE_PIDS" "$SMOKE_WAVE_HANDLES" \
      "$SMOKE_REDIRECTED_PATHS" "$SMOKE_WAVE_PANES" "$SMOKE_WAVE_ROOTS" \
      "$SMOKE_PEER_OWNED_PATHS" "$OUTDIR/wave-sessions" "$SMOKE_OPERATOR_TMUX_SOCKET" \
      >"$OUTDIR/operator-state.out" 2>&1; then
    cat "$OUTDIR/operator-state.out"
  else
    printf '%s\t%s\n' operator-state "$OUTDIR/operator-state.out" >>"$POST_WAVE_FAIL"
  fi
fi
if smoke_tmux_state_predicate \
    "$SMOKE_TMUX_BEFORE" "$SMOKE_TMUX_AFTER" "$SMOKE_FIXTURE_SESSION_NAMES" \
    >"$OUTDIR/operator-tmux.out" 2>&1; then
  cat "$OUTDIR/operator-tmux.out"
else
  printf '%s\t%s\n' operator-tmux "$OUTDIR/operator-tmux.out" >>"$POST_WAVE_FAIL"
fi

# Probe mode ends here: no suite accounting, receipt or merge evidence. The
# probe's own output replays first, then the roots it ran under, then any
# post-wave failure. Exit precedence: an isolation or state-predicate failure
# wins (1, even when the probe exited 0); otherwise the probe's own status.
if [ "$PROBE_SET" = 1 ]; then
  _probe_rel="${SMOKE_PROBE_PATH#"$ROOT"/}"
  _probe_class=""; _probe_log=""; _probe_rc=1
  if [ -f "$OUTDIR/fail" ]; then
    IFS="$(printf '\t')" read -r _probe_class _ _probe_log <"$OUTDIR/fail" || true
    case "$_probe_class" in
      ''|*[!0-9]*) _probe_rc=1 ;;
      *) _probe_rc="$_probe_class" ;;
    esac
  elif [ -f "$OUTDIR/pass" ]; then
    IFS="$(printf '\t')" read -r _ _probe_log <"$OUTDIR/pass" || true
    _probe_rc=0
  fi
  if [ -n "$_probe_log" ] && [ -f "$_probe_log" ]; then
    cat "$_probe_log"
  else
    echo "probe: error=no_result: the worker recorded no outcome" >&2
    echo "probe: recovery: rerun; if it repeats, run bash scripts/smoke-all.sh --help and check the boundary" >&2
  fi
  if [ "$_probe_class" = "setup" ]; then
    # The worker never ran the probe: a boundary failure, not a probe status.
    smoke_probe_refuse isolation_failed "the worker could not allocate its per-file roots" "rerun; if it repeats, check free space and TMPDIR" 1 || true
    exit 1
  fi
  if [ "$_probe_class" = "tmux-escape" ]; then
    "${TAP_PYTHON:-python3}" -I -B "$SMOKE_ALL_TMUX_GUARD/escape-record.py" replay "$SMOKE_TMUX_ESCAPE_MARKER" "${SMOKE_PROBE_PATH#"$ROOT"/}" \
      || echo "probe: the tmux guard record could not be replayed from $SMOKE_TMUX_ESCAPE_MARKER" >&2
  fi
  for _worker_roots in "$OUTDIR"/*.roots; do
    [ -f "$_worker_roots" ] && cat "$_worker_roots"
  done
  _probe_post_wave="$(wc -l <"$POST_WAVE_FAIL" | tr -d ' ')"
  if [ "$_probe_post_wave" -gt 0 ]; then
    while IFS="$(printf '\t')" read -r label log; do
      echo "=== FAIL post-wave $label ==="
      cat "$log" || echo "probe: post-wave attribution could not be replayed: $log" >&2
    done <"$POST_WAVE_FAIL"
    echo "probe: FAILED file=$_probe_rel isolation or state predicate failed (probe exit=$_probe_rc; the state failure wins) — runner output, not merge evidence" >&2
    exit 1
  fi
  if [ "$_probe_rc" -ne 0 ]; then
    echo "probe: FAILED file=$_probe_rel exit=$_probe_rc — runner output, not merge evidence" >&2
  else
    echo "probe: ok file=$_probe_rel exit=0 — runner output, not merge evidence" >&2
  fi
  exit "$_probe_rc"
fi

# Passing logs normally disappear with OUTDIR. Surface the small, declared
# coverage caveat before cleanup, and turn legacy skip-shaped output into the
# same fail ledger the runner already knows how to render.
DECLARED_SKIP_RECEIPTS="$OUTDIR/declared-skip-receipts"
: > "$DECLARED_SKIP_RECEIPTS" || {
  echo "smoke-all: could not create declared-skip receipt ledger" >&2
  exit 1
}
declared_skips=0
skip_files=0
skip_accounting_incomplete=0
policy_failures=0
worker_passes=0
known_logs=()
record_declared_skip() {
  local rel="$1" log="$2" marker_count
  if ! marker_count="$(awk '/^SMOKE-SKIP: [^[:space:]]/{count++} END{print count+0}' "$log")"; then
    return 1
  elif [ "$marker_count" -gt 0 ]; then
    if {
      echo ""
      echo "=== DECLARED SKIP $rel ==="
      awk '/^SMOKE-SKIP: [^[:space:]]/' "$log"
    } >> "$DECLARED_SKIP_RECEIPTS"; then
      declared_skips=$((declared_skips + marker_count))
      skip_files=$((skip_files + 1))
    else
      return 1
    fi
  fi
}

# A passing file's stdout is otherwise discarded with its log, so a mutation
# witness's proof line would vanish from the gate artifact. A file declares one
# with `SMOKE-RECEIPT: <proof>` at column 0 and the runner copies exactly those
# lines, with their source file. Failing files already replay their whole log.
PROOF_RECEIPTS="$OUTDIR/proof-receipts"
: > "$PROOF_RECEIPTS" || {
  echo "smoke-all: could not create proof receipt ledger" >&2
  exit 1
}
record_proof_receipt() {
  local rel="$1" log="$2" receipts
  receipts="$(awk '/^SMOKE-RECEIPT: [^[:space:]]/' "$log")" || return 1
  [ -n "$receipts" ] || return 0
  {
    echo ""
    echo "=== SMOKE RECEIPT $rel ==="
    printf '%s\n' "$receipts"
  } >> "$PROOF_RECEIPTS"
}

# A failed worker can still declare a skip before its failure. Scan these rows
# first, before pass-policy checks append their own rows to the shared ledger;
# that ordering is what keeps the known_logs addition here free of double
# counts, since policy rows only appear later with their logs already counted
# by the pass loop (tap-qwf96).
if [ -f "$OUTDIR/fail" ]; then
  while IFS="$(printf '\t')" read -r _ rel log; do
    known_logs+=("$log")
    record_declared_skip "$rel" "$log" || skip_accounting_incomplete=1
  done < "$OUTDIR/fail"
fi
if [ -f "$OUTDIR/pass" ]; then
  worker_passes="$(wc -l < "$OUTDIR/pass" | tr -d ' ')"
  while IFS="$(printf '\t')" read -r rel log; do
    known_logs+=("$log")
    failure_class=""
    undeclared=0
    if ! record_declared_skip "$rel" "$log"; then
      failure_class="skip-accounting-error"
      skip_accounting_incomplete=1
    fi

    # The closed vocabulary catches the legacy receipts found by the census
    # without treating identifiers such as suite-skip-accounting or skip-files
    # as prose. Passing assertions that end in the suite's `: ok` convention
    # remain ordinary success output.
    if [ -z "$failure_class" ] && ! undeclared="$(awk '
        /^SMOKE-SKIP: [^[:space:]]/ { next }
        # The reserved prefix is malformed INDEPENDENTLY of the colon. Requiring
        # the colon left a hole that nothing else covered: the general word scan
        # below cannot see `smoke-skip`, because its boundary class excludes the
        # hyphen, so `SMOKE-SKIP reason` and `SMOKE-SKIP : reason` reached the end
        # of the scan unmatched and a worker exiting zero with a malformed
        # declaration was handed a GREEN zero census — the exact outcome this
        # accounting exists to make impossible.
        #
        # Anchored at line start (after any indentation), mirroring the
        # valid-marker regex it complements: the only legitimate line-initial use
        # of the prefix is a valid declaration at column 0, and the rule above has
        # already consumed those, so an INDENTED marker is malformed too. Leaving
        # it unanchored would redden any worker that merely quotes the convention
        # mid-line (tap-q949), as the remediation text printed by this suite does.
        toupper($0) ~ /^[[:space:]]*SMOKE[-_]SKIP/ { found=1; next }
        {
          lower=tolower($0)
          if (lower ~ /: ok[[:space:]]*$/) next
          if (lower ~ /(^|[^[:alnum:]_-])skip(ped|ping)?([^[:alnum:]_-]|$)/) found=1
        }
        END { print found+0 }
      ' "$log")"; then
      failure_class="skip-accounting-error"
    fi

    if [ -z "$failure_class" ] && [ "$undeclared" -gt 0 ]; then
      failure_class="undeclared-skip"
    fi
    if [ -z "$failure_class" ] && ! smoke_known_defect_receipt "$log" >/dev/null; then
      failure_class="known-defect-accounting-error"
    fi
    # Last, so a file the policy above rejects never leaves a proof block beside
    # its own FAIL replay.
    if [ -z "$failure_class" ] && ! record_proof_receipt "$rel" "$log"; then
      failure_class="skip-accounting-error"
    fi
    if [ -n "$failure_class" ]; then
      printf "%s\t%s\t%s\n" "$failure_class" "$rel" "$log" >> "$OUTDIR/fail"
      policy_failures=$((policy_failures + 1))
    fi
  done < "$OUTDIR/pass"
fi

if ! known_defect_summary="$(smoke_known_defect_receipt "${known_logs[@]}")"; then
  known_defect_summary="known-defect: invalid"
fi
if [ "$skip_accounting_incomplete" -gt 0 ]; then
  declared_skips=unknown
  skip_files=unknown
fi

npass=$((worker_passes - policy_failures)); nfail=0
[ -f "$OUTDIR/fail" ] && nfail="$(wc -l < "$OUTDIR/fail" | tr -d ' ')"
post_wave_failures="$(wc -l < "$POST_WAVE_FAIL" | tr -d ' ')"
wall=$(( $(date +%s) - start ))

# Terminal results describe the checkout after workers return, so a mutation
# during the run cannot be stamped with the pre-run clean tree. Capture once;
# duplicated stdout/stderr red summaries must cite the same observed fact.
#
# tap-1f45b: that sentence was a deliberate choice, not an oversight — whoever
# wrote it noticed mutation-during-run and picked end-state reporting over
# stamping the stale pre-run anchors. It is still right about the two options
# it weighed, and both are wrong: reporting the OLD anchors claims a tree the
# workers stopped reading, and reporting the NEW ones claims a tree they never
# finished reading, in the reassuring direction — the receipt looks fresher
# than the run was. The third option is to refuse. A straddled run is not a
# weaker pass of either tree; it is not a pass of anything, and the anchors it
# would print are the ones a reader trusts most.
result_receipt="$(smoke_gate_receipt "$ROOT" "$OUTDIR"); $(cat "$IGNORED_STATE_SUMMARY")"
failure_receipt_id=""
if [ "$nfail" -gt 0 ]; then
  failure_receipt_id="$(python3 -I -c 'import secrets; print(secrets.token_hex(16))')" || {
    echo "$SUITE_NAME: could not mint the failure receipt id" >&2
    exit 1
  }
  printf '%s\n' "$failure_receipt_id" | grep -Eq '^[0-9a-f]{32}$' || {
    echo "$SUITE_NAME: malformed failure receipt id" >&2
    exit 1
  }
fi

# Failures before the timing dump so a red log puts the useful output first.
#
# EVERY failing file carries the load this run recorded (tap-7r3fn.31(b)).
# Deliberately every one, rather than only the files that touch tmux: the
# runner has no honest way to know which arm inside a file asked for a pane,
# and a citation that is sometimes absent is read as "load was fine here". The
# entry sample is what the scheduler actually decided on; the receipt sample is
# taken now, because a file that reds 200 seconds in failed under neither the
# entry number nor a guess. Both are labelled with when they were taken —
# neither is the load AT the failure, which nothing here observed.
_load_transient_files=""
_load_transient_n=0
if [ "$nfail" -gt 0 ]; then
  _receipt_load="$(smoke_probe_load1m 2>/dev/null || echo unknown)"
  while IFS="$(printf '\t')" read -r rc rel log; do
    echo ""
    echo "=== SMOKE-FAIL-BEGIN receipt-id=$failure_receipt_id path=$rel ==="
    if [ "$rc" = "undeclared-skip" ]; then
      echo "=== FAIL $rel (undeclared skip output) ==="
      cat "$log"
      echo "smoke-all: $rel exited zero but emitted skip-shaped output without a declaration; emit SMOKE-SKIP: <reason> for an intentional skip"
    elif [ "$rc" = "skip-accounting-error" ]; then
      echo "=== FAIL $rel (skip accounting error) ==="
      cat "$log" || echo "smoke-all: retained log could not be replayed: $log" >&2
      echo "$SUITE_NAME: $rel exited zero, but $SUITE_NAME could not classify its retained log or retain its declared receipt; refusing a green receipt"
    elif [ "$rc" = "known-defect-accounting-error" ]; then
      echo "=== FAIL $rel (known-defect accounting error) ==="
      cat "$log" || echo "smoke-all: retained log could not be replayed: $log" >&2
      echo "$SUITE_NAME: $rel emitted a malformed KNOWN-DEFECT marker; expected tab-separated bead id, date, and description"
    else
      echo "=== FAIL $rel (exit $rc) ==="
      cat "$log"
    fi
    # A retained log with no trailing newline (e.g. a pretty-printed JSON dump
    # ending in a bare `}`) would otherwise run its last byte straight into
    # this marker on the same line, so the parser's `^=== SMOKE-FAIL-END`
    # anchor never matches it — read as an unterminated BEGIN, then charged
    # as "nested" against the next file's BEGIN (ci-gate-verdict.py). The
    # last byte is read through `od`, not captured raw in `$(...)`: bash
    # command substitution cannot hold a NUL byte, so a log ending in one
    # would misread as "" (empty, i.e. already newline-terminated) and skip
    # the guard, reglueing the marker for that byte the same way.
    _log_last_byte="$(tail -c1 "$log" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    [ -z "$_log_last_byte" ] || [ "$_log_last_byte" = "0a" ] || echo
    if [ "$rc" = "tmux-escape" ]; then
      "${TAP_PYTHON:-python3}" -I -B "$SMOKE_ALL_TMUX_GUARD/escape-record.py" replay "$SMOKE_TMUX_ESCAPE_MARKER" "$rel" \
        || echo "smoke-all: $rel: the tmux guard record could not be replayed from $SMOKE_TMUX_ESCAPE_MARKER"
    fi
    echo "=== SMOKE-FAIL-END receipt-id=$failure_receipt_id path=$rel ==="
    echo "$_suite_load_line (at entry); load1m=$_receipt_load at receipt"
    if smoke_load_transient_refusal "$rel"; then
      _load_transient_n=$((_load_transient_n + 1))
      _load_transient_files="${_load_transient_files:+$_load_transient_files }$rel"
      echo "$SUITE_NAME: $rel — load-transient candidate (rerun same head): the tmux server refused to fork a child (ENXIO, \"Device not configured\"), which is a pty or process ceiling on this machine and not a verdict on this file. Rerun it at the SAME head before dispositioning it. This is NOT a known-bad arm and must not be dispositioned as one; if it reds again on a quiet box, it is a real failure."
    fi
  done < "$OUTDIR/fail"
  echo ""
fi

# A candidate is a REQUEST FOR A RERUN, never a pass. It is printed beside the
# red count rather than folded into it, so nothing here can subtract a failure
# from the receipt: the run is still red, and the exit is still 1.
if [ "$_load_transient_n" -gt 0 ]; then
  echo "$SUITE_NAME: load-transient candidates: $_load_transient_n ($_load_transient_files) — rerun same head; still counted as failures above"
fi

if [ "$post_wave_failures" -gt 0 ]; then
  while IFS="$(printf '\t')" read -r label log; do
    echo "=== FAIL post-wave $label ==="
    cat "$log" || echo "smoke-all: post-wave attribution could not be replayed: $log" >&2
  done <"$POST_WAVE_FAIL"
  echo ""
fi

if [ -s "$DECLARED_SKIP_RECEIPTS" ]; then
  cat "$DECLARED_SKIP_RECEIPTS"
  echo ""
fi

if [ -s "$PROOF_RECEIPTS" ]; then
  cat "$PROOF_RECEIPTS"
  echo ""
fi

# Root receipts exceed PIPE_BUF on macOS; print private files after the wave.
for _worker_roots in "$OUTDIR"/*.roots; do
  [ -f "$_worker_roots" ] || continue
  cat "$_worker_roots" || exit 1
done
echo "smoke-all: per-file wall time (ms, descending)"
if [ -f "$SMOKE_ALL_TIMINGS" ]; then
  sort -t "$(printf '\t')" -k2,2nr "$SMOKE_ALL_TIMINGS"
fi

# tap-1f45b: a straddled run refuses BEFORE any authored result, so no ok-line
# and no red receipt can carry anchors the run did not hold throughout. This is
# a post-worker REFUSAL, not a result: it deliberately carries no known-defect
# or declared-skip accounting, because a citable-looking number beside a void
# head observation is quoted later by someone who does not know it was void.
# The failing-file logs above are still replayed — they are the useful half of
# a run that certifies nothing.
#
# WHAT THIS DOES NOT COVER, and it is not a weaker version of a freeze:
#   * moved-and-back — HEAD moves and returns before the receipt; both endpoint
#     samples agree while the workers read two trees. Endpoint equality is two
#     samples of a path, not proof the path was constant.
#   * dirtied-and-cleaned — no commit at all: uncommitted edits, then a
#     `git checkout --` or a stash pop before the receipt. HEAD and its tree are
#     identical at both ends and the executed bytes were mixed.
#   * receipt-vs-suite-source — `tested-tree` is the COMMITTED tree of HEAD, not
#     a checksum of the bytes the workers executed; it is only the same thing
#     while the checkout stays clean throughout, which neither endpoint proves.
# The upstream rule still owns all three: do not write to a worktree while any
# suite is reading it, and do not start a gate until the writes have stopped.
# Detecting a mixture after the fact does not give the 250 seconds back.
if [ -e "$OUTDIR/straddled" ]; then
  straddle_pins="$(cat "$OUTDIR/straddled" 2>/dev/null || printf 'pins unreadable')"
  case "$straddle_pins" in
    *"reason=receipt-head-unreadable"*)
      straddle_what="the checkout could not be re-read at receipt, so this run cannot show it stayed put"
      straddle_verdict="this run certifies neither tree" ;;
    *)
      straddle_what="the checkout moved between suite start and receipt"
      straddle_verdict="this run read a mixture of both trees and certifies neither" ;;
  esac
  straddle_summary="$SUITE_NAME: $result_receipt — STRADDLED — $straddle_what ($straddle_pins); $straddle_verdict"
  echo "$straddle_summary"
  echo "$straddle_summary" >&2
  exit 1
fi
if [ "$nfail" -gt 0 ] || [ "$post_wave_failures" -gt 0 ]; then
  failure_binding=""
  [ -z "$failure_receipt_id" ] || failure_binding="; failure-receipt-id=$failure_receipt_id"
  failing_segment="$(red_failing_segment "$OUTDIR/fail" "$POST_WAVE_FAIL" 2>/dev/null || true)"
  if [ "$post_wave_failures" -gt 0 ]; then
    red_summary="$SUITE_NAME: $result_receipt$failure_binding$failing_segment; $(red_known_defect_census "$known_defect_summary"); declared-skips=$declared_skips skip-files=$skip_files — $nfail/$total FAILED, $npass passed; post-wave failures=$post_wave_failures (${wall}s, -j $JOBS)"
  else
    red_summary="$SUITE_NAME: $result_receipt$failure_binding$failing_segment; $(red_known_defect_census "$known_defect_summary"); declared-skips=$declared_skips skip-files=$skip_files — $nfail/$total FAILED, $npass passed (${wall}s, -j $JOBS)"
  fi
  echo "$red_summary"
  echo "$red_summary" >&2
  exit 1
fi
if [ "$npass" -ne "$total" ]; then
  echo "$SUITE_NAME: $result_receipt; $(red_known_defect_census "$known_defect_summary"); declared-skips=$declared_skips skip-files=$skip_files — ledger mismatch — $npass passed + $nfail failed != $total files (worker died?)" >&2
  exit 1
fi
# tap-52ys: the terminal receipt names the SUITE, not this
# script. A regress run executes 60 optional files; emitting the canonical
# "smoke-all: ... ok — all N files passed" line would hand a reviewer a
# merge-gate green receipt for a suite that is not the merge gate, and the
# gate's evidence anchors are quoted by that exact string. Pinned by
# suite-name-receipt.test.sh, bidirectionally.
smoke_terminal_success_line "$SUITE_NAME" "$result_receipt" "$declared_skips" "$skip_files" \
  "$known_defect_summary" "$total" "$wall" "$JOBS"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  smoke_all_entry "$@"
fi
