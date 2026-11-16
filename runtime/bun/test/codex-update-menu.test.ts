import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectAgentState } from "../src/agent-state";
import { codexUpdateNotice, codexUpdatePrompt, launchedCodexHome } from "../src/codex-update";
import { withCodexUpdateCheckOff } from "../src/launcher/adapters";
import { Notices } from "../src/launcher/catalog-notices";
import { launchInvocation } from "../src/launcher/invocation";
import type { SessionRecord } from "../src/launcher/types";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", "agent-state", "codex", name), "utf8");

// A 200x60 capture (`capture-pane -p -J`, plain and `-e`) of the menu as Codex
// 0.166.0 paints it: hyperlink escapes inside the release-notes and install
// rows, a full-width selected row, and blank padding left by the welcome art.
describe("Codex update menu at 200 columns with hyperlinks", () => {
  for (const name of ["update-available-wide.txt", "update-available-wide.ansi"]) {
    test(`${name} is recognized with both versions`, () => {
      const frame = fixture(name);
      expect(detectAgentState("codex", frame)).toEqual({ agentState: "blocked", reason: "codex-update-available" });
      expect(codexUpdatePrompt(frame)).toEqual({ current: "0.166.0", available: "0.167.0" });
    });
  }

  test("a menu painted only part way down is never an idle composer", () => {
    const rows = fixture("update-available-wide.ansi").split("\n");
    for (let shown = 1; shown <= rows.length; shown++) {
      expect(detectAgentState("codex", rows.slice(0, shown).join("\n"), "tap").agentState).not.toBe("idle");
    }
  });
});

describe("Codex seats start with the startup update check off", () => {
  test("the override rides beside --no-daemon, ahead of any subcommand, or leads when that flag is absent", () => {
    expect(withCodexUpdateCheckOff("codex", ["codex", "--config", "a=b", "--no-daemon", "--approve-for-me", "resume", "abc"]))
      .toEqual(["codex", "--config", "a=b", "--no-daemon", "-c", "check_for_update_on_startup=false", "--approve-for-me", "resume", "abc"]);
    expect(withCodexUpdateCheckOff("codex", ["codex", "--remote", "host:1", "--", "--no-daemon"]))
      .toEqual(["codex", "-c", "check_for_update_on_startup=false", "--remote", "host:1", "--", "--no-daemon"]);
  });

  test("a key the user already set, in any -c spelling, is kept as written", () => {
    for (const set of [["-c", "check_for_update_on_startup=true"], ["--config=check_for_update_on_startup=true"], ["-ccheck_for_update_on_startup=false"]]) {
      const argv = ["codex", "--no-daemon", ...set];
      expect(withCodexUpdateCheckOff("codex", argv)).toEqual(argv);
    }
  });

  test("every composed Codex launch carries it once: fresh, resumed, and with a tail that sets the key", () => {
    const dir = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "codex-policy-"));
    mkdirSync(join(dir, "tap"));
    writeFileSync(join(dir, "tap", "config.toml"), "version=3\n", { mode: 0o600 });
    const env = { HOME: "/nonexistent", XDG_CONFIG_HOME: dir };
    const id = "01a0f7d8-6ccd-7580-90ff-62526bca1870";
    const compose = (action: string, extra: Partial<SessionRecord> = {}): string[] =>
      launchInvocation(action, { name: "seat", harness: "codex", cwd: dir, base: "team", model: null, ...extra },
        new Notices(() => {}), { env, resume: action === "resume" ? id : null, notify: false }).argv;
    const off = (argv: string[]) => argv.filter(token => token === "check_for_update_on_startup=false").length;
    const fresh = compose("new"), resumed = compose("resume", { harness_session_id: id });
    expect(fresh.slice(0, 4)).toEqual(["codex", "--no-daemon", "-c", "check_for_update_on_startup=false"]);
    expect([off(fresh), off(resumed)]).toEqual([1, 1]);
    expect(resumed.indexOf("check_for_update_on_startup=false")).toBeLessThan(resumed.indexOf("resume"));
    const kept = compose("new", { harness_tail: ["-c", "check_for_update_on_startup=true"] });
    expect(off(kept)).toBe(0);
    expect(kept.slice(-2)).toEqual(["-c", "check_for_update_on_startup=true"]);
  });

  test("other harnesses are untouched", () => {
    expect(withCodexUpdateCheckOff("claude", ["claude", "--resume"])).toEqual(["claude", "--resume"]);
  });
});

