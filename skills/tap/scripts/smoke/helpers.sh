#!/usr/bin/env bash
# Shared helpers for TAP smoke fixtures.

# shellcheck source=sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

# Explicit current-world fixture for registration tests with a custom bus.
# The production register door refuses old stores; tests seed their own index.
# A canonical <root>/.tap/bus gets the production shape: the acting registry is
# <root>/.tap/team-registry.json (native derives the team root from it) and the
# bus registry.json is a symlink to it. Any other bus keeps its registry.json.
tap_smoke_enroll_current() { # <worktree-root> <bus> [team-name]
  python3 -B - "$1" "$2" "${TAP_INDEX_HOME:?}" "${3:-}" <<'PY'
import json, os, pathlib, sys
root, bus, index = map(pathlib.Path, sys.argv[1:4])
root = root.resolve()
name = sys.argv[4] or root.name
bus.mkdir(parents=True, exist_ok=True)
index.mkdir(parents=True, exist_ok=True)
registry = bus / "registry.json"
canonical = bus.resolve() == (root / ".tap" / "bus").resolve()
acting = root / ".tap" / "team-registry.json" if canonical else registry
if canonical and registry.exists() and not registry.is_symlink():
    if acting.exists():
        sys.exit(f"tap_smoke_enroll_current: both {registry} and {acting} exist; seed one")
    source = registry
else:
    source = acting
if not source.exists():
    source.write_text(json.dumps({"schema": "0.20", "team": {"name": name, "worktree_root": str(root)}, "seats": {}}) + "\n")
else:
    # Enroll only a current-format fixture; adopting an old one hides it.
    doc = json.loads(source.read_text())
    if not (isinstance(doc, dict) and doc.get("schema") == "0.20"
            and isinstance(doc.get("seats"), dict) and "agents" not in doc):
        sys.exit(f"tap_smoke_enroll_current: {source} is not a current-format fixture "
                 '({"schema":"0.20","team":{...},"seats":{...}}, no agents); convert it first')
if source != acting:
    source.rename(acting)
if canonical and not registry.is_symlink():
    registry.symlink_to("../team-registry.json")
gpath = index / "global-registry.json"
doc = json.loads(gpath.read_text()) if gpath.exists() else {"schema": "0.20", "teams": {}}
doc["teams"][name] = {"root": str(root), "registry_location": str(acting.resolve()), "state": "registered"}
gpath.write_text(json.dumps(doc) + "\n")
PY
}

# Keep expected setup noise out of green runs, but replay stderr before returning
# an unexpected non-zero status so set -e never turns a useful refusal into a
# bare, context-free fixture exit.
tap_smoke_quiet() {
  local stderr_file rc
  stderr_file="$(mktemp "${TMPDIR:-/tmp}/tap-smoke-stderr.XXXXXX")" || {
    printf 'tap smoke: could not create a temporary stderr capture\n' >&2
    return 1
  }

  if "$@" >/dev/null 2>"$stderr_file"; then
    rm -f "$stderr_file" || true
    return 0
  else
    rc=$?
  fi

  cat "$stderr_file" >&2 || true
  rm -f "$stderr_file" || true
  return "$rc"
}

# Opt in after choosing a fixture bus. Loading helpers alone must not alter
# locale, tmux routing, or a production library already sourced by a test.
tap_smoke_runtime() {
  . "$(dirname "${BASH_SOURCE[0]}")/runtime-helpers.sh"
}
