// Ported from the retired smoke waiter-lifetime.test.sh (tap-w4f7 Fork A) plus the
// window-owner arm of delivery-window-drain.test.sh (arm 0c). The deliverer under
// test is the real spool-waiter.ts process, spawned and joined so the measurement
// is its own exit: a parked entry's WAITER LIFETIME and its expiry DISPOSITION are
// separate facts, and both arms assert behavior, never the field — an arm reading
// `waiter_lifetime` would pass a rename while the waiter still died early.
import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintMeta } from "../src/spool-publication";

const repo = join(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The retired smoke's sandbox: a copied tree (the waiter re-execs and spawns its
// drain child from it), a fixture bus, and the retired file's own stateful fake
// tmux, carried over verbatim: its C-u clear, cancel, stuck-submit and logged
// send-keys arms are what the draft-restoration and no-notice assertions read.
function sandbox() {
  const work = mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "waiter-lifetime-"));
  roots.push(work);
  const scripts = join(work, "skills/tap/scripts");
  mkdirSync(join(scripts, "smoke"), { recursive: true });
  for (const helper of ["runtime-helpers.sh", "runtime-primitives.sh"])
    cpSync(join(repo, "skills/tap/scripts/smoke", helper), join(scripts, "smoke", helper));
  for (const entry of readdirSync(join(repo, "skills/tap/scripts"), { withFileTypes: true })) {
    if (["smoke", "regress", "__pycache__"].includes(entry.name)) continue;
    entry.isDirectory()
      ? cpSync(join(repo, "skills/tap/scripts", entry.name), join(scripts, entry.name), { recursive: true })
      : cpSync(join(repo, "skills/tap/scripts", entry.name), join(scripts, entry.name));
  }
  cpSync(join(repo, "runtime/bun/src"), join(work, "runtime/bun/src"), { recursive: true });
  cpSync(join(repo, "runtime/bun/main.ts"), join(work, "runtime/bun/main.ts"));
  mkdirSync(join(work, "bin"));
  cpSync(join(repo, "bin/tap"), join(work, "bin/tap"));
  const bus = join(work, "bus");
  for (const name of ["spool", "receipts", "payloads", "delivery"]) mkdirSync(join(bus, name), { recursive: true });
  writeFileSync(join(bus, ".tap-bus-authority"), "");
  writeFileSync(join(bus, "registry.json"), JSON.stringify({
    schema: "0.20", team: { name: "testteam" },
    seats: {
      codex: { pane: "sender-pane", pane_id: "%1002", session: "sess", server_epoch: "srv:900:100", boot_id: "boot:1", harness: "codex", status: "active" },
      peer: { pane: "fake-pane", pane_id: "%1001", session: "sess", server_epoch: "srv:900:100", boot_id: "boot:1", harness: "codex", status: "active" },
    },
  }));
  const state = join(work, "fake-tmux");
  mkdirSync(state);
  writeFileSync(join(work, "bin", "tmux"), `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_TMUX_STATE:?}"
mkdir -p "$state"
# The native observer passes socket flags the retired stub never saw.
while [ "\${1:-}" = "-L" ] || [ "\${1:-}" = "-S" ]; do shift 2; done
echo "$*" >> "$state/all-calls.log"
cmd="\${1:-}"; shift || true
case "$cmd" in
  list-sessions) printf 'sess\\t900:100\\t1\\n' ;;
  list-panes) printf 'sess\\tfake-pane\\t%%1001\\tcodex\\t2147483646\\t900:100\\t0\\n' ;;
  display-message)
    target=""; fmt=""
    while [ "$#" -gt 0 ]; do
      case "$1" in -p) shift ;; -t) target="\${2:-}"; shift 2 ;; *) fmt="$1"; shift ;; esac
    done
    case "$fmt" in
      *pane_id*session_name*pane_current_command*)
                              printf '%%1001\\tsess\\t%s\\t%s\\t0\\n' "\${FAKE_PANE_PID:-2147483646}" "\${FAKE_TMUX_CMD:-codex}" ;;
      *pane_id*session_name*) printf '%%1001\\tsess\\t900:100\\n' ;;
      *start_time*)           echo "900:100" ;;
      *pane_id*)              echo "%1001" ;;
      *pane_pid*)             echo "\${FAKE_PANE_PID:-2147483646}" ;;
      *pane_in_mode*)         echo "$fmt" >> "$state/mode-probes"; [ -f "$state/copy_mode" ] && echo "1" || echo "0" ;;
      *pane_current_command*) echo "\${FAKE_TMUX_CMD:-codex}" ;;
      *)                      echo "" ;;
    esac ;;
  capture-pane)
    [ "\${FAKE_NO_PROMPT:-0}" = "1" ] && { printf 'model is still working\\n'; exit 0; }
    if [ -f "$state/input" ]; then printf '\\u203a %s\\n' "$(cat "$state/input")"; else printf '\\u203a \\n'; fi ;;
  load-buffer) cp "\${!#}" "$state/buffer" ;;
  paste-buffer) cp "$state/buffer" "$state/input" ;;
  send-keys)
    # The disposition assertion greps this file; without the log it passes unconditionally.
    echo "$*" >> "$state/send-keys.log"
    if [ "\${1:-}" = "-t" ]; then shift 2; fi
      if [ "\${1:-}" = "-X" ] && [ "\${2:-}" = "cancel" ]; then
        [ -f "$state/copy_mode" ] && exit 1
        exit 0
      fi
    if [ "\${1:-}" = "C-u" ]; then
      : > "$state/input"
      exit 0
    fi
    if [ "\${1:-}" = "-l" ]; then
      shift; [ "\${1:-}" = "--" ] && shift
      printf '%s' "\${1:-}" > "$state/input"
      exit 0
    fi
    if [ "\${1:-}" = "Enter" ]; then
      if [ "\${FAKE_TMUX_STUCK_SUBMIT:-0}" = "1" ]; then
        exit 0
      fi
      if [ -n "\${FAKE_TMUX_STUCK_ID:-}" ] && grep -qF "id=\${FAKE_TMUX_STUCK_ID}" "$state/input" 2>/dev/null; then
        exit 0
      fi
      rm -f "$state/input"
      exit 0
    fi ;;
esac
`, { mode: 0o755 });
  return { work, bus, state, scripts };
}

