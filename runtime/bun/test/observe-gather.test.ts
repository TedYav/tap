import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { clockFields, gather, type GatherOptions } from "../src/observe-gather";
import { classifyHarness, harnessFamily, agentFamilies } from "../src/observe";

const PANE = (session: string, cmd: string, id = "%1", pid = "100"): string =>
  `${session}\t${session}:0.0\t${id}\t${cmd}\t${pid}\t7:7\t0\n`;
const SESSION = (name: string): string => `${name}\t7:7\t1\n`;

interface Call { args: string[] }

/** A tmux that answers from a table keyed by the query it is asked. */
function fakeTmux(answers: {
  sessions?: { code: number; stdout: string };
  all?: { code: number; stdout: string };
  scoped?: Record<string, { code: number; stdout: string }>;
}, calls: Call[] = []) {
  return (args: string[]): { code: number; stdout: string } => {
    calls.push({ args });
    if (args[0] === "list-sessions") return answers.sessions ?? { code: 1, stdout: "" };
    if (args[1] === "-a") return answers.all ?? { code: 1, stdout: "" };
    const target = (args[3] ?? "").replace(/^=/, "");
    return answers.scoped?.[target] ?? { code: 1, stdout: "" };
  };
}

const noPs = () => ({ status: 1, stdout: "" });
const yesPs = () => ({ status: 0, stdout: "1 1 1 zsh zsh\n" });

function opts(extra: Partial<GatherOptions>): GatherOptions {
  return { env: { TAP_BOOT_ID: "boot:1", TAP_BOOT_ID_LEGACY: "boot:1", TAP_WATCH_NOW: "1" }, ps: noPs, ...extra };
}

describe("scope", () => {
  test("a scoped gather asks list-panes -s for exactly that session and never -a", () => {
    const calls: Call[] = [];
    const run = fakeTmux({
      sessions: { code: 0, stdout: SESSION("a") + SESSION("b") },
      scoped: { a: { code: 0, stdout: PANE("a", "zsh") } },
    }, calls);
    const g = gather(opts({ scope: "a", run }));
    expect(g.panes_rc).toBe(0);
    expect(g.panes_text).toBe(PANE("a", "zsh"));
    expect(calls.filter(c => c.args[1] === "-a")).toHaveLength(0);
    expect(calls.filter(c => c.args[0] === "list-panes")).toHaveLength(1);
  });

  test("a scoped query that fails is rc 1 with NO text, and no fallback is attempted", () => {
    const calls: Call[] = [];
    const run = fakeTmux({
      sessions: { code: 0, stdout: SESSION("a") + SESSION("b") },
      scoped: { a: { code: 1, stdout: "partial\n" } },
    }, calls);
    const g = gather(opts({ scope: "a", run }));
    expect(g.panes_rc).toBe(1);
    // A failed query's stdout is not evidence. Keeping it would hand the
    // classifier rows from a query that reported it could not answer.
    expect(g.panes_text).toBe("");
    expect(calls.filter(c => c.args[0] === "list-panes")).toHaveLength(1);
  });
});

