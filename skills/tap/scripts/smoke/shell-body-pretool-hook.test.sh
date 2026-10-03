#!/usr/bin/env bash
# shell-body-pretool-hook.test.sh — tap-liero: the Claude PreToolUse hook is a
# best-effort backstop for common direct forms, not a shell fence. Pipeline
# producers, the ! and time prefixes, coproc, other wrappers, and nested shell
# constructs remain outside its boundary; file-first input is the reliable
# protection, with a quoted heredoc as the shell alternative.
set -euo pipefail
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../../tap/scripts/smoke/sandbox-pins.sh"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"

python3 -B - "$ROOT" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
manifest = json.loads((root / "hooks/hooks.json").read_text())
commands = [
    hook.get("command", "")
    for entry in manifest.get("hooks", {}).get("PreToolUse", [])
    if entry.get("matcher") == "Bash"
    for hook in entry.get("hooks", [])
    if "tap-shell-body-guard" in hook.get("command", "")
]
if len(commands) != 1:
    raise SystemExit(
        "shell-body-pretool-hook: expected one Bash PreToolUse body guard "
        f"registration, got {commands!r}"
    )

hook_command = commands[0].replace("${CLAUDE_PLUGIN_ROOT}", str(root))


def invoke(command, *, tool_name="Bash", raw_input=None):
    payload = raw_input
    if payload is None:
        payload = json.dumps(
            {
                "session_id": "test-session",
                "transcript_path": "/tmp/test-transcript.jsonl",
                "cwd": str(root),
                "permission_mode": "default",
                "hook_event_name": "PreToolUse",
                "tool_name": tool_name,
                "tool_input": {"command": command},
                "tool_use_id": "toolu_test",
            }
        )
    return subprocess.run(
        hook_command,
        shell=True,
        cwd=root,
        env={**os.environ, "CLAUDE_PLUGIN_ROOT": str(root)},
        input=payload,
        text=True,
        capture_output=True,
        check=False,
    )


def _assert_denied_impl(label, command, *, expect_class=None):
    result = invoke(command)
    if result.returncode != 0:
        raise SystemExit(
            f"shell-body-pretool-hook: {label} hook exited {result.returncode}: "
            f"{result.stderr!r}"
        )
    try:
        output = json.loads(result.stdout)
        decision = output["hookSpecificOutput"]
    except (json.JSONDecodeError, KeyError) as exc:
        raise SystemExit(
            f"shell-body-pretool-hook: {label} did not emit a structured decision: "
            f"{result.stdout!r} ({exc})"
        ) from exc
    if decision.get("hookEventName") != "PreToolUse" or decision.get("permissionDecision") != "deny":
        raise SystemExit(
            f"shell-body-pretool-hook: {label} was not denied: {decision!r}"
        )
    reason = decision.get("permissionDecisionReason", "")
    if expect_class == "heredoc_backtick":
        if "<<'EOF'" not in reason:
            raise SystemExit(
                f"shell-body-pretool-hook: {label} heredoc backtick denial must name <<'EOF': {reason!r}"
            )
        if "-f <path>" in reason or "-f -" in reason:
            raise SystemExit(
                f"shell-body-pretool-hook: {label} heredoc backtick denial must not offer tap-specific -f: {reason!r}"
            )
    elif expect_class == "tap_body":
        if "-f" not in reason:
            raise SystemExit(
                f"shell-body-pretool-hook: {label} tap body denial must name -f: {reason!r}"
            )
    else:
        if "<<'EOF'" not in reason and "-f" not in reason:
            raise SystemExit(
                f"shell-body-pretool-hook: {label} denial omitted a repair recipe: {reason!r}"
            )


def assert_denied(label, command):
    _assert_denied_impl(label, command, expect_class="tap_body")


def assert_denied_heredoc_backtick(label, command):
    _assert_denied_impl(label, command, expect_class="heredoc_backtick")


def assert_allowed(label, command, *, tool_name="Bash", raw_input=None):
    result = invoke(command, tool_name=tool_name, raw_input=raw_input)
    if result.returncode != 0 or result.stdout or result.stderr:
        raise SystemExit(
            f"shell-body-pretool-hook: {label} should be silent/allowed, got "
            f"rc={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}"
        )


