import { readFileSync } from "node:fs";
import { actingRegistryPath } from "../../src/launcher/records";
// Candidate native callers for comparison with the pinned pre-cut Python tree.
// Public resume/restart doors own their selection; creation takes the transaction
// request new.ts makes for its record. Attach stays outside this comparison.
import { cmdSessionDoor } from "../../src/launcher/session-doors";
import { Notices } from "../../src/launcher/catalog-notices";
import { launchTransaction, seatUpTransaction, type LaunchRecord } from "../../src/launcher/transaction";

const record = JSON.parse(process.argv[2]!) as LaunchRecord;
const kind = process.argv[3] ?? "new";
if (kind === "seat-up") {
  const path = actingRegistryPath(record.cwd)!;
  const row = JSON.parse(readFileSync(path, "utf8")).seats[record.tag!];
  const result = await seatUpTransaction([record.cwd, record.base, record.tag!, JSON.stringify(row), path]);
  console.log(JSON.stringify({ ok: true, handle: record.tag, session: result.record.name, outcome: "resumed" }));
  process.exit(result.code);
}
if (["resume", "adopted", "resume-all", "restart"].includes(kind)) {
  const args = kind === "restart" ? [record.tag!, "--force", "--json"]
    : kind === "resume-all" ? ["--all", "--json"] : [kind === "adopted" ? record.harness : record.tag!, "--json"];
  process.exit(await cmdSessionDoor(kind === "restart" ? "restart" : "resume", args));
}
const notices = new Notices();
notices.suppress(true);
const result = await launchTransaction({ kind: "new", record, dry_run: false, json: true, terminal: { stderr_tty: false } },
  process.env, new AbortController().signal, notices);
process.exitCode = result.code;
