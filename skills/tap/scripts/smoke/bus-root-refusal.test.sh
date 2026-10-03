#!/usr/bin/env bash
# bus-root-refusal.test.sh — an explicit TAP_HOME that names the
# .tap container, not its bus/, must refuse before any phantom-bus directory is
# created. The paired positive arm uses the same fixture's real bus so a guard
# that refuses every explicit TAP_HOME fails just as loudly as a missing guard.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

TEAM="$WORK/team"
BUS="$TEAM/.tap/bus"
PHANTOM="$TEAM/.tap"
mkdir -p "$BUS/payloads" "$BUS/receipts"

write_registry() { # <path>
  cat > "$1" <<'JSON'
{
  "schema": "0.20", "team": {"name": "fixture"},
  "seats": {
    "alice": {"delivery": "poll", "harness": "codex", "status": "active"},
    "bob": {"delivery": "poll", "harness": "codex", "status": "active"}
  }
}
JSON
}

# The bus carries registry.json. A copy at the parent proves that parent metadata
# cannot make the container a self-consistent custom home with a second
# payload/receipt namespace.
write_registry "$BUS/registry.json"
write_registry "$PHANTOM/registry.json"
cat > "$PHANTOM/team-registry.json" <<'JSON'
{"schema":"0.20","team":{"name":"fixture"},"seats":{}}
JSON

assert_non_bus_refusal() { # <label> <input-home> <reported-home> <expected-bus> <command...>
  local label="$1" input_home="$2" reported_home="$3" expected_bus="$4" out rc=0
  shift 4
  out="$WORK/$label.out"
  TAP_HOME="$input_home" "$@" >"$out" 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || {
    echo "bus-root-refusal: $label accepted TAP_HOME=$input_home" >&2
    cat "$out" >&2
    exit 1
  }
  grep -Fq "TAP_HOME='$reported_home' does not name a bus" "$out" || {
    echo "bus-root-refusal: $label refused for the wrong reason" >&2
    cat "$out" >&2
    exit 1
  }
  grep -Fq "expected '$expected_bus'" "$out" || {
    echo "bus-root-refusal: $label did not name the real nested bus" >&2
    cat "$out" >&2
    exit 1
  }
  grep -Fq 'next: unset TAP_HOME or point it at the bus dir' "$out" || {
    echo "bus-root-refusal: $label did not give the one-step remedy" >&2
    cat "$out" >&2
    exit 1
  }
  [ ! -d "$reported_home/payloads" ] && [ ! -d "$reported_home/receipts" ] && [ ! -d "$reported_home/tmp" ] || {
    echo "bus-root-refusal: $label created phantom bus state before refusing" >&2
    find "$reported_home" -maxdepth 2 -print >&2
    exit 1
  }
}

# Send is the incident path. Poll and reply prove the guard sits at the shared
# bus-mutation boundary rather than in send alone.
assert_non_bus_refusal send "$PHANTOM" "$PHANTOM" "$BUS" \
  "$TAP" send bob -m phantom --from alice --id tap-c6ji-send
assert_non_bus_refusal poll "$PHANTOM" "$PHANTOM" "$BUS" "$TAP" poll bob --quiet
printf 'answer\n' > "$WORK/reply-body.md"
assert_non_bus_refusal reply "$PHANTOM" "$PHANTOM" "$BUS" \
  "$TAP" reply tap-c6ji-missing --by bob -f "$WORK/reply-body.md"
# A caller can also export the worktree root itself. Once a nested canonical bus
# exists, that is just as provably a container and must not grow payloads/ beside
# .tap/.
assert_non_bus_refusal root-with-bus "$TEAM" "$TEAM" "$BUS" \
  "$TAP" send bob -m phantom --from alice --id tap-c6ji-root

# Keep every container predicate independently mutation-sensitive. In particular,
# the clean Git root cannot borrow proof from an already-present nested bus.
ABSENT_ROOT="$WORK/absent"
ABSENT_CONTAINER="$ABSENT_ROOT/.tap"
mkdir -p "$ABSENT_ROOT"
assert_non_bus_refusal absent-dotdir-slash "$ABSENT_CONTAINER/" "$ABSENT_CONTAINER" \
  "$ABSENT_CONTAINER/bus" \
  "$TAP" send bob -m phantom --from alice --id tap-c6ji-absent-slash
[ ! -e "$ABSENT_CONTAINER" ] || {
  echo "bus-root-refusal: trailing-slash refusal created the absent .tap container" >&2
  exit 1
}

FRESH_GIT="$WORK/fresh-git"
mkdir -p "$FRESH_GIT"
git -C "$FRESH_GIT" init -q
assert_non_bus_refusal clean-git-root "$FRESH_GIT" "$FRESH_GIT" \
  "$FRESH_GIT/.tap/bus" \
  "$TAP" send bob -m phantom --from alice --id tap-c6ji-clean-git

DOTDIR_ALIAS="$WORK/dotdir-alias"
ln -s "$PHANTOM" "$DOTDIR_ALIAS"
assert_non_bus_refusal dotdir-symlink "$DOTDIR_ALIAS" "$PHANTOM" "$BUS" \
  "$TAP" send bob -m phantom --from alice --id tap-c6ji-dotdir-alias

