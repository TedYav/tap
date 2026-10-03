#!/usr/bin/env bash
# Await a GitHub run's OWN conclusion, tolerating a flapping local network.
#
# `gh run watch --exit-status` exits non-zero for two unrelated facts: the run
# failed, and the watcher's own API call failed. On this box the second happens
# (twice tonight: "read: can't assign requested address", with the local IP
# changing between them), and it reads as a red gate. That is the same class this
# lane spent the night removing from the courier -- a non-zero status that means
# the instrument broke, not that the thing failed -- so the watcher gets the same
# treatment: the VERDICT is the run's own terminal `conclusion` field, never an
# exit code from the process that asked for it.
set -uo pipefail
run="${1:-}"
poll="${2:-30}"
case "$run" in ''|*[!0-9]*) echo 'await-run: run id must be numeric' >&2; exit 64 ;; esac
case "$poll" in ''|*[!0-9]*|0) echo 'await-run: poll seconds must be positive' >&2; exit 64 ;; esac
consecutive_errors=0
while :; do
  out="$(gh run view "$run" --json status,conclusion --jq '.status + " " + .conclusion' 2>/dev/null)"
  rc=$?
  valid=false
  case "$out" in
    'queued '*|'in_progress '*|'waiting '*|'requested '*|'pending '*) valid=true ;;
    'completed success'|'completed failure'|'completed cancelled'|'completed timed_out'|'completed action_required'|'completed neutral'|'completed skipped'|'completed stale'|'completed startup_failure') valid=true ;;
  esac
  if [ "$rc" -ne 0 ] || [ "$valid" != true ]; then
    consecutive_errors=$((consecutive_errors + 1))
    # A transient lookup failure is not a verdict. Only give up if the API is
    # unreachable for long enough that something else is wrong.
    if [ "$consecutive_errors" -ge 20 ]; then
      printf 'await-run: UNOBSERVABLE after %d consecutive lookup failures for run %s\n' "$consecutive_errors" "$run"
      exit 2
    fi
    sleep "$poll"; continue
  fi
  consecutive_errors=0
  status="${out%% *}"; conclusion="${out#* }"
  if [ "$status" = completed ]; then
    printf 'await-run: run %s completed conclusion=%s\n' "$run" "$conclusion"
    [ "$conclusion" = success ] && exit 0 || exit 1
  fi
  sleep "$poll"
done
