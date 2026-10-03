// tap-gbo8k: a redirection glued to a word is split off the way Bash does it,
// so `tap>/dev/null send ...` and `tap send>/dev/null ...` still classify as
// TAP send. tap-drjcr: a clustered `-c` behaves exactly like a plain `-c`.
// Authored for the Bun guard; the frozen corpus (Python captures) is untouched.
// Each test names the mutant that would keep it green if the fix were deleted.
import { describe, expect, test } from "bun:test";

import { commandWords, resolveCommand, shellTokens } from "../src/lint-body";
import { hookResponse, toolAndFlags } from "../src/shell-body-guard";

function decide(command: string): "deny" | "allow" {
  const payload = { tool_name: "Bash", tool_input: { command } };
  const result = hookResponse(new Uint8Array(Buffer.from(JSON.stringify(payload), "utf8")));
  expect(result.exit).toBe(0);
  return result.stdout === "" ? "allow" : "deny";
}

function words(command: string): string[] {
  return commandWords(shellTokens(command)).map((w) => w.value);
}

const BODY = ' peer -m "$(date)"';

describe("glued redirection is split off the word (tap-gbo8k)", () => {
  test("the two bead shapes classify as TAP send and deny the expanding body", () => {
    expect(decide(`tap>/dev/null send${BODY}`)).toBe("deny");
    expect(decide(`tap send>/dev/null${BODY}`)).toBe("deny");
    expect(toolAndFlags(shellTokens("tap>/dev/null send peer -m x"))?.tapFlags).toBe(true);
    expect(toolAndFlags(shellTokens("tap send>/dev/null peer -m x"))?.tapFlags).toBe(true);
  });

  test("spaced and glued forms agree (mutant: split only at token start)", () => {
    expect(decide(`tap >/dev/null send${BODY}`)).toBe("deny");
    expect(words("tap >/dev/null send peer")).toEqual(["tap", "send", "peer"]);
    expect(words("tap>/dev/null send peer")).toEqual(["tap", "send", "peer"]);
  });

  test("every operator the old full-match knew splits off a glued word", () => {
    for (const redirection of [">/dev/null", ">>/dev/null", "&>/dev/null", "&>>/dev/null", "</dev/null", "<&0", ">&2", ">|/dev/null", "<>/dev/null"]) {
      expect(words(`tap${redirection} send peer`)).toEqual(["tap", "send", "peer"]);
      expect(words(`tap send${redirection} peer`)).toEqual(["tap", "send", "peer"]);
    }
    // An fd number glued to a word is part of the word (`tap2>x` writes to a
    // file named x from the word `tap2`); spaced, it is the fd prefix.
    for (const redirection of ["2>/dev/null", "1>&2", "2>&1"]) {
      expect(words(`tap ${redirection} send peer`)).toEqual(["tap", "send", "peer"]);
    }
  });

  test("a here-string or heredoc operator glued to the word splits too", () => {
    expect(words("tap<<<x send peer")).toEqual(["tap", "send", "peer"]);
    expect(words("tap<<EOF send peer")).toEqual(["tap", "send", "peer"]);
  });

  test("the target may be the next token (mutant: assume the target is glued)", () => {
    expect(words("tap> /dev/null send peer")).toEqual(["tap", "send", "peer"]);
    expect(words("tap send> /dev/null peer")).toEqual(["tap", "send", "peer"]);
    expect(decide(`tap> /dev/null send${BODY}`)).toBe("deny");
  });

  test("a chain of glued redirections is consumed (mutant: split once only)", () => {
    expect(words("tap>a>b send peer")).toEqual(["tap", "send", "peer"]);
    expect(words("tap>a> b send peer")).toEqual(["tap", "send", "peer"]);
    expect(words("tap>a>&2 send peer")).toEqual(["tap", "send", "peer"]);
  });

  test("a digit-suffixed word is a word, not an fd prefix (mutant: strip trailing digits)", () => {
    expect(words("tap2>/dev/null send peer")).toEqual(["tap2", "send", "peer"]);
    expect(words("2>/dev/null tap send peer")).toEqual(["tap", "send", "peer"]);
    expect(words("{fd}>/dev/null tap send peer")).toEqual(["tap", "send", "peer"]);
  });

  test("quoted, escaped, and ANSI-C operators are data, not redirections (mutant: split inside quotes)", () => {
    expect(words("echo 'tap>/dev/null'")).toEqual(["echo", "tap>/dev/null"]);
    expect(words('echo "tap>/dev/null"')).toEqual(["echo", "tap>/dev/null"]);
    expect(words("echo tap\\>/dev/null")).toEqual(["echo", "tap>/dev/null"]);
    expect(words("echo $'tap>x' y")).toEqual(["echo", "tap>x", "y"]);
    expect(resolveCommand(shellTokens("'tap>/dev/null' send peer"))?.value).toBe("tap>/dev/null");
    expect(decide(`echo 'tap>/dev/null send'${BODY}`)).toBe("allow");
    expect(decide(`'tap>/dev/null' send${BODY}`)).toBe("allow");
  });

  test("a quoted word before a glued operator keeps its unquoted value", () => {
    expect(words(`"tap">/dev/null send peer`)).toEqual(["tap", "send", "peer"]);
    expect(decide(`"tap">/dev/null send${BODY}`)).toBe("deny");
  });

  test("&> admits no fd prefix; a pending target's own operator carries on (partner round 1)", () => {
    expect(words("tap 2&>target send peer")).toEqual(["tap", "2", "send", "peer"]);
    expect(words("tap {fd}&>target send peer")).toEqual(["tap", "{fd}", "send", "peer"]);
    expect(decide('tap 2&>target send peer -m "$(date)"')).toBe("allow");
    expect(words("tap> out> send peer")).toEqual(["tap", "peer"]);
    expect(decide('tap> out> send peer -m "$(date)"')).toBe("allow");
    expect(words("tap> a>b send peer")).toEqual(["tap", "send", "peer"]);
  });

  test("line continuations vanish before operators and targets are read (codex threads)", () => {
    expect(words("2\\\n>/dev/null tap send peer")).toEqual(["tap", "send", "peer"]);
    expect(decide('2\\\n>/dev/null tap send peer -m "$(date)"')).toBe("deny");
    expect(words("tap>\\\n /dev/null send peer")).toEqual(["tap", "send", "peer"]);
    expect(decide('tap>\\\n /dev/null send peer -m "$(date)"')).toBe("deny");
    expect(words("tap><(true)> /dev/null send peer")).toEqual(["tap", "send", "peer"]);
    // Inside single quotes a backslash-newline is data, not a continuation.
    expect(words("echo 'a\\\n>b'")).toEqual(["echo", "a\\\n>b"]);
  });

  test("process substitution stays part of the word", () => {
    expect(words("cat <(date) tap")).toEqual(["cat", "<(date)", "tap"]);
    expect(words("tee>(cat) x")).toEqual(["tee>(cat)", "x"]);
    // An operator after the span still redirects (partner round 2).
    expect(words("tap> >(cat)> send peer")).toEqual(["tap", "peer"]);
    expect(decide('tap> >(cat)> send peer -m "$(date)"')).toBe("allow");
    expect(words("tap>(cat)>x send peer")).toEqual(["tap>(cat)", "send", "peer"]);
    expect(words("tap>(cat send peer")).toEqual(["tap>(cat", "send", "peer"]);
  });

  test("a safe body behind a glued redirection still allows (no false denial)", () => {
    expect(decide('tap>/dev/null send peer -m "plain status"')).toBe("allow");
    expect(decide("tap>/dev/null send peer -m 'literal $(date)'")).toBe("allow");
    expect(decide('tap send>/dev/null peer -f body.md')).toBe("allow");
  });

  test("bd and tmux resolve through a glued redirection the same way", () => {
    expect(decide('bd>/dev/null update x -d "$(date)"')).toBe("deny");
    expect(decide("tmux>/dev/null kill-server")).toBe("deny");
    expect(decide("tmux>/dev/null -L sock kill-server")).toBe("allow");
  });

  test("a redirection after the body value does not hide the body", () => {
    expect(decide('tap send peer -m "$(date)">/dev/null')).toBe("deny");
    expect(decide('tap send peer -m"$(date)" 2>&1')).toBe("deny");
  });
});

