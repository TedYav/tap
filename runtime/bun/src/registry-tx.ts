import { TapError, type ResolvedContext } from "./context";
import { acquireRegistryLock } from "./panelock";
import { assertSelectionCurrent } from "./selector";
import { loadRegistry, type RegistryDoc, type Seat } from "./registry";
import { registryWriteRefusal } from "./register-authority";
import { isFile } from "./watch-lease";

/**
 * Run a registry mutation under the lock. Only an existing document with a
 * `seats` map and no `agents` key is writable, so every other shape refuses
 * before the action can move files or save: a detached empty roster would let
 * a caller report success for a write that never landed.
 */
export function withActingRegistry<T>(ctx: ResolvedContext, action: (doc: RegistryDoc, seats: Record<string, Seat>) => T, timeoutMs = 5000): T {
  const lock = acquireRegistryLock(ctx.registryPath, timeoutMs);
  if (!lock) throw new TapError(1, "launcher_registry_busy", "retry this command after the registry write completes", "could not obtain registry lock");
  try {
    assertSelectionCurrent(ctx.selection!, lock);
    const path = ctx.registryPath;
    if (!isFile(path)) throw new TapError(1, "registry_invalid", "tap doctor", `acting registry '${path}' is missing; nothing was written`);
    const doc = loadRegistry(path);
    const refusal = registryWriteRefusal(path, doc);
    if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail);
    return action(doc, doc.seats as Record<string, Seat>);
  } finally { lock.release(); }
}
