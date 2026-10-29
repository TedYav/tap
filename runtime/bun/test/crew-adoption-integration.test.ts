import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crewFixture as fixture } from "./support/crew-fixture";

test.each([false, true])("public ask -> crew add --resume -> exact registration (mismatched hook=%s)", async mismatched => {
  const f = fixture();
  try {
    const before = readFileSync(f.registry, "utf8");
    const ask = f.run(["ask", "claude", "--model", "fixture", "-m", "question"]);
    expect(ask.status, ask.stderr).toBe(0); expect(ask.stdout).toBe("fixture answer\n");
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    const id = /claude session ([^;]+);/.exec(ask.stderr)?.[1]; expect(id).toBeTruthy();
    const add = f.run(["crew", "add", "claude", "continued", "--model", "fixture", "--resume", id!, "--cwd", f.cwd,
      ...(mismatched ? ["--env", "ADOPT_WRONG_ID=wrong-native-id"] : [])]);
    expect(add.status, add.stdout + add.stderr).toBe(0);
    const until = Date.now() + 10000;
    while (!existsSync(join(f.root, "hook-continued")) && Date.now() < until) await Bun.sleep(50);
    const hook = JSON.parse(readFileSync(join(f.root, "hook-continued"), "utf8")) as {
      before: { identity_capture?: unknown }; result: { status: number | null; out: string; err: string };
    };
    expect(hook.before.identity_capture).toEqual({ mode: "exact_resume", expected_harness_session_id: id });
    expect(hook.result.status, hook.result.out + hook.result.err).toBe(0);
    expect(f.seats().continued).toMatchObject({ harness_session_id: id, crew_owner: "parent", crew_owner_instance: "parent-one",
      crew_identity_capture: { decision: mismatched ? "quarantined" : "accepted", observed_harness_session_id: mismatched ? "wrong-native-id" : id } });
    if (mismatched) expect(f.seats().continued.identity_capture).toEqual({ mode: "exact_resume", expected_harness_session_id: id });
    expect(f.seats().parent).toEqual(JSON.parse(before).seats.parent);
    const panes = f.read("list-panes", "-a", "-F", "#{pane_id}");
    f.env.TAP_JSON = "1";
    const duplicate = f.run(["crew", "add", "claude", "duplicate", "--model", "fixture", "--resume", id!]);
    expect(duplicate.status).not.toBe(0);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({ error_class: "duplicate_identity_owner" });
    expect(f.seats().duplicate).toBeUndefined();
    expect(f.read("list-panes", "-a", "-F", "#{pane_id}")).toBe(panes);
    for (const flags of [["--resume="], ["--resume", id!, "--resume", id!], ["--resume", "--latest"]]) {
      const refused = f.run(["crew", "add", "claude", "invalid", "--model", "fixture", ...flags]);
      expect(refused.status).toBe(1); expect(JSON.parse(refused.stdout)).toMatchObject({ error_class: "usage_error" });
      expect(f.seats().invalid).toBeUndefined();
    }
  } catch (error) {
    console.error("crew adoption operation failed before fixture cleanup:", error);
    throw error;
  } finally { await f.close(); }
}, 45000);

test.each([false, true])("fresh relaunch accepts a new conversation after adoption (quarantined=%s)", async quarantined => {
  const f = fixture();
  try {
    const ask = f.run(["ask", "claude", "--model", "fixture", "-m", "question"]);
    expect(ask.status, ask.stderr).toBe(0);
    const id = /claude session ([^;]+);/.exec(ask.stderr)?.[1]; expect(id).toBeTruthy();
    const add = f.run(["crew", "add", "claude", "continued", "--model", "fixture", "--resume", id!,
      ...(quarantined ? ["--env", "ADOPT_WRONG_ID=wrong-native-id"] : [])]);
    expect(add.status, add.stdout + add.stderr).toBe(0);
    expect(f.seats().continued.crew_identity_capture.decision).toBe(quarantined ? "quarantined" : "accepted");
    const relaunched = f.run(["crew", "relaunch", "continued"]);
    expect(relaunched.status, relaunched.stdout + relaunched.stderr).toBe(0);
    // The fake harness runs its SessionStart hook after relaunch returns; wait for the new capture verdict.
    const until = Date.now() + 15000;
    while (f.seats().continued.crew_identity_capture === undefined && Date.now() < until) await Bun.sleep(50);
    const row = f.seats().continued;
    expect(row.crew_identity_capture.decision).toBe("accepted");
    expect(row.harness_session_id).toBeTruthy();
    expect(row.harness_session_id).not.toBe(id);
    expect(row.identity_quarantine_reason).toBeUndefined();
    expect(row.quarantined_harness_session_id).toBeUndefined();
  } finally { await f.close(); }
}, 45000);