// tap-io56b: the body-flag matcher compared the whole token, so `-m>a` was not
// `-m` and the expanding argument after it went unchecked. The flag word is the
// token cut at its first unquoted redirection, via lint-body's splitter.
const GLUED_REDIRECTIONS = [">a", ">>a", "<a", "&>a", "&>>a", ">&2", ">|a", "<>a", "<<<x", ">a>b", ">a>&2"];
const TAP_BODY_FLAGS = ["-m", "--message", "--preview"];
const BD_BODY_FLAGS = ["-d", "--description", "--notes", "--append-notes", "--body"];

describe("a body flag with a glued redirection is checked like the plain flag (tap-io56b)", () => {
  test("tap flag × glued operator: an expanding body is denied (mutant: match the whole token)", () => {
    for (const flag of TAP_BODY_FLAGS) {
      expect(decide(`tap send peer ${flag} "$(date)"`)).toBe("deny");
      for (const redirection of GLUED_REDIRECTIONS) {
        expect(decide(`tap send peer ${flag}${redirection} "$(date)"`)).toBe("deny");
        expect(decide(`tap send peer ${flag}${redirection} "\`date\`"`)).toBe("deny");
      }
    }
  });

  test("bd flag × glued operator: an expanding body is denied", () => {
    for (const flag of BD_BODY_FLAGS) {
      expect(decide(`bd update x ${flag} "$(date)"`)).toBe("deny");
      for (const redirection of GLUED_REDIRECTIONS) {
        expect(decide(`bd update x ${flag}${redirection} "$(date)"`)).toBe("deny");
      }
    }
  });

  test("the redirection target may be the next token (mutant: assume the target is glued)", () => {
    for (const flag of [...TAP_BODY_FLAGS]) {
      expect(decide(`tap send peer ${flag}> a "$(date)"`)).toBe("deny");
      expect(decide(`tap send peer ${flag}>a> b "$(date)"`)).toBe("deny");
    }
    expect(decide('bd update x -d>> a "$(date)"')).toBe("deny");
  });

  test("a spaced redirection after the flag still denies (fd prefix, then body)", () => {
    expect(decide('tap send peer -m 2>a "$(date)"')).toBe("deny");
    expect(decide('tap send peer -m >a "$(date)"')).toBe("deny");
  });

  test("every tap verb that takes a body, and a glued tool and verb redirection too", () => {
    for (const verb of ["send", "reply", "escalate", "assign"]) {
      expect(decide(`tap ${verb} peer -m>a "$(date)"`)).toBe("deny");
    }
    expect(decide('tap>/dev/null send>/dev/null peer -m>a "$(date)"')).toBe("deny");
  });

  test("a quoted flag word before the operator keeps its unquoted value", () => {
    expect(decide('tap send peer "-m">a "$(date)"')).toBe("deny");
    expect(decide("tap send peer '--message'>a \"$(date)\"")).toBe("deny");
  });

  test("a dash-led redirection target is not the next option (partner round 1; mutant: break on any dash token)", () => {
    expect(decide('tap send peer -m> -out "$(date)"')).toBe("deny");
    expect(decide('tap send peer -m >-out "$(date)"')).toBe("deny");
    expect(decide('tap send peer -m > -out "$(date)"')).toBe("deny");
    expect(decide('bd update x -d>a> -out "$(date)"')).toBe("deny");
    expect(decide('tap send peer -m> -out "plain"')).toBe("allow");
    // A real option still ends the body: `-f` takes the next word, so the
    // trailing expansion is a positional, as with the plain flag.
    expect(decide('tap send peer -m>a -f body.md "$(date)"')).toBe("allow");
    expect(decide('tap send peer -m -f body.md "$(date)"')).toBe("allow");
  });

  test("a flag-shaped redirection target is not a glued flag (partner round 1; mutant: split every token)", () => {
    expect(decide('tap send peer > --message>a "$(date)"')).toBe("allow");
    expect(decide('tap send peer > -m>a "$(date)"')).toBe("allow");
    expect(decide('bd update x > --body>a "$(date)"')).toBe("allow");
  });

  test("the flag after a glued flag still checks (mutant: stop at the first glued token)", () => {
    expect(decide('tap send peer -m>a -m "$(date)"')).toBe("deny");
    expect(decide('tap send peer -f>a body.md -m>b "$(date)"')).toBe("deny");
  });

  test("a literal body behind the glued flag still allows (no false denial)", () => {
    for (const flag of TAP_BODY_FLAGS) {
      expect(decide(`tap send peer ${flag}>a "plain status"`)).toBe("allow");
      expect(decide(`tap send peer ${flag}>a 'literal $(date)'`)).toBe("allow");
    }
    for (const flag of BD_BODY_FLAGS) {
      expect(decide(`bd update x ${flag}>a "plain status"`)).toBe("allow");
    }
  });

  test("a body-file flag with a glued redirection still allows", () => {
    expect(decide("tap send peer -f>a body.md")).toBe("allow");
    expect(decide("tap send peer --body-file>a body.md")).toBe("allow");
    expect(decide("bd update x --body-file>a body.md")).toBe("allow");
  });

  test("a quoted or escaped operator is part of the word, not a redirection (mutant: split inside quotes)", () => {
    expect(decide('tap send peer -m">a" "$(date)"')).toBe("allow");
    expect(decide("tap send peer -m\\>a \"$(date)\"")).toBe("allow");
    expect(decide('tap send peer -m$\'>a\' "$(date)"')).toBe("allow");
  });

  test("a digit-suffixed or process-substitution word is not the flag (mutant: strip trailing digits or `>(`)", () => {
    expect(decide('tap send peer -m2>a "$(date)"')).toBe("allow");
    expect(decide('tap send peer -m>(cat) "$(date)"')).toBe("allow");
  });
});

describe("clustered -c behaves like plain -c (tap-drjcr)", () => {
  test("bash -c, -xc, -lc, and -l -c all pass the nested body (documented nested-shell evasion)", () => {
    const nested = `'tap send peer -m "$(date)"'`;
    expect(decide(`bash -c ${nested}`)).toBe("allow");
    expect(decide(`bash -xc ${nested}`)).toBe("allow");
    expect(decide(`bash -lc ${nested}`)).toBe("allow");
    expect(decide(`bash -l -c ${nested}`)).toBe("allow");
    expect(decide(`sh -lc ${nested}`)).toBe("allow");
  });

  test("every form consumes the nested string as the c argument (no tool hit)", () => {
    for (const flags of ["-c", "-xc", "-lc", "-l -c"]) {
      const tokens = shellTokens(`bash ${flags} 'tap send peer -m x'`);
      expect(toolAndFlags(tokens)).toBeNull();
      expect(resolveCommand(tokens)).toBeNull();
    }
  });
});
