import { renderRefusals } from "../error-line";
import { retiredCheckpoint } from "./reset";

export function cmdTeamRestore(argv: string[]): number {
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  return renderRefusals("tap team restore", () => retiredCheckpoint("tap team restore", argv));
}
