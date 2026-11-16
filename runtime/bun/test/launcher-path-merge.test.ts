import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loginShellExec } from "../src/launcher/invocation";
import { shellQuote } from "../src/shell-quote";
import { removeScratchTree } from "./support/scratch";

test("nested launches keep only the first occurrence of each login and caller PATH entry", () => {
  const root = mkdtempSync(join(tmpdir(), "path-merge-"));
  try {
    const shell = join(root, "bash"), login = "/login/bin:/usr/bin:/bin";
    writeFileSync(shell, `#!/bin/sh\nshift\nscript=$1\nshift\nPATH=${shellQuote(login)} exec /bin/sh -c "$script" "$@"\n`, { mode: 0o755 });
    let path = "/caller/bin:/usr/bin:/bin:/caller/bin";
    for (let generation = 0; generation < 6; generation++) {
      const command = loginShellExec(["/bin/sh", "-c", 'printf %s "$PATH"'], { PATH: path, TAP_LAUNCH_SHELL: shell });
      const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      path = result.stdout;
      expect(path).toBe(`${login}:/caller/bin`);
    }
  } finally { removeScratchTree(root); }
});

test("PATH merging preserves literal, relative and empty entries in first-occurrence order", () => {
  const root = mkdtempSync(join(tmpdir(), "path-literal-"));
  try {
    const shell = join(root, "sh"), login = ":./tools:/literal/*:./tools:", caller = "/a ' $(touch injected):/literal/*::/tail";
    writeFileSync(shell, `#!/bin/sh\nshift\nscript=$1\nshift\nPATH=${shellQuote(login)} exec /bin/sh -c "$script" "$@"\n`, { mode: 0o755 });
    const command = loginShellExec(["/bin/sh", "-c", 'printf %s "$PATH"'], { PATH: caller, TAP_LAUNCH_SHELL: shell });
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(":./tools:/literal/*:/a ' $(touch injected):/tail");
  } finally { removeScratchTree(root); }
});
