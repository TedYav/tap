import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInvocation, launchInvocation, invocationShellCommand } from "../src/launcher/invocation";
import { spawnSync } from "node:child_process";
import { Notices } from "../src/launcher/catalog-notices";

const work = mkdtempSync(join(tmpdir(), "opencode-session-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const env = { ...process.env, XDG_CONFIG_HOME: work };
const sid = "ses_02ff4d9afffeNqlNt4HsmpFeUi";
const record = { name: "demo/glm", base: "glm", harness: "opencode", cwd: "/tmp/demo", model: "tokenrouter/z-ai/glm-5.2" };
// A native `--session` resume restores its own model, so only a launch or a fresh resume re-passes it (tap-j5k1b).
for (const action of ["launch", "resume"]) for (const id of [sid, ""]) test(`${action} pins only the stored OpenCode identity: ${id || "fresh"}`, () => {
  const model = action === "resume" && id ? [] : ["--model", record.model];
  expect(buildInvocation(action, { ...record, harness_session_id: id }, new Notices(() => {}), env).argv)
    .toEqual(["opencode", ...model, ...(id ? ["--session", id] : [])]);
});
test("final composition removes persisted adoption flags and pins the record ID", () => {
  expect(launchInvocation("new", { ...record, harness_session_id: sid,
    harness_passthrough: ["--session", sid, "--continue", "--foo", "bar"] }, new Notices(() => {}), { env }).argv)
    .toEqual(["opencode", "--standalone", "--foo", "bar", "--session", sid]);
});
test("live policy cannot replace the record ID or adopt the latest conversation", () => {
  const dir = join(work, "configured"); mkdirSync(join(dir, "tap"), { recursive: true });
  writeFileSync(join(dir, "tap/config.toml"), 'version=2\n[harness.opencode.params]\nsession="ses_config"\ncontinue=true\nfoo="bar"', { mode: 0o600 });
  expect(launchInvocation("new", { ...record, model: null, harness_session_id: sid }, new Notices(() => {}),
    { env: { ...env, XDG_CONFIG_HOME: dir } }).argv).toEqual(["opencode", "--standalone", "--foo", "bar", "--session", sid]);
});

test("v2 final invocation carries tuning in the prepared-session record, not unsupported TUI flags", () => {
  const prepared = { ...record, harness_session_id: sid, harness_passthrough: ["--variant", "high"] };
  const invocation = launchInvocation("new", prepared, new Notices(() => {}), { env });
  expect(invocation.argv).toEqual(["opencode", "--standalone", "--session", sid]);
  expect((prepared as typeof prepared & { launch_tuning: unknown }).launch_tuning).toMatchObject({model:record.model,effort:"high"});
});

test("v2 rejects flags that would share another pane's OpenCode server", () => {
  for (const tail of [["--server", "http://127.0.0.1:4096"], ["--no-standalone"], ["--standalone=false"]])
    expect(() => launchInvocation("new", { ...record, harness_tail: tail }, new Notices(() => {}), { env })).toThrow("standalone");
});

for (const mode of ["private", "shared"] as const) for (const action of ["new", "resume"]) {
  test(`${mode} ${action}: the TUI command carries tabs off and the receipt records it`, () => {
    const seat = { ...record, harness_session_id: sid, opencode_server_mode: mode };
    const notices: string[] = [];
    const invocation = launchInvocation(action, seat, new Notices(line => notices.push(line)), { env, resume: sid });
    // Execute the actual shell renderer with a harmless env reader as its harness.
    const rendered = invocationShellCommand({ ...invocation, argv: ["/usr/bin/printenv", "OPENCODE_CLI_CONFIG_CONTENT"] },
      { ...env, TAP_LAUNCH_SHELL: "/bin/sh" });
    const child = spawnSync("/bin/sh", ["-c", rendered], { env, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ tabs: { mode: "off" } });
    expect(notices).toContain("tap session: OpenCode tabs.mode=off");
  });
}

test("an operator tabs override is visible without exposing other inline config", () => {
  const notices: string[] = [];
  const seat = { ...record, harness_env: { OPENCODE_CLI_CONFIG_CONTENT: '{"tabs":{"mode":"on"},"private":"do-not-print"}' } };
  launchInvocation("new", seat, new Notices(line => notices.push(line)), { env });
  expect(notices).toContain("tap session: OpenCode tabs.mode=on");
  expect(notices.join("\n")).not.toContain("do-not-print");
});

test("unset removes OpenCode inline config even when its inherited value is malformed", () => {
  const notices: string[] = [];
  const invocation = launchInvocation("new", { ...record, harness_unset_env: ["OPENCODE_CLI_CONFIG_CONTENT"] },
    new Notices(line => notices.push(line)), { env: { ...env, OPENCODE_CLI_CONFIG_CONTENT: "malformed" } });
  expect(invocation.env).not.toHaveProperty("OPENCODE_CLI_CONFIG_CONTENT");
  expect(invocation.unset_env).toContain("OPENCODE_CLI_CONFIG_CONTENT");
  expect(notices).not.toContain("tap session: OpenCode tabs.mode=off");
});
