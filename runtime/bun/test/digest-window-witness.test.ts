// The change witness in `updateConfig` re-reads the config by NAME after the
// temp is written and refuses if the bytes moved since the secure read. The
// spy must be in place BEFORE the module's first import (a static import
// would bind `readFileSync` to the real function), so this arm lives alone.
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("updateConfig's change witness: bytes that moved between the secure read and the replace refuse, and the temp is removed", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "dw-witness-")); roots.push(root);
  const cfg = join(root, "cfg", "tap", "config.toml");
  fs.mkdirSync(join(root, "cfg", "tap"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cfg, "[delivery]\nnow_window_seconds = 10\n"); fs.chmodSync(cfg, 0o600);
  const env = { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: join(root, "cfg") };
  const realRead = fs.readFileSync;
  // The witness re-reads the config by its RESOLVED name after writing the temp; hand it different bytes once.
  const resolved = fs.realpathSync(cfg);
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: never, ...rest: never[]) => {
    if (String(path) === resolved) { spy.mockRestore(); return Buffer.from("[delivery]\nnow_window_seconds = 11\n"); }
    return (realRead as never as (...a: never[]) => Buffer)(path, ...rest);
  }) as never);
  const { updateConfig: fresh } = await import("../src/digest-window");
  try {
    expect(() => fresh(cfg, "tap/peer", 600, true, env)).toThrow("config changed during update; retry");
  } finally { spy.mockRestore(); }
  expect(fs.readFileSync(cfg, "utf8")).toBe("[delivery]\nnow_window_seconds = 10\n");
  expect(fs.readdirSync(join(root, "cfg", "tap")).filter(n => n.startsWith(".digest-window-"))).toEqual([]);
});

