import { pyStrip } from "./catalog-metadata";
/** Codex's repeatable config option is keyed by its assignment, not its flag. */
export function assignments(argv: readonly string[]): { start: number; end: number; key: string }[] {
  const found: { start: number; end: number; key: string }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;
    const option = token.split("=", 1)[0];
    if (option !== "--config" && option !== "-c") continue;
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[i + 1];
    const at = value?.indexOf("=") ?? -1;
    if (at < 1 || value!.startsWith("-")) continue;
    const start = i;
    if (!token.includes("=")) i++;
    found.push({ start, end: i + 1, key: pyStrip(value!.slice(0, at)) });
  }
  return found;
}

export function configOnly(argv: readonly string[]): string[] {
  return assignments(argv).flatMap(({ start, end }) => argv.slice(start, end));
}

/** Keep winning assignments in their original order and spelling. */
export function configDefaults(defaults: readonly string[], higher: readonly string[]): string[] {
  const present = new Set(assignments(higher).map(item => item.key));
  const remove = new Set<number>();
  for (const { start, end, key } of assignments(defaults).reverse()) {
    if (present.has(key)) for (let i = start; i < end; i++) remove.add(i);
    present.add(key);
  }
  return defaults.filter((_, i) => !remove.has(i));
}

export function composeConfig(defaults: readonly string[], explicit: readonly string[]): string[] {
  return [...configDefaults(defaults, explicit), ...configDefaults(explicit, [])];
}

/** The assignment spans as plain triples, for a caller that splices argv itself. */
export function configAssignments(argv: readonly string[]): [number, number, string][] {
  return assignments(argv).map(({ start, end, key }) => [start, end, key]);
}
