// Reply's forwarded forms on the native door (D4b, member 3a-bis-2 of the
// `reply` stack): `--delivery polite|now` (forwarded to the send that owns the
// classes since D3a — reply validates nothing itself, tap-reply.sh:56-62), `-f -`
// (the stdin body the native send has staged since D1) and `--allow-unattended`
// (the flag only skips reply's own unattended refusal, tap-reply.sh:224). Every
// row runs through the installed `bin/tap` over the two-team fixture of
// reply-foreign-route.test.ts, where alpha's `ub` (a second local seat on
// rb's pane) is the LOCAL original sender and beta's `rb` the FOREIGN one, and
// checks exit, route trace, receipt bytes, the spool's policy facts, the
// inbound's settlement, the outbound's body hash and the pane effect.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME / TAP_HOME / TAP_LOCK_DIR and a
// fake tmux on PATH. No real server is started.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";

import { envelopeBodyBytes, envelopeField } from "../src/envelope";
import { removeScratchTree } from "./support/scratch";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-reply-forms."));
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(scratchRoot); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}, 40_000);

// The fake tmux of reply-foreign-route.test.ts: `ua` (%6) and `rb` (%7), both
// claude. FAKE_BAND is rb's composer (a pre-existing file is a human draft).
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
      *) printf '%s\\n' "$*" >> "$FAKE_KEYS" ;;
    esac ;;
esac
exit 0
`;

interface Team { name: string; wt: string; bus: string; registry: string }

function team(root: string, name: string, seats: Record<string, unknown>): Team {
  const wt = join(root, name);
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q", wt], { stdout: "pipe", stderr: "pipe" });
  expect(git.exitCode).toBe(0);
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name, worktree_root: wt }, seats })}\n`);
  return { name, wt, bus, registry };
}

