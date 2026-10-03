// A recipient settles an ask whose sender has LEFT the team (tap-4lrwv).
// `tap out`/`--kill`/shutdown delete the sender's registry row, and the
// composed send then refuses `unknown_recipient` before placing anything, so
// the completed order pends in the recipient's `tap poll` forever.
//
// Contract under test (unit 1): with the reply-only departed option, send
// places the outbound through the ordinary canonical placement, archives it
// and writes cancel's `.cancelled` receipt (via=cancelled,
// reason=seat_unresolvable, target_status=gone) instead of delivering, and
// reply settles the inbound and exits 0 with a receipt line that says the
// sender will never read it. The predicate is narrow: NO registry row and no
// forwarding edge. A re-registered handle delivers to the new occupant; a
// forwarding-retired sender routes to the successor; suspended senders and
// unreadable registries keep refusing; --progress never takes the branch.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME / TAP_LOCK_DIR and a fake
// tmux on PATH. No real server is started.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envelopeField } from "../src/envelope";
import { removeScratchTree } from "./support/scratch";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-reply-departed."));
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(scratchRoot); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}, 40_000);

// The fake tmux: three sessions — ua (%6, the replier), sb (%7, the original
// sender or its re-registered occupant), sx (%8, a forwarding successor) — all
// running claude. FAKE_BAND holds the composer text; FAKE_KEYS records
// send-keys.
const FAKE_TMUX = `#!/bin/sh
case " $* " in
  *"list-sessions"*) printf 'ua\\t123:456\\n'; printf 'sb\\t123:456\\n'; printf 'sx\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n%%8\\n' ;;
  *"list-panes"*)
    case " $* " in
      *"=sb"*|*" sb:"*|*" sb "*) printf 'sb\\tsb:0.0\\t%%7\\tclaude\\t4242\\t123:456\\t0\\n' ;;
      *"=sx"*|*" sx:"*|*" sx "*) printf 'sx\\tsx:0.0\\t%%8\\tclaude\\t4242\\t123:456\\t0\\n' ;;
      *) printf 'ua\\tua:0.0\\t%%6\\tclaude\\t4242\\t123:456\\t0\\n' ;;
    esac ;;
  *"#{pane_id}"*"#{session_name}"*)
    case " $* " in
      *" sb:"*|*"=sb"*|*" sb "*|*" %7 "*) printf '%%7\\tsb\\t4242\\tclaude\\t0\\n' ;;
      *" sx:"*|*"=sx"*|*" sx "*|*" %8 "*) printf '%%8\\tsx\\t4242\\tclaude\\t0\\n' ;;
      *) printf '%%6\\tua\\t4242\\tclaude\\t0\\n' ;;
    esac ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    printf 'ua\\t123:456\\n' ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_current_command}"*) printf 'claude\\n' ;;
  *"#{pane_in_mode}"*) printf '0\\n' ;;
  *"#{pane_pid}"*) printf '4242\\n' ;;
  *"#{pane_dead}"*) printf '0\\n' ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*)
    case " $* " in
      *" sb:"*|*"=sb"*|*" sb "*|*" %7 "*) printf '%%7\\n' ;;
      *" sx:"*|"=sx"*|" sx "*|" %8 "*) printf '%%8\\n' ;;
      *) printf '%%6\\n' ;;
    esac ;;
  *"capture-pane"*)
    if [ -e "$FAKE_BAND.submitted" ]; then printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'
    elif [ -e "$FAKE_BAND" ]; then printf '› '; cat "$FAKE_BAND"; printf '\\n%s\\n' '──────────────────────────────────────────'
    else printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'; fi ;;
  *"send-keys"*)
    case " $* " in
      *" -l -- "*) rm -f "$FAKE_BAND.submitted"; for last do :; done; printf '%s' "$last" > "$FAKE_BAND"; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
      *" Enter "*|*" Enter") : > "$FAKE_BAND.submitted"; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
    esac ;;
esac
exit 0
`;