def assert_tmux_denied(label, command, *, harness="claude"):
    if harness == "cursor":
        payload = {"command": command}
    elif harness == "antigravity":
        payload = {
            "toolCall": {
                "name": "run_command",
                "args": {"CommandLine": command},
            }
        }
    else:
        payload = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": command},
        }
    result = invoke(command, raw_input=json.dumps(payload))
    if result.returncode != 0:
        raise SystemExit(
            f"shell-body-pretool-hook: {label} hook exited {result.returncode}: "
            f"{result.stderr!r}"
        )
    try:
        output = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"shell-body-pretool-hook: {label} emitted no structured denial: "
            f"{result.stdout!r}"
        ) from exc
    if harness == "cursor":
        denied = output.get("permission") == "deny"
        reason = output.get("agent_message", "")
    elif harness == "antigravity":
        denied = output.get("decision") == "deny"
        reason = output.get("reason", "")
    else:
        decision = output.get("hookSpecificOutput", {})
        denied = decision.get("permissionDecision") == "deny"
        reason = decision.get("permissionDecisionReason", "")
    if not denied:
        raise SystemExit(
            f"shell-body-pretool-hook: {label} was not denied: {output!r}"
        )
    for needle in ("every TAP team", "tmux -L", "tmux -S", "outside the agent"):
        if needle not in reason:
            raise SystemExit(
                f"shell-body-pretool-hook: {label} denial omitted {needle!r}: {reason!r}"
            )


assert_denied("preview backtick", 'tap send peer -f body.md --preview "Discuss `command`"')
assert_denied("preview substitution", 'tap reply id -f body.md --preview "Discuss $(command)"')
assert_denied("preview assign", 'tap assign peer -f body.md --preview "Discuss `command`"')
assert_denied("preview escalate", 'tap escalate -f body.md --preview "Discuss `command`"')
assert_allowed("literal preview", "tap send peer -f body.md --preview 'Discuss `command`'")

assert_denied(
    "double-quoted tap send backtick",
    'tap send peer -m "report `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "equals-attached tap send dollar-paren",
    'tap send peer -m="report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "attached tap send dollar-paren",
    'tap send peer -m"report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "double-quoted tap reply dollar-paren",
    'tap reply payload-id -m "result $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "attached tap reply backtick",
    'tap reply payload-id -m"result `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "unquoted tap escalate backtick",
    "tap escalate -m blocked-`touch /tmp/tap-hook-probe`",
)
assert_denied(
    "attached tap escalate dollar-paren",
    'tap escalate -m"blocked $(touch /tmp/tap-hook-probe)"',
)
# tap-oglkh :668 (codex P1): `assign` is a send-alias verb that takes -m/-f, so it
# must be in the inline-body classifier or `tap assign x -m "$(...)"` bypasses the
# guard and the composing shell runs the substitution before TAP sees the body.
assert_denied(
    "double-quoted tap assign backtick",
    'tap assign peer -m "investigate `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "attached tap assign dollar-paren",
    'tap assign peer -m"investigate $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "bd description backtick",
    'bd update tap-liero -d "ran `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "attached bd description dollar-paren",
    'bd create x -d"see $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "bd notes dollar-paren",
    'bd create --notes="ran $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "bd append-notes dollar-paren",
    'bd update tap-liero --append-notes="ran $(touch /tmp/tap-hook-probe)"',
)
assert_denied_heredoc_backtick(
    "unquoted TAP heredoc backtick",
    "tap send peer -f - <<EOF\nran `touch /tmp/tap-hook-probe`\nEOF",
)
assert_denied(
    "unquoted TAP heredoc dollar-paren",
    "tap send peer -f - <<EOF\nran $(touch /tmp/tap-hook-probe)\nEOF",
)
assert_denied_heredoc_backtick(
    "redirection-prefixed unquoted TAP heredoc backtick",
    "<<EOF tap send peer -f -\nran `touch /tmp/tap-hook-probe`\nEOF",
)
assert_denied(
    "redirection-prefixed tap send",
    '</dev/null tap send peer -m "report `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "descriptor-redirection-prefixed tap send",
    '2>&1 tap send peer -m "report `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "clobber-redirection-prefixed tap send",
    '>|/tmp/tap-hook-output tap send peer -m "report `touch /tmp/tap-hook-probe`"',
)
assert_denied_heredoc_backtick(
    "trailing-backslash unquoted TAP heredoc backtick",
    "tap send peer -f - <<EOF\nran `touch /tmp/tap-hook-probe` \\\nEOF",
)
assert_denied(
    "environment-prefixed tap send",
    'TAP_HOME=/tmp/tap-test tap send peer -m "report `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "env-wrapped tap send",
    'env TAP_HOME=/tmp/tap-test tap send peer -m "report `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "path-qualified env-wrapped tap send",
    '/usr/bin/env TAP_HOME=/tmp/tap-test tap send peer -m "report `touch /tmp/tap-hook-probe`"',
)
assert_denied(
    "option-bearing env-wrapped tap send",
    '/usr/bin/env -i /abs/path/tap send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "operand-option env-wrapped tap send",
    '/usr/bin/env -u TAP_HOME -- /abs/path/tap send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "GNU flag-option env-wrapped tap send",
    'env --ignore-environment tap send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "GNU operand-option env-wrapped tap send",
    'env --unset=FOO tap send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "option-bearing command-wrapped tap send",
    'command -p /abs/path/tap send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "option-terminated command-wrapped tap send",
    'command -- /abs/path/tap send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "option-bearing bash-wrapped tap send",
    'bash -x scripts/tap.sh send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "option-bearing sh-wrapped tap send",
    'sh -x scripts/tap.sh send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "path-qualified option-bearing bash-wrapped tap send",
    '/bin/bash -x scripts/tap.sh send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "path-qualified option-bearing sh-wrapped tap send",
    '/bin/sh -x scripts/tap.sh send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "path-qualified bash-wrapped tap send",
    '/bin/bash scripts/tap.sh send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "path-qualified command-wrapped tap send",
    '/usr/bin/command -p /abs/path/tap send peer -m "report $(touch /tmp/tap-hook-probe)"',
)
assert_denied(
    "dash-leading inline body",
    'tap send peer -m "--report=`touch /tmp/tap-hook-probe`"',
)

