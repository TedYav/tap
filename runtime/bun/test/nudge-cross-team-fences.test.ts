// Cross-team nudge fences and post-Enter observation failures (a reviewer's
// probe, adopted). The canonical payload lives on the SENDER's
// bus while the recipient team's fences live on its own; both must refuse.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetFenceRefusal } from "../src/reset";
import { removeScratchTree } from "./support/scratch";

type Fence = "none" | "Sender" | "Target" | "Target-clear" | "Sender-clear";
function fixture(fenced: Fence, afterEnterReadFails = false, sentinelRecipient?: "other") {
  const dir = realpathSync(mkdtempSync(join(process.env.TAP_HOME!, "nudge-xteam-fence-")));
  const bin = join(dir, "bin"), index = join(dir, "index");
  mkdirSync(bin); mkdirSync(index);
  const teams: Record<string, object> = {};
  const homes: Record<string, string> = {};
  for (const name of ["Sender", "Target"]) {
    const root = join(dir, name), bus = join(root, ".tap/bus"), registry = join(root, ".tap/team-registry.json");
    mkdirSync(join(bus, "payloads"), { recursive: true }); mkdirSync(join(bus, "receipts"));
    homes[name] = bus;
    teams[name] = { root, registry_location: registry, state: "registered" };
    const seat = (handle: string, pane: string, paneId: string) => ({ status: "active", pane, pane_id: paneId, session: `Target/${handle}`,
      harness: "codex", server_epoch: "srv:900:100", boot_id: "boot:1" });
    writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name }, seats: name === "Sender" ? {} : {
      peer: seat("peer", "Target/peer:0.0", "%301"),
      // A second Target seat, so a bare `to: other` names a real seat on the argv team.
      ...(sentinelRecipient ? { [sentinelRecipient]: seat(sentinelRecipient, `Target/${sentinelRecipient}:0.0`, "%302") } : {}),
    } }));
  }
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams }));
  const id = "sender-20260907T000000Z-abcd";
  writeFileSync(join(homes.Sender!, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: sender\nto: ${sentinelRecipient ?? "peer"}\n${sentinelRecipient ? "" : "to_team: Target\n"}kind: note\nreply: settle-only\n---\nFixture.\n`);
  writeFileSync(join(dir, "frame"), `› [[TAP v0.23 note Sender/${id}]]\n`);
  writeFileSync(join(dir, "effects"), "");
  writeFileSync(join(bin, "tmux"), `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
const root=process.env.FAKE_ROOT, args=process.argv.slice(2);
while (["-L","-S"].includes(args[0])) args.splice(0,2);
const cmd=args[0], fmt=args.at(-1);
if (cmd==="display-message") {
 const fields={"#{pid}:#{start_time}":"900:100", "#{pane_id}\\t#{session_name}\\t#{pane_pid}\\t#{pane_current_command}\\t#{pane_dead}":"%301\\tTarget/peer\\t301\\tcodex\\t0",
 "#{pane_id}":"%301", "#{pane_current_command}":"codex", "#{pane_pid}":"301", "#{pane_in_mode}":"0", "#{pane_dead}":"0", "#{session_windows}":"1", "#{pane_width}":"100"};
 console.log(fields[fmt] ?? "");
} else if (cmd==="list-sessions") console.log("Target/peer\\t900:100\\t0");
else if (cmd==="list-panes") console.log(fmt==="#{pane_id}" ? "%301" : "Target/peer\\tTarget/peer:0.0\\t%301\\tcodex\\t301\\t900:100\\t0");
else if (cmd==="capture-pane") {
 const phases=root+"/Sender/.tap/bus/receipts/sender-20260907T000000Z-abcd.submit-phases.jsonl";
 if(process.env.REVIEW_FAIL_AFTER_SENT==="1" && existsSync(phases) && readFileSync(phases,"utf8").includes("Enter-sent")) {
   process.stderr.write("fork failed: Device not configured"); process.exit(1);
 }
 process.stdout.write(readFileSync(root+"/frame"));
}
else if (cmd==="send-keys") { appendFileSync(root+"/effects",args.join(" ")+"\\n"); if(args.includes("Enter")) writeFileSync(root+"/frame","› \\n"); }
`, { mode: 0o700 });
  if (fenced === "Sender" || fenced === "Target") {
    writeFileSync(join(homes[fenced]!, "reset.fence.json"), "{}\n");
    expect(resetFenceRefusal(homes[fenced]!, "probe")).not.toBeNull();
  } else if (fenced !== "none") {
    // A live mid-clear marker for a seat named `peer`, on one bus only.
    const home = homes[fenced === "Target-clear" ? "Target" : "Sender"]!;
    mkdirSync(join(home, "clear-fence"), { recursive: true });
    writeFileSync(join(home, "clear-fence", "peer.json"), JSON.stringify({ since_epoch: Date.now() / 1000, ceiling_seconds: 600 }));
  }
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), PATH: `${bin}:${process.env.PATH}`,
    FAKE_ROOT: dir, TAP_HOME: homes.Sender!, TAP_INDEX_HOME: index, TAP_BOOT_ID: "boot:1",
    TAP_SERVER_EPOCH: "srv:900:100", TAP_TUI_SETTLE_SCALE: "0.01", REVIEW_FAIL_AFTER_SENT: afterEnterReadFails ? "1" : "0" };
  const r = spawnSync("bun", [join(import.meta.dir, "support/nudge-cross-team-entry.ts")], { cwd: join(dir, "Sender"), env, encoding: "utf8", timeout: 25000 });
  return { dir, r, effects: readFileSync(join(dir, "effects"), "utf8") };
}

test("observation failure after nudge Enter retains unverified exit and terminal phase", () => {
  const f = fixture("none", true);
  try {
    const phases = readFileSync(join(f.dir, "Sender/.tap/bus/receipts/sender-20260907T000000Z-abcd.submit-phases.jsonl"), "utf8");
    expect(f.effects.split("\n").filter(line => line.endsWith(" Enter"))).toHaveLength(1);
    expect(f.r.status).toBe(5);
    expect(phases).toContain('"phase":"verify-result"');
    // The terminal record keeps the one possible Enter.
    const final = phases.trim().split("\n").map(line => JSON.parse(line)).find(p => p.phase === "verify-result");
    expect(final.result).toBe("unverified"); expect(final.enter_count).toBe(1);
  } finally { removeScratchTree(f.dir); }
}, 30000);

for (const fence of ["none", "Sender", "Target", "Target-clear", "Sender-clear"] as const) {
  test(`cross-team nudge respects a ${fence} fence`, () => {
    const f = fixture(fence);
    try {
      // A clear marker for a same-named seat on the SENDER's bus is someone else's.
      if (fence === "none" || fence === "Sender-clear") { expect(f.r.status).toBe(0); expect(f.effects).toContain("Enter"); }
      else { expect(f.effects).toBe(""); expect(f.r.status).not.toBe(0); }
    } finally { removeScratchTree(f.dir); }
  }, 30000);
}

// nudge.ts qualifies a BARE payload recipient with the argv team, then refuses when the
// qualified sentinel identity differs from the argv target — before any pane effect (tap-qgg4).
test("a bare to: naming a different seat on the argv team refuses before any pane effect", () => {
  const f = fixture("none", false, "other");
  try {
    expect(f.r.status).toBe(1);
    expect(f.r.stderr).toContain("argv target 'Target/peer' disagrees with stuck sentinel to='Target/other'");
    expect(f.effects).toBe("");
  } finally { removeScratchTree(f.dir); }
}, 30000);