const UA = { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" };
const SB = { status: "active", pane: "sb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "sb|B", harness: "claude" };
const SX = { status: "active", pane: "sx:0.0", pane_id: "%8", server_epoch: "srv:123:456", instance: "sx|S", harness: "claude" };
const INBOUND_ID = "sb-20260924T120000Z-aabbccddeeff";

interface FixtureOpts {
  seats?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  registryBytes?: string;
  // Tombstones under .tap/team-history/ (out-retire's shape): handle ->
  // instance it retired with. A tombstone is the EVIDENCE a handle ever was
  // a seat and left; "no row" alone proves nothing (tap-4lrwv review I-A).
  tombstones?: Record<string, string>;
}

function tombstoneFile(root: string, handle: string, instance: string): string {
  const dir = join(root, ".tap", "team-history");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${handle}.out-5cd14c89b626.20260924T083015Z.json`);
  writeFileSync(path, `${JSON.stringify({
    handle, instance, retired_by: "out-5cd14c89b626", retired_at: "2026-09-24T08:30:15Z",
    row: { status: "active", instance, harness: "claude" },
  })}\n`);
  return path;
}

function fixture(opts: FixtureOpts = {}) {
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  mkdirSync(index); mkdirSync(bin);
  const wt = join(root, "alpha");
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", wt], { stdout: "pipe", stderr: "pipe" });
  expect(git.exitCode).toBe(0);
  if (opts.registryBytes !== undefined) {
    writeFileSync(registry, opts.registryBytes);
  } else {
    writeFileSync(registry, `${JSON.stringify({
      schema: "0.20", team: { name: "alpha", worktree_root: wt },
      seats: { ua: UA, ...(opts.seats ?? {}) }, ...(opts.extra ?? {}),
    })}\n`);
  }
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20",
    teams: { alpha: { root: wt, registry_location: registry, state: "registered" } },
  })}\n`);
  for (const [handle, instance] of Object.entries(opts.tombstones ?? {})) tombstoneFile(wt, handle, instance);
  // The inbound: sb asked ua (same team, both stamps present).
  const payload = join(bus, "payloads", `${INBOUND_ID}.md`);
  writeFileSync(payload,
    `---\nid: ${INBOUND_ID}\npath: ${payload}\nfrom: sb\nto: ua\nkind: discuss\nreply: expected\n` +
    `sender_instance: sb|B\nrecipient_instance: ua|A\n---\nquestion?\n`);
  writeFileSync(join(bus, "receipts", `${INBOUND_ID}.placed`), "{}\n");
  writeFileSync(join(bin, "tmux"), FAKE_TMUX, { mode: 0o755 });
  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  writeFileSync(socketPath, "socket\n");
  const xdgConfig = join(root, "xdg-config");
  mkdirSync(xdgConfig);
  const band = join(root, "band");
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: xdgConfig,
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    OPENCODE_DB_PATH: join(root, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
    TAP_LOCK_DIR: join(root, "locks"),
    TAP_TMUX_SOCKET_PATH: socketPath,
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    FAKE_BAND: band,
    FAKE_KEYS: join(root, "keys"),
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  return { root, wt, bus, registry, env, keys: join(root, "keys") };
}

type Fx = ReturnType<typeof fixture>;

function run(fx: Fx, args: string[], extraEnv: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync([TAP, ...args], {
    cwd: fx.wt,
    env: { ...fx.env, TAP_SELF: "ua", ...extraEnv },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString().split(fx.root).join("<root>") };
}

function outId(fx: Fx): string {
  const archiveDir = join(fx.bus, "archive");
  const dir = existsSync(archiveDir) ? archiveDir : join(fx.bus, "payloads");
  const files = readdirSync(dir).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`).sort();
  expect(files.length).toBe(1);
  return files[0]!.replace(/\.(cancelled\.)?md$/, "");
}

function receipt(fx: Fx, name: string): Record<string, unknown> | null {
  const p = join(fx.bus, "receipts", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : null;
}

function injected(fx: Fx): string[] {
  if (!existsSync(fx.keys)) return [];
  return readFileSync(fx.keys, "utf8").split("\n").filter(l => l.includes(" -l -- ")).map(l => l.slice(l.indexOf(" -l -- ") + " -l -- ".length));
}

function spoolEntries(fx: Fx): string[] {
  const dir = join(fx.bus, "spool");
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")) : [];
}

function archiveFile(fx: Fx): string | null {
  const dir = join(fx.bus, "archive");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  return files.length === 1 ? join(dir, files[0]!) : null;
}

describe("reply to a sender who has left the team", () => {
  test("departed sender: the reply is recorded durably, the ask settles, and nothing is delivered", () => {
    // sb retired: no row, and a tombstone proves the handle left (I-A).
    const fx = fixture({ seats: {}, tombstones: { sb: "sb|B" } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 0,
      stdout: `tap reply: recorded ${INBOUND_ID}; sender 'sb' has left the team — not delivered, will not be read; inbound settled\n`,
      stderr: "",
    });
    const id = outId(fx);
    // The record is the archived outbound; no canonical, no spool, no pane effect.
    const archived = archiveFile(fx);
    expect(archived).toBe(join(fx.bus, "archive", `${id}.cancelled.md`));
    expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
    expect(spoolEntries(fx)).toEqual([]);
    expect(injected(fx)).toEqual([]);
    const raw = readFileSync(archived!, "utf8");
    expect({ from: envelopeField(raw, "from"), to: envelopeField(raw, "to"), inReplyTo: envelopeField(raw, "in_reply_to"), reply: envelopeField(raw, "reply"), senderInstance: envelopeField(raw, "sender_instance"), recipientInstance: envelopeField(raw, "recipient_instance") })
      .toEqual({ from: "ua", to: "sb", inReplyTo: INBOUND_ID, reply: "settle-only", senderInstance: "ua|A", recipientInstance: undefined });
    expect(receipt(fx, `${id}.cancelled`)).toMatchObject({
      id, status: "cancelled", via: "cancelled", by: "ua", reason: "seat_unresolvable", target: "sb", target_status: "gone",
    });
    // The ask is settled with reply evidence derived from the archived record.
    expect(receipt(fx, `${INBOUND_ID}.done`)).toMatchObject({ via: "reply", by: "ua", reply_id: id, reply_preview: "answer" });
    // The record stays readable, the poll is clean, and nothing strands in outstanding.
    const show = run(fx, ["show", id]);
    expect(show.code).toBe(0);
    const poll = run(fx, ["poll"]);
    expect({ code: poll.code, stdout: poll.stdout }).toEqual({ code: 0, stdout: expect.not.stringContaining(INBOUND_ID) });
    const outstanding = run(fx, ["outstanding", "--json"]);
    expect(JSON.parse(outstanding.stdout).outstanding).toEqual([]);
  }, 120_000);

  test("active sender: unchanged delivery (the pin on the ordinary path)", () => {
    const fx = fixture({ seats: { sb: SB } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 0, stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "",
    });
    expect(archiveFile(fx)).toBeNull();
    const files = readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`);
    expect(files.length).toBe(1);
    const id = files[0]!.replace(/\.md$/, "");
    expect({ placed: !!receipt(fx, `${id}.placed`), sent: !!receipt(fx, `${id}.sent`), cancelled: !!receipt(fx, `${id}.cancelled`) })
      .toEqual({ placed: true, sent: true, cancelled: false });
    expect(injected(fx)).toEqual([`[[TAP v0.23 note ${id}]]`]);
    expect(receipt(fx, `${INBOUND_ID}.done`)).toMatchObject({ via: "reply", by: "ua", reply_id: id });
  }, 120_000);

  test("suspended sender: still refused, nothing settled", () => {
    const fx = fixture({ seats: { sb: { ...SB, status: "suspended" } } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect(v.code).toBe(3);
    expect(v.stderr).toContain("outbound to sb failed because 'sb' is suspended");
    expect(v.stderr).toContain("left unsettled");
    expect(receipt(fx, `${INBOUND_ID}.done`)).toBeNull();
    expect(archiveFile(fx)).toBeNull();
    expect(readdirSync(join(fx.bus, "payloads")).filter(f => f !== `${INBOUND_ID}.md`)).toEqual([]);
  }, 120_000);

  test("re-registered handle: the reply delivers to the new occupant, no departed branch", () => {
    const fx = fixture({ seats: { sb: { ...SB, instance: "sb|C" } } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 0, stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "",
    });
    expect(archiveFile(fx)).toBeNull();
    expect(injected(fx).length).toBe(1);
    const files = readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`);
    expect(receipt(fx, `${INBOUND_ID}.done`)).toMatchObject({ via: "reply", reply_id: files[0]!.replace(/\.md$/, "") });
  }, 120_000);

  test("forwarding-retired sender: the reply routes to the successor", () => {
    const fx = fixture({
      seats: { sx: SX },
      extra: { seat_forwardings: [{ source: "sb", source_instance: "sb|B", destination: "sx", destination_instance: "sx|S", at: "2026-09-24T12:00:00Z", address_active: true }] },
    });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 0, stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "",
    });
    expect(archiveFile(fx)).toBeNull();
    const files = readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`);
    const raw = readFileSync(join(fx.bus, "payloads", files[0]!), "utf8");
    expect({ to: envelopeField(raw, "to"), adopted: envelopeField(raw, "to_adopted_from") }).toEqual({ to: "sx", adopted: "sb" });
    expect(injected(fx).length).toBe(1);
    expect(receipt(fx, `${INBOUND_ID}.done`)).toMatchObject({ via: "reply" });
  }, 120_000);

  test("progress never takes the departed branch", () => {
    const fx = fixture({ seats: {} });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "still working", "--by", "ua", "--progress"]);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("did not become durable");
    expect(receipt(fx, `${INBOUND_ID}.done`)).toBeNull();
    expect(archiveFile(fx)).toBeNull();
  }, 120_000);

  test("unreadable registry refuses before anything settles", () => {
    const fx = fixture({ registryBytes: "not json at all" });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect(v.code).toBe(1);
    expect(receipt(fx, `${INBOUND_ID}.done`)).toBeNull();
    expect(archiveFile(fx)).toBeNull();
  }, 120_000);

  test("never-registered sender: no row and no tombstone keeps the ordinary refusal (I-A)", () => {
    // watcher probes, courier identities and restored envelopes carry
    // from-handles that were never seats: "no row" alone is not "left".
    const fx = fixture({ seats: {} }); // no tombstone for zz
    const inbound = join(fx.bus, "payloads", `${INBOUND_ID}.md`);
    writeFileSync(inbound, readFileSync(inbound, "utf8").replace("from: sb", "from: zz").replace("sender_instance: sb|B", "sender_instance:"));
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 1, stdout: "",
      stderr: `tap reply: outbound to zz failed because 'zz' is not an active seat on team 'alpha'; next: tap team\n`
        + `tap reply: '${INBOUND_ID}' left unsettled — the outbound to zz did not become durable; re-run 'tap reply' after fixing the send above\n`,
    });
    expect(archiveFile(fx)).toBeNull();
    expect(receipt(fx, `${INBOUND_ID}.done`)).toBeNull();
  }, 120_000);

  test("instance arm: a tombstone for another instance of the handle does not prove departure (o1)", () => {
    // sb left as sb|OLD long ago; the inbound is from sb|B. A handle-level
    // match alone would falsely record; the instance arm must refuse.
    const fx = fixture({ seats: {}, tombstones: { sb: "sb|OLD" } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, stdout: v.stdout }).toEqual({
      code: 1, stdout: "",
    });
    expect(v.stderr).toContain("'sb' is not an active seat on team 'alpha'");
    expect(v.stderr).toContain("left unsettled");
    expect(archiveFile(fx)).toBeNull();
    expect(receipt(fx, `${INBOUND_ID}.done`)).toBeNull();
  }, 120_000);

  // The race re-checks (I-B): the route seam hook mutates the registry after
  // send's snapshot and before placement — exactly the window
  // assertDepartedUnchanged re-proves under the publication locks.
  test("race: the departed seat re-registers before placement — refuse, place nothing (I-B)", () => {
    const fx = fixture({ seats: {}, tombstones: { sb: "sb|B" } });
    const hook = join(fx.root, "hook-reregister.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' '${JSON.stringify({
      schema: "0.20", team: { name: "alpha", worktree_root: fx.wt }, seats: { ua: UA, sb: { ...SB, instance: "sb|C" } },
    }).replace(/'/g, "")}' > '${fx.registry}'\n`, { mode: 0o755 });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"], { TAP_SEND_AFTER_ROUTE_HOOK: hook });
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("pinned recipient route changed before placement (departed recipient re-registered before placement)");
    expect(v.stderr).toContain("left unsettled");
    expect(archiveFile(fx)).toBeNull();
    expect(receipt(fx, `${INBOUND_ID}.done`)).toBeNull();
    expect(injected(fx)).toEqual([]);
  }, 120_000);

  test("race: a forwarding successor appears before placement — refuse, place nothing (I-B)", () => {
    const fx = fixture({ seats: { sx: SX }, tombstones: { sb: "sb|B" } });
    const hook = join(fx.root, "hook-edge.sh");
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' '${JSON.stringify({
      schema: "0.20", team: { name: "alpha", worktree_root: fx.wt }, seats: { ua: UA, sx: SX },
      seat_forwardings: [{ source: "sb", source_instance: "sb|B", destination: "sx", destination_instance: "sx|S", at: "2026-09-24T13:00:00Z", address_active: true }],
    }).replace(/'/g, "")}' > '${fx.registry}'\n`, { mode: 0o755 });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"], { TAP_SEND_AFTER_ROUTE_HOOK: hook });
    expect(v.code).toBe(1);
    expect(v.stderr).toContain("pinned recipient route changed before placement (a forwarding successor appeared before placement)");
    expect(v.stderr).toContain("left unsettled");
    expect(archiveFile(fx)).toBeNull();
    expect(receipt(fx, `${INBOUND_ID}.done`)).toBeNull();
  }, 120_000);
});
