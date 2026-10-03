#!/usr/bin/env bash
# Private companion helpers expose this fixture's overrides to native callers.
spool_callback_fixture() { # <private-root> <real-scripts>; declarations on stdin
  local root="$1" source="$2" scripts file
  scripts="$root/skills/tap/scripts"
  mkdir -p "$scripts/smoke"
  [ -e "$root/runtime" ] || ln -s "$source/../../../runtime" "$root/runtime"
  for file in "$source"/*; do
    [ "${file##*/}" = smoke ] && continue
    [ -e "$scripts/${file##*/}" ] || ln -s "$file" "$scripts/${file##*/}"
  done
  for file in "$source/smoke"/*; do
    [ "${file##*/}" = runtime-helpers.sh ] && continue
    [ -e "$scripts/smoke/${file##*/}" ] || ln -s "$file" "$scripts/smoke/${file##*/}"
  done
  {
    printf '. %q\n' "$source/smoke/runtime-helpers.sh"
    cat
    printf '_TAP_SCRIPT_DIR=%q\n' "$scripts"
  } > "$scripts/smoke/runtime-helpers.sh"
  printf '%s' "$scripts"
}
