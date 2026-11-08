import { expect, test } from "bun:test";
import { reportingFixture } from "./support/reporting-fixture";

test("implicit reporting discovers the caller once and keeps pane precedence", () => {
  const f = reportingFixture();
  try {
    for (const [args, limit] of [
      [["whoami", "--json"], 5],
      [["outstanding", "self", "--json"], 7],
      [["show", f.id], 4],
    ] as const) {
      const r = f.run([...args]);
      expect(r.code, r.stderr).toBe(0);
      if (args[0] === "whoami") expect(JSON.parse(r.stdout)).toMatchObject({ handle: "self", team: "reporting", pane_id: f.pane });
      if (args[0] === "outstanding") expect(JSON.parse(r.stdout).outstanding).toHaveLength(1);
      if (args[0] === "show") expect(r.stdout).toContain("reporting fixture body");
      expect(r.calls.length, JSON.stringify({ args, calls: r.calls })).toBeLessThanOrEqual(limit);
      expect(r.calls.filter(row => row[0] === "ps").length).toBe(1);
      expect(r.calls.filter(row => row[0] === "tmux").length).toBe(1);
    }
    // A different enrolled cwd in the same repository must not steal the pane's team.
    const other = f.otherWorktree();
    expect(JSON.parse(f.run(["whoami", "--json"], undefined, other).stdout)).toMatchObject({ handle: "self", team: "reporting" });
  } finally { f.close(); }
}, 60_000);

test("outstanding shares its caller observation with the overdue-inbound advisory", () => {
  const f = reportingFixture();
  try {
    f.inbound();
    for (const actor of [[], ["self"], ["peer"]]) {
      const r = f.run(["outstanding", ...actor, "--json"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stderr).toBe("tap: warning: self has 1 unsettled inbound aged >=3600s (oldest 36000s); run 'tap poll self'\n");
      expect(r.calls.filter(row => row[0] === "tmux").length).toBe(1);
      expect(r.calls.filter(row => row[0] === "ps").length).toBe(1);
    }
  } finally { f.close(); }
}, 60_000);
