import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notifyDraftBackedUp } from "../src/spool-park-report";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(change = "", clients = "client-one\nclient-two\n") {
  const root = mkdtempSync(join(tmpdir(), "draft-notice-")); roots.push(root);
  const bin = join(root, "bin"), log = join(root, "notices"); mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(join(bin, "tmux"), `#!/bin/bash
while [ "$1" = -L ] || [ "$1" = -S ]; do shift 2; done
case "$1" in
  list-clients) [ "$3" = owner-session ] || exit 1; printf '%s' "$CLIENTS" ;;
  display-message)
    if [ "$2" = -c ]; then printf '%s\\n' "$*" >> "$NOTICES"; exit 0; fi
    case "\${!#}" in
      '#{pid}:#{start_time}')
        if [ "$CHANGE" = epoch ] && [ -s "$NOTICES" ]; then printf '9:9\\n'; else printf '1:2\\n'; fi ;;
      *)
        id=%7
        if [ "$CHANGE" = pane ] && [ -s "$NOTICES" ]; then id=%8; fi
        printf '%s\\towner-session\\t42\\tcodex\\t0\\n' "$id" ;;
    esac ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAP_INDEX_HOME: join(root, "index"),
    TAP_SERVER_EPOCH: undefined, TAP_TMUX_SOCKET_PATH: join(root, "socket"), NOTICES: log, CLIENTS: clients, CHANGE: change };
  return { env, notices: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

test("draft notice addresses each owner client, never the invoking client", () => {
  const f = fixture();
  notifyDraftBackedUp("owner:0", "%7", "srv:1:2", "owner-session", f.env);
  expect(f.notices()).toEqual(["client-one", "client-two"].map(client =>
    `display-message -c ${client} -t %7 -d 8000 tap: your draft was saved, not lost -- recover it with: tap draft`));
});

for (const change of ["epoch", "pane"]) test(`draft notice stops when ${change} changes between clients`, () => {
  const f = fixture(change);
  notifyDraftBackedUp("owner:0", "%7", "srv:1:2", "owner-session", f.env);
  expect(f.notices()).toHaveLength(1);
});

test("unknown caller identity and zero clients are cosmetic no-ops", () => {
  for (const [paneId, epoch, session, clients] of [["", "srv:1:2", "owner-session", "c"],
    ["%7", "", "owner-session", "c"], ["%7", "srv:1:2", "", "c"], ["%7", "srv:1:2", "owner-session", ""]]) {
    const f = fixture("", clients);
    notifyDraftBackedUp("owner:0", paneId!, epoch!, session!, f.env);
    expect(f.notices()).toEqual([]);
  }
});

test("an incomplete backup notice does not promise recovery of pasted contents", () => {
  const f = fixture();
  notifyDraftBackedUp("owner:0", "%7", "srv:1:2", "owner-session", f.env, true);
  expect(f.notices()).toHaveLength(2);
  for (const notice of f.notices()) {
    // The notice labels incomplete pasted-text/image snapshots; never promised as recovered content.
    expect(notice).toContain("pasted contents or images were not captured");
    expect(notice).not.toContain("saved, not lost");
  }
});
