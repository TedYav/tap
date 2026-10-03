import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redeliveryEligibility } from "../src/slices/redelivery-eligibility";

test("terminal eligibility preserves prior transport evidence", () => {
  const home = mkdtempSync(join(tmpdir(), "tap-redelivery-eligibility."));
  const receipts = join(home, "receipts");
  mkdirSync(receipts);
  try {
    expect(redeliveryEligibility(home, "note")).toBe("eligible");
    for (const terminal of ["done", "cancelled"]) {
      const state = terminal === "done" ? "settled" : "cancelled";
      writeFileSync(join(receipts, `note.${terminal}`), "existing terminal evidence");
      expect(redeliveryEligibility(home, "note")).toBe(`${state}-before-delivery`);
      for (const effect of ["attempted", "sent", "harness-queued"]) {
        const path = join(receipts, `note.${effect}`);
        writeFileSync(path, "existing transport evidence");
        expect(redeliveryEligibility(home, "note")).toBe(`${state}-after-delivery-attempt`);
        rmSync(path);
      }
      rmSync(join(receipts, `note.${terminal}`));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("terminal and transport markers require regular files", () => {
  const home = mkdtempSync(join(tmpdir(), "tap-redelivery-kind."));
  const receipts = join(home, "receipts");
  const directory = join(home, "directory");
  mkdirSync(receipts); mkdirSync(directory);
  try {
    for (const suffix of ["done", "cancelled", "attempted", "sent", "harness-queued"]) mkdirSync(join(receipts, `note.${suffix}`));
    expect(redeliveryEligibility(home, "note")).toBe("eligible");
    for (const suffix of ["done", "cancelled", "attempted", "sent", "harness-queued"]) {
      const path = join(receipts, `note.${suffix}`);
      rmSync(path, { recursive: true }); symlinkSync(directory, path);
    }
    expect(redeliveryEligibility(home, "note")).toBe("eligible");
    rmSync(join(receipts, "note.done")); writeFileSync(join(receipts, "note.done"), "terminal");
    expect(redeliveryEligibility(home, "note")).toBe("settled-before-delivery");
    rmSync(join(receipts, "note.sent")); writeFileSync(join(receipts, "note.sent"), "transport");
    expect(redeliveryEligibility(home, "note")).toBe("settled-after-delivery-attempt");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