describe("the unscoped coverage fallback", () => {
  const sessions = { code: 0, stdout: SESSION("a") + SESSION("b") };

  test("-a covering every session is used as-is", () => {
    const calls: Call[] = [];
    const run = fakeTmux({ sessions, all: { code: 0, stdout: PANE("a", "zsh") + PANE("b", "zsh") } }, calls);
    const g = gather(opts({ run }));
    expect(g.panes_rc).toBe(0);
    expect(calls.filter(c => c.args[0] === "list-panes")).toHaveLength(1);
  });

  test("-a missing a session triggers the staged per-session retry", () => {
    const run = fakeTmux({
      sessions,
      all: { code: 0, stdout: PANE("a", "zsh") },
      scoped: { a: { code: 0, stdout: PANE("a", "zsh") }, b: { code: 0, stdout: PANE("b", "zsh") } },
    });
    const g = gather(opts({ run }));
    expect(g.panes_rc).toBe(0);
    expect(g.panes_text).toBe(PANE("a", "zsh") + PANE("b", "zsh"));
  });

  test("a TRUNCATED row is not coverage — an unanchored search would accept it", () => {
    const run = fakeTmux({
      sessions,
      all: { code: 0, stdout: PANE("a", "zsh") + "b\tb:0.0\n" },
      scoped: { a: { code: 0, stdout: PANE("a", "zsh") }, b: { code: 0, stdout: PANE("b", "zsh") } },
    });
    expect(gather(opts({ run })).panes_text).toBe(PANE("a", "zsh") + PANE("b", "zsh"));
  });

  test("a session name that is a SUFFIX of another is not covered by it", () => {
    const run = fakeTmux({
      sessions: { code: 0, stdout: SESSION("demo/a") },
      all: { code: 0, stdout: PANE("x-demo/a", "zsh") },
      scoped: { "demo/a": { code: 0, stdout: PANE("demo/a", "zsh") } },
    });
    expect(gather(opts({ run })).panes_text).toBe(PANE("demo/a", "zsh"));
  });

  test("a session that emits rows and THEN fails contributes nothing", () => {
    const run = fakeTmux({
      sessions,
      all: { code: 1, stdout: "" },
      scoped: {
        a: { code: 0, stdout: PANE("a", "zsh") },
        b: { code: 1, stdout: PANE("b", "zsh") },
      },
    });
    const g = gather(opts({ run }));
    expect(g.panes_rc).toBe(0);
    expect(g.panes_text).toBe(PANE("a", "zsh"));
  });

  test("no successful chunk at all is rc 1 — UNREADABLE, not affirmatively empty", () => {
    const run = fakeTmux({ sessions, all: { code: 1, stdout: "" }, scoped: {} });
    const g = gather(opts({ run }));
    expect(g.panes_rc).toBe(1);
    expect(g.panes_text).toBe("");
  });

  test("a successful chunk with NO rows is rc 0 and empty — the third state", () => {
    const run = fakeTmux({
      sessions,
      all: { code: 1, stdout: "" },
      scoped: { a: { code: 0, stdout: "" }, b: { code: 0, stdout: "" } },
    });
    const g = gather(opts({ run }));
    // rc 0 with no rows says "this server has no panes"; rc 1 says "I could not
    // read the pane set". Collapsing them turns an unreadable inventory into an
    // affirmative empty one, and a live seat into a gone one.
    expect(g.panes_rc).toBe(0);
    expect(g.panes_text).toBe("");
  });

  test("unreadable sessions means no names to retry, so the fallback yields rc 1", () => {
    const run = fakeTmux({ sessions: { code: 1, stdout: "" }, all: { code: 1, stdout: "" } });
    const g = gather(opts({ run }));
    expect(g.sessions_rc).toBe(1);
    expect(g.sessions_text).toBe("");
    expect(g.panes_rc).toBe(1);
  });
});

describe("--fast", () => {
  test("an empty -a with NO observed sessions is affirmatively empty, not unobservable", () => {
    // A lingering server with every session closed (`exit-empty off`) answers
    // `list-sessions` non-zero and `list-panes -a` rc 0 with no rows. The old
    // `team.ts --fast` refusal carried no emptiness term at all — zero observed
    // sessions name nothing to cover — so that answer stood as "this server has
    // no panes". Folding the roster's unconditional emptiness term into fast as
    // well turned every registered seat from the affirmatively-gone family into
    // `unknown:pane_set_unobservable` under `tap admin --fast`: the three-state
    // collapse this file exists to prevent, inverted.
    const calls: Call[] = [];
    const run = fakeTmux({ sessions: { code: 1, stdout: "" }, all: { code: 0, stdout: "" } }, calls);
    const g = gather(opts({ fast: true, run }));
    expect(g.panes_rc).toBe(0);
    expect(g.panes_text).toBe("");
    // And still exactly one query: `--fast` promises no second round.
    expect(calls.filter(c => c.args[0] === "list-panes")).toHaveLength(1);
  });

  test("the same input WITHOUT --fast is unobservable, because its incumbent differs", () => {
    // Not an inconsistency to tidy away. The Bash roster treats an empty `-a` as
    // incomplete unconditionally and then finds no session to retry, so rc 1 is
    // its faithful answer. The two branches answer differently because they are
    // ports of two incumbents that answered differently.
    const run = fakeTmux({ sessions: { code: 1, stdout: "" }, all: { code: 0, stdout: "" } });
    expect(gather(opts({ run })).panes_rc).toBe(1);
  });

  test("refuses an incomplete inventory instead of re-querying", () => {
    const calls: Call[] = [];
    const run = fakeTmux({
      sessions: { code: 0, stdout: SESSION("a") + SESSION("b") },
      all: { code: 0, stdout: PANE("a", "zsh") },
      scoped: { b: { code: 0, stdout: PANE("b", "zsh") } },
    }, calls);
    const g = gather(opts({ fast: true, run }));
    expect(g.panes_rc).toBe(1);
    expect(g.panes_text).toBe("");
    expect(calls.filter(c => c.args[0] === "list-panes")).toHaveLength(1);
  });
});

