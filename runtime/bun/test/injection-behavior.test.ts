import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectionBehavior, injectionBehaviorFault, draftClobberDue, digestDraftPlan } from "../src/injection-behavior";
const dir = mkdtempSync(join(tmpdir(), "injection-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = { ...process.env, XDG_CONFIG_HOME: dir };
test("clobber default, explicit wait, legacy warn reads as wait; invalid value refuses", () => {
  expect(injectionBehavior(env)).toBe("clobber");
  mkdirSync(join(dir, "tap"));
  writeFileSync(join(dir, "tap/config.toml"), '[injection]\nbehavior="wait"\n');
  expect(injectionBehavior(env)).toBe("wait");
  writeFileSync(join(dir, "tap/config.toml"), '[injection]\nbehavior="warn"\n');
  expect(injectionBehavior(env)).toBe("wait");
  writeFileSync(join(dir, "tap/config.toml"), '[injection]\nbehavior="clobber"\n');
  expect(injectionBehavior(env)).toBe("clobber");
  writeFileSync(join(dir, "tap/config.toml"), '[injection]\nbehavior="typo"\n');
  expect(() => injectionBehavior(env)).toThrow();
});
test("the fault names only a wrong injection setting; a read or parse failure elsewhere propagates", () => {
  const config = join(dir, "tap/config.toml");
  writeFileSync(config, '[injection]\nbehavior="typo"\n');
  expect(injectionBehaviorFault(env)).toBe("injection.behavior must be clobber or wait");
  writeFileSync(config, 'injection = 3\n');
  expect(injectionBehaviorFault(env)).toBe("injection must be a TOML table");
  writeFileSync(config, '[injection]\nbehavior="wait"\n');
  expect(injectionBehaviorFault(env)).toBeNull();
  writeFileSync(config, '[injection]\nbehavior="wait"\n[unrelated\n');
  expect(() => injectionBehaviorFault(env)).toThrow();
  rmSync(config); mkdirSync(config);
  expect(() => injectionBehaviorFault(env)).toThrow("not a regular file");
  rmSync(config, { recursive: true });
});
test("only an expired draft grace authorizes clobber; wait and other holds do not", () => {
  expect(draftClobberDue({ draft_deadline_epoch: 130 }, 129, "clobber")).toBe(false);
  expect(draftClobberDue({ draft_deadline_epoch: 130 }, 130, "clobber")).toBe(true);
  expect(draftClobberDue({ draft_deadline_epoch: 130 }, 999, "wait")).toBe(false);
  expect(draftClobberDue({ deadline_epoch: 130 }, 999, "clobber")).toBe(false);
  expect(draftClobberDue({ waiter_lifetime: "grace-window", deadline_epoch: 130 }, 130, "clobber")).toBe(true);
  expect(draftClobberDue({ draft_deadline_epoch: "bad" }, 999, "clobber")).toBe(false);
});

test("native admission carries only due members, so fresh notes cannot postpone old ones", () => {
  const spool = join(dir, "spool"); mkdirSync(spool);
  for (const [id, deadline] of [["old", 100], ["fresh", 200]] as const)
    writeFileSync(join(spool, `${id}.meta.json`), JSON.stringify({ draft_deadline_epoch: deadline }));
  const row = (id: string, ready = "busy:pending", cls = "auto-due") => ["registry", "team", "peer", "%1", "%1", "0", id, cls, ready].join("\x1f");
  expect(digestDraftPlan(row("old") + "\n" + row("fresh"), spool, 150, 32, "clobber")).toEndWith("\x1fold\n");
  expect(digestDraftPlan(row("old", "busy:queued"), spool, 150, 32, "clobber")).toBe("");
  expect(digestDraftPlan(row("old"), spool, 150, 32, "wait")).toBe("");
  expect(digestDraftPlan(row("old", "ready"), spool, 150, 32, "wait")).toEndWith("\x1fold\n");
  expect(digestDraftPlan(row("old", "ready", "plain"), spool, 150, 32, "clobber")).toBe("");
  const ready = Array.from({length: 5}, (_, i) => row(`n${i}`, "ready", "plain")).join("\n");
  expect(digestDraftPlan(ready, spool, 150, 2, "clobber").trim().split("\n")).toHaveLength(2);

});
