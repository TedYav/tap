#!/usr/bin/env bash
# install-skill-coverage.test.sh — every skill directory shipped in skills/ must be
# named in install.sh's link arrays, and every named entry must exist as a skill
# directory. A skill absent from the arrays installs nowhere: the repo ships it,
# reviews it, and no harness ever links it (skills/adapt once shipped this way).
# REPO_LOCAL_SKILLS is the third state (tap-tcw88): it names skills that ship but
# are deliberately linked into NO harness home — counted as handled here exactly
# like the linked arrays, so the coverage direction cannot red a deliberate
# unsharing.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
INSTALL_SH="$ROOT/install.sh"

# Read the same static classification table as installer/setup; test both directions.
eval "$(bun "$ROOT/runtime/bun/src/skill-policy.ts" classifications)"
# REPO_LOCAL_SKILLS may name skills the export manifest denies: hold every
# listed entry against only what this checkout carries. The private tree keeps
# full coverage; a public candidate without those directories still holds.
listed_repo_local=()
for s in ${REPO_LOCAL_SKILLS+"${REPO_LOCAL_SKILLS[@]}"}; do
  [ -f "$ROOT/skills/$s/SKILL.md" ] && listed_repo_local+=("$s")
done
listed=("${CORE_SKILLS[@]}" "${OPTIONAL_SKILLS[@]}" "${listed_repo_local[@]}")

fail=0

# Direction 1: every installable skill (a dir carrying SKILL.md) is linked.
for dir in "$ROOT"/skills/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || continue
  found=0
  for s in "${listed[@]}"; do
    [ "$s" = "$name" ] && { found=1; break; }
  done
  if [ "$found" -eq 0 ]; then
    echo "install-skill-coverage: skills/$name ships a SKILL.md but no install.sh array links it" >&2
    fail=1
  fi
done

# Direction 2: every listed entry points at a real skill directory.
for s in "${listed[@]}"; do
  if [ ! -f "$ROOT/skills/$s/SKILL.md" ]; then
    echo "install-skill-coverage: install.sh lists '$s' but skills/$s/SKILL.md does not exist" >&2
    fail=1
  fi
done

# Product discovery belongs to the native plugin, so the old Claude relays must
# be absent. Repository-local skills keep their convention relays.
for s in "${CORE_SKILLS[@]}" "${OPTIONAL_SKILLS[@]}"; do
  plugin="$ROOT/plugins/tap/skills/$s/SKILL.md"
  [ -f "$plugin" ] || { echo "install-skill-coverage: missing plugin entry $s" >&2; fail=1; }
  legacy="tap-$s"; [ "$s" != tap ] || legacy=tap
  [ ! -L "$ROOT/.claude/skills/$legacy" ] || { echo "install-skill-coverage: duplicate relay $legacy" >&2; fail=1; }
done

# Direction 4 (repo-local relays) is this repository's own check: repo-local-skill-relays.test.sh.

# Structural relay checks do not prove a harness loads either convention. Probe
# OpenCode itself in minimal git repos with isolated state. OpenCode 2 exposes
# its resolved registry through GET /api/skill (verified with 2.1.2).
# The source-only repo is the causal negative: it holds the same SKILL.md as
# each positive arm but no convention relay. A hit there means OpenCode scanned
# top-level skills/ (or leaked machine state), so the positives cannot prove
# which relay loaded the skill.
command -v opencode >/dev/null 2>&1 \
  || { echo "install-skill-coverage: opencode is required for repo-local loader coverage" >&2; exit 1; }
opencode_version="$(opencode --version)"
echo "install-skill-coverage: loader $opencode_version"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/install-skill-loader.XXXXXX")"
trap 'rm -rf "${probe_dir:?}"' EXIT

