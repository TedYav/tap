// Observe real I/O before importing Bus/courier; a fresh child avoids test-file import order.
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";

const root = process.argv[2]!;
const index = join(root, "archive/2026-10/index.ndjson");
const read = fs.readFileSync, open = fs.openSync, stat = fs.statSync, lstat = fs.lstatSync;
let indexTouches = 0;
const count = (path: unknown) => { const p = String(path); if (p === index || p.startsWith(join(root, "archive"))) indexTouches++; };
spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => { count(args[0]); return read(...args); }) as typeof fs.readFileSync);
spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => { count(args[0]); return open(...args); }) as typeof fs.openSync);
spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => { count(args[0]); return stat(...args); }) as typeof fs.statSync);
spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => { count(args[0]); return lstat(...args); }) as typeof fs.lstatSync);
const { Bus } = await import("../../src/bus");
const { canonicalPlace } = await import("../../src/courier");
const bus = new Bus(root);
const settled = ["archived-0", "archived-4095", "active-done", "pending"].map(id => bus.isDone(id));
const path = join(root, "payloads/new-id.md");
canonicalPlace(bus, "---\n---\nnew bytes\n", { id: "new-id", from: "sender", to: "reader", kind: "discuss", path });
const hotTouches = indexTouches;
// Control: the counter must see a history reader's index read.
const { monthIndexRows } = await import("../../src/bus-archive-index");
const historyRows = monthIndexRows(root, "2026-10").size;
console.log(JSON.stringify({ settled, placed: fs.existsSync(path), indexTouches: hotTouches, historyRows, controlSawIndex: indexTouches > hotTouches }));
