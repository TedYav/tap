import { buildHarnessInvocation } from "../src/launcher/adapters";
import { relaunchIdentity, refuseOnIdentityDrift } from "../src/launcher/replace";
import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { validateLaunchWorkdir } from "../src/launcher/workdir";
import { lookupHelp } from "../src/help";
import { parseNew } from "../src/launcher/new";
import { recordFromRow, storeRecipe, durableRecord } from "../src/launcher/transaction";
import { removeScratchTree } from "./support/scratch";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeScratchTree(root); });
test("workdir is a TAP option, including equals syntax; intentional harness tail remains opaque", () => {
  expect(lookupHelp(["launch"]).stdout).toContain("--workdir <path>");
  expect(parseNew(["codex", "alice", "--workdir", "/lane"]).workdir).toBe("/lane");
  expect(parseNew(["codex", "alice", "--workdir=/lane"]).harness_passthrough).toEqual([]);
  expect(parseNew(["codex", "alice", "--", "--workdir", "/native"]).harness_passthrough).toEqual(["--workdir", "/native"]);
});
test("workdir validates real repository membership and recipe round-trips without moving the team anchor", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "launch-workdir-"))); roots.push(root);
  const team = join(root, "team"), lane = join(root, "lane with spaces"), other = join(root, "other");
  mkdirSync(team); mkdirSync(other);
  const git = (...args: string[]) => { const r = spawnSync("git", ["-C", team, ...args], {encoding:"utf8"}); expect(r.status, r.stderr).toBe(0); };
  git("init", "-q"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  git("worktree", "add", "--detach", lane, "HEAD");
  symlinkSync(lane, join(root, "alias"));
  expect(validateLaunchWorkdir(team, "alias", root)).toBe(lane);
  expect(validateLaunchWorkdir(team, relative(root, lane), root)).toBe(lane);
  for (const invalid of ["", other, join(root,"missing"), join(team,".git")]) expect(() => validateLaunchWorkdir(team, invalid)).toThrow("invalid_workdir");
  const row = { session: "Team/alice", harness: "codex", registered_from_worktree: team, launch_workdir: lane };
  const record = recordFromRow("alice", row, {name:"Team"}, team)!;
  expect(record.cwd).toBe(team); expect(record.launch_workdir).toBe(lane);
  const stored: Record<string, unknown> = {}; storeRecipe(stored, record);
  expect(stored.launch_workdir).toBe(lane); expect(durableRecord(record).launch_workdir).toBe(lane);
  git("worktree", "remove", lane);
  expect(() => validateLaunchWorkdir(team, record.launch_workdir!)).toThrow("invalid_workdir");
});

test("Cursor workspace uses the recorded launch workdir and relaunch rejects a changed workdir", () => {
  const record = {name:"Team/alice",harness:"cursor",base:"Team",cwd:"/team",launch_workdir:"/lane"};
  const invocation = buildHarnessInvocation("new",record,null,null);
  expect(invocation.argv[invocation.argv.indexOf("--workspace")+1]).toBe("/lane");
  const row = {harness:"cursor",pane_id:"%7",harness_session_id:"conversation",launch_workdir:"/lane"};
  expect(() => refuseOnIdentityDrift("Team/alice",relaunchIdentity(row),{...row,launch_workdir:"/other"})).toThrow("launch_workdir");
});
