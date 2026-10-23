import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { removeScratchTree } from "./support/scratch";

const work = realpathSync(mkdtempSync(join(tmpdir(), "shared-compiled-")));
afterAll(() => removeScratchTree(work));

test("compiled service requests spawn shipped source through Bun, not the router or bunfs", () => {
  const repo = resolve(import.meta.dir, "../../..");
  for (const dir of ["skills", "runtime"]) symlinkSync(join(repo, dir), join(work, dir));
  mkdirSync(join(work, "bin/tap"), { recursive: true });
  const entry = join(work, "entry.ts"), binary = join(work, "bin/tap/router"), argv = join(work, "argv");
  writeFileSync(entry, `import {openCodeAPI} from ${JSON.stringify(join(repo, "runtime/bun/src/opencode-service.ts"))};
// Like the real router, the compiled entry refuses a source path as a verb.
if (process.argv.includes('--request')) process.exit(17);
try { process.stdout.write(JSON.stringify(openCodeAPI({url:'http://127.0.0.1:12345',password:'fixture-secret'},'/api/shell'))); }
catch { process.exitCode=1; }
`);
  const build = spawnSync(process.execPath, ["build", "--compile", entry, "--outfile", binary], { encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);
  writeFileSync(join(work, "bin/bun"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$PROBE_ARGV"\ncat >/dev/null\nprintf \'{"data":[]}\'\n', { mode: 0o755 });
  const run = spawnSync(binary, [], { encoding: "utf8", env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}`, PROBE_ARGV: argv }, timeout: 10000 });
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({ data: [] });
  expect(readFileSync(argv, "utf8").trim().split("\n")).toEqual([join(work, "runtime/bun/src/opencode-service.ts"), "--request"]);
}, 120000);
