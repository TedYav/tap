// The foreign return route on a LOCAL inbound (D4, member 3a-bis-1 of the
// `reply` stack): `tap reply <id>` where the inbound on the caller's own bus
// carries `from_team`, so the answer is addressed `<from_team>/<from>`. The
// native door no longer delegates on `from_team`; the outbound takes D2's
// native remote route (`tap send <team>/<handle>`) with the historical-
// recipient opts reply already carried. Every row runs the native door
// through the installed `bin/tap` over one two-team fixture (alpha's `ua`
// answering beta's `rb`) and checks exit, route trace, receipt bytes, the
// outbound's stamps on the sender's bus, the inbound's settlement and the
// pane effect.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME / TAP_HOME / TAP_LOCK_DIR and a
// fake tmux on PATH. No real server is started.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { envelopeField } from "../src/envelope";
import { removeScratchTree } from "./support/scratch";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-reply-foreign."));
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(scratchRoot); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}, 40_000);

// The fake tmux: two sessions, `ua` (%6, alpha's replier) and `rb` (%7, beta's
// original sender), both running claude. FAKE_BAND holds rb's composer text (a
// pre-existing file is a human draft); FAKE_KEYS records every send-keys.
const FAKE_TMUX = `#!/bin/sh
case " $* " in
  *"list-sessions"*) printf 'ua\\t123:456\\n'; printf 'rb\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n' ;;
  *"list-panes"*)
    case " $* " in
      *"=rb"*|*" rb:"*|*" rb "*) printf 'rb\\trb:0.0\\t%%7\\tclaude\\t4242\\t123:456\\t0\\n' ;;
      *) printf 'ua\\tua:0.0\\t%%6\\tclaude\\t4242\\t123:456\\t0\\n' ;;
    esac ;;
  *"#{pane_id}"*"#{session_name}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*) printf '%%6\\tua\\t4242\\tclaude\\t0\\n' ;;
      *) printf '%%7\\trb\\t4242\\tclaude\\t0\\n' ;;
    esac ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    case " $* " in
      *" rb:"*|*"=rb"*|*" %7 "*) printf 'rb\\t123:456\\n' ;;
      *) printf 'ua\\t123:456\\n' ;;
    esac ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{pane_current_command}"*) printf 'claude\\n' ;;
  *"#{pane_in_mode}"*) printf '0\\n' ;;
  *"#{pane_pid}"*) printf '4242\\n' ;;
  *"#{pane_dead}"*) printf '0\\n' ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" %6 "*) printf '%%6\\n' ;;
      *) printf '%%7\\n' ;;
    esac ;;
  *"capture-pane"*)
    band="$FAKE_BAND"
    case " $* " in *" ua:"*|*"=ua"*|*" %6 "*) band="$FAKE_BAND.ua" ;; esac
    if [ -e "$band.submitted" ]; then printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'
    elif [ -e "$band" ]; then printf '› '; cat "$band"; printf '\\n%s\\n' '──────────────────────────────────────────'
    else printf '› \\n'; printf '%s\\n' '──────────────────────────────────────────'; fi ;;
  *"send-keys"*)
    band="$FAKE_BAND"
    case " $* " in *" ua:"*|*"=ua"*|*" %6 "*) band="$FAKE_BAND.ua" ;; esac
    case " $* " in
      *" -l -- "*) rm -f "$band.submitted"; for last do :; done; printf '%s' "$last" > "$band"; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
      *" Enter "*|*" Enter") : > "$band.submitted"; printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
    esac ;;
esac
exit 0
`;

interface Team { name: string; wt: string; bus: string; registry: string }

