/**
 * Dark help catalog (tap-2gvjf). These tests import help.ts directly; they do
 * not go through main.ts. Rows are checked against each dispatcher's accepting
 * case, not against help text or unknown-subcommand refusal strings.
 */
import { describe, expect, test } from "bun:test";
import { ADMIN_SUBCOMMANDS } from "../src/verbs/admin";
import { CREW_SUBCOMMANDS } from "../src/verbs/crew";
import { NATIVE_VERBS } from "../main";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { removeScratchTree } from "./support/scratch";

import { AGENT_FAMILIES, TEAM_SUBCOMMANDS } from "../src/verbs/team";
import {
  ASK_HELP,
  HELP_COMPOSITES,
  HELP_TOMBSTONES,
  helpArgv,
  helpCatalogIndex,
  helpRows,
  isHelpForm,
  lookupHelp,
} from "../src/help";
import { expectFrozenFixture } from "./support/frozen-fixture";

const root = resolve(import.meta.dir, "../../..");
const tapBin = joinp("bin/tap");
const rootShim = joinp("scripts/tap.sh");
const tapAsk = joinp("runtime/bun/src/verbs/ask.ts");
const mainTs = joinp("runtime/bun/main.ts");

function joinp(...parts: string[]): string {
  return resolve(root, ...parts);
}

function read(rel: string): string {
  return readFileSync(joinp(rel), "utf8");
}

function rowKey(parts: readonly string[]): string {
  return parts.join(" ");
}

function catalogKeys(): Set<string> {
  return new Set(helpRows().map(rowKey));
}

function isolatedHelpEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tap-help-parity."));
  mkdirSync(join(dir, "index"), { recursive: true });
  mkdirSync(join(dir, "bus"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    TAP_HOME: join(dir, "bus"),
    TAP_INDEX_HOME: join(dir, "index"),
    TAP_SESSION_MANIFEST: join(dir, "sessions.json"),
    OPENCODE_DB_PATH: join(dir, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(dir, "version-seen.json"),
  };
  delete env.TAP_SELF;
  delete env.TMUX;
  delete env.TMUX_PANE;
  return { env, dir };
}

function bashHelp(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync("bash", [tapBin, ...args], { encoding: "utf8", env });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function namedArms(src: string, uniqueNeedle: string): string[] {
  const idx = src.lastIndexOf(uniqueNeedle);
  if (idx < 0) throw new Error(`named-arm needle not found: ${uniqueNeedle}`);
  const slice = src.slice(idx, idx + 1200);
  const names: string[] = [];
  for (const match of slice.matchAll(/^\s+([a-z][a-z0-9-]*)\)/gm)) {
    names.push(match[1]!);
  }
  return names;
}

function dispatcherRows(): Set<string> {
  const rows = new Set<string>();
  // The router is the one dispatcher (verb-prelude row C): its native table
  // and the forms main.ts accepts before or beside route(), each
  // checked against the arm that accepts it, plus the one help-only topic.
  for (const verb of NATIVE_VERBS) rows.add(verb);
  const main = read("runtime/bun/main.ts");
  for (const [verb, arm] of [["ask", 'argv[0] === "ask"'], ["launch", 'argv[0] === "launch"'], ["init", 'verb === "init"']] as const) {
    if (!main.includes(arm)) throw new Error(`main.ts lost the ${verb} pre-route arm`);
    rows.add(verb);
  }
  rows.add("advisory");

  for (const sub of TEAM_SUBCOMMANDS) rows.add(`team ${sub}`);
  rows.add("team");

  const session = /session: async \(\) => \{([\s\S]*?)\n  \},/.exec(main)?.[1];
  if (!session) throw new Error("main.ts lost the native session handler");
  for (const match of session.matchAll(/argv\[0\] === "([a-z]+)"/g)) {
    // Completion is an internal shell protocol, deliberately absent from help.
    if (match[1] !== "complete") rows.add(`session ${match[1]}`);
  }
  // Launch is the final accepted arm, after the native handler's refusal guard.
  if (!session.includes('if (argv[0] !== "launch") throw new TapError') ||
      !session.includes('cmdSessionLaunch(argv.slice(1)')) throw new Error("main.ts lost the native launch arm");
  rows.add("session launch");
  rows.add("session");

  // U-C: the Bash body is deleted; the accepted set IS the native verb's own
  for (const sub of CREW_SUBCOMMANDS) rows.add(`crew ${sub}`);
  rows.add("crew");

  // checkpoint C: the Bash body is deleted; the accepted set IS the native
  // dispatcher's list.
  for (const sub of ADMIN_SUBCOMMANDS) rows.add(`admin ${sub}`);
  rows.add("admin");

  // every watch arm is native (W3): the accepted set is verbs/watch.ts's, `tick` and
  // `run` dispatched by name before it
  const watchSrc = read("runtime/bun/src/verbs/watch.ts");
  const watchList = /if \(!\[([^\]]+)\]\.includes\(sub\)\)/.exec(watchSrc);
  if (!watchList) throw new Error("verbs/watch.ts lost its accepted-subcommand list");
  for (const sub of [...watchList[1]!.matchAll(/"([a-z]+)"/g)].map(m => m[1]!)) rows.add(`watch ${sub}`);
  for (const sub of ["tick", "run"]) {
    if (!watchSrc.includes(`sub === "${sub}"`)) throw new Error(`verbs/watch.ts lost accepting arm '${sub}'`);
    rows.add(`watch ${sub}`);
  }
  rows.add("watch");

  // R6 U3: the goalie dispatcher is native (verbs/goalie.ts), shaped like watch's.
  const goalieSrc = read("runtime/bun/src/verbs/goalie.ts");
  const goalieList = /!\(\[([^\]]+)\]\.includes\(sub\)\)/.exec(goalieSrc);
  if (!goalieList) throw new Error("verbs/goalie.ts lost its accepted-subcommand list");
  for (const sub of [...goalieList[1]!.matchAll(/"([a-z]+)"/g)].map(m => m[1]!)) rows.add(`goalie ${sub}`);
  for (const sub of ["tick", "run"]) {
    if (!goalieSrc.includes(`sub === "${sub}"`)) throw new Error(`verbs/goalie.ts lost accepting arm '${sub}'`);
    rows.add(`goalie ${sub}`);
  }

  // R12 U1: the worktree dispatcher is native (verbs/worktree.ts), shaped like
  // spool/remind's accepted-arm derivation.
  const worktreeSrc = read("runtime/bun/src/verbs/worktree.ts");
  if (!worktreeSrc.includes('sub !== "check"')) throw new Error("verbs/worktree.ts lost check");
  if (!worktreeSrc.includes('sub !== "branch"')) throw new Error("verbs/worktree.ts lost branch");
  rows.add("worktree");
  rows.add("worktree check");
  rows.add("worktree branch");

  // `tap self`: parseSelf accepts compact|goal|loop; cmdSelf routes clear|rebrief to the recovery parser.
  const selfSrc = read("runtime/bun/src/verbs/self.ts");
  const selfList = /\["([a-z]+)", "([a-z]+)", "([a-z]+)"\]\.includes\(verb \?\? ""\)/.exec(selfSrc);
  if (!selfList) throw new Error("verbs/self.ts lost its accepted-verb list");
  if (!selfSrc.includes('argv[0] === "clear" || argv[0] === "rebrief"')) throw new Error("verbs/self.ts lost the clear|rebrief arm");
  for (const sub of [...selfList.slice(1), "clear", "rebrief"]) rows.add(`self ${sub}`);
  rows.add("self");

  // `tap command`: compact is the compatibility spelling; clear is retired but still an accepted word.
  const compactSrc = read("runtime/bun/src/verbs/compact.ts");
  for (const sub of ["compact", "clear"]) {
    if (!compactSrc.includes(`verb === "${sub}"`) && !compactSrc.includes(`verb !== "${sub}"`)) throw new Error(`verbs/compact.ts lost the command ${sub} arm`);
    rows.add(`command ${sub}`);
  }
  rows.add("command");

  const spool = read("runtime/bun/src/verbs/spool.ts");
  for (const sub of ["list", "status", "cancel"]) {
    if (!spool.includes(`if (sub === "${sub}")`)) {
      throw new Error(`spool.ts lost accepting arm '${sub}'`);
    }
    rows.add(`spool ${sub}`);
  }
  rows.add("spool");

  const remind = read("runtime/bun/src/verbs/remind.ts");
  for (const sub of ["list", "cancel", "kill"]) {
    if (!remind.includes(`if (sub === "${sub}")`)) {
      throw new Error(`remind.ts lost accepting arm '${sub}'`);
    }
    rows.add(`remind ${sub}`);
  }
  rows.add("remind");

  const config = read("runtime/bun/src/verbs/config.ts");
  for (const sub of ["get", "set", "path"]) {
    if (!config.includes(`sub === "${sub}"`)) {
      throw new Error(`config.ts lost accepting arm '${sub}'`);
    }
    rows.add(`config ${sub}`);
  }
  rows.add("config");

  // Single-form families: each sub is the one arm its handler accepts.
  const bus = read("runtime/bun/src/bus-archive.ts");
  if (!bus.includes('argv.shift()!=="archive"')) throw new Error("bus-archive.ts lost its archive arm");
  rows.add("bus");
  rows.add("bus archive");
  // `tap teams refresh` is delegated to admin refresh (main.ts) and is public.
  if (!/teams: async[\s\S]*?argv\[0\] === "refresh"\) return runNative\("admin"/.test(main)) throw new Error("main.ts lost the teams refresh arm");
  rows.add("teams");
  rows.add("teams refresh");
  // `tap teams roster` aliases the machine seat view (main.ts), ahead of a team named roster.
  if (!/teams: async[\s\S]*?name === "roster"\) return writeRoutingResult\(await teamsView\(\["--seats"/.test(main)) throw new Error("main.ts lost the teams roster arm");
  rows.add("teams roster");
  const completion = read("runtime/bun/src/completion.ts");
  if (!completion.includes('argv.length === 1 && argv[0] === "zsh"')) throw new Error("completion.ts lost its zsh arm");
  rows.add("completion");
  rows.add("completion zsh");

  return rows;
}

describe("help is native on every door", () => {
  test("bin/tap and the root shim serve lookupHelp bytes", () => {
    const { env, dir } = isolatedHelpEnv();
    try {
      const forms: [string[], string[]][] = [
        [["help"], []], [["--help"], []], [["help", "team", "refresh"], ["team", "refresh"]],
        [["send", "help"], ["send"]], [["team", "up", "-h"], ["team", "up"]], [["help", "advisory"], ["advisory"]],
        [["help", "notaverb"], ["notaverb"]], [["help", "team", "notasub"], ["team", "notasub"]],
        [["help", "ask"], ["ask"]], [["-h", "ask"], ["ask"]], [["--help", "ask"], ["ask"]],
      ];
      for (const [argv, topic] of forms) {
        const want = lookupHelp(topic);
        for (const door of [[tapBin], ["bash", rootShim]]) {
          const child = spawnSync(door[0]!, [...door.slice(1), ...argv], { encoding: "utf8", env, cwd: dir });
          expect({ door: door.at(-1), argv, exit: child.status, stdout: child.stdout, stderr: child.stderr })
            .toEqual({ door: door.at(-1), argv, exit: want.exit, stdout: want.stdout, stderr: want.stderr });
        }
      }
    } finally {
      removeScratchTree(dir);
    }
  });

  test("the router traces help as native, before onboarding", () => {
    const { env, dir } = isolatedHelpEnv();
    try {
      const trace = join(dir, "trace");
      const child = spawnSync("bun", [mainTs, "help", "team"], { encoding: "utf8", env: { ...env, TAP_BUN_ROUTE_TRACE: trace }, cwd: dir });
      expect(child.status).toBe(0);
      expect(child.stdout).toBe(lookupHelp(["team"]).stdout);
      expect(readFileSync(trace, "utf8")).toBe("native help\n");
    } finally {
      removeScratchTree(dir);
    }
  });

  test("a trailing help word on a verb without a page is not help", () => {
    expect(isHelpForm(["notaverb", "help"])).toBe(false);
    expect(isHelpForm(["send", "help", "-m", "x"])).toBe(false);
    expect(isHelpForm(["help", "skill", "tap"])).toBe(false);
    expect(isHelpForm(["help", "ask"])).toBe(false);
    expect(isHelpForm(["help", "ask", "x"])).toBe(true);
    expect(isHelpForm(["send", "help"])).toBe(true);
  });

  test("every trailing help spelling on the done tombstone is the same help request", () => {
    for (const spelling of ["--help", "-h", "help"]) {
      expect(isHelpForm(["done", spelling])).toBe(true);
      expect(helpArgv(["done", spelling])).toEqual(helpArgv(["help", "done"]));
    }
    expect(isHelpForm(["done", "some-id"])).toBe(false);
  });
});

describe("accepted rows come from accepting cases", () => {
  test("every accepted command, subcommand, and help topic is a catalog row", () => {
    const catalog = catalogKeys();
    const accepted = dispatcherRows();
    expect([...accepted].filter((key) => !catalog.has(key)).sort()).toEqual([]);
    expect([...catalog].filter((key) => key !== "" && !accepted.has(key)).sort()).toEqual([]);
  });

  test("setup help names every core skill as the fresh-install set", () => {
    const setup = lookupHelp(["setup"]).stdout;
    expect(setup).toContain("Claude and Codex use the complete tap plugin");
    expect(setup).toContain("tap-help");
    expect(setup).not.toContain("tap-config only.");
  });
  test("overview stays within 40 lines", () => {
    expect(lookupHelp([]).stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
  });

  test("first-exchange help separates options and preserves settlement and retry limits", () => {
    for (const verb of ["send", "assign", "reply"]) {
      const page = lookupHelp([verb]).stdout;
      expect(page).toContain("\nOPTIONS\n");
      expect(page).toContain("\nEXAMPLES\n");
      expect(page).toContain("\nEXIT CODES\n");
      expect(page).toContain("do not blindly retry");
      expect(page).toContain("delivery target unavailable; no message remains placed");
    }
    const reply = lookupHelp(["reply"]).stdout.replace(/\s+/g, " ");
    expect(reply).toContain("--progress send a settle-only status; leave the ask open");
    expect(reply).toContain("Do not re-run tap reply: that would send a second answer");
    expect(reply).toContain("Accepted is not processed");
    expect(reply).toContain("Keep a sentinel's <team>/ prefix");
    expect(lookupHelp(["assign"]).stdout).toContain("--wake             accepted but unnecessary");
  });

  test("spool help distinguishes native pairs from intent cancellation without a Bash-drain claim", () => {
    const page = lookupHelp(["spool"]).stdout.replace(/\s+/g, " ");
    expect(page).toContain("intent record: tap spool cancel <id>");
    expect(page).toContain("payload/metadata pair: tap cancel <id> --spooled");
    expect(page).toContain("Native send and reply use payload/metadata pairs");
    expect(page).toContain("legacy_bash_parks and legacy_bash_park");
    expect(page).not.toContain("stays on the Bash drain");
    expect(page).toContain("refuses a pair before any effect");
  });

  test("spool sender filter help distinguishes intent rows, malformed diagnostics and pair counts", () => {
    const page = lookupHelp(["spool"]).stdout.replace(/\s+/g, " ");
    expect(page).toContain("--from <handle> filter intent rows by sender; omit malformed diagnostics. The legacy_bash_parks count still includes all senders.");
  });

  test("operational pages state what their parsers and exits do", () => {
    const page = (...argv: string[]) => lookupHelp(argv).stdout;
    const doctor = page("doctor");
    expect(doctor).toContain("summary.seat_attention counts named seats with warning findings");
    expect(doctor).toContain("tap --verbose doctor");
    expect(doctor).toContain("0  bus integrity clean; seat-health warnings may still need attention");
    // escalate: who may call it (escalate.ts unregistered / unregistered_from / reserved_from)
    const escalate = page("escalate");
    expect(escalate).toContain("\n  WHO CAN ESCALATE\n");
    expect(escalate).toContain("--from <seat> naming a registered seat");
    expect(escalate).toContain("unregistered_from, or reserved_from");
    expect(Math.max(...escalate.split("\n").map(l => l.length))).toBeLessThan(900);
    // out: --team and qualified targets (out-retire.ts parseOutForm)
    const out = page("out");
    expect(out).toContain("tap out [<name|team/name>] [--team <team>]");
    expect(out).toContain("<team>/<handle> or with --team <team>; naming it both ways is refused (selector_conflict)");
    // spool: output is always JSONL (verbs/spool.ts list)
    expect(page("spool")).toContain("output is always JSONL, so --json changes nothing");
    // watch: status exit codes (verbs/watch.ts status return)
    expect(page("watch")).toContain("status:    0 disarmed or dispatcher alive, 1 cannot be checked, 2 dispatcher dead");
    expect(page("watch")).toContain("its exit-1 advice may ask you to run it by hand");
    // remind: the example runs outside the TAP repo
    const remind = page("remind");
    expect(remind).toContain("--when-done 'npm test' --circle-back 30m");
    expect(remind).not.toContain("runtime/bun/test/run.sh");
    // withdraw: --team is accepted (verbs/withdraw.ts)
    expect(page("withdraw")).toContain("[--by <me>] [--team <name>] [--json]");
    // teams refresh: --dry-run is accepted (page "teams refresh")
    expect(page("teams")).toContain("tap teams refresh [--dry-run] [--json]");
    // cancel: every reason verbs/cancel.ts can write
    expect(page("cancel")).toContain("reason=seat_unresolvable, instance_retired, unconfirmed_withdrawn or spooled_withdrawn");
    // attach: the picker's Ctrl-C exit (attach-picker.ts)
    expect(page("attach")).toContain("130  interrupted (Ctrl-C in the picker)");
    // config: GET / SET / ARRAY paragraphs, no first-run wall
    const config = page("config");
    expect(config).toContain("and other values.\n\n  set parses the value");
    expect(config).toContain("new value.\n\n  The one array exception");
    expect(Math.max(...config.split("\n").map(l => l.length))).toBeLessThan(900);
  });

  test("init, setup, config and presets lead with their scope", () => {
    const init = lookupHelp(["init"]).stdout, setup = lookupHelp(["setup"]).stdout;
    expect(init).toContain("Scope: this project.");
    expect(init).toContain("Optional folder trust records this current directory");
    expect(init).toContain("tap setup --machine");
    expect(init).toContain("it prompts when AGENTS.md is absent, you pass neither --yes nor --json, and stdin/stderr are terminals");
    for (const mode of ["tap setup --machine ", "tap setup --machine --answers <file|->", "tap setup [--yes] [--team <name>]", "tap setup --repo [--check]"]) {
      expect(setup).toContain(`\n  ${mode}`);
    }
    expect(setup).toContain("tap setup --machine --answers choices.json --dry-run --json");
    expect(setup).toContain("docs/EASY-MODE.md");
    expect(setup).toContain("Candidate config is inactive");
    expect(lookupHelp(["config"]).stdout).toContain("The one array exception: notifications.command");
    const presets = lookupHelp(["presets"]).stdout;
    expect(presets).toContain("tap session launch <preset> [name]");
    expect(presets).toContain("source=null");
    expect(presets).toContain("presets.toml");
    expect(presets).not.toContain("reference-copy");
    expect(presets).not.toMatch(/forced Bash|prologue|Native dispatch|legacy fallback/);
  });

  test("first-run pages stay scannable: no wall-of-text line in presets or init", () => {
    for (const verb of ["presets", "init"]) {
      const longest = Math.max(...lookupHelp([verb]).stdout.split("\n").map(line => line.length));
      expect(longest).toBeLessThan(500);
    }
    const init = lookupHelp(["init"]).stdout;
    expect(init).toContain("an existing team is left untouched; the folder-trust offer still applies");
    expect(init).toContain("\n    - .tap/ in the project");
    expect(init).toContain("\n    - on a fresh machine, ~/.tap/global-registry.json");
  });

  test("nudge page documents the ladder, interrupt rows, wire forms and tombstones (tap-xe42x)", () => {
    const nudge = lookupHelp(["nudge"]).stdout.replace(/\s+/g, " ");
    expect(nudge).toContain("no rung ever sends C-c");
    expect(nudge).toContain("opencode: Escape Escape");
    expect(nudge).toContain("Enter at +5000 ms, then Enter +200 ms later");
    expect(nudge).toContain("hermes: the bare doorbell's submission is the interrupt");
    expect(nudge).toContain("hermes queues the doorbell behind /queue");
    expect(nudge).toContain("[[TAP v0.23 nudge]]");
    expect(nudge).toContain("--pane repairs a pane that no registered seat matches: rungs 1 and 2 only");
    expect(nudge).toContain("tap nudge: aggressiveness=<mode> source=<config|default>");
    for (const retired of ["--interrupt (now the default)", "--reason (use --message)", "--aggressiveness (use --dry-run)", "--from (nudges have no sender)"]) {
      expect(nudge).toContain(retired);
    }
  });

  test("the overview names the message-recovery verbs", () => {
    expect(lookupHelp([]).stdout).toContain("tap nudge · cancel · resend · withdraw · show");
  });

  test("help.ts defines each page once: no object-literal key is overwritten by a later assignment", () => {
    const source = readFileSync(join(root, "runtime/bun/src/help.ts"), "utf8");
    for (const dead of ["escalate", "models", "out", "in"]) {
      expect(source).not.toMatch(new RegExp(`^  "${dead}": `, "m"));
    }
  });

  test("no help page cites a numbered pull request", () => {
    for (const topic of helpRows()) {
      expect(lookupHelp([...topic]).stdout).not.toMatch(/\bPR #?\d+/);
    }
  });

  test("health help names the injection-behavior attention item and doctor names its finding (tap-832t0)", () => {
    const health = lookupHelp(["health"]);
    expect(health.exit).toBe(0);
    // One sentence survives intact on its own indented line under the page's exit-code line.
    expect(health.stdout).toContain("Exit 0 healthy / 2 attention.\n  An attention item of type injection-behavior-invalid (field detail)");
    expect(health.stdout).toContain("the legacy alias warn");
    expect(health.stdout).toContain("preset_config_invalid");
    const doctor = lookupHelp(["doctor"]).stdout;
    expect(doctor).toContain("injection_behavior");
    expect(doctor).toContain("injection_behavior_invalid");
  });

  test("retired lane verbs are absent from both help surfaces", () => {
    expect([...catalogKeys()].some((key) => key === "lane" || key.startsWith("lane "))).toBe(false);
    expect(lookupHelp(["lane"]).exit).toBe(1);
    const child = spawnSync("bash", [tapBin, "help", "lane"], { encoding: "utf8" });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("no help for 'lane'");
    const overview = spawnSync("bash", [tapBin, "help"], { encoding: "utf8" });
    expect(overview.status).toBe(0);
    expect(overview.stdout).not.toMatch(/^  lane /m);
  });

  test("goalie reap is a row, named as internal in help though the refusal string omits it", () => {
    const goalieHelp = lookupHelp(["goalie"]);
    expect(goalieHelp.stdout).toContain("tap help goalie reap");
    const goalieSrc = read("runtime/bun/src/verbs/goalie.ts");
    const refuse = goalieSrc.match(/unknown subcommand '\$\{sub\}' \(([^)]+)\)/)?.[1];
    expect(refuse).toBe("on|off|status");
    expect(refuse).not.toContain("reap");
    const reap = lookupHelp(["goalie", "reap"]);
    expect(reap.exit).toBe(0);
    expect(reap.stdout).toContain("archive-directory");
    expect(reap.key).toBe("goalie reap");
  });

  test("admin prune is a tombstone row, not an absent row", () => {
    expect(HELP_TOMBSTONES["admin prune"]).toBeDefined();
    const result = lookupHelp(["admin", "prune"]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("tap admin refresh");
    expect(result.stderr).toContain("tap admin retire <team>");
    expect(result.stderr).toContain("tap admin prune is now");
  });

  test("done is a tombstone row that names its replacement, not a live verb", () => {
    expect(HELP_TOMBSTONES["done"]).toBeDefined();
    const result = lookupHelp(["done"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("tap reply <id> --by <you> -f <file>");
    expect(result.stderr).toContain("tap read <id>");
  });

  test("spool is a help row with its composites", () => {
    expect(catalogKeys().has("spool")).toBe(true);
    expect(lookupHelp(["spool"]).exit).toBe(0);
    expect(HELP_COMPOSITES.spool).toEqual(["list", "status", "cancel"]);
  });

  test("ask is a help row dispatched before route(), not a native handler", () => {
    expect(NATIVE_VERBS.has("ask")).toBe(false);
    expect(catalogKeys().has("ask")).toBe(true);
  });

  test("session complete is not a help row", () => {
    expect(catalogKeys().has("session complete")).toBe(false);
  });
});

describe("extra composite tokens", () => {
  test("a third token retains the recognized composite in the remedy", () => {
    const result = lookupHelp(["team", "up", "junk"]);
    expect(result.exit).toBe(1);
    expect(result.key).toBe("team up junk");
    expect(result.stderr).toContain("For subcommand details, see: tap help team up");
  });
});

describe("76m7 composite routing", () => {
  test("team out has dedicated lifecycle help and remains distinct from shutdown", () => {
    const out = lookupHelp(["team", "out"]);
    expect(out.exit).toBe(0);
    expect(out.stdout).toContain("NAME\n  tap team out");
    expect(out.stdout).toContain("--only h,...");
    expect(out.stdout).toContain("--hard");
    expect(out.stdout).toContain("registry envelope");
    expect(helpArgv(["help", "team", "out"])).toEqual(out);
  });

  test("help team refresh reaches team-refresh scope, not seat-context refresh", () => {
    const composite = lookupHelp(["team", "refresh"]);
    const seat = lookupHelp(["refresh"]);
    const team = lookupHelp(["team"]);
    expect(composite.exit).toBe(0);
    expect(composite.key).toBe("team refresh");
    expect(composite.stdout).toContain("tap team refresh");
    expect(composite.stdout).toContain("--hard");
    expect(composite.stdout).toContain("gone seats");
    expect(composite.stdout).toContain("Distinct from `tap refresh`");
    expect(composite.stdout).not.toBe(seat.stdout);
    expect(seat.stdout).toContain("clear its context");
    expect(composite.stdout).not.toContain("clear its context");
    expect(helpArgv(["help", "team", "refresh"])).toEqual(composite);
    expect(team.stdout).toContain("  refresh      Trim roster rows");
  });

  test("an unknown subverb still refuses and names the ignored token", () => {
    const result = lookupHelp(["team", "notasub"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no help topic 'team notasub'");
    expect(result.stderr).not.toContain("at most one verb");
    expect(result.stderr).toContain("For subcommand details, see: tap help team");
  });

  test("bus archive, teams refresh and completion zsh are help rows, not refusals", () => {
    for (const topic of [["bus", "archive"], ["teams", "refresh"], ["completion", "zsh"]]) {
      const result = lookupHelp(topic);
      expect(result.exit, topic.join(" ")).toBe(0);
      expect(result.key).toBe(topic.join(" "));
      expect(result.stderr).toBe("");
      expect(helpArgv(["help", ...topic])).toEqual(result);
    }
    expect(lookupHelp(["bus", "archive"]).stdout).toBe(lookupHelp(["bus"]).stdout);
    expect(lookupHelp(["completion", "zsh"]).stdout).toBe(lookupHelp(["completion"]).stdout);
    // teams refresh is the machine alias of admin refresh, not the team-roster page.
    expect(lookupHelp(["teams", "refresh"]).stdout).toContain("tap admin refresh");
    expect(lookupHelp(["teams", "refresh"]).stdout).not.toBe(lookupHelp(["teams"]).stdout);
  });

  test("an extra word after a fallback composite still names the valid parent topic", () => {
    for (const topic of [["bus", "archive"], ["completion", "zsh"], ["teams", "refresh"]]) {
      const result = lookupHelp([...topic, "junk"]);
      expect(result.exit).toBe(1);
      expect(result.stderr).toBe(`tap help: no help topic '${topic.join(" ")} junk'.\nFor subcommand details, see: tap help ${topic.join(" ")}\n`);
    }
  });

  test("the new family pages carry the required NAME and USAGE sections and their branchable exits", () => {
    for (const topic of [["bus", "archive"], ["teams", "refresh"]]) {
      const page = lookupHelp(topic).stdout;
      expect(page).toMatch(/^NAME\n  tap /);
      expect(page).toContain("\nUSAGE\n  tap ");
      expect(page).toContain("\nEXIT CODES\n");
    }
  });

  test("every command page begins with NAME and then USAGE (CLI-HELP-3/4)", () => {
    // The overview and the transport advisory are not command pages, and tombstones print nothing on stdout.
    const exempt = new Set(["", "advisory", ...Object.keys(HELP_TOMBSTONES)]);
    const shapeless: string[] = [];
    for (const row of helpRows()) {
      if (exempt.has(rowKey(row))) continue;
      if (!/^NAME\n {2}tap [^\n]+\n\nUSAGE\n {2}\S/.test(lookupHelp([...row]).stdout)) shapeless.push(rowKey(row));
    }
    expect(shapeless).toEqual([]);
  });

  test("the escalate page names every refusal that sends nothing, with its remedy", () => {
    const page = lookupHelp(["escalate"]).stdout;
    for (const refusal of ["unregistered", "unregistered_from", "reserved_from", "generation_unverifiable"]) expect(page).toContain(refusal);
    expect(page).toContain("wait for tmux to answer and retry, or pass --from <seat>");
  });

  test("an unsupported word under a known verb names the topic and keeps literal operands out of help", () => {
    const result = lookupHelp(["bus", "prune"]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toBe("tap help: no help topic 'bus prune'.\nFor subcommand details, see: tap help bus\n");
    // A literal operand is data, not a help request, for verbs that take operands.
    expect(isHelpForm(["send", "help", "-m", "x"])).toBe(false);
    expect(isHelpForm(["bus", "archive", "--older-than", "7d"])).toBe(false);
  });

  test("helpArgv recognizes team up's trailing help spelling", () => {
    const page = lookupHelp(["team", "up"]);
    expect(page.exit).toBe(0);
    expect(page.stdout).toContain("tap team up");
    expect(page.stdout).toContain("--only <h,...>");
    expect(helpArgv(["team", "up", "help"])).toEqual(page);
    expect(helpArgv(["team", "up", "--help"])).toEqual(page);
  });

  test("attach help explains the human missing and scoped target doors", () => {
    const page = lookupHelp(["attach"]);
    expect(page.exit).toBe(0);
    expect(page.stdout).toContain("tap attach [--no-resume] [<handle|team/handle>]");
    expect(page.stdout).toContain("no target opens the team and seat pickers");
    expect(page.stdout).toContain("missing-target discovery still works and is attach-only");
    expect(page.stdout).toContain("Invalid syntax and unavailable authority");
    const reference = readFileSync(join(root, "docs/attach-launch-reference.md"), "utf8");
    expect(reference).toContain("Picked seats recheck the chosen team");
    expect(reference).toContain("TAP_TEAM_SELECT is never widened");
    expect(reference).toContain("Handles are C-locale sorted");
    for (const verb of ["attach", "launch"]) {
      const help = lookupHelp([verb]).stdout;
      expect(help.split("\n").length).toBeLessThanOrEqual(60);
      expect(help).toContain("docs/attach-launch-reference.md#");
      expect(help.indexOf("EXAMPLES")).toBeLessThan(help.indexOf("SEE ALSO"));
    }
  });
});

describe("register recovery and session door pages (docs lane 2)", () => {
  test("register help names the recovery flags and separates them from tap restore", () => {
    const page = lookupHelp(["register"]).stdout;
    for (const flag of ["--list-history", "--restore <instance>", "--fresh", "--override-worktree"]) expect(page).toContain(flag);
    expect(page).toContain("tap restore <handle> --archive <archive>   restore a handle's archived state");
    expect(page).toContain("tap team reset                             stop and retire seats; keep the team");
    expect(page).toContain("tap session resume <handle>                bring a stopped process back");
    expect(page).not.toContain("(the team archive)");
    expect(page.split("\n").every(line => line.length < 400 || line.trimStart().startsWith("tap register "))).toBe(true);
    expect(lookupHelp(["in"]).stdout).toBe(page);
    const resume = lookupHelp(["session", "resume"]).stdout;
    expect(resume).toContain("tap session resume <harness> <name> [--dry-run] [--json]");
    expect(resume).toContain("with a\n  usable foreground terminal it attaches");
    const relaunch = lookupHelp(["session", "relaunch"]).stdout;
    expect(relaunch).toContain("Crew seats have no conversation: they relaunch fresh");
    expect(relaunch).not.toContain("a crew or poll row (no launcher record of its own)");
  });

  test("session help is a short entry page that states preset and bare-harness tuning", () => {
    const family = lookupHelp(["session"]).stdout;
    expect(family.length).toBeLessThan(2500);
    expect(family.split("\n").every(line => line.length <= 100)).toBe(true);
    expect(family.replace(/\s+/g, " ")).toContain("With a preset, model and effort come from the preset and cannot be overridden. With a bare harness, use --model and --effort");
    expect(family).not.toContain("stay preset-owned");
    expect(family.replace(/\s+/g, " ")).toContain("OpenCode 2 takes model and variant; Cursor takes model only.");
    expect(family.replace(/\s+/g, " ")).toContain("continue the stored conversation where the harness can");
    expect(family).not.toContain("same chat");
    expect(family.replace(/\s+/g, " ")).toContain("restart may already have ended the old session");
    expect(lookupHelp(["session", "relaunch"]).stdout).not.toContain("in a batch that member's");
    expect(family).toContain("tap session launch claude");
    for (const sub of ["launch", "resume", "restart", "relaunch", "fork", "repair", "list"]) {
      expect(family).toContain(`tap session ${sub} `);
      expect(lookupHelp(["session", sub]).exit).toBe(0);
    }
    // Precise details left the parent and live on the owning pages.
    const launch = lookupHelp(["launch"]).stdout;
    expect(launch).toContain("preset_not_composable");
    expect(launch).toContain("Unknown flags warn, forward to the harness and persist across resume/restart.");
    expect(launch).toContain("session_record_exists");
    const reference = readFileSync(join(root, "docs/attach-launch-reference.md"), "utf8");
    expect(reference).toContain("[harness.<name>] machine policy");
    expect(reference).toContain("--cwd is not a TAP launch option");
    expect(lookupHelp(["session", "resume"]).stdout).toContain("would_reattach");
    expect(lookupHelp(["session", "resume"]).stdout).toContain("A live resume re-registers the occupant");
    expect(reference.replace(/\s+/g, " ")).toContain("A missing file applies no policy silently.");
    expect(reference).toContain("seated-and-unjoined");
  });

  test("outstanding help excludes cancelled sends", () => {
    const page = lookupHelp(["outstanding"]).stdout;
    expect(page).toContain("unsettled, uncancelled outbound messages, including parked sends");
    expect(page).not.toContain("no .done yet");
  });

  test("out help separates leaving, stopping, forwarding and crew dismissal", () => {
    const page = lookupHelp(["unregister"]).stdout;
    expect(page).toContain("leave and stop");
    expect(page).toContain("leave, keep mail");
    expect(page).toContain("Exit 0 means the row is gone, not that a process stopped");
    expect(lookupHelp(["out"]).stdout).toBe(page);
  });

  test("crew help gives every subcommand an example", () => {
    const page = lookupHelp(["crew"]).stdout;
    for (const sub of ["add", "list", "resume", "shutdown", "relaunch", "rearm", "remove"]) expect(page).toContain(`tap crew ${sub} `.trimEnd());
    expect(page).toContain("tap crew shutdown --owner fable");
    expect(page).toContain("tap crew resume reviewer");
    expect(page).toMatch(/rearm\s+retired:/);
  });

  test("crew add examples supply a model and draft help promises no full restoration", () => {
    const crew = lookupHelp(["crew"]).stdout;
    for (const line of crew.split("\n").filter(l => l.includes("tap crew add") && !l.includes("<preset|harness>"))) {
      expect(line).toMatch(/--model [^<\s]+|add astra /);
      expect(line).not.toContain("<");
    }
    expect(crew).toContain("add needs an explicit model");
    for (const page of ["config", "setup", "send"]) {
      const text = lookupHelp([page]).stdout;
      expect(text).not.toContain("line by line");
      expect(text).not.toMatch(/put (your|the )?(whole )?draft back|draft put back/);
    }
    for (const page of ["config", "setup", "send"]) {
      const text = lookupHelp([page]).stdout;
      for (const limit of ["`tap draft` recovers", "pasting it back is conditional", "OpenCode drafts always need that", "pasted content or images may not be captured"]) {
        expect(text.replace(/\s+/g, " ").toLowerCase()).toContain(limit.toLowerCase());
      }
    }
  });

  test("resume, restart, relaunch and repair are dedicated and their --help handlers serve the same page", async () => {
    const { cmdSessionDoor } = await import("../src/launcher/session-doors");
    const { cmdSessionRelaunch } = await import("../src/launcher/relaunch");
    const { cmdSessionRepair } = await import("../src/launcher/repair");
    const capture = async (run: () => number | Promise<number>) => {
      const original = process.stdout.write.bind(process.stdout);
      const log = console.log;
      let out = "";
      process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
      console.log = (...args: unknown[]) => { out += args.join(" ") + "\n"; };
      try { expect(await run()).toBe(0); } finally { process.stdout.write = original; console.log = log; }
      return out;
    };
    const handlers: Record<string, () => number | Promise<number>> = {
      resume: () => cmdSessionDoor("resume", ["--help"]),
      restart: () => cmdSessionDoor("restart", ["--help"]),
      relaunch: () => cmdSessionRelaunch(["--help"]),
      repair: () => cmdSessionRepair(["--help"]),
    };
    for (const [name, run] of Object.entries(handlers)) {
      const row = helpCatalogIndex().find((entry) => entry.key === `session ${name}`)!;
      expect(row.dedicated).toBe(true);
      const page = lookupHelp(["session", name]).stdout;
      expect(page).toContain(`NAME\n  tap session ${name} `);
      expect(page).toContain("EXAMPLES");
      expect(page).toContain(name === "relaunch"
        ? "Otherwise the top-level exit never carries a member's own status; read\n  results[] in"
        : "A failed child command can return its own status; read the diagnostic before");
      expect(await capture(run)).toBe(page);
      expect(helpArgv(["session", name, "--help"])).toEqual(lookupHelp(["session", name]));
    }
  });
});

describe("cj8w crew coverage", () => {
  test("native crew help names agy and --env", () => {
    const native = lookupHelp(["crew"]);
    expect(native.exit).toBe(0);
    expect(native.stdout).toContain("--env KEY=VALUE");
    expect(native.stdout).toContain("--preset");
    for (const family of AGENT_FAMILIES) {
      expect(native.stdout).toContain(family);
    }
  });
});

describe("i3kd ask renderer", () => {
  test("tap help ask renders through the native owner and its shared catalog", () => {
    const fromLeaf = spawnSync(process.execPath, [tapAsk, "--help"], { encoding: "utf8" });
    const fromHelp = spawnSync("bash", [tapBin, "help", "ask"], { encoding: "utf8" });
    expect(fromLeaf.status).toBe(0);
    expect(fromHelp.status).toBe(0);
    expect(fromHelp.stdout).toBe(fromLeaf.stdout);
    expect(ASK_HELP).toBe(fromLeaf.stdout);
    expect(lookupHelp(["ask"]).stdout).toBe(ASK_HELP);
    expect(ASK_HELP).toContain("HARNESSES");
    for (const family of AGENT_FAMILIES) {
      expect(ASK_HELP).toContain(family);
    }
  });

  test("ask has no composite, so a second word still refuses", () => {
    const result = lookupHelp(["ask", "foo"]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("no help topic 'ask foo'");
    expect(result.stderr).toContain("tap help ask");
  });
});

describe("refusals", () => {
  test("unknown verb names the token", () => {
    const result = lookupHelp(["notaverb"]);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("no help for 'notaverb'");
  });

  test("overview is empty topic, not a missing verb", () => {
    const result = lookupHelp([]);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("TAP Agent Protocol");
    expect(helpArgv(["help"])).toEqual(result);
    expect(helpArgv(["-h"])).toEqual(result);
  });
});

describe("the Bash door serves native pages", () => {
  test("public remind help exposes the command trigger and explicit child control", () => {
    const { env, dir } = isolatedHelpEnv();
    try {
      const result = bashHelp(["help", "remind"], env);
      expect(result.status).toBe(0);
      for (const spelling of ["--when-done", "--circle-back", "--fallback", "--to", "--unobservable-exit", "tap remind kill <id>"]) {
        expect(result.stdout).toContain(spelling);
      }
      expect(result.stdout).toContain("cancel stops watching only");
      expect(result.stdout).toContain("completion goes to both original target and fallback");
    } finally { removeScratchTree(dir); }
  });

  test("refusal stderr byte-matches Bash on unknown, extra-known, and extra-unknown", () => {
    const { env, dir } = isolatedHelpEnv();
    try {
      const unknown = bashHelp(["help", "notaverb"], env);
      expect(unknown.status).toBe(1);
      expect(lookupHelp(["notaverb"]).stderr).toBe(unknown.stderr);

      const extraKnown = bashHelp(["help", "team", "notasub"], env);
      expect(extraKnown.status).toBe(1);
      expect(lookupHelp(["team", "notasub"]).stderr).toBe(extraKnown.stderr);

      const extraUnknown = bashHelp(["help", "notaverb", "junk"], env);
      expect(extraUnknown.status).toBe(1);
      expect(lookupHelp(["notaverb", "junk"]).stderr).toBe(extraUnknown.stderr);
    } finally {
      removeScratchTree(dir);
    }
  });
});

describe("causal fixtures: dropped subcommand, wrong-scoped help, routing gap", () => {
  const fixture = (...parts: string[]) =>
    readFileSync(join(import.meta.dir, "fixtures", "help", ...parts), "utf8");

  test("JSON catalog index is frozen and agrees with lookupHelp text", () => {
    // Regenerate after an intended help change: TAP_UPDATE_FIXTURES=1 bash runtime/bun/test/run.sh runtime/bun/test/help.test.ts
    expectFrozenFixture(join(import.meta.dir, "fixtures", "help", "catalog-index.json"), JSON.stringify(helpCatalogIndex(), null, 2) + "\n");
    const frozen = fixture("catalog-index.json");

    const index = JSON.parse(frozen) as ReturnType<typeof helpCatalogIndex>;
    // 97 with the team history page and the teams roster page (the machine seat view alias).
    expect(index.filter((row) => row.dedicated)).toHaveLength(97);
    expect(index.filter((row) => row.tombstone)).toHaveLength(3);
    expect(index.filter((row) => !row.dedicated && !row.tombstone && row.topic.length >= 2)).toHaveLength(47);

    for (const row of index) {
      const live = lookupHelp(row.topic);
      expect(live.exit).toBe(row.exit);
      expect(live.key).toBe(row.key);
      if (row.tombstone) {
        expect(live.stdout).toBe("");
        expect(live.stderr).toBe(HELP_TOMBSTONES[row.key]!.stderr);
        continue;
      }
      expect(live.stderr).toBe("");
      if (!row.dedicated) {
        const parent = lookupHelp([row.page]);
        expect(parent.exit).toBe(0);
        expect(live.stdout).toBe(parent.stdout);
      } else {
        expect(live.stdout.length).toBeGreaterThan(0);
      }
    }
  });

  test("dropped subcommand stderr is frozen (not a silent parent page)", () => {
    const result = lookupHelp(["team", "notasub"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(fixture("dropped-subcommand.stderr.txt"));
    expect(result.stderr).toContain("no help topic 'team notasub'");
  });

  test("team refresh is dedicated, not seat-context refresh and not the parent team page", () => {
    const frozen = JSON.parse(fixture("wrong-scoped-team-refresh.json")) as {
      native: { key: string; exit: 0 | 1; dedicated: boolean };
      seat: { key: string; exit: 0 | 1 };
      parent: { key: string; exit: 0 | 1 };
      native_stdout_equals_seat: boolean;
      native_stdout_equals_parent: boolean;
    };
    const native = lookupHelp(["team", "refresh"]);
    const seat = lookupHelp(["refresh"]);
    const parent = lookupHelp(["team"]);
    expect({
      native: { key: native.key, exit: native.exit, dedicated: true },
      seat: { key: seat.key, exit: seat.exit },
      parent: { key: parent.key, exit: parent.exit },
      native_stdout_equals_seat: native.stdout === seat.stdout,
      native_stdout_equals_parent: native.stdout === parent.stdout,
    }).toEqual(frozen);
    expect(frozen.native_stdout_equals_seat).toBe(false);
    expect(frozen.native_stdout_equals_parent).toBe(false);
  });
});

test("team roster help describes count/cap and keeps exact telemetry available", () => {
  const page = lookupHelp(["team", "roster"]).stdout;
  expect(page).toContain("145k/380k");
  expect(page).toContain("cap defaults to 1M");
  expect(page).toContain("context_tokens");
  expect(page).not.toContain("Context is the harness-reported footer percentage");
});

test("the public goalie door routes to the native engine", () => {
  const dir = mkdtempSync(join(tmpdir(), "help-goalie-route."));
  const trace = join(dir, "trace");
  try {
    // The ROUTER door carries the trace: pre-cutover the verb falls back to the
    // Bash body ("bash goalie"), post-cutover the handler owns it.
    const r = spawnSync("bun", [mainTs, "goalie", "status"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, TAP_BUN_ROUTE_TRACE: trace },
    });
    expect(r.status).toBe(0);
    // Route OWNERSHIP, not behavior: the cutover moves the verb off the Bash body.
    expect(readFileSync(trace, "utf8")).toBe("native goalie\n");
    // The root scripts/tap.sh door reaches the same native owner through bin/tap.
    const viaShim = join(dir, "trace-shim");
    const shim = spawnSync("bash", [rootShim, "goalie", "status"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, TAP_BUN_ROUTE_TRACE: viaShim },
    });
    expect(shim.status).toBe(0);
    expect(readFileSync(viaShim, "utf8")).toBe("native goalie\n");
  } finally {
    removeScratchTree(dir);
  }
});

describe("team and admin family pages", () => {
  const children = ["roster", "calibration", "doctor", "attach", "detach", "down", "shutdown", "reset", "restore", "purge"];

  test("tap help team is a short family index that links each operation page", () => {
    const index = lookupHelp(["team"]);
    expect(index.exit).toBe(0);
    expect(index.stdout.split("\n").length).toBeLessThan(60);
    for (const child of [...children.filter(c => c !== "roster"), "up", "out", "refresh"]) {
      expect(index.stdout).toContain(`  ${child} `);
    }
    expect(index.stdout).toContain("tap team [--json | --names | --all | --wide] [--online | --offline]");
    expect(index.stdout).toContain("tap help team <operation>");
  });

  test.each(children)("team %s is a dedicated page, reachable from its help spellings", child => {
    const page = lookupHelp(["team", child]);
    expect(page.exit).toBe(0);
    expect(page.key).toBe(`team ${child}`);
    expect(page.stdout).toContain(`tap team ${child}`);
    expect(page.stdout).not.toBe(lookupHelp(["team"]).stdout);
    expect(helpArgv(["help", "team", child])).toEqual(page);
    expect(helpCatalogIndex().find(row => row.topic.join(" ") === `team ${child}`)?.dedicated).toBe(true);
  });

  test.each(["down", "shutdown"])("team %s states --yes per path and --force as a no-op", verb => {
    const flat = lookupHelp(["team", verb]).stdout.replace(/\s+/g, " ");
    expect(flat).toContain("Picker path: confirms the preview without asking [Y/n]");
    expect(flat).toContain("Exact path: accepted and ignored");
    expect(flat).toContain("--force Accepted and ignored on both paths; a compatibility no-op");
    // The retired blanket claim, which was false on the picker path.
    expect(flat).not.toContain("--yes/--force are compatibility no-ops");
  });

  test("attach and detach carry the same --yes distinction without calling it a no-op everywhere", () => {
    for (const verb of ["attach", "detach"]) {
      const flat = lookupHelp(["team", verb]).stdout.replace(/\s+/g, " ");
      expect(flat).toContain("--yes is accepted and ignored");
      expect(flat).toContain("--yes answers that question");
    }
  });

  test("team reset explains caller inclusion and the replacement for checkpoints", () => {
    const page = lookupHelp(["team", "reset"]).stdout;
    expect(page).toContain("INCLUDING YOUR OWN SEAT");
    expect(page).toContain("--except <your-handle>");
    expect(page).toContain("tap team out --hard");
    for (const verb of ["restore", "purge"]) {
      const tombstone = lookupHelp(["team", verb]).stdout;
      expect(tombstone).toContain("removed checkpoint operation");
      expect(tombstone).toContain("error_class=renamed_verb");
    }
  });

  test("admin is a per-operation index that labels tombstones and keeps admin ps", () => {
    const page = lookupHelp(["admin"]);
    expect(page.exit).toBe(0);
    for (const op of ["dashboard", "dashboard --fast", "ps", "refresh", "retire <team>", "rebuild-registry"]) {
      expect(page.stdout).toContain(`  ${op} `);
    }
    expect(page.stdout).toContain("TOMBSTONES");
    expect(page.stdout).toContain("migrate-registry    Removed.");
    expect(page.stdout).toContain("prune               Renamed.");
    expect(page.stdout).toContain("tap help admin ps");
    expect(lookupHelp(["admin", "ps"]).exit).toBe(0);
  });
});

test("admin ps has a dedicated process-scope help page", () => {
  const page = lookupHelp(["admin", "ps"]);
  expect(page.exit).toBe(0);
  expect(page.stdout).toContain("tap admin ps [--json]");
  expect(page.stdout).toContain("not its\n  descendants");
});

test("admin ps trailing help routes to its dedicated page", () => {
  for (const spelling of ["--help", "-h", "help"]) {
    expect(isHelpForm(["admin", "ps", spelling])).toBe(true);
    expect(helpArgv(["admin", "ps", spelling])).toEqual(lookupHelp(["admin", "ps"]));
  }
  expect(isHelpForm(["admin", "ps", "--help", "extra"])).toBe(false);
});


describe("launch help is a public no-effect operation", () => {
  test.each([false, true])("launch syntax refuses before onboarding or lifecycle effects (enrolled=%s)", enrolled => {
    const { env, dir } = isolatedHelpEnv();
    env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    try {
      const cwd = join(dir, "project"), bin = join(dir, "bin");
      mkdirSync(cwd); mkdirSync(bin);
      env.TAP_HOME = "";
      env.XDG_CONFIG_HOME = join(dir, "missing-config");
      env.PATH = `${bin}:${env.PATH}`;
      const calls = join(dir, "unexpected-call");
      for (const command of ["claude", "codex", "tmux", "ps", "git"]) {
        writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${calls}'\nexit 99\n`, { mode: 0o755 });
      }
      if (enrolled) {
        mkdirSync(join(cwd, ".tap"));
        const registry = join(cwd, ".tap/team-registry.json");
        writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", root: cwd }, seats: {} }));
        writeFileSync(join(dir, "index/global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root: cwd, registry_location: registry } } }));
      }
      const snapshot = () => readdirSync(dir, { recursive: true, withFileTypes: true }).map(entry => {
        const path = join(entry.parentPath, entry.name);
        return [path, entry.isFile() ? readFileSync(path).toString("base64") : "directory"];
      }).sort((a, b) => a[0]!.localeCompare(b[0]!));
      const before = snapshot();
      for (const prefix of [["launch"], ["session", "launch"]]) for (const mode of ["human", "flag", "inherited"]) {
        for (const [args, detail] of [
          [["codex", "--model"], "--model requires a value"],
          [["codex", "--model", "--dry-run", "--help"], "--model requires a value"],
          [["codex", "--model", "--help", "--unknown"], "--model requires a value"],
          [["codex", "reviewer", "private\r\n\x1b[31mextra"], "unexpected positional argument; use -- before bare harness arguments"],
        ] as const) {
          const result = spawnSync(tapBin, [...prefix, ...(mode === "flag" ? ["--json"] : []), ...args], {
            cwd, env: { ...env, TAP_JSON: mode === "inherited" ? "1" : "0" }, encoding: "utf8", timeout: 20000,
          });
          expect(result.status, result.stdout + result.stderr).toBe(2);
          if (mode === "human") {
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe(`tap launch: ${detail}; next: tap launch --help\n`);
          } else {
            expect(result.stderr).toBe("");
            expect(JSON.parse(result.stdout)).toEqual({ ok: false, error_class: "launch_arg_invalid", action: "tap launch --help", detail });
          }
          expect(snapshot()).toEqual(before);
        }
      }
    } finally { removeScratchTree(dir); }
  }, 60000);

  test("trailing flags on both spellings bypass config, onboarding, probes and recording", () => {
    const { env, dir } = isolatedHelpEnv();
    try {
      const cwd = join(dir, "project"), bin = join(dir, "bin");
      mkdirSync(cwd); mkdirSync(bin);
      env.TAP_HOME = "";
      env.XDG_CONFIG_HOME = join(dir, "missing-config");
      env.PATH = `${bin}:${env.PATH}`;
      const calls = join(dir, "unexpected-call");
      for (const command of ["claude", "codex", "tmux", "ps", "git"]) {
        writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\n' '${command}' >> '${calls}'\nexit 99\n`, { mode: 0o755 });
      }
      mkdirSync(join(dir, "index/debug"));
      const recording = join(dir, "debug-run"); mkdirSync(recording);
      writeFileSync(join(dir, "index/debug/enabled.json"), JSON.stringify({ id: "help-test", directory: recording }));
      const snapshot = () => readdirSync(dir, { recursive: true, withFileTypes: true })
        .map(entry => {
          const path = join(entry.parentPath, entry.name);
          return [path, entry.isFile() ? readFileSync(path).toString("base64") : "directory"];
        }).sort((a, b) => a[0]!.localeCompare(b[0]!));
      const before = snapshot();
      for (const prefix of [["launch"], ["session", "launch"]]) {
        for (const flag of ["-h", "--help"]) {
          for (const rest of [[], ["codex"], ["codex", "reviewer"], ["codex", "--model", "available", "--effort", "high"]]) {
            const child = spawnSync(tapBin, [...prefix, ...rest, flag], { cwd, env, encoding: "utf8", timeout: 20_000 });
            expect({ status: child.status, out: child.stdout, err: child.stderr })
              .toEqual({ status: 0, out: lookupHelp(["launch"]).stdout, err: "" });
            expect(readdirSync(cwd)).toEqual([]);
            expect(snapshot()).toEqual(before);
          }
        }
      }
      // An explicit harness delimiter preserves intent: these are NOT TAP help.
      for (const prefix of [["launch"], ["session", "launch"]]) {
        const forwarded = spawnSync(tapBin, [...prefix, "codex", "--", "--help"], { cwd, env: { ...env, TAP_INDEX_HOME: join(dir, "other-index") }, encoding: "utf8", timeout: 20_000 });
        expect(forwarded.status).not.toBe(0);
        expect(forwarded.stdout).not.toContain("tap launch —");
        expect(forwarded.stderr).toContain("git exited 99");
        expect(readFileSync(calls, "utf8")).toContain("git");
      }
    } finally { removeScratchTree(dir); }
  }, 60_000);

  test("help respects value operands, literal names and harness argument ownership", () => {
    for (const prefix of [["launch"], ["session", "launch"]]) {
      for (const args of [["codex", "--", "--help"], ["codex", "--model", "--help"],
        ["codex", "--model", "--", "--help"], ["codex", "--model", "--dry-run", "--help"],
        ["codex", "--model=--help"], ["codex", "--env", "MESSAGE=--help"],
        ["codex", "help"], ["codex", "--unknown", "--help"]]) {
        expect(isHelpForm([...prefix, ...args]), args.join(" ")).toBe(false);
      }
      expect(isHelpForm([...prefix, "codex", "--model=available", "--help"])).toBe(true);
      expect(helpArgv([...prefix, "codex", "reviewer", "-h"]).stdout).toBe(lookupHelp(["launch"]).stdout);
    }
    expect(isHelpForm(["send", "peer", "-m", "--help"])).toBe(false);
  });

  test("overview is short and launch aliases share a sectioned useful page", () => {
    const overview = lookupHelp([]).stdout;
    expect(overview.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
    expect(overview.indexOf("tap launch")).toBeLessThan(overview.indexOf("tap send"));
    expect(overview).toContain("tap attach"); expect(overview).toContain("tap team");
    expect(overview).toContain("QUICK-REFERENCE.md");
    const launch = lookupHelp(["launch"]).stdout;
    expect(lookupHelp(["session", "launch"]).stdout).toBe(launch);
    for (const section of ["NAME", "USAGE", "DESCRIPTION", "OPTIONS", "EXAMPLES", "EXIT CODES", "SEE ALSO"]) expect(launch).toContain(section + "\n");
    expect(launch).toContain("tap launch codex reviewer");
    expect(launch).toContain("--model <available-model> --effort high");
    expect(launch).toContain("127  command not found during execution");
    expect(launch).toContain("130/143  interrupted by SIGINT/SIGTERM");
  });
});

describe("watch help documents status's branchable exit (tap-zpmvx)", () => {
  test("`tap help watch` says status exits 0 for a dead dispatcher and leaves the check to tap health", () => {
    const page = lookupHelp(["watch"]).stdout;
    expect(page).toContain("status  Prints the lease, or \"disarmed\", and the dispatcher's liveness. Exit 0 when it reports: disarmed, alive, or dead");
    expect(page).toContain("tap health is the check that exits 2 for a dead dispatcher");
    // The spelling `tap watch status` shares the page; there is no second copy to drift.
    expect(lookupHelp(["watch", "status"]).stdout).toBe(page);
  });
});

describe("resend help documents the same-id retry", () => {
  const page = lookupHelp(["resend"]).stdout;
  test("names the same-id contract and the recovery ladder", () => {
    expect(page).toContain("tap resend — ring an unconfirmed send again, under the same id");
    expect(page).toContain("It\n  keeps the id, the body and the one obligation; nothing is withdrawn and no new id is\n  minted.");
    expect(page).toContain("    not confirmed, and still unread          tap resend <id>\n");
    expect(page).toContain("  Only resend rings again, under the same id; a repeat is safe to read.\n");
  });
  test("names the exits: 0 for queued or nothing to ring, 1 for each refusal", () => {
    expect(page).toContain("EXIT CODES");
    expect(page).toContain("0   queued, or nothing to ring (already read, settled, cancelled, or already queued)");
    for (const refusal of ["usage_error", "not_found", "not_sender", "invalid_payload", "recipient_unbound", "obligation_busy"]) {
      expect(page).toContain(refusal);
    }
    expect(page).not.toMatch(/^  5 /m);
  });
  test("no longer documents a successor, its failure classes or the no-attempt guard", () => {
    for (const retired of ["FAILED SUCCESSOR", "resend_successor_failed", "resend_receipt_invalid", "resend_of", "successor", "proven never attempted", "None of them re-delivers"]) {
      expect(page).not.toContain(retired);
    }
  });
});

test("cancel and withdraw share the resend recovery ladder", () => {
  for (const verb of ["cancel", "withdraw"]) {
    const page = lookupHelp([verb]).stdout;
    expect(page).toContain("    not confirmed, and still unread          tap resend <id>\n");
    expect(page).toContain("  Only resend rings again, under the same id; a repeat is safe to read.\n");
    expect(page).not.toContain("proven never attempted");
  }
});

test("unwedge help keeps report, explicit rungs, exact predecessor and uncertainty visible", () => {
  const page = lookupHelp(["unwedge"]);
  expect(page.exit).toBe(0);
  for (const text of ["--rung message", "--rung nudge", "--rung continue", "--rung restart", "--after <recovery-id>", "two minutes", "no automatic", "exact native", "5 possible", "custody", "--json"]) expect(page.stdout).toContain(text);
});

test("seat filters and the renamed flags are documented on every seat list's page", () => {
  for (const page of [["team", "roster"], ["teams"]]) {
    const text = lookupHelp(page).stdout;
    for (const flag of ["--harness <list>", "--model <list>", "--state <list>", "active is every live"]) expect([page.join(" "), text.includes(flag)]).toEqual([page.join(" "), true]);
  }
  for (const page of [["team"], ["admin", "ps"], ["team", "calibration"], ["crew"]]) {
    expect([page.join(" "), lookupHelp(page).stdout.includes("--state <list>")]).toEqual([page.join(" "), true]);
  }
  const roster = lookupHelp(["team", "roster"]).stdout;
  expect(roster).toContain("--online    Only lifecycle-active seats");
  expect(roster).toContain("--active    Old spelling of --online");
  expect(roster).toContain("Seat filters narrow first");
  expect(lookupHelp(["teams", "roster"]).stdout).toContain("tap teams roster — every team's seats");
  expect(lookupHelp(["session", "list"]).stdout).toContain("--state            refused");
});
