#!/usr/bin/env bash
# opencode-session-argv.test.sh — exact OpenCode IDs restore the recorded TUI;
# id-less launches stay fresh and never adopt a cwd sibling via --continue.
#
# WHY THE ARMS: launch and resume consume the exact record-owned ID, while an
# id-less row must never fall through to latest-session adoption.
# Persisted passthrough and live harness params compose after the pure builder,
# so the final child argv strips their IDs and pins the record-owned ID.
# The primary checkout hosts many OpenCode seats, so `--continue` can select
# another seat's conversation.
#
#            | has stored id       | no stored id
#   ---------+---------------------+----------------------
#   launch   | --session <id>      | neither flag
#   resume   | --session <id>      | neither flag (fresh)
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

# Pure argv and policy controls moved to launcher-opencode-session.test.ts.

# (8) The team-up path is `resume --all`. A stopped OpenCode row must not abort
# a mixed cohort: captured IDs resume exactly; id-less rows start fresh with one
# stderr notice, while JSON stdout remains machine-only in both cases.
TAP="$ROOT/scripts/tap.sh"
WORK="$(mktemp -d)"
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
export TAP_INDEX_HOME="$WORK/index"
REPO="$WORK/repo"
BUS="$REPO/.tap/bus"
ACTING="$REPO/.tap/team-registry.json"
mkdir -p "$BUS/payloads" "$BUS/receipts" "$WORK/index"
git -C "$REPO" init -q
python3 -B - "$ACTING" "$BUS/registry.json" "$TAP_INDEX_HOME/global-registry.json" "$REPO" <<'PY'
import json, pathlib, sys
acting, bus, index, root = map(pathlib.Path, sys.argv[1:])
team = {
    "schema": "0.20", "team": {"name": "repo", "worktree_root": str(root)},
    "seats": {
        "glm": {
            "status": "suspended", "status_reason": "session_stopped",
            "delivery": "pane", "session": "repo/glm", "harness": "opencode",
            "cwd": str(root), "base": "repo", "tag": "glm", "index": 1,
            "last_launched": "2026-07-10T00:17:45Z",
            "harness_session_id": "ses_previous",
        },
        "scout": {
            "status": "suspended", "status_reason": "session_stopped",
            "delivery": "pane", "session": "repo/scout", "harness": "claude",
            "cwd": str(root), "base": "repo", "tag": "scout", "index": 2,
            "last_launched": "2026-07-10T00:17:45Z",
        },
    },
}
acting.write_text(json.dumps(team) + "\n")
bus.write_text(json.dumps({"schema": "0.20", "team": team["team"], "seats": {}}) + "\n")
index.write_text(json.dumps({
    "schema": "0.20",
    "migrated": {"at": "2026-08-04T00:00:00Z", "backups": {}},
    "teams": {"repo": {
        "root": str(root), "registry_location": str(acting), "state": "registered",
    }},
}) + "\n")
PY

run_cohort() {
  before="$(cksum "$ACTING")"
  set +e
  (cd "$REPO" && "$TAP" session resume --all --dry-run --json) >"$WORK/out" 2>"$WORK/err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || { cat "$WORK/err" >&2; return "$rc"; }
  [ "$before" = "$(cksum "$ACTING")" ] || {
    echo "opencode-session-argv: dry-run cohort plan wrote the acting registry" >&2
    return 1
  }
}

run_cohort
python3 -B - "$WORK/out" "$WORK/err" <<'PY'
import json, sys
raw = open(sys.argv[1]).read()
err = open(sys.argv[2]).read()
rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
assert sorted(row["name"] for row in rows) == ["repo/glm", "repo/scout"], rows
opencode = next(row for row in rows if row["name"] == "repo/glm")
assert opencode["argv"] == ["opencode", "--session", "ses_previous"], opencode
assert "starting a fresh conversation" not in err, err
assert "starting a fresh conversation" not in raw, raw
print("opencode-session-argv: captured-id mixed cohort plans exact OpenCode + Claude: ok")
PY

set +e
(cd "$REPO" && "$TAP" session restart glm --dry-run --json) >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
[ "$rc" -eq 0 ] || { cat "$WORK/err" >&2; exit "$rc"; }
python3 -B - "$WORK/out" "$WORK/err" <<'PY'
import json, sys
plan = json.loads(open(sys.argv[1]).read().strip())
err = open(sys.argv[2]).read()
assert plan["argv"] == ["opencode", "--session", "ses_previous"], plan
assert "starting a fresh conversation" not in err, err
print("opencode-session-argv: captured-id restart plans the exact OpenCode session: ok")
PY

python3 -B - "$ACTING" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
doc = json.loads(path.read_text())
doc["seats"]["glm"].pop("harness_session_id")
path.write_text(json.dumps(doc) + "\n")
PY
run_cohort
python3 -B - "$WORK/out" "$WORK/err" <<'PY'
import json, sys
raw = open(sys.argv[1]).read()
err = open(sys.argv[2]).read()
rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
assert sorted(row["name"] for row in rows) == ["repo/glm", "repo/scout"], rows
opencode = next(row for row in rows if row["name"] == "repo/glm")
assert opencode["argv"] == ["opencode"], opencode
assert err.count("starting a fresh conversation") == 1, err
assert "native continuation" not in err and "OpenCode session id; falling back" not in err, err
assert "starting a fresh conversation" not in raw, raw
print("opencode-session-argv: id-less mixed cohort starts fresh with one notice: ok")
PY

set +e
(cd "$REPO" && "$TAP" session restart glm --dry-run --json) >"$WORK/out" 2>"$WORK/err"
rc=$?
set -e
[ "$rc" -eq 0 ] || { cat "$WORK/err" >&2; exit "$rc"; }
python3 -B - "$WORK/out" "$WORK/err" <<'PY'
import json, sys
plan = json.loads(open(sys.argv[1]).read().strip())
err = open(sys.argv[2]).read()
assert plan["argv"] == ["opencode"], plan
assert err.count("starting a fresh conversation") == 1, err
print("opencode-session-argv: id-less restart starts fresh with one notice: ok")
PY