function team(root: string, name: string, seats: Record<string, unknown>, extra: Record<string, unknown> = {}): Team {
  const wt = join(root, name);
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", wt], { stdout: "pipe", stderr: "pipe" });
  expect(git.exitCode).toBe(0);
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name, worktree_root: wt }, seats, ...extra })}\n`);
  return { name, wt, bus, registry };
}

const RB = { status: "active", pane: "rb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rb|B", harness: "claude" };
const INBOUND_ID = "rb-20260916T120000Z-aabbccddeeff";

interface FixtureOpts {
  alphaSeats?: Record<string, unknown>;
  betaSeats?: Record<string, unknown>;
  betaExtra?: Record<string, unknown>;
  /** Extra frontmatter on the inbound (`from_team` defaults to beta; pass "" to drop it). */
  inbound?: Record<string, string>;
  /** rb's composer holds a human draft: the remote pane parks. */
  draft?: boolean;
}

function fixture(opts: FixtureOpts = {}) {
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  mkdirSync(index); mkdirSync(bin);
  const alpha = team(root, "alpha", {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
    ua2: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua2|A", harness: "claude" },
    ...opts.alphaSeats,
  });
  const beta = team(root, "beta", opts.betaSeats ?? { rb: RB }, opts.betaExtra);
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20",
    teams: {
      alpha: { root: alpha.wt, registry_location: alpha.registry, state: "registered" },
      beta: { root: beta.wt, registry_location: beta.registry, state: "registered" },
    },
  })}\n`);
  // The inbound: beta's rb asked alpha's ua, as D2's cross-team send stamps it.
  const fields: Record<string, string> = {
    from: "rb", to: "ua", kind: "discuss", reply: "expected", from_team: "beta", to_team: "alpha", cross_worktree: "true",
    sender_instance: "rb|B", recipient_instance: "ua|A", ...opts.inbound,
  };
  const payload = join(alpha.bus, "payloads", `${INBOUND_ID}.md`);
  writeFileSync(payload,
    `---\nid: ${INBOUND_ID}\npath: ${payload}\n` +
    Object.entries(fields).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}\n`).join("") +
    "---\nquestion?\n");
  writeFileSync(join(alpha.bus, "receipts", `${INBOUND_ID}.placed`), "{}\n");
  writeFileSync(join(bin, "tmux"), FAKE_TMUX, { mode: 0o755 });
  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  writeFileSync(socketPath, "socket\n");
  const xdgConfig = join(root, "xdg-config");
  mkdirSync(xdgConfig);
  const band = join(root, "band");
  if (opts.draft) writeFileSync(band, "half-typed human draft");
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
  return { root, index, alpha, beta, env, keys: join(root, "keys") };
}

type Fx = ReturnType<typeof fixture>;

interface View { code: number; route: string; stdout: string; stderr: string }

/** Run the installed native door from alpha's worktree as `ua`. Reply has no `--json`. */
function run(fx: Fx, args: string[]): View {
  const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
  const r = Bun.spawnSync([TAP, ...args], {
    cwd: fx.alpha.wt,
    env: { ...fx.env, TAP_SELF: "ua", TAP_BUN_ROUTE_TRACE: trace },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  return { code: r.exitCode, route: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "", stdout: r.stdout.toString(), stderr: r.stderr.toString().split(fx.root).join("<root>") };
}

/** The outbound canonicals on a bus: every payload that is not the seeded inbound. */
function outbounds(bus: string): string[] {
  const dir = join(bus, "payloads");
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`).sort() : [];
}

const STAMPS = ["from", "to", "kind", "reply", "cross_worktree", "from_team", "to_team", "recipient_instance", "sender_instance", "to_adopted_from", "original_recipient_instance", "in_reply_to", "reply_to", "urgency"];

function frontmatter(path: string): Record<string, string> {
  const body = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const key of STAMPS) {
    const v = envelopeField(body, key);
    if (v) out[key] = v;
  }
  return out;
}

function injected(fx: Fx): string[] {
  if (!existsSync(fx.keys)) return [];
  return readFileSync(fx.keys, "utf8").split("\n").filter(l => l.includes(" -l -- ")).map(l => l.slice(l.indexOf(" -l -- ") + " -l -- ".length));
}

