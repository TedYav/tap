#!/usr/bin/env bash
# smoke-preflight.sh — shared interpreter floor checks for the smoke suite.
#
# Source from smoke-all.sh or individual smokes:
#   source "$(dirname "$0")/../smoke/smoke-preflight.sh"
#
# Asserts BOTH interpreter floors the suite requires:
#   - python >= 3.12 (the shared TEST floor; runtime Python checks are separate)
#   - bash >= 4.0 (mapfile, associative arrays, etc. in some smokes)
#
# Fails LOUD with the named fix — never lets a per-box red recur in every
# lane's evidence (tap-w0t3). On macOS, /bin/bash is 3.2 forever and /usr/bin/
# python3 is 3.9; both need a brew install + PATH order fix.

smoke_preflight_check() {
  local rc=0

  # --- bash >= 4.0 ---
  local bash_major="${BASH_VERSINFO[0]:-0}"
  if [ "$bash_major" -lt 4 ]; then
    echo "smoke-preflight: bash >= 4.0 required (running under bash $BASH_VERSION)" >&2
    echo "smoke-preflight: on macOS: brew install bash, then ensure /opt/homebrew/bin/bash (or /usr/local/bin/bash) is on PATH before /bin" >&2
    rc=1
  fi

  # --- python >= 3.12 (test floor; see header) ---
  # Prefer python3.1x on PATH (brew installs), fall back to python3.
  local py=""
  for candidate in python3.14 python3.13 python3.12; do
    if command -v "$candidate" >/dev/null 2>&1; then
      py="$candidate"
      break
    fi
  done
  if [ -z "$py" ]; then
    if command -v python3 >/dev/null 2>&1; then
      py="python3"
    else
      echo "smoke-preflight: no python3 found on PATH" >&2
      echo "smoke-preflight: install python >= 3.12 (on macOS: brew install python@3.14 or similar)" >&2
      rc=1
    fi
  fi
  if [ -n "$py" ]; then
    local py_version py_major py_minor
    py_version="$("$py" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")"
    py_major="${py_version%%.*}"
    py_minor="${py_version#*.}"
    if [ "$py_major" -lt 3 ] || { [ "$py_major" -eq 3 ] && [ "$py_minor" -lt 12 ]; }; then
      echo "smoke-preflight: python >= 3.12 required for the test suite (found $py = $py_version)" >&2
      echo "smoke-preflight: on macOS: brew install python@3.14, then ensure /opt/homebrew/bin is on PATH before /usr/bin" >&2
      rc=1
    fi
  fi

  # --- bare python3 floor (tap-w0t3) ---
  # The suite has dozens of sites (lib.sh, tap-team.sh, etc.) that invoke bare
  # `python3` — not ${TAP_PYTHON}. A half-fixed box (a newer python installed but
  # PATH order wrong, bare python3 = an older one) would PASS the preferred-
  # candidate check above while those sites run on the older interpreter. So bare
  # python3 must ALSO meet the floor — held at the SAME 3.12 as the preferred
  # check, so preflight green means the WHOLE suite runs on >= 3.12, not just the
  # selected smokes. This checks the test interpreter independently of runtime
  # checks (tap-w0t3).
  if command -v python3 >/dev/null 2>&1; then
    local bare_py_version bare_py_major bare_py_minor
    bare_py_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")"
    bare_py_major="${bare_py_version%%.*}"
    bare_py_minor="${bare_py_version#*.}"
    if [ "$bare_py_major" -lt 3 ] || { [ "$bare_py_major" -eq 3 ] && [ "$bare_py_minor" -lt 12 ]; }; then
      echo "smoke-preflight: bare 'python3' on PATH is $bare_py_version (< 3.12 required for the test suite)" >&2
      echo "smoke-preflight: the suite invokes bare 'python3' in lib.sh, tap-team.sh, and other scripts — not just the swept smokes" >&2
      echo "smoke-preflight: on macOS: brew install python@3.14, then ensure /opt/homebrew/bin is on PATH before /usr/bin so 'python3' resolves to the brew version" >&2
      rc=1
    fi
  fi

  # --- bash via command -v (non-blocking note a from opus gate) ---
  # BASH_VERSINFO checks the INVOKING bash, but children run PATH-bash. An
  # explicit-path invocation (e.g. /opt/homebrew/bin/bash scripts/smoke-all.sh
  # with /bin first on PATH) would pass the VERSINFO check while children still
  # run /bin/bash 3.2. Assert command -v bash too so the PATH-bash is compliant.
  local path_bash
  path_bash="$(command -v bash 2>/dev/null || true)"
  if [ -n "$path_bash" ]; then
    local path_bash_major
    path_bash_major="$("$path_bash" -c 'echo ${BASH_VERSINFO[0]:-0}' 2>/dev/null || echo "0")"
    if [ "$path_bash_major" -lt 4 ]; then
      echo "smoke-preflight: 'bash' on PATH ($path_bash) is bash $path_bash_major (< 4.0 required)" >&2
      echo "smoke-preflight: children run PATH-bash, not the invoking shell — ensure /opt/homebrew/bin/bash is on PATH before /bin" >&2
      rc=1
    fi
  fi

  return $rc
}

