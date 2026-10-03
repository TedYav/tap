import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Spawn-count regression pins for `tap in`'s pre-lock fan-out (launchfast).
 * A PATH-shim farm (tmux/ps/git) logs every subprocess one `tap in` spawns
 * from inside a real private-socket pane, and the pins hold the collapse:
 *
 *  - exactly ONE display-message targeting the caller pane's combined
 *    nine-field record (identity + address + pane pid + command + path +
 *    socket ride one atomic observation);
 *  - ZERO targeted `#{pane_pid}`-only reads (paneHarnessCommand and
 *    callerUnderPane consume the record / revalidation);
 *  - ZERO targetless `#{socket_path}` reads (enrollment and prepare read the
 *    record's socket);
 *  - exactly TWO `ps -Ao` scans: the per-invocation classification memo
 *    (pre-lock) and the chooser's fresh in-lock gather snapshot.
 */
const tapRoot = realpathSync(join(import.meta.dir, "..", "..", ".."));
const original = { ...process.env };

function fixture(): { root: string; index: string; panePath: string; socket: string; traceFile: string; sid: string } {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR!, "reg-spawn-")));
  const index = join(root, "index"), registry = join(root, "relocated.json");
  for (const dir of [index, join(root, ".tap/bus"), join(root, ".config/tap"), join(root, "bin"), join(root, "real"), join(root, "shims")]) mkdirSync(dir, { recursive: true });
  writeFileSync(registry, JSON.stringify({ schema: "0.20", team: { name: "fixture", worktree_root: root }, seats: {}, extension: { retain: true } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { fixture: { root, registry_location: registry } } }));
  writeFileSync(join(root, ".config/tap/config.toml"), `version = 3\n[harness.claude]\nverbose = true\n`);
  const socket = `regspawn-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const traceFile = join(root, "spawns.log");
  for (const bin of ["tmux", "ps", "git"]) {
    const which = spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8", env: original });
    const real = (which.stdout ?? "").trim();
    if (!real) throw new Error(`no real ${bin} on PATH`);
    writeFileSync(join(root, "shims", bin), `#!/bin/bash\nprintf '%s\\0' "\${0##*/}" "$@" >> '${traceFile}'\nprintf '\\n' >> '${traceFile}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  }
  const bin = join(root, "bin", "claude"), real = join(root, "real", "claude");
  if (process.platform === "linux") {
    const { copyFileSync } = require("node:fs");
    copyFileSync("/bin/sleep", real);
  } else symlinkSync("/bin/sleep", real);
  const sid = `sess-${Math.random().toString(16).slice(2, 10)}`;
  const panePath = `${join(root, "shims")}:${join(root, "bin")}:${original.PATH}`;
  const paneEnv = `HOME='${root}' XDG_CONFIG_HOME='${join(root, ".config")}' TAP_INDEX_HOME='${index}' TAP_TMUX_SOCKET='${socket}' SHELL=/bin/bash`;
  const tapIn = `TAP_REGISTER_LOCK_TIMEOUT=10 TAP_SKIP_VERSION_BRIEFING=1 '${join(tapRoot, "bin/tap")}' in --harness-session-id '${sid}'`;
  writeFileSync(bin, `#!/bin/bash\ncd '${root}'\n( env PATH='${panePath}' ${tapIn} > '${root}/bindout' 2> '${root}/binderr'; touch '${root}/done' ) &\nexec '${real}' 600\n`);
  chmodSync(bin, 0o755);
  return { root, index, panePath, socket, traceFile, sid };
}

test("tap in keeps its pre-lock subprocess fan-out collapsed", () => {
  const { root, index, panePath, socket, traceFile, sid } = fixture();
  try {
    const mk = spawnSync("tmux", ["-L", socket, "new-session", "-d", "-x", "200", "-y", "50",
      `env HOME='${root}' XDG_CONFIG_HOME='${join(root, ".config")}' TAP_INDEX_HOME='${index}' TAP_TMUX_SOCKET='${socket}' PATH='${panePath}' '${join(root, "bin", "claude")}'`], { env: original, encoding: "utf8" });
    expect(mk.status, `new-session failed: ${mk.stderr}`).toBe(0);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !existsSync(join(root, "done"))) {
      spawnSync("sleep", ["0.05"], { env: original, stdio: "ignore" });
    }
    expect(existsSync(join(root, "done")), "tap in did not finish").toBe(true);
    const row = JSON.parse(readFileSync(join(root, "relocated.json"), "utf8")).seats;
    const bound = Object.values(row as Record<string, Record<string, string>>).find(seat => seat.harness_session_id === sid);
    expect(bound, "the bind must succeed for the spawn pins to describe the real flow").toBeTruthy();

    const spawns = readFileSync(traceFile, "utf8").split("\n").filter(l => l.length > 0)
      .map(line => (line.split("\0").filter(p => p.length > 0) as string[]));
    const argvOf = (parts: string[]) => parts.join(" ");
    const profile = () => spawns.map(argvOf).map(a => `\n  ${a}`).join("");
    const displays = spawns.filter(a => a.includes("display-message")).map(argvOf);
    const combined = displays.filter(a => a.includes("pane_tty") && a.includes(" -t ") && a.includes("socket_path"));
    expect(combined.length, `one combined caller record, got: ${combined.join(" | ")}; full profile:${profile()}`).toBe(1);
    const pidOnly = displays.filter(a => a.trim().endsWith("#{pane_pid}"));
    expect(pidOnly.length, `no pane_pid-only reads, got: ${pidOnly.join(" | ")}; full profile:${profile()}`).toBe(0);
    const socketOnly = displays.filter(a => a.trim().endsWith("#{socket_path}") && !a.includes(" -t "));
    expect(socketOnly.length, `no targetless socket reads, got: ${socketOnly.join(" | ")}; full profile:${profile()}`).toBe(0);
    // The server-epoch guard rides the pane observation (one targetless
    // `#{pid}:#{start_time}` read behind the 100 ms identity TTL, so the total
    // is ±1); what must never return is the folded duplicate — two of those
    // reads back to back, the pre-fold serverEpochNow-then-revalidate pair.
    const epochReadIdx = spawns
      .map(parts => argvOf(parts))
      .map((a, i) => (a.includes("display-message") && a.includes("#{pid}:#{start_time}") && !a.includes(" -t ") ? i : -1))
      .filter(i => i >= 0);
    const adjacentPairs = epochReadIdx.filter((idx, n) => n > 0 && idx === epochReadIdx[n - 1]! + 1);
    expect(adjacentPairs.length, `no adjacent targetless epoch reads, got indices [${epochReadIdx.join(", ")}]; full profile:${profile()}`).toBe(0);
    const psAo = spawns.filter(a => a[0] === "ps" && a.includes("-Ao"));
    expect(psAo.length, `one classification memo + one in-lock chooser scan, got: ${psAo.map(argvOf).join(" | ")}`).toBe(2);
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { env: original, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
