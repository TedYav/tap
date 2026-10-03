/** The digest submit result decides custody and reporting, never pane effects. */
export interface DigestOutcome {
  accepted: boolean;
  disposition: "verified" | "queued" | "unconfirmed" | "timeout" | "failed";
  canonicalize: boolean;
  stampClock: boolean;
  notifySenders: boolean;
  returnCode: number;
  event: "digest" | "redelivery_submit_unverified" | "redelivery_submit_timeout" | "digest_inject_failed";
  diagnostic: string;
}

export function digestOutcome({ rc, members }: { rc: number; members: number }): DigestOutcome {
  if (!Number.isInteger(rc) || rc < 0 || rc > 255 || !Number.isInteger(members) || members < 1) {
    throw new Error("digest outcome requires a shell status and positive member count");
  }
  if (rc === 0) return {
    accepted: true, disposition: "verified", canonicalize: true, stampClock: true,
    notifySenders: false, returnCode: 0, event: "digest", diagnostic: "",
  };
  if (rc === 7) return {
    accepted:true,disposition:"queued",canonicalize:true,stampClock:false,
    notifySenders:false,returnCode:0,event:"digest",diagnostic:"accepted into harness queue; recipient processing unconfirmed",
  };
  if (rc === 5 || rc === 124) return {
    accepted: true, disposition: rc === 124 ? "timeout" : "unconfirmed", canonicalize: true,
    stampClock: false, notifySenders: true, returnCode: rc,
    event: rc === 124 ? "redelivery_submit_timeout" : "redelivery_submit_unverified",
    diagnostic: `is canonical but submit-${rc === 124 ? "timeout" : "unverified"}; automatic retry stopped to avoid duplicate injection (${members} members)`,
  };
  return {
    accepted: false, disposition: "failed", canonicalize: false, stampClock: false,
    notifySenders: false, returnCode: 1, event: "digest_inject_failed", diagnostic: "",
  };
}

// Resolve the finite table before the pane attempt: no subprocess is needed
// between an observed submit and its custody disposition. The final row is the
// generic failure and preserves the helper's existing refusal status 1.
if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3) throw new Error("expected member count");
    const members = Number(Bun.argv[2]);
    const rows = [0, 5, 124, 7, 1].map(rc => {
      const result = digestOutcome({ rc, members });
      return [rc === 1 ? "*" : rc, +result.canonicalize, +result.stampClock,
        +result.notifySenders, result.returnCode,
        result.event, result.diagnostic].join("\x1f");
    });
    console.log(rows.join("\n"));
  } catch (error) {
    console.error(String(error));
    process.exit(2);
  }
}
