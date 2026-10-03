#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Contracts intentionally pin the exact atomic publication block. An
# equivalent refactor should update the contract rather than weaken the check.


@dataclass(frozen=True)
class Poll:
    path: str
    line: int
    spelling: str
    token: str

    @property
    def key(self) -> str:
        return f"{self.path}:{self.token}"


@dataclass(frozen=True)
class Contract:
    atomic: str
    mutation: str
    publisher: str | None = None
    # A poll helper whose token is a parameter serves several publishers; each
    # one gets its own pinned block and its own mutation.
    siblings: tuple["Contract", ...] = ()
    # A pinned block must contain a rename unless the row names why not: a writer that
    # cannot rename (an append journal), or a site that never waits for the file (a
    # one-shot assertion after a synchronous call).
    exemption: str = ""


POLL_PATTERNS = (
    ("os.path.exists", re.compile(r"os\.path\.exists\(\s*([A-Za-z_]\w*)\s*\)")),
    ("os.path.isfile", re.compile(r"os\.path\.isfile\(\s*([A-Za-z_]\w*)\s*\)")),
    ("path.exists", re.compile(r"(?<![.\w])([A-Za-z_]\w*)\.exists\(\)")),
    ("path.is_file", re.compile(r"(?<![.\w])([A-Za-z_]\w*)\.is_file\(\)")),
    ("[ -f", re.compile(r"\[\s+-f\s+[\"']?([^\s\"';\]]+)")),
    ("[ ! -f", re.compile(r"\[\s+!\s+-f\s+[\"']?([^\s\"';\]]+)")),
    ("[ -e", re.compile(r"\[\s+-e\s+[\"']?([^\s\"';\]]+)")),
    ("[ ! -e", re.compile(r"\[\s+!\s+-e\s+[\"']?([^\s\"';\]]+)")),
    ("test -f", re.compile(r"(?<![\w-])test\s+-f\s+[\"']?([^\s\"';]+)")),
    # -s proves "some bytes arrived", never "all bytes arrived": a create-then-fill
    # writer passes it with a partial file (tap-my48: a 200 KB payload was torn on
    # 60/60 reads), and it reads like a fix to a reviewer.
    ("[ -s", re.compile(r"\[\s+-s\s+[\"']?([^\s\"';\]]+)")),
    ("[ ! -s", re.compile(r"\[\s+!\s+-s\s+[\"']?([^\s\"';\]]+)")),
    ("test -s", re.compile(r"(?<![\w-])test\s+-s\s+[\"']?([^\s\"';]+)")),
)

