// The settle epoch on native reply (D4c, member 3a-bis-3 of the `reply` stack):
// `tap reply --epoch <n>` and ambient TAP_EPOCH stamp the settle receipt's
// `epoch` in the incumbent's precedence — `--epoch` > TAP_EPOCH > the inbound's
// own `epoch:` (tap-reply.sh:37/:48/:231, then tap-reply-settle.sh:367). TAP never
// interprets the value (CONTRACT §Settlement: it records what it is told, so a
// seal predicate downstream can reject a stale-epoch ack). Every row runs the
// native door through the installed `bin/tap` over one team and checks exit,
// route trace, receipt bytes, the `.done`'s `epoch` and the outbound.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME / TAP_HOME / TAP_LOCK_DIR and a
// fake tmux on PATH. No real server is started.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeScratchTree } from "./support/scratch";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-reply-epoch."));
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(scratchRoot); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}, 40_000);

// One team, two seats on two panes: `ua` (%6) replies to `ub` (%7); both claude.
const FAKE_TMUX = `#!/bin/sh
case " $* " in
  *"list-sessions"*) printf 'ua\\t123:456\\n'; printf 'ub\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n' ;;
  *"list-panes"*)
    case " $* " in
      *"=ub"*|*" ub:"*|*" ub "*) printf 'ub\\tub:0.0\\t%%7\\tclaude\\t4242\\t123:456\\t0\\n' ;;
      *) printf 'ua\\tua:0.0\\t%%6\\tclaude\\t4242\\t123:456\\t0\\n' ;;
    esac ;;
  *"#{pane_id}"*"#{session_name}"*)
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*) printf '%%6\\tua\\t4242\\tclaude\\t0\\n' ;;
      *) printf '%%7\\tub\\t4242\\tclaude\\t0\\n' ;;
    esac ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    case " $* " in
      *" ub:"*|*"=ub"*|*" %7 "*) printf 'ub\\t123:456\\n' ;;
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

const INBOUND_ID = "ub-20260916T120000Z-aabbccddeeff";

function fixture(opts: { inboundEpoch?: string } = {}) {
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
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name: "alpha", worktree_root: wt }, seats: {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
    ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" },
  } })}\n`);
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({ schema: "0.20", teams: { alpha: { root: wt, registry_location: registry, state: "registered" } } })}\n`);
  const payload = join(bus, "payloads", `${INBOUND_ID}.md`);
  writeFileSync(payload,
    `---\nid: ${INBOUND_ID}\npath: ${payload}\nfrom: ub\nto: ua\nkind: discuss\nreply: expected\nsender_instance: ub|A\nrecipient_instance: ua|A\n` +
    (opts.inboundEpoch ? `epoch: ${opts.inboundEpoch}\n` : "") + "---\nquestion?\n");
  writeFileSync(join(bus, "receipts", `${INBOUND_ID}.placed`), "{}\n");
  writeFileSync(join(bin, "tmux"), FAKE_TMUX, { mode: 0o755 });
  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  writeFileSync(socketPath, "socket\n");
  const xdgConfig = join(root, "xdg-config");
  mkdirSync(xdgConfig);
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
    FAKE_BAND: join(root, "band"),
    FAKE_KEYS: join(root, "keys"),
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  return { root, wt, bus, env };
}

type Fx = ReturnType<typeof fixture>;

interface View { code: number; route: string; stdout: string; stderr: string }

function run(fx: Fx, args: string[], ambientEpoch?: string): View {
  const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
  const env: NodeJS.ProcessEnv = { ...fx.env, TAP_SELF: "ua", TAP_BUN_ROUTE_TRACE: trace };
  if (ambientEpoch !== undefined) env.TAP_EPOCH = ambientEpoch;
  const r = Bun.spawnSync([TAP, ...args], { cwd: fx.wt, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { code: r.exitCode, route: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "", stdout: r.stdout.toString(), stderr: r.stderr.toString().split(fx.root).join("<root>") };
}

function outbounds(fx: Fx): string[] {
  return readdirSync(join(fx.bus, "payloads")).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`).sort();
}

