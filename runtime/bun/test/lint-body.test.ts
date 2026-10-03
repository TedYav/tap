// U1 — dark C9 tokenizer. Each test names the mutant that would keep it green
// if the check were deleted: a pass that only inspects token count is not a pin.
// Python parity is retained as frozen goldens captured once from
// hooks/tap-shell-body-guard.py (goldens/lint-body-python-parity.json): the
// S1 port keeps the same assertions without spawning python3 per fixture.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  commandSubstitutionAt,
  commandWords,
  isSpace,
  PYTHON_ISSPACE,
  resolveCommand,
  shellEscaped,
  shellSegments,
  shellTokens,
} from "../src/lint-body";
import {
  HOOK_BD_BODY_FLAGS,
  HOOK_TAP_BODY_FLAGS,
  toolAndFlags,
  unquotedHeredocIsUnsafe,
  withoutHeredocBodies,
} from "../src/shell-body-guard";

type Parity = {
  shell_tokens: Record<string, Array<[string, boolean, string]>>;
  shell_segments: Record<string, string[]>;
  without_heredoc_bodies_quoted_only: Record<string, string>;
  unquoted_heredoc_is_unsafe: Record<string, boolean>;
  tool_and_flags: Record<string, [number | null, string[] | null]>;
};
const parity = JSON.parse(
  readFileSync(resolve(import.meta.dir, "goldens/lint-body-python-parity.json"), "utf8"),
) as Parity;

function pyTokens(segment: string): Array<[string, boolean, string]> {
  return pyTokensMany([segment])[0]!;
}

function pyTokensMany(segments: string[]): Array<Array<[string, boolean, string]>> {
  return segments.map((segment) => {
    const frozen = parity.shell_tokens[segment];
    if (!frozen) throw new Error(`no frozen python shell_tokens for ${JSON.stringify(segment)}`);
    return frozen;
  });
}

function pyCallQuotedStrip(command: string): string {
  const frozen = parity.without_heredoc_bodies_quoted_only[command];
  if (frozen === undefined) throw new Error(`no frozen python strip for ${JSON.stringify(command)}`);
  return frozen;
}

function pyUnquotedHeredoc(command: string): boolean {
  const frozen = parity.unquoted_heredoc_is_unsafe[command];
  if (frozen === undefined) throw new Error(`no frozen python verdict for ${JSON.stringify(command)}`);
  return frozen;
}

describe("commandSubstitutionAt (mutant: treat $(( as $( )", () => {
  test("$( is substitution and $(( is not, including a later $( inside arithmetic)", () => {
    expect(commandSubstitutionAt("$(date)", 0)).toBe(true);
    expect(commandSubstitutionAt("$((n+1))", 0)).toBe(false);
    expect(commandSubstitutionAt("$((n+1))", 1)).toBe(false);
    expect(commandSubstitutionAt("x$(date)", 1)).toBe(true);
    // Deleting the $(( exclusion turns arithmetic-in-body into a false deny.
    expect(commandSubstitutionAt("retry $((n+1))", 6)).toBe(false);
  });
});

describe("shellEscaped (mutant: odd/even backslash run)", () => {
  test("a single backslash escapes; two do not; zero does not", () => {
    expect(shellEscaped("`x", 0)).toBe(false);
    expect(shellEscaped("\\`x", 1)).toBe(true);
    expect(shellEscaped("\\\\`x", 2)).toBe(false);
    expect(shellEscaped("\\\\\\`x", 3)).toBe(true);
  });
});