# The self-test mutates a REAL atomic-publish site and proves the scanner
# reddens. Each carrier must therefore still exist in the tree: tap-52ys
# deleted switch-client-caller.test.sh and enroll-marker-recheck.test.sh,
# which carried two of the four contracts, so those entries are retired and
# the surviving carriers keep the self-test bidirectional.
#
# A contract naming a deleted file fails LOUD ("stale atomic-publish
# contract"), never silently — that is the intended direction, and it is how
# this retirement was caught rather than shipped as a green no-op self-test.
ASK = "skills/tap/scripts/smoke/ask.test.sh"
SUITE_SLOT = "skills/tap/scripts/smoke/suite-slot.test.sh"
SUITE_SLOT_PUBLISHER = "scripts/suite_slot.py"
GOALIE_RUN_PUBLISHER = "runtime/bun/src/goalie-run.ts"
COURIER_AUTO_SETTLE = "skills/tap/scripts/smoke/courier-auto-settle.test.sh"
OPENCODE_WIRE = "skills/tap/scripts/smoke/opencode-context-wire.test.sh"
PRESETS_VERB = "skills/tap/scripts/smoke/presets-verb.test.sh"
WAVE_SESSION_REAP = "skills/tap/scripts/smoke/wave-session-reap.test.sh"
SMOKE_ALL_PUBLISHER = "scripts/smoke-all.sh"
NUDGE_SUBMIT = "skills/tap/scripts/regress/nudge-submit-verify.test.sh"
# The one carrier that is private by design: the publish manifest denies it, so the public tree
# has no such file. Its path is built from parts because a literal here would be a shipped file
# naming a non-shipped one, which candidate assembly refuses as a closure edge. This set is the
# ONLY place a missing carrier is tolerated, and only while the file is absent from the tree: a
# private carrier that is present must still match a poll, and a shipped carrier that goes
# missing still fails as a stale contract.
BEADS_REBASE_EXPORT = "skills/tap/scripts/smoke/" + "beads-rebase-export" + ".test.sh"
PRIVATE_CARRIERS = frozenset({BEADS_REBASE_EXPORT})
BUN_RUNNER_DISCOVERY = "skills/tap/scripts/smoke/bun-runner-discovery.test.sh"
COMMAND_MODE = "skills/tap/scripts/smoke/command-mode.test.sh"
HEALTH_DIFFERENTIAL = "skills/tap/scripts/smoke/health-differential.test.sh"
DONE_TOMBSTONE = "skills/tap/scripts/smoke/done-tombstone.test.sh"
INSTALL_FIRST_RUN = "skills/tap/scripts/smoke/install-first-run-hardening.test.sh"
PROBE_RUNNER = "skills/tap/scripts/smoke/probe-runner.test.sh"
CONTRACTS = {
    f"{ASK}:pid_path": Contract(
        'printf \'%s\\n\' "$$" > "$FAKE_PID_FILE.partial"\n'
        '  mv -f "$FAKE_PID_FILE.partial" "$FAKE_PID_FILE"',
        ': > "$FAKE_PID_FILE"\n'
        '  sleep 0.3\n'
        '  printf \'%s\\n\' "$$" > "$FAKE_PID_FILE"',
    ),
    f"{SUITE_SLOT}:$LOCK_HOME/smoke-all.lease.json": Contract(
        'tmp = path + ".tmp"\n'
        '    with open(tmp, "w", encoding="utf-8") as f:\n'
        '        json.dump(payload, f, indent=2, sort_keys=True)\n'
        '        f.write("\\n")\n'
        '        f.flush()\n'
        '        os.fsync(f.fileno())\n'
        '    os.replace(tmp, path)',
        'with open(path, "w", encoding="utf-8") as f:\n'
        '        import time; time.sleep(0.3)\n'
        '        json.dump(payload, f, indent=2, sort_keys=True)',
        SUITE_SLOT_PUBLISHER,
    ),
    # Both -s polls are safe because the probe publishes by rename, not because
    # the payload is short; the pid and exit-status writers sit in the fixture itself.
    f"{COURIER_AUTO_SETTLE}:$A24_STATE/pid": Contract(
        'writeFileSync(state+"/pid.tmp",child.pid+"\\n"); renameSync(state+"/pid.tmp",state+"/pid");',
        'writeFileSync(state+"/pid",child.pid+"\\n");',
    ),
    f"{COURIER_AUTO_SETTLE}:$A24_STATE/status": Contract(
        'writeFileSync(state+"/status.tmp",rc+"\\n"); renameSync(state+"/status.tmp",state+"/status");',
        'writeFileSync(state+"/status",rc+"\\n");',
    ),
    # Bounded for-loop polls (tap-p8u7w).
    f"{OPENCODE_WIRE}:$WORK/port": Contract(
        'await Bun.write(`${process.env.CAPTURE_PORT_FILE!}.tmp`, String(server.port));\n'
        'renameSync(`${process.env.CAPTURE_PORT_FILE!}.tmp`, process.env.CAPTURE_PORT_FILE!);',
        'await Bun.write(`${process.env.CAPTURE_PORT_FILE!}`, String(server.port));',
    ),
    # The fake harness writes argv first, env second; each is published by rename.
    f"{PRESETS_VERB}:$POS/crew-argv.txt": Contract(
        'printf \'%s\\n\' "$*" > "${TAP_SMOKE_ARGV:?}.tmp"\n'
        'mv -f "${TAP_SMOKE_ARGV:?}.tmp" "${TAP_SMOKE_ARGV:?}"',
        'printf \'%s\\n\' "$*" > "${TAP_SMOKE_ARGV:?}"',
    ),
    f"{PRESETS_VERB}:$POS/crew-env.txt": Contract(
        'printf \'%s\\n\' "${PRESET_SMOKE_FLAG:-<UNSET>}" > "${TAP_SMOKE_ENV:?}.tmp"\n'
        'mv -f "${TAP_SMOKE_ENV:?}.tmp" "${TAP_SMOKE_ENV:?}"',
        'printf \'%s\\n\' "${PRESET_SMOKE_FLAG:-<UNSET>}" > "${TAP_SMOKE_ENV:?}"',
    ),
    # wait_file polls whatever path its caller passes, so the token is the parameter
    # `$1` and the poll cannot name its writer. Every target it waits on has its own
    # publisher pinned here, each with its own mutation: a new wait_file caller needs
    # a new sibling.
    f"{WAVE_SESSION_REAP}:$1": Contract(
        'pathlib.Path(os.environ["REAP_SLEEPER_PID_FILE"] + ".tmp").write_text("%s\\n" % os.getpid(), encoding="utf-8"); '
        'os.replace(os.environ["REAP_SLEEPER_PID_FILE"] + ".tmp", os.environ["REAP_SLEEPER_PID_FILE"])',
        'open(os.environ["REAP_SLEEPER_PID_FILE"], "w", encoding="utf-8").write("1"); time.sleep(0.3)',
        siblings=(
            Contract(
                'pathlib.Path(seen + ".tmp").write_text("exists\\n" if (sandbox and os.path.exists(sandbox)) else "missing\\n", encoding="utf-8"); '
                'os.replace(seen + ".tmp", seen)',
                'open(seen, "w", encoding="utf-8").write("ex"); time.sleep(0.3); open(seen, "a", encoding="utf-8").write("ists\\n")',
            ),
            Contract(
                'pathlib.Path(fork_on_term + ".tmp").write_text("%s\\n" % os.getpid(), encoding="utf-8"); '
                'os.replace(fork_on_term + ".tmp", fork_on_term)',
                'open(fork_on_term, "w", encoding="utf-8").write("1"); time.sleep(0.3)',
            ),
            Contract(
                'pathlib.Path(sys.argv[2] + ".tmp").write_text("%s\\n" % pid, encoding="utf-8"); '
                'os.replace(sys.argv[2] + ".tmp", sys.argv[2])',
                'open(sys.argv[2], "w", encoding="utf-8").write("1"); time.sleep(0.3)',
            ),
            Contract(
                'pathlib.Path(sys.argv[1] + ".tmp").write_text("%s\\n" % os.getpid(), encoding="utf-8"); '
                'os.replace(sys.argv[1] + ".tmp", sys.argv[1])',
                'open(sys.argv[1], "w", encoding="utf-8").write("1"); time.sleep(0.3)',
            ),
            Contract(
                'echo "$rc" >"$PROBE/leader.rc.tmp" && mv -f "$PROBE/leader.rc.tmp" "$PROBE/leader.rc"',
                ': >"$PROBE/leader.rc"; sleep 0.3; echo "$rc" >>"$PROBE/leader.rc"',
            ),
            # The one writer that cannot rename: the wave pid list is an append journal
            # shared by several appenders and also read by the reaper, so replacing the
            # file would drop other writers' records. Exempt by name, not by a short write
            # being presumed atomic.
            Contract(
                'open(os.environ["SMOKE_WAVE_PIDS"], "a", encoding="utf-8").write("%s\\n" % pid)',
                'open(os.environ["SMOKE_WAVE_PIDS"], "a", encoding="utf-8").write("%s" % pid); time.sleep(0.3)',
                SMOKE_ALL_PUBLISHER,
                exemption=(
                    "append journal with several appenders; each record is one newline-terminated "
                    "O_APPEND write and the reader takes only the first line"
                ),
            ),
        ),
    ),
    # One-shot assertions: each loop runs a synchronous command per case and then asserts
    # a file is absent or empty. Nothing waits for the file and no publisher races the
    # check; the row pins the loop so a different loop with the same token is not covered.
    f"{NUDGE_SUBMIT}:$FAKE_TMUX_STATE/input": Contract(
        "for suffix in '' ' human draft' truncated; do",
        "for suffix in x; do",
        exemption="the loop writes the fake input file itself, runs the synchronous nudge, then asserts it was consumed",
        siblings=(
            Contract(
                "for footer in 'ctrl+p commands' '■■■■ esc interrupt'; do",
                "for footer in x; do",
                exemption="the loop writes the fake input file itself, runs the synchronous nudge, then asserts it was consumed",
            ),
        ),
    ),
    f"{BEADS_REBASE_EXPORT}:$PRIMARY/calls": Contract(
        'for caller in "$PRIMARY" "$SIBLING"; do',
        "for caller in x; do",
        exemption="asserts the export stub never ran during a rebase marker; the hook call is synchronous and the file is absent by design",
        siblings=(
            Contract(
                'for marker in rebase-merge rebase-apply; do\n  mkdir "$sibling_git/$marker"',
                'for marker in x; do\n  mkdir "$sibling_git/$marker"',
                exemption="asserts the export stub never ran during a rebase marker; the hook call is synchronous and the file is absent by design",
            ),
        ),
    ),
    f"{BUN_RUNNER_DISCOVERY}:$BUN_RUNNER_DISCOVERY_LOG": Contract(
        "for option in --timeout=20000 --only --help; do",
        "for option in x; do",
        exemption="truncates the log, runs the runner synchronously, then asserts it stayed empty (refused before discovery)",
    ),
    f"{COMMAND_MODE}:$FAKE_TMUX_STATE/send-log": Contract(
        'for narrowing in "focus only on the gate" "ignore the rest of the lane" "discard the failing arm"; do',
        "for narrowing in x; do",
        exemption="asserts a synchronous refusal never touched the fake pane (empty send log)",
    ),
    # A path built from the loop variable through an intermediate assignment is ambiguous
    # to the scanner, so it is classified here: the walk hashes a quiescent snapshot.
    f"{HEALTH_DIFFERENTIAL}:path": Contract(
        "for name in filenames:",
        "for name in x:",
        exemption="os.walk iteration; `path` is built from the loop variable and read in the same iteration of a quiescent tree",
    ),
    # Collection walks nested in an outer collection loop: the checked path is the inner
    # loop's own variable, but the outer loop does not bind it, so the scanner keeps the
    # site. Each pins its inner loop.
    f"{DONE_TOMBSTONE}:p": Contract(
        "for p in sorted(root.rglob('*')):",
        "for p in sorted(x):",
        exemption="snapshot walk: `p` is the inner loop's own variable and the outer loop only selects roots; nothing waits for a file",
    ),
    f"{PROBE_RUNNER}:path": Contract(
        'rows[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "dir"',
        'rows[str(path)] = "x"',
        exemption="snapshot walk: `path` comes from rglob over existing roots and is_file() only picks file or directory; nothing waits for a file",
    ),
    f"{INSTALL_FIRST_RUN}:entry": Contract(
        "for entry in directory.iterdir():",
        "for entry in x:",
        exemption="directory walk: `entry` is the inner loop's own variable and the outer loop only selects directories; nothing waits for a file",
    ),
}