# A fresh skill.list request can precede asynchronous plugin activation in v2.
# Keep one private server alive until both the native and compatibility skill
# plugins resolve controls in the isolated home; only then can it prove absence.
dump_skills() (
  local repo="$1" skill_home="$2" dump="$3" server_pid server_url deadline server_password
  mkdir -p "$skill_home/tmp" "$skill_home/.config/opencode/skills/tap-probe-control" \
    "$skill_home/.claude/skills/tap-probe-control-compat"
  skill_home="$(cd "$skill_home" && pwd -P)"
  cd "$repo"
  repo="$(pwd -P)"
  printf '%s\n' '---' 'name: tap-probe-control' 'description: Verify native skill discovery is ready.' '---' \
    > "$skill_home/.config/opencode/skills/tap-probe-control/SKILL.md"
  printf '%s\n' '---' 'name: tap-probe-control-compat' 'description: Verify compatibility skill discovery is ready.' '---' \
    > "$skill_home/.claude/skills/tap-probe-control-compat/SKILL.md"
  server_password="$(openssl rand -hex 24)"
  mkfifo "$skill_home/server.stdin"
  exec 3<>"$skill_home/server.stdin"
  env -i PATH="$PATH" HOME="$skill_home" \
    XDG_CONFIG_HOME="$skill_home/.config" \
    XDG_DATA_HOME="$skill_home/.local/share" \
    XDG_CACHE_HOME="$skill_home/.cache" \
    XDG_STATE_HOME="$skill_home/.local/state" TMPDIR="$skill_home/tmp" \
    OPENCODE_PASSWORD="$server_password" \
    opencode serve --stdio --hostname 127.0.0.1 --port 0 \
    3>&- < "$skill_home/server.stdin" > "$dump.server" 2> "$dump.stderr" &
  server_pid=$!
  trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; exec 3>&-' EXIT
  deadline=$((SECONDS + 30))
  until server_url="$(jq -er '.url // empty' "$dump.server" 2>/dev/null)"; do
    if ! kill -0 "$server_pid" 2>/dev/null || [ "$SECONDS" -ge "$deadline" ]; then
      echo "install-skill-coverage: private OpenCode server did not start in $repo" >&2
      cat "$dump.stderr" >&2
      exit 1
    fi
    sleep 0.1
  done
  case "$server_url" in
    http://127.0.0.1:*) ;;
    *) echo "install-skill-coverage: unexpected private server URL: $server_url" >&2; exit 1 ;;
  esac
  while :; do
    curl --fail --silent --show-error --max-time 20 --user "opencode:$server_password" \
      "$server_url/api/skill" > "$dump.json"
    # Match parsed names only: prose mentions are not registry entries. Embedded
    # skills have virtual /builtin/ paths; all file skills stay in this fixture.
    jq -er --arg repo "$repo" --arg skill_home "$skill_home" '
      if .location.directory == $repo and (.data | type == "array") and
         all(.data[]; (.name | type == "string") and (.path | type == "string") and
           (.path | startswith($repo + "/") or startswith($skill_home + "/") or startswith("/builtin/")))
      then [.data[].name] | join("\n")
      else error("invalid or uncontained OpenCode skill response") end
    ' "$dump.json" > "$dump"
    if grep -Fxq tap-probe-control "$dump" && grep -Fxq tap-probe-control-compat "$dump"; then
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "install-skill-coverage: OpenCode did not resolve both control skills in $repo" >&2
      cat "$dump.stderr" >&2
      exit 1
    fi
    sleep 0.1
  done
)