describe("the boot pin: presence is not value", () => {
  const base = { TAP_BOOT_ID: "boot:9", TAP_BOOT_ID_LEGACY: "boot:9", TAP_WATCH_NOW: "1" };

  test("an UNSET pin falls back to the observed boot id", () => {
    expect(clockFields({ env: base }).now_boot).toBe("boot:9");
  });

  test("a pin set to the EMPTY STRING stays empty", () => {
    // The incumbent tested `[ -n "${TAP_OBS_NOW_BOOT_PIN+x}" ]` — variable
    // PRESENCE — and then assigned whatever it held. An empty pin means "the
    // caller sampled the boot id and got nothing", and substituting the live
    // host boot advances classification past a check the incumbent failed as
    // unobservable.
    expect(clockFields({ env: base, nowBootPinSet: true, nowBootPin: "" }).now_boot).toBe("");
  });

  test("a nonempty pin wins over the observed boot id", () => {
    expect(clockFields({ env: base, nowBootPinSet: true, nowBootPin: "boot:1" }).now_boot).toBe("boot:1");
  });

  test("a pin never invents TAP_BOOT_ID presence", () => {
    // Overloading TAP_BOOT_ID for the value would kill the five-second
    // boot:<epoch> migration tolerance, which keys on presence.
    const noBootId = { TAP_WATCH_NOW: "1" };
    const f = clockFields({ env: noBootId, nowBootPinSet: true, nowBootPin: "boot:1" });
    expect(f.now_boot).toBe("boot:1");
    expect(f.tap_boot_id_set).toBe(false);
  });
});

describe("the need-ps decision", () => {
  const sessions = { code: 0, stdout: SESSION("a") };
  const gatheredPs = (extra: Partial<GatherOptions>): boolean =>
    gather(opts({ ps: yesPs, ...extra })).ps_rc === 0;

  test("every pane agent or denylisted skips the process table", () => {
    const run = fakeTmux({ sessions, all: { code: 0, stdout: PANE("a", "zsh") + PANE("a", "claude", "%2") } });
    expect(gatheredPs({ run })).toBe(false);
  });

  test("one unsupported pane gathers it", () => {
    const run = fakeTmux({ sessions, all: { code: 0, stdout: PANE("a", "zsh") + PANE("a", "sleep", "%2") } });
    expect(gatheredPs({ run })).toBe(true);
    // The fixture must actually be unsupported, or the arm proves nothing.
    const fam = agentFamilies({});
    expect(classifyHarness(harnessFamily("sleep", fam), fam)).toBe("unsupported");
    expect(classifyHarness(harnessFamily("zsh", fam), fam)).toBe("denylist");
  });

  test("an unreadable pane set gathers it — we cannot tell", () => {
    const run = fakeTmux({ sessions, all: { code: 1, stdout: "" }, scoped: {} });
    expect(gatheredPs({ run })).toBe(true);
  });

  test("a row with an EMPTY command field gathers, as the Bash read does", () => {
    // Not because empty is unsupported in the Bash — because bash's TAB-IFS
    // `read` collapses the empty field and classifies the pane PID instead,
    // which does not classify either. Both land on "gather"; only the reason
    // differs, and no verdict depends on the reason.
    const run = fakeTmux({ sessions, all: { code: 0, stdout: PANE("a", "zsh") + "a\ta:0.1\t%2\t\t123\t7:7\t0\n" } });
    expect(gatheredPs({ run })).toBe(true);
  });

  test("a TRUNCATED row with no command field at all gathers too", () => {
    const run = fakeTmux({ sessions, all: { code: 0, stdout: PANE("a", "zsh") + "a\ta:0.1\t%2\n" } });
    expect(gatheredPs({ run })).toBe(true);
  });
});

