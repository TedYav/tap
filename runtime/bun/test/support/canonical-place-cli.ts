// Test-only door onto the native placement owner (courier.ts canonicalPlace) for
// shell fixtures; see skills/tap/scripts/smoke/canonical-place-fixture.sh.
//
// argv: <src> <id> <from> <to> <kind> <dest> [xwt] [reply] [from_team] [to_team]
//       [urgency] [reply_to] [in_reply_to] [recipient_instance] [sender_instance]
// The positional order is the retired Bash tap_canonical_place's. As there, a
// non-empty xwt (even "0") stamps `cross_worktree: true`, and <dest> is stamped
// as `path:`. The bus is <dest>'s grandparent, so <dest> must be
// <bus>/payloads/<id>.md.
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, normalize } from "node:path";

import { Bus } from "../../src/bus";
import { canonicalPlace } from "../../src/courier";

const [src, id, from, to, kind, dest, xwt = "", reply, from_team, to_team, urgency, reply_to, in_reply_to, recipient_instance, sender_instance] = process.argv.slice(2);

try {
  if (!src || !id || !from || !to || !kind || !dest) throw new Error("usage: <src> <id> <from> <to> <kind> <dest> [xwt] [reply] ...");
  const bus = new Bus(dirname(dirname(dest)));
  if (basename(dirname(dest)) !== "payloads" || bus.payloadPath(id) !== normalize(dest)) {
    throw new Error(`dest must be <bus>/payloads/${id}.md, got ${dest}`);
  }
  mkdirSync(bus.payloadsDir, { recursive: true });
  mkdirSync(bus.receiptsDir, { recursive: true });
  // canonicalPlace takes the source TEXT, not a path.
  canonicalPlace(bus, readFileSync(src, "utf8"), {
    id, from, to, kind, path: dest,
    cross_worktree: xwt !== "" ? "true" : undefined,
    reply, from_team, to_team, urgency, reply_to, in_reply_to, recipient_instance, sender_instance,
  });
} catch (e) {
  process.stderr.write(`canonical_place_fixture: ${(e as Error).message}\n`);
  process.exitCode = 1;
}