describe("the notice reads the Codex home the launched seat uses", () => {
  const policy = (body: string): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "codex-home-policy-"));
    mkdirSync(join(dir, "tap"));
    writeFileSync(join(dir, "tap", "config.toml"), `version=3\n${body}`, { mode: 0o600 });
    return { HOME: "/ambient/user-root", XDG_CONFIG_HOME: dir, CODEX_HOME: "/ambient/codex" };
  };
  const composed = (env: NodeJS.ProcessEnv, extra: Partial<SessionRecord> = {}) =>
    launchInvocation("new", { name: "seat", harness: "codex", cwd: "/", base: "team", model: null, ...extra }, new Notices(() => {}), { env, notify: false });

  test("a home set by machine policy wins over the launcher's own", () => {
    const env = policy('[harness.codex.env]\nCODEX_HOME = "/policy/codex"\n');
    expect(launchedCodexHome(composed(env), env)).toBe("/policy/codex");
  });

  test("a home set for the seat wins over the launcher's own", () => {
    const env = policy("");
    expect(launchedCodexHome(composed(env, { harness_env: { CODEX_HOME: "/seat/codex" } }), env)).toBe("/seat/codex");
  });

  test("an inherited home the launch unsets falls back to the default under the child's HOME", () => {
    const env = policy("");
    expect(launchedCodexHome(composed(env), env)).toBe("/ambient/codex");
    expect(launchedCodexHome(composed(env, { harness_unset_env: ["CODEX_HOME"] }), env)).toBe("/ambient/user-root/.codex");
  });
});

describe("launch notice from Codex's own version cache", () => {
  const banner = "\x1b[38;2;99;168;248m>_ \x1b[1mOpenAI Codex\x1b[0;2m (v0.166.0)\x1b[0m\n› \x1b[2mAsk Codex to do anything\x1b[0m\n";
  const home = (cache: unknown): string => {
    const dir = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "codex-home-"));
    if (cache !== undefined) writeFileSync(join(dir, "version.json"), typeof cache === "string" ? cache : JSON.stringify(cache));
    return dir;
  };

  test("names both versions when the cached release is newer than the running one", () => {
    expect(codexUpdateNotice(banner, home({ latest_version: "0.167.0", dismissed_version: "0.164.0" })))
      .toBe("Codex 0.167.0 is available (this seat runs 0.166.0); update Codex when convenient");
    expect(codexUpdateNotice(banner, home({ latest_version: "0.166.0.1" }))).toContain("Codex 0.166.0.1 is available");
    expect(codexUpdateNotice(banner, home({ latest_version: "0.1000.0" }))).toContain("Codex 0.1000.0 is available");
  });

  test("is silent when nothing newer is known or the user skipped that release", () => {
    for (const cache of [
      { latest_version: "0.166.0" }, { latest_version: "0.165.9" }, { latest_version: "0.99.0" },
      { latest_version: "0.167.0", dismissed_version: "0.167.0" },
      { latest_version: "0.167.0-beta.1" }, { latest_version: 167 }, {}, "not json", undefined,
    ]) expect(codexUpdateNotice(banner, home(cache))).toBeNull();
  });

  test("is silent when the pane does not show which version is running", () => {
    const cached = home({ latest_version: "0.167.0" });
    expect(codexUpdateNotice(null, cached)).toBeNull();
    expect(codexUpdateNotice("› \x1b[2mAsk Codex to do anything\x1b[0m\n", cached)).toBeNull();
  });
});
