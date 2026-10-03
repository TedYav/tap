// Test-only entry for the forwarding race: runs the native read verb with the
// registry mutation injected at the ACTUAL in-process publication boundary —
// forwarding-receipt's registry-lock acquisition — where the incumbent's bun
// shim intercepted its subprocess. The mutation lands between read's sampled
// grant and the helper's under-lock revalidation, so only a publication that
// revalidates can refuse it. Env: FORWARD_REGISTRY, FORWARD_MUTATION
// (replace|restore), FORWARD_MARKER — the same contract the old shim had.
import { mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

const registryPath = process.env.FORWARD_REGISTRY ?? "";
const mutation = process.env.FORWARD_MUTATION ?? "";
const markerPath = process.env.FORWARD_MARKER ?? "";

if (mutation && registryPath && markerPath) {
  const panelock = await import("../../src/panelock");
  // Capture the real lock BEFORE mock.module: the mock replaces the namespace
  // property in place, so a wrapper that read it through the namespace would
  // recurse into itself and never acquire.
  const realAcquire = panelock.acquireRegistryLock;
  mock.module("../../src/panelock", () => ({
    ...panelock,
    acquireRegistryLock(path: string) {
      const doc = JSON.parse(readFileSync(registryPath, "utf8")) as {
        seats: Record<string, Record<string, unknown>>;
        seat_forwardings: Array<Record<string, unknown>>;
      };
      if (mutation === "replace") doc.seats.b!.instance = "b|replacement";
      else {
        doc.seats.a = { instance: "a|one", status: "active", delivery: "poll" };
        doc.seat_forwardings[0]!.custody_revoked = true;
      }
      writeFileSync(registryPath, JSON.stringify(doc));
      writeFileSync(markerPath, "after initial grant, before receipt helper");
      return realAcquire(path);
    },
  }));
}

const { runNative } = await import("../../main");
const { cmdRead } = await import("../../src/verbs/read");
process.exitCode = runNative("read", cmdRead, process.argv.slice(2));
