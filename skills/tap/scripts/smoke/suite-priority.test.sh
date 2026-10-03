#!/usr/bin/env bash
# Exercise discovery and dispatch, not a grep of the priority list.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FIXTURE="$WORK/repo"
mkdir -p "$FIXTURE/scripts" "$FIXTURE/skills/tap/scripts/smoke" "$WORK/home" "$WORK/locks"
for file in smoke-all.sh ignored-state-tripwire.py suite-slot-run.py suite_slot.py; do
  cp "$ROOT/scripts/$file" "$FIXTURE/scripts/$file"
done
for file in smoke-preflight.sh smoke_hermeticity_lint.py; do
  cp "$ROOT/skills/tap/scripts/smoke/$file" "$FIXTURE/skills/tap/scripts/smoke/$file"
done
for name in a-fast bun-router session-pytest team-refresh-parity z-serial; do
  cat > "$FIXTURE/skills/tap/scripts/smoke/$name.test.sh" <<WORKER
#!/usr/bin/env bash
printf '%s\\n' '$name' >> '$WORK/order'
WORKER
  chmod +x "$FIXTURE/skills/tap/scripts/smoke/$name.test.sh"
done
git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email tap@test
git -C "$FIXTURE" config user.name tap
git -C "$FIXTURE" add .
git -C "$FIXTURE" commit -qm fixture
if ! (
  cd "$FIXTURE"
  env -i HOME="$WORK/home" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TERM=dumb LANG=C LC_CTYPE=en_US.UTF-8 TZ=UTC TAP_PYTHON="${TAP_PYTHON:-python3}" \
    TAP_SUITE_SLOT=bypass TAP_SUITE_LOCK_HOME="$WORK/locks" TAP_RUNNER_ALLOW=1 SMOKE_ALL_MIN_FILES=1 \
    bash scripts/smoke-all.sh -j 1
) > "$WORK/run.log" 2>&1; then
  cat "$WORK/run.log" >&2
  exit 1
fi
printf '%s\n' bun-router team-refresh-parity session-pytest a-fast z-serial > "$WORK/expected"
if ! cmp -s "$WORK/expected" "$WORK/order"; then
  echo 'suite-priority: (1) measured long file was not dispatched before legacy priorities, or membership/serial order changed' >&2
  cat "$WORK/order" >&2
  exit 1
fi
echo 'suite-priority: measured long file starts first; every worker runs once and serial stays last: ok'
