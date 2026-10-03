import { awaitReplacedHarness } from "../src/launcher/readiness";
import { launchTransaction } from "../src/launcher/transaction";
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

test("Cursor pre-mint: the native owner tap clear mints through before replacement", async () => {
  // The Python bridge door (launcher.mint_launch_session_id) died with the
  // Python clear in R7b; planClear (launcher/replace.ts) calls this directly.
  const { mintLaunchSessionId, refusePreexistingIdOnNewMint } = await import("../src/launcher/transaction");
  const root = realpathSync(mkdtempSync(join(process.env.TAP_INDEX_HOME!, "cursor-mint-")));
  const binary = join(root, "cursor-agent"), receipt = join(root, "called");
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
  const uuid = "550E8400-e29b-41d4-A716-446655440000";
  const executable = (body: string) => {
    writeFileSync(binary, `#!/bin/sh\n[ "$1" = create-chat ] && [ "$#" = 1 ] || exit 18\n[ "$PWD" = "${root}" ] || exit 19\n`
      + `[ ! -t 0 ] && [ ! -t 1 ] && [ ! -t 2 ] || exit 20\nprintf called >> "${receipt}"\n${body}`);
    chmodSync(binary, 0o755);
  };
  const record = { name: "fixture/cursor", harness: "cursor", cwd: root, base: "fixture", tag: "cursor", index: 1, harness_session_id: null } as never;
  executable(`printf 'Chat created: ${uuid}\\n'\n`);
  const updated = await mintLaunchSessionId(record, env);
  expect([updated.harness_session_id, updated.identity_capture_action]).toEqual([uuid, "new"]);
  expect((record as { harness_session_id: null }).harness_session_id).toBeNull();
  const before = readFileSync(receipt, "utf8");
  for (const harness of ["claude", "codex", "opencode", "agy", "hermes"]) {
    const other = { ...(record as object), harness } as never;
    expect(await mintLaunchSessionId(other, env)).toBe(other);
  }
  expect(await mintLaunchSessionId(updated, env)).toBe(updated);
  expect(readFileSync(receipt, "utf8")).toBe(before);
  expect(() => refusePreexistingIdOnNewMint(updated)).toThrow("pre-existing");
  refusePreexistingIdOnNewMint(record);
  for (const body of ["printf malformed", "exit 7"]) {
    executable(body);
    expect(await mintLaunchSessionId(record, env)).toBe(record);
  }
  // An unavailable interpreter exercises ENOENT without falling through to a real Cursor on PATH.
  writeFileSync(binary, "#!/nonexistent/cursor-test-interpreter\n");
  expect(await mintLaunchSessionId(record, env)).toBe(record);
  executable(`printf '${uuid}\\n'; /bin/sleep 30`);
  const start = performance.now();
  expect(await mintLaunchSessionId(record, env)).toBe(record);
  const took = (performance.now() - start) / 1000;
  expect(took >= 9.5 && took < 14).toBe(true);
}, 30_000);

test("fractional readiness timeout stays bounded in the native owner", async () => {
  const start = performance.now();
  expect(await awaitReplacedHarness({ pane_id: "%999999", harness: "codex", timeout: 0.01,
    expected_server_epoch: "srv:0:0", previous_pane_pid: 1, detect_resume_picker: false }, process.env)).toEqual({ ready: false, reason: null });
  expect(performance.now() - start).toBeLessThan(2000);
});

test("unknown transaction kind refuses instead of entering a resume", async () => {
  const root = mkdtempSync(join(process.env.TAP_INDEX_HOME!, "invalid-kind-"));
  await expect(launchTransaction({ kind: "typo" as never, record: { name: "fixture/seat", harness: "claude", base: "fixture", cwd: root } }))
    .rejects.toThrow("invalid launch transaction kind");
});
