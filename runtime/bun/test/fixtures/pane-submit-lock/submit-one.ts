#!/usr/bin/env bun
// One concurrent sender for pane-submit-lock-physics.test.ts: the native
// courier's submit (courier.ts submitVerify), which takes the pane lock around
// the whole cycle. Only the harness-liveness probe is substituted (the band is
// not a real codex process); the lock, captures and keystrokes are production.
const [courierPath, pane, id, sentinel] = process.argv.slice(2);
if (!courierPath || !pane || !id || !sentinel) {
  process.stderr.write("usage: submit-one.ts <courier.ts> <pane> <id> <sentinel>\n");
  process.exit(2);
}
export {};
const { submitVerify, REAL_EFFECTS } = await import(courierPath);
// A pane-bound recipient carries the generation observed with its id, as send
// stamps it (tap-zk1w); the courier refuses a bound pane without one.
const seen = REAL_EFFECTS.observePane(pane);
const serverEpoch = seen && typeof seen === "object" ? seen.serverEpoch : "";
const r = submitVerify(
  pane,
  id,
  sentinel,
  { paneId: pane, serverEpoch, harness: "codex" },
  undefined,
  { ...REAL_EFFECTS, harnessEvidence: () => "alive" },
);
process.stderr.write(`${JSON.stringify(r)}\n`);
process.exit(r.status === "injected" ? 0 : 5);
