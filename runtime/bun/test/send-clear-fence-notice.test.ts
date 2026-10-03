/**
 * The two native send doors must consume the shared clear-fence notice gate:
 * ordinary delivery warns from courier.ts, while polite parking warns from
 * verbs/send.ts before the park. The helper's own frozen corpus covers torn
 * nonces and sidecar write failures; this file proves both callers honor the
 * same once-per-nonce state.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fixture, releaseScratch, run, type View } from "./support/send-delivery-fixture";

afterAll(releaseScratch, 40_000);

const WARNING = "WARNING: clear fence for rb expired; delivering anyway (fail-open past the family await ceiling)";

function expired(bus: string, nonce: string): void {
  mkdirSync(join(bus, "clear-fence"), { recursive: true });
  writeFileSync(join(bus, "clear-fence", "rb.json"), `${JSON.stringify({
    nonce,
    pid: process.pid,
    since_epoch: 1,
    ceiling_seconds: 1,
  })}\n`);
}

function warningCount(view: View): number {
  return view.stderr.split(WARNING).length - 1;
}

for (const { name, args } of [
  { name: "ordinary delivery courier", args: ["send", "rb", "-m", "hi"] },
  { name: "polite pre-placement door", args: ["send", "rb", "-m", "hi", "--polite"] },
]) {
  describe(`${name} uses the once-per-nonce notice gate`, () => {
    test("consumes the gate once per nonce", () => {
      const fx = fixture();
      expired(fx.bus, "nonce-1");
      const first = run(fx, args);
      const repeated = run(fx, args);

      expired(fx.bus, "nonce-2");
      const changed = run(fx, args);

      expect({
        codes: [first.code, repeated.code, changed.code],
        warnings: [warningCount(first), warningCount(repeated), warningCount(changed)],
        sidecar: readFileSync(join(fx.bus, "clear-fence", "rb.json.expired-notice"), "utf8"),
      }).toEqual({ codes: [0, 0, 0], warnings: [1, 0, 1], sidecar: "nonce-2\n" });
    }, 180_000);

    test("an unreadable diagnostic sidecar does not block delivery", () => {
      const fx = fixture();
      expired(fx.bus, "nonce-1");
      const sidecar = join(fx.bus, "clear-fence", "rb.json.expired-notice");
      writeFileSync(sidecar, Buffer.from([0x80]));

      const view = run(fx, args);

      expect({ code: view.code, warnings: warningCount(view), sidecar: readFileSync(sidecar).toString("hex") })
        .toEqual({ code: 0, warnings: 0, sidecar: "80" });
    }, 180_000);
  });
}
