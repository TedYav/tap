// Hermetic OpenCode 2 preparation for fixtures whose interactive process is a stand-in.
import { strict as assert } from "node:assert";
import { appendFileSync } from "node:fs";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    console.log("opencode v2.1.2");
  } else {
    const [command, mode, method, path, flag, raw] = args;
    assert.equal(command, "api");
    assert.equal(mode, "--standalone");
    const [providerID, id] = (process.env.TAP_TEST_OPENCODE_MODEL || "fixture/opus-test").split("/");
    const model = { providerID, id, enabled: true, variants: [] };
    if (method === "GET" && path?.startsWith("/api/model?")) {
      assert.equal(new URLSearchParams(path.split("?")[1]).get("location[directory]"), process.cwd());
      console.log(JSON.stringify({ data: [model] }));
    } else {
      assert.equal(method, "POST");
      assert.equal(path, "/api/session");
      assert.equal(flag, "--data");
      const body = JSON.parse(raw!);
      assert.equal(body.location.directory, process.cwd());
      if (body.model) assert.deepEqual(body.model, { providerID, id });
      const session = { id: `ses_fixture${process.pid}`, location: body.location, model: body.model };
      if (process.env.TAP_TEST_OPENCODE_LOG) appendFileSync(process.env.TAP_TEST_OPENCODE_LOG, JSON.stringify(session) + "\n");
      console.log(JSON.stringify({ data: session }));
    }
  }
}
