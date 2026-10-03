/**
 * The PUBLIC digest-window verb (cmdDigestWindow), not the module CLI: every
 * refusal of the config read carries the verb label and exits 1, so none
 * reaches the router unlabeled (tap-uinaa). The pane/team identity seams are
 * mocked in a child process (fixtures/digest-window-verb-probe.ts): mock.module
 * is process-wide and would leak into every later test file.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isInvalidUtf8 } from "../src/verbs/digest-window";

const probe = join(import.meta.dir, "fixtures", "digest-window-verb-probe.ts");
const tapBin = resolve(import.meta.dir, "../../../bin/tap");
const work = mkdtempSync(join(tmpdir(), "dw-verb-bin-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(mode: string, env: Record<string, string> = {}) {
  const child = Bun.spawnSync([process.execPath, probe, mode], { env: { ...process.env, TAP_JSON: "", ...env }, stdout: "pipe", stderr: "pipe" });
  const out = child.stdout.toString().trimEnd(), stderr = child.stderr.toString();
  expect(child.exitCode, stderr).toBe(0);
  return JSON.parse(out.slice(out.lastIndexOf("\n") + 1)) as { rc?: number; threw?: string; stderr: string; stdout: string; unchanged: boolean };
}

test("control: a valid update writes the window and prints the receipt", () => {
  const r = run("ok");
  expect(r).toMatchObject({ rc: 0, stdout: "tap digest-window: demo/sol window=30 include-asks=0\n", stderr: "", unchanged: false });
});

test("a group-writable config is refused with the router's class-carrying line and its recovery action, bytes untouched", () => {
  const r = run("group-writable");
  expect(r.threw).toBeUndefined();
  expect(r.rc).toBe(1);
  expect(r.stderr).toMatch(/^tap digest-window: preset config is group\/world writable: (\S+config\.toml); next: chmod 600 \1\n$/);
  expect(r.stdout).toBe("");
  expect(r.unchanged).toBe(true);
});

test("under TAP_JSON=1 the refusals are the router's JSON envelope with their error class, never prose on stderr", () => {
  const insecure = run("group-writable", { TAP_JSON: "1" });
  expect(insecure.threw).toBeUndefined();
  expect(insecure.rc).toBe(1);
  expect(insecure.stderr).toBe("");
  expect(JSON.parse(insecure.stdout)).toMatchObject({ ok: false, error_class: "preset_config_insecure", action: expect.stringMatching(/^chmod 600 /) });
  expect(insecure.unchanged).toBe(true);
  const undecodable = run("bad-utf8", { TAP_JSON: "1" });
  expect(undecodable.stderr).toBe("");
  expect(JSON.parse(undecodable.stdout)).toMatchObject({ ok: false, error_class: "preset_config_invalid", action: expect.stringMatching(/^fix /) });
  expect(undecodable.unchanged).toBe(true);
});

test("a config that is not valid UTF-8 is refused as an invalid config with a fix action, exit 1, bytes untouched", () => {
  const r = run("bad-utf8");
  expect(r.threw).toBeUndefined();
  expect(r.rc).toBe(1);
  expect(r.stderr).toMatch(/^tap digest-window: invalid preset config (\S+config\.toml): The encoded data was not valid for encoding utf-8; next: fix \1\n$/);
  expect(r.stdout).toBe("");
  expect(r.unchanged).toBe(true);
});

test("a TypeError that is not the decoder's invalid-UTF-8 refusal propagates instead of being labeled", () => {
  const r = run("type-error");
  expect(r.rc).toBeUndefined();
  expect(r.threw).toBe("TypeError: x is not a function");
  expect(r.stderr).toBe("");
});

test("isInvalidUtf8 matches only the fatal decoder's error", () => {
  let decoded: unknown;
  try { new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from([0xff, 0xfe])); } catch (error) { decoded = error; }
  expect(isInvalidUtf8(decoded)).toBe(true);
  expect(isInvalidUtf8(new TypeError("x is not a function"))).toBe(false);
  expect(isInvalidUtf8(Object.assign(new Error("bad"), { code: "ERR_ENCODING_INVALID_ENCODED_DATA" }))).toBe(false);
});

test("bin/tap digest-window refuses every bad window before touching any config, with the verb label and exit 1", () => {
  const xdg = join(work, "cfg");
  mkdirSync(join(xdg, "tap"), { recursive: true });
  const config = join(xdg, "tap/config.toml");
  const before = '[delivery]\nnow_window_seconds = 10\n[delivery.overrides."t/peer"]\nnow_window_seconds = 40\n';
  writeFileSync(config, before, { mode: 0o600 });
  for (const value of ["-1", "bad", "2.5", "2147483648", "", " 10"]) {
    const r = Bun.spawnSync([tapBin, "digest-window", value], { env: { ...process.env, TAP_JSON: "", XDG_CONFIG_HOME: xdg }, cwd: work, stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode, r.stdout.toString(), r.stderr.toString()], `accepted '${value}'`)
      .toEqual([1, "", "tap digest-window: window must be off or integer seconds from 0 to 2147483647\n"]);
  }
  expect(readFileSync(config, "utf8"), "a refused window wrote the config").toBe(before);
});

test("an unsafe TOML and a dotted-key layout are refused with the verb label, bytes untouched", () => {
  for (const [mode, layout] of [["bad-toml", /^tap digest-window: .+\n$/], ["dotted-key", /^tap digest-window: .+\n$/]] as const) {
    const r = run(mode);
    expect(r.threw, mode).toBeUndefined();
    expect(r.rc, mode).toBe(1);
    expect(r.stderr, mode).toMatch(layout);
    expect(r.stdout, mode).toBe("");
    expect(r.unchanged, `${mode} rewrote the config`).toBe(true);
  }
});
