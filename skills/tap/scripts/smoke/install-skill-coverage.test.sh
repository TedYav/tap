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
# OpenCode itself in minimal git repos with isolated state. Its debug output is
# larger than 64 KiB in this checkout and OpenCode 1.18.21 truncates stdout at
# exactly 65,536 bytes when it is a pipe, so capture to a file before grepping.
# The source-only repo is the causal negative: it holds the same SKILL.md as
# each positive arm but no convention relay. A hit there means OpenCode scanned
# top-level skills/ (or leaked machine state), so the positives cannot prove
# which relay loaded the skill.
command -v opencode >/dev/null 2>&1 \
  || { echo "install-skill-coverage: opencode is required for repo-local loader coverage" >&2; exit 1; }
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/install-skill-loader.XXXXXX")"
trap 'rm -rf "$probe_dir"' EXIT

# Exercise the installer's actual link/reap functions without its hook writes.
# A second install must keep /tap-collab available beside both existing work shapes
# in the Claude and Codex skill roots. This proves installation, not CLI loading.
REPO="$ROOT"
export TAP_INSTALL_MANIFEST="$probe_dir/install-manifest.json"
export XDG_CONFIG_HOME="$probe_dir/config"
mkdir -p "$XDG_CONFIG_HOME/tap"
printf '[skills]\nfull_kit = true\n' > "$XDG_CONFIG_HOME/tap/config.toml"
# link_user_skills runs its Bun step through the installer's one-line tap_bun
# helper and tallies through the installer's counters and install_detail; take
# those lines from install.sh too, on the checkout path (ARTIFACT=0, quiet detail).
ARTIFACT=0
VERBOSE=0
for installer_line_prefix in '^tap_bun() ' '^install_detail() ' '^SKILL_LINK_COUNT=' '^SKILL_HOME_COUNT=' '^ABSENT_SKILL_HOMES='; do
  installer_line="$(grep -m1 "$installer_line_prefix" "$INSTALL_SH")" || installer_line=""
  [ -n "$installer_line" ] || { echo "install-skill-coverage: missing installer line $installer_line_prefix" >&2; exit 1; }
  eval "$installer_line"
done
for function_name in link_user_skills; do
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
(
  cd "$source_repo"
  env -i PATH="$PATH" HOME="$source_home" \
    XDG_CONFIG_HOME="$source_home/.config" \
    XDG_DATA_HOME="$source_home/.local/share" \
    XDG_CACHE_HOME="$source_home/.cache" \
    opencode debug skill --pure > "$probe_dir/source-only.out"
)
for s in ${listed_repo_local+"${listed_repo_local[@]}"}; do
  if grep -Fq "\"name\": \"$s\"" "$probe_dir/source-only.out"; then
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
    (
      cd "$repo"
      env -i PATH="$PATH" HOME="$home" \
        XDG_CONFIG_HOME="$home/.config" \
        XDG_DATA_HOME="$home/.local/share" \
        XDG_CACHE_HOME="$home/.cache" \
        opencode debug skill --pure > "$dump"
    )
    if grep -Fq "\"name\": \"$s\"" "$dump"; then
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
    (
      cd "$repo"
      env -i PATH="$PATH" HOME="$home" \
        XDG_CONFIG_HOME="$home/.config" \
        XDG_DATA_HOME="$home/.local/share" \
        XDG_CACHE_HOME="$home/.cache" \
        opencode debug skill --pure > "$dump"
    )
    if ! grep -Fq "\"name\": \"$s\"" "$dump"; then
      echo "install-skill-coverage: opencode did not discover REPO_LOCAL skill '$s' through .$convention/skills" >&2
      fail=1
    fi
  done
done

# /tap-collab must load beside both work shapes, and compatibility aliases must
# remain separately discoverable. Isolated machine state prevents an installed
# legacy link from hiding a missing relay or the wrong frontmatter name.
linked_dump="$probe_dir/linked-skills.out"
(
  cd "$ROOT"
  env -i PATH="$PATH" HOME="$probe_dir/linked-home" \
    XDG_CONFIG_HOME="$probe_dir/linked-config" \
    XDG_DATA_HOME="$probe_dir/linked-data" \
    XDG_CACHE_HOME="$probe_dir/linked-cache" \
    opencode debug skill --pure > "$linked_dump"
)
for skill in tap-collab tap-pair tap-discuss tap-conduct tap; do
  if grep -Fq "\"name\": \"$skill\"" "$linked_dump"; then
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
(
  cd "$probe_dir/source-only"
  env -i PATH="$PATH" HOME="$alias_home" \
    XDG_CONFIG_HOME="$alias_home/.config" \
    XDG_DATA_HOME="$alias_home/.local/share" \
    XDG_CACHE_HOME="$alias_home/.cache" \
    opencode debug skill --pure > "$probe_dir/aliases.out"
)
for skill in tap-lead tap-drive tap-conduct tap; do
  grep -Fq "\"name\": \"$skill\"" "$probe_dir/aliases.out" \
    || { echo "install-skill-coverage: generated/canonical $skill missing from loader" >&2; fail=1; }
done

for skill in lead drive conductor using-tap; do
  if grep -Fq "\"name\": \"$skill\"" "$probe_dir/aliases.out"; then
    echo "install-skill-coverage: old alias $skill leaked into discovery" >&2; fail=1
  fi
done

# Tombstones are explicit lookup documents, never loader entries or relays.
for skill in "${TOMBSTONE_SKILLS[@]}"; do
  [ -f "$ROOT/compat/skills/$skill/SKILL.md" ] || {
    echo "install-skill-coverage: missing tombstone $skill" >&2; fail=1;
  }
  for dump in "$linked_dump" "$probe_dir/aliases.out"; do
    if grep -Fq "\"name\": \"$skill\"" "$dump"; then
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
