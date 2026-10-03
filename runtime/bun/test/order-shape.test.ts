// The work-order shape predicate: the AND, the frontmatter boundary, and the
// case rules. Every arm here is a body shape someone actually sends — the
// positive case is the verbatim 13:58Z hopper row from the incident, because a
// guard tested only against prose its author invented tends to match that prose
// and nothing else.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bodyWithoutFrontmatter, isOrderShaped } from "../src/slices/order-shape";

const fixtures = join(import.meta.dir, "../../../skills/tap/scripts/smoke/fixtures/order-shaped");
const withFrontmatter = (body: string) => `---\nid: sender-20260903T135800Z-0123456789ab\nfrom: boss\nto: hand\nkind: discuss\nre: tap-oglkh dispatch\nreply: settle-only\n---\n\n${body}\n`;

test("the real 2026-09-03 dispatch is order-shaped", () => {
  expect(isOrderShaped(readFileSync(join(fixtures, "hopper-w2-2026-09-03T1358Z.md"), "utf8"))).toBe(true);
});

test("either conjunct alone is ordinary writing", () => {
  // A bead id in status prose.
  expect(isOrderShaped(withFrontmatter("tap-oglkh is merged; nothing else to do here."))).toBe(false);
  // A plan heading with no bead id.
  expect(isOrderShaped(withFrontmatter("## Plan\n\nWe talk, then we decide."))).toBe(false);
  expect(isOrderShaped(withFrontmatter("## Units\n\nThree of them."))).toBe(false);
  expect(isOrderShaped(withFrontmatter("Your next holiday should be longer."))).toBe(false);
  // Both, and it refuses.
  expect(isOrderShaped(withFrontmatter("## Plan\n\nLand tap-oglkh."))).toBe(true);
});

test("the envelope never supplies a conjunct the author did not write", () => {
  // The id: line is a bead-shaped token and `re:` carries one too, so without a
  // frontmatter strip every positional send with a `## Plan` body would refuse.
  const envelopeOnly = `---\nid: tap-oglkh-20260903T135800Z-0123456789ab\nre: tap-oglkh\nreply: settle-only\n---\n\n## Plan\n\nNothing to do.\n`;
  expect(bodyWithoutFrontmatter(envelopeOnly).trim()).toBe("## Plan\n\nNothing to do.");
  expect(isOrderShaped(envelopeOnly)).toBe(false);
  // And the body's own id still counts.
  expect(isOrderShaped(envelopeOnly.replace("Nothing to do.", "Land tap-oglkh."))).toBe(true);
});

test("a body with no frontmatter is judged whole", () => {
  expect(bodyWithoutFrontmatter("## Plan\n\nLand tap-oglkh.")).toBe("## Plan\n\nLand tap-oglkh.");
  expect(isOrderShaped("## Plan\n\nLand tap-oglkh.")).toBe(true);
  // An unterminated fence is all frontmatter and no prose to judge.
  expect(bodyWithoutFrontmatter("---\nid: x\n## Plan tap-oglkh")).toBe("");
  expect(isOrderShaped("---\nid: x\n## Plan tap-oglkh")).toBe(false);
});

test("bead ids of every live length match, with no upper cliff", () => {
  for (const id of ["tap-04n", "tap-9sjp", "tap-7r3fn", "tap-abcdefghij", "tap-7r3fn.161", "tap-7r3fn.1.2"]) {
    expect(isOrderShaped(withFrontmatter(`## Plan\n\nFinish ${id}.`))).toBe(true);
  }
  // Two characters is not an id, and neither is a bare prefix.
  for (const id of ["tap-0x", "tap-", "taproot-abc"]) {
    expect(isOrderShaped(withFrontmatter(`## Plan\n\nFinish ${id}.`))).toBe(false);
  }
});

test("SHOUTY markers are case-sensitive; phrases are not", () => {
  const plan = (marker: string) => withFrontmatter(`${marker}: land tap-oglkh`);
  expect(isOrderShaped(plan("NEXT ITEM"))).toBe(true);
  expect(isOrderShaped(plan("DISPATCH"))).toBe(true);
  // "dispatch" and "next item" are ordinary words in ordinary prose; only the
  // shout is a hopper row, and reading them case-insensitively would refuse
  // every status note that mentions a dispatch.
  expect(isOrderShaped(plan("next item"))).toBe(false);
  expect(isOrderShaped(plan("dispatch"))).toBe(false);
  expect(isOrderShaped(plan("Dispatch"))).toBe(false);
  for (const phrase of ["read-back", "START NOW", "Your Next", "Work Order"]) {
    expect(isOrderShaped(withFrontmatter(`${phrase} tap-oglkh`))).toBe(true);
  }
});

test("a heading marker must start its own line, after optional indent", () => {
  expect(isOrderShaped(withFrontmatter("## Plan\n\ntap-oglkh"))).toBe(true);
  expect(isOrderShaped(withFrontmatter("  ## Units\n\ntap-oglkh"))).toBe(true);
  // Mid-line prose about a plan is not a plan heading.
  expect(isOrderShaped(withFrontmatter("I read the ## Plan section of tap-oglkh"))).toBe(false);
  expect(isOrderShaped(withFrontmatter("### Plan\n\ntap-oglkh"))).toBe(false);
});

test("the CLI reads the file the incumbent read: a leading BOM is body, not a fence", () => {
  // The predicate can be right and the verb still wrong, because the verb reads
  // a FILE. `Bun.file().text()` strips a leading U+FEFF; Python's
  // `open(..., encoding="utf-8")` did not, so `\ufeff---` was never a fence to
  // the incumbent and the envelope's own `re:` line stayed in the judged body.
  // With the BOM silently removed the fence is recognized, the conjuncts are
  // stripped, and a work order goes out as a note. A function-only oracle cannot
  // see this; only spawning the actual CLI on an actual file can.
  const scratch = mkdtempSync(join(tmpdir(), "order-shape-cli."));
  const cli = join(import.meta.dir, "../src/slices/order-shape.ts");
  const envelope = ["---", "id: x", "re: tap-abc", "---", "## Plan", "Nothing to do."].join("\n");
  const run = (name: string, body: string) => {
    const path = join(scratch, name); writeFileSync(path, body);
    const r = spawnSync(process.execPath, [cli, path], { encoding: "utf8", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    expect(r.status).toBe(0);
    return r.stdout;
  };
  expect(run("bom.md", "\ufeff" + envelope)).toBe("order-shape:shaped\n");
  expect(run("plain.md", envelope)).toBe("order-shape:not-shaped\n");
  // The verdict channel is the token, and a read failure is neither token.
  const missing = spawnSync(process.execPath, [cli, join(scratch, "absent.md")], { encoding: "utf8" });
  expect(missing.status).toBe(2);
  expect(missing.stdout).toBe("");
});
