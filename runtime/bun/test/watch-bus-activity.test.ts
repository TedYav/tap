// the bus-activity clock's Bash reader (deleted in the R6 goalie cutover; the
// frozen python below is its pre-cutover body, verbatim) RUN against the port over
// the same scratch bus: canonical payloads and `.done` receipts with set mtimes, a
// frontmatter corpus (supervision kinds, addressed/foreign/legacy `to_team`, unreadable,
// fenceless, draft, dotfile), the future clamp, the floor, with and without a seat.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { busActivity } from "../src/watch-detectors";
import { removeScratchTree } from "./support/scratch";

const SCRIPTS = join(import.meta.dir, "../../../skills/tap/scripts/smoke");

const PY = `
import glob, os, sys
payloads, receipts, now, floor, scripts, seat, local_team = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6], sys.argv[7]
sys.path.insert(0, scripts)
from tap_frontmatter import addressed_to_local, frontmatter, list_payload_paths

meta_cache = {}
def relevant(ident):
    if ident not in meta_cache:
        meta_cache[ident] = frontmatter(os.path.join(payloads, ident + ".md"))
    meta = meta_cache[ident]
    if meta.get("kind") in {"probe", "notice", "progress"}:
        return False
    if not seat:
        return True
    if meta.get("from") == seat:
        return True
    return addressed_to_local(meta, seat, local_team)

best = floor
for ident, path in list_payload_paths(payloads) or ():
    mtime = min(int(os.path.getmtime(path)), now)
    if mtime > best and relevant(ident):
        best = mtime
for path in glob.glob(os.path.join(receipts, "*.done")):
    mtime = min(int(os.path.getmtime(path)), now)
    if mtime > best and relevant(os.path.basename(path)[:-5]):
        best = mtime
print(best if best else "")
`;

function python(payloads: string, receipts: string, now: string, floor: string, seat: string, team: string): string {
  const r = spawnSync("python3", ["-B", "-c", PY, payloads, receipts, now, floor, SCRIPTS, seat, team], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python: ${r.stderr}`);
  return r.stdout.replace(/\n$/, "");
}

describe("the bus activity clock", () => {
  const scratch = mkdtempSync(join(tmpdir(), "watch-bus-activity."));
  const payloads = join(scratch, "payloads");
  const receipts = join(scratch, "receipts");
  mkdirSync(payloads); mkdirSync(receipts);
  const at = (path: string, t: number) => utimesSync(path, t, t);
  const payload = (id: string, fields: string, t: number, fence = true) => {
    const p = join(payloads, `${id}.md`);
    writeFileSync(p, fence ? `---\n${fields}\n---\nbody\n` : `${fields}\n`);
    at(p, t);
  };
  const done = (id: string, t: number) => { const p = join(receipts, `${id}.done`); writeFileSync(p, ""); at(p, t); };
  payload("p-note-old", "kind: note\nfrom: a\nto: b", 1500);
  payload("p-probe-new", "kind: probe\nfrom: watcher\nto: a", 1990);          // supervision: never activity
  payload("p-notice-new", "kind: notice\nfrom: watcher\nto: a", 1991);
  payload("p-progress-new", "kind: progress\nfrom: a\nto: b", 1997);          // newer than every ordinary payload a sent
  payload("p-to-a", "kind: note\nfrom: c\nto: a", 1800);
  payload("p-to-a-foreign", "kind: note\nfrom: c\nto: a\nto_team: other", 1850);   // outbound relay: not a's inbox
  payload("p-to-a-local", "kind: note\nfrom: c\nto: a\nto_team:  tap ", 1860);     // stripped
  payload("p-to-a-local-tab", "kind: note\nfrom: c\nto: a\nto_team: tap\t", 1870);  // a trailing tab survives the field strip? (`rest.strip()` removes it; the second strip is for the caller's team)
  payload("p-from-a", "kind: note\nfrom: a\nto: d", 1700);
  payload("p-no-fence", "kind: note\nfrom: a", 1995, false);                        // {}: counts without a seat only
  payload("p-loose-colon", "kind:note\nfrom: a\nto: b", 1996);                      // `kind:note` is not a field
  payload("p-future", "kind: note\nfrom: c\nto: b", 5000);                          // clamped to now (for every seat but a and b: the clamp must not mask the rows below)
  payload("_draft", "kind: note\nfrom: a\nto: b", 1999);                            // draft: skipped
  payload(".dot", "kind: note\nfrom: a\nto: b", 1998);                              // glob skips dotfiles
  payload(".dot-newest", "kind: note\nfrom: a\nto: a", 1999);                       // ... even when it would be the newest for every seat
  done("p-note-old", 1900);                                                          // a receipt is activity for its payload's kind
  done("p-probe-new", 1993);                                                         // ... unless the kind is supervision
  done("r-orphan", 1997);                                                            // no payload: {} -> counts without a seat
  done("p-progress-new", 1998);                                                      // progress is a supervision kind: its receipt is not activity either
  done(".hidden", 1999); writeFileSync(join(payloads, ".hidden.md"), "---\nkind: note\nfrom: c\nto: a\n---\n"); at(join(payloads, ".hidden.md"), 1500); // a dot receipt: glob skips it too
  writeFileSync(join(receipts, "not-a-receipt.txt"), "");
  const grid: Array<[string, string, string, string]> = [];
  for (const now of ["2000", "1899", "1000", "6000"]) for (const floor of ["0", "1950", "9999"]) for (const [seat, team] of [["", ""], ["a", "tap"], ["a", " tap "], ["a", "other"], ["zz", "tap"]] as const) grid.push([now, floor, seat, team]);
  const want = grid.map(([now, floor, seat, team]) => python(payloads, receipts, now, floor, seat, team));
  for (const [i, [now, floor, seat, team]] of grid.entries()) {
    test(`now=${now} floor=${floor} seat=${JSON.stringify(seat)} team=${JSON.stringify(team)}`, () => {
      expect(busActivity(payloads, receipts, BigInt(now), BigInt(floor), seat, team)).toBe(want[i]!);
    });
  }
  test("a missing payloads or receipts directory is no activity (python's globs were empty)", () => {
    expect(busActivity(join(scratch, "absent"), join(scratch, "absent"), 2000n, 0n, "", "")).toBe(python(join(scratch, "absent"), join(scratch, "absent"), "2000", "0", "", ""));
    expect(busActivity(join(scratch, "absent"), join(scratch, "absent"), 2000n, 0n, "", "")).toBe("");
  });
  test("cleanup", () => { removeScratchTree(scratch); });
});