function waiterEnv(work: string, bus: string, delays: string): NodeJS.ProcessEnv {
  return {
    ...process.env, TAP_HOME: bus, PATH: `${join(work, "bin")}:${process.env.PATH}`,
    TAP_SPOOL_DELIVERER_DELAYS: delays, TAP_SPOOL_DISABLE_DELIVERER: "1", TAP_TUI_SETTLE_SCALE: "0.1",
    TAP_SERVER_EPOCH: "srv:900:100", TAP_BOOT_ID: "boot:1",
    FAKE_TMUX_STATE: join(work, "fake-tmux"), TMUX: "/fake/socket",
    TAP_SPOOL_REOWN_TOKEN: undefined as unknown as string,
  };
}

// exec keeps the spawned PID as the waiter's own, so the join measures the
// process's own exit rather than a poll that might miss it.
function startWaiter(work: string, bus: string, id: string, delays: string) {
  const log = join(work, "deliverer.log");
  return Bun.spawn(["/bin/sh", "-c", `exec '${process.execPath}' '${join(work, "runtime/bun/src/spool-waiter.ts")}' '${id}' >> '${log}' 2>&1`],
    { env: waiterEnv(work, bus, delays), stdin: "ignore" });
}

function mintPark(bus: string, id: string, meta: Record<string, unknown>, body = "grace body", now = Math.floor(Date.now() / 1000), reply = "expected"): number {
  const full = { id, target: "peer", to_team: "testteam", target_registry: join(bus, "registry.json"),
    pane: "fake-pane", pane_id: "%1001", reason: "pending-input", reason_class: "busy", policy: "standard",
    first_spooled_epoch: now, hold_until_epoch: 0, deadline_epoch: now, attempts: 0, ...meta };
  writeFileSync(join(bus, "spool", `${id}.md`), `---\nid: ${id}\nfrom: codex\nto: peer\nkind: discuss\nreply: ${reply}\npath: ${join(bus, "payloads", `${id}.md`)}\n---\n${body}\n`);
  writeFileSync(join(bus, "spool", `${id}.meta.json`), `${JSON.stringify(full, null, 2)}\n`);
  // MIRROR PRODUCTION: the canonical is deleted the moment the entry is parked, so
  // a parked entry has NO canonical until delivery puts one back.
  rmSync(join(bus, "payloads", `${id}.md`), { force: true });
  return now;
}

