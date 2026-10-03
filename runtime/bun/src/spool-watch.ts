import { join } from "node:path";
import { untintPane } from "./pane-tint";
import { drainOnce, type DrainContext, type DrainEffects } from "./spool-drain";
import { pyStrCompare } from "./spool-publication";
import { fieldValue, isFile, readLoose, set } from "./watch-lease";

/**
 * The watcher alone supplies the human-alert fact; no environment name grants it.
 * After the drain, the pass clears panes an older arm painted `bg=colour22` and
 * records an empty list. It does not paint. `hold_until_epoch` is eligibility,
 * not a promise the row will inject, so a standing tint would show while a
 * busy, grace, or unverified row is still parked.
 */
export async function processWatchSpool(ctx: DrainContext, effects: DrainEffects, armedAt: string): Promise<number> {
  const arm = join(ctx.home, "watch/arm.json");
  if (!isFile(arm) || fieldValue(readLoose(arm), "armed_at") !== armedAt) return 0;
  const rc = await drainOnce(ctx, effects);
  if (rc !== 0 && rc !== 5) return rc;
  const previous = fieldValue(readLoose(arm), "tinted_panes") || "[]";
  // The incumbent's Python diff failed on malformed JSON but the pass still
  // replaced tinted_panes. Keep that failure local to cosmetic reconciliation.
  try {
    const parsed = JSON.parse(previous);
    if (!Array.isArray(parsed)) throw new Error("tinted_panes is not a list");
    const recorded = [...new Set(parsed.filter((pane): pane is string => typeof pane === "string" && pane !== ""))];
    const bestEffort = (pane: string) => {
      ctx.signal?.throwIfAborted();
      try { untintPane(pane, ctx.env); } catch { /* Best-effort cue. */ }
    };
    for (const pane of recorded.sort(pyStrCompare)) bestEffort(pane);
  } catch (error) { ctx.signal?.throwIfAborted(); process.stderr.write(`tap watch: spool tint reconciliation failed: ${String(error)}\n`); }
  try { set(arm, ["tinted_panes", "[]"], ctx.env); } catch { /* best effort */ }
  return 0;
}
