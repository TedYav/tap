import { validToken } from "../ids";

export type WaiterScope =
  | { ok: true; target: string; targetRegistry: string }
  | { ok: false; refusal: "unbound" | "registry_mismatch" };

/** An absent binding must never become the drain's whole-bus default. */
export function waiterScope(input: {
  target: string; targetRegistry: string; registryMatchesTeam: boolean;
}): WaiterScope {
  if (!validToken(input.target) || !input.targetRegistry || /[\x00-\x1f\x7f]/.test(input.targetRegistry)) {
    return { ok: false, refusal: "unbound" };
  }
  if (!input.registryMatchesTeam) return { ok: false, refusal: "registry_mismatch" };
  return { ok: true, target: input.target, targetRegistry: input.targetRegistry };
}

if (import.meta.main) {
  try {
    const [target, targetRegistry, matches] = Bun.argv.slice(2);
    if (Bun.argv.length !== 5 || !["0", "1"].includes(matches!)) throw new Error("expected target, registry, and match flag");
    console.log(JSON.stringify(waiterScope({ target: target!, targetRegistry: targetRegistry!, registryMatchesTeam: matches === "1" })));
  } catch (error) { console.error(String(error)); process.exit(2); }
}
