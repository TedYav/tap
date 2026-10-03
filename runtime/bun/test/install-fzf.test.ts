import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureFzf } from "./support/fzf-fixture";
import { installFzf, retryTransient, TransientDownloadError } from "../src/install-fzf";
import { fzfTool, fzfOwnedFiles, managedFzf, fileMatches } from "../src/fzf-tool";
import { removeEntry } from "../src/verbs/machine";
const root = mkdtempSync(join(tmpdir(), "install-fzf-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, TAP_INDEX_HOME: root };
beforeAll(async () => { await fixtureFzf(env); }, 45000);
test("verified pin installs executable and notices, reuses exact offline cache", async () => {
  const path = managedFzf(env);
  expect(await installFzf({ env, download: async () => { throw new Error("offline"); } })).toBe(path);
  const entries = fzfOwnedFiles(join(import.meta.dir, "../../.."), root);
  expect(entries.some(e => e.path.endsWith("/LICENSE"))).toBe(true);
  expect(entries.some(e => e.path.endsWith("/uniseg.LICENSE"))).toBe(true);
  expect(entries.every(e => fileMatches(e.path, e.sha256))).toBe(true);
  expect(fileMatches(path, "")).toBe(false);
});
test("invalid download and unsupported platforms fail without changing prior pin", async () => {
  const before = readFileSync(fzfTool(env).binary);
  await expect(installFzf({ env: { ...env, TAP_INDEX_HOME: join(root, "bad") }, download: async () => new Uint8Array() })).rejects.toThrow("checksum mismatch");
  await expect(installFzf({ env, platform: "unsupported" })).rejects.toMatchObject({ errorClass: "fzf_platform_unsupported" });
  expect(readFileSync(fzfTool(env).binary)).toEqual(before);
});
test("uninstall removes exact owned files and preserves changed bytes", async () => {
  const scratchEnv = { ...env, TAP_INDEX_HOME: join(root, "uninstall") };
  await installFzf({ env: scratchEnv, download: async () => readFileSync(fzfTool(env).cache) });
  const entries = fzfOwnedFiles(join(import.meta.dir, "../../.."), scratchEnv.TAP_INDEX_HOME);
  const binary = entries.find(e => e.path.endsWith("/fzf"))!;
  writeFileSync(binary.path, "changed");
  expect(removeEntry({ kind: "file", ...binary })).toContain("preserved");
  for (const entry of entries.filter(e => e !== binary)) expect(removeEntry({ kind: "file", ...entry })).toBe("removed");
  await expect(installFzf({ env: scratchEnv })).rejects.toThrow("preserved changed fzf file");
});

test("changed file types including dangling symlinks are preserved", async () => {
  const changedEnv = { ...env, TAP_INDEX_HOME: join(root, "changed-type") };
  const tool = fzfTool(changedEnv);
  mkdirSync(tool.directory, { recursive: true });
  symlinkSync(join(root, "missing-target"), tool.binary);
  await expect(installFzf({ env: changedEnv, download: async () => { throw new Error("must not download"); } })).rejects.toThrow("preserved changed fzf file");
  expect(lstatSync(tool.binary).isSymbolicLink()).toBe(true);
});

// The entry script's local-archive seam (tap-335zf) replaces only where the bytes come
// from: the pinned sha256 still gates them, so a wrong file installs nothing.
const entry = join(import.meta.dir, "../src/install-fzf.ts");
const runEntry = (index: string, archive: string) =>
  spawnSync(process.execPath, [entry], { encoding: "utf8", env: { ...env, TAP_INDEX_HOME: index, TAP_FZF_TEST_ARCHIVE: archive, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" } });
test("entry script installs from TAP_FZF_TEST_ARCHIVE without a download and still verifies it", () => {
  const good = runEntry(join(root, "entry-good"), fzfTool(env).cache);
  expect(good.status).toBe(0);
  expect(good.stdout).toContain("install: managed fzf");
  const junk = join(root, "junk.tar.gz");
  writeFileSync(junk, "not the pinned archive");
  const bad = runEntry(join(root, "entry-bad"), junk);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("checksum mismatch");
  expect(() => managedFzf({ ...env, TAP_INDEX_HOME: join(root, "entry-bad") })).toThrow();
});

test("a transient download failure is retried a bounded number of times, a permanent one is not", async () => {
  let calls = 0;
  expect(await retryTransient(async () => { if (++calls < 3) throw new TransientDownloadError("socket closed"); return "ok"; }, 3, 0)).toBe("ok");
  expect(calls).toBe(3);
  calls = 0;
  await expect(retryTransient(async () => { calls++; throw new TransientDownloadError("timed out"); }, 3, 0)).rejects.toThrow("timed out");
  expect(calls).toBe(3);
  calls = 0;
  await expect(retryTransient(async () => { calls++; throw new Error("fzf download failed: HTTP 404"); }, 3, 0)).rejects.toThrow("HTTP 404");
  expect(calls).toBe(1);
});
