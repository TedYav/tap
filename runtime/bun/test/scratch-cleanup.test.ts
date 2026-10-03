import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeScratchTree } from "./support/scratch";

if (existsSync("/usr/sbin/lsof")) {
  console.log("SMOKE-SKIP: absent-lsof cleanup refusal requires a host without /usr/sbin/lsof; PATH refusal and positive controls still run");
}

let root: string;
let bin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tap-cleanup."));
  bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["mktemp", "mkdir", "chmod", "ln", "env", "rm", "dirname", "python3", "cat"]) {
    symlinkSync(Bun.which(name)!, join(bin, name));
  }
  // The nested runner has no test body; these controls exercise its EXIT trap. The stub
  // records one entry in the runner's ran-files log (as the real preload does), because
  // run.sh fails a run that opened no test file and these controls expect a clean exit.
  writeFileSync(join(bin, "bun"), '#!/bin/sh\necho /stub/entry.test.ts >> "$TAP_RUNNER_RAN_LOG"\nexit 0\n', { mode: 0o755 });
});
afterEach(() => removeScratchTree(root));

function cleanupResult(kind: "support" | "runner") {
  const env = { ...process.env, PATH: bin, TMUX_TMPDIR: root, TAP_SMOKE_BUN: "bun" };
  if (kind === "support") {
    const scratch = join(root, "child-scratch");
    mkdirSync(scratch);
    const helper = join(import.meta.dir, "support/scratch.ts");
    const result = spawnSync(process.execPath, ["-e",
      `import { removeScratchTree } from ${JSON.stringify(helper)}; removeScratchTree(${JSON.stringify(scratch)});`],
    { env, encoding: "utf8" });
    return { status: result.status, retained: existsSync(scratch), stderr: result.stderr };
  }
  const result = spawnSync("/bin/bash", [resolve(import.meta.dir, "run.sh")], { env, encoding: "utf8" });
  return { status: result.status, retained: readdirSync(root).some((p) => p.startsWith("tb.")), stderr: result.stderr };
}

for (const kind of ["support", "runner"] as const) {
  test(`${kind}: PATH lsof unowned result permits cleanup`, () => {
    writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = cleanupResult(kind);
    expect(result.status).toBe(0);
    expect(result.retained).toBe(false);
  });
  for (const status of [0, 2]) {
    test(`${kind}: PATH lsof exit ${status} refuses cleanup`, () => {
      writeFileSync(join(bin, "lsof"), `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 });
      const result = cleanupResult(kind);
      expect(result.status).not.toBe(0);
      expect(result.retained).toBe(true);
      expect(result.stderr).toContain("refusing to remove scratch");
    });
  }
  if (!existsSync("/usr/sbin/lsof")) test(`${kind}: absent PATH lsof and absent platform fallback refuse cleanup`, () => {
    const result = cleanupResult(kind);
    expect(result.status).not.toBe(0);
    expect(result.retained).toBe(true);
    expect(result.stderr).toContain("refusing to remove scratch");
  });
}

test("support: lsof output with exit 1 still refuses cleanup", () => {
  writeFileSync(join(bin, "lsof"), "#!/bin/sh\nprintf 'unexpected owner\\n'\nexit 1\n", { mode: 0o755 });
  const result = cleanupResult("support");
  expect(result.status).not.toBe(0);
  expect(result.retained).toBe(true);
});
