import { physicalSocketPath } from "../src/tmux";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchTree } from "./support/scratch";
import { acquirePathLock } from "../src/panelock";
import { enrolledSeatForObservedPane } from "../src/registry";
import { paneEnrollment } from "../src/pane-enrollment";
import { purgeGoneEnrollment } from "../src/index-home";

const ROOT = join(import.meta.dir, "../../..");

// Public-door fixture: every test drives `bin/tap in ...` (the main.ts
// register|in route) against a sandboxed live-marker world with a fixture
// tmux on PATH. The mock answers the caller-pane identity record, the
// chooser's list-panes/list-sessions gather, and the per-pane extras.
function fixture(opts: { sessions?: boolean; panes?: boolean; socketSuffix?: string } = {}) {
  const root = join(tmpdir(), `tap-register-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const index = join(root, "index");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(join(index), { recursive: true });
  mkdirSync(join(home, ".tap"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo), { recursive: true });
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  git(["init", "-q"]);
  git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20", migrated: { at: "2026-01-01T00:00:00Z", backups: {} }, teams: {},
  }));
  const addr = "repo/seat:0.0";
  const epoch = "srv:900:100";
  const tmux = `#!/bin/bash
while [ "\${1:-}" = "-L" ] || [ "\${1:-}" = "-S" ]; do shift 2; done
cmd="\${1:-}"; shift || true
# One server, one socket: every answer — records and targeted reads alike —
# must name the SAME socket or the registration recheck reads a rebirth.
if [ -n "\${TAP_TMUX_SOCKET_PATH:-}" ]; then sock="\$TAP_TMUX_SOCKET_PATH"
elif [ -n "\${TAP_TMUX_SOCKET:-}" ]; then sock="\${TMUX_TMPDIR:-/tmp}/tmux-\$(id -u)/\$TAP_TMUX_SOCKET"
else sock="\${TMUX:-/fake/socket}"; fi
sock="\$sock${opts.socketSuffix ?? ""}"
case "\$cmd" in
  display-message)
    target=""; fmt=""
    while [ "\$#" -gt 0 ]; do
      case "\$1" in -p) shift ;; -t) target="\$2"; shift 2 ;; *) fmt="\$1"; shift ;; esac
    done
    case "\$fmt" in
      *pane_id*pane_tty*session_name*) printf '%%2\\t/dev/t\\trepo/seat\\t900:100\\trepo/seat:0.0\\t4242\\tzsh\\t%s\\t${repo}\\n' "\$sock" ;;
      *pane_id*session_name*pane_pid*pane_current_command*)
        # Scenario counting (SCENARIO_DIR set only by the epoch-move tests):
        # ff read 2 sleeps once, so the NEXT server-identity read is past the
        # 100 ms identity TTL and re-observes the (possibly reborn) server;
        # ff reads 3+ answer the scenario's pane state. Without a scenario
        # every read is live and nothing is written.
        if [ -n "\${SCENARIO_DIR:-}" ]; then n=\$((\$(cat "\$SCENARIO_DIR/ff-count" 2>/dev/null || echo 0)+1)); printf '%s' "\$n" > "\$SCENARIO_DIR/ff-count"; else n=0; fi
        if [ -n "\${SCENARIO_MODE:-}" ] && [ "\$n" -eq 2 ]; then sleep 0.12; fi
        if [ "\$n" -ge 3 ] && [ "\${SCENARIO_MODE:-}" = dead ]; then printf '%%2\\trepo/seat\\t4242\\tzsh\\t1\\n'
        elif [ "\$n" -ge 3 ] && [ "\${SCENARIO_MODE:-}" = gone ]; then printf '\\n'
        else printf '%%2\\trepo/seat\\t4242\\tzsh\\t0\\n'; fi ;;
      *pid*start_time*)
        # The rebirth is keyed to the ff reads, not to a count of identity probes:
        # under load the 100 ms identity TTL can lapse early and move which probe
        # is "the second", so a probe-count key reborn the server at the lock-entry
        # call (identity_unverified) instead of the pre-write call. Identity reads
        # after ff read 2 see the reborn server; earlier ones never do.
        ffn=\$(cat "\${SCENARIO_DIR:-/nonexistent}/ff-count" 2>/dev/null || echo 0)
        if [ -n "\${SCENARIO_REBIRTH:-}" ] && [ "\$ffn" -ge 2 ]; then printf '901:200\\n'; else printf '900:100\\n'; fi ;;
      *pane_id*session_name*pid*start_time*socket_path*) printf '%%2\\trepo/seat\\t900:100\\t%s\\n' "\$sock" ;;
      *pane_id*session_name*pid*start_time*) printf '%%2\\trepo/seat\\t900:100\\n' ;;
      *pane_id*session_name*) printf '%%2\\trepo/seat\\n' ;;
      *pane_id*) printf '%%2\\n' ;;
      *pane_pid*) printf '4242\\n' ;;
      *pane_current_command*) printf 'zsh\\n' ;;
      *pane_current_path*) printf '${repo}\\n' ;;
      *socket_path*)
        if [ -n "\${TAP_TMUX_SOCKET_PATH:-}" ]; then printf '%s${opts.socketSuffix ?? ""}\\n' "\$TAP_TMUX_SOCKET_PATH"
        elif [ -n "\${TAP_TMUX_SOCKET:-}" ]; then printf '%s${opts.socketSuffix ?? ""}\\n' "\${TMUX_TMPDIR:-/tmp}/tmux-\$(id -u)/\$TAP_TMUX_SOCKET"
        else printf '%s${opts.socketSuffix ?? ""}\\n' "\${TMUX:-/fake/socket}"
        fi ;;
      *session_name*window_index*pane_index*) printf 'repo/seat:0.0\\n' ;;
      *) printf '\\n' ;;
    esac ;;
  list-sessions)
