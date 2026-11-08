import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-caller-")));
afterAll(() => removeScratchTree(root));
function run(mode: string) {
  const p = spawnSync(process.execPath, [join(import.meta.dir, "support/opencode-caller-fixture.ts"), join(root, mode), mode], { encoding: "utf8", timeout: 10000 });
  expect(p.status).toBe(0);
  const lines = p.stdout.trim().split("\n");
  return { result: JSON.parse(lines.at(-1)!), stdout: p.stdout, stderr: p.stderr };
}
test("shared inherited actor must match; ordinary inherited actor behavior remains", () => {
  expect(run("mismatch").result.error).toBe("shared_actor_mismatch");
  expect(run("match").result.actor).toBe("alpha");
  expect(run("normal").result.actor).toBe("wrong");
});
test("explicit --from bypasses inherited TAP_SELF and sends as the declared actor", () => {
  const r = run("declared"); expect(r.result).toMatchObject({ code: 0 }); expect(r.stdout).toContain('"from":"declared"');
});
test("shared registration refuses before changing the registry", () => {
  const r = run("register"); expect(r.result).toMatchObject({ error: "shared_registration", unchanged: true });
  expect(r.result.message).toContain("launcher owns their session binding");
});
test("physical walk cannot borrow the service's inherited controlling tty", () => {
  const r = run("boundary"); expect(r.result.observation.state).toBe("unobservable"); expect(r.result.paneProbes).toBe(0);
});
test("callingPane projects verified shared identity claims and rejects a successor instance", () => {
  expect(run("projection").result).toEqual({
    pane: { status: "ok", paneId: "%1", session: "t/alpha", serverEpoch: "srv:100:200",
      selectedHandle: "alpha", selectedInstance: "alpha|one", selectedSocket: join(root, "projection/socket"), selectedPane: "t/alpha:0.0" },
    refusal: "unregistered",
  });
  expect(run("projection-refused").result.pane).toBeNull();
});
test("native child context selects its root seat despite a foreign enrolled cwd and bus pin", () => {
  const r = run("child-context"); expect(r.result).toEqual({ team: "t", root: join(root, "child-context/team"),
    pin: join(root, "child-context/team/.tap/bus"), socket: join(root, "child-context/socket") });
});
test("shared crew shutdown infers its owner from the verified selected socket", () => {
  expect(run("crew-owner").result).toMatchObject({ code: 0, unchanged: true, mutations: 0 });
});
for (const door of ["down", "out-kill", "out-hard", "team-down", "team-shutdown", "team-reset", "team-out"]) {
  test(`shared self-including ${door} refuses before any registry or pane mutation`, () => {
    const r = run(`self-${door}`);
    expect(r.result).toMatchObject({ code: 1, unchanged: true, mutations: 0 });
    expect(r.stdout).toContain('"error_class":"opencode_shared_self_stop"');
  });
}


test("shared child reporting never substitutes a foreign cwd team for its root seat", () => {
  expect(run("child-reporting").result).toEqual({reporting:null,fresh:"t",explicit:"other"});
});