# Resolve the python interpreter that meets the 3.12+ test floor, preferring
# python3.1x on PATH. Smokes that need python should use $(smoke_resolve_python)
# instead of bare python3.
# tap-h3p4: report every TAP_* the LAUNCHING SHELL exported. Lives here rather
# than inside smoke-all.sh so it is sourceable and therefore testable — a header
# nobody can test is decoration.
#
# Reported, not refused, and that is the design: a refusal only catches the knobs
# someone thought to forbid; a report catches the knob nobody predicted. The
# hazard is not a leaked knob that turns the suite RED — that is loud and
# self-correcting. It is one that turns it GREEN.
#
# Values are printed, not just names: `TAP_PYTHON` inherited is a question,
# `TAP_PYTHON=true` is the answer.
smoke_env_inherited() {
  local n v out=""
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    # Skip what OUR OWN slot re-exec injects. suite-slot-run.py sets these and
    # re-invokes smoke-all, so on the re-invoked run they are present in the
    # environment while having come from this script rather than the operator's
    # shell. Reporting them would train the reader to ignore the line.
    # TAP_SUITE_SLOT itself is NOT skipped: `bypass` is an operator decision.
    case "$n" in
      TAP_SUITE_SLOT_HELD|TAP_SUITE_SLOT_PID|TAP_SUITE_SLOT_PROBE) continue ;;
    esac
    eval "v=\${$n-}"
    [ "${#v}" -le 48 ] || v="${v:0:45}..."
    out="${out:+$out }$n=$v"
  done <<EOF
$(env | sed -n 's/^\(TAP_[A-Za-z0-9_]*\)=.*/\1/p' | sort)
EOF
  printf '%s' "$out"
}

smoke_resolve_python() {
  # Optional floor-version probe; the ordinary suite still resolves >=3.12 below.
  if [ "${1:-}" = 3.11 ]; then
    for candidate in python3.11 /opt/homebrew/opt/python@3.11/bin/python3.11 /usr/local/opt/python@3.11/bin/python3.11; do
      if command -v "$candidate" >/dev/null 2>&1 && [ "$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" = 3.11 ]; then
        echo "$candidate"; return 0
      fi
    done
    return 1
  fi
  for candidate in python3.14 python3.13 python3.12; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  echo "python3"
}

# Assert a SPECIFIC interpreter command actually reports Python >= 3.12. Validates
# the command's own version output (NOT its exit code — `TAP_PYTHON=true` would
# exit 0 while running nothing), so a smoke that honors an unchecked ${TAP_PYTHON}
# override cannot silently print PASS on a bogus/old interpreter. Returns 1 loud.
smoke_assert_python() {
  local cmd="$1" ver
  ver="$("$cmd" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
  case "$ver" in
    3.1[2-9]|3.[2-9][0-9]|[4-9].*|[1-9][0-9]*.*) return 0 ;;
    *)
      echo "smoke-preflight: interpreter '$cmd' is not runnable Python >= 3.12 (got '${ver:-<none>}'; a TAP_PYTHON override must still meet the test floor)" >&2
      return 1
      ;;
  esac
}