${opts.sessions === false ? "    exit 1 ;;" : `    printf 'repo/seat\\t900:100\\t1\\n' ;;`}
  list-panes)
${opts.panes === false ? "    exit 1 ;;" : `    printf 'repo/seat\\trepo/seat:0.0\\t%%2\\tzsh\\t4242\\t900:100\\t0\\n' ;;`}
  *) exit 0 ;;
esac
`;
  writeFileSync(join(bin, "tmux"), tmux);
  chmodSync(join(bin, "tmux"), 0o755);
  const registry = join(repo, ".tap", "team-registry.json");
  const bus = join(repo, ".tap", "bus");
  mkdirSync(bus, { recursive: true });
  const scenario = join(root, "scenario");
  mkdirSync(scenario, { recursive: true });
  const writeRegistry = (doc: Record<string, unknown>) => {
    mkdirSync(join(repo, ".tap"), { recursive: true });
    writeFileSync(registry, `${JSON.stringify({ schema: "0.20", ...doc }, null, 2)}\n`);
  };
  writeRegistry({ schema: "0.20", team: { name: "repo", worktree_root: repo }, seats: {} });
  // Pin the fixture's socket world to its own physical path. The runner's ambient
  // TMUX_TMPDIR sits under /tmp (a symlink to /private/tmp on macOS), and
  // physicalSocketPath realpaths that spelling only once the tmux uid dir exists,
  // so an unpinned fixture compares /private/tmp against the mock's raw /tmp
  // depending on load (tap-md1g7). Resolving the root here makes both sides agree.
  const socketPath = join(realpathSync(root), "tmux.sock");
  const env = (extra: NodeJS.ProcessEnv = {}) => {
    const { TAP_HOME: _runnerTapHome, ...ambient } = process.env;
    return ({
      ...ambient, HOME: home, TAP_INDEX_HOME: index, TAP_SESSION_MANIFEST: join(root, "sessions.json"),
      TAP_TMUX_SOCKET_PATH: socketPath,
    PATH: `${bin}:${process.env.PATH}`, TMUX: "/fake/socket", TMUX_PANE: "%2",
    TAP_SKIP_VERSION_BRIEFING: "1", ...extra,
    });
  };
  const door = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = Bun.spawnSync([join(ROOT, "bin/tap"), "in", ...args], {
      cwd: repo, env: env(extra), stdout: "pipe", stderr: "pipe", timeout: 60000,
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const seats = (): Record<string, Record<string, unknown>> => {
    const doc = JSON.parse(readFileSync(registry, "utf8")) as { seats?: Record<string, Record<string, unknown>> };
    return doc.seats ?? {};
  };
  return { root, index, home, repo, bin, addr, epoch, registry, bus, scenario, writeRegistry, env, door, seats };
}

function enrollPair(f: ReturnType<typeof fixture>) {
  const other = join(f.root, "other");
  const otherRegistry = join(other, ".tap", "team-registry.json");
  mkdirSync(join(other, ".tap"), { recursive: true });
  writeFileSync(otherRegistry, JSON.stringify({ schema: "0.20",
    team: { name: "other", worktree_root: other },
    seats: { incumbent: { status: "active", delivery: "pane", pane: f.addr,
      pane_id: "%2", server_epoch: f.epoch, server_socket: physicalSocketPath(f.env()), harness: "zsh",
      session: "repo/seat", instance: "incumbent|original" } } }));
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({
    schema: "0.20", teams: {
      repo: { root: f.repo, registry_location: f.registry, state: "registered" },
      other: { root: other, registry_location: otherRegistry, state: "registered" },
    },
  }));
  return otherRegistry;
}

test("register refuses a pane already active in another enrolled team without row or mail effects", () => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    const original = [readFileSync(f.registry, "utf8"), readFileSync(otherRegistry, "utf8")];
    mkdirSync(join(f.bus, "payloads"), { recursive: true });
    const payload = join(f.bus, "payloads", "pending.md");
    writeFileSync(payload, "---\nid: pending\nto: incumbent\n---\nretain me\n");
    const r = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect({ code: r.code, out: r.out, err: r.err }).toMatchObject({ code: 1 });
    expect(r.out).toContain("pane_enrolled_elsewhere");
    expect(r.out).toContain("other");
    expect(r.out).toContain("incumbent");
    expect([readFileSync(f.registry, "utf8"), readFileSync(otherRegistry, "utf8")]).toEqual(original);
    expect(readFileSync(payload, "utf8")).toBe("---\nid: pending\nto: incumbent\n---\nretain me\n");
  } finally { removeScratchTree(f.root); }
});

test("same-team registration remains available when no other pane claim exists", () => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    const other = JSON.parse(readFileSync(otherRegistry, "utf8"));
    other.seats = {};
    writeFileSync(otherRegistry, JSON.stringify(other));
    const first = f.door(["local-seat", "--pane", f.addr, "--json"]);
    expect({ code: first.code, out: first.out, err: first.err }).toMatchObject({ code: 0 });
    const instance = f.seats()["local-seat"]!.instance;
    const second = f.door(["local-seat", "--pane", f.addr, "--json"]);
    expect({ code: second.code, out: second.out, err: second.err }).toMatchObject({ code: 0 });
    expect(f.seats()["local-seat"]!.instance).toBe(instance);
  } finally { removeScratchTree(f.root); }
});

const indexTeams = (f: ReturnType<typeof fixture>): Record<string, unknown> =>
  JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8")).teams;

// Pre-write revalidation under a server rebirth: the mock's server-identity
// read answers a new pid:start_time from its second spawn, and the one-shot
// sleep at ff read 2 puts the pre-write identity read past the 100 ms TTL so
// the reborn server is what the pre-write call observes.
for (const scenario of [
  { mode: "dead", rebirth: true, expected: "server_epoch_moved" },
  { mode: "gone", rebirth: true, expected: "server_epoch_moved" },
  { mode: "dead", rebirth: false, expected: "pane_dead" },
] as const) test(`a ${scenario.rebirth ? "reborn server with a " : "same-epoch "}target gone ${scenario.mode} at the pre-write revalidation refuses ${scenario.expected}`, () => {
  const f = fixture();
  try {
    const extra: NodeJS.ProcessEnv = { SCENARIO_DIR: f.scenario, SCENARIO_MODE: scenario.mode };
    if (scenario.rebirth) extra.SCENARIO_REBIRTH = "1";
    const r = f.door(["new-seat", "--pane", f.addr, "--json"], extra);
    expect({ code: r.code, out: r.out, err: r.err }).toMatchObject({ code: 1 });
    expect(r.out + r.err).toContain(scenario.expected);
    expect(f.seats()["new-seat"]).toBeUndefined();
  } finally { removeScratchTree(f.root); }
});

test.each(["missing", "bad-json", "directory"])("a %s foreign registry under a live root never blocks registration and is never purged", fault => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    unlinkSync(otherRegistry);
    if (fault === "bad-json") writeFileSync(otherRegistry, "{broken");
    else if (fault === "directory") mkdirSync(otherRegistry);
    const r = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect({ code: r.code, out: r.out, err: r.err }).toMatchObject({ code: 0 });
    expect(f.seats()["new-seat"]!.pane_id).toBe("%2");
    expect(indexTeams(f)).toHaveProperty("other");
    expect(r.err).not.toContain("de-enrolled");
  } finally { removeScratchTree(f.root); }
});

test("a socket path with a trailing space registers", () => {
  // D4 (round 3): the record keeps the socket exactly as tmux prints it —
  // first line, whitespace and all — and the post-lock recheck compares the
  // same form. Trimmed rechecks read a trailing space as a rebirth and
  // refuse server_epoch_moved on a server that never moved.
  const f = fixture({ socketSuffix: " " });
  try {
    const otherRegistry = enrollPair(f);
    const other = JSON.parse(readFileSync(otherRegistry, "utf8"));
    other.seats = {};
    writeFileSync(otherRegistry, JSON.stringify(other));
    const r = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect({ code: r.code, out: r.out, err: r.err }).toMatchObject({ code: 0 });
    expect(r.out + r.err).not.toContain("server_epoch_moved");
    expect(f.seats()["new-seat"]!.server_socket).toBe(physicalSocketPath(f.env()) + " ");
  } finally { removeScratchTree(f.root); }
});

test("a team whose worktree root is gone is de-enrolled with a restore snapshot and registration proceeds", () => {
  const f = fixture();
  try {
    enrollPair(f);
    removeScratchTree(join(f.root, "other"));
    const r = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect({ code: r.code, out: r.out, err: r.err }).toMatchObject({ code: 0 });
    expect(f.seats()["new-seat"]!.pane_id).toBe("%2");
    expect(Object.keys(indexTeams(f))).toEqual(["repo"]);
    expect(r.err).toContain("de-enrolled gone team 'other' (worktree root gone)");
    expect(r.err).toContain(`restore: cp '${join(f.index, "recovery")}/index-gone-team.`);
    expect(r.err).toContain(`.json' '${join(f.index, "global-registry.json")}'`);
    const snaps = readdirSync(join(f.index, "recovery")).filter(name => name.startsWith("index-gone-team.") && name.endsWith(".json"));
    expect(snaps.length).toBe(1);
    expect(JSON.parse(readFileSync(join(f.index, "recovery", snaps[0]!), "utf8")).teams).toHaveProperty("other");
  } finally { removeScratchTree(f.root); }
});