describe("shellTokens quote and unsafe (U1 causal mutants)", () => {
  test("double-quoted backtick is unsafe; single-quoted backtick is not", () => {
    const dbl = shellTokens(`tap send peer -m "report \`date\`"`);
    const body = dbl.at(-1);
    expect(body?.value).toBe("report `date`");
    expect(body?.raw).toBe(`"report \`date\`"`);
    expect(body?.unsafe).toBe(true);
    const sgl = shellTokens("tap send peer -m 'literal `date`'");
    const quoted = sgl.at(-1);
    expect(quoted?.value).toBe("literal `date`");
    expect(quoted?.raw).toBe("'literal `date`'");
    expect(quoted?.unsafe).toBe(false);
  });

  test("$( in double quotes is unsafe; $(( is not", () => {
    const sub = shellTokens(`tap send peer -m "report $(date)"`);
    expect(sub.at(-1)?.unsafe).toBe(true);
    expect(sub.at(-1)?.value).toBe("report $(date)");
    const arith = shellTokens(`tap send peer -m "retry $((n+1))"`);
    expect(arith.at(-1)?.unsafe).toBe(false);
    expect(arith.at(-1)?.value).toBe("retry $((n+1))");
  });

  test("backslash-consumed $ never occupies a scan index, so \\$( is not unsafe", () => {
    const toks = shellTokens("echo \\$(date)");
    expect(toks).toEqual([
      { value: "echo", unsafe: false, raw: "echo" },
      { value: "$(date)", unsafe: false, raw: "\\$(date)" },
    ]);
  });

  test("quotes strip from value and stay in raw; adjacent quotes concatenate", () => {
    expect(shellTokens(`"$PY"`)).toEqual([{ value: "$PY", unsafe: false, raw: `"$PY"` }]);
    expect(shellTokens("''")).toEqual([{ value: "", unsafe: false, raw: "''" }]);
    expect(shellTokens(`""`)).toEqual([{ value: "", unsafe: false, raw: `""` }]);
    expect(shellTokens(`"foo"bar`)).toEqual([{ value: "foobar", unsafe: false, raw: `"foo"bar` }]);
  });

  test("quoted heredoc opener strips quotes from value so later units see <<DATA not <<'DATA'", () => {
    const toks = shellTokens("echo python3 - <<'DATA'");
    expect(toks.map((t) => t.value)).toEqual(["echo", "python3", "-", "<<DATA"]);
    expect(toks.at(-1)?.raw).toBe("<<'DATA'");
  });

  test("# starts a comment only at an unquoted token boundary", () => {
    expect(shellTokens("tap send # comment").map((t) => t.value)).toEqual(["tap", "send"]);
    expect(shellTokens("foo#bar")).toEqual([{ value: "foo#bar", unsafe: false, raw: "foo#bar" }]);
  });

  test("whitespace splits; leading and trailing IFS is not a token", () => {
    expect(shellTokens("  tap   send  ").map((t) => t.value)).toEqual(["tap", "send"]);
    expect(shellTokens("")).toEqual([]);
  });
});

// Closed Python str.isspace set. M1 (add U+00A0 to ASCII-only) and M2 (drop \v)
// stayed green on U1 at c2663fbb because no fixture used those separators.
const PYTHON_ISSPACE_CHARS = [
  "\u0009", "\u000a", "\u000b", "\u000c", "\u000d",
  "\u001c", "\u001d", "\u001e", "\u001f",
  "\u0020", "\u0085", "\u00a0", "\u1680",
  "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006",
  "\u2007", "\u2008", "\u2009", "\u200a",
  "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
];

describe("isSpace matches Python str.isspace (U1 HOLD / Unicode separators)", () => {
  test("the closed 29-codepoint set splits; A and NUL do not (mutant: ASCII-only isSpace)", () => {
    expect(PYTHON_ISSPACE_CHARS).toHaveLength(29);
    for (const sep of PYTHON_ISSPACE_CHARS) {
      expect(isSpace(sep)).toBe(true);
      expect(shellTokens(`tap${sep}send`).map((t) => t.value)).toEqual(["tap", "send"]);
    }
    expect(isSpace("A")).toBe(false);
    expect(isSpace("\u0000")).toBe(false);
    expect(shellTokens("tapAsend").map((t) => t.value)).toEqual(["tapAsend"]);
  });

  test("U+00A0 must split or tap/send merge and bypass tool equality (Opus M1)", () => {
    const nbsp = "\u00a0";
    expect(isSpace(nbsp)).toBe(true);
    expect(shellTokens(`tap${nbsp}send`).map((t) => t.value)).toEqual(["tap", "send"]);
    const mergedWouldBypass = toolAndFlags(shellTokens(`tap${nbsp}send peer -m "$(date)"`));
    expect(mergedWouldBypass).not.toBeNull();
    expect(mergedWouldBypass?.tokenIndex).toBe(0);
  });

  test("vertical tab still splits (Opus M2: delete \\v from ASCII list stayed green)", () => {
    expect(isSpace("\v")).toBe(true);
    expect(shellTokens("tap\vsend").map((t) => t.value)).toEqual(["tap", "send"]);
  });

  test("python shell_tokens parity on non-ASCII separators", () => {
    const seps = ["\u00a0", "\u001c", "\u0085", "\u2003", "\u2028", "\u2029", "\u3000"];
    const segments = seps.map((sep) => `tap${sep}send peer`);
    const py = pyTokensMany(segments);
    for (let i = 0; i < segments.length; i++) {
      expect(shellTokens(segments[i]!).map((t) => [t.value, t.unsafe, t.raw])).toEqual(py[i]!);
    }
  });

  test("PYTHON_ISSPACE is the frozen closed set CPython 3.14 measured (29 BMP scalars; add or remove reds)", () => {
    // The live-CPython cross-check ran once at capture time (2026-09-25,
    // Python 3.14.6); the frozen set below is the retained result. The
    // full-scalar scan still verifies isSpace against every code point.
    const frozen = PYTHON_ISSPACE_CHARS.map((c) => c.codePointAt(0)!).sort((a, b) => a - b);
    expect(frozen).toHaveLength(29);
    expect([...PYTHON_ISSPACE].sort((a, b) => a - b)).toEqual(frozen);
    const bun: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (isSpace(String.fromCodePoint(cp))) bun.push(cp);
    }
    expect(bun).toEqual(frozen);
  });
});