const metaOf = (bus: string, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(bus, "spool", `${id}.meta.json`), "utf8"));
const deliveryFailedNotices = (bus: string): string[] =>
  readdirSync(join(bus, "payloads")).filter(name => name.endsWith(".md")
    && readFileSync(join(bus, "payloads", name), "utf8").includes("kind: delivery-failed"));

test("a grace park's waiter is bounded by its deadline, not by its retry cadence, and force-delivers at it without telling the sender", async () => {
  const s = sandbox();
  const GRACE = 6, MAX_LATE = 30;
  const draft = "half typed human sentence";
  writeFileSync(join(s.state, "input"), draft);
  const first = Math.floor(Date.now() / 1000);
  mintPark(s.bus, "wl1", { deadline_epoch: first + GRACE, waiter_lifetime: "grace-window" }, "grace body", first);
  // ASSERT THE PRECONDITION YOU CONFIGURED, before measuring anything downstream
  // of it: both earlier versions of the retired arm believed they had a 6s grace,
  // silently got the 60s default, and went green having tested nothing.
  const meta = metaOf(s.bus, "wl1");
  const deadline = first + GRACE;
  expect(meta.deadline_epoch).toBe(deadline);
  expect(meta.reason).toBe("pending-input");
  expect(existsSync(join(s.bus, "payloads", "wl1.md")), "canonical still present after park").toBe(false);

  // The cadence is deliberately shorter than the grace window: the whole question
  // is whether the waiter is bounded by the CADENCE (the tap-w4f7 bug) or by its
  // DEADLINE. Three 0.2s delays exhaust in ~0.6s.
  // Note on the lifetime guard: with a draft in the band the waiter's deadline is
  // carried by the input-protection window (spool-waiter-loop reads the protection
  // deadline first), so this arm's red mutant is the drain's deadline force gate
  // (spool-drain deadlinePassed), not the waiterDeadline owned list — the owned
  // list is the window-owner arm's guard, where no draft exists to protect.
  const waiter = startWaiter(s.work, s.bus, "wl1", "0.2 0.2 0.2");
  const hung = await Promise.race([waiter.exited.then(() => false), Bun.sleep((GRACE + MAX_LATE + 10) * 1000).then(() => true)]);
  const finishedAt = Math.floor(Date.now() / 1000);
  const psTree = hung || waiter.exitCode !== 0
    ? spawnSync("bash", ["-c", `ps -eo pid,ppid,stat,etime,command | grep -E 'spool-waiter|spool-engine|${s.work}' | grep -v grep; echo '--- log:'; cat '${join(s.work, "deliverer.log")}' 2>/dev/null; echo '--- spool:'; ls '${join(s.bus, "spool")}'`], { encoding: "utf8" }).stdout : "";
  expect(hung, psTree || readFileSync(join(s.work, "deliverer.log"), "utf8")).toBe(false);
  try {
    // THREE conditions, and the exit STATUS is one of them. A nonzero exit is the
    // watchdog having killed an unbounded waiter; an exit before the deadline is
    // the waiter bounded by its retry cadence (the tap-w4f7 starvation); an exit
    // far past the deadline is no longer bounded by the clock it enforces.
    expect(waiter.exitCode, "the waiter did not exit cleanly").toBe(0);
    expect(finishedAt - deadline, "the waiter outlived its deadline bound").toBeLessThanOrEqual(MAX_LATE);
    expect(finishedAt, `the waiter died before its deadline (${finishedAt} < ${deadline}) — it was bounded by its retry cadence instead of the clock it exists to enforce`).toBeGreaterThanOrEqual(deadline);

    // DISPOSITION: grace does NOT inherit give-up-and-terminalize. The lifetime
    // fix must not hand this class the sender-wake + terminalize pair: a grace
    // deadline means force-deliver. The negative half alone proves nothing
    // ("no delivery-failed" is also satisfied by a deadline that did nothing),
    // so the positive half is asserted with equal strength.
    expect(deliveryFailedNotices(s.bus), "a grace park emitted delivery-failed at its deadline — lifetime was coupled to disposition").toEqual([]);
    expect(existsSync(join(s.bus, "spool", "wl1.md")) || existsSync(join(s.bus, "spool", "wl1.meta.json")),
      "the grace deadline passed and the entry is STILL PARKED — force-deliver did not happen, so the absence of delivery-failed proves nothing").toBe(false);
    expect(readFileSync(join(s.bus, "payloads", "wl1.md"), "utf8")).toContain("grace body");
    // Canonical movement alone also occurs for submit-unverified; .sent does not.
    expect(existsSync(join(s.bus, "receipts", "wl1.sent")), "force delivery was not verified").toBe(true);
    expect(readFileSync(join(s.state, "input"), "utf8"), "force delivery did not restore the original draft").toBe(draft);
  } finally {
    if (waiter.exitCode === null) { waiter.kill(); await waiter.exited; }
  }
}, 75_000);