describe("harness classification is CASE-SENSITIVE (tap-fqd3e)", () => {
  const fam = agentFamilies({});
  test("a capitalized command is unsupported, as tap_harness_family reads it", () => {
    for (const name of ["CLAUDE", "Codex", "Hermes", "AGY"]) {
      expect(classifyHarness(harnessFamily(name, fam), fam)).toBe("unsupported");
    }
  });
  test("the lowercase spellings are unchanged", () => {
    for (const name of ["claude", "codex", "opencode", "cursor", "hermes", "agy"]) {
      expect(classifyHarness(harnessFamily(name, fam), fam)).toBe("agent");
    }
    expect(harnessFamily("/usr/local/bin/claude-code", fam)).toBe("claude");
    expect(harnessFamily("/usr/local/bin/CLAUDE-code", fam)).toBe("CLAUDE-code");
  });
  test("a capitalized DENYLIST member is likewise not denylisted", () => {
    expect(classifyHarness(harnessFamily("BASH", fam), fam)).toBe("unsupported");
    expect(classifyHarness(harnessFamily("bash", fam), fam)).toBe("denylist");
  });
});

// Ported from the retired smoke/observe-gather-router.test.sh: the CLI door
// (bun observe.ts --gather-from-env) preserves a set-empty
// TAP_OBS_NOW_BOOT_PIN as an empty pin — the row's stored boot then cannot be
// related to the observation, so the seat reports unobservable instead of
// silently passing under a substituted live boot.
test("gather-from-env: a set-empty boot pin reports the seat unobservable; an unset pin does not", () => {
  const row = JSON.stringify([{ key: "k", status: "active", delivery: "pane", pane: "s/a:0.0", pane_id: "%1", session: "s/a", row_boot: "boot:1" }]);
  const script = join(import.meta.dir, "../src/observe.ts");
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script, "--gather-from-env"], {
    input: row + "\n", encoding: "utf8",
    env: { ...process.env, TAP_OBS_SESSION_SCOPE: "s/a", TAP_BOOT_ID: "boot:1", ...env },
  });
  const emptyOut = run({ TAP_OBS_NOW_BOOT_PIN: "" });
  expect(emptyOut.status).toBe(0);
  expect(emptyOut.stdout).toContain("boot_id_unobservable");
  const unsetOut = run({});
  expect(unsetOut.status).toBe(0);
  expect(unsetOut.stdout).not.toContain("boot_id_unobservable");
  expect(unsetOut.stdout).not.toBe(emptyOut.stdout);
});

test("the pane listing carries lifetime options and title without a fallback listing", () => {
  const calls: Call[] = [];
  const pane = PANE("a", "codex").trimEnd() + '\t{"version":1}\ttoken\tCodex title\twith tab\n';
  const g = gather(opts({run: fakeTmux({sessions:{code:0,stdout:SESSION("a")},all:{code:0,stdout:pane}}, calls)}));
  expect(g.panes_text).toBe(pane);
  expect(calls.filter(c => c.args[0] === "list-panes")).toHaveLength(1);
  expect(calls.find(c => c.args[0] === "list-panes")!.args.at(-1)).toContain("#{@tap_crew_lifetime}\t#{@tap_crew_lifetime_token}\t#{pane_title}");
});
