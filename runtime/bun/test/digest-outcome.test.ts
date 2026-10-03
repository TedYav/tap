import { expect, test } from "bun:test";
import { digestOutcome } from "../src/slices/digest-outcome";

test("verified digest is the only outcome that advances the clock", () => {
  expect(digestOutcome({ rc: 0, members: 2 })).toEqual({
    accepted: true, disposition: "verified", canonicalize: true, stampClock: true,
    notifySenders: false, returnCode: 0, event: "digest", diagnostic: "",
  });
});
for (const [rc, disposition, event] of [[5, "unconfirmed", "redelivery_submit_unverified"],
  [124, "timeout", "redelivery_submit_timeout"]] as const) {
  test(`status ${rc} preserves uncertainty and disables retry`, () => {
    expect(digestOutcome({ rc, members: 2 })).toEqual({
      accepted: true, disposition, canonicalize: true, stampClock: false,
      notifySenders: true, returnCode: rc, event,
      diagnostic: `is canonical but submit-${rc === 124 ? "timeout" : "unverified"}; automatic retry stopped to avoid duplicate injection (2 members)`,
    });
  });
}
for (const rc of [1, 2, 6, 127]) {
  test(`nonaccepted status ${rc} preserves the generic refusal code`, () => {
    expect(digestOutcome({ rc, members: 2 })).toEqual({
      accepted: false, disposition: "failed", canonicalize: false, stampClock: false,
      notifySenders: false, returnCode: 1, event: "digest_inject_failed", diagnostic: "",
    });
  });
}
test("invalid observations refuse without a default decision", () => {
  for (const input of [{ rc: NaN, members: 2 }, { rc: -1, members: 2 },
    { rc: 0, members: 0 }, { rc: 256, members: 2 }]) {
    expect(() => digestOutcome(input)).toThrow();
  }
});

test('harness queue retires retry custody without alarming or advancing delivery clock',()=>{
 expect(digestOutcome({rc:7,members:2})).toMatchObject({accepted:true,disposition:'queued',canonicalize:true,stampClock:false,notifySenders:false,returnCode:0});
});
