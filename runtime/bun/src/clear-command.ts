// M6 U1: this table has one owner; watch and self-rebrief read the same clear spellings from here.
export function clearCommand(harness: string): string {
  if (harness.startsWith("opencode")) return "/new";
  return /^(claude|codex|cursor|agy|hermes)/.test(harness) ? "/clear" : "";
}
