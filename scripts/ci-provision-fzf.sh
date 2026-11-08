#!/usr/bin/env bash
# Provision the pinned fzf archive into the CI runner account's real-home cache
# (~/.tap/tools/fzf/<version>-<key>/), so every install-shaped test reads it offline.
#
# Why: install.sh stages the pinned fzf, and every install-shaped test used to
# download it from GitHub's release-asset host inside a discarded sandbox HOME.
# When that host returned HTTP 504, gates lost 11-24 files 40 minutes in. The
# suite already resolves a verified real-home cache (fzf-archive-pin.sh, via the
# passwd home, which a sandbox HOME cannot hide); this step makes sure the runner
# has one. It is the gate's one deliberate real-home write. A warm cache makes it
# a ~1 s checksum check; a cold one downloads once, retrying transient failures
# within the budget, and fails the job here, loudly, if it cannot.
#
# The archive is verified against vendor/fzf/manifest.json either way; this
# script changes where the bytes live, never which bytes are trusted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="$ROOT/skills/tap/scripts/smoke/fzf-archive-pin.sh"
# Total wall-clock budget, enforced on every attempt; first retry delay (doubles, cap 120 s).
budget="${TAP_FZF_PROVISION_BUDGET_SECS:-600}"
delay="${TAP_FZF_PROVISION_RETRY_SECS:-15}"
for value in "$budget" "$delay"; do
  case "$value" in
    ''|*[!0-9]*|0) echo "ci-provision-fzf: budget and retry delay must be positive integers (got budget='$budget' delay='$delay')" >&2; exit 2 ;;
  esac
done

# The same home fzf-archive-pin.sh resolves (passwd, not $HOME), so the write
# lands exactly where the suite looks.
real_home="$(env -u TAP_FZF_TEST_ARCHIVE bash -c '. "$1" && tap_fzf_account_home' _ "$PIN")"
if [ -z "$real_home" ] || [ ! -d "$real_home" ]; then
  echo "ci-provision-fzf: could not resolve the runner account's home (got '$real_home')" >&2
  exit 1
fi
export TAP_INDEX_HOME="$real_home/.tap"
unset TAP_FZF_TEST_ARCHIVE
echo "ci-provision-fzf: user=$(id -un) cache-root=$TAP_INDEX_HOME budget=${budget}s"

start=$SECONDS
attempt=1
while :; do
  remaining=$((budget - (SECONDS - start)))
  # alarm 0 would mean no deadline at all.
  if [ "$remaining" -le 0 ]; then
    echo "ci-provision-fzf: FAIL: budget of ${budget}s exhausted before attempt $attempt" >&2
    exit 1
  fi
  rc=0
  # perl's alarm bounds the attempt (install-fzf.ts retries internally) by what
  # is left of the budget; SIGALRM exits 142.
  out="$(perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$remaining" bun "$ROOT/runtime/bun/src/install-fzf.ts" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$out"
    break
  fi
  printf '%s\n' "$out" >&2
  if [ "$rc" -eq 142 ]; then
    echo "ci-provision-fzf: FAIL: budget of ${budget}s exhausted during attempt $attempt; the release-asset host is unavailable and every install-shaped test would download and fail" >&2
    exit 1
  fi
  # Retry what says nothing about the archive (connection, timeout, 429, 5xx);
  # a 404, a bad size or a checksum mismatch will not improve with waiting.
  case "$out" in
    *"fzf download failed: HTTP 429"*|*"fzf download failed: HTTP 5"*) ;;
    *"fzf download failed: HTTP "*) echo "ci-provision-fzf: FAIL: permanent download refusal" >&2; exit 1 ;;
    *"fzf download failed:"*) ;;
    *) echo "ci-provision-fzf: FAIL: not a transient download failure" >&2; exit 1 ;;
  esac
  if [ $((SECONDS - start + delay)) -ge "$budget" ]; then
    echo "ci-provision-fzf: FAIL: no verified fzf archive after $attempt attempts in $((SECONDS - start))s of a ${budget}s budget; the release-asset host is unavailable and every install-shaped test would download and fail" >&2
    exit 1
  fi
  echo "ci-provision-fzf: attempt $attempt failed transiently; retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2 > 120 ? 120 : delay * 2))
done

# Refusing instrument: an installer exit 0 proves a write, not that the suite's
# resolver finds it. fzf-archive-pin.sh prints nothing on any failure, so check
# its answer directly.
resolved="$(env -u TAP_FZF_TEST_ARCHIVE -u TAP_INDEX_HOME bash -c '. "$1" && printf %s "${TAP_FZF_TEST_ARCHIVE:-}"' _ "$PIN")"
if [ -z "$resolved" ] || [ ! -f "$resolved" ]; then
  echo "ci-provision-fzf: FAIL: installed, but fzf-archive-pin.sh does not resolve a verified archive under $TAP_INDEX_HOME" >&2
  exit 1
fi
echo "ci-provision-fzf: suite resolves verified archive $resolved"
