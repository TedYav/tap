// Born live (F2a): a launch resolves its team through an enrolled machine
// index, so a scratch git root that plans a launch is enrolled first: an empty
// acting registry under <root>/.tap/bus and a 0.20 marker naming it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function enrollScratchRoot(root: string, index: string, team = "fixture"): void {
  const registry = join(root, ".tap", "bus", "registry.json");
  mkdirSync(join(root, ".tap", "bus"), { recursive: true });
  mkdirSync(index, { recursive: true });
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name: team, worktree_root: root }, seats: {} })}\n`);
  writeFileSync(join(index, "global-registry.json"),
    `${JSON.stringify({ schema: "0.20", teams: { [team]: { root, registry_location: registry, state: "registered" } } })}\n`);
}
