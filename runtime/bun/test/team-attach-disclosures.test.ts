import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { printDisclosures, upWithAttachCode, type Disclosures } from "../src/team/attach";
import { removeScratchTree } from "./support/scratch";

const roots: string[] = [];
afterAll(() => { for (const root of roots) removeScratchTree(root); });

// printDisclosures is a pure renderer: the registry is its only state input,
// so a fabricated Disclosures against a seeded acting registry pins the
// incapable/unavailable split without tmux, iTerm or a live selection. The
// spared branch is unreachable with empty excluded rows, so the selection
// is the real no-selection shape.
function selectionWith(): Disclosures["selection"] {
  return { mode: "", except: [], only: [] };
}

function fixture(seats: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tap-attach-disclosures.")));
  roots.push(root);
  mkdirSync(join(root, ".tap"), { recursive: true });
  writeFileSync(registryPath(root), `${JSON.stringify({ schema: "0.20", team: { name: "demo", worktree_root: root }, seats })}\n`);
  return registryPath(root);
}

const registryPath = (root: string) => join(root, ".tap", "team-registry.json");

function disclosuresFor(registry: string): Disclosures {
  return {
    clientRows: [],
    rows: {
      live: [],
      unavailable: [
        { name: "demo/scout", handle: "scout", third: "revive" },
        { name: "demo/peer", handle: "peer", third: "revive" },
      ],
      excluded: [],
    },
    selection: selectionWith(),
    registryPath: registry,
    root: "/tmp/some team root",
  };
}

test("an incapable unavailable seat is disclosed as incapable, never as a resume candidate", () => {
  const registry = fixture({
    scout: { status: "suspended", status_reason: "incapable" },
    peer: { status: "suspended", status_reason: "session_stopped" },
  });
  let out = "";
  printDisclosures(disclosuresFor(registry), { write: (chunk: string | Uint8Array) => { out += String(chunk); return true; } } as unknown as NodeJS.WriteStream);
  expect(out).toContain("incapable: scout is suspended (incapable); re-register from its pane: run 'tap in' there, or 'tap register scout --pane <tmux-target>'");
  expect(out).not.toContain("tap session resume scout");
  // The non-incapable row keeps the incumbent's line shape, anchored to the root.
  expect(out).toContain("peer (resume tier revive; next: cd '/tmp/some team root' && tap session resume peer)");
  expect(out).toContain("unavailable: peer (resume tier revive; next: cd '/tmp/some team root' && tap session resume peer)");
});

test("without an incapable mark the disclosures keep the incumbent's shape, anchored to the root", () => {
  const registry = fixture({
    scout: { status: "suspended", status_reason: "session_stopped" },
    peer: { status: "active", status_reason: "" },
  });
  let out = "";
  printDisclosures(disclosuresFor(registry), { write: (chunk: string | Uint8Array) => { out += String(chunk); return true; } } as unknown as NodeJS.WriteStream);
  expect(out).toBe([
    "tap team attach: skipped because already attached: none",
    "tap team attach: unavailable: scout (resume tier revive; next: cd '/tmp/some team root' && tap session resume scout), "
      + "peer (resume tier revive; next: cd '/tmp/some team root' && tap session resume peer)",
    "",
  ].join("\n"));
  expect(out).not.toContain("incapable:");
});

// tap-26r3: with the team root known, the resume command is anchored so it
// works from an unrelated cwd (explicit TAP_HOME, foreign checkout).
test("the unavailable disclosure's resume command is anchored to the team root", () => {
  const registry = fixture({
    scout: { status: "suspended", status_reason: "session_stopped" },
    peer: { status: "suspended", status_reason: "session_stopped" },
  });
  let out = "";
  printDisclosures(disclosuresFor(registry), { write: (chunk: string | Uint8Array) => { out += String(chunk); return true; } } as unknown as NodeJS.WriteStream);
  expect(out).toContain("unavailable: scout (resume tier revive; next: cd '"
    + "/tmp/some team root" + "' && tap session resume scout), peer (resume tier revive; next: cd '"
    + "/tmp/some team root" + "' && tap session resume peer)");
});

test("team up --attach: a failed attach wins over team up's attention code; a clean attach keeps team up's", () => {
  expect(upWithAttachCode(2, 1)).toBe(1);
  expect(upWithAttachCode(0, 1)).toBe(1);
  expect(upWithAttachCode(2, 0)).toBe(2);
  expect(upWithAttachCode(0, 0)).toBe(0);
});