// From delivery-window-drain.test.sh arm 0c: a window park whose pane is briefly
// unavailable (copy mode) must keep its owned deliverer PAST its deadline — the
// deadline must not make the live entry undrainable — and the same owner delivers
// once the pane recovers, leaving no lease, no cancellation and no failure notice.
test("the leased window owner survives its deadline and delivers after pane recovery", async () => {
  const s = sandbox();
  writeFileSync(join(s.state, "copy_mode"), "");
  const now = Math.floor(Date.now() / 1000);
  mintPark(s.bus, "window-owner", {
    reason: "window", reason_class: "window", waiter_lifetime: "window",
    first_spooled_epoch: now - 700, hold_until_epoch: now - 2, deadline_epoch: now - 1,
  }, "window body");
  expect(existsSync(join(s.bus, "spool", "window-owner.meta.json")), "the fixture did not park").toBe(true);

  const waiter = startWaiter(s.work, s.bus, "window-owner", "0.1");
  try {
    let probes = 0;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      probes = existsSync(join(s.state, "mode-probes"))
        ? readFileSync(join(s.state, "mode-probes"), "utf8").split("\n").filter(Boolean).length : 0;
      if (probes >= 6) break;
      if (waiter.exitCode !== null) break;
      await Bun.sleep(100);
    }
    const diag = () => `${readFileSync(join(s.work, "deliverer.log"), "utf8")}\n--- tmux calls:\n${readFileSync(join(s.state, "all-calls.log"), "utf8").split("\n").slice(-40).join("\n")}\n--- state:\n${readdirSync(s.state).join(" ")}`;
    expect(probes, `owner never observed the unavailable pane after deadline (waiter exit ${waiter.exitCode})\n${diag()}`).toBeGreaterThanOrEqual(6);
    expect(waiter.exitCode, readFileSync(join(s.work, "deliverer.log"), "utf8")).toBeNull();
    expect(metaOf(s.bus, "window-owner").escalated_at, "window deadline made the live entry undrainable").toBeFalsy();
    expect(existsSync(join(s.bus, "spool", "window-owner.meta.json.reown")), "surviving owner has no lease").toBe(true);
    expect(existsSync(join(s.bus, "receipts", "window-owner.cancelled")), "a live window park was cancelled").toBe(false);

    // Only the real owner may drain after recovery; no manual drain can mask its exit.
    rmSync(join(s.state, "copy_mode"), { force: true });
    let sent = false;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      sent = existsSync(join(s.bus, "receipts", "window-owner.sent"));
      if (sent || waiter.exitCode !== null) break;
      await Bun.sleep(100);
    }
    expect(sent, readFileSync(join(s.work, "deliverer.log"), "utf8")).toBe(true);
    expect(await Promise.race([waiter.exited.then(() => "exited"), Bun.sleep(15_000).then(() => "hung")]), "owner did not exit after delivering").toBe("exited");
    expect(waiter.exitCode, "owner exited unsuccessfully").toBe(0);
    expect(existsSync(join(s.bus, "spool", "window-owner.meta.json")), "delivered entry remains spooled").toBe(false);
    expect(existsSync(join(s.bus, "spool", "window-owner.meta.json.reown")), "owner left a lease behind").toBe(false);
    expect(deliveryFailedNotices(s.bus), "a window delay manufactured a delivery-failed notice").toEqual([]);
  } finally {
    if (waiter.exitCode === null) { waiter.kill(); await waiter.exited; }
  }
}, 60_000);