GIT_ALIAS="$WORK/git-alias"
ln -s "$FRESH_GIT" "$GIT_ALIAS"
assert_non_bus_refusal git-root-symlink "$GIT_ALIAS" "$FRESH_GIT" \
  "$FRESH_GIT/.tap/bus" \
  "$TAP" send bob -m phantom --from alice --id tap-c6ji-git-alias

# A legacy-only enrolled root refuses as old_store before sender validation.
# An empty tmp/tap directory alone is scratch, not evidence of an old store.
LEGACY_ROOT="$WORK/legacy"
LEGACY_BUS="$LEGACY_ROOT/tmp/tap"
LEGACY_INDEX="$WORK/legacy-index"
mkdir -p "$LEGACY_BUS" "$LEGACY_INDEX"
write_registry "$LEGACY_BUS/registry.json"
cat > "$LEGACY_INDEX/global-registry.json" <<JSON
{"schema":"0.20","teams":{"legacy":{"root":"$LEGACY_ROOT","registry_location":"$LEGACY_BUS/registry.json","state":"registered"}}}
JSON
legacy_before="$(cat "$LEGACY_BUS/registry.json")"
if out="$(env -u TAP_HOME -u TAP_REGISTRY TAP_INDEX_HOME="$LEGACY_INDEX" \
  "$TAP" send bob -m phantom --from missing --team legacy --json 2>&1)"; then
  echo "bus-root-refusal: legacy-only root accepted send" >&2; exit 1
fi
[[ "$out" == *'"old_store"'* ]] || {
  echo "bus-root-refusal: legacy-only root refused for the wrong reason: $out" >&2
  exit 1
}
[ "$(cat "$LEGACY_BUS/registry.json")" = "$legacy_before" ] \
  && [ ! -e "$LEGACY_BUS/payloads" ] \
  && [ ! -e "$LEGACY_BUS/receipts" ] \
  && [ ! -e "$LEGACY_ROOT/.tap/bus" ] || {
  echo "bus-root-refusal: old_store refusal changed bus state" >&2; exit 1
}
echo "bus-root-refusal: legacy-only root refuses before sender validation: ok"
echo "bus-root-refusal: one-level-high TAP_HOME refuses across the shared boundary: ok"

# Bidirectional control: the exact nested bus remains usable. This must fail if
# the guard merely bans explicit TAP_HOME or any parent carrying team metadata.
TAP_HOME="$BUS" "$TAP" send bob -m canonical --from alice --id tap-c6ji-valid >/dev/null
[ -f "$BUS/payloads/tap-c6ji-valid.md" ] || {
  echo "bus-root-refusal: valid nested bus did not receive the control payload" >&2
  exit 1
}
[ ! -d "$PHANTOM/payloads" ] && [ ! -d "$PHANTOM/receipts" ] || {
  echo "bus-root-refusal: valid control leaked into the parent .tap container" >&2
  exit 1
}
echo "bus-root-refusal: exact .tap/bus positive control: ok"

# An arbitrary non-container path is still a supported custom bus. The guard is
# shape-based; it must not turn registry presence or path naming into policy.
CUSTOM_BUS="$WORK/custom-bus"
mkdir -p "$CUSTOM_BUS/payloads" "$CUSTOM_BUS/receipts"
write_registry "$CUSTOM_BUS/registry.json"
TAP_HOME="$CUSTOM_BUS" \
  "$TAP" send bob -m custom --from alice --id tap-c6ji-custom >/dev/null
[ -f "$CUSTOM_BUS/payloads/tap-c6ji-custom.md" ] || {
  echo "bus-root-refusal: arbitrary custom bus did not receive the control payload" >&2
  exit 1
}
echo "bus-root-refusal: arbitrary custom TAP_HOME positive control: ok"

# The other resolver form is --team: it derives the same exact bus from the
# machine index while TAP_HOME is absent. This positive arm catches a guard that
# rejects a valid flag-derived root or validates only the source-time env value.
INDEX="$WORK/index"
UNRELATED="$WORK/unrelated"
mkdir -p "$INDEX" "$UNRELATED"
cat > "$INDEX/global-registry.json" <<JSON
{"schema":"0.20","teams":{"fixture":{"root":"$(cd "$TEAM" && pwd -P)","registry_location":"$(cd "$BUS" && pwd -P)/registry.json","state":"registered"}}}
JSON
(
  cd "$UNRELATED"
  env -u TAP_HOME TAP_INDEX_HOME="$INDEX" \
    "$TAP" send bob -m team-flag --from alice --id tap-c6ji-team --team fixture >/dev/null
)
[ -f "$BUS/payloads/tap-c6ji-team.md" ] || {
  echo "bus-root-refusal: --team-derived bus did not receive the control payload" >&2
  exit 1
}
echo "bus-root-refusal: --team-derived .tap/bus positive control: ok"

# An explicit env value outranks --team. A bad env anchor must therefore refuse,
# not silently escape to the enrolled team's valid bus.
assert_non_bus_refusal env-precedes-team "$PHANTOM" "$PHANTOM" "$BUS" \
  env TAP_INDEX_HOME="$INDEX" \
  "$TAP" send bob -m phantom --from alice --id tap-c6ji-env-team --team fixture
[ ! -f "$BUS/payloads/tap-c6ji-env-team.md" ] || {
  echo "bus-root-refusal: --team overrode the invalid explicit TAP_HOME" >&2
  exit 1
}
echo "bus-root-refusal: explicit TAP_HOME precedence over --team: ok"

echo "bus-root-refusal: ok"
