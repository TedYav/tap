// `tap withdraw <id>` — sender-side retraction of a DELIVERED obligation the
// sender superseded (tap-owanr; rule 43's head-move cancellation had no verb).
//
// The verb is native-only and born without a Bash twin, so there is no door
// differential to run here (rule 34's oracle applies to a ported verb, not a new
// one). What these rows pin instead is the thing the design turns on: the
// receipt is `.cancelled` with `via: withdrawn` and the payload STAYS RESIDENT,
// which is what makes the recipient's tombstone reachable and the sender's
// obligation stop aging, without inventing a receipt suffix the Bash readers do
// not know.
//
// Runner boundary: `bash runtime/bun/test/run.sh` supplies TMUX_TMPDIR and the
// scrubbed TMUX; the fixture pins TAP_INDEX_HOME / HOME / TAP_LOCK_DIR and a
// fake tmux on PATH. No real server is started and no pane is written.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeScratchTree } from "./support/scratch";
import { acquireResetMutationLock } from "../src/reset";
import { writeAllSync } from "../src/fsatomic";

const REPO = join(import.meta.dir, "..", "..", "..");
const TAP = join(REPO, "bin", "tap");

const scratchRoot = mkdtempSync(join(tmpdir(), "tap-withdraw."));
afterAll(async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { removeScratchTree(scratchRoot); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
  }
}, 40_000);

// `sa` (the sender, %1) and `ra` (the recipient, %2), both claude, one team.
// FAKE_KEYS records every send-keys: an empty file is the pane-effect control.
const FAKE_TMUX = `#!/bin/sh
case " $* " in
  *"list-sessions"*) printf 'sa\\t123:456\\n'; printf 'ra\\t123:456\\n' ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%1\\n%%2\\n' ;;
  *"list-panes"*)
    case " $* " in
      *"=ra"*|*" ra:"*|*" ra "*) printf 'ra\\tra:0.0\\t%%2\\tclaude\\t4242\\t123:456\\t0\\n' ;;
      *) printf 'sa\\tsa:0.0\\t%%1\\tclaude\\t4242\\t123:456\\t0\\n' ;;
    esac ;;
  *"send-keys"*) printf '%s\\n' "$*" >> "\${FAKE_KEYS:-/dev/null}" ;;
esac
exit 0
`;

const ID = "sa-20260916T120000Z-aabbccddeeff";
const SUCCESSOR = "sa-20260916T130000Z-112233445566";

interface FixtureOpts {
  /** Envelope overrides for the delivered payload. */
  envelope?: Record<string, string>;
  /** Write a `.done` receipt before the withdrawal (the recipient answered). */
  done?: boolean;
  /** Write a `.cancelled` receipt before the withdrawal. */
  cancelled?: Record<string, unknown>;
  /** Park the payload in spool/ instead of placing it in payloads/. */
  spooled?: boolean;
  /** Omit the payload entirely. */
  absent?: boolean;
}

