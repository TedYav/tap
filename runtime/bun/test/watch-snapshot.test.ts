import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realTickSeams } from "../src/watch-tick-run";
import { removeScratchTree } from "./support/scratch";

// Exercise the real roster and four passes. Only the tmux server is a fixture;
// every logged line is a real PATH-resolved child invocation.
test("one tick shares registry, pane identity and one capture across all detector passes", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "watch-snapshot."));
  const saved = { ...process.env };
  const registry = join(root, "registry.json"), log = join(root, "calls"), bin = join(root, "bin");
  fs.mkdirSync(bin); fs.mkdirSync(join(root, "watch"));
  for (const name of ["payloads", "receipts", "spool"]) fs.mkdirSync(join(root, name));
  const harnesses = ["codex", "codex", "claude", "opencode", "cursor"];
  const seats = Object.fromEntries(harnesses.map((harness, i) => [`s${i}`, {
    pane: `fixture:${i}.0`, pane_id: `%${i}`, harness, status: "active", delivery: "pane",
    session: "fixture", server_epoch: "srv:1:1", boot_id: "boot:fixture",
  }]));
  const handles = ["10", "2", "s2", "s3", "s4"];
  fs.writeFileSync(registry, `{"schema":"0.20","team":{"name":"fixture"},"seats":{${handles.map((h, i) => `${JSON.stringify(h)}:${JSON.stringify(seats[`s${i}`])}`).join(",")}}}`);
  fs.writeFileSync(join(root, "panes"), harnesses.map((h, i) => `fixture\tfixture:${i}.0\t%${i}\t${h}\t${100 + i}\t1:1\t0\n`).join(""));
  fs.writeFileSync(join(root, "watch/arm.json"), JSON.stringify({ armed_at: 100 }));
  fs.writeFileSync(join(bin, "tmux"), `#!/bin/sh
printf '%s\\n' "$*" >> "$SNAPSHOT_LOG"
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
 list-sessions) printf 'fixture\\t1:1\\t1\\n' ;;
 list-panes) cat "$SNAPSHOT_PANES" ;;
 display-message)
   case "$*" in
     *pane_id*) target=""; prev=""; for arg in "$@"; do [ "$prev" = -t ] && target="$arg"; prev="$arg"; done
       case "$target" in %*) printf '%s\\n' "$target" ;; *) target="\${target#*:}"; printf '%%%s\\n' "\${target%%.*}" ;; esac ;;
     *) printf '1:1\\n' ;;
   esac ;;
 capture-pane) printf 'Stable work output\\nWorking (1s • esc to interrupt)\\nesc interrupt\\n80%% context left\\n' ;;
 *) exit 1 ;;
esac
`, { mode: 0o755 });
  Object.assign(process.env, { PATH: `${bin}:${saved.PATH}`, TAP_SERVER_EPOCH: "srv:1:1", TAP_BOOT_ID: "boot:fixture",
    TAP_WATCH_NOW: "2000", SNAPSHOT_LOG: log, SNAPSHOT_PANES: join(root, "panes") });
  const read = spyOn(fs, "readFileSync");
  try {
    const tick = realTickSeams({ bus: root, scripts: join(root, "scripts"), registry, env: process.env, team: "fixture" });
    const roster = tick.roster()!;
    expect(roster.map(r => r.handle)).toEqual(handles);
    tick.detector("context-pressure", ["100", "2000", "40", ""], roster);
    tick.detector("codex-livelock", ["100", "2000", "300", "leader"], roster);
    tick.detector("context-freeze", ["100", "2000", "leader"], roster);
    tick.detector("opencode-wedge", ["100", "2000", "leader"], roster);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    const captures = calls.filter(c => c.includes("capture-pane"));
    console.log(`watch snapshot: ${calls.length} tmux children, ${captures.length} captures for ${harnesses.length} seats`);
    expect(captures).toHaveLength(4); // cursor does not participate in these detectors
    expect(calls.filter(c => c.includes("display-message"))).toHaveLength(0);
    expect(read.mock.calls.filter(c => c[0] === registry)).toHaveLength(1);
    expect(calls.filter(c => c.includes("list-panes"))).toHaveLength(1);
    // Reusing this tick at a later wall clock must not advance a cached frame's sample.
    const before = JSON.parse(fs.readFileSync(join(root, "watch/arm.json"), "utf8")).context_freeze;
    tick.detector("context-freeze", ["100", "2301", "leader"], roster);
    expect(JSON.parse(fs.readFileSync(join(root, "watch/arm.json"), "utf8")).context_freeze).toEqual(before);
    const wedge = JSON.parse(fs.readFileSync(join(root, "watch/arm.json"), "utf8")).opencode_wedge;
    expect(JSON.parse(wedge).s3.at).toBe(2000);
    expect(tick.detector("opencode-wedge", ["100", "2301", "leader"], roster)).toBe(0);
    expect(JSON.parse(fs.readFileSync(join(root, "watch/arm.json"), "utf8")).opencode_wedge).toEqual(wedge);
  } finally {
    read.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    removeScratchTree(root);
  }
});
