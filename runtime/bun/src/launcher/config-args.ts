import { pyStrip } from "./catalog-metadata";
/**
 * Codex's repeatable config option is keyed by its assignment, not its flag. Clap accepts five spellings:
 * `-c K=V`, `--config K=V`, `--config=K=V`, `-c=K=V` and the attached short form `-cK=V`.
 */
export function assignments(argv: readonly string[]): { start: number; end: number; key: string; value: string }[] {
  const found: { start: number; end: number; key: string; value: string }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") break;
    const option = token.split("=", 1)[0];
    let value: string | undefined, width = 1;
    if (option === "--config" || option === "-c") {
      if (token.includes("=")) value = token.slice(token.indexOf("=") + 1);
      else { value = argv[i + 1]; width = 2; }
    } else if (token.startsWith("-c") && !token.startsWith("--")) value = token.slice(2);
    else continue;
    const at = value?.indexOf("=") ?? -1;
    if (at < 1 || value!.startsWith("-")) continue;
    found.push({ start: i, end: i + width, key: pyStrip(value!.slice(0, at)), value: value!.slice(at + 1) });
    i += width - 1;
  }
  return found;
}

/** Drop every assignment of the named keys; every other token keeps its place. */
export function withoutConfigKeys(argv: readonly string[], keys: readonly string[]): string[] {
  const drop = new Set<number>();
  for (const { start, end, key } of assignments(argv)) if (keys.includes(key)) for (let i = start; i < end; i++) drop.add(i);
  return argv.filter((_, i) => !drop.has(i));
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
