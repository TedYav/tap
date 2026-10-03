import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as locks from "../src/panelock";
import { quarantinePayload } from "../src/quarantine";

const roots: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  if (!process.env.TAP_INDEX_HOME || !process.env.TMUX_TMPDIR) throw new Error("use test/run.sh");
  const root = fs.mkdtempSync(join(tmpdir(), "tap-quarantine."));
  roots.push(root);
  fs.mkdirSync(join(root, "payloads"));
  const src = join(root, "payloads", "broken.md");
  fs.writeFileSync(src, "original bytes");
  return { root, src, dest: join(root, "payloads", ".quarantine", "broken.md") };
}

for (const fault of ["destination", "source", "after-link"] as const) {
  test(`quarantine distinguishes ${fault} ENOENT at the real publication operation`, () => {
    const { src, dest } = fixture();
    const original = fs.linkSync;
    const spy = spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (fault === "source") fs.unlinkSync(src);
      if (fault === "after-link") { original(from, to); fs.unlinkSync(src); return; }
      throw Object.assign(new Error("injected missing path"), {code: "ENOENT"});
    });
    restores.push(() => spy.mockRestore());
    expect(quarantinePayload(src, "invalid_envelope")).toBe(fault === "source" ? 1 : 2);
    expect(fs.existsSync(src)).toBe(fault === "destination");
    expect(fs.existsSync(dest)).toBe(fault === "after-link");
    if (fault === "after-link") expect(fs.readFileSync(dest, "utf8")).toBe("original bytes");
  });
}

test("quarantine refuses a failed generation mark after preserving bytes", () => {
  const { root, src, dest } = fixture();
  fs.writeFileSync(join(root, "reset-generation.json"), '{"state":"pristine"}');
  const spy = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("injected generation write failure"); });
  restores.push(() => spy.mockRestore());
  expect(quarantinePayload(src, "invalid_envelope")).toBe(2);
  expect(fs.readFileSync(dest, "utf8")).toBe("original bytes");
  expect(JSON.parse(fs.readFileSync(join(root, "reset-generation.json"), "utf8")).state).toBe("pristine");
});

test("quarantine revalidates a corrected replacement after acquiring the shared lock", () => {
  const { src, dest } = fixture();
  const original = locks.acquireObligationLock;
  const corrected = `---\nid: broken\nfrom: snd\nto: rcv\nkind: discuss\npath: ${src}\n---\ncorrected\n`;
  const spy = spyOn(locks, "acquireObligationLock").mockImplementation((...args) => {
    const lock = original(...args);
    if (!lock) throw new Error("fixture failed to acquire lock");
    fs.writeFileSync(src, corrected);
    return lock;
  });
  restores.push(() => spy.mockRestore());
  expect(quarantinePayload(src, "invalid_envelope")).toBe(1);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(src, "utf8")).toBe(corrected);
  expect(fs.existsSync(dest)).toBe(false);
});

// The helper's three exits are distinct, and the callers act on them: rc 1 (the
// ignorable race) and rc 2 (failed, or moved without its generation mark) were
// one code once, so a real failure read as "somebody else handled it". Each row
// is arranged separately; "0 and not zero" would not distinguish them.

test("a clean quarantine is rc 0 and consumes the reset generation", () => {
  const { root, src, dest } = fixture();
  fs.writeFileSync(join(root, "reset-generation.json"), '{"bundle_id":"b","state":"pristine"}');
  expect(quarantinePayload(src, "invalid_envelope")).toBe(0);
  expect(fs.readFileSync(dest, "utf8")).toBe("original bytes");
  expect(fs.existsSync(src)).toBe(false);
  expect(JSON.parse(fs.readFileSync(join(root, "reset-generation.json"), "utf8")).state).toBe("reused");
});

test("a failed .quarantine mkdir is rc 2, and no quarantine directory appears", () => {
  const { root, src } = fixture();
  const original = fs.mkdirSync;
  const spy = spyOn(fs, "mkdirSync").mockImplementation((path, options) => {
    if (String(path).endsWith(".quarantine")) throw Object.assign(new Error("injected mkdir failure"), { code: "EACCES" });
    return original(path as string, options);
  });
  restores.push(() => spy.mockRestore());
  expect(quarantinePayload(src, "invalid_envelope")).toBe(2);
  expect(fs.existsSync(join(root, "payloads", ".quarantine"))).toBe(false);
  expect(fs.existsSync(src)).toBe(true);
});

test("a move that failed with the source still live is rc 2, never the ignorable race", () => {
  const { root, src } = fixture();
  fs.mkdirSync(join(root, "payloads", ".quarantine"));
  const spy = spyOn(fs, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("injected link failure"), { code: "EACCES" });
  });
  restores.push(() => spy.mockRestore());
  expect(quarantinePayload(src, "invalid_envelope")).toBe(2);
  expect(fs.existsSync(src)).toBe(true);
  expect(fs.readdirSync(join(root, "payloads", ".quarantine"))).toEqual([]);
});
