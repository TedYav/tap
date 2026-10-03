import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { goalieDeliveryHealth, type DeliveryObservation } from "../src/goalie-delivery";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "goalie-delivery-")); roots.push(home);
  for (const dir of ["spool", "payloads", "receipts"]) fs.mkdirSync(`${home}/${dir}`);
  const input: DeliveryObservation = {
    home, team: "tap", observer: "goalie", seat: { status: "active", pane: "%1", instance: "current" },
    now: 10000, staleSeconds: 100, judgeSeats: {}, authoredAge: "UNAGED:structural",
    state: () => ({ status: 0, stdout: "idle-at-prompt" }),
  };
  const payload = (name: string, fields: string, epoch = 9800, dir = "payloads") => {
    const file = `${home}/${dir}/${name}.md`;
    fs.writeFileSync(file, `---\nid: ${name}\n${fields}\n---\nbody\n`);
    fs.utimesSync(file, epoch, epoch);
  };
  const ask = () => payload("ask", "from: lead\nto: goalie\nreply: expected\nrecipient_instance: current");
  return { home, input, payload, ask, run: () => goalieDeliveryHealth(input) };
}
test("idle with no owed work is healthy even without a readable session store", () => {
  const w = world(); expect(w.run()).toEqual({ status: "healthy" });
});
test("working or idle with an overdue ask needs self-authored progress", () => {
  const w = world(); w.ask();
  for (const state of ["idle-at-prompt", "working"]) {
    w.input.state = () => ({ status: 0, stdout: state });
    expect(w.run()).toEqual({ status: "degraded", reason: "wake=ask overdue without self-authored progress or a reply" });
  }
  w.input.authoredAge = "10"; expect(w.run()).toEqual({ status: "healthy" });
  w.input.authoredAge = "100"; expect(w.run().status).toBe("degraded");
});
test("incoming activity and a supervisor-authored wake are not reply progress", () => {
  const w = world(); w.ask();
  w.payload("incoming", "from: lead\nto: goalie\nreply: settle-only", 9990);
  w.payload("supervisor", "from: goalie\nto: feeder\nreply: expected", 9990);
  expect(w.run().status).toBe("degraded");
  w.payload("reply", "from: goalie\nto: lead\nin_reply_to: ask\nsender_instance: current", 9990, "spool");
  expect(w.run()).toEqual({ status: "healthy" });
});
test("settled ask, fresh ask and another incarnation's ask do not create overdue duty", () => {
  const w = world(); w.ask();
  fs.writeFileSync(`${w.home}/receipts/ask.done`, '{"status":"done","via":"reply"}');
  w.payload("fresh", "from: lead\nto: goalie\nreply: expected", 9990);
  w.payload("retired", "from: lead\nto: goalie\nreply: expected\nrecipient_instance: retired");
  expect(w.run()).toEqual({ status: "healthy" });
});
test("foreign replies and old-incarnation replies do not supply progress", () => {
  const w = world(); w.ask();
  w.payload("foreign", "from: goalie\nfrom_team: elsewhere\nin_reply_to: x", 9990);
  w.payload("retired", "from: goalie\nsender_instance: retired\nin_reply_to: x", 9990);
  w.payload("unbound", "from: goalie\nin_reply_to: x", 9990);
  expect(w.run().status).toBe("degraded");
  w.input.seat = { status: "active", pane: "%1" };
  expect(w.run().status).toBe("degraded");
});
test("pending judge verdict is observed before target state can erase it", () => {
  const w = world();
  w.input.judgeSeats = { target: { request_status: "queued", episode_started_at: 9800, verdict_at: 0 } };
  expect(w.run()).toEqual({ status: "degraded", reason: "judge=target overdue without self-authored progress or a reply" });
  w.input.judgeSeats = { target: { request_status: "queued", episode_started_at: 9800, verdict_at: 9900 } };
  expect(w.run()).toEqual({ status: "healthy" });
});
test("missing observation, failed state and unreadable inbox never read healthy", () => {
  const w = world();
  w.input.state = () => ({ status: 1, stdout: "working" }); expect(w.run().status).toBe("degraded");
  w.input.state = () => ({ status: 0, stdout: "unknown" }); expect(w.run().status).toBe("degraded");
  w.input.state = () => ({ status: 0, stdout: "idle-at-prompt" });
  fs.rmdirSync(`${w.home}/spool`); fs.writeFileSync(`${w.home}/spool`, "not a directory");
  expect(w.run().status).toBe("degraded");
});
test("canonical cancellation settles duty; malformed judge state is an observer failure", () => {
  const w = world(); w.ask();
  fs.writeFileSync(`${w.home}/receipts/ask.cancelled`, ""); expect(w.run().status).toBe("healthy");
  w.input.judgeSeats = { target: null }; expect(w.run().status).toBe("degraded");
});

test("inactive and missing delivery seats fail before any state read", () => {
  const w = world();
  let reads = 0;
  w.input.state = () => { reads++; return { status: 0, stdout: "working" }; };
  for (const seat of [undefined, { pane: "%1", status: "suspended" }, { pane: "%1", delivery: "poll" }, { pane: "%1", status_reason: "launching" }]) {
    w.input.seat = seat;
    expect(w.run().status).toBe("degraded");
  }
  expect(reads).toBe(0);
});

for (const mode of ["unrelated", "settled", "overdue", "reply"]) {
  test(`opaque binary body: ${mode} routing is decided from its header`, () => {
    const w = world();
    if (mode === "reply") w.ask();
    const fields = mode === "reply"
      ? "from: goalie\nsender_instance: current\nto: lead\nin_reply_to: ask"
      : `from: lead\nto: ${mode === "unrelated" ? "other" : "goalie"}\nreply: expected`;
    const epoch = mode === "reply" ? 9990 : 9800;
    w.payload("binary", fields, epoch);
    const file = `${w.home}/payloads/binary.md`;
    fs.appendFileSync(file, Buffer.from([0xff, 0x00]));
    fs.utimesSync(file, epoch, epoch);
    if (mode === "settled") fs.writeFileSync(`${w.home}/receipts/binary.done`, "");
    if (mode === "overdue") expect(w.run()).toEqual({ status: "degraded", reason: "wake=binary overdue without self-authored progress or a reply" });
    else expect(w.run()).toEqual({ status: "healthy" });
  });
}
test("invalid routing-header bytes remain an unreadable observation", () => {
  const w = world();
  fs.writeFileSync(`${w.home}/payloads/bad.md`, Buffer.concat([Buffer.from("---\nto: "), Buffer.from([0xff]), Buffer.from("\n---\nbody")]));
  expect(w.run()).toEqual({ status: "degraded", reason: "delivery obligations or reply evidence unreadable" });
});