# Exercise the installer's actual link/reap functions without its hook writes.
# A second install must keep /tap-collab available beside both existing work shapes
# in the Claude and Codex skill roots. This proves installation, not CLI loading.
REPO="$ROOT"
export TAP_INSTALL_MANIFEST="$probe_dir/install-manifest.json"
export XDG_CONFIG_HOME="$probe_dir/config"
mkdir -p "$XDG_CONFIG_HOME/tap"
printf '[skills]\nfull_kit = true\n' > "$XDG_CONFIG_HOME/tap/config.toml"
# link_user_skills runs its Bun step through the installer's tap_bun helper,
# which starts Bun under the config path the installer resolves, and tallies
# through the installer's counters and install_detail; take those definitions
# from install.sh too, on the checkout path (ARTIFACT=0, quiet detail). The
# one-line definitions are taken by line, the functions by body.
ARTIFACT=0
VERBOSE=0
for installer_line_prefix in '^install_detail() ' '^SKILL_LINK_COUNT=' '^SKILL_HOME_COUNT=' '^ABSENT_SKILL_HOMES=' '^TAP_BUN_CONFIG=' '^\[ -f "\$TAP_BUN_CONFIG" \] || TAP_BUN_CONFIG='; do
  installer_line="$(grep -m1 "$installer_line_prefix" "$INSTALL_SH")" || installer_line=""
  [ -n "$installer_line" ] || { echo "install-skill-coverage: missing installer line $installer_line_prefix" >&2; exit 1; }
  eval "$installer_line"
done
[ "$TAP_BUN_CONFIG" = "$ROOT/runtime/bun/tap-bunfig.toml" ] || { echo "install-skill-coverage: the installer's Bun config did not resolve inside this checkout: $TAP_BUN_CONFIG" >&2; exit 1; }
for function_name in tap_bun link_user_skills; do
  function_body="$(sed -n "/^${function_name}()/,/^}/p" "$INSTALL_SH")"
  [ -n "$function_body" ] || { echo "install-skill-coverage: missing installer function $function_name" >&2; exit 1; }
  eval "$function_body"
done
# A home is linked only when its harness command is on PATH (tap-gjwtw): Hermes needs a stub,
# while OpenCode must stay the real command so its discovery below is unchanged.
mkdir -p "$probe_dir/hermes-bin"
printf '#!/bin/sh\nexit 0\n' >"$probe_dir/hermes-bin/hermes"; chmod +x "$probe_dir/hermes-bin/hermes"
for harness in Hermes OpenCode; do
  installed_home="$probe_dir/installed-$harness"
  mkdir -p "$installed_home"
  for pass in 1 2; do
    PATH="$probe_dir/hermes-bin:$PATH" link_user_skills "$harness" "$installed_home" > "$probe_dir/install-$harness-$pass.out"
    for skill in tap-collab tap-pair tap-discuss; do
      if ! grep -Fq "tap help skill ${skill#tap-}" "$installed_home/skills/$skill/SKILL.md"; then
        echo "install-skill-coverage: $harness install $pass did not delegate /$skill to its shipped source" >&2
        fail=1
      fi
    done
  done
done

source_repo="$probe_dir/source-only"
source_home="$probe_dir/home-source-only"
mkdir -p "$source_repo" "$source_home"
for s in ${listed_repo_local+"${listed_repo_local[@]}"}; do
  mkdir -p "$source_repo/skills/$s"
  cp "$ROOT/skills/$s/SKILL.md" "$source_repo/skills/$s/SKILL.md"
done
git -C "$source_repo" init -q
dump_skills "$source_repo" "$source_home" "$probe_dir/source-only.out"
for s in ${listed_repo_local+"${listed_repo_local[@]}"}; do
  if grep -Fxq "$s" "$probe_dir/source-only.out"; then
    echo "install-skill-coverage: isolated source-only repo unexpectedly discovered REPO_LOCAL skill '$s' without a convention relay" >&2
    fail=1
  fi
done

# Hold the convention directory constant too: if its mere presence makes
# OpenCode scan top-level skills/, a positive hit cannot be attributed to the
# relay inside that directory.
for convention in claude agents; do
  for s in ${listed_repo_local+"${listed_repo_local[@]}"}; do
    repo="$probe_dir/$convention-empty-$s"
    home="$probe_dir/home-$convention-empty-$s"
    dump="$probe_dir/$convention-empty-$s.out"
    mkdir -p "$repo/skills/$s" "$repo/.$convention/skills" "$home"
    cp "$ROOT/skills/$s/SKILL.md" "$repo/skills/$s/SKILL.md"
    git -C "$repo" init -q
    dump_skills "$repo" "$home" "$dump"
    if grep -Fxq "$s" "$dump"; then
      echo "install-skill-coverage: isolated .$convention/skills directory without a relay unexpectedly discovered REPO_LOCAL skill '$s'" >&2
      fail=1
    fi
  done