describe("shellTokens matches the frozen python shell_tokens (drift pin)", () => {
  const fixtures = [
    "",
    "tap send peer",
    "  tap   send  ",
    `tap send peer -m "report \`date\`"`,
    "tap send peer -m 'literal `date`'",
    `tap send peer -m "retry $((n+1))"`,
    `tap send peer -m "report $(date)"`,
    `"$PY" - <<'DATA'`,
    "echo python3 - <<'DATA'",
    "foo#bar",
    "tap send # comment",
    "''",
    `""`,
    `"foo"bar`,
    "echo \\$(date)",
    "/usr/bin/env -i /abs/path/tap send",
    "TAP_HOME=/tmp tap send peer",
    "2>&1 tap send peer",
    "<<EOF tap send peer -f -",
    "command -p /abs/path/tap",
  ];

  for (const segment of fixtures) {
    test(`python parity: ${JSON.stringify(segment)}`, () => {
      const bun = shellTokens(segment);
      const py = pyTokens(segment);
      expect(bun.map((t) => [t.value, t.unsafe, t.raw])).toEqual(py);
    });
  }
});

function pySegments(command: string): string[] {
  const frozen = parity.shell_segments[command];
  if (!frozen) throw new Error(`no frozen python shell_segments for ${JSON.stringify(command)}`);
  return frozen;
}

describe("shellSegments (U2; mutant: split on &> or 2>&1)", () => {
  test("pipes, semicolons, and && split; redirection ampersands do not", () => {
    expect(shellSegments("echo a | tap send peer -m x")).toEqual(["echo a ", " tap send peer -m x"]);
    expect(shellSegments("tap send a; tap send b")).toEqual(["tap send a", " tap send b"]);
    expect(shellSegments("true && tap send peer -m x")).toEqual(["true ", "", " tap send peer -m x"]);
    expect(shellSegments("2>&1 tap send peer")).toEqual(["2>&1 tap send peer"]);
    expect(shellSegments(">|/tmp/out tap send peer")).toEqual([">|/tmp/out tap send peer"]);
    expect(shellSegments("&> /tmp/out tap send peer")).toEqual(["&> /tmp/out tap send peer"]);
  });

  test("a quoted pipe is data, not a segment boundary", () => {
    expect(shellSegments(`echo "a | b" | cat`)).toEqual([`echo "a | b" `, " cat"]);
  });

  const fixtures = [
    "echo a | tap send peer -m x",
    "true && tap send peer -m x",
    "tap send a; tap send b",
    "2>&1 tap send peer",
    ">|/tmp/out tap send peer",
    "&> /tmp/out tap send peer",
    `echo "a | b" | cat`,
  ];
  for (const command of fixtures) {
    test(`python parity: ${JSON.stringify(command)}`, () => {
      expect(shellSegments(command)).toEqual(pySegments(command));
    });
  }
});

