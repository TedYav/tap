import { expect, test } from "bun:test";
import { Notices } from "../src/launcher/catalog-notices";

function sink() { const out: string[] = []; return { out, notices: new Notices(m => out.push(m)) }; }

// The four controls a per-call notice API passes while being wrong, named by the
// partner who specified them before the implementation existed.
test("one command, same text twice, emits once", () => {
  const { out, notices } = sink();
  notices.emit("identical"); notices.emit("identical");
  expect(out).toEqual(["identical"]);
});

test("one command, two different texts, both emit", () => {
  const { out, notices } = sink();
  notices.emit("first"); notices.emit("second");
  expect(out).toEqual(["first", "second"]);
});

// The other direction, which process-lifetime dedup fails: a long-lived host
// running two commands must print the same sentence for EACH of them.
test("two commands, same text, emits once per command", () => {
  const { out, notices } = sink();
  notices.emit("identical");
  notices.reset();
  notices.emit("identical");
  expect(out).toEqual(["identical", "identical"]);
});

test("suppression silences prose and survives the command reset", () => {
  const { out, notices } = sink();
  notices.suppress(true);
  notices.emit("quiet");
  notices.reset();
  notices.emit("still quiet");
  expect(out).toEqual([]);
});

test("a quiet read is silent and restores the previous setting on success", () => {
  const { out, notices } = sink();
  notices.quietly(() => notices.emit("during"));
  notices.emit("after");
  expect(out).toEqual(["after"]);
});

test("a quiet read restores on FAILURE too", () => {
  const { out, notices } = sink();
  expect(() => notices.quietly(() => { throw new Error("read failed"); })).toThrow("read failed");
  notices.emit("after");
  expect(out).toEqual(["after"]);
  expect(notices.isSuppressed).toBe(false);
});

// An ALREADY-suppressed command must stay suppressed after a quiet read -- the
// restore puts back what was there, it does not unmute.
test("a quiet read inside a suppressed command leaves it suppressed", () => {
  const { out, notices } = sink();
  notices.suppress(true);
  notices.quietly(() => notices.emit("during"));
  notices.emit("after");
  expect(out).toEqual([]);
  expect(notices.isSuppressed).toBe(true);
});
