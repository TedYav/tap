#!/usr/bin/env bash
# bus-relocation-fallback.test.sh — one canonical root-derived bus, a thin
# old-store detector, explicit custom homes, and no automatic conversion.
#
# Resolution keys on the native repoRoot/resolveBus owners. Each case runs
# from a fresh NON-git temp dir so the repo
# root is that dir (pwd fallback) and TAP_HOME is unset — exercising the real chain.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

# (1) Fresh repo, no bus, TAP_HOME unset → doctor's zero-write promise (tap-0y4u)
#     refuses a genuinely unenrolled cwd rather than bootstrapping .tap/bus;
#     nothing materializes. See runtime/bun/test/doctor.test.ts's own
#     "unenrolled cwd is refused before any bus materializes" coverage.
mkdir -p "$WORK/fresh"
rc=0; out="$(cd "$WORK/fresh" && env -u TAP_HOME "$TAP" doctor 2>&1)" || rc=$?
[ "$rc" != 0 ] || { echo "bus-relocation: (1) doctor should refuse an unenrolled fresh repo" >&2; echo "$out" >&2; exit 1; }
[[ "$out" == *"TAP_HOME"* ]] || { echo "bus-relocation: (1) refusal must name TAP_HOME" >&2; echo "$out" >&2; exit 1; }
[ ! -d "$WORK/fresh/.tap" ] || { echo "bus-relocation: (1) zero-write refusal let .tap be created" >&2; exit 1; }
echo "bus-relocation: (1) fresh unenrolled repo refuses zero-write, nothing created: ok"

# (1b) The default-rule bootstrap doctor used to perform is not gone, just
#      moved: any ordinary writer still creates .tap/bus on demand with a
#      self-ignoring .tap/.gitignore (skills/tap/scripts/smoke/README.md:42's
#      claim), same as (5) exercises for the R23 guard. Exercised directly for
#      the same reason (5) is: no unrelated business logic in the way.
mkdir -p "$WORK/bootstrap"
out="$(cd "$WORK/bootstrap" && env -u TAP_HOME "${TAP_SMOKE_BUN:-bun}" "$ROOT/runtime/bun/test/support/python-closure-cli.ts" bus-ensure 2>&1)" || {
  echo "bus-relocation: (1b) native bus ensure failed on a fresh repo" >&2; echo "$out" >&2; exit 1; }
[ -d "$WORK/bootstrap/.tap/bus/payloads" ] || { echo "bus-relocation: (1b) .tap/bus not created" >&2; exit 1; }
grep -qx 'bus/' "$WORK/bootstrap/.tap/.gitignore" || { echo "bus-relocation: (1b) .tap/.gitignore missing 'bus/'" >&2; cat "$WORK/bootstrap/.tap/.gitignore" 2>&1 >&2; exit 1; }
echo "bus-relocation: (1b) an ordinary writer still bootstraps .tap/bus + writes .gitignore: ok"

# (2) A legacy registry without a canonical bus reports old_store, with no writes.
mkdir -p "$WORK/legacy/tmp/tap/payloads"
printf '%s\n' '{"schema":"0.20","seats":{}}' > "$WORK/legacy/tmp/tap/registry.json"
out="$(cd "$WORK/legacy" && env -u TAP_HOME "$TAP" doctor 2>&1)" || true
[[ "$out" == *"rule=old_store"* ]] || { echo "bus-relocation: (2) rule should be old_store" >&2; echo "$out" >&2; exit 1; }
[ ! -d "$WORK/legacy/.tap/bus" ] || { echo "bus-relocation: (2) created a bus over the old store" >&2; exit 1; }
echo "bus-relocation: (2) legacy-only registry reported, no fresh bus: ok"

# (3) Both layouts present → .tap/bus wins; rule=dotdir.
mkdir -p "$WORK/both/.tap/bus/payloads" "$WORK/both/tmp/tap/payloads"
out="$(cd "$WORK/both" && env -u TAP_HOME "$TAP" doctor 2>&1)" || true
[[ "$out" == *"rule=dotdir"* ]] || { echo "bus-relocation: (3) .tap/bus should win" >&2; echo "$out" >&2; exit 1; }
grep -q "bus=$WORK/both/.tap/bus" <<<"$out" || { echo "bus-relocation: (3) resolved bus should be .tap/bus" >&2; echo "$out" >&2; exit 1; }
echo "bus-relocation: (3) both present → .tap/bus wins: ok"

