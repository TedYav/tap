#!/usr/bin/env bash
# u6-u7-specimen.sh — synthetic specimens for u6-u7-composite.test.sh.
# Sourced only. Not a smoke itself.
#
# Variants (fresh workdir per call):
#   u67_specimen_membership  — alice + bob(poll) + carol(parked); ghost manifest-only
#   u67_specimen_happy       — current seats only + launch-config; no ambiguity
#   u67_specimen_ambiguous   — happy + alpha/alice-dup (same root/handle clash)
#
# Pre-migration: index/global-registry.json ABSENT (flip not live).

u67_specimen_common_dirs_() {
  local work="${1:?work dir}"
  U67_WORK="$work"
  U67_INDEX="$work/index"
  U67_TEAM="$work/alpha"
  U67_BUS="$U67_TEAM/.tap/bus"
  U67_MANIFEST="$work/launcher/sessions.json"
  U67_MANIFEST_LOCK="$work/launcher/sessions.json.lock"
  U67_BACKUP="$work/backup/0.20-migration"

  mkdir -p "$U67_INDEX" "$U67_BUS/payloads" "$U67_BUS/receipts" \
    "$U67_TEAM/.tap/team-history" "$work/launcher" "$work/beta/.tap/bus"
}

u67_specimen_write_teams_() {
  cat >"$U67_INDEX/teams.json" <<JSON
{
  "teams": {
    "alpha": {"root": "$U67_TEAM"},
    "beta": {"root": "$U67_WORK/beta"}
  }
}
JSON
}

# Membership / relaunch specimen: parked current + poll + manifest-only ghost.
u67_specimen_membership() {
  local work="${1:?work dir}"
  u67_specimen_common_dirs_ "$work"
  u67_specimen_write_teams_

  cat >"$U67_BUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "alpha", "worktree_root": "$U67_TEAM"},
  "seats": {
    "alice": {
      "status": "active",
      "delivery": "pane",
      "harness": "claude",
      "pane": "alpha/alice:0.0",
      "pane_id": "%101",
      "server_epoch": "srv:900:200",
      "instance": "alice|KEEP",
      "harness_session_id": "sess-alice-reg",
      "identity_capture_result": {
        "decision": "quarantined",
        "mode": "untrusted_resume",
        "expected_harness_session_id": "sess-alice-expected",
        "observed_harness_session_id": "sess-alice-obs",
        "reason": "specimen-ktd13"
      }
    },
    "bob": {
      "status": "active",
      "delivery": "poll",
      "harness": "claude",
      "instance": "bob|KEEP",
      "server_epoch": "srv:900:200"
    },
    "carol": {
      "status": "parked",
      "delivery": "pane",
      "harness": "claude",
      "instance": "carol|KEEP",
      "server_epoch": "srv:900:200",
      "harness_session_id": "sess-carol-parked"
    }
  }
}
JSON
  : >"$U67_BUS/registry-events.log"
  printf 'lock\n' >"$U67_BUS/registry.json.lock"

  cat >"$U67_MANIFEST" <<JSON
{
  "sessions": [
    {
      "name": "alpha/alice",
      "handle": "alice",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "alice",
      "model": "specimen-model",
      "teams": "beta",
      "passthrough": ["--foo", "bar"],
      "harness_session_id": "sess-alice-reg",
      "transcript_path": "/tmp/alice.jsonl",
      "identity_capture_result": {
        "decision": "quarantined",
        "mode": "untrusted_resume",
        "expected_harness_session_id": "sess-alice-expected",
        "observed_harness_session_id": "sess-alice-obs",
        "reason": "specimen-ktd13"
      }
    },
    {
      "name": "alpha/bob",
      "handle": "bob",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "bob",
      "delivery": "poll"
    },
    {
      "name": "alpha/carol",
      "handle": "carol",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "carol",
      "model": "carol-model",
      "harness_session_id": "sess-carol-parked"
    },
    {
      "name": "alpha/ghost",
      "handle": "ghost",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "ghost",
      "model": "ghost-model",
      "harness_session_id": "sess-ghost-only"
    }
  ]
}
JSON
  printf 'lock\n' >"$U67_MANIFEST_LOCK"
}