describe("withoutHeredocBodies quoted_only (U2 + tap-6ystp)", () => {
  const quotedBackticks = "tap send peer -f - <<'EOF'\nliteral `date`\nEOF\nafter";

  test("quoted identifier heredoc drops the body (false-positive control: backticks in the body must not remain)", () => {
    expect(withoutHeredocBodies(quotedBackticks, true)).toBe("tap send peer -f - <<'EOF'\nafter");
    expect(withoutHeredocBodies(quotedBackticks, true)).not.toContain("`date`");
  });

  test("double-quoted identifier and <<- tab strip still drop the body", () => {
    expect(withoutHeredocBodies(`tap send peer -f - <<"EOF"\nliteral \`date\`\nEOF\nafter`, true)).toBe(
      `tap send peer -f - <<"EOF"\nafter`,
    );
    expect(withoutHeredocBodies("tap send peer -f - <<-'EOF'\n\tliteral `date`\n\tEOF\nafter", true)).toBe(
      "tap send peer -f - <<-'EOF'\nafter",
    );
  });

  test("space-indented closer under <<- is not a closer (mutant: lstrip all whitespace)", () => {
    const command = "tap send peer -f - <<-'EOF'\n    still-body\n    EOF\n\tEOF\nafter";
    const stripped = withoutHeredocBodies(command, true);
    expect(stripped).toBe("tap send peer -f - <<-'EOF'\nafter");
    expect(stripped).not.toContain("still-body");
  });

  test("unquoted <<EOF body stays (mutant: treat every << as literal)", () => {
    const command = "tap send peer -f - <<EOF\nliteral `date`\nEOF\nafter";
    expect(withoutHeredocBodies(command, true)).toBe(command);
  });

  test("<<'END-MSG' drops the body (tap-6ystp; mutant: identifier-only delimiter class)", () => {
    const command = "tap send peer -f - <<'END-MSG'\nliteral `date`\nEND-MSG\nafter";
    expect(withoutHeredocBodies(command, true)).toBe("tap send peer -f - <<'END-MSG'\nafter");
    expect(withoutHeredocBodies(command, true)).not.toContain("`date`");
  });

  test("<<\\EOF drops the body (tap-6ystp; mutant: quoted-quotes-only opener)", () => {
    const command = "tap send peer -f - <<\\EOF\nliteral `date`\nEOF\nafter";
    expect(withoutHeredocBodies(command, true)).toBe("tap send peer -f - <<\\EOF\nafter");
    expect(withoutHeredocBodies(command, true)).not.toContain("`date`");
  });

  test("Python and Bun agree on identifiers and punctuation delimiters", () => {
    expect(withoutHeredocBodies(quotedBackticks, true)).toBe(
      pyCallQuotedStrip(quotedBackticks),
    );
    const hyphen = "tap send peer -f - <<'END-MSG'\nliteral `date`\nEND-MSG\nafter";
    expect(pyCallQuotedStrip(hyphen)).toBe(withoutHeredocBodies(hyphen, true));
    expect(withoutHeredocBodies(hyphen, true)).not.toBe(hyphen);
  });

  test("quoted mention of <<'EOF' does not open (mutant: re.search on the raw line)", () => {
    const command = `echo "see <<'EOF' below"\nbd update x -d "ran $(date)"\nafter`;
    expect(withoutHeredocBodies(command, true)).toBe(command);
    expect(withoutHeredocBodies(command, true)).toContain("bd update");
    expect(pyCallQuotedStrip(command)).toBe(command);
  });

  test("quoted mention of <<'END-MSG' does not enlarge swallow (6ystp widening)", () => {
    const command = `echo "see <<'END-MSG' below"\nbd update x --design "ran $(date)"\nafter`;
    expect(withoutHeredocBodies(command, true)).toBe(command);
    expect(withoutHeredocBodies(command, true)).toContain("bd update");
  });

  test("unquoted <<'EOF' on the line is still a real opener", () => {
    const command = "echo see <<'EOF' below\nliteral `date`\nEOF\nafter";
    expect(withoutHeredocBodies(command, true)).toBe("echo see <<'EOF' below\nafter");
  });

  test("space-separated << 'EOF' still opens", () => {
    const command = "tap send peer -f - << 'EOF'\nliteral `date`\nEOF\nafter";
    expect(withoutHeredocBodies(command, true)).toBe("tap send peer -f - << 'EOF'\nafter");
  });
});