test("a busy machine index makes the gone-team purge give up within its bound and change nothing", () => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    removeScratchTree(join(f.root, "other"));
    const before = readFileSync(join(f.index, "global-registry.json"), "utf8");
    const lock = acquirePathLock(join(f.index, "global-registry.json.lock"), 1000);
    expect(lock).not.toBeNull();
    try {
      const started = Date.now();
      const result = purgeGoneEnrollment("other", { root: join(f.root, "other"), registryLocation: otherRegistry }, f.index);
      expect(result).toMatchObject({ ok: false, code: 3 });
      expect(Date.now() - started).toBeLessThan(900);
    } finally { lock!.release(); }
    expect(readFileSync(join(f.index, "global-registry.json"), "utf8")).toBe(before);
    expect(purgeGoneEnrollment("other", { root: join(f.root, "elsewhere"), registryLocation: otherRegistry }, f.index))
      .toMatchObject({ ok: false, code: 6 });
    expect(purgeGoneEnrollment("other", { root: join(f.root, "other"), registryLocation: otherRegistry }, f.index))
      .toMatchObject({ ok: true });
    expect(Object.keys(indexTeams(f))).toEqual(["repo"]);
  } finally { removeScratchTree(f.root); }
});

test.each(["generation", "socket"])("a reused pane id with a different %s is not foreign ownership", axis => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    const doc = JSON.parse(readFileSync(otherRegistry, "utf8"));
    if (axis === "generation") doc.seats.incumbent.server_epoch = "srv:900:99";
    else doc.seats.incumbent.server_socket = "/different/server.sock";
    writeFileSync(otherRegistry, JSON.stringify(doc));
    const r = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect({ code: r.code, out: r.out, err: r.err }).toMatchObject({ code: 0 });
    expect(f.seats()["new-seat"]!.pane_id).toBe("%2");
  } finally { removeScratchTree(f.root); }
});

