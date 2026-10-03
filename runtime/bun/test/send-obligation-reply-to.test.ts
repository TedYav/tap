// tap_serial_triggers "runtime/bun/src/verbs/send.ts" "runtime/bun/src/slices/message-construction.ts" "skills/tap/scripts/tap-send.sh" "runtime/bun/test/support/send-delivery-fixture.ts"
import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envelopeField } from "../src/envelope";
import { fixture, releaseScratch, run, routeOf } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

const rows = [
  { name: "explicit reply-to preserves ask", flags: ["--reply-to", "rb"], expected: true },
  { name: "explicit reply-to licenses assign", flags: ["--reply-to", "rb"], expected: true, assign: true },
  { name: "no deliverable reply-to warns once", flags: [], expected: false },
  { name: "stored pane-less reply-to cannot grant an obligation", flags: [], stored: "proxy", expected: false },
  { name: "qualified stored reply-to cannot borrow a local namesake", flags: [], stored: "absent/rb", expected: false },
  { name: "no-auto-reply-to suppresses the obligation grant", flags: ["--no-auto-reply-to"], stored: "rb", expected: false },
  { name: "self reply-to cannot grant an obligation", flags: [], stored: "ua", expected: false },
];

for (const row of rows) test("effective reply-to: " + row.name, () => {
  const fx = fixture();
  const registry = JSON.parse(readFileSync(fx.registry, "utf8"));
  registry.seats.ua.unattended = true;
  if (row.stored) registry.seats.ua.reply_to = row.stored;
  registry.seats.proxy = { status: "active", harness: "claude", instance: "proxy|A" };
  writeFileSync(fx.registry, JSON.stringify(registry));
  const verb = row.assign ? "assign" : "send";
  const v = run(fx, [verb, "rb", "-m", "reply routing control", "--id", "obligation",
    ...(row.assign ? [] : ["--ask"]), ...row.flags]);
  expect({ code: v.code, route: v.route }).toEqual({ code: 0, route: routeOf(verb) });
  const message = readFileSync(join(fx.bus, "payloads", "obligation.md"), "utf8");
  expect(envelopeField(message, "reply")).toBe(row.expected ? "expected" : "settle-only");
  expect(envelopeField(message, "reply_to")).toBe(row.expected ? "alpha/rb" : undefined);
  expect((v.stderr.match(/--ask downgraded/g) ?? []).length).toBe(row.expected ? 0 : 1);
}, 120_000);
