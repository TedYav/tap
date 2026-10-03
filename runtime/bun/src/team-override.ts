// Shared pane-less --team semantics: explicit TAP_HOME retains precedence.
import { accessSync, constants, statSync } from "node:fs";
import { noMachineIndexError, TapError } from "./context";
import { validToken } from "./ids";
import { busHomeForEnrolled } from "./selector";
import { resolveEnrolledTeamRoot, actingRegistryForTeamOverride, isRegularFile } from "./index-home";

export function applyTeamOverride(team: string, { requireExistingBus = false }: { requireExistingBus?: boolean } = {}): void {
  if (!team) return;
  if (process.env.TAP_HOME) return;
  if (!validToken(team)) {
    throw new TapError(1, "usage_error", "tap help",
      `--team '${team}' fails charset ^[A-Za-z0-9][A-Za-z0-9._-]*$`);
  }
  const resolved = resolveEnrolledTeamRoot(team, process.env.TAP_INDEX_HOME);
  if (resolved.kind === "invalid") {
    throw new TapError(1, "invalid_flip", "tap doctor",
      "registry flip marker is present but invalid; refusing rather than skipping a v0.20 obligation");
  }
  if (resolved.kind === "absent") throw noMachineIndexError();
  if (resolved.kind === "not_authoritative") {
    throw new TapError(1, "registry_unreachable", "tap doctor",
      `acting registry for team '${team}' is unreachable (flip marker live/invalid?)`);
  }
  if (resolved.kind !== "ok") {
    throw new TapError(1, "not_found", "tap register",
      `--team '${team}' is not enrolled in the machine index (global-registry.json) — register a member in that worktree first, or pass an explicit TAP_HOME`);
  }
  const home = busHomeForEnrolled(resolved.root);
  // Settlement must not recreate a bus removed from under its enrollment.
  if (requireExistingBus && !isDirectory(home)) {
    throw new TapError(1, "registry_unreachable", "tap doctor",
      `acting registry for team '${team}' is unreachable: its bus '${home}' does not exist and settlement will not create one`);
  }
  if (!isReadableRegularFile(actingRegistryForTeamOverride(team, home, process.env.TAP_INDEX_HOME))) {
    throw new TapError(1, "registry_unreachable", "tap doctor",
      `acting registry for team '${team}' is unreachable (flip marker live/invalid?)`);
  }
  process.env.TAP_HOME = home;
  // Mark the mutation so lockRoot can tell a CALLER-pinned TAP_HOME from the
  // override: locks follow the caller's pin only (tap-7r3fn.66), keeping Bun
  // in lockstep with lib.sh's TAP_BUS_RULE distinction.
  process.env.TAP_TEAM_OVERRIDE_BUS = home;
}

function isReadableRegularFile(path: string): boolean {
  if (!isRegularFile(path)) return false;
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
