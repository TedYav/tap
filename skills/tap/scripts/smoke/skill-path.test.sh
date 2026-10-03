#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -P "$(dirname "$0")/../../../.." && pwd)"
# The supported runner owns TMPDIR and cleanup; keep HOME separate from logs.
skill_work="$(mktemp -d)"
skill_work="$(cd -P "$skill_work" && pwd)"
skill_home="$skill_work/home with spaces"
mkdir -p "$skill_home" "$skill_work/bin" "$skill_work/cwd"
export SKILL_REAL_BUN="$(command -v bun)"
export SKILL_STAT_FAULT="$skill_work/stat-fault.ts"
cat > "$SKILL_STAT_FAULT" <<'TS'
const fs = require("node:fs"), original = fs.statSync;
fs.statSync = (path, ...args) => {
  if (path === `${process.env.HOME}/.agents/skills/precedence/SKILL.md`) {
    const code = process.env.SKILL_FAIL_CODE;
    throw Object.assign(new Error(`${code}: cannot inspect ${path}`), { code });
  }
  return original(path, ...args);
};
TS
cat > "$skill_work/bin/bun" <<'BUN'
#!/usr/bin/env bash
[ "${BUN_RUNTIME_TRANSPILER_CACHE_PATH:-}" = "$SKILL_EXPECT_CACHE_PIN" ] || {
  echo 'skill-path: caller did not pin Bun before startup' >&2; exit 89;
}
[ -z "${SKILL_FAIL_CODE:-}" ] || exec "$SKILL_REAL_BUN" --preload "$SKILL_STAT_FAULT" "$@"
exec "$SKILL_REAL_BUN" "$@"
BUN
chmod +x "$skill_work/bin/bun"
ln -s "$ROOT/bin/tap" "$skill_work/bin/tap-link"

for personal in .agents .claude .codex; do
  mkdir -p "$skill_home/$personal/skills/tap" "$skill_home/$personal/skills/precedence"
  printf 'personal\n' > "$skill_home/$personal/skills/tap/SKILL.md"
  printf 'precedence\n' > "$skill_home/$personal/skills/precedence/SKILL.md"
done
mkdir -p "$skill_home/.claude/skills/claude-only" "$skill_home/.codex/skills/claude-only" \
  "$skill_home/.codex/skills/codex-only" "$skill_home/.agents/skills/directory/SKILL.md" \
  "$skill_home/.codex/skills/directory" "$skill_home/.agents/skills/linked" \
  "$skill_home/.agents/skills/dangling" "$skill_home/.codex/skills/dangling" \
  "$skill_home/.agents/skills/loop" "$skill_home/.codex/skills/loop"
for candidate in .claude/skills/claude-only .codex/skills/claude-only .codex/skills/codex-only \
  .codex/skills/directory .codex/skills/dangling .codex/skills/loop; do
  printf 'skill\n' > "$skill_home/$candidate/SKILL.md"
done
printf 'not a directory\n' > "$skill_home/.agents/skills/codex-only"
ln -s "$skill_home/.codex/skills/codex-only/SKILL.md" "$skill_home/.agents/skills/linked/SKILL.md"
ln -s missing "$skill_home/.agents/skills/dangling/SKILL.md"
ln -s SKILL.md "$skill_home/.agents/skills/loop/SKILL.md"

check() {
  local expected_rc="$1" expected_out="$2" expected_err="$3" rc=0
  shift 3
  (
    cd "$skill_work/cwd"
    env -u TAP_VERBOSE -u TAP_BUN_ROUTE_TRACE HOME="$skill_home" TAP_INDEX_HOME="$skill_work/index" \
      TAP_HOME="$skill_work/bus" PATH="$skill_work/bin:$PATH" \
      BUN_RUNTIME_TRANSPILER_CACHE_PATH="$skill_work/cache" SKILL_EXPECT_CACHE_PIN=0 \
      bash "$skill_entry" "$@"
  ) > "$skill_work/out" 2> "$skill_work/err" || rc=$?
  [ "$rc" = "$expected_rc" ] || { echo "skill-path: $skill_entry $*: rc=$rc expected=$expected_rc" >&2; cat "$skill_work/err" >&2; exit 1; }
  printf '%s' "$expected_out" > "$skill_work/expected-out"
  printf '%s' "$expected_err" > "$skill_work/expected-err"
  cmp "$skill_work/expected-out" "$skill_work/out"
  if [ "${1:-}" = --verbose ]; then
    # The retained dispatcher owns verbose diagnostics, but stdout stays exact.
    grep -q 'tap verbose:' "$skill_work/err"
  else
    cmp "$skill_work/expected-err" "$skill_work/err"
  fi
}

