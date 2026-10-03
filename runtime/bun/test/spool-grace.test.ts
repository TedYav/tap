import { expect, test } from "bun:test";
import { graceCanReprobe, heldSpoolClass } from "../src/spool-grace";
test("only standard grace without possible effects gains reprobe eligibility", () => {
  const meta = { waiter_lifetime: "grace-window", policy: "standard" };
  expect(graceCanReprobe(meta, false)).toBe(true);
  expect(graceCanReprobe(meta, true)).toBe(false);
  for (const policy of ["autosettle", "polite", "urgent"]) expect(graceCanReprobe({ ...meta, policy }, false)).toBe(false);
  for (const waiter_lifetime of ["", "autosettle-hold", "readiness-gate", "typo"]) expect(graceCanReprobe({ ...meta, waiter_lifetime }, false)).toBe(false);
});
test("owner class preserves absent-versus-empty and neighboring lifetimes", () => {
  expect(heldSpoolClass({ deadline_source: "readiness-gate" }, false)).toBe(true);
  expect(heldSpoolClass({ deadline_source: "readiness-gate", waiter_lifetime: "" }, false)).toBe(false);
  expect(heldSpoolClass({ waiter_lifetime: "autosettle-hold" }, false)).toBe(false);
  expect(heldSpoolClass({ reason_class: "window" }, false)).toBe(true);
  expect(heldSpoolClass({ waiter_lifetime: "grace-window" }, false)).toBe(true);
  expect(heldSpoolClass({ waiter_lifetime: "grace-window" }, true)).toBe(false);
  expect(heldSpoolClass({ waiter_lifetime: "grace-window" }, true, true)).toBe(true);
});

// Presence is conservative even when the record cannot be decoded. The `held`
// door is the deliverer's; the reprobe decision runs in-process inside the drain's
// deadline transaction (spool-deadline.test.ts pins the same marker shapes there).
test("CLI refuses empty, torn, directory and dangling-link possible markers", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "grace-marker-"));
  const meta = path.join(home, "meta.json"), attempted = path.join(home, "attempted");
  fs.writeFileSync(meta, JSON.stringify({ waiter_lifetime: "grace-window", policy: "standard" }));
  const decide = () => {
    const result = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../src/spool-grace.ts"), "held", meta, attempted]);
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    expect(decide()).toBe("yes");
    for (const create of [() => fs.writeFileSync(attempted, ""), () => fs.writeFileSync(attempted, "{"),
      () => fs.mkdirSync(attempted), () => fs.symlinkSync(path.join(home, "absent"), attempted)]) {
      create(); expect(decide()).toBe("no"); fs.rmSync(attempted, { recursive: true });
    }
    // The retired `reprobe` door refuses rather than answering.
    const retired = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../src/spool-grace.ts"), "reprobe", meta, attempted, "ready"]);
    expect(retired.exitCode).toBe(2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
