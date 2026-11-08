#!/usr/bin/env bash
# scripts/ci-provision-fzf.sh: transient failures retry, permanent ones stop at
# once, the budget bounds even a hung attempt, and success needs the suite's own
# resolver to find the archive. A fake bun stands in for the installer and the
# resolver's checksum probe, so nothing downloads and no real cache is written.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
unset TAP_FZF_TEST_ARCHIVE

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-provision-fzf.XXXXXX")"
trap 'rm -rf "${WORK:?}"' EXIT
mkdir -p "$WORK/bin"
: > "$WORK/fzf.tar.gz"
cat > "$WORK/bin/bun" <<'FAKE'
#!/usr/bin/env bash
# bun -e <probe> ...: the resolver's checksum probe answers with the fake archive.
if [ "${1:-}" = -e ]; then
  [ "${FAKE_RESOLVE:-1}" = 1 ] && printf '%s\n' "$FAKE_ARCHIVE"
  exit 0
fi
n=$(( $(cat "$FAKE_STATE/count" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$n" > "$FAKE_STATE/count"
read -r -a plan <<< "$FAKE_PLAN"
step="${plan[$((n - 1))]:-${plan[${#plan[@]}-1]}}"
case "$step" in
  ok) echo "install: managed fzf 0.74.4: fake"; exit 0 ;;
  hang) exec sleep 30 ;;
  sum) echo "install: fzf archive checksum mismatch for fake; nothing installed; next: rerun" >&2; exit 1 ;;
  *) echo "install: fzf download failed: HTTP $step; next: rerun ./install.sh after fixing the cause" >&2; exit 1 ;;
esac
FAKE
chmod +x "$WORK/bin/bun"

fail() { echo "FAIL: $*" >&2; exit 1; }
# provision <case> <plan> [VAR=value...]: run the script; sets rc, out, count, secs.
provision() {
  local name="$1" plan="$2"; shift 2
  mkdir -p "$WORK/$name"
  local t0=$SECONDS
  rc=0
  out="$(env PATH="$WORK/bin:$PATH" FAKE_STATE="$WORK/$name" FAKE_PLAN="$plan" FAKE_ARCHIVE="$WORK/fzf.tar.gz" \
    TAP_FZF_PROVISION_RETRY_SECS=1 "$@" bash "$ROOT/scripts/ci-provision-fzf.sh" 2>&1)" || rc=$?
  secs=$((SECONDS - t0))
  count="$(cat "$WORK/$name/count" 2>/dev/null || echo 0)"
}

provision transient "504 ok" TAP_FZF_PROVISION_BUDGET_SECS=30
[ "$rc" = 0 ] && [ "$count" = 2 ] || fail "transient then success: rc=$rc attempts=$count: $out"
case "$out" in *"retrying in 1s"*"suite resolves verified archive $WORK/fzf.tar.gz"*) ;; *) fail "transient: $out" ;; esac
echo "ok: a 504 retries and the next success is accepted after the resolver finds the archive"

provision permanent "404"
[ "$rc" = 1 ] && [ "$count" = 1 ] || fail "404: rc=$rc attempts=$count: $out"
case "$out" in *"permanent download refusal"*) ;; *) fail "404: $out" ;; esac
echo "ok: a 404 fails on the first attempt"

provision checksum "sum"
[ "$rc" = 1 ] && [ "$count" = 1 ] || fail "checksum: rc=$rc attempts=$count: $out"
case "$out" in *"not a transient download failure"*) ;; *) fail "checksum: $out" ;; esac
echo "ok: a checksum mismatch fails on the first attempt"

provision hung "hang" TAP_FZF_PROVISION_BUDGET_SECS=2
[ "$rc" = 1 ] && [ "$secs" -le 6 ] || fail "hung attempt: rc=$rc secs=$secs: $out"
case "$out" in *"budget of 2s exhausted during attempt 1"*) ;; *) fail "hung: $out" ;; esac
echo "ok: a hung attempt is stopped at the budget (${secs}s)"

provision exhausted "503" TAP_FZF_PROVISION_BUDGET_SECS=3
[ "$rc" = 1 ] && [ "$count" = 2 ] || fail "exhausted: rc=$rc attempts=$count: $out"
case "$out" in *"no verified fzf archive after 2 attempts"*) ;; *) fail "exhausted: $out" ;; esac
echo "ok: repeated 503s stop before a retry would pass the budget"

provision unresolved "ok" FAKE_RESOLVE=0
[ "$rc" = 1 ] || fail "unresolved: rc=$rc: $out"
case "$out" in *"does not resolve a verified archive"*) ;; *) fail "unresolved: $out" ;; esac
echo "ok: an install the suite resolver cannot find fails"

for bad in abc 0 -5; do
  provision "budget-$bad" "ok" TAP_FZF_PROVISION_BUDGET_SECS="$bad"
  [ "$rc" = 2 ] && [ "$count" = 0 ] || fail "budget '$bad': rc=$rc attempts=$count: $out"
done
echo "ok: a non-positive or non-numeric budget is refused before any attempt"
