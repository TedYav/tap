import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLoginShell } from "../src/launcher/invocation";

const work = mkdtempSync(join(tmpdir(), "login-shell-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Only the fixture directory is on PATH, so zsh/bash/sh candidates cannot
// resolve to a system shell; "/bin/sh" is the terminal fallback.
const FALLBACK = "/bin/sh";

function dirNamedBash(name: string): string {
  const parent = join(work, name);
  mkdirSync(join(parent, "bash"), { recursive: true });
  return parent;
}
function executableBash(name: string): string {
  const parent = join(work, name);
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, "bash"), "#!/bin/sh\n");
  chmodSync(join(parent, "bash"), 0o755);
  return parent;
}

test("a directory named bash is refused as an absolute TAP_LAUNCH_SHELL", () => {
  const parent = dirNamedBash("abs-dir");
  expect(resolveLoginShell({ TAP_LAUNCH_SHELL: join(parent, "bash"), PATH: parent })).toBe(FALLBACK);
});

test("a directory named bash is refused when found on PATH", () => {
  const parent = dirNamedBash("path-dir");
  expect(resolveLoginShell({ TAP_LAUNCH_SHELL: "bash", PATH: parent })).toBe(FALLBACK);
  expect(resolveLoginShell({ PATH: parent })).toBe(FALLBACK);
});

test("an executable file named bash is accepted both absolute and on PATH", () => {
  const parent = executableBash("file");
  const bash = join(parent, "bash");
  expect(resolveLoginShell({ TAP_LAUNCH_SHELL: bash, PATH: parent })).toBe(bash);
  expect(resolveLoginShell({ PATH: parent })).toBe(bash);
});