describe("resolveCommand (U3 / tap-oymdg command position)", () => {
  test("echo python3 is argument position, not command (mutant: whitespace is a command boundary)", () => {
    const tokens = shellTokens("echo python3 - <<'DATA'");
    const command = resolveCommand(tokens);
    expect(command?.value).toBe("echo");
    expect(tokens.some((t) => t.value === "python3")).toBe(true);
  });

  test("quoted python3 inside printf's argument is not a command (mutant: split on quoted ;|&)", () => {
    const tokens = shellTokens(`printf '%s\\n' "; python3 - <<'DATA'"`);
    expect(resolveCommand(tokens)?.value).toBe("printf");
    expect(tokens.some((t) => t.value.includes("python3"))).toBe(true);
  });

  test('"$PY" in command position is python after quote stripping', () => {
    const tokens = shellTokens(`"$PY" - <<'DATA'`);
    const command = resolveCommand(tokens);
    expect(command?.value).toBe("$PY");
  });

  test("assignments and env wrappers peel before the command", () => {
    expect(resolveCommand(shellTokens("TAP_HOME=/tmp tap send peer"))?.value).toBe("tap");
    expect(resolveCommand(shellTokens("env TAP_HOME=/tmp tap send peer"))?.value).toBe("tap");
    expect(resolveCommand(shellTokens("/usr/bin/env -i /abs/path/tap send peer"))?.value).toBe("/abs/path/tap");
    expect(resolveCommand(shellTokens("command -p /abs/path/tap send peer"))?.value).toBe("/abs/path/tap");
  });

  test("redirections are not the command (mutant: treat 2>&1 as argv0)", () => {
    expect(commandWords(shellTokens("2>&1 tap send peer")).map((w) => w.value)).toEqual([
      "tap",
      "send",
      "peer",
    ]);
    expect(resolveCommand(shellTokens("</dev/null tap send peer"))?.value).toBe("tap");
  });
});

describe("toolAndFlags (U3; the hook's Python-contract flag sets)", () => {
  test("tap send/reply/escalate in command position hit TAP body flags", () => {
    const send = toolAndFlags(shellTokens("tap send peer -m x"));
    expect(send?.tapFlags).toBe(true);
    expect(toolAndFlags(shellTokens("tap reply id -m x"))).not.toBeNull();
    expect(toolAndFlags(shellTokens("tap escalate -m x"))).not.toBeNull();
    // tap-oglkh :668 (codex P1): assign is a send-alias verb taking -m/-f, so the
    // inline-body classifier must recognize it or `tap assign x -m "$(...)"` bypasses.
    expect(toolAndFlags(shellTokens("tap assign peer -m x"))).not.toBeNull();
    expect(toolAndFlags(shellTokens("tap poll"))).toBeNull();
  });

  test("echo tap send is not a TAP command (same axis as oymdg)", () => {
    expect(toolAndFlags(shellTokens("echo tap send peer -m x"))).toBeNull();
  });

  test("hook flag sets are the Python hook's exact contract", () => {
    // TAP: --preview is in (tap-7r3fn.120).
    expect([...HOOK_TAP_BODY_FLAGS].sort()).toEqual(["--message", "--preview", "-m"]);
    // BD: the Python hook's set — --design/--acceptance are deliberately NOT
    // ported (widening hook denials is a follow-up bead, not a port); the
    // lint verb's superset was retired with its classifier (partner F4).
    expect(HOOK_BD_BODY_FLAGS.has("-d")).toBe(true);
    expect(HOOK_BD_BODY_FLAGS.has("--description")).toBe(true);
    expect(HOOK_BD_BODY_FLAGS.has("--notes")).toBe(true);
    expect(HOOK_BD_BODY_FLAGS.has("--append-notes")).toBe(true);
    expect(HOOK_BD_BODY_FLAGS.has("--body")).toBe(true);
    expect(HOOK_BD_BODY_FLAGS.has("--design")).toBe(false);
    expect(HOOK_BD_BODY_FLAGS.has("--acceptance")).toBe(false);
    expect(HOOK_BD_BODY_FLAGS.has("--notes-contains")).toBe(false);
    const bd = toolAndFlags(shellTokens("bd update x --design y"));
    expect(bd?.tapFlags).toBe(false);
  });

  test("python tool_and_flags index matches for tap/bd command-position fixtures", () => {
    const fixtures = [
      "tap send peer -m x",
      "env TAP_HOME=/tmp tap send peer -m x",
      "/usr/bin/env -i /abs/path/tap send peer",
      "command -p /abs/path/tap send peer",
      "bd update x -d y",
      "echo tap send peer -m x",
      "2>&1 tap send peer -m x",
      "tap assign peer -m x",
    ];
    for (const command of fixtures) {
      const bun = toolAndFlags(shellTokens(command));
      const frozen = parity.tool_and_flags[command];
      if (!frozen) throw new Error(`no frozen python tool_and_flags for ${JSON.stringify(command)}`);
      const [pyIndex] = frozen;
      expect(bun?.tokenIndex ?? null).toBe(pyIndex);
    }
  });
});