done

for convention in claude agents; do
  for s in ${listed_repo_local+"${listed_repo_local[@]}"}; do
    repo="$probe_dir/$convention-$s"
    home="$probe_dir/home-$convention-$s"
    dump="$probe_dir/$convention-$s.out"
    mkdir -p "$repo/skills/$s" "$repo/.$convention/skills" "$home"
    cp "$ROOT/skills/$s/SKILL.md" "$repo/skills/$s/SKILL.md"
    ln -s "../../skills/$s" "$repo/.$convention/skills/$s"
    git -C "$repo" init -q
    dump_skills "$repo" "$home" "$dump"
    if ! grep -Fxq "$s" "$dump"; then
      echo "install-skill-coverage: opencode did not discover REPO_LOCAL skill '$s' through .$convention/skills" >&2
      fail=1
    fi
  done
done

# /tap-collab must load beside both work shapes, and compatibility aliases must
# remain separately discoverable. Isolated machine state prevents an installed
# legacy link from hiding a missing relay or the wrong frontmatter name.
linked_dump="$probe_dir/linked-skills.out"
# v2 walks all ancestors, beyond the git root. Copy the checkout's discovery
# inputs into the sandbox so that walk cannot reach the operator's home.
linked_repo="$probe_dir/linked-repo"
mkdir -p "$linked_repo"
for entry in .claude .agents .opencode skills plugins opencode.json opencode.jsonc; do
  [ ! -e "$ROOT/$entry" ] || cp -RP "$ROOT/$entry" "$linked_repo/$entry"
done
git -C "$linked_repo" init -q
dump_skills "$linked_repo" "$probe_dir/linked-home" "$linked_dump"
for skill in tap-collab tap-pair tap-discuss tap-conduct tap; do
  if grep -Fxq "$skill" "$linked_dump"; then
    echo "install-skill-coverage: duplicate product skill /$skill leaked from repo state" >&2
    fail=1
  else
    echo "install-skill-coverage: product /$skill correctly requires machine install"
  fi
done

# Flat-host wrappers retain prefixed names and delegate to canonical policy.
alias_home="$probe_dir/alias-loader-home"
mkdir -p "$alias_home/.config/opencode"
link_user_skills OpenCode "$alias_home/.config/opencode" > "$probe_dir/alias-install.out"
dump_skills "$source_repo" "$alias_home" "$probe_dir/aliases.out"
for skill in tap-lead tap-drive tap-conduct tap; do
  grep -Fxq "$skill" "$probe_dir/aliases.out" \
    || { echo "install-skill-coverage: generated/canonical $skill missing from loader" >&2; fail=1; }
done

for skill in lead drive conductor using-tap; do
  if grep -Fxq "$skill" "$probe_dir/aliases.out"; then
    echo "install-skill-coverage: old alias $skill leaked into discovery" >&2; fail=1
  fi
done

# Tombstones are explicit lookup documents, never loader entries or relays.
for skill in "${TOMBSTONE_SKILLS[@]}"; do
  [ -f "$ROOT/compat/skills/$skill/SKILL.md" ] || {
    echo "install-skill-coverage: missing tombstone $skill" >&2; fail=1;
  }
  for dump in "$linked_dump" "$probe_dir/aliases.out"; do
    if grep -Fxq "$skill" "$dump"; then
      echo "install-skill-coverage: retired $skill leaked into discovery" >&2; fail=1;
    fi
  done
  for convention in claude agents; do
    if [ -e "$ROOT/.$convention/skills/$skill" ] || [ -L "$ROOT/.$convention/skills/$skill" ]; then
      echo "install-skill-coverage: retired relay $convention/$skill remains" >&2; fail=1;
    fi
  done
done

[ "$fail" -eq 0 ] || exit 1
echo "install-skill-coverage: ok"
