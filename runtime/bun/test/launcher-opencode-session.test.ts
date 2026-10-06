import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInvocation, launchInvocation } from "../src/launcher/invocation";
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
    .toEqual(["opencode", "--foo", "bar", "--model", record.model, "--session", sid]);
});
test("live policy cannot replace the record ID or adopt the latest conversation", () => {
  const dir = join(work, "configured"); mkdirSync(join(dir, "tap"), { recursive: true });
  writeFileSync(join(dir, "tap/config.toml"), 'version=2\n[harness.opencode.params]\nsession="ses_config"\ncontinue=true\nfoo="bar"', { mode: 0o600 });
  expect(launchInvocation("new", { ...record, model: null, harness_session_id: sid }, new Notices(() => {}),
    { env: { ...env, XDG_CONFIG_HOME: dir } }).argv).toEqual(["opencode", "--foo", "bar", "--session", sid]);
});