function fixture(opts: FixtureOpts = {}) {
  const root = mkdtempSync(join(scratchRoot, "fx."));
  const index = join(root, "index");
  const bin = join(root, "bin");
  const wt = join(root, "team");
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  mkdirSync(index); mkdirSync(bin);
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  mkdirSync(join(bus, "spool"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", wt], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);

  const seats = {
    sa: { status: "active", pane: "sa:0.0", pane_id: "%1", server_epoch: "srv:123:456", instance: "sa|CURRENT", harness: "claude" },
    ra: { status: "active", pane: "ra:0.0", pane_id: "%2", server_epoch: "srv:123:456", instance: "ra|A", harness: "claude" },
  };
  writeFileSync(registry, `${JSON.stringify({ schema: "0.20", team: { name: "team", worktree_root: wt }, seats })}\n`);
  writeFileSync(join(index, "global-registry.json"),
    `${JSON.stringify({ schema: "0.20", teams: { team: { root: wt, registry_location: registry, state: "registered" } } })}\n`);

  const resident = join(bus, "payloads", `${ID}.md`);
  const parked = join(bus, "spool", `${ID}.md`);
  const payload = opts.spooled ? parked : resident;
  const fields: Record<string, string> = {
    from: "sa", to: "ra", kind: "discuss", reply: "expected",
    sender_instance: "sa|CURRENT", recipient_instance: "ra|A", ...opts.envelope,
  };
  if (!opts.absent) {
    const envelope = `---\nid: ${ID}\npath: ${payload}\n`
      + Object.entries(fields).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}\n`).join("")
      + "---\nthe original question?\n";
    writeFileSync(payload, envelope);
    writeFileSync(join(bus, "receipts", `${ID}.placed`), "{}\n");
    writeFileSync(join(bus, "receipts", `${ID}.sent`), "{}\n");
  }
  if (opts.done) writeFileSync(join(bus, "receipts", `${ID}.done`), `${JSON.stringify({ id: ID, status: "done", via: "read", by: "ra", at: "2026-09-16T12:30:00Z" })}\n`);
  if (opts.cancelled) writeFileSync(join(bus, "receipts", `${ID}.cancelled`), `${JSON.stringify(opts.cancelled)}\n`);

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
    FAKE_KEYS: join(root, "keys"),
  } as NodeJS.ProcessEnv;
  delete env.TAP_HOME;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  return { root, wt, bus, env, keys: join(root, "keys"), resident, parked };
}

type Fx = ReturnType<typeof fixture>;

function run(fx: Fx, args: string[], self = "sa", extraEnv: NodeJS.ProcessEnv = {}) {
  const trace = join(fx.root, `route.${Math.random().toString(36).slice(2)}.trace`);
  const r = Bun.spawnSync([TAP, ...args], {
    cwd: fx.wt,
    env: { ...fx.env, TAP_SELF: self, TAP_BUN_ROUTE_TRACE: trace, ...extraEnv },
    stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const mask = (t: string) => t.split(`/private${fx.root}`).join("<root>").split(fx.root).join("<root>");
  return {
    code: r.exitCode,
    stdout: mask(r.stdout.toString()),
    stderr: mask(r.stderr.toString()),
    route: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "",
  };
}

const cancelReceipt = (fx: Fx) => JSON.parse(readFileSync(join(fx.bus, "receipts", `${ID}.cancelled`), "utf8"));

describe("tap withdraw — the effect", () => {
  test("writes via=withdrawn, keeps the payload RESIDENT, and names the successor", () => {
    const fx = fixture();
    const r = run(fx, ["withdraw", ID, "-m", "head moved to 34e303ba2", "--superseded-by", SUCCESSOR]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("withdrawn");
    expect(r.stdout).toContain(SUCCESSOR);
    const rec = cancelReceipt(fx);
    expect(rec.via).toBe("withdrawn");
    expect(rec.status).toBe("cancelled");
    expect(rec.by).toBe("sa");
    expect(rec.reason).toBe("head moved to 34e303ba2");
    expect(rec.superseded_by).toBe(SUCCESSOR);
    // THE design invariant: archiving a delivered id is what strands the
    // recipient's doorbell, so the payload must still be where they can read it.
    expect(existsSync(fx.resident)).toBe(true);
    // Mark only: no pane effect, for any class.
    expect(existsSync(fx.keys)).toBe(false);
  });

  test("the sender's obligation stops aging in tap outstanding", () => {
    const fx = fixture();
    expect(run(fx, ["outstanding", "sa"]).stdout).toContain(ID);
    expect(run(fx, ["withdraw", ID, "-m", "superseded"]).code).toBe(0);
    expect(run(fx, ["outstanding", "sa"]).stdout).not.toContain(ID);
  });

  test("a reason is optional and its absence is stated, not faked", () => {
    const fx = fixture();
    expect(run(fx, ["withdraw", ID]).code).toBe(0);
    expect(cancelReceipt(fx).reason).toBeUndefined();
    expect(run(fx, ["read", ID], "ra").stdout).toContain("no reason given");
  });

  test("--json reports the withdrawal structurally", () => {
    const fx = fixture();
    const r = run(fx, ["withdraw", ID, "-m", "why", "--superseded-by", SUCCESSOR, "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ ok: true, id: ID, via: "withdrawn", by: "sa", to: "ra", reason: "why", superseded_by: SUCCESSOR });
  });
});

describe("tap withdraw — the recipient's tombstone", () => {
  test("read answers in one line, owes nothing, and writes no settlement of its own", () => {
    const fx = fixture();
    run(fx, ["withdraw", ID, "-m", "the ask was wrong", "--superseded-by", SUCCESSOR]);
    const r = run(fx, ["read", ID], "ra");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("superseded: the ask was wrong");
    expect(r.stdout).toContain(SUCCESSOR);
    // Read must not manufacture a `.done`: the sender withdrew it, the
    // recipient did not settle it, and provenance must keep saying so.
    expect(existsSync(join(fx.bus, "receipts", `${ID}.done`))).toBe(false);
    expect(cancelReceipt(fx).via).toBe("withdrawn");
  });

  test("read --verbose says who withdrew it and where to go instead", () => {
    const fx = fixture();
    run(fx, ["withdraw", ID, "-m", "r", "--superseded-by", SUCCESSOR]);
    const r = run(fx, ["read", ID, "--force"], "ra");
    expect(r.stdout).toContain("via: withdrawn");
    expect(r.stdout).toContain(`answer ${SUCCESSOR} instead`);
  });

  test("the BASH door renders the same tombstone (--by delegates to it)", () => {
    // `read` is Bash-owned for `--by` and `--team`, so the recipient reading
    // through either of those forms takes the incumbent door. Its cancel branch
    // hardcoded `SETTLED_NOTE=cancelled` exactly as native's did, which would
    // have left the tombstone existing on one door only.
    const fx = fixture();
    run(fx, ["withdraw", ID, "-m", "wrong head", "--superseded-by", SUCCESSOR]);
    const r = run(fx, ["read", ID, "--by", "ra"], "ra");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("superseded: wrong head");
    expect(r.stdout).toContain(SUCCESSOR);
    expect(existsSync(join(fx.bus, "receipts", `${ID}.done`))).toBe(false);
  });

  test("an ORDINARY cancellation keeps its own wording — only a withdrawal gets the tombstone", () => {
    const fx = fixture({ cancelled: { id: ID, status: "cancelled", via: "cancelled", by: "sa", at: "2026-09-16T12:00:00Z" } });
    const r = run(fx, ["read", ID], "ra");
    expect(r.stdout).not.toContain("superseded:");
    expect(r.stdout).not.toContain("withdrawn");
  });

  test("reply is refused and NAMES the successor", () => {
    const fx = fixture();
    run(fx, ["withdraw", ID, "-m", "wrong head", "--superseded-by", SUCCESSOR]);
    const body = join(fx.root, "answer.md");
    writeFileSync(body, "an answer\n");
    const r = run(fx, ["reply", ID, "-f", body], "ra");
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("withdrawn");
    expect(`${r.stdout}${r.stderr}`).toContain(SUCCESSOR);
  });

  test("the native reply door refuses a withdrawn inbound (--delivery interrupt) BEFORE any outbound", () => {
    // The hole a reviewer found on the RETAIN panel, and the reason the
    // census missed it: a gate on `.done` alone that never names `.cancelled`
    // cannot see this. It only became REACHABLE because a withdrawn payload
    // deliberately stays resident — archiving would have failed the inbound
    // lookup instead. Without this guard the payload looks like ordinary mail:
    // it would compose and deliver an outbound, then write `.done` beside the
    // `.cancelled`, and since every reader prefers `.done` the tombstone
    // vanishes and provenance claims the recipient settled a retraction.
    const fx = fixture();
    run(fx, ["withdraw", ID, "-m", "wrong head", "--superseded-by", SUCCESSOR]);
    const before = readdirSync(join(fx.bus, "payloads")).sort();
    const body = join(fx.root, "answer.md");
    writeFileSync(body, "an answer\n");
    const r = run(fx, ["reply", ID, "-f", body, "--delivery", "interrupt"], "ra");
    expect(r.route).toBe("native reply");
    expect(r.code).not.toBe(0);
    const said = `${r.stdout}${r.stderr}`;
    expect(said).toContain("withdrawn");
    expect(said).toContain(SUCCESSOR);
    // No delivery, no settlement, and the payload still readable.
    expect(readdirSync(join(fx.bus, "payloads")).sort()).toEqual(before);
    expect(existsSync(join(fx.bus, "receipts", `${ID}.done`))).toBe(false);
    expect(existsSync(fx.resident)).toBe(true);
    expect(cancelReceipt(fx).via).toBe("withdrawn");
  });

  test("a NON-REGULAR .cancelled is not terminal — the guard matches tap_is_done", () => {
    // The residual grok flagged on the F&S accept: `tap_refuse_if_cancelled`
    // used `[ -e ]` where `tap_is_done` uses `[ -f ]`. Two predicates disagreeing
    // about the same record is the exact shape this member exists to remove.
    // `-f` is the correct side BY CONSISTENCY: if `tap_is_done` does not count a
    // directory as settled, the obligation is still open and the reply door must
    // not refuse it as terminal. Under `-e` the guard instead tried to parse a
    // directory as JSON, fell back to via="cancelled", and refused a LIVE ask.
    const fx = fixture();
    mkdirSync(join(fx.bus, "receipts", `${ID}.cancelled`), { recursive: true });
    const before = readdirSync(join(fx.bus, "payloads")).length;
    const body = join(fx.root, "answer.md");
    writeFileSync(body, "an answer\n");
    const r = run(fx, ["reply", ID, "-f", body, "--delivery", "interrupt"], "ra");
    const said = `${r.stdout}${r.stderr}`;
    // POSITIVE, because an absence-of-error-strings assertion cannot tell
    // "the guard let it through" from "it died before the guard for an
    // unrelated reason" — and measured, that is exactly what happened: a probe
    // of an earlier version of this arm exited 3 on "pane 'sa:0.0' gone" and
    // still satisfied both `not.toContain`s. A fixture that cannot distinguish
    // its claim from its neighbour is not evidence (rule 57(a)).
    // WHICH refusal it hits is the distinguishing fact, so assert that rather
    // than a bare exit code. This fixture's sender pane is not deliverable, so
    // the reply fails at the SEND stage either way — the question is whether it
    // GOT there. "left unsettled" is emitted only after the terminality gate
    // has been passed and the outbound attempted, so it is positive evidence of
    // reaching the send; under `-e` the guard refuses first and this line never
    // appears. (Measured: an earlier version asserted only the ABSENCE of the
    // terminal strings and passed because the reply died at the pane for an
    // unrelated reason — rule 57(a), on this very arm.)
    expect(said).toContain("left unsettled");
    expect(said).not.toContain("already terminal");
    expect(said).not.toContain("was withdrawn by its sender");
    // Nothing settled, and no outbound became durable.
    expect(existsSync(join(fx.bus, "receipts", `${ID}.done`))).toBe(false);
    expect(readdirSync(join(fx.bus, "payloads")).length).toBe(before);
  });

  test("show surfaces via, reason and the successor on the receipt row", () => {
    const fx = fixture();
    run(fx, ["withdraw", ID, "-m", "because", "--superseded-by", SUCCESSOR]);
    const r = run(fx, ["show", ID]);
    expect(r.stdout).toContain("via=withdrawn");
    expect(r.stdout).toContain(`superseded_by=${SUCCESSOR}`);
  });
});

describe("tap withdraw — authority and refusals", () => {
  test("only the original sender withdraws", () => {
    const fx = fixture();
    const r = run(fx, ["withdraw", ID, "--json"], "ra");
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).error_class).toBe("not_sender");
    expect(existsSync(join(fx.bus, "receipts", `${ID}.cancelled`))).toBe(false);
  });

  test("a STALE SENDER INSTANCE still withdraws — the ratified deviation from resend", () => {
    // resend.py:80-83 refuses when `sender_instance` is not current, because it
    // re-sends UNDER that identity. Withdraw only retracts, and rule 30's
    // refresh (`/clear` + `tap in`) makes a predecessor instance routine: the
    // reloaded seat holding its predecessor's aging asks is exactly who needs
    // this verb, so binding it to the instance would refuse its own use case.
    const fx = fixture({ envelope: { sender_instance: "sa|PREDECESSOR" } });
    const r = run(fx, ["withdraw", ID, "-m", "my predecessor's ask"]);
    expect(r.code).toBe(0);
    expect(cancelReceipt(fx).via).toBe("withdrawn");
  });

  test("a send from another TEAM is refused", () => {
    const fx = fixture({ envelope: { from_team: "elsewhere" } });
    const r = run(fx, ["withdraw", ID, "--json"]);
    expect(JSON.parse(r.stdout.trim()).error_class).toBe("not_sender");
  });

  test("an already-settled obligation is refused — a real settlement is never overwritten", () => {
    const fx = fixture({ done: true });
    const r = run(fx, ["withdraw", ID, "--json"]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).error_class).toBe("already_settled");
    expect(JSON.parse(readFileSync(join(fx.bus, "receipts", `${ID}.done`), "utf8")).via).toBe("read");
    expect(existsSync(join(fx.bus, "receipts", `${ID}.cancelled`))).toBe(false);
  });

  test("withdrawal is not repeatable", () => {
    const fx = fixture();
    expect(run(fx, ["withdraw", ID, "-m", "first"]).code).toBe(0);
    const r = run(fx, ["withdraw", ID, "-m", "second", "--json"]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).error_class).toBe("already_settled");
    // The first withdrawal's reason survives the second attempt.
    expect(cancelReceipt(fx).reason).toBe("first");
  });

  test("a SPOOLED send is redirected to cancel --spooled, not withdrawn here", () => {
    // Queue custody has one owner. Duplicating cancel's claim handling would be
    // the parallel engine rule 1 forbids.
    const fx = fixture({ spooled: true });
    const r = run(fx, ["withdraw", ID, "--json"]);
    expect(r.code).not.toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.error_class).toBe("not_delivered");
    expect(out.action).toContain("--spooled");
    expect(existsSync(join(fx.bus, "receipts", `${ID}.cancelled`))).toBe(false);
    expect(existsSync(fx.parked)).toBe(true);
  });

  test("HELD RESET CUSTODY refuses, and leaves no receipt", () => {
    // Partner review, G1-F1. A point-in-time `assertResetUnfenced` left the cut
    // race open: reset takes its sidecar after the check, cuts the still-open
    // obligation, and the withdrawal then publishes `.cancelled` into the fresh
    // blank bus — restoring the checkpoint RESURRECTS work the sender was told
    // was withdrawn.
    //
    // The lock is taken through the PRODUCTION function, so the arm exercises
    // the real custody mechanism rather than a hand-rolled imitation of it that
    // could hold a different lock and pass for the wrong reason.
    const fx = fixture();
    const held = acquireResetMutationLock(fx.bus, "test-holder");
    let r: ReturnType<typeof run>;
    try {
      r = run(fx, ["withdraw", ID, "-m", "during a reset", "--json"]);
    } finally { held.release(); }
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).error_class).toBe("reset_custody_busy");
    // The invariant that matters: no tombstone was published without custody.
    expect(existsSync(join(fx.bus, "receipts", `${ID}.cancelled`))).toBe(false);
    // And the obligation is still open afterwards.
    expect(run(fx, ["outstanding", "sa"]).stdout).toContain(ID);
  });

  test("a withdrawal receipt carries none of the retirement marker fields", () => {
    // Field-shape tripwire on the WRITER only. The consumer axis — a withdrawal
    // receipt is NOT a retirement receipt — is proven against the real
    // retirementCandidates() in spool-retired.test.ts.
    const fx = fixture();
    run(fx, ["withdraw", ID, "-m", "superseded"]);
    const rec = cancelReceipt(fx);
    expect(rec.by).toBe("sa");
    expect(rec.reason).toBe("superseded");
    expect(rec.source).toBeUndefined();
    expect(rec.via).toBe("withdrawn");
  });

  test("a NON-ACTING pinned bus is refused, and nothing is written to the acting one", () => {
    // Review catch. Converting a caller pin into a
    // `pinnedRoot` resolves the ROOT to its ACTING bus — so a caller pinned at a
    // different bus under the same root was silently redirected and then
    // WRITTEN TO, on a bus it never named. Root match is not bus match.
    const fx = fixture();
    const legacy = join(fx.wt, ".tap", "legacy-bus");
    mkdirSync(join(legacy, "payloads"), { recursive: true });
    mkdirSync(join(legacy, "receipts"), { recursive: true });
    const r = run(fx, ["withdraw", ID, "-m", "wrong bus", "--json"], "sa", { TAP_HOME: legacy });
    expect(r.code).not.toBe(0);
    // THE invariant: no write effect on the bus the caller did not name.
    expect(existsSync(join(fx.bus, "receipts", `${ID}.cancelled`))).toBe(false);
    expect(existsSync(join(legacy, "receipts", `${ID}.cancelled`))).toBe(false);
    // And the obligation is still open on the acting bus.
    expect(run(fx, ["outstanding", "sa"]).stdout).toContain(ID);
  });

  test("a STANDALONE pin is honoured from an ENROLLED FOREIGN cwd", () => {
    // Review, measured through three public doors. The walk
    // ignores TAP_HOME whenever the cwd is enrolled, so resolving a standalone
    // pin from the CALLER's cwd silently dropped it: withdraw returned 0 and
    // wrote `.cancelled` to the cwd's bus — a terminal effect on a bus the
    // caller never named, reported as success.
    //
    // The id exists ONLY on the pinned standalone bus, so answering from the
    // enrolled cwd cannot be mistaken for success: it would have to write there.
    const fx = fixture();
    const standalone = join(fx.root, "standalone", ".tap", "bus");
    mkdirSync(join(standalone, "payloads"), { recursive: true });
    mkdirSync(join(standalone, "receipts"), { recursive: true });
    const pinnedPayload = join(standalone, "payloads", `${ID}.md`);
    writeFileSync(pinnedPayload, readFileSync(fx.resident, "utf8").replace(fx.resident, pinnedPayload));
    // Remove it from the enrolled cwd's bus so the two buses are distinguishable.
    unlinkSync(fx.resident);

    const r = run(fx, ["withdraw", ID, "-m", "pinned"], "sa", { TAP_HOME: standalone });
    expect(r.code).toBe(0);
    // The PINNED bus got the receipt...
    expect(existsSync(join(standalone, "receipts", `${ID}.cancelled`))).toBe(true);
    // ...and the enrolled cwd's bus was never touched.
    expect(existsSync(join(fx.bus, "receipts", `${ID}.cancelled`))).toBe(false);
  });

  test("an unknown id is not found", () => {
    const fx = fixture({ absent: true });
    const r = run(fx, ["withdraw", ID, "--json"]);
    expect(JSON.parse(r.stdout.trim()).error_class).toBe("not_found");
  });

  test("a malformed --superseded-by is refused before any effect", () => {
    const fx = fixture();
    const r = run(fx, ["withdraw", ID, "--superseded-by", "not an id", "--json"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(fx.bus, "receipts", `${ID}.cancelled`))).toBe(false);
  });

  test("an unknown option is refused", () => {
    const fx = fixture();
    expect(run(fx, ["withdraw", ID, "--nope"]).code).not.toBe(0);
  });
});

describe("tap withdraw — a short write never publishes a receipt", () => {
  // Review catch: staging + fsync + an exclusive link
  // defends against a THROWN error and establishes nothing about a PARTIAL
  // write, which `writeSync` reports by returning a smaller count. Their probe
  // produced a `.cancelled` holding exactly `{"id":"s` at exit 0.
  //
  // The seam is injectable rather than mocked: `mock.module` on `node:fs` is not
  // undone by `mock.restore`, so a global fs mock leaks into sibling files
  // (rule 47 / tap-zq33r). This exercises the real production loop.
  test("a writer that stops short still writes EVERY byte", () => {
    // The defect is a partial write reported as success, so the property is
    // completeness, not refusal: a writer that returns a small POSITIVE count
    // is legal and must be driven to the end. (An earlier version of this arm
    // asserted it should throw — which is wrong, and the red baseline said so.)
    const buf = Buffer.from("{\"id\":\"sa-1\",\"via\":\"withdrawn\"}\n", "utf8");
    let written = 0;
    writeAllSync(1, buf, (_fd, _b, _off, len) => { const n = Math.min(3, len); written += n; return n; });
    expect(written).toBe(buf.length);
  });

  test("a writer that returns zero refuses instead of spinning", () => {
    const buf = Buffer.from("abc", "utf8");
    expect(() => writeAllSync(1, buf, () => 0)).toThrow(/short write/);
  });

  test("a writer that advances in chunks completes exactly once", () => {
    // The control: partial counts are fine as long as they ADVANCE, and the
    // loop must write every byte exactly once rather than restarting.
    const buf = Buffer.from("0123456789", "utf8");
    const seen: Array<[number, number]> = [];
    writeAllSync(1, buf, (_fd, _b, off, len) => { seen.push([off, len]); return Math.min(4, len); });
    expect(seen).toEqual([[0, 10], [4, 6], [8, 2]]);
  });
});

describe("tap withdraw — the interrupt class is MARKED, never touched", () => {
  // resend refuses the interrupt class outright (resend.py:104-105) because it
  // would re-fire a pane interrupt. Withdraw has no delivery step at all, so it
  // is allowed — and "mark only" is mechanical rather than promised: the
  // `.cancelled` receipt makes tap_is_done true, and the drain's resurrection
  // guard is `tap_is_done "$id" && continue` (lib.sh:3721).
  for (const envelope of [{ kind: "escalate" }, { urgency: "urgent" }] as Record<string, string>[]) {
    const label = Object.entries(envelope).map(([k, v]) => `${k}=${v}`).join(",");
    test(`${label} withdraws, writes no pane effect, and leaves the spool alone`, () => {
      const fx = fixture({ envelope });
      const r = run(fx, ["withdraw", ID, "-m", "superseded"]);
      expect(r.code).toBe(0);
      expect(cancelReceipt(fx).via).toBe("withdrawn");
      expect(existsSync(fx.keys)).toBe(false);
      expect(existsSync(join(fx.bus, "spool", `${ID}.md`))).toBe(false);
      expect(existsSync(fx.resident)).toBe(true);
    });
  }
});