test("a registry writer holding the gone team's sidecar lock blocks the purge", () => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    const path = join(f.index, "global-registry.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.teams.other.root = join(f.root, "deleted-root");
    writeFileSync(path, JSON.stringify(index));
    const before = readFileSync(path, "utf8");
    const lock = acquirePathLock(`${otherRegistry}.lock`, 1000);
    expect(lock).not.toBeNull();
    try {
      expect(purgeGoneEnrollment("other", { root: join(f.root, "deleted-root"), registryLocation: otherRegistry }, f.index))
        .toMatchObject({ ok: false, code: 3 });
    } finally { lock!.release(); }
    expect(readFileSync(join(f.index, "global-registry.json"), "utf8")).toBe(before);
  } finally { removeScratchTree(f.root); }
});

test("a deleted root is gone even while its registry elsewhere still claims this pane", () => {
  const f = fixture();
  try {
    enrollPair(f);
    const path = join(f.index, "global-registry.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.teams.other.root = join(f.root, "deleted-root");
    writeFileSync(path, JSON.stringify(index));
    const r = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect({ code: r.code, out: r.out, err: r.err }).toMatchObject({ code: 0 });
    expect(r.err).toContain("de-enrolled gone team 'other' (worktree root gone)");
    expect(Object.keys(indexTeams(f))).toEqual(["repo"]);
  } finally { removeScratchTree(f.root); }
});

test.each(["", "relative/other"])("a foreign entry with root %p is never judged gone or purged", root => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    unlinkSync(otherRegistry);
    const path = join(f.index, "global-registry.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.teams.other.root = root;
    writeFileSync(path, JSON.stringify(index));
    expect(paneEnrollment({ paneId: "%2", epoch: f.epoch, socket: physicalSocketPath(f.env()) }, f.repo, f.index))
      .toMatchObject({ kind: "none", gone: [] });
    expect(purgeGoneEnrollment("other", { root, registryLocation: otherRegistry }, f.index)).toMatchObject({ ok: false, code: 6 });
    expect(indexTeams(f)).toHaveProperty("other");
  } finally { removeScratchTree(f.root); }
});