# (4) TAP_HOME env wins over both; rule=env.
mkdir -p "$WORK/enved/.tap/bus" "$WORK/enved/tmp/tap"
CUSTOM="$WORK/custom-home"
out="$(cd "$WORK/enved" && TAP_HOME="$CUSTOM" "$TAP" doctor 2>&1)" || true
[[ "$out" == *"rule=env"* ]] || { echo "bus-relocation: (4) rule should be env" >&2; echo "$out" >&2; exit 1; }
grep -q "bus=$CUSTOM" <<<"$out" || { echo "bus-relocation: (4) env bus should win" >&2; echo "$out" >&2; exit 1; }
echo "bus-relocation: (4) TAP_HOME env wins over both layouts: ok"

# (5) Exercise native selection and effect owners under the same isolated runner.
python3 -B - "$ROOT/skills/tap/scripts" "$WORK" <<'PYTEST'
import errno, json, os, pathlib, subprocess, sys
scripts, work = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
bridge = scripts.parents[2] / "runtime/bun/test/support/python-closure-cli.ts"

def native(root, mode, home=None):
    env = dict(os.environ)
    env.pop("TAP_HOME", None)
    env["TAP_MIGRATING"] = "1"  # this retired flag never bypasses the refusal
    env["TAP_JSON"] = "1"
    if home is not None:
        env["TAP_HOME"] = str(home)
    return subprocess.run([os.environ.get("TAP_SMOKE_BUN", "bun"), str(bridge), mode],
                          cwd=root, env=env, text=True, capture_output=True)

for kind in ("scratch", "malformed", "dangling", "directory", "canonical"):
    root = work / ("owners-" + kind)
    legacy, canonical = root / "tmp/tap", root / ".tap/bus"
    legacy.mkdir(parents=True)
    marker = legacy / "registry.json"
    if kind == "dangling":
        marker.symlink_to("missing")
    elif kind == "directory":
        marker.mkdir()
    elif kind != "scratch":
        marker.write_text("retained evidence")
    else:
        (legacy / "archive.md").write_text("retained archive")
    if kind == "canonical":
        canonical.mkdir(parents=True)
    old = kind in ("malformed", "dangling", "directory")
    selected = native(root, "bus-select")
    rule = "old_store" if old else "dotdir" if kind == "canonical" else "default"
    assert selected.returncode == 0 and selected.stdout == f"{rule}|{canonical}", selected
    if old:
        for home in (None, canonical):
            refused = native(root, "bus-ensure", home)
            assert refused.returncode == 1 and "old_store" in refused.stdout + refused.stderr, refused
            assert not canonical.exists()
    else:
        made = native(root, "bus-ensure")
        assert made.returncode == 0 and (canonical / "payloads").is_dir(), made
    # An explicit tmp/tap spelling is an ordinary custom home, with its parent
    # context anchor retained and no legacy-specific climb to the worktree.
    custom = native(root, "bus-custom", legacy)
    assert custom.returncode == 0 and custom.stdout == str(root / "tmp"), custom
    if kind == "malformed":
        assert marker.read_text() == "retained evidence"
    elif kind == "dangling":
        assert marker.is_symlink() and not marker.exists()
    elif kind == "scratch":
        assert (legacy / "archive.md").read_text() == "retained archive"

# Lookup failures must not look like missing entries in the native owner.
for kind in ("loop", "unsearchable"):
    root = work / ("lookup-" + kind)
    root.mkdir()
    legacy = root / "tmp/tap"
    if kind == "loop":
        (root / "tmp").symlink_to("tmp")
        expected_errno = errno.ELOOP
    else:
        legacy.mkdir(parents=True)
        (legacy / "registry.json").write_text("retained evidence")
        legacy.chmod(0)
        expected_errno = errno.EACCES
    try:
        # Root can traverse mode-000 directories; the ELOOP control still runs.
        if kind == "unsearchable" and os.geteuid() == 0:
            continue
        for home in (None, root / ".tap/bus"):
            refused = native(root, "bus-ensure", home)
            assert refused.returncode != 0 and ("bus lookup failed" in refused.stderr or errno.errorcode[expected_errno] in refused.stderr), refused
            assert not (root / ".tap/bus").exists()
    finally:
        if kind == "unsearchable":
            legacy.chmod(0o700)
            assert (legacy / "registry.json").read_text() == "retained evidence"

print("bus-relocation: native canonical selection, detector, custom homes: ok")
PYTEST

echo "bus-relocation-fallback: ok"
