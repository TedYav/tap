// tap-gridx: `tap nudge --interrupt` proven against genuinely wedged panes on a
// private tmux server. Each family's seat runs support/wedged-harness.sh under a
// bash binary copied to the family's name, registered through the real
// `tap register`. A wedged pane drops every typed byte until its family's
// interrupt key arrives, so a delivered note proves the keys fell first; a pane
// no key can free proves the outcome line never claims delivery it did not see.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeScratchTree } from "./support/scratch";

const MAIN = join(import.meta.dir, "..", "main.ts");
const HARNESS = join(import.meta.dir, "support", "wedged-harness.sh");
const SOCKET = `tap-nudge-live-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const TEAM = "alpha";
const FAMILIES = ["claude", "codex", "agy", "opencode", "cursor", "hermes"] as const;
let root: string, wt: string, bus: string, index: string, bindir: string, registryPath: string;
// The specimen's team: a second enrolled checkout the caller is not inside.
let metaRoot: string, metaBus: string, metaRegistry: string;
let jobs = 0;
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bindir}:${process.env.PATH}`, TAP_HOME: bus, TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(index, "sessions.json"), OPENCODE_DB_PATH: join(index, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(index, "version-seen.json"), TAP_LOCK_DIR: join(index, "locks"),
    TAP_TMUX_SOCKET: SOCKET, TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_SELF: undefined, TAP_EPOCH: undefined,
    TAP_TUI_SETTLE_SCALE: "0.2", TMUX: undefined, TMUX_PANE: undefined, ...extra } as NodeJS.ProcessEnv;
}
function tmux(...args: string[]) {
  return Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
}
function tap(args: string[], extra: Record<string, string | undefined> = {}, cwd = wt) {
  const r = Bun.spawnSync(["bun", MAIN, ...args], { cwd, env: env(extra), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
async function until(predicate: () => boolean, detail: string, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(detail);
    await Bun.sleep(20);
  }
}
const dirOf = (seat: string) => join(root, "wedge", seat);
const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";

async function wedge(seat: string, family: string, key = "", cwd = wt): Promise<void> {
  const dir = dirOf(seat);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cmd = `${key ? `WEDGE_KEY=${key} ` : ""}${quote(join(bindir, family))} ${quote(HARNESS)} ${family} ${quote(dir)}`;
  const created = tmux("new-session", "-d", "-s", seat, "-x", "120", "-y", "30", "-c", cwd, cmd);
  expect(created.exitCode, created.stderr.toString()).toBe(0);
  await until(() => read(join(dir, "state")).trim() === "work", `${seat} never painted its wedge`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tap-nudge-live.")); wt = join(root, TEAM);
  bus = join(wt, ".tap", "bus"); index = join(root, "index"); bindir = join(root, "bin");
  registryPath = join(wt, ".tap", "team-registry.json");
  for (const path of [join(bus, "payloads"), join(bus, "receipts"), index, bindir]) mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", wt]);
  const realTmux = Bun.which("tmux");
  if (!realTmux) throw new Error("the live interrupt proof requires tmux");
  writeFileSync(join(bindir, "tmux"), `#!/bin/sh\nexec ${quote(realTmux)} -L ${quote(SOCKET)} "$@"\n`, { mode: 0o755 });
  const bash = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", ...(process.platform === "linux" ? [Bun.which("bash") ?? ""] : [])]
    .find(p => p && existsSync(p));
  if (!bash) throw new Error("the live interrupt proof requires a copyable bash");
  for (const family of FAMILIES) {
    copyFileSync(bash, join(bindir, family));
    Bun.spawnSync(["chmod", "+x", join(bindir, family)]);
  }
  metaRoot = join(root, "beta"); metaBus = join(metaRoot, ".tap", "bus"); metaRegistry = join(metaRoot, ".tap", "team-registry.json");
  for (const path of [join(metaBus, "payloads"), join(metaBus, "receipts")]) mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", metaRoot]);
  writeFileSync(metaRegistry, JSON.stringify({ schema: "0.20", team: { name: "beta", worktree_root: metaRoot }, seats: {
    jevver: { status: "active", delivery: "poll", harness: "claude", instance: "jevver|1", registered_at: "2026-10-01T00:00:00Z" },
  } }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {
    [TEAM]: { root: wt, registry_location: registryPath, state: "registered" },
    beta: { root: metaRoot, registry_location: metaRegistry, state: "registered" },
  } }));
  writeFileSync(registryPath, JSON.stringify({ schema: "0.20", team: { name: TEAM, worktree_root: wt }, seats: {
    lead: { status: "active", delivery: "poll", harness: "codex", instance: "lead|1", registered_at: "2026-10-01T00:00:00Z" },
    // Shares beta's sender handle: a pinned nudge must never send from this one.
    jevver: { status: "active", delivery: "poll", harness: "claude", instance: "alpha-jevver|1", registered_at: "2026-10-01T00:00:00Z" },
  } }));
});
afterAll(() => { tmux("kill-server"); removeScratchTree(root); });

async function seat(family: string, key = "", handle = `w-${family}${key ? "-stuck" : ""}`, team = TEAM): Promise<string> {
  await wedge(handle, family, key, team === TEAM ? wt : metaRoot);
  const registered = team === TEAM ? tap(["register", handle, "--pane", `${handle}:0.0`])
    : tap(["register", handle, "--pane", `${handle}:0.0`], { TAP_HOME: metaBus }, metaRoot);
  expect(registered.code, registered.stderr).toBe(0);
  return handle;
}

for (const family of FAMILIES) {
  test(`${family}: the interrupt frees a wedged pane and the continue note is submitted`, async () => {
    const handle = await seat(family);
    const r = tap(["nudge", "--interrupt", `${TEAM}/${handle}`, "--reason", "api timeout"], { TAP_SELF: "lead" });
    const pane = tmux("capture-pane", "-p", "-t", `${handle}:0.0`).stdout.toString();
    const why = `${r.stdout}\n${r.stderr}\n${pane}`;
    expect(r.code, why).toBe(0);
    // hermes has no key: the bare submit is the interrupt, and the courier's
    // no-prompt hermes submit cannot verify consumption, so it says queued.
    expect(r.stdout, why).toContain(family === "hermes"
      ? `tap nudge: ${TEAM}/${handle}  interrupted; note queued (queued-harness)`
      : `tap nudge: ${TEAM}/${handle}  interrupted (delivered)`);
    if (family !== "hermes") expect(read(join(dirOf(handle), "keys"))).toBe("interrupted\n");
    expect(read(join(dirOf(handle), "submitted"))).toMatch(/\[\[TAP v0\.23 note \S+ urgent/);
  }, 60_000);
}


test("a pane no key can free: the outcome says UNVERIFIED, exit 5, never delivered", async () => {
  const handle = await seat("claude", "none");
  const r = tap(["nudge", "--interrupt", "--to", `${TEAM}/${handle}`], { TAP_SELF: "lead" });
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(5);
  expect(r.stdout).toContain(`tap nudge: ${TEAM}/${handle}  interrupted; note UNVERIFIED (possible effect; do not re-nudge)`);
  expect(r.stdout).not.toContain("interrupted (delivered)");
  expect(read(join(dirOf(handle), "submitted"))).toBe("");
}, 60_000);

// The specimen (tap-gridx): a caller that is no seat, naming the sender and the
// target on another team, from inside a different enrolled checkout and from
// outside every enrolled checkout. No TAP_HOME, no TAP_SELF, no tmux pane.
for (const [label, cwd] of [["inside another team's checkout", () => wt], ["outside every enrolled checkout", () => root]] as const) {
  test(`cross-team interrupt with --from team/seat, ${label}`, async () => {
    const handle = await seat("claude", "", `m-${label.split(" ")[0]}`, "beta");
    const r = tap(["nudge", "--interrupt", `beta/${handle}`, "--from", "beta/jevver"], { TAP_HOME: undefined }, cwd());
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`tap nudge: beta/${handle}  interrupted (delivered)`);
    const submitted = read(join(dirOf(handle), "submitted"));
    const id = submitted.match(/note (\S+) urgent/)?.[1] ?? "";
    expect(readFileSync(join(metaBus, "payloads", `${id}.md`), "utf8")).toMatch(/^from: jevver$/m);
  }, 60_000);
}

// Review (astra-ponytail): TAP_HOME decides the bus, and send must not
// re-resolve it from an enrolled cwd whose team has a seat of the same name.
test("a TAP_HOME pin is honoured through the send, even from another team's checkout with the same sender handle", async () => {
  const handle = await seat("claude", "", "m-pinned", "beta");
  const r = tap(["nudge", "--interrupt", `beta/${handle}`, "--from", "jevver"], { TAP_HOME: metaBus }, wt);
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
  const id = read(join(dirOf(handle), "submitted")).match(/note (\S+) urgent/)?.[1] ?? "";
  expect(readFileSync(join(metaBus, "payloads", `${id}.md`), "utf8")).toMatch(/^from: jevver$/m);
  expect(existsSync(join(bus, "payloads", `${id}.md`))).toBe(false);
}, 60_000);

test("without --from, the unregistered caller is told the two recoveries that work", async () => {
  const handle = await seat("claude", "", "m-no-sender", "beta");
  const r = tap(["nudge", "--interrupt", `beta/${handle}`], { TAP_HOME: undefined }, root);
  expect(r.code).toBe(1);
  // Under a caller with a terminal this is "not a registered seat and is not
  // interactive"; under one with no controlling terminal in its ancestry (a
  // compute daemon) the seat question is unobservable. Both refuse with the
  // same two recoveries, and neither sends.
  expect(r.stderr).toContain("pass --from <seat|team/seat>, or run from an interactive terminal to send as the operator");
  expect(read(join(dirOf(handle), "submitted"))).toBe("");
  const inside = tap(["nudge", "--interrupt", `beta/${handle}`], { TAP_HOME: undefined }, wt);
  expect(inside.stderr).toContain("pass --from <seat|team/seat>, or run from an interactive terminal to send as the operator");
}, 60_000);

// Review (Codex): a named --team anchors the fan-out's operator sender from
// outside every enrolled checkout, as a team/peer target does for the interrupt.
test("a fan-out naming --team reaches the sender question from outside every enrolled checkout", async () => {
  await seat("claude", "", "m-fanout-anchor", "beta");
  const r = tap(["nudge", "--harness", "claude", "--team", "beta", "--dry-run"], { TAP_HOME: undefined }, root);
  expect(r.stderr).not.toContain("unanchored_bus");
  expect(r.stderr).not.toContain("name the team");
  expect(r.stderr).toContain("pass --from <seat|team/seat>, or run from an interactive terminal to send as the operator");
}, 60_000);

/** Hand one command to a pane: an interactive shell sources it; an agent loop reads the bare path.
 * stdout always goes to a file; stderr stays on the pane's terminal when `ttyStderr` (a prompt). */
function startInPane(target: string, args: string[], cwd: string, opts: { agentLoop?: boolean; ttyStderr?: boolean } = {}) {
  const prefix = join(root, `job-${++jobs}`);
  const vars = Object.entries(env({ TAP_HOME: undefined })).filter(([name, value]) => value !== undefined && name.startsWith("TAP_"))
    .map(([name, value]) => `${name}=${quote(value!)}`);
  writeFileSync(`${prefix}.sh`, `cd ${quote(cwd)} && env -u TAP_SELF -u TAP_HOME ${vars.join(" ")} PATH=${quote(env().PATH!)} ` +
    `bun ${quote(MAIN)} ${args.map(quote).join(" ")} >${quote(prefix + ".out")}${opts.ttyStderr ? "" : ` 2>${quote(prefix + ".err")}`}\n` +
    `printf '%s' "$?" >${quote(prefix + ".rc.tmp")}; mv ${quote(prefix + ".rc.tmp")} ${quote(prefix + ".rc")}\n`);
  expect(tmux("send-keys", "-t", target, "-l", opts.agentLoop ? `${prefix}.sh` : `. ${quote(prefix + ".sh")}`).exitCode).toBe(0);
  expect(tmux("send-keys", "-t", target, "Enter").exitCode).toBe(0);
  return { async finish() {
    await until(() => existsSync(`${prefix}.rc`), `pane command did not finish: ${args.join(" ")}`, 30);
    return { code: Number(read(`${prefix}.rc`)), stdout: read(`${prefix}.out`), stderr: read(`${prefix}.err`) };
  } };
}
const screen = (target: string) => tmux("capture-pane", "-p", "-J", "-t", target).stdout.toString();

async function operatorPane(name: string): Promise<string> {
  expect(tmux("new-session", "-d", "-s", name, "-x", "200", "-y", "30", "-c", root, "/bin/bash --norc --noprofile").exitCode).toBe(0);
  await Bun.sleep(300);
  return `${name}:0.0`;
}

test("from a person's own terminal (no seat, a TTY): the prompt asks, Enter sends as the operator", async () => {
  const handle = await seat("codex", "", "m-operator", "beta");
  const pane = await operatorPane("operator");
  const job = startInPane(pane, ["nudge", "--interrupt", "--to", `beta/${handle}`, "--reason", "Internet dropout"], root, { ttyStderr: true });
  await until(() => screen(pane).includes("Send this nudge as you (the operator)? [Y/n]"), "the operator prompt never appeared", 20);
  expect(tmux("send-keys", "-t", pane, "Enter").exitCode).toBe(0);
  const r = await job.finish();
  expect(r.code, `${r.stdout}\n${screen(pane)}`).toBe(0);
  expect(r.stdout).toContain(`tap nudge: beta/${handle}  interrupted (delivered)`);
  const id = read(join(dirOf(handle), "submitted")).match(/note (\S+) urgent/)?.[1] ?? "";
  const payload = readFileSync(join(metaBus, "payloads", `${id}.md`), "utf8");
  expect(payload).toMatch(/^from: user$/m);
  expect(payload).toContain("Nudge: Internet dropout. Continue what you were working on.");
  // The recovery the help gives for exit 5 works for the operator too.
  // Exit 2 is "some outstanding": the fake recipient never runs tap read.
  const owed = tap(["outstanding", "user"], { TAP_HOME: metaBus }, metaRoot);
  expect(owed.code, owed.stderr).toBe(2);
  expect(owed.stdout).toContain(id);
  // The operator identity can never be claimed as a seat.
  const claimed = tap(["register", "user", "--pane", pane]);
  expect(claimed.code).not.toBe(0);
  expect(claimed.stderr).toContain("reserved operator identity");
  // Only the prompted nudge sends as the operator; plain send can neither send as it nor to it.
  const forged = tap(["send", "lead", "--from", "user", "-m", "hello"]);
  expect(forged.code).toBe(1);
  expect(forged.stderr).toContain("'user' is the reserved operator identity; only 'tap nudge', run from a person's own terminal, sends as it");
  const addressed = tap(["send", "user", "-m", "hello"], { TAP_SELF: "lead" });
  expect(addressed.code).toBe(1);
  expect(addressed.stderr).toContain("'user' is the reserved operator identity and can never receive a send");
}, 90_000);

test("the person says no: nothing sent, exit 1, the wedge untouched", async () => {
  const handle = await seat("claude", "", "m-declined", "beta");
  const pane = await operatorPane("declines");
  const job = startInPane(pane, ["nudge", "--interrupt", "--to", `beta/${handle}`], root, { ttyStderr: true });
  await until(() => screen(pane).includes("[Y/n]"), "the operator prompt never appeared", 20);
  expect(tmux("send-keys", "-t", pane, "-l", "n").exitCode).toBe(0);
  expect(tmux("send-keys", "-t", pane, "Enter").exitCode).toBe(0);
  const r = await job.finish();
  expect(r.code).toBe(1);
  expect(screen(pane)).toContain("not sent as the operator; nothing sent");
  expect(read(join(dirOf(handle), "keys"))).toBe("");
  expect(read(join(dirOf(handle), "state")).trim()).toBe("work");
}, 90_000);

test("a target that cannot be nudged refuses before the operator is asked", async () => {
  const pane = await operatorPane("no-target");
  const r = await startInPane(pane, ["nudge", "--interrupt", "--to", "beta/ghost"], root, { ttyStderr: true }).finish();
  expect(r.code).toBe(1);
  const shown = screen(pane);
  expect(shown).toContain("'beta/ghost' is not a registered seat on team 'beta'; nothing sent");
  expect(shown).not.toContain("[Y/n]");
}, 60_000);

test("a registered seat's pane is never asked: it sends as the seat", async () => {
  const handle = await seat("opencode", "", "w-for-seat");
  const agent = join(root, "agent.sh");
  writeFileSync(agent, "printf '\\n> '\nwhile IFS= read -r script; do [ ! -f \"$script\" ] || . \"$script\"; printf '\\n> '; done\n");
  expect(tmux("new-session", "-d", "-s", "seatpane", "-c", wt, `${quote(join(bindir, "claude"))} ${quote(agent)}`).exitCode).toBe(0);
  await Bun.sleep(300);
  const registered = tap(["register", "opseat", "--pane", "seatpane:0.0"]);
  expect(registered.code, registered.stderr).toBe(0);
  const r = await startInPane("seatpane:0.0", ["nudge", "--interrupt", "--to", `${TEAM}/${handle}`], wt, { agentLoop: true }).finish();
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
  expect(r.stderr).not.toContain("[Y/n]");
  const id = read(join(dirOf(handle), "submitted")).match(/note (\S+) urgent/)?.[1] ?? "";
  expect(readFileSync(join(bus, "payloads", `${id}.md`), "utf8")).toMatch(/^from: opseat$/m);
  // The same seat's terminal, acting from another team's checkout: it is still
  // that seat, so it is told to name itself rather than asked to be the operator.
  const meta = await seat("claude", "", "m-from-other-seat", "beta");
  const other = await startInPane("seatpane:0.0", ["nudge", "--interrupt", "--to", `beta/${meta}`], metaRoot, { agentLoop: true }).finish();
  expect(other.code).toBe(1);
  expect(other.stderr).toContain(`this pane is seat 'opseat' on team '${TEAM}', not a seat on 'beta'; nothing sent`);
  expect(other.stderr).toContain(`pass --from ${TEAM}/opseat`);
  expect(read(join(dirOf(meta), "keys"))).toBe("");
}, 90_000);