test("a gone team neither hides nor replaces a real foreign claim", () => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8"));
    index.teams.zgone = { root: join(f.root, "gone"), registry_location: join(f.root, "gone", ".tap", "team-registry.json"), state: "registered" };
    writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(index));
    expect(paneEnrollment({ paneId: "%2", epoch: f.epoch, socket: physicalSocketPath(f.env()) }, f.repo, f.index)).toMatchObject({
      kind: "elsewhere", claims: [{ team: "other", handle: "incumbent" }], gone: [{ team: "zgone" }],
    });
    expect(readFileSync(otherRegistry, "utf8")).toContain("incumbent");
  } finally { removeScratchTree(f.root); }
});

test("a forced duplicate is named as contested and one qualified out removes only the wrong row", () => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    f.writeRegistry({ team: { name: "repo", worktree_root: f.repo }, seats: { survivor: {
      status: "active", delivery: "pane", pane: f.addr, pane_id: "%2", server_epoch: f.epoch,
      server_socket: physicalSocketPath(f.env()), session: "repo/seat", instance: "survivor|original", harness: "zsh",
    } } });
    const before = readFileSync(f.registry, "utf8");
    const duplicate = enrolledSeatForObservedPane("%2", "repo/seat", f.epoch, f.index);
    expect(duplicate.kind).toBe("contested");
    if (duplicate.kind !== "contested") throw new Error("duplicate did not produce contested evidence");
    expect(duplicate.evidence).toContain("repo/survivor");
    expect(duplicate.evidence).toContain("other/incumbent");
    const r = Bun.spawnSync([join(ROOT, "bin/tap"), "out", "other/incumbent", "--json"],
      { cwd: f.repo, env: f.env(), stdout: "pipe", stderr: "pipe", timeout: 30000 });
    expect({ code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }).toMatchObject({ code: 0 });
    expect(readFileSync(f.registry, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(otherRegistry, "utf8")).seats.incumbent).toBeUndefined();
    expect(enrolledSeatForObservedPane("%2", "repo/seat", f.epoch, f.index)).toMatchObject({ kind: "resolved", team: "repo", handle: "survivor" });
  } finally { removeScratchTree(f.root); }
});

test("a malformed foreign handle never becomes an executable repair command", () => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    const doc = JSON.parse(readFileSync(otherRegistry, "utf8"));
    doc.seats["bad;command"] = doc.seats.incumbent;
    delete doc.seats.incumbent;
    writeFileSync(otherRegistry, JSON.stringify(doc));
    expect(paneEnrollment({ paneId: "%2", epoch: f.epoch, socket: physicalSocketPath(f.env()) }, f.repo, f.index)).toMatchObject({ kind: "none", gone: [] });
  } finally { removeScratchTree(f.root); }
});

test.each(["", false, 0, null])("legacy falsy enrollment state %s retains registered semantics", state => {
  const f = fixture();
  try {
    const otherRegistry = enrollPair(f);
    const path = join(f.index, "global-registry.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.teams.other.state = state;
    writeFileSync(path, JSON.stringify(index));
    const claimed = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect(JSON.parse(claimed.out)).toMatchObject({ error_class: "pane_enrolled_elsewhere" });
    const other = JSON.parse(readFileSync(otherRegistry, "utf8"));
    other.seats = {};
    writeFileSync(otherRegistry, JSON.stringify(other));
    const vacant = f.door(["new-seat", "--pane", f.addr, "--json"]);
    expect({ code: vacant.code, out: vacant.out, err: vacant.err }).toMatchObject({ code: 0 });
  } finally { removeScratchTree(f.root); }
});
