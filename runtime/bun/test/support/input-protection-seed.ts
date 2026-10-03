import { updateInputProtection, type InputProtection } from "../../src/input-protection";

/**
 * Seed the EXPIRED input-protection record a production park would have left
 * behind: the park-time submit (or its waiter) mints the pane record with a
 * 30 s grace on the real clock, and a forced deadline arrives after it
 * lapses. Fixtures that jump straight to the forced attempt must seed this
 * state through the product's own writer — the record file name is
 * sha256(physicalSocketPath + NUL + pane) and must not be duplicated here.
 *
 * Returns the written record, or null when the product writer declined to
 * write one; the CLI wrapper turns null into a nonzero exit so a vacuous
 * seed fails loudly instead of letting the drain mint a fresh grace.
 */
export function seedExpiredProtection(opts: {
  env: NodeJS.ProcessEnv;
  paneId: string;
  serverEpoch: string;
  harness?: string;
  home: string;
  id: string;
  sender?: string;
  ageSeconds?: number;
  draft?: string;
}): InputProtection | null {
  const now = Date.now() - (opts.ageSeconds ?? 120) * 1000;
  return updateInputProtection(
    { paneId: opts.paneId, serverEpoch: opts.serverEpoch, currentCommand: opts.harness ?? "codex" } as never,
    { state: "busy", text: opts.draft ?? "unfinished human draft" },
    {
      env: opts.env, now, urgent: false, harness: opts.harness, sender: opts.sender ?? "ua",
      message: { home: opts.home, id: opts.id, sender: opts.sender ?? "ua" },
    },
  );
}
