// Read-only acceptance instrument. Claims are the population, not all live panes.
import { isOldStoreRefusal } from "./register-authority";
import { loadGlobalRegistry } from "./index-home";
import { enrolledSeatForObservedPane, isRegisteredTeamState, loadCurrentRegistry, seatMap } from "./registry";
import { serverEpochFromRaw, tmuxReadOnly } from "./tmux";

export function paneIdentityCensus(env: NodeJS.ProcessEnv = process.env): { code: number; text: string } {
  const snapshot = loadGlobalRegistry(env.TAP_INDEX_HOME);
  if (snapshot.marker !== "live" || !snapshot.doc) {
    return { code: 1, text: `census: ${snapshot.marker} global registry at ${snapshot.path}\n` };
  }
  const claims: Array<{ pane: string; team: string; handle: string; epoch: string }> = [];
  const skipped: string[] = [];
  for (const [team, value] of Object.entries(snapshot.doc.teams ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (!isRegisteredTeamState(entry.state)) continue;
    if (typeof entry.registry_location !== "string" || !entry.registry_location) { skipped.push(team); continue; }
    try {
      for (const [handle, seat] of Object.entries(seatMap(loadCurrentRegistry(entry.registry_location)))) {
        if (seat && typeof seat === "object" && typeof seat.pane_id === "string" && seat.pane_id) {
          claims.push({ pane: seat.pane_id, team, handle, epoch: typeof seat.server_epoch === "string" ? seat.server_epoch : "" });
        }
      }
    } catch (error) {
      if (isOldStoreRefusal(error)) throw error;
      skipped.push(team);
    }
  }
  let correct = 0, refused = 0, unjustified = 0;
  const verdicts = new Map<string, number>(), filtered: string[] = [], failures: string[] = [];
  const count = (v: string) => verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
  const panes = [...new Set(claims.map(c => c.pane))].sort();
  for (const pane of panes) {
    // One targeted observation binds identity and generation; no cache/rate writes.
    let observation;
    try { observation = tmuxReadOnly(["display-message", "-p", "-t", pane, "#{pane_id}\t#{session_name}\t#{pid}:#{start_time}"], env); }
    catch { refused++; count("unobservable"); continue; }
    const fields = observation.stdout.trimEnd().split("\t");
    if (observation.code !== 0 || fields.length !== 3 || fields[0] !== pane || !fields[1]) {
      refused++; count("unobservable"); continue;
    }
    const session = fields[1]!, epoch = serverEpochFromRaw(fields[2]!, env);
    let answer;
    try { answer = enrolledSeatForObservedPane(pane, session, epoch, env.TAP_INDEX_HOME); }
    catch { refused++; count("unreadable"); continue; }
    if (answer.kind !== "resolved") {
      refused++; count(answer.kind === "unverified" ? answer.verdict : answer.kind); continue;
    }
    const identity = `${answer.team}/${answer.handle}`;
    if (identity !== session) {
      unjustified++; count("unjustified"); failures.push(`  ${pane} tmux says ${session}, lookup says ${identity}`);
    } else {
      correct++; count("resolved");
      const stale = claims.filter(c => c.pane === pane && c.epoch !== epoch)
        .map(c => `${c.team}/${c.handle}(${c.epoch || "UNSTAMPED"})`);
      if (stale.length) filtered.push(`  ${pane} resolved ${session}; filter discarded: ${stale.join(" ")}`);
    }
  }
  let blind = "unknown (live pane enumeration unavailable)";
  try {
    const live = tmuxReadOnly(["list-panes", "-a", "-F", "#{pane_id}"], env);
    if (live.code === 0) blind = String(live.stdout.split("\n").filter(p => p && !panes.includes(p)).length);
  } catch { /* An unavailable complement is not an observed zero. */ }
  const lines = [
    `pane-identity census: ${panes.length} claimed pane id(s); ${correct} correct, ${refused} refused, ${unjustified} UNJUSTIFIED`,
    `verdicts:${[...verdicts].map(([v, n]) => ` ${v}=${n}`).join("")}`,
    `note: ${correct} correct is load-bearing — over-classifying stale rows may refuse every live identity.`,
    ...(skipped.length ? [`unreadable registry sources excluded from population: ${skipped.join(", ")}`] : []),
    ...(filtered.length ? ["epoch filter discriminated (resolved despite stale claimants):", ...filtered] : []),
    ...(failures.length ? ["UNJUSTIFIED — a confident identity the data does not justify:", ...failures] : []),
    unjustified ? "FAIL: unjustified must be 0 (tap-3kwy)." : "PASS: no pane id resolves to an identity its data cannot justify.",
    "basis: UNJUSTIFIED=0 is a safety property and passes vacuously on an empty board;",
    "       discrimination is proven in enrolled-pane-authority.test.ts, not here.",
    `blind spot: ${blind} live pane(s) claimed by NO row — this sweep walks claims, not panes.`,
  ];
  return { code: unjustified ? 1 : 0, text: lines.join("\n") + "\n" };
}

if (import.meta.main) {
  try {
    const result = paneIdentityCensus();
    process.stdout.write(result.text);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`census: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