def code_skeleton(line: str) -> str:
    """Keep executable text while blanking quoted strings and comments."""
    chars = [" "] * len(line)
    quote: str | None = None
    escaped = False
    for index, char in enumerate(line):
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\" and quote == '"':
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "#":
            break
        else:
            chars[index] = char
    return "".join(chars)


LOOP_KEYWORD = re.compile(r"(?:^\s*|[;{}]\s*)(while|until|for)\b")
RENAME = re.compile(r"renameSync|os\.replace|\bmv\b|\brename\(")
SHELL_FOR_VARIABLE = re.compile(r"for\s+(\w+)")
PYTHON_FOR_TARGET = re.compile(r"for\s+(.+?)\s+in\b")


def loop_keyword(line: str) -> str | None:
    match = LOOP_KEYWORD.search(code_skeleton(line))
    return match.group(1) if match else None


def loop_variables(line: str) -> set[str]:
    """Names a `for` header binds: `for x in ..`, `for x; do`, `for i, x in ..:`."""
    skeleton = code_skeleton(line)
    keyword = LOOP_KEYWORD.search(skeleton)
    assert keyword is not None
    text = skeleton[keyword.start(1):]
    if text.rstrip().endswith(":"):
        match = PYTHON_FOR_TARGET.match(text)
        return set(re.findall(r"\w+", match.group(1))) if match else set()
    match = SHELL_FOR_VARIABLE.match(text)
    return {match.group(1)} if match else set()