mkdir -p "$skill_home/.agents/skills/tap-double-check"
printf 'stale personal skill\n' > "$skill_home/.agents/skills/tap-double-check/SKILL.md"

usage=$'tap help skill: expected one simple skill name\n'
missing="tap help skill: no SKILL.md for unknown-skill in $ROOT/skills, $ROOT/compat/skills, $skill_home/.agents/skills, $skill_home/.claude/skills, $skill_home/.codex/skills"$'\n'
for door in root public symlink; do
  case "$door" in
    root) skill_entry="$ROOT/scripts/tap.sh" ;;
    public) skill_entry="$ROOT/bin/tap" ;;
    symlink) skill_entry="$skill_work/bin/tap-link" ;;
  esac
  check 0 "$ROOT/skills/tap/SKILL.md"$'\n' '' help skill tap
  for canonical in lead drive conduct choreography config-wizard; do
    for spelling in "$canonical" "tap:$canonical" "tap-$canonical"; do
      check 0 "$ROOT/skills/$canonical/SKILL.md"$'\n' '' help skill "$spelling"
    done
  done
  check 0 "$ROOT/skills/tap/SKILL.md"$'\n' '' help skill tap:tap
  check 0 "$ROOT/skills/tap/SKILL.md"$'\n' '' help skill using-tap
  check 0 "$ROOT/skills/conduct/SKILL.md"$'\n' '' help skill conductor
  check 0 "$ROOT/skills/config-wizard/SKILL.md"$'\n' '' help skill tap-config
  for retired in tap-double-check tap-coach tap-abandon-branch; do
    check 0 "$ROOT/compat/skills/$retired/SKILL.md"$'\n' '' help skill "$retired"
  done
  check 0 "$skill_home/.agents/skills/precedence/SKILL.md"$'\n' '' help skill precedence
  check 0 "$skill_home/.claude/skills/claude-only/SKILL.md"$'\n' '' help skill claude-only
  for name in codex-only directory dangling loop; do
    check 0 "$skill_home/.codex/skills/$name/SKILL.md"$'\n' '' help skill "$name"
  done
  check 0 "$skill_home/.codex/skills/codex-only/SKILL.md"$'\n' '' help skill linked
  check 1 '' "$missing" help skill unknown-skill
  check 2 '' "$usage" help skill
  check 2 '' "$usage" help skill tap extra
  for name in '' ../tap /tmp dotted.name _first 'two words' 'café' $'using-tap\n' other:lead tap:../lead tap:lead:extra; do
    check 2 '' "$usage" help skill "$name"
  done
  check 0 "$ROOT/skills/tap/SKILL.md"$'\n' '' --verbose -v help skill tap
  check 2 '' "$usage" --verbose -v help skill
  # Runtime-boundary faults stay reliable even when the test runs as root.
  # Both later roots contain this skill; observation failure must not pick one.
  for code in EACCES EIO; do
    export SKILL_FAIL_CODE="$code"
    check 1 '' "tap help skill: Error: $code: cannot inspect $skill_home/.agents/skills/precedence/SKILL.md"$'\n' help skill precedence
    unset SKILL_FAIL_CODE
  done
done

for state in "$skill_home/.tap" "$skill_work/index" "$skill_work/bus" "$skill_work/cwd/.tap" "$skill_work/cache"; do
  [ ! -e "$state" ] || { echo "skill-path: lookup created $state" >&2; exit 1; }
done
# The pin is specific to literal help skill, not all help or its aliases.
for args in 'help advisory' '--help skill'; do
  control_rc=0
  env HOME="$skill_home" TAP_INDEX_HOME="$skill_work/index" PATH="$skill_work/bin:$PATH" \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH="$skill_work/cache" SKILL_EXPECT_CACHE_PIN="$skill_work/cache" \
    bash "$ROOT/bin/tap" $args > "$skill_work/control-out" 2> "$skill_work/control-err" || control_rc=$?
  if [ "$args" = '--help skill' ]; then
    [ "$control_rc" = 1 ] || { echo "skill-path: control '$args' rc=$control_rc (want 1); stderr: $(head -c 300 "$skill_work/control-err")" >&2; exit 1; }
    grep -q "tap: no help for 'skill'" "$skill_work/control-err" \
      || { echo "skill-path: control '$args' lacks the no-help refusal; stderr: $(head -c 300 "$skill_work/control-err")" >&2; exit 1; }
  else
    [ "$control_rc" = 0 ] || { echo "skill-path: control '$args' rc=$control_rc (want 0); stderr: $(head -c 300 "$skill_work/control-err")" >&2; exit 1; }
  fi
done
echo 'skill-path: ordered roots, exact refusals, entry cache pins and no bus creation passed'