# Happy path: no ambiguity; includes dave with NO instance (U7 must mint).
# beta/alice present for cross-team isolation checks.
u67_specimen_happy() {
  local work="${1:?work dir}"
  u67_specimen_common_dirs_ "$work"
  u67_specimen_write_teams_

  cat >"$U67_BUS/registry.json" <<JSON
{
  "schema": "0.20", "team": {"name": "alpha", "worktree_root": "$U67_TEAM"},
  "seats": {
    "alice": {
      "status": "active",
      "delivery": "pane",
      "harness": "claude",
      "pane": "alpha/alice:0.0",
      "pane_id": "%101",
      "server_epoch": "srv:900:200",
      "instance": "alice|KEEP",
      "harness_session_id": "sess-alice-reg",
      "identity_capture_result": {
        "decision": "quarantined",
        "mode": "untrusted_resume",
        "expected_harness_session_id": "sess-alice-expected",
        "observed_harness_session_id": "sess-alice-obs",
        "reason": "specimen-ktd13"
      }
    },
    "bob": {
      "status": "active",
      "delivery": "poll",
      "harness": "claude",
      "instance": "bob|KEEP",
      "server_epoch": "srv:900:200"
    },
    "dave": {
      "status": "active",
      "delivery": "pane",
      "harness": "claude",
      "pane": "alpha/dave:0.0",
      "pane_id": "%102",
      "server_epoch": "srv:900:200"
    }
  }
}
JSON
  : >"$U67_BUS/registry-events.log"
  printf 'lock\n' >"$U67_BUS/registry.json.lock"

  cat >"$U67_MANIFEST" <<JSON
{
  "sessions": [
    {
      "name": "alpha/alice",
      "handle": "alice",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "alice",
      "model": "specimen-model",
      "teams": "beta",
      "passthrough": ["--foo", "bar"],
      "harness_session_id": "sess-alice-reg",
      "transcript_path": "/tmp/alice.jsonl",
      "identity_capture_result": {
        "decision": "quarantined",
        "mode": "untrusted_resume",
        "expected_harness_session_id": "sess-alice-expected",
        "observed_harness_session_id": "sess-alice-obs",
        "reason": "specimen-ktd13"
      }
    },
    {
      "name": "alpha/bob",
      "handle": "bob",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "bob",
      "delivery": "poll"
    },
    {
      "name": "alpha/dave",
      "handle": "dave",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "dave",
      "model": "dave-model",
      "harness_session_id": "sess-dave-reg"
    },
    {
      "name": "beta/alice",
      "handle": "alice",
      "harness": "claude",
      "cwd": "$U67_WORK/beta",
      "base": "beta",
      "tag": "alice",
      "model": "OTHER-TEAM-MODEL",
      "harness_session_id": "sess-other-alice"
    },
    {
      "name": "alpha/ghost",
      "handle": "ghost",
      "harness": "claude",
      "cwd": "$U67_TEAM",
      "base": "alpha",
      "tag": "ghost",
      "model": "ghost-model",
      "harness_session_id": "sess-ghost-only"
    }
  ]
}
JSON
  printf 'lock\n' >"$U67_MANIFEST_LOCK"
}

# Ambiguity specimen: two alpha records for handle alice.
u67_specimen_ambiguous() {
  u67_specimen_happy "$1"
  python3 -B - "$U67_MANIFEST" "$U67_TEAM" <<'PY'
import json, sys
path, team = sys.argv[1:3]
doc = json.load(open(path))
doc["sessions"].append({
    "name": "alpha/alice-dup",
    "handle": "alice",
    "harness": "claude",
    "cwd": team,
    "base": "alpha",
    "tag": "alice-dup",
    "model": "AMBIGUOUS-MODEL",
    "harness_session_id": "sess-alice-ambiguous",
})
json.dump(doc, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
}