# tap-n40rq: any-consumer unquoted heredoc with backtick — the widened class.
# tap-psif: the fork-bomb incident body shape (cat > file <<EOF with backtick).
assert_denied_heredoc_backtick(
    "tap-psif: non-tap unquoted heredoc backtick (any consumer)",
    'cat > "$stub" <<EOF\necho `date`\nEOF',
)
assert_denied_heredoc_backtick(
    "python3 unquoted heredoc backtick (leader 07:09Z shape)",
    "python3 - <<PY\nprint('ran at `date`')\nPY",
)
assert_denied_heredoc_backtick(
    "cat unquoted heredoc backtick",
    "cat <<EOF\nThe command is `tap send`\nEOF",
)
assert_denied_heredoc_backtick(
    "tab-stripping unquoted heredoc backtick",
    "cat <<-EOF\n\tran `date`\n\tEOF",
)

# tap-n40rq finding 1: mixed heredoc ordering — unquoted before quoted on the same line.
assert_denied_heredoc_backtick(
    "unquoted then quoted: backtick in first body",
    "cat <<A <<'B'\nran `date`\nA\nquoted safe\nB",
)
assert_denied_heredoc_backtick(
    "unquoted body containing a quoted-heredoc example before a backtick",
    "cat <<OUTER\nExample: <<'INNER'\nran `date`\nOUTER",
)

# Panel finding #1: backslash-newline continuation before delimiter.
assert_denied_heredoc_backtick(
    "continued body line before delimiter hides later backtick",
    "cat <<EOF\nsafe\\\nEOF\nran `date`\nEOF",
)

# Panel finding #3: numeric and partially quoted delimiters.
assert_denied_heredoc_backtick(
    "numeric delimiter",
    "cat <<123\nran `date`\n123",
)
assert_allowed(
    "partially quoted delimiter (Bash does not expand)",
    "cat <<'A'Z\nran `date`\nAZ",
)

# tap-6qxht: direct default-server teardown is never an agent operation. The
# exact incident line is the load-bearing RED; the other payloads prove that
# the same classifier speaks each installed harness's native hook contract.
incident = 'TMUX_TMPDIR="$SHORT/tt" tmux kill-server 2>/dev/null'
assert_tmux_denied("Claude/Codex incident line", incident)
assert_tmux_denied("Cursor incident line", incident, harness="cursor")
assert_tmux_denied("Antigravity incident line", incident, harness="antigravity")
assert_tmux_denied("bare kill-server", "tmux kill-server")
assert_tmux_denied("command-wrapped kill-server", "command tmux kill-server")
real_tmux = "/usr/bin/" + "tmux"
assert_tmux_denied("path-qualified kill-server", f"{real_tmux} kill-server")
assert_tmux_denied(
    "scrub plus TMUX_TMPDIR is still unpinned",
    "env -u TMUX -u TMUX_PANE TMUX_TMPDIR=$SHORT/private tmux kill-server",
)
assert_tmux_denied("shortest unique-prefix kill-server", "tmux kill-ser")
assert_tmux_denied("escaped kill-server", r"tmux kill\-server")
assert_tmux_denied("quoted kill-server", 'tmux "kill"-server')
assert_tmux_denied("line-continued kill-server", "tmux \\\nkill-server")
assert_tmux_denied(
    "kill-server after a heredoc body ending in a backslash",
    "cat <<'EOF'\nfoo\\\nEOF\ntmux kill-server",
)
assert_tmux_denied("kill-server after a here-string", "cat <<<EOF\ntmux kill-server")
assert_tmux_denied("socket option after verb", "tmux kill-server -S $SHORT/private")

