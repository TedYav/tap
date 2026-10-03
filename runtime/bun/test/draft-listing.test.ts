import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftEntries, draftView } from "../src/input-backup";

const work = mkdtempSync(join(tmpdir(), "draft-listing-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let serial = 0;
const fixture = () => { const path = join(work, String(serial++)); mkdirSync(path); return path; };
function backup(dir: string, name: string | Buffer, handle = "alice", created = "20260907T200000Z", payload = "draft") {
  const path = Buffer.concat([Buffer.from(`${dir}/`), Buffer.isBuffer(name) ? name : Buffer.from(name)]);
  writeFileSync(path, `---\nschema_version: 1\ncreated_at: ${created}\nhandle: ${handle}\npayload_id: ${payload}\n---\n\n## Backed-up input\n\nbody ${payload}\n`);
  return path;
}
// Frozen pre-port algorithm: independent awk extraction + LC_ALL=C sort -r.
const legacy = String.raw`
set -euo pipefail
field() { awk -v field="$2" '$0 == "---" { if (seen++) exit } $0 ~ "^" field ": " { sub("^" field ": ", ""); print; exit }' "$1"; }
entries() {
  [ -d "$1" ] || return 0
  for path in "$1"/*.md; do
    [ -f "$path" ] || continue
    handle="$(field "$path" handle)"
    [ "$handle" = "$2" ] || continue
    created="$(field "$path" created_at)"
    payload="$(field "$path" payload_id)"
    [ -n "$created" ] && [ -n "$payload" ] || continue
    printf '%s\t%s\t%s\n' "$created" "$payload" "$path"
  done | LC_ALL=C sort -r
}
ENTRIES="$(entries "$1" "$2")"
if [ "$3" = list ]; then
  if [ -z "$ENTRIES" ]; then printf 'tap draft: no drafts backed up for %s\n' "$2"; else
    printf 'CREATED\tPAYLOAD_ID\n'
    printf '%s\n' "$ENTRIES" | awk -F '\t' 'NR <= 10 { print $1 "\t" $2 }'
  fi
elif [ -n "$4" ]; then
  printf '%s\n' "$ENTRIES" | awk -F '\t' -v wanted="$4" '$2 == wanted { printf "%s", $3; exit }'
else
  printf '%s\n' "$ENTRIES" | awk -F '\t' 'NR == 1 { printf "%s", $3 }'
fi
`;
function old(dir: string, list = false, requested = "") {
  const result = Bun.spawnSync(["bash", "-c", legacy, "draft-reference", dir, "alice", list ? "list" : "select", requested]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}
function parity(dir: string, requested = "") {
  expect(draftView(dir, "alice", true)).toEqual(old(dir, true));
  expect(draftView(dir, "alice", false, requested)).toEqual(old(dir, false, requested));
}

test("missing/empty directories and unknown id retain no-result behavior", () => {
  parity(join(work, "missing"));
  parity(fixture());
  const dir = fixture(); backup(dir, "one.md"); parity(dir, "unknown");
});

test("newest timestamp, duplicate timestamp/payload tie-break and ten-row limit match C sort", () => {
  const dir = fixture();
  for (let i = 0; i < 15; i++) backup(dir, `${i}.md`, "alice", `20260907T20${String(i).padStart(2, "0")}00Z`, `p${i}`);
  backup(dir, "z tie.md", "alice", "20260907T201400Z", "p14");
  const winner = backup(dir, "é tie.md", "alice", "20260907T201400Z", "p14");
  backup(dir, "foreign.md", "bob", "99999999T000000Z", "foreign");
  parity(dir); parity(dir, "p4"); parity(dir, "p14"); parity(dir, "foreign");
  expect(draftView(dir, "alice", false)).toEqual(winner);
  expect(draftView(dir, "alice", true).toString().split("\n")).toHaveLength(12);
}, 20000);

test("first matching field wins; missing, empty and body-only fields are excluded", () => {
  const dir = fixture();
  backup(dir, "good.md");
  writeFileSync(join(dir, "missing.md"), '---\nhandle: alice\ncreated_at: now\n---\npayload_id: outside\n');
  writeFileSync(join(dir, "empty.md"), '---\nhandle: alice\ncreated_at: \npayload_id: x\n---\n');
  writeFileSync(join(dir, "wrong-separator.md"), '---\nhandle:alice\ncreated_at: now\npayload_id: x\n---\n');
  writeFileSync(join(dir, "duplicate.md"), '---\nhandle: bob\nhandle: alice\ncreated_at: now\npayload_id: x\n---\n');
  writeFileSync(join(dir, "unfenced.md"), 'handle: alice\ncreated_at: 20200101\npayload_id: unfenced\n');
  writeFileSync(join(dir, "empty-first.md"), 'handle: alice\ncreated_at: \ncreated_at: later\npayload_id: x\n');
  parity(dir);
  expect(draftEntries(dir, "alice")).toHaveLength(2);
});

test("glob semantics retain regular symlinks and skip hidden/non-md/directories/dangling links", () => {
  const dir = fixture();
  const path = backup(dir, "regular.md");
  backup(dir, ".hidden.md", "alice", "9999"); backup(dir, "other.txt", "alice", "9999");
  mkdirSync(join(dir, "folder.md"));
  symlinkSync(path.toString(), join(dir, "linked.md"));
  symlinkSync(join(dir, "missing"), join(dir, "dangling.md"));
  parity(dir);
  expect(draftEntries(dir, "alice")).toHaveLength(2);
});

test("odd filenames match old output; invalid UTF-8 metadata stays byte-exact", () => {
  const dir = fixture();
  backup(dir, "é.md"); backup(dir, "[ glob ] space.md");
  parity(dir);
  const path = backup(dir, "metadata.md");
  writeFileSync(path, Buffer.concat([Buffer.from('handle: alice\ncreated_at: '), Buffer.from([0xff]), Buffer.from('\npayload_id: bytes\n')]));
  // macOS awk can drop invalid UTF-8 under its inherited locale. Native byte
  // handling must not substitute U+FFFD or change the C-sort key.
  expect(draftView(dir, "alice", false)).toEqual(path);
  expect(draftView(dir, "alice", true).subarray(19, 27)).toEqual(Buffer.from([255, 9, 98, 121, 116, 101, 115, 10]));
});

test("odd path delimiters never become another caller's row or truncate the selected path", () => {
  const dir = fixture();
  const selected = backup(dir, "space\ttab\nnewline.md");
  backup(dir, "9999\tforged\tpath\nforeign.md", "bob", "9999", "foreign");
  expect(draftEntries(dir, "alice")).toHaveLength(1);
  expect(draftView(dir, "alice", false)).toEqual(selected);
  expect(draftView(dir, "alice", false, "foreign")).toEqual(Buffer.alloc(0));
});


test("non-UTF8 filenames preserve C-sort order on supporting filesystems", () => {
  if (process.platform === "darwin") {
    console.log("SMOKE-SKIP: non-UTF8 filename C-sort parity requires a filesystem accepting invalid UTF-8 names (Darwin platform boundary)");
    return;
  }
  const dir = fixture();
  backup(dir, Buffer.from([0xff, 0x2e, 0x6d, 0x64]));
  backup(dir, "é.md");
  parity(dir);
});
