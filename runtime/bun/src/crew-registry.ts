// Crew shells start in --cwd. Refuse before pane creation when ordinary seat
// commands there would select a different registry from the launcher's row.
import { realpathSync } from "node:fs";
import { selectCaller } from "./selector";

// In-process twin of the retired `tap_bun_call crew-registry` door: same
// check, same mismatch sentence, no `runtime_missing`/`slice_failed` wrapper
// lines (those belonged to the call wrapper, not the contract).
export function checkCrewRegistry(cwd: string, registry: string): void {
  if (!cwd || !registry) throw new Error("missing crew cwd or acting registry");
  // A tmux window's inherited environment is not a durable team binding.
  const env = { ...process.env };
  delete env.TAP_HOME;
  const child = selectCaller({ cwd, env });
  if (child.registryLocation !== registry || child.registryLocationReal !== realpathSync(registry)) {
    throw new Error(`crew cwd selects ${child.registryLocation}, launcher uses ${registry}`);
  }
}

