import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/bus";
import type { ResolvedContext } from "../src/context";
import { captureNewCrewIdentity } from "../src/crew-capture";
import { removeScratchTree } from "./support/scratch";

test("capture fallback refuses a relocated acting registry without rewriting either row", async () => {
  const root = mkdtempSync(join(process.env.TMUX_TMPDIR!, "capture-"));
  const saved = new Map(["TAP_VERB_SCRIPT", "TAP_INDEX_HOME"].map(key => [key, process.env[key]]));
  try {
    const index = join(root, "index"), busHome = join(root, ".tap/bus");
    mkdirSync(index); mkdirSync(busHome, { recursive: true });
    const old = join(root, ".tap/team-registry.json"), moved = join(root, "relocated.json");
    const registry = JSON.stringify({ schema: "0.20", team: { name: "capture", worktree_root: root }, seats: {
      child: { crew: true, instance: "child-one", pane_id: "%1", crew_identity_capture: { decision: "not_started" } },
    } });
    writeFileSync(old, registry); writeFileSync(moved, registry);
    const marker = (path: string) => JSON.stringify({ schema: "0.20", teams: { capture: { root, registry_location: path, state: "registered" } } });
    writeFileSync(join(index, "global-registry.json"), marker(old));
    const replacement = join(root, "new-index.json"); writeFileSync(replacement, marker(moved));
    const standIn = join(root, "register.sh");
    writeFileSync(standIn, `#!/bin/sh\ncp '${replacement}' '${index}/global-registry.json'\nexit 1\n`);
    process.env.TAP_VERB_SCRIPT = standIn; process.env.TAP_INDEX_HOME = index;
    const ctx = { root, team: "capture", registryPath: old, bus: new Bus(busHome) } as ResolvedContext;
    await expect(captureNewCrewIdentity(ctx, "unused", "child", "%1", "child-one", "codex")).rejects.toThrow("authority moved");
    expect(readFileSync(old, "utf8")).toBe(registry);
    expect(readFileSync(moved, "utf8")).toBe(registry);
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    removeScratchTree(root);
  }
}, 15000);
