// Count manifest (index.ndjson) opens by month while looking up and archiving.
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";

const [bus, leftover, now] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4])];
const reads: string[] = [];
const open = fs.openSync, read = fs.readFileSync;
const count = (path: unknown) => { const p = String(path); if (basename(p) === "index.ndjson") reads.push(basename(dirname(p))); };
spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => { count(args[0]); return open(...args); }) as typeof fs.openSync);
spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => { count(args[0]); return read(...args); }) as typeof fs.readFileSync);
const { archivedMonth, archivedPayload, archivedHistoryPayload } = await import("../../src/bus-archive-index");
const { archiveBus } = await import("../../src/bus-archive");
const found = archivedMonth(bus, leftover);
archivedPayload(bus, leftover); archivedHistoryPayload(bus, leftover); archivedMonth(bus, "never-archived");
const lookupManifestReads = reads.splice(0);
const result = archiveBus(bus, 7, false, now);
console.log(JSON.stringify({ lookupManifestReads, found, archived: result.archived, runManifestReads: [...new Set(reads)],
  leftoverGone: !fs.existsSync(join(bus, "receipts", `${leftover}.placed`)) }));