// The park SHAPE comes from the production writer's own meta function, not from
// hand-picked fields: whatever spool-publication.ts mints for a policy/class is
// exactly what these arms inherited from the retired fixtures, which parked via
// the production pair writer. A drift in the writer shows up here as a shape
// precondition failure instead of a silently re-scoped arm.
function mintedMeta(bus: string, work: string, id: string, at: Date, over: Record<string, string>): Record<string, unknown> {
  const canonical = join(work, `canon-${id}.md`);
  writeFileSync(canonical, `---\nid: ${id}\nfrom: codex\nto: peer\nkind: discuss\nreply: expected\n---\nbody\n`);
  return mintMeta({
    spoolDir: join(bus, "spool"), id, canonical, target: "peer", team: "testteam", reason: "auto-settle",
    reasonClass: "", timeoutSeconds: "", pane: "fake-pane", paneId: "%1001", toTeam: "testteam",
    policy: "autosettle", graceSeconds: "", targetRegistry: join(bus, "registry.json"), windowSeconds: "",
    lastDelivered: "", cueStyle: "", cueRedAt: "", env: { ...process.env }, now: at, lockTimeoutMs: 1000,
    ...over,
  } as Parameters<typeof mintMeta>[0], {}, false, at);
}

// From courier-auto-settle.test.sh arm 16: the autosettle HOLD clock is what
// schedules delivery for a plain settle-only note. The park carries the OWNED
// lifetime the production writer mints (autosettle-hold, whose give-up deadline
// sits a busy-tail past the hold), and the cadence is deliberately SHORTER than
// the hold: it exhausts in ~0.6s, so only the owned lifetime can carry the
// deliverer to the hold's expiry. There it rings ONE doorbell for both eligible
// rows — the doorbell settles nothing (no .done) — and leaves no claim behind.
test("an autosettle hold's owned deliverer rings one doorbell for both rows at the hold's expiry", async () => {
  const HOLD = 3;
  const s = sandbox();
  const at = new Date();
  const now = Math.floor(at.getTime() / 1000);
  for (const id of ["q3", "q4"]) {
    // lastDelivered = the writer's own clock instant: the hold then resolves to
    // lastDelivered + window with no dependence on a second boundary crossing.
    const meta = mintedMeta(s.bus, s.work, id, at, { windowSeconds: String(HOLD), lastDelivered: String(now) });
    // ASSERT THE SHAPE YOU INHERITED before measuring anything downstream of it:
    // an unowned lifetime would make this arm a cadence test that measures nothing.
    expect(meta.waiter_lifetime, "setup: the autosettle park must carry its OWNED lifetime").toBe("autosettle-hold");
    expect(meta.deadline_source, "setup: the owned lifetime carries its own deadline source").toBe("autosettle-hold");
    expect(meta.hold_until_epoch, "setup: the hold must sit HOLD seconds past the park").toBe(Number(meta.first_spooled_epoch) + HOLD);
    expect(Number(meta.deadline_epoch), "setup: the owned lifetime owes a tail deadline past the hold").toBeGreaterThan(Number(meta.hold_until_epoch));
    mintPark(s.bus, id, meta, `hold body ${id}`, now, "settle-only");
  }
  // THE BARRIER. Both rows complete BEFORE the actor exists — the deliverer must
  // not observe a half-built fixture whatever the machine's load.
  for (const id of ["q3", "q4"]) expect(existsSync(join(s.bus, "spool", `${id}.meta.json`)), `setup: ${id} is not fully parked`).toBe(true);
  const waiter = startWaiter(s.work, s.bus, "q3", "0.2 0.2 0.2");
  try {
    const hung = await Promise.race([waiter.exited.then(() => false), Bun.sleep(40_000).then(() => true)]);
    const diag = () => {
      const read = (p: string) => existsSync(p) ? readFileSync(p, "utf8") : "(absent)";
      return `exit=${waiter.exitCode} hung=${hung}\n--- deliverer.log:\n${read(join(s.work, "deliverer.log"))}\n--- send-keys:\n${read(join(s.state, "send-keys.log"))}\n--- spool:\n${readdirSync(join(s.bus, "spool")).join(" ")}\n--- meta q3:\n${read(join(s.bus, "spool", "q3.meta.json"))}`;
    };
    expect(hung, diag()).toBe(false);
    expect(waiter.exitCode, "the deliverer did not exit cleanly: it was killed by the watchdog or died mid-drain").toBe(0);
    const notes = existsSync(join(s.state, "send-keys.log"))
      ? readFileSync(join(s.state, "send-keys.log"), "utf8").split("\n").filter(line => /\[\[TAP v\d+\.\d+ note courier-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}( |$)/.test(line)) : [];
    expect(notes, `the hold clock did not deliver: expected exactly one doorbell, got ${notes.length}`).toHaveLength(1);
    for (const id of ["q3", "q4"]) {
      expect(existsSync(join(s.bus, "receipts", `${id}.done`)), `${id} was marked done by the doorbell the clock rang`).toBe(false);
      expect(existsSync(join(s.bus, "spool", `${id}.md`)) || existsSync(join(s.bus, "spool", `${id}.meta.json`)),
        `delivered body ${id} left in the spool`).toBe(false);
      expect(existsSync(join(s.bus, "payloads", `${id}.md`)), `${id} left the spool but no canonical payload exists`).toBe(true);
    }
    const claims = readdirSync(join(s.bus, "spool")).filter(name => name.endsWith(".claim"));
    expect(claims, "the delivered transaction left a claim behind").toEqual([]);
    expect(deliveryFailedNotices(s.bus), "the hold clock manufactured a delivery-failed notice").toEqual([]);
  } finally {
    if (waiter.exitCode === null) { waiter.kill(); await waiter.exited; }
  }
}, 70_000);

// From sender-drain-isolation.test.sh's detached arm: no sender verb, no register,
// no drain call — the production detached deliverer ALONE advances a ready entry
// (plain busy park minted in the production readiness-gate shape, empty band, so
// no input-protection path exists to help it).
test("the detached deliverer alone advances a ready entry to verified delivery", async () => {
  const s = sandbox();
  const now = Math.floor(Date.now() / 1000);
  const meta = mintedMeta(s.bus, s.work, "peer-detached", new Date(), { reason: "no-input-prompt", policy: "standard" });
  // ASSERT THE SHAPE: the retired arm's park went through the same busy branch,
  // so the deliverer here owns its lifetime through readiness-gate, not by luck.
  expect(meta.waiter_lifetime, "setup: a busy park must carry the readiness-gate lifetime").toBe("readiness-gate");
  expect(meta.deadline_source, "setup: the readiness-gate deadline is its own source").toBe("readiness-gate");
  expect(meta.hold_until_epoch, "setup: with no window and no delivery reading, the entry is due at its park epoch").toBe(meta.first_spooled_epoch);
  mintPark(s.bus, "peer-detached", meta, "body peer-detached", now);
  expect(existsSync(join(s.state, "input")), "the fixture must present an empty band: this arm proves delivery without any draft").toBe(false);
  const waiter = startWaiter(s.work, s.bus, "peer-detached", "0.1");
  try {
    let sent = false;
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      sent = existsSync(join(s.bus, "receipts", "peer-detached.sent"));
      if (sent || waiter.exitCode !== null) break;
      await Bun.sleep(100);
    }
    const diag = () => `${readFileSync(join(s.work, "deliverer.log"), "utf8")}\n--- send-keys:\n${readFileSync(join(s.state, "send-keys.log"), "utf8")}\n--- spool:\n${readdirSync(join(s.bus, "spool")).join(" ")}`;
    expect(sent, `detached delivery did not advance the entry\n${diag()}`).toBe(true);
    expect(await Promise.race([waiter.exited.then(() => "exited"), Bun.sleep(15_000).then(() => "hung")]), "detached deliverer did not exit after delivering").toBe("exited");
    expect(waiter.exitCode, "detached deliverer failed").toBe(0);
    expect(existsSync(join(s.bus, "spool", "peer-detached.md")) || existsSync(join(s.bus, "spool", "peer-detached.meta.json")),
      "delivered entry remains spooled").toBe(false);
    expect(readFileSync(join(s.bus, "payloads", "peer-detached.md"), "utf8")).toContain("body peer-detached");
  } finally {
    if (waiter.exitCode === null) { waiter.kill(); await waiter.exited; }
  }
}, 45_000);