assert_allowed(
    "single-quoted tap body",
    "tap send peer -m 'literal `touch /tmp/tap-hook-probe`'",
)
assert_allowed("plain inline body", 'tap send peer -m "plain status"')
assert_allowed(
    "bd body-file path substitution",
    'bd create x --body-file="$(printf /tmp/body)"',
)
assert_allowed(
    "unrecognized gh body-file path substitution",
    'gh issue create --body-file="$(printf /tmp/body)"',
)
assert_allowed(
    "bd notes-contains filter path substitution",
    'bd search --notes-contains="$(printf needle)"',
)
assert_allowed(
    "quoted TAP heredoc",
    "tap send peer -f - <<'EOF'\nliteral `touch /tmp/tap-hook-probe`\nEOF",
)
assert_allowed(
    "quoted heredoc containing a bad TAP example",
    "cat >note <<'EOF'\ntap send peer -m \"literal `date`\"\nEOF",
)
assert_allowed(
    "quoted outer heredoc with unquoted-heredoc example containing backticks",
    "cat >doc.md <<'EOF'\nExample:\n```bash\ncat <<INNER\nran `date`\nINNER\n```\nEOF",
)
assert_allowed(
    "escaped inline substitutions",
    r'tap send peer -m "literal \`date\` and \$(date)"',
)
assert_allowed(
    "safe expansions in an unquoted heredoc",
    "tap send peer -f - <<EOF\nretry in $((n+1)); literal \\$(date)\nEOF",
)
assert_allowed(
    "non-tap unquoted heredoc dollar-paren (intentional expansion)",
    "cat <<EOF\ntoday is $(date)\nEOF",
)
assert_allowed(
    "single-quoted delimiter with backtick body",
    "cat <<'EOF'\nran `date`\nEOF",
)
assert_allowed(
    "double-quoted delimiter with backtick body",
    'cat <<"EOF"\nran `date`\nEOF',
)
assert_allowed(
    "non-tap $() in mixed-segment heredoc",
    "tap send peer -m plain; cat <<EOF\ntoday is $(date)\nEOF",
)
assert_allowed("unrelated command substitution", 'printf "%s\\n" "$(date)"')
assert_allowed(
    "arithmetic expansion in a tap body",
    'tap send peer -m "retry in $((n+1)) seconds"',
)
assert_allowed(
    "TAP example passed to another command",
    'echo tap send peer -m "literal `date`"',
)
assert_allowed("explicit -L socket", "tmux -L private kill-server")
assert_allowed("joined -L socket", "tmux -Lprivate kill-server")
assert_allowed("explicit -S socket", "tmux -S $SHORT/private.sock kill-server")
assert_allowed("joined -S socket", "tmux -S$SHORT/private.sock kill-server")
assert_allowed("socket after another client flag", "tmux -2u -L private kill-server")
assert_allowed("tmux list", "tmux ls")
assert_allowed("ambiguous kill-server prefix", "tmux kill-se")
assert_allowed("tmux send-keys", "tmux send-keys -t %7 echo safe")
assert_allowed("targeted kill-session", "tmux kill-session -t =team/seat")
assert_allowed("targeted kill-window", "tmux kill-window -t @7")
assert_allowed("targeted kill-pane", "tmux kill-pane -t %7")
assert_allowed("kill-server mentioned as data", "echo tmux kill-server")
assert_allowed(
    "kill-server in quoted heredoc data",
    "cat >note <<'EOF'\ntmux kill-server\nEOF",
)
assert_allowed(
    "kill-server in unquoted heredoc data",
    "cat >note <<EOF\ntmux kill-server\nEOF",
)
assert_allowed(
    "kill-server in tab-stripping heredoc data",
    "cat >note <<-EOF\n\ttmux kill-server\n\tEOF",
)
assert_allowed(
    "kill-server in the second of multiple heredoc bodies",
    "cat <<A <<B\nfoo\nA\ntmux kill-server\nB",
)
assert_allowed(
    "redirection-prefixed single-quoted tap body",
    "</dev/null tap send peer -m 'literal `date`'",
)
assert_allowed(
    "command-shaped shell comment",
    'tap send peer -m "plain status" # example: tap send peer -m "bad `date`"',
)
assert_allowed(
    "command substitution outside the body",
    'tap send peer --id "$(uuidgen)" -m "plain status"',
)
assert_allowed(
    "non-Bash tool",
    'tap send peer -m "report `touch /tmp/tap-hook-probe`"',
    tool_name="Write",
)
assert_allowed("malformed hook input", "", raw_input="{")
assert_allowed("array hook input", "", raw_input="[]")
assert_allowed("null hook input", "", raw_input="null")
assert_allowed("string hook input", "", raw_input='"text"')
assert_allowed(
    "null tool input",
    "",
    raw_input='{"tool_name":"Bash","tool_input":null}',
)
assert_allowed(
    "array tool input",
    "",
    raw_input='{"tool_name":"Bash","tool_input":[]}',
)