function done(fx: Fx): Record<string, unknown> | null {
  const p = join(fx.bus, "receipts", `${INBOUND_ID}.done`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : null;
}

describe("the settle epoch on reply", () => {
  // The precedence table: `--epoch` > ambient TAP_EPOCH > the inbound's `epoch:` > none.
  const rows: Array<{ name: string; flag?: string; ambient?: string; inbound?: string; want: string | undefined }> = [
    { name: "--epoch alone", flag: "7", want: "7" },
    { name: "ambient TAP_EPOCH alone", ambient: "9", want: "9" },
    { name: "--epoch beats ambient TAP_EPOCH", flag: "7", ambient: "9", want: "7" },
    { name: "--epoch beats the inbound's epoch", flag: "7", inbound: "3", want: "7" },
    { name: "ambient TAP_EPOCH beats the inbound's epoch", ambient: "9", inbound: "3", want: "9" },
    { name: "the inbound's epoch alone", inbound: "3", want: "3" },
    { name: "no epoch anywhere", want: undefined },
    // The partner reviewer: an EMPTY ambient TAP_EPOCH is absent on the incumbent
    // (`${TAP_EPOCH:-}`), so the inbound's epoch travels — a port keyed on the
    // variable's presence would stamp nothing and still pass the rows above.
    { name: "an explicitly empty TAP_EPOCH is absent: the inbound's epoch travels", ambient: "", inbound: "3", want: "3" },
    { name: "an explicitly empty TAP_EPOCH with no inbound epoch stamps nothing", ambient: "", want: undefined },
    { name: "a non-numeric --epoch is recorded, never interpreted", flag: "gen-4:b", want: "gen-4:b" },
  ];
  for (const row of rows) {
    test(`${row.name}: the .done carries epoch=${row.want === undefined ? "<absent>" : row.want}`, () => {
      const fx = fixture({ inboundEpoch: row.inbound });
      const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", ...(row.flag !== undefined ? ["--epoch", row.flag] : [])], row.ambient);
      expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
        .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
      const d = done(fx);
      expect({ epoch: d?.epoch, via: d?.via, by: d?.by, mail: outbounds(fx).length }).toEqual({ epoch: row.want, via: "reply", by: "ua", mail: 1 });
      // Frozen (was the cross-door parity check, the sole assertion of the
      // receipt's full key shape; native's byte-for-byte value carries forward).
      const wantKeys = row.want === undefined
        ? ["at", "by", "id", "instance", "reply_id", "reply_preview", "reply_sha256", "status", "via"]
        : ["at", "by", "epoch", "id", "instance", "reply_id", "reply_preview", "reply_sha256", "status", "via"];
      expect(Object.keys(d ?? {}).sort()).toEqual(wantKeys);
    }, 120_000);
  }

  test("--progress --epoch: a progress outbound settles nothing, so no epoch is stamped anywhere", () => {
    const fx = fixture({ inboundEpoch: "3" });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "still working", "--by", "ua", "--progress", "--epoch", "7"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, done: done(fx), mail: outbounds(fx).length })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: progress ${INBOUND_ID} (open)\n`, done: null, mail: 1 });
  }, 120_000);

  test("a bare or empty --epoch is refused (usage_error), nothing placed, the inbound open", () => {
    for (const args of [["--epoch"], ["--epoch", ""]]) {
      const fx = fixture();
      const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", ...args]);
      expect({ args, code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, mail: outbounds(fx).length, done: done(fx) })
        .toEqual({ args, code: 1, route: "native reply", stdout: "", stderr: "tap reply: --epoch needs a value; next: tap help reply\n", mail: 0, done: null });
    }
  }, 120_000);
});
