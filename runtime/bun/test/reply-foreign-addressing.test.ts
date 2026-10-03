// tap_serial_triggers "bin/" "runtime/bun/main.ts" "runtime/bun/test/support/reply-foreign-fixture.ts" "skills/tap/scripts/tap-send.sh" "skills/tap/scripts/lib.sh"
// ADDRESSING component of the former reply-foreign-payload.test.ts (unit 2
// split): the reference spellings that deliver the answer (absolute path,
// path=<absolute-file>, <team>/<id>, <id> --payload <abs>, a bare <id> through the
// index), the --progress delivery shape, the --payload id-mismatch
// usage_error, and the bare-id LOCAL-first resolver order. Shared world:
// support/reply-foreign-fixture.ts (this file registers its own
// afterAll(releaseScratch, 40_000)).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { envelopeField } from "../src/envelope";
import { TapError } from "../src/context";
import { refuseUnreachableSenderTeam } from "../src/verbs/reply";
import { removeScratchTree } from "./support/scratch";
import { fixture, run, outbounds, frontmatter, injected, settlement, INBOUND_ID, releaseScratch, type Fx } from "./support/reply-foreign-fixture";

afterAll(releaseScratch, 40_000);
describe("the foreign payload file", () => {
  // The four spellings of the same reference. Each delivers the answer to
  // beta/rb, places the outbound on ALPHA's bus and settles the inbound on
  // BETA's.
  const spellings: Array<{ name: string; args: (fx: Fx) => string[] }> = [
    { name: "an absolute path", args: fx => [fx.payload] },
    { name: "path=<file>", args: fx => [`path=${fx.payload}`] },
    { name: "<team>/<id>", args: () => [`beta/${INBOUND_ID}`] },
    { name: "<id> --payload <abs>", args: fx => [INBOUND_ID, "--payload", fx.payload] },
    { name: "a bare <id> resolved through the index", args: () => [INBOUND_ID] },
  ];
  for (const spelling of spellings) {
    test(`delivery (${spelling.name}): the answer goes to beta/rb, the outbound lives on alpha's bus, the inbound settles on beta's`, () => {
      const fx = fixture();
      const v = run(fx, ["reply", ...spelling.args(fx), "-m", "answer", "--by", "ua"]);
      expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
        .toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "" });
      const mail = outbounds(fx.alpha.bus);
      expect({ alpha: mail.length, beta: outbounds(fx.beta.bus) }).toEqual({ alpha: 1, beta: [] });
      const outId = mail[0]!.replace(/\.md$/, "");
      const fm = frontmatter(join(fx.alpha.bus, "payloads", mail[0]!));
      expect(fm).toEqual({ from: "ua", to: "rb", kind: "discuss", reply: "settle-only", cross_worktree: "true", from_team: "alpha", to_team: "beta", recipient_instance: "rb|B", sender_instance: "ua|A", in_reply_to: INBOUND_ID });
      expect(injected(fx)).toEqual([`[[TAP v0.23 note alpha/${outId}]]`]);
      // The settle epoch falls back to the FOREIGN envelope's `epoch:` (the
      // local context has no inbound receipt at all).
      expect(settlement(fx)).toEqual({ betaDone: { via: "reply", by: "ua", replyId: outId, adoptedFrom: undefined, preview: "answer", epoch: "3" }, alphaDone: false });
    }, 120_000);
  }

  test("--progress on a foreign inbound: the progress outbound is delivered and NO .done lands on either bus", () => {
    const fx = fixture();
    const v = run(fx, ["reply", fx.payload, "-m", "still working", "--by", "ua", "--progress"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr })
      .toEqual({ code: 0, route: "native reply", stdout: `tap reply: progress ${INBOUND_ID} (open)\n`, stderr: "" });
    expect({ alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) }).toEqual({ alpha: 1, betaDone: null, alphaDone: false });
  }, 120_000);

  test("refusal: --payload naming a file whose id is not the reference — usage_error, nothing placed", () => {
    const fx = fixture();
    const v = run(fx, ["reply", "rb-20260916T120000Z-000000000000", "--payload", fx.payload, "-m", "answer", "--by", "ua"]);
    expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) }).toEqual({
      code: 1, route: "native reply", stdout: "",
      stderr: `tap reply: explicit payload id '${INBOUND_ID}' does not match 'rb-20260916T120000Z-000000000000'; next: tap reply <id> --payload <matching-path> -f <body-file>\n`,
      alpha: 0, betaDone: null, alphaDone: false,
    });
  }, 120_000);

  for (const spelling of ["--payload", "positional path"] as const) {
    test(`refusal: a relative ${spelling} is not accepted as an external payload address`, () => {
      const fx = fixture();
      const rel = relative(fx.alpha.wt, fx.payload);
      const args = spelling === "--payload" ? [INBOUND_ID, "--payload", rel] : [rel];
      const v = run(fx, ["reply", ...args, "-m", "answer", "--by", "ua"]);
      expect({ code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr, alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) }).toEqual({
        code: 1, route: "native reply", stdout: "",
        stderr: `tap reply: --payload must be an absolute path (got: ${rel}); next: tap help reply\n`,
        alpha: 0, betaDone: null, alphaDone: false,
      });
    }, 120_000);
  }

  test("a bare id that two enrolled buses hold resolves LOCAL-first (the resolver's order) — alpha's copy is answered and settled, beta's untouched", () => {
    const fx = fixture({ duplicateOnAlpha: true });
    const v = run(fx, ["reply", INBOUND_ID, "-m", "answer", "--by", "ua"]);
    const seen = { code: v.code, route: v.route, stdout: v.stdout, stderr: v.stderr.replace(/<root>[^\s]*/g, "<path>"), alpha: outbounds(fx.alpha.bus).length, ...settlement(fx) };
    // A bare id resolves LOCALLY first when the local bus holds it (the
    // resolver's order): the reply answers alpha's copy, so nothing is
    // ambiguous — measured, pinned as the resolver's contract.
    expect(seen).toEqual({ code: 0, route: "native reply", stdout: `tap reply: ok ${INBOUND_ID}\n`, stderr: "", alpha: 1, betaDone: null, alphaDone: true });
  }, 120_000);
});
