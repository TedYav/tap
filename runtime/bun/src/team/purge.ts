import { renderRefusals } from "../error-line";
import { retiredCheckpoint } from "./reset";

export function cmdTeamPurge(argv: string[]): number {
  if (argv.includes("--json")) process.env.TAP_JSON = "1";
  return renderRefusals("tap team purge", () => retiredCheckpoint("tap team purge", argv));
}