describe("unquotedHeredocIsUnsafe (U4)", () => {
  test("unquoted TAP heredoc with backtick or $( is unsafe; $(( and escaped $( are not", () => {
    expect(
      unquotedHeredocIsUnsafe("tap send peer -f - <<EOF\nran `date`\nEOF"),
    ).toBe(true);
    expect(
      unquotedHeredocIsUnsafe("tap send peer -f - <<EOF\nran $(date)\nEOF"),
    ).toBe(true);
    expect(
      unquotedHeredocIsUnsafe("tap send peer -f - <<EOF\nretry in $((n+1)); literal \\$(date)\nEOF"),
    ).toBe(false);
  });

  test("redirection-prefixed unquoted heredoc still counts (mutant: only trail <<)", () => {
    expect(
      unquotedHeredocIsUnsafe("<<EOF tap send peer -f -\nran `date`\nEOF"),
    ).toBe(true);
  });

  test("quoted <<'EOF' is not this scan; echo python3 IS a guarded consumer (tap-n40rq any-consumer class)", () => {
    expect(
      unquotedHeredocIsUnsafe("tap send peer -f - <<'EOF'\nliteral `date`\nEOF"),
    ).toBe(false);
    // The Python guard denies backticks in ANY unquoted heredoc body, not
    // only tap/bd ones (tap-n40rq); the retired line-based lint version
    // gated this on a tap/bd command word, which the corpus supersedes.
    expect(
      unquotedHeredocIsUnsafe("echo python3 - <<EOF\nran `date`\nEOF"),
    ).toBe(true);
  });

  test("quoted mention of <<EOF does not open (mutant: re.finditer on the raw line)", () => {
    const command = `echo "see <<EOF below"\ntap send peer -m x\nEOF`;
    expect(unquotedHeredocIsUnsafe(command)).toBe(false);
  });

  test("two unquoted heredocs on one line: later body still counts (mutant: first opener only)", () => {
    const fd = "tap send peer -f - 3<<A 4<<B\nsafe\nA\ncost $(date)\nB";
    const bare = "bd update x -d - <<A <<B\nharmless\nA\ncost $(date)\nB";
    expect(unquotedHeredocIsUnsafe(fd)).toBe(true);
    expect(unquotedHeredocIsUnsafe(bare)).toBe(true);
    expect(pyUnquotedHeredoc(fd)).toBe(true);
    expect(pyUnquotedHeredoc(bare)).toBe(true);
  });

  test("quoted then unquoted does not scan the quoted body (mutant: skip quoted, start cursor at line 2)", () => {
    const command = "bd update x -d - <<'A' <<B\nliteral $(date)\nA\nharmless\nB";
    expect(unquotedHeredocIsUnsafe(command)).toBe(false);
  });

  test("python unquoted_heredoc_is_unsafe matches on the smoke fixtures", () => {
    const fixtures = [
      "tap send peer -f - <<EOF\nran `date`\nEOF",
      "tap send peer -f - <<EOF\nran $(date)\nEOF",
      "tap send peer -f - <<EOF\nretry in $((n+1)); literal \\$(date)\nEOF",
      "<<EOF tap send peer -f -\nran `date`\nEOF",
      "tap send peer -f - <<'EOF'\nliteral `date`\nEOF",
    ];
    for (const command of fixtures) {
      const py = pyUnquotedHeredoc(command);
      expect(unquotedHeredocIsUnsafe(command)).toBe(py);
    }
  });
});

