import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { paneIdentityCensus } from "../src/pane-census";
import { removeScratchTree } from "./support/scratch";

for (const state of ["registered", [], {}]) test(`census includes registered state ${JSON.stringify(state)} and discriminates stale claims without writes`, () => {
  const root = mkdtempSync(join(tmpdir(), "pane-census-"));
  try {
    const index = join(root, "index"), bin = join(root, "bin"), log = join(root, "calls");
    mkdirSync(index); mkdirSync(bin);
    const registry = join(root, "registry.json"), global = join(index, "global-registry.json");
    writeFileSync(global, JSON.stringify({ schema: "0.20", teams: { t: { root, registry_location: registry, state } } }));
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "t" }, seats: {
      malformed: null,
      peer: { pane_id: "%1", session: "t/peer", server_epoch: "srv:44:55" },
      old: { pane_id: "%1", session: "old/peer", server_epoch: "srv:1:2" },
      missing: { pane_id: "%2", session: "t/missing", server_epoch: "srv:44:55" },
    } }));
    writeFileSync(join(bin, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CENSUS_LOG"\ncase "$1" in\n display-message) [ "$4" = "%1" ] || exit 1; printf "%%1\\tt/peer\\t44:55\\n";;\n list-panes) printf "%%1\\n%%3\\n";;\nesac\n', { mode: 0o755 });
    const env = { ...process.env, TAP_INDEX_HOME: index, TAP_TMUX_SOCKET: undefined, TAP_TMUX_SOCKET_PATH: undefined, TMUX: undefined, TAP_SERVER_EPOCH: undefined, CENSUS_LOG: log, PATH: `${bin}:${process.env.PATH}` };
    const before = [readFileSync(registry, "utf8"), readFileSync(global, "utf8")];
    const result = paneIdentityCensus(env);
    expect(result.code).toBe(0);
    expect(result.text).toContain("1 correct, 1 refused, 0 UNJUSTIFIED");
    expect(result.text).toContain("t/old(srv:1:2)");
    expect(result.text).toContain("blind spot: 1 live pane");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.filter(c => c.startsWith("display-message"))).toHaveLength(2);
    expect(calls[0]).toContain("#{pane_id}\t#{session_name}\t#{pid}:#{start_time}");
    expect([readFileSync(registry, "utf8"), readFileSync(global, "utf8")]).toEqual(before);
    writeFileSync(global, "invalid");
    expect(paneIdentityCensus(env).code).toBe(1);
  } finally { removeScratchTree(root); }
});