def depends_on(token: str, variables: set[str]) -> bool:
    if token.isidentifier():
        return token in variables
    return any(re.search(rf"\$\{{?{re.escape(name)}\b", token) for name in variables)


def enclosing_loops(lines: list[str], index: int, window: int = 8) -> list[int]:
    """Start lines of the loops the line at `index` sits in, innermost first."""
    starts = [index] if loop_keyword(lines[index]) is not None else []
    current_indent = len(lines[index]) - len(lines[index].lstrip())
    for start in range(index - 1, max(-1, index - window - 1), -1):
        if loop_keyword(lines[start]) is None:
            continue
        loop_indent = len(lines[start]) - len(lines[start].lstrip())
        if current_indent <= loop_indent:
            continue
        if all(
            not code_skeleton(line).strip()
            or len(line) - len(line.lstrip()) > loop_indent
            for line in lines[start + 1:index + 1]
        ):
            starts.append(start)
    return starts


def in_loop_context(lines: list[str], index: int, token: str) -> bool:
    """while/until repeat a check. Each enclosing `for` is judged against its OWN variables:
    it polls when the path it checks does not depend on them (the loop repeats one check),
    and checking a loop's own variable walks a collection. One repeating loop is enough, so
    an outer file iterator cannot veto an inner retry of the same path. A path derived
    through an intermediate assignment is ambiguous and stays in: a false red gets
    classified, a false green hides."""
    return any(
        loop_keyword(lines[start]) != "for" or not depends_on(token, loop_variables(lines[start]))
        for start in enclosing_loops(lines, index)
    )


def reads_token(token: str, source: str) -> bool:
    token_pattern = re.escape(token)
    if token.isidentifier():
        return bool(
            re.search(
                rf"(?:open\(\s*{token_pattern}\s*[,)]|"
                rf"{token_pattern}\.read_(?:text|bytes)\s*\()",
                source,
            )
        )
    return bool(
        re.search(
            rf"(?:\bcat\s+(?:--\s+)?[\"']?{token_pattern}(?:[\"']|\s|\)|$)|"
            rf"<\s*[\"']?{token_pattern}(?:[\"']|\s|$))",
            source,
            re.MULTILINE,
        )
    )


