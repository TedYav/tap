// Reset clears membership through the existing hard family-retirement engine.
// The former checkpoint lifecycle is retired; historical bundles stay on disk.
import { TapError } from "../context";
import { renderRefusalsAsync } from "../error-line";
import { cmdTeamOut } from "./out";

export function retiredCheckpoint(verb: string, argv: string[]): never {
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  throw new TapError(1, "renamed_verb", "tap help team reset; tap team down to retain the roster",
    `${verb} was removed with the team checkpoint lifecycle; historical archives are untouched. Use tap team reset to stop and retire seats while keeping the team initialized`, verb);
}

export function cmdTeamReset(argv: string[]): Promise<number> {
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  return renderRefusalsAsync("tap team reset", () => {
    const removed = argv.find(arg => arg === "--kill-self" || arg === "--allow-nonstandard-bus-path");
    if (removed) throw new TapError(1, "renamed_verb", "tap help team reset; use --except <your-handle> to spare yourself",
      `${removed} belonged to the retired checkpoint reset; team reset now uses team out --hard`, "tap team reset");
    return cmdTeamOut(argv.includes("--hard") || argv.includes("--kill") ? argv : [...argv, "--hard"]);
  });
}