const RB = { status: "active", pane: "rb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "rb|B", harness: "claude" };
const INBOUND_ID = "rb-20260916T120000Z-aabbccddeeff";

interface FixtureOpts {
  /** The inbound's sender: alpha's `ub` (local, rb's pane) or beta's `rb` (foreign). */
  sender?: "local" | "foreign";
  /** alpha's `ub` is registered unattended. */
  unattended?: boolean;
  /** rb's composer holds a human draft. */
  draft?: boolean;
  /** The replying actor `ua` carries a stored `reply_to` (a team-qualified one makes the native send delegate AFTER staging). */
  actorReplyTo?: string;
  /** The inbound carries a stored `reply_to` the answer must route through. */
  inboundReplyTo?: string;
  /** beta's `rb` is registered with status_reason launching. */
  betaRbLaunching?: boolean;
}

function fixture(opts: FixtureOpts = {}) {
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  mkdirSync(index); mkdirSync(bin);
  const alpha = team(root, "alpha", {
    ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude", ...(opts.actorReplyTo ? { reply_to: opts.actorReplyTo } : {}) },
    ub: { status: "active", pane: "rb:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude", ...(opts.unattended ? { unattended: true } : {}) },
  });
  const beta = team(root, "beta", { rb: opts.betaRbLaunching ? { ...RB, status_reason: "launching" } : RB });
  writeFileSync(join(index, "global-registry.json"), `${JSON.stringify({
    schema: "0.20",
    teams: {
      alpha: { root: alpha.wt, registry_location: alpha.registry, state: "registered" },
      beta: { root: beta.wt, registry_location: beta.registry, state: "registered" },
    },
  })}\n`);
  const foreign = opts.sender === "foreign";
  const fields: Record<string, string> = {
    ...(foreign
      ? { from: "rb", to: "ua", kind: "discuss", reply: "expected", from_team: "beta", to_team: "alpha", cross_worktree: "true", sender_instance: "rb|B", recipient_instance: "ua|A" }
      : { from: "ub", to: "ua", kind: "discuss", reply: "expected", sender_instance: "ub|A", recipient_instance: "ua|A" }),
    ...(opts.inboundReplyTo ? { reply_to: opts.inboundReplyTo } : {}),
  };
  const payload = join(alpha.bus, "payloads", `${INBOUND_ID}.md`);
  writeFileSync(payload,
    `---\nid: ${INBOUND_ID}\npath: ${payload}\n` + Object.entries(fields).map(([k, v]) => `${k}: ${v}\n`).join("") + "---\nquestion?\n");
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

/** Run the installed native reply from alpha's worktree as `ua`; `stdin` feeds `-f -`. */
function run(fx: Fx, args: string[], stdin?: string): View {
  const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
  const r = Bun.spawnSync([TAP, ...args], {
    cwd: fx.alpha.wt,
    env: { ...fx.env, TAP_SELF: "ua", TAP_BUN_ROUTE_TRACE: trace },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  return { code: r.exitCode, route: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "", stdout: r.stdout.toString(), stderr: r.stderr.toString().split(fx.root).join("<root>") };
}

function outbounds(bus: string): string[] {
  const dir = join(bus, "payloads");
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md") && f !== `${INBOUND_ID}.md`).sort() : [];
}

function injected(fx: Fx): string[] {
  if (!existsSync(fx.keys)) return [];
  return readFileSync(fx.keys, "utf8").split("\n").filter(l => l.includes(" -l -- ")).map(l => l.slice(l.indexOf(" -l -- ") + " -l -- ".length));
}

function receipt(fx: Fx, name: string): Record<string, unknown> | null {
  const p = join(fx.alpha.bus, "receipts", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown> : null;
}

/** The spool's pinned policy facts (send-delivery-fixture's shape): reason, policy, timeout, target, team. */
function spool(bus: string): Array<Record<string, unknown>> {
  const dir = join(bus, "spool");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".meta.json")).sort().map(f => {
    const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    return { reason: meta.reason ?? null, policy: meta.policy ?? null, timeout_seconds: meta.timeout_seconds ?? null, target: meta.target ?? null, team: meta.team ?? null, to_team: meta.to_team ?? null };
  });
}

describe("reply's forwarded forms", () => {
  for (const explicit of [false, true]) {
    test(`reply never inherits interrupt permission from an escalation: explicit=${explicit}`, () => {
      const fx = fixture();
      const inbound = join(fx.alpha.bus, "payloads", `${INBOUND_ID}.md`);
      writeFileSync(inbound, readFileSync(inbound, "utf8").replace("kind: discuss", "kind: escalate\nurgency: urgent"));
      const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--kind", "escalate",
        "--delivery", explicit ? "interrupt" : "now"]);
      expect(v.code).toBe(0);
      expect(readFileSync(fx.keys, "utf8").includes("Escape")).toBe(explicit);
      expect(v.stderr.includes("interrupt attempt for")).toBe(explicit);
      expect(receipt(fx, `${INBOUND_ID}.done`)?.via).toBe("reply");
    }, 120_000);
  }
  for (const sender of ["local", "foreign"] as const) {
    const target = sender === "local" ? "ub" : "rb";
    test(`--delivery polite (${sender} sender): parks before any attempt with the polite policy and its 600 s timeout, the receipt says queued, the inbound settles`, () => {
      const fx = fixture({ sender });
      const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--delivery", "polite"]);
      expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
        .toEqual({ code: 0, route: "native reply", stdout: `tap reply: queued ${INBOUND_ID}\n`, stderr: "" });
      expect({ spool: spool(fx.alpha.bus), betaSpool: existsSync(join(fx.beta.bus, "spool")), injected: injected(fx), canonical: outbounds(fx.alpha.bus).length })
        .toEqual({ spool: [{ reason: "polite", policy: "polite", timeout_seconds: 600, target, team: "alpha", to_team: sender === "foreign" ? "beta" : "" }], betaSpool: false, injected: [], canonical: 0 });
      const done = receipt(fx, `${INBOUND_ID}.done`);
      expect({ via: done?.via, by: done?.by }).toEqual({ via: "reply", by: "ua" });
    }, 120_000);
  }

  test("--delivery polite --progress: the progress outbound parks polite and the inbound stays open", () => {
    const fx = fixture();
    const v = run(fx, ["reply", INBOUND_ID, "-m", "still working", "--by", "ua", "--progress", "--delivery", "polite"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: progress ${INBOUND_ID} (open)\n`, stderr: "" });
    expect({ spool: spool(fx.alpha.bus).map(m => m.reason), done: receipt(fx, `${INBOUND_ID}.done`) }).toEqual({ spool: ["polite"], done: null });
  }, 120_000);

  test("--delivery now: the default class by name — injects into the sender's pane and settles", () => {
    const fx = fixture();
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--delivery", "now"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const mail = outbounds(fx.alpha.bus);
    expect({ mail: mail.length, spool: spool(fx.alpha.bus).length, injected: injected(fx).length, done: receipt(fx, `${INBOUND_ID}.done`)?.via }).toEqual({ mail: 1, spool: 0, injected: 1, done: "reply" });
    expect(readFileSync(fx.keys, "utf8")).toMatch(/send-keys -t (%7|rb:0\.0) -l -- /);
  }, 120_000);

  test("--delivery now on a held draft still parks (the class does not clear a human's input)", () => {
    const fx = fixture({ draft: true });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--delivery", "now"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout }).toEqual({ code: 0, route: "native reply", stdout: `tap reply: queued ${INBOUND_ID}\n` });
    expect({ spool: spool(fx.alpha.bus).map(m => [m.reason, m.policy]), injected: injected(fx) }).toEqual({ spool: [["pending-input", "standard"]], injected: [] });
  }, 120_000);

  test("the classes are reachable only through --delivery: --polite, --polite-timeout and --no-spool are unknown options on reply", () => {
    for (const args of [["--polite"], ["--polite-timeout", "7"], ["--no-spool"]]) {
      const fx = fixture();
      const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", ...args]);
      expect({ args, code: v.code, stdout: v.stdout, stderr: v.stderr, mail: outbounds(fx.alpha.bus).length, done: receipt(fx, `${INBOUND_ID}.done`) })
        .toEqual({ args, code: 1, stdout: "", stderr: `tap reply: unknown option '${args[0]}'; next: tap help reply\n`, mail: 0, done: null });
    }
  }, 120_000);

  test("a bare --delivery with no operand is refused with native's usage_error — nothing placed, the inbound open (partner review)", () => {
    const fx = fixture();
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--delivery"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, mail: outbounds(fx.alpha.bus).length, spool: spool(fx.alpha.bus).length, done: receipt(fx, `${INBOUND_ID}.done`) })
      .toEqual({ code: 1, route: "native reply", stdout: "", stderr: "tap reply: --delivery needs a value; next: tap help reply\n", mail: 0, spool: 0, done: null });
  }, 120_000);

  // Two calling shapes for the stdin body: the plain local path, and the one
  // whose replying actor carries a stored team-qualified reply_to — since
  // checkpoint A of the SendReply R2 slice that stamp is delivered by the
  // native send's own deliverability port, so both shapes route native reply
  // and stdin is consumed once. The body has no trailing newline so a replay
  // that appends one reds; the receipt hash is checked against the DURABLE
  // body on the bus.
  for (const shape of [
    { name: "all native", opts: {} as FixtureOpts, nativeRoute: "native reply" },
    { name: "the actor's stored qualified reply_to", opts: { actorReplyTo: "beta/rb" } as FixtureOpts, nativeRoute: "native reply" },
  ]) {
    test(`-f - (${shape.name}): the body comes from stdin — the bus body is byte-exact and the receipt hashes those bytes`, () => {
      const body = "answer from stdin\nwith a second line and a tab\there, no trailing newline";
      const fx = fixture(shape.opts);
      const v = run(fx, ["reply", INBOUND_ID, "-f", "-", "--by", "ua"], body);
      expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
        .toEqual({ code: 0, route: shape.nativeRoute, stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
      const mail = outbounds(fx.alpha.bus);
      expect({ mail: mail.length }).toEqual({ mail: 1 });
      const rawBytes = readFileSync(join(fx.alpha.bus, "payloads", mail[0]!));
      const raw = rawBytes.toString("utf8");
      const busBody = envelopeBodyBytes(rawBytes)!;
      const done = receipt(fx, `${INBOUND_ID}.done`);
      expect({ body: busBody.toString("utf8"), replyTo: envelopeField(raw, "reply_to"), replyId: done?.reply_id, sha: done?.reply_sha256 })
        .toEqual({ body, replyTo: undefined, replyId: mail[0]!.replace(/\.md$/, ""), sha: createHash("sha256").update(busBody).digest("hex") });
    }, 120_000);
  }

  test("--allow-unattended: an unattended local original sender is answered; without the flag the incumbent's refusal", () => {
    const fx = fixture({ unattended: true });
    const refused = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: refused.code, stderr: refused.stderr, mail: outbounds(fx.alpha.bus).length }).toEqual({
      code: 1, mail: 0,
      stderr: `tap reply: 'ub' is unattended; inbound replies are refused by default unless reporting a problem; next: tap read ${INBOUND_ID} or tap reply ${INBOUND_ID} --allow-unattended -f <file>\n`,
    });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--allow-unattended"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    expect({ mail: outbounds(fx.alpha.bus).length, injected: injected(fx).length, done: receipt(fx, `${INBOUND_ID}.done`)?.via }).toEqual({ mail: 1, injected: 1, done: "reply" });
  }, 120_000);

  test("router: every reply argv stays native — delivery classes, their value validation, and a missing or empty operand", () => {
    const native = [["--delivery", "polite"], ["--delivery", "now"], ["--delivery", "interrupt"], ["--delivery", "bogus"], ["--allow-unattended"], ["--pane", "rb:0.0"], ["--reply-to", "ua"]];
    for (const args of native) expect({ args, route: run(fixture(), ["reply", INBOUND_ID, "-m", "x", "--by", "ua", ...args]).route }).toEqual({ args, route: "native reply" });
    expect(run(fixture(), ["reply", INBOUND_ID, "-f", "-", "--by", "ua"], "x\n").route).toBe("native reply");
    const positional = fixture();
    expect(run(positional, ["reply", INBOUND_ID, join(positional.alpha.bus, "payloads", `${INBOUND_ID}.md`), "--by", "ua"]).route).toBe("native reply");
    // The D feeder is closed: a missing operand is a native usage_error on
    // every value option, an empty one on every option but `-m`/`--preview`.
    const refused: Array<[string[], string]> = [
      [["-m", "x", "--by", "ua", "--delivery"], "--delivery"], [["-m", "x", "--by", "ua", "--pane"], "--pane"],
      [["-m", "x", "--by", "ua", "--team", ""], "--team"], [["-m", "x", "--by", ""], "--by"],
      [["-f", "", "--by", "ua"], "--body-file"], [["--by", "ua", "-m"], "-m"], [["-m", "x", "--by", "ua", "--preview"], "--preview"],
    ];
    for (const [args, name] of refused) {
      const fx = fixture();
      const v = run(fx, ["reply", INBOUND_ID, ...args]);
      expect({ args, code: v.code, route: v.route, stderr: v.stderr, mail: outbounds(fx.alpha.bus).length, done: receipt(fx, `${INBOUND_ID}.done`) })
        .toEqual({ args, code: 1, route: "native reply", stderr: `tap reply: ${name} needs a value; next: tap help reply\n`, mail: 0, done: null });
    }
  }, 120_000);

  test("an empty -m and an empty --preview are accepted natively, as Bash's `${2?}` accepted them: the reply lands and the inbound settles", () => {
    for (const args of [["-m", ""], ["-m", "answer", "--preview", ""]]) {
      const fx = fixture();
      const v = run(fx, ["reply", INBOUND_ID, ...args, "--by", "ua"]);
      expect({ args, code: v.code, route: v.route, stdout: v.stdout, mail: outbounds(fx.alpha.bus).length, settled: receipt(fx, `${INBOUND_ID}.done`) !== null })
        .toEqual({ args, code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, mail: 1, settled: true });
    }
  }, 120_000);
});

describe("reply's outbound addressing forms — checkpoint A (U1)", () => {
  test("an explicit --reply-to rides the composed send and stamps the qualified address", () => {
    const fx = fixture();
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua", "--reply-to", "ub"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const raw = readFileSync(join(fx.alpha.bus, "payloads", outbounds(fx.alpha.bus)[0]!), "utf8");
    expect({ replyTo: envelopeField(raw, "reply_to"), done: receipt(fx, `${INBOUND_ID}.done`)?.via, injected: injected(fx).length })
      .toEqual({ replyTo: "alpha/ub", done: "reply", injected: 1 });
  }, 120_000);

  test("a positional body file is the outbound body byte for byte", () => {
    const fx = fixture();
    const bodyPath = join(fx.root, "body.md");
    writeFileSync(bodyPath, "answer from a positional file\nsecond line, no trailing newline");
    const v = run(fx, ["reply", INBOUND_ID, bodyPath, "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const mail = outbounds(fx.alpha.bus);
    expect({ mail: mail.length, done: receipt(fx, `${INBOUND_ID}.done`)?.via, injected: injected(fx).length })
      .toEqual({ mail: 1, done: "reply", injected: 1 });
    const busBody = envelopeBodyBytes(readFileSync(join(fx.alpha.bus, "payloads", mail[0]!)))!.toString("utf8");
    expect(busBody).toBe("answer from a positional file\nsecond line, no trailing newline");
  }, 120_000);

  test("an inbound stored team-qualified reply_to redirects the answer to that seat", () => {
    const fx = fixture({ inboundReplyTo: "beta/rb" });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
    const mail = outbounds(fx.alpha.bus);
    const raw = readFileSync(join(fx.alpha.bus, "payloads", mail[0]!), "utf8");
    expect({ mail: mail.length, to: envelopeField(raw, "to"), fromTeam: envelopeField(raw, "from_team"), toTeam: envelopeField(raw, "to_team"), done: receipt(fx, `${INBOUND_ID}.done`)?.via, injected: injected(fx).length })
      .toEqual({ mail: 1, to: "rb", fromTeam: "alpha", toTeam: "beta", done: "reply", injected: 1 });
  }, 120_000);

  // Review round 1 (important 3): a redirect target carrying a `launching`
  // status_reason is NOT deliverable (tap_seat_deliverable, lib.sh:7337-7343),
  // so the answer falls back to the original sender.
  test("a launching redirect target falls back to the original sender", () => {
    const fx = fixture({ inboundReplyTo: "beta/rb", betaRbLaunching: true });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`,
        stderr: expect.stringContaining("is no longer deliverable") });
    const mail = outbounds(fx.alpha.bus);
    const raw = readFileSync(join(fx.alpha.bus, "payloads", mail[0]!), "utf8");
    expect({ mail: mail.length, to: envelopeField(raw, "to"), fromTeam: envelopeField(raw, "from_team"), toTeam: envelopeField(raw, "to_team"), injected: injected(fx).length })
      .toEqual({ mail: 1, to: "ub", fromTeam: undefined, toTeam: undefined, injected: 1 });
  }, 120_000);

  // Review round 1 (important 4): with a reference present, the body-count
  // refusal is the `pass exactly one message source…` sentence ALONE (the
  // incumbent checks the reference first, tap-reply.sh:76 vs :87-93) — the
  // usage line belongs only to a MISSING reference.
  test("the body-source refusal emits the incumbent's sentence alone, zero and multiple sources", () => {
    const fx = fixture();
    const zero = run(fx, ["reply", INBOUND_ID, "--by", "ua"]);
    expect({ code: zero.code, route: zero.route }).toEqual({ code: 1, route: "native reply" });
    expect(zero.stderr).toContain("pass exactly one message source: -m \"text\", -f <body-file>, or a positional <payload-file>");
    expect(zero.stderr).not.toContain("usage: tap reply");
    const multi = run(fixture(), ["reply", INBOUND_ID, "-m", "text", "-f", "-", "--by", "ua"], "stdin body\n");
    expect({ code: multi.code, route: multi.route }).toEqual({ code: 1, route: "native reply" });
    expect(multi.stderr).toContain("pass exactly one message source: -m \"text\", -f <body-file>, or a positional <payload-file>");
    expect(multi.stderr).not.toContain("usage: tap reply");
    const positionalClash = run(fixture(), ["reply", INBOUND_ID, "some-file.md", "-m", "text", "--by", "ua"]);
    expect({ code: positionalClash.code }).toEqual({ code: 1 });
    expect(positionalClash.stderr).toContain("pass exactly one message source: -m \"text\", -f <body-file>, or a positional <payload-file>");
  }, 120_000);
});