def discover_polls(root: Path) -> tuple[list[Poll], dict[str, str]]:
    polls: list[Poll] = []
    sources: dict[str, str] = {}
    # tap-52ys / sol-ponytail P2: scan BOTH suite buckets. A poll-then-read that
    # tears a file is the same defect wherever the fixture lives, and AGENTS.md
    # requires repo-wide sweepers to walk both directories — globbing only
    # smoke/ meant moving a fixture to regress/ silently exempted it from this
    # check (8 discovered polls vs 15 across both).
    suite_files = sorted(root.glob("skills/*/scripts/smoke/*.test.sh")) + sorted(
        root.glob("skills/*/scripts/regress/*.test.sh")
    )
    for smoke in suite_files:
        relative = smoke.relative_to(root).as_posix()
        text = smoke.read_text(encoding="utf-8", errors="replace")
        sources[relative] = text
        lines = text.splitlines()
        for index, line in enumerate(lines):
            skeleton = code_skeleton(line)
            for spelling, pattern in POLL_PATTERNS:
                for match in pattern.finditer(line):
                    if skeleton[match.start()] == " ":
                        continue
                    token = match.group(1)
                    if not in_loop_context(lines, index, token):
                        continue
                    polls.append(Poll(relative, index + 1, spelling, token))
    return polls, sources


def reads_content(poll: Poll, source: str) -> bool:
    code = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
    return reads_token(poll.token, code)


def absent_private_carrier(root: Path, key: str, private_carriers: frozenset[str]) -> bool:
    carrier = key.rsplit(":", 1)[0]
    return carrier in private_carriers and not (root / carrier).exists()


def scan(
    root: Path,
    contracts: dict[str, Contract] = CONTRACTS,
    private_carriers: frozenset[str] = PRIVATE_CARRIERS,
) -> tuple[list[str], list[Poll]]:
    polls, sources = discover_polls(root)
    violations: list[str] = []
    # EVERY site, not one per file:token. A dict keyed on the token kept only the last
    # twin, so an earlier violating site was invisible until a later one was fixed
    # (tap-0erc: one site hid behind another).
    content_polls = [poll for poll in polls if reads_content(poll, sources[poll.path])]

    for poll in sorted(content_polls, key=lambda p: (p.path, p.line, p.spelling)):
        contract = contracts.get(poll.key)
        if contract is None:
            violations.append(
                f"{poll.path}:{poll.line}: unclassified poll-then-read via {poll.spelling} ({poll.token})"
            )
            continue
        for part in (contract, *contract.siblings):
            publisher = part.publisher or poll.path
            publisher_source = sources.get(publisher)
            if publisher_source is None:
                publisher_source = (root / publisher).read_text(encoding="utf-8", errors="replace")
            if part.atomic not in publisher_source:
                violations.append(
                    f"{poll.path}:{poll.line}: readiness content for {poll.token} is not published by rename; "
                    "the ordered temp-write/rename block is missing"
                )

    for key in sorted(set(contracts) - {poll.key for poll in content_polls}):
        if absent_private_carrier(root, key, private_carriers):
            continue
        violations.append(f"stale atomic-publish contract: {key}")
    return violations, polls


def fixture_root(parent: Path, text: str, bucket: str = "smoke") -> Path:
    root = parent / "fixture"
    suite = root / "skills" / "tap" / "scripts" / bucket
    suite.mkdir(parents=True)
    (suite / "fixture.test.sh").write_text(text, encoding="utf-8")
    return root