# Execute only harmless Bash oracles: functions replace both protected tools.
# The same source then goes through the public hook, so each RED reaches the
# named production predicate instead of merely testing a parser helper.
def bash_oracle(source, expected):
    result = subprocess.run(
        ["/bin/bash", "-c", "tmux() { printf 'EXECUTED\\n'; }; "
         "tap() { printf 'EXECUTED\\n'; };\n" + source],
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, (source, result.stderr)
    assert expected in result.stdout, (source, result.stdout, result.stderr)


regression_failures = []


def regression(check, label, source):
    try:
        check(label, source)
    except SystemExit as error:
        regression_failures.append(str(error))


for separator in ("\x85", "\u2028", "\u2029", "\r"):
    source = "cat <<EOF\nEOF" + separator + "`printf EXPANDED`\nEOF"
    bash_oracle(source, "EXPANDED")
    regression(assert_denied_heredoc_backtick, "only LF closes shell lines " + repr(separator), source)
    source = "cat <<'EOF'\nEOF" + separator + "\ntmux kill-server\nEOF"
    bash_oracle(source, "tmux kill-server")
    regression(assert_allowed, "only LF closes quoted bodies " + repr(separator), source)

for label, source in (
    ("concatenated quoted delimiter", "cat <<'A'Z\ndata\nAZ\ntap send peer -m \"`printf EXPANDED`\"\n# A\nA"),
    ("punctuation delimiter", "cat <<END-1\ndata\nEND-1\ntmux kill-server\n# END"),
    ("continued delimiter", "cat <<E\\\nOF\ndata\nEOF\ntmux kill-server\n# E"),
    ("double quote preserves ordinary backslash", 'cat <<"E\\q"\ndata\nE\\q\ntmux kill-server\n# Eq'),
    ("arithmetic shift is not a heredoc", "printf '%s\\n' $((1<<2))\ntmux kill-server\n# 2"),
    ("quoted opener mention", "printf '%s\\n' \"mention <<'EOF'\"\ntmux kill-server\n# EOF"),
):
    # A is an inert command only in the first hook fixture; omit it in the
    # oracle so its unrelated command-not-found status cannot mask evidence.
    bash_oracle(source.removesuffix("\nA"), "EXECUTED")
    if label == "concatenated quoted delimiter":
        regression(assert_denied, label, source)
    else:
        regression(assert_tmux_denied, label, source)

source = "cat <<\\\nEOF\n`printf EXPANDED`\nEOF"
bash_oracle(source, "EXPANDED")
regression(assert_denied_heredoc_backtick, "line continuation is not delimiter quoting", source)
source = "printf '%s\\n' '$((literal'; cat <<EOF\n`printf EXPANDED`\nEOF"
bash_oracle(source, "EXPANDED")
regression(assert_denied_heredoc_backtick, "quoted arithmetic mention cannot hide opener", source)
source = "echo hi # <<EOF\ntmux kill-server"
bash_oracle(source, "EXECUTED")
regression(assert_tmux_denied, "comment opener mention cannot hide command", source)
source = "cat <<E\\\nOF\n`printf EXPANDED`\nEOF"
bash_oracle(source, "EXPANDED")
regression(assert_denied_heredoc_backtick, "in-word continuation is not delimiter quoting", source)
source = "echo \\<<EOF\ntmux kill-server\n# EOF"
bash_oracle(source, "EXECUTED")
regression(assert_tmux_denied, "escaped opener cannot hide command", source)
regression(assert_allowed, "quoted full concatenated delimiter is data", "cat <<'A'Z\n`date`\nAZ")
regression(assert_allowed, "quoted punctuation delimiter is data", "cat <<'END-1'\ntmux kill-server\n`date`\nEND-1")

for label, source in (
    ("here-string backtick body", 'tap send peer -f - <<< "before `printf EXPANDED` after"'),
    ("here-string dollar-paren body", 'tap send peer -f - <<< "before $(printf EXPANDED) after"'),
    ("long body-file here-string", 'tap send peer --body-file - <<< "$(printf EXPANDED)"'),
    ("attached here-string target", 'tap send peer -f - <<<"$(printf EXPANDED)"'),
    ("explicit stdin here-string", 'tap send peer -f - 0<<< "$(printf EXPANDED)"'),
    ("prefix here-string", '<<< "$(printf EXPANDED)" tap send peer -f -'),
):
    bash_oracle("tap() { cat; };\n" + source, "EXPANDED")
    regression(assert_denied, label, source)
for label, source in (
    ("single-quoted here-string data", "tap send peer -f - <<< 'literal `date` $(date)'"),
    ("escaped here-string data", 'tap send peer -f - <<< "literal \\`date\\` \\$(date)"'),
    ("unrelated expansion with literal here-string", 'tap send peer --id "$(printf id)" -f - <<< "literal"'),
    ("file input is not here-string body", 'tap send peer -f /dev/null <<< "$(printf value)"'),
    ("non-stdin here-string", 'tap send peer -f - 3<<< "$(printf value)"'),
    ("intentional non-TAP here-string", 'cat <<< "$(printf value)"'),
):
    regression(assert_allowed, label, source)


# tap-hxt2v: literal shell words and executable/data boundaries share one
# classifier in every adapter. None of these strings executes real tmux.
lexical_denials = [
    "tmux $'kill-server'",
    r"tmux k$'ill\x2d'server",
    r"tmux $'kill\055server'",
    r"$'tm\165\170' kill-server",
    r"tmux $'kill-server\0ignored'",
    "printf '%s' $'it\\'s <<EOF'; tmux kill-server",
    ": # <<EOF\ntmux kill-server\nEOF",
    ": # ' <<EOF\ntmux kill-server",
    ": # comment \\\ntmux kill-server",
    "cat <<$'EO\\106'\ntext\nEOF\ntmux kill-server",
]
lexical_allowances = [
    "tmux -L private $'kill-server'",
    "tmux -S $SHORT/private.sock $'kill-server'",
    "tmux $'-L' private $'kill-server'",
    r"tmux $'kill\-server'",  # unknown ANSI escape keeps the backslash
    r"tmux \$'kill-server'",
    "tmux \"$'kill-server'\"",
    ": # ; tmux kill-server",
    "# ' ; tmux kill-server\nprintf safe",
    "printf '%s' $'literal # ; tmux kill-server'",
    "cat <<$'EO\\106'\ntmux kill-server\nEOF",
    "cat <<'EOF'\ntmux $'kill-server'\nEOF",
    "tap send peer -m $'literal $(date) `date`'",
]
for source in lexical_denials:
    # A harmless function stands in for tmux and establishes executable reach.
    bash_oracle(source.removesuffix("\nEOF"), "EXECUTED")
    for harness in ("claude", "cursor", "antigravity"):
        try:
            assert_tmux_denied("lexical " + repr(source), source, harness=harness)
        except SystemExit as error:
            regression_failures.append(str(error))
for source in lexical_allowances:
    regression(assert_allowed, "lexical data/pin " + repr(source), source)

if regression_failures:
    raise SystemExit("\n".join(regression_failures))

# ANSI-C word parity against bash and the shared-mechanism mutants moved to
# the Bun suite in the S1 port: runtime/bun/test/ansi-c-word.test.ts keeps
# the bash printf oracle for ansiCWord, and the corpus mutant battery
# (its mutant evidence is quoted in the PR) covers the
# mechanism mutants against frozen bytes. This smoke keeps exercising the
# registered hook command end to end, whichever runtime serves it.

print("shell-body-pretool-hook: known-bad inline bodies deny; safe forms stay silent: ok")
PY
