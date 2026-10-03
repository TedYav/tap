import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInvocation } from "../src/launcher/invocation";
import { Notices } from "../src/launcher/catalog-notices";

const work = mkdtempSync(join(tmpdir(), "native-resume-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const native = "11111111-2222-3333-4444-555555555555";
const stored = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const record = { name: "demo/scout", base: "scout", harness: "claude", cwd: "/tmp/demo", harness_session_id: stored };

function claudeEnv(name: string, transcripts: string[]): NodeJS.ProcessEnv {
  const home = join(work, name);
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  for (const id of transcripts) writeFileSync(join(home, "projects", "p", `${id}.jsonl`), "{}\n");
  return { ...process.env, TAP_CLAUDE_HOME: home, XDG_CONFIG_HOME: join(work, "config") };
}

function resumeArgv(env: NodeJS.ProcessEnv): string[] {
  return buildInvocation("resume", record, new Notices(() => {}), env, null, null, native).argv;
}

// The nativeQuery guard: a native id is passed to `claude --resume` only when
// its transcript exists; otherwise the stored resume target decides.
test("native claude resume passes the native id when its transcript exists", () => {
  const argv = resumeArgv(claudeEnv("present", [native, stored]));
  expect(argv.slice(-2)).toEqual(["--resume", native]);
});

test("native claude resume falls back to the stored target when the native transcript is absent", () => {
  const argv = resumeArgv(claudeEnv("absent", [stored]));
  expect(argv).not.toContain(native);
  expect(argv.slice(-2)).toEqual(["--resume", stored]);
});
