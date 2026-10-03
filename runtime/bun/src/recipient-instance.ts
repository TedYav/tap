/** Instance evidence is relative to the selected registry, not the payload's bus. */
import { seatMap, loadCurrentRegistry } from "./registry";

export function recipientInstance(registry: string, actor: string, bound: string): {
  state: "match" | "unresolved" | "mismatch"; current: string;
} {
  let row;
  try { row = seatMap(loadCurrentRegistry(registry))[actor]; }
  catch { return { state: "unresolved", current: "" }; }
  if (!row || typeof row !== "object") return { state: "unresolved", current: "" };
  const current = typeof row.instance === "string" ? row.instance : "";
  return { state: !current ? "unresolved" : current === bound ? "match" : "mismatch", current };
}

/** The instance a settlement receipt stamps as `instance`: the actor's current instance in the
 * selected registry, or the explicit `unresolved` when the registry cannot supply one. It is
 * compared against the envelope's `recipient_instance`, never copied from it (tap-stap). */
export function settlingInstance(registry: string, actor: string): string {
  return recipientInstance(registry, actor, "").current || "unresolved";
}

export function unresolvedRecipient(actor: string, team: string): { detail: string; action: string } {
  return {
    detail: `'${actor}' has no verified instance in selected team '${team}' — locating its payload on another bus does not establish recipient identity here`,
    action: "check tap whoami / tap teams; retry from the registered team's checkout or pass --team <registered-team> (check any explicit TAP_HOME first)",
  };
}

if (import.meta.main) {
  try {
    const [registry, actor, bound, team] = process.argv.slice(2);
    if (!registry || !actor || !bound || !team) throw new Error("expected registry, actor, bound instance, team");
    const result = recipientInstance(registry, actor, bound);
    const refusal = unresolvedRecipient(actor, team);
    console.log([result.state, result.current || "-", refusal.detail, refusal.action].join("\x1f"));
  } catch (error) { console.error(String(error)); process.exit(1); }
}
