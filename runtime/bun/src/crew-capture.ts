// Best-effort native identity observation after a crew's shell starts the harness.
// Registration remains the sole identity/quarantine authority.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ResolvedContext } from "./context";
import { INHERITED_IDENTITY_ENV } from "./session-store";
import { verbArgv } from "./courier-argv";
import { acquireRegistryLock } from "./panelock";
import { acquireResetMutationLock } from "./reset";
import { isMap, loads } from "./watch-detect";
import { atomicWrite } from "./fsatomic";
import { pyDumpIndent } from "./lossless-json";
import { validateLockedRegistryAuthority } from "./slices/registry-authority";

export async function captureNewCrewIdentity(ctx: ResolvedContext, scriptsDir: string,
  handle: string, pane: string, instance: string, harness: string, signal?: AbortSignal, launch?: { root: string; token: string }): Promise<void> {
  const env = { ...process.env };
  for (const key of [...INHERITED_IDENTITY_ENV, "TAP_CLEAR_ID", "TAP_CALLER_SELECTED_JOB", "TAP_REGISTER_SUPPRESS_IDENTITY_CAPTURE"]) delete env[key];
  if (launch) { env.TAP_LAUNCH_ROOT = launch.root; env.TAP_LAUNCH_ID = launch.token; }
  env.TAP_REGISTER_EXPECTED_HARNESS = harness;
  env.TAP_CALLER_SELECTED_INSTANCE = instance;
  env.TAP_REGISTER_CREW_CAPTURE_ONLY = "1";
  env.TAP_REGISTER_LOCK_TIMEOUT = "1";
  const [cmd, ...args] = verbArgv(scriptsDir, ["register", handle, "--pane", pane, "--crew", "--json"]);
  const deadline = performance.now() + 5000;
  let failure = "native identity observation timed out";
  do {
    await Bun.sleep(100);
    signal?.throwIfAborted();
    const result = spawnSync(cmd!, args, { env, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) failure = result.error ? `registration observation failed: ${result.error.message}`
      : `registration observation refused: ${(result.stdout || result.stderr).trim()}`;
    // Read only our exact row. SessionStart may have won the capture meanwhile.
    const doc = loads(readFileSync(ctx.registryPath, "utf8"));
    const rows = isMap(doc) ? doc.get("seats") : undefined;
    const row = isMap(rows) ? rows.get(handle) : undefined;
    if (!isMap(row) || row.get("pane_id") !== pane || row.get("instance") !== instance) return;
    const outcome = row.get("crew_identity_capture");
    if (isMap(outcome)) {
      if (outcome.get("decision") === "accepted" || outcome.get("decision") === "quarantined") return;
      if (outcome.get("decision") === "unavailable") failure = String(outcome.get("reason"));
    }
  } while (performance.now() < deadline);
  signal?.throwIfAborted();

  // A failed registration must not leave a not_started outcome forever. Pin
  // the exact child again under reset -> registry custody; never overwrite a
  // successful SessionStart or a replacement row. Preserve unrelated numbers.
  const reset = acquireResetMutationLock(ctx.bus.home, "crew identity capture", 1000, "shared");
  try {
    const lock = acquireRegistryLock(ctx.registryPath, 1000);
    if (!lock) throw new Error("crew capture outcome registry lock busy");
    try {
      const authority = validateLockedRegistryAuthority(ctx.registryPath, ctx.root, env.TAP_INDEX_HOME);
      if (!authority.ok) throw new Error(authority.message);
      const doc = loads(readFileSync(ctx.registryPath, "utf8"));
      const rows = isMap(doc) ? doc.get("seats") : undefined;
      const row = isMap(rows) ? rows.get(handle) : undefined;
      if (!isMap(row) || row.get("pane_id") !== pane || row.get("instance") !== instance) return;
      const prior = row.get("crew_identity_capture");
      if (isMap(prior) && ["accepted", "quarantined"].includes(String(prior.get("decision")))) return;
      row.set("crew_identity_capture", new Map([
        ["decision", "unavailable"], ["reason", failure], ["at", new Date().toISOString()],
      ]));
      atomicWrite(ctx.registryPath, pyDumpIndent(doc, 0) + "\n");
    } finally { lock.release(); }
  } finally { reset.release(); }
}