def self_test(root: Path) -> None:
    cases = {
        "os.path.exists": "while not os.path.exists(ready): pass\nvalue = open(ready).read()\n",
        "os.path.isfile": "while not os.path.isfile(ready): pass\nvalue = open(ready).read()\n",
        "path.exists": "while not ready.exists(): pass\nvalue = ready.read_text()\n",
        "path.is_file": "while not ready.is_file(): pass\nvalue = ready.read_text()\n",
        "[ -f": 'while [ -f "$ready" ]; do :; done\nvalue="$(cat "$ready")"\n',
        "[ ! -f": 'while [ ! -f "$ready" ]; do :; done\nvalue="$(cat "$ready")"\n',
        "[ -e": 'while [ -e "$ready" ]; do :; done\nvalue="$(cat "$ready")"\n',
        "[ ! -e": 'while [ ! -e "$ready" ]; do :; done\nvalue="$(cat "$ready")"\n',
        "test -f": 'while test -f "$ready"; do :; done\nvalue="$(cat "$ready")"\n',
        "[ -s": 'while [ -s "$ready" ]; do :; done\nvalue="$(cat "$ready")"\n',
        "[ ! -s": 'while [ ! -s "$ready" ]; do :; done\nvalue="$(cat "$ready")"\n',
        "test -s": 'while test -s "$ready"; do :; done\nvalue="$(cat "$ready")"\n',
    }
    for spelling, text in cases.items():
        with tempfile.TemporaryDirectory() as tmp:
            candidate = fixture_root(Path(tmp), text)
            violations, polls = scan(candidate, {})
            assert [poll.spelling for poll in polls] == [spelling], (spelling, polls)
            assert any("unclassified poll-then-read" in violation for violation in violations), (
                spelling,
                violations,
            )

    # tap-52ys / sol-ponytail P2: the same violation must be FOUND in regress/,
    # not just in smoke/. Without this arm the two-bucket glob above is an
    # unverified claim — the scanner would look like it walks both buckets while
    # only ever being proven against one.
    regress_case = 'while [ ! -f "$ready" ]; do :; done\nvalue="$(cat "$ready")"\n'
    with tempfile.TemporaryDirectory() as tmp:
        candidate = fixture_root(Path(tmp), regress_case, bucket="regress")
        violations, polls = scan(candidate, {})
        assert [poll.spelling for poll in polls] == ["[ ! -f"], polls
        assert any("skills/tap/scripts/regress/" in v for v in violations), violations
        assert any("unclassified poll-then-read" in v for v in violations), violations

    # tap-my48: the retained torn-read shape. `-s` only proves some bytes arrived, so a
    # create-then-fill writer (a ~200 KB payload, 60/60 reads torn) passes it with a
    # partial file. The scanner must redden on it, and stay quiet on the same poll once
    # the writer publishes by rename -- bidirectional, so the -s rows cannot be a
    # blanket refusal nor a blanket pass.
    torn_reader = 'while [ ! -s "$ready" ]; do sleep 0.01; done\nvalue="$(cat "$ready")"\n'
    torn_writer = 'printf \'%s\' "$payload_200kb" > "$ready"\n'
    atomic_writer = 'printf \'%s\' "$payload_200kb" > "$ready.tmp"\nmv -f "$ready.tmp" "$ready"\n'
    with tempfile.TemporaryDirectory() as tmp:
        violations, polls = scan(fixture_root(Path(tmp), torn_reader + torn_writer), {})
        assert [poll.spelling for poll in polls] == ["[ ! -s"], polls
        assert any("unclassified poll-then-read via [ ! -s" in v for v in violations), violations
    fixture_key = "skills/tap/scripts/smoke/fixture.test.sh:$ready"
    with tempfile.TemporaryDirectory() as tmp:
        violations, _ = scan(fixture_root(Path(tmp), torn_reader + atomic_writer), {fixture_key: Contract(atomic_writer.rstrip("\n"), torn_writer)})
        assert not violations, violations
    with tempfile.TemporaryDirectory() as tmp:
        violations, _ = scan(fixture_root(Path(tmp), torn_reader + torn_writer), {fixture_key: Contract(atomic_writer.rstrip("\n"), torn_writer)})
        assert any("is not published by rename" in v for v in violations), violations

    # tap-0erc: twin sites of one file:token are each reported. A dict keyed on the token
    # kept only the last, so the earlier violating site stayed invisible until a later one
    # was fixed. Lines 1 and 3 are two separate polls of the same token; both must appear,
    # with no contract and with a contract whose publish block is missing.
    twins = 'while [ ! -f "$ready" ]; do :; done\nvalue="$(cat "$ready")"\nwhile [ ! -s "$ready" ]; do :; done\n'
    with tempfile.TemporaryDirectory() as tmp:
        violations, polls = scan(fixture_root(Path(tmp), twins), {})
        assert [poll.line for poll in polls] == [1, 3], polls
        assert [v.split(": ")[0].rsplit(":", 1)[1] for v in violations] == ["1", "3"], violations
    with tempfile.TemporaryDirectory() as tmp:
        violations, _ = scan(fixture_root(Path(tmp), twins), {fixture_key: Contract("never published", "x")})
        assert [v.split(": ")[0].rsplit(":", 1)[1] for v in violations] == ["1", "3"], violations
    with tempfile.TemporaryDirectory() as tmp:
        violations, _ = scan(fixture_root(Path(tmp), twins + atomic_writer), {fixture_key: Contract(atomic_writer.rstrip("\n"), torn_writer)})
        assert not violations, violations

    structural_cases = {
        "multiline Python loop": (
            "while time.monotonic() < deadline:\n"
            "    if ready.is_file():\n"
            "        break\n"
            "value = ready.read_text()\n"
        ),
        "multiline shell loop": (
            "while [ \"$SECONDS\" -lt \"$deadline\" ]; do\n"
            "  [ -f \"$ready\" ] && break\n"
            "done\n"
            "value=\"$(cat \"$ready\")\"\n"
        ),
    }
    for label, text in structural_cases.items():
        with tempfile.TemporaryDirectory() as tmp:
            violations, polls = scan(fixture_root(Path(tmp), text), {})
            assert len(polls) == 1, (label, polls)
            assert any("unclassified poll-then-read" in violation for violation in violations), (
                label,
                violations,
            )

    # tap-p8u7w: a `for` is a poll when the path its readiness check tests does not depend
    # on the loop variable, however the header is spelled. Dropping `for` from LOOP_KEYWORD
    # must redden every poll arm; treating every `for` as a collection must redden them too.
    for_cases = {
        "single-line shell for": (
            'for _ in $(seq 1 50); do [ -s "$ready" ] && break; sleep 0.1; done\n'
            'value="$(cat "$ready")"\n',
            "[ -s",
        ),
        "multiline shell for": (
            'for _ in $(seq 1 50); do\n'
            '  [ -f "$ready" ] && break\n'
            '  sleep 0.1\n'
            'done\n'
            'value="$(cat "$ready")"\n',
            "[ -f",
        ),
        "no-sleep shell seq for": (
            'for _ in $(seq 1 50); do [ -s "$ready" ] && break; done\n'
            'value="$(cat "$ready")"\n',
            "[ -s",
        ),
        "two-attempt shell for": (
            'for _ in 1 2; do [ -s "$ready" ] || continue; done\n'
            'value="$(cat "$ready")"\n',
            "[ -s",
        ),
        "quoted-list shell for": (
            'for _ in "1" "2" "3"; do [ -s "$ready" ]; done\n'
            'value="$(cat "$ready")"\n',
            "[ -s",
        ),
        "unrecognized-header shell for": (
            'for _ in $(jot 5); do [ -s "$ready" ] || continue; done\n'
            'value="$(cat "$ready")"\n',
            "[ -s",
        ),
        "multiline Python for": (
            "for _ in range(50):\n"
            "    if ready.is_file():\n"
            "        break\n"
            "    time.sleep(0.1)\n"
            "value = ready.read_text()\n",
            "path.is_file",
        ),
        "two-attempt Python tuple for": (
            "for _ in (1, 2):\n"
            "    if not ready.is_file():\n"
            "        continue\n"
            "value = ready.read_text()\n",
            "path.is_file",
        ),
        "unrecognized-header Python for": (
            "for _ in itertools.count():\n"
            "    if not ready.is_file():\n"
            "        continue\n"
            "value = ready.read_text()\n",
            "path.is_file",
        ),
        "retry nested in file iteration, Python": (
            "for ready in paths:\n"
            "    for _ in range(50):\n"
            "        if ready.is_file():\n"
            "            break\n"
            "    value = ready.read_text()\n",
            "path.is_file",
        ),
        "retry nested in file iteration, shell": (
            'for ready in a b; do\n'
            '  for _ in 1 2; do\n'
            '    [ -s "$ready" ] && break\n'
            '  done\n'
            '  value="$(cat "$ready")"\n'
            'done\n',
            "[ -s",
        ),
        "ambiguous shell assignment for": (
            'for name in a b; do\n'
            '  ready="$name.ready"\n'
            '  [ -s "$ready" ] || continue\n'
            'done\n'
            'value="$(cat "$ready")"\n',
            "[ -s",
        ),
        "ambiguous Python assignment for": (
            "for name in names:\n"
            "    ready = root / name\n"
            "    if not ready.is_file():\n"
            "        continue\n"
            "value = ready.read_text()\n",
            "path.is_file",
        ),
    }
    for label, (text, spelling) in for_cases.items():
        with tempfile.TemporaryDirectory() as tmp:
            violations, polls = scan(fixture_root(Path(tmp), text), {})
            assert [poll.spelling for poll in polls] == [spelling], (label, polls)
            assert any("unclassified poll-then-read" in v for v in violations), (label, violations)
    # Collection iteration: the check tests the loop variable itself, so nothing is waited for.
    iteration_cases = {
        "shell glob": 'for ready in "$dir"/*; do [ -f "$ready" ] || continue; done\nvalue="$(cat "$ready")"\n',
        "shell word list": 'for ready in --only --help; do [ ! -s "$ready" ] || exit 1; done\nvalue="$(cat "$ready")"\n',
        "shell braced variable": 'for ready in a b; do [ -f "${ready}.x" ] || continue; done\nvalue="$(cat "${ready}.x")"\n',
        "shell positional parameters": 'for ready; do [ -f "$ready" ] || continue; done\nvalue="$(cat "$ready")"\n',
        "Python producer": (
            "for path in sorted(root.rglob('*')):\n"
            "    if path.is_file():\n"
            "        value = path.read_text()\n"
        ),
        "Python tuple unpack": (
            "for index, path in enumerate(paths):\n"
            "    if path.is_file():\n"
            "        value = path.read_text()\n"
        ),
        "nested loops whose inner variable builds the path": (
            'for d in a b; do\n'
            '  for name in x y; do\n'
            '    [ -f "$d/$name" ] || continue\n'
            '  done\n'
            'done\n'
            'value="$(cat "$d/$name")"\n'
        ),
        "Python nested loop that breaks": (
            "for path in paths:\n"
            "    if not path.is_file():\n"
            "        continue\n"
            "    for line in path.read_text().splitlines():\n"
            "        break\n"
            "    value = path.read_text()\n"
        ),
    }
    for label, text in iteration_cases.items():
        with tempfile.TemporaryDirectory() as tmp:
            violations, polls = scan(fixture_root(Path(tmp), text), {})
            assert not polls and not violations, (label, polls, violations)

    quoted_prose = (
        '[ -f "$ready" ] || { echo "missing while obligations remain"; exit 1; }\n'
        'value="$(cat "$ready")"\n'
    )
    with tempfile.TemporaryDirectory() as tmp:
        violations, polls = scan(fixture_root(Path(tmp), quoted_prose), {})
        assert not polls, polls
        assert not violations, violations

    benign = "\n".join(
        line.splitlines()[0] for line in cases.values()
    ) + '\n: > "$ready"\nready.touch()\n'
    with tempfile.TemporaryDirectory() as tmp:
        violations, _ = scan(fixture_root(Path(tmp), benign), {})
        assert not violations, violations

    # The private-carrier exception, both directions: an absent private carrier is tolerated,
    # an absent shipped carrier and a present-but-unmatched private carrier still fail loud.
    gone = "skills/tap/scripts/smoke/gone.test.sh"
    gone_contracts = {f"{gone}:$x": Contract("mv -f a b", "echo b > b")}
    with tempfile.TemporaryDirectory() as tmp:
        fixture = fixture_root(Path(tmp), "true\n")
        violations, _ = scan(fixture, gone_contracts, frozenset({gone}))
        assert not violations, violations
        violations, _ = scan(fixture, gone_contracts, frozenset())
        assert any("stale atomic-publish contract" in v for v in violations), violations
        (fixture / gone).write_text("true\n", encoding="utf-8")
        violations, _ = scan(fixture, gone_contracts, frozenset({gone}))
        assert any("stale atomic-publish contract" in v for v in violations), violations

    for key, contract in CONTRACTS.items():
        if absent_private_carrier(root, key, PRIVATE_CARRIERS):
            continue
        for part in (contract, *contract.siblings):
            with tempfile.TemporaryDirectory() as tmp:
                candidate = Path(tmp)
                for relative in {
                    ASK, SUITE_SLOT, SUITE_SLOT_PUBLISHER, GOALIE_RUN_PUBLISHER, COURIER_AUTO_SETTLE,
                    OPENCODE_WIRE, PRESETS_VERB, WAVE_SESSION_REAP, SMOKE_ALL_PUBLISHER,
                    NUDGE_SUBMIT, BEADS_REBASE_EXPORT, BUN_RUNNER_DISCOVERY, COMMAND_MODE, HEALTH_DIFFERENTIAL,
                    DONE_TOMBSTONE, INSTALL_FIRST_RUN, PROBE_RUNNER,
                }:
                    if relative in PRIVATE_CARRIERS and not (root / relative).exists():
                        continue
                    destination = candidate / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(root / relative, destination)
                path = candidate / (part.publisher or key.rsplit(":", 1)[0])
                source = path.read_text(encoding="utf-8")
                if not part.exemption:
                    assert RENAME.search(part.atomic), (key, "pinned block publishes without a rename", part.atomic)
                assert part.atomic in source, (key, part.atomic)
                assert part.mutation not in source, (key, part.mutation)
                path.write_text(source.replace(part.atomic, part.mutation, 1), encoding="utf-8")
                violations, _ = scan(candidate)
                assert any(key.split(":", 1)[1] in violation for violation in violations), (
                    key,
                    part.atomic,
                    violations,
                )

    print(
        "poll-read-atomicity: self-test covers twelve spellings, for-loop polls, the -s torn-read shape, twin sites, "
        "multiline checks, quoted prose, the contract mutations, and empty markers"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.self_test:
        self_test(root)
        return 0

    violations, polls = scan(root)
    if violations:
        for violation in violations:
            print(f"poll-read-atomicity: {violation}")
        return 1
    content_count = len({poll.key for poll in polls if reads_content(poll, (root / poll.path).read_text())})
    print(
        f"poll-read-atomicity: {len(polls)} readiness check(s), "
        f"{content_count} atomic content contract(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
