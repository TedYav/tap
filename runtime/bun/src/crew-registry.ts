// Crew shells start in --cwd. Refuse before pane creation when ordinary seat
// commands there would select a different registry from the launcher's row.
import { realpathSync } from "node:fs";
import { selectCaller, SelectorError } from "./selector";
import { gitCommonDir, resolveContext } from "./context";

// In-process twin of the retired `tap_bun_call crew-registry` door: same
// check, same mismatch sentence, no `runtime_missing`/`slice_failed` wrapper
// lines (those belonged to the call wrapper, not the contract).
export function checkCrewRegistry(cwd: string, registry: string, retainedRoot?: string): void {
  if (!cwd || !registry) throw new Error("missing crew cwd or acting registry");
  // A tmux window's inherited environment is not a durable team binding.
  const env = { ...process.env };
  delete env.TAP_HOME;
  let selected: string;
  try { selected = selectCaller({ cwd, env }).registryLocation; }
  catch (error) {
    if (!(error instanceof SelectorError) || error.errorClass !== "unanchored_bus") throw error;
    // A retained recipe can recover from an unenrolled sibling worktree after
    // all panes are gone. Its proven registry and Git repository remain fixed.
    if (retainedRoot) {
      const common = gitCommonDir(cwd, env);
      if (common && common === gitCommonDir(retainedRoot, env)) return;
    }
    // An unenrolled sibling worktree can use the parent's verified pane
    // binding; an enrolled cwd keeps its ordinary selection.
    try { selected = resolveContext(cwd, env).registryPath; }
    catch (fallback) {
      if (!(fallback instanceof Error)) throw fallback;
      throw new Error(`${fallback.message}; an unenrolled crew cwd needs a unique current registered caller pane in a canonical team/handle session in the same repository`);
    }
  }
  if (selected !== registry || realpathSync(selected) !== realpathSync(registry)) {
    throw new Error(`crew cwd selects ${selected}, launcher uses ${registry}`);
  }
}

