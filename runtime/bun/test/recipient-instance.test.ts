import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/bus";
import { TapError, type Context } from "../src/context";
import { assertRecipientAuthority } from "../src/verbs/done";
import { removeScratchTree } from "./support/scratch";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) removeScratchTree(path); });
function context(seats: Record<string, unknown>): Context {
  const root = mkdtempSync(join(tmpdir(), "tap-recipient-instance.")); scratch.push(root);
  const registryPath = join(root, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ schema: "0.20", seats }));
  mkdirSync(join(root, "bus"));
  return { root, registryPath, team: "selected", bus: new Bus(join(root, "bus")), busRule: "env" };
}
const raw = "---\nid: leader-20260907T000000Z-123456789abc\nfrom: leader\nto: driver\nrecipient_instance: driver|launch\n---\nwork\n";
function refusal(ctx: Context): TapError {
  try { assertRecipientAuthority(ctx, "ask", raw, "driver", "reply"); }
  catch (e) { if (e instanceof TapError) return e; throw e; }
  throw new Error("unexpectedly authorized");
}
test("missing selected-team actor names team recovery, never sender cancellation", () => {
  const e = refusal(context({}));
  expect(e.errorClass).toBe("instance_unresolved");
  expect(e.detail).toContain("selected team 'selected'");
  expect(e.action).toContain("--team <registered-team>");
  expect(e.action).not.toContain("cancel");
});
test("real replacement retains its exact refusal and cancellation guidance", () => {
  const e = refusal(context({ driver: { instance: "driver|replacement", pane_id: "%2" } }));
  expect(e.errorClass).toBe("not_addressee");
  expect(e.detail).toBe("'ask' is bound to recipient instance 'driver|launch', not the current 'driver' instance — a fresh seat at this handle cannot settle predecessor-bound mail");
  expect(e.action).toBe("the sender clears this: tap cancel ask --by leader");
});
test("unchanged instance remains authorized; unbound present row remains refused", () => {
  expect(assertRecipientAuthority(context({ driver: { instance: "driver|launch", pane_id: "%1" } }), "ask", raw, "driver", "reply")).toBe("");
  expect(refusal(context({ driver: { pane_id: "%1" } })).errorClass).toBe("instance_unresolved");
});
test("exact predecessor grant remains eligible even when successor instance is empty", () => {
  const ctx = context({ successor: { adopted_handles: ["driver"], adopted_instances: { driver: "driver|launch" } } });
  expect(assertRecipientAuthority(ctx, "ask", raw, "successor", "done", { allowAdoptionGrant: true })).toBe("driver");
});
test("unreadable current identity is unresolved, not evidence of replacement", () => {
  const ctx = context({}); writeFileSync(ctx.registryPath, "{");
  expect(refusal(ctx).errorClass).toBe("instance_unresolved");
});