function receipt(fx: Fx, name: string): Record<string, unknown> | null {
  const p = join(fx.alpha.bus, "receipts", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : null;
}

function spoolEntries(bus: string): string[] {
  const dir = join(bus, "spool");
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")).sort() : [];
}

describe("the foreign return route on a local inbound", () => {
  // The three obligation modes reply has: the route change applies to all of
  // them (partner review). Plain and --expect-reply settle the inbound on the
  // accepted outbound; --progress leaves it open.
  const modes: Array<{ name: string; args: string[]; reply: string; sentinel: string; settles: boolean; stdout: (id: string) => string }> = [
    { name: "plain", args: [], reply: "settle-only", sentinel: "note", settles: true, stdout: id => `tap reply: ok ${id}\n` },
    { name: "--expect-reply", args: ["--expect-reply"], reply: "expected", sentinel: "ask", settles: true, stdout: id => `tap reply: ok ${id}\n` },
    { name: "--progress", args: ["--progress"], reply: "settle-only", sentinel: "note", settles: false, stdout: id => `tap reply: progress ${id} (open)\n` },
  ];
  for (const mode of modes) {
    test(`delivery (${mode.name}): the answer is addressed beta/rb, injected into rb's pane, stamped as a cross-team outbound on alpha's bus${mode.settles ? "; the inbound settles" : "; the inbound stays open"}`, () => {
      const fx = fixture();
      const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", ...mode.args]);
      expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
        .toEqual({ code: 0, route: "native reply", stdout: mode.stdout(INBOUND_ID), stderr: "" });
      // The canonical lives on the SENDER's (alpha's) bus only, with D2's cross-team stamps and no auto reply_to.
      const mail = outbounds(fx.alpha.bus);
      expect({ alpha: mail.length, beta: outbounds(fx.beta.bus) }).toEqual({ alpha: 1, beta: [] });
      const outId = mail[0]!.replace(/\.md$/, "");
      const fm = frontmatter(join(fx.alpha.bus, "payloads", mail[0]!));
      expect(fm).toEqual({
        from: "ua", to: "rb", kind: "discuss", reply: mode.reply, cross_worktree: "true", from_team: "alpha", to_team: "beta",
        recipient_instance: "rb|B", sender_instance: "ua|A", in_reply_to: INBOUND_ID,
      });
      expect({ placed: !!receipt(fx, `${outId}.placed`), sent: !!receipt(fx, `${outId}.sent`) }).toEqual({ placed: true, sent: true });
      // The sentinel names alpha as the bus locator (enrolled, no path=), lands in rb's pane.
      expect(injected(fx)).toEqual([`[[TAP v0.23 ${mode.sentinel} alpha/${outId}]]`]);
      expect(readFileSync(fx.keys, "utf8")).toMatch(/send-keys -t (%7|rb:0\.0) -l -- /);
      // Delivery clock on the RECIPIENT's bus; the inbound's settlement on the caller's.
      expect({ beta: existsSync(join(fx.beta.bus, "delivery", "rb.json")), alpha: existsSync(join(fx.alpha.bus, "delivery")) })
        .toEqual({ beta: true, alpha: false });
      const done = receipt(fx, `${INBOUND_ID}.done`);
      if (mode.settles) {
        expect({ via: done?.via, by: done?.by, replyId: done?.reply_id, preview: done?.reply_preview }).toEqual({ via: "reply", by: "ua", replyId: outId, preview: "answer" });
      } else {
        expect(done).toBeNull();
      }
    }, 120_000);
  }

  test("park: rb holds a human draft — the outbound parks on alpha's spool, the receipt says queued, the inbound settles (a park is a durable exit 0)", () => {
    const fx = fixture({ draft: true });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: queued ${INBOUND_ID}\n`, stderr: "" });
    const spool = spoolEntries(fx.alpha.bus);
    expect({ spool: spool.length, betaSpool: existsSync(join(fx.beta.bus, "spool")), injected: injected(fx) }).toEqual({ spool: 1, betaSpool: false, injected: [] });
    const meta = JSON.parse(readFileSync(join(fx.alpha.bus, "spool", spool[0]!.replace(/\.md$/, ".meta.json")), "utf8")) as Record<string, unknown>;
    expect({ target: meta.target, team: meta.team, reason: meta.reason }).toEqual({ target: "rb", team: "alpha", reason: "pending-input" });
    const done = receipt(fx, `${INBOUND_ID}.done`);
    expect({ via: done?.via, replyId: done?.reply_id }).toEqual({ via: "reply", replyId: spool[0]!.replace(/\.md$/, "") });
  }, 120_000);

  test("park (--progress): a parked progress outbound leaves the inbound open", () => {
    const fx = fixture({ draft: true });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "still working", "--by", "ua", "--progress"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: progress ${INBOUND_ID} (open)\n`, stderr: "" });
    expect({ spool: spoolEntries(fx.alpha.bus).length, done: receipt(fx, `${INBOUND_ID}.done`) }).toEqual({ spool: 1, done: null });
  }, 120_000);

  test("replaced foreign sender: beta's rb is a new instance with no forwarding — the historical route answers the CURRENT seat (forwarding.ts:46)", () => {
    const fx = fixture({ betaSeats: { rb: { ...RB, instance: "rb|C" } } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    const mail = outbounds(fx.alpha.bus);
    const fm = mail.length ? frontmatter(join(fx.alpha.bus, "payloads", mail[0]!)) : {};
    const seen = { code: v.code, route: v.route, stdout: v.stdout.replace(INBOUND_ID, "<in>"), stderr: v.stderr, mail: mail.length, to: fm.to, inst: fm.recipient_instance, adopted: fm.to_adopted_from, injected: injected(fx).length, done: !!receipt(fx, `${INBOUND_ID}.done`) };
    expect(seen).toEqual({ code: 0, route: "native reply", stdout: "tap reply: ok <in>\n", stderr: "", mail: 1, to: "rb", inst: "rb|C", adopted: undefined, injected: 1, done: true });
  }, 120_000);

  test("retired foreign sender with a successor: the pinned forwarding on BETA's registry routes the answer to rc with the adoption stamps", () => {
    const fx = fixture({
      betaSeats: { rc: { ...RB, instance: "rc|B" } },
      betaExtra: { seat_forwardings: [{ source: "rb", source_instance: "rb|B", destination: "rc", destination_instance: "rc|B", at: "2026-09-16T00:00:00Z", address_active: true }] },
    });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr }).toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const mail = outbounds(fx.alpha.bus);
    expect(mail.length).toBe(1);
    const fm = frontmatter(join(fx.alpha.bus, "payloads", mail[0]!));
    // Frozen (was the cross-door parity check, the sole assertion of the
    // non-adoption stamps below; native's byte-for-byte value carries forward).
    expect(fm).toEqual({
      from: "ua", to: "rc", kind: "discuss", reply: "settle-only", cross_worktree: "true", from_team: "alpha", to_team: "beta",
      recipient_instance: "rc|B", sender_instance: "ua|A", to_adopted_from: "rb", original_recipient_instance: "rb|B", in_reply_to: INBOUND_ID,
    });
    expect(receipt(fx, `${INBOUND_ID}.done`)?.via).toBe("reply");
  }, 120_000);

  test("qualified reply_to through a retired source: the forwarding edge routes beta/rb to the successor rc, not the original sender (tap_seat_deliverable)", () => {
    const fx = fixture({
      betaSeats: { rc: { ...RB, instance: "rc|B" }, wq: { ...RB, instance: "wq|B" } },
      betaExtra: { seat_forwardings: [{ source: "rb", source_instance: "rb|B", destination: "rc", destination_instance: "rc|B", at: "2026-09-16T00:00:00Z", address_active: true }] },
      inbound: { from: "wq", sender_instance: "wq|B", reply_to: "beta/rb" },
    });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr }).toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const mail = outbounds(fx.alpha.bus);
    expect({ alpha: mail.length, beta: outbounds(fx.beta.bus) }).toEqual({ alpha: 1, beta: [] });
    const outId = mail[0]!.replace(/\.md$/, "");
    const fm = frontmatter(join(fx.alpha.bus, "payloads", mail[0]!));
    expect(fm).toEqual({
      from: "ua", to: "rc", kind: "discuss", reply: "settle-only", cross_worktree: "true", from_team: "alpha", to_team: "beta",
      recipient_instance: "rc|B", sender_instance: "ua|A", in_reply_to: INBOUND_ID, to_adopted_from: "rb", original_recipient_instance: "rb|B",
    });
    expect(injected(fx)).toEqual([`[[TAP v0.23 note alpha/${outId}]]`]);
    expect(receipt(fx, `${INBOUND_ID}.done`)?.via).toBe("reply");
  }, 120_000);

  test("unattended is judged on the LOCAL sender only: a local seat sharing the foreign handle, marked unattended, does not refuse the foreign answer (tap-reply.sh:232)", () => {
    const fx = fixture({ alphaSeats: { rb: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "rb|A", harness: "claude", unattended: true } } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr }).toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const fm = frontmatter(join(fx.alpha.bus, "payloads", outbounds(fx.alpha.bus)[0]!));
    expect({ to: fm.to, toTeam: fm.to_team, inst: fm.recipient_instance }).toEqual({ to: "rb", toTeam: "beta", inst: "rb|B" });
    // Control: the same unattended seat as a LOCAL original sender is refused.
    const fx2 = fixture({
      alphaSeats: { rb: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "rb|A", harness: "claude", unattended: true } },
      inbound: { from_team: "", to_team: "", cross_worktree: "", sender_instance: "rb|A" },
    });
    const v2 = run(fx2, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v2.code, route: v2.route, stdout: v2.stdout, stderr: v2.stderr, mail: outbounds(fx2.alpha.bus).length })
      .toEqual({ code: 1, route: "native reply", stdout: "", stderr: `tap reply: 'rb' is unattended; inbound replies are refused by default unless reporting a problem; next: tap read ${INBOUND_ID} or tap reply ${INBOUND_ID} --allow-unattended -f <file>\n`, mail: 0 });
  }, 120_000);

  test("fallback: a bare local reply_to that is no longer deliverable falls back to the foreign sender with the incumbent's warning", () => {
    const fx = fixture({ inbound: { reply_to: "ghost" } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`,
      stderr: `tap reply: warning: reply_to 'ghost' on '${INBOUND_ID}' is no longer deliverable (unknown team, unknown handle, or not an active pane/poll seat) — falling back to the original sender 'beta/rb'\n`,
    });
    const fm = frontmatter(join(fx.alpha.bus, "payloads", outbounds(fx.alpha.bus)[0]!));
    expect({ to: fm.to, toTeam: fm.to_team }).toEqual({ to: "rb", toTeam: "beta" });
  }, 120_000);

  test("a bare reply_to on a foreign inbound never routes to a same-named local seat; it takes the fallback and warns (tap-bgxp)", () => {
    // ua2 is an active seat on the LOCAL team alpha; the pre-upgrade bare reply_to "ua2" was minted on beta.
    const fx = fixture({ inbound: { reply_to: "ua2" } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`,
      stderr: `tap reply: warning: reply_to 'ua2' on '${INBOUND_ID}' is no longer deliverable (unknown team, unknown handle, or not an active pane/poll seat) — falling back to the original sender 'beta/rb'\n`,
    });
    const fm = frontmatter(join(fx.alpha.bus, "payloads", outbounds(fx.alpha.bus)[0]!));
    expect({ to: fm.to, toTeam: fm.to_team }).toEqual({ to: "rb", toTeam: "beta" });
  }, 120_000);

  test("same-team control: a bare reply_to on a local inbound still routes to the named local seat, with no warning (tap-bgxp)", () => {
    const uc = { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "uc|A", harness: "claude" };
    const fx = fixture({
      alphaSeats: { uc },
      inbound: { from: "ua2", from_team: "", to_team: "", cross_worktree: "", sender_instance: "ua2|A", reply_to: "uc" },
    });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stderr: v.stderr }).toEqual({ code: 0, route: "native reply", stderr: "" });
    const fm = frontmatter(join(fx.alpha.bus, "payloads", outbounds(fx.alpha.bus)[0]!));
    expect(fm.to).toBe("uc");
  }, 120_000);

  test("refusal: the sender's team is not enrolled — the incumbent's two lines, exit 1, nothing on either bus, the inbound open", () => {
    const fx = fixture({ inbound: { from_team: "gamma" } });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 1, route: "native reply", stdout: "",
      stderr: "tap reply: outbound to gamma/rb failed because unknown team 'gamma' (not in the machine index; known sibling worktrees: <none>). Fallback: tap send rb <payload> --cross-worktree --pane <tmux-target>; next: tap send rb <payload> --cross-worktree --pane <tmux-target>\n"
        + `tap reply: '${INBOUND_ID}' left unsettled — the outbound to gamma/rb did not become durable; re-run 'tap reply' after fixing the send above\n`,
    });
    const receipts = readdirSync(join(fx.alpha.bus, "receipts")).sort();
    expect({ alpha: outbounds(fx.alpha.bus), beta: outbounds(fx.beta.bus), spool: spoolEntries(fx.alpha.bus), receipts, injected: injected(fx) })
      .toEqual({ alpha: [], beta: [], spool: [], receipts: [`${INBOUND_ID}.placed`], injected: [] });
  }, 120_000);

  test("local route control: a sender with no registry row records the reply, settles the ask, and never delivers (tap-4lrwv)", () => {
    const fx = fixture({ inbound: { from: "zz", from_team: "", to_team: "", cross_worktree: "", sender_instance: "" } });
    // zz LEFT: the tombstone is the departure evidence; a handle that never
    // was a seat keeps the ordinary refusal (reply-departed-sender.test.ts).
    mkdirSync(join(fx.alpha.wt, ".tap", "team-history"), { recursive: true });
    writeFileSync(join(fx.alpha.wt, ".tap", "team-history", "zz.out-5cd14c89b626.20260924T083015Z.json"),
      `${JSON.stringify({ handle: "zz", instance: "zz|Z", retired_by: "out-5cd14c89b626", retired_at: "2026-09-24T08:30:15Z", row: { status: "active", instance: "zz|Z" } })}\n`);
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr }).toEqual({
      code: 0, route: "native reply",
      stdout: `tap reply: recorded ${INBOUND_ID}; sender 'zz' has left the team — not delivered, will not be read; inbound settled\n`,
      stderr: "",
    });
    // The reply-expected ask from a departed seat settles on the record: the
    // outbound is archived under cancel's convention with a terminal receipt,
    // nothing is injected, and no canonical or spool entry remains.
    const id = readdirSync(join(fx.alpha.bus, "archive")).sort()[0]!.replace(/\.cancelled\.md$/, "");
    const fm = frontmatter(join(fx.alpha.bus, "archive", `${id}.cancelled.md`));
    expect({
      archived: `${id}.cancelled.md`,
      canonical: outbounds(fx.alpha.bus), spool: spoolEntries(fx.alpha.bus), injected: injected(fx),
      from: fm.from, to: fm.to, inReplyTo: fm.in_reply_to,
    }).toEqual({
      archived: `${id}.cancelled.md`,
      canonical: [], spool: [], injected: [],
      from: "ua", to: "zz", inReplyTo: INBOUND_ID,
    });
    expect(receipt(fx, `${id}.cancelled`)).toMatchObject({ id, status: "cancelled", via: "cancelled", by: "ua", reason: "seat_unresolvable", target: "zz", target_status: "gone" });
    expect(receipt(fx, `${INBOUND_ID}.done`)).toMatchObject({ via: "reply", by: "ua", reply_id: id, reply_preview: "answer" });
  }, 120_000);

  test("post-placement refusal: the machine index turns invalid after the canonical is placed — the outbound REMAINS as a tracked obligation, and the native door never invites a re-run beside it", () => {
    const fx = fixture();
    // D2's control (send-remote.test.ts): the first observation of beta's pane —
    // once native has bound the remote team — corrupts the machine index, so
    // the sentinel render after placement refuses (send.ts senderIndexEvidence,
    // lib.sh:822-838) with the canonical already on alpha's bus.
    const tmux = join(fx.root, "bin", "tmux");
    const real = join(fx.root, "bin", "tmux.real");
    renameSync(tmux, real);
    writeFileSync(tmux, `#!/bin/sh
case " $* " in
  *" rb:"*|*"=rb"*|*" %7 "*)
    if [ ! -e "$TAP_INDEX_HOME/.corrupted" ]; then
      printf '{ invalid' > "$TAP_INDEX_HOME/global-registry.json"
      : > "$TAP_INDEX_HOME/.corrupted"
    fi
    ;;
esac
exec "$FAKE_TMUX_REAL" "$@"
`, { mode: 0o755 });
    (fx.env as Record<string, string>).FAKE_TMUX_REAL = real;
    const v = run(fx, ["reply", INBOUND_ID, "-m", "index race", "--by", "ua"]);
    const mail = outbounds(fx.alpha.bus);
    const outId = mail[0]?.replace(/\.md$/, "") ?? "";
    const view = { code: v.code, stdout: v.stdout, stderr: v.stderr.split(outId || "<no-outbound>").join("<out>"),
      alpha: mail.length, placed: mail.map(() => !!receipt(fx, `${outId}.placed`)), spool: spoolEntries(fx.alpha.bus).length,
      injected: injected(fx), done: !!receipt(fx, `${INBOUND_ID}.done`) };
    // Native: send's render refusal (D2's bytes) on the first line; the second
    // line names the outbound that remains and refuses to invite a re-run.
    expect(view).toEqual({ code: 1, stdout: "",
      stderr: "tap reply: outbound to beta/rb failed because sentinel_render: registry marker is invalid_flip; refusing to render rather than guess whether team 'alpha' is reachable; next: fix_command\n"
        + `tap reply: '${INBOUND_ID}' left unsettled — the outbound <out> to beta/rb is placed on the bus (canonical) and was not delivered; do not re-run 'tap reply', which would mint a second outbound; next: tap outstanding ua\n`,
      alpha: 1, placed: [true], spool: 0, injected: [], done: false });
    expect(String(view.stderr)).not.toContain("re-run 'tap reply' after fixing");
  }, 120_000);

  test("router: a local inbound with from_team traces native, as do a path ref, --payload since D4d and a team-qualified reply_to since send-reply-r2 checkpoint A", () => {
    const fx = fixture();
    expect(run(fx, ["reply", INBOUND_ID, "-m", "native", "--by", "ua"]).route).toBe("native reply");
    const qualified = fixture({ inbound: { reply_to: "beta/rb" } });
    // send-reply-r2 checkpoint A (U1): the redirect's deliverability answer is
    // the native index bind + row read, so the qualified reply_to routes here.
    expect(run(qualified, ["reply", INBOUND_ID, "-m", "redirect", "--by", "ua"]).route).toBe("native reply");
    const path = fixture();
    expect(run(path, ["reply", join(path.alpha.bus, "payloads", `${INBOUND_ID}.md`), "-m", "path", "--by", "ua"]).route).toBe("native reply");
    const payload = fixture();
    expect(run(payload, ["reply", INBOUND_ID, "-m", "payload", "--by", "ua", "--payload", join(payload.alpha.bus, "payloads", `${INBOUND_ID}.md`)]).route).toBe("native reply");
  }, 120_000);
});
