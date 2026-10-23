import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { SENTINEL_VERSION } from "./sentinel";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeAllSync } from "./fsatomic";
import { pyDumpIndent } from "./lossless-json";
import { acquirePathLock } from "./panelock";
import { pyReadUtf8, pyStrip } from "./spool-publication";
import { isMap, loads, pyStr, type JsonMap, type JsonValue } from "./watch-detect";

function diagnostic(message: unknown): void {
  try { writeAllSync(2, Buffer.from(`tap-version-briefing: ${message}\n`)); } catch { /* advisory output may also be closed */ }
}

function persist(path: string, state: JsonMap): void {
  const temp = join(dirname(path), `.version-seen.${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, pyDumpIndent(state, 0) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function schemaNumber(value: JsonValue): number | bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return Number(value);
  if (value !== null && typeof value === "object" && "float" in value) return Number(value.float);
  throw new Error("version state schema_version is not numeric");
}

function brief(root: string, team: string, handle: string, env: NodeJS.ProcessEnv): void {
  const current = SENTINEL_VERSION;
  const statePath = env.TAP_VERSION_SEEN_PATH ?? join(homedir(), ".tap/version-seen.json");
  const changelogPath = env.TAP_VERSION_CHANGELOG_PATH ?? join(root, "skills/tap/VERSION-BRIEF.md");
  const visible = env.TAP_VERSION_RECORD_ONLY !== "1";
  // Check before opening state descriptors: a closed stdout could otherwise be
  // reused by the lock, making a notice write succeed against the lock file.
  if (visible) fstatSync(1);
  const emit = (detail: string) => {
    if (visible) writeAllSync(1, Buffer.from(`TAP v${current} — ${detail}\n`));
  };

  let lock;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    // Python opened a+ before flock; lockf alone also accepts directories on macOS.
    closeSync(openSync(`${statePath}.lock`, "a+"));
    lock = acquirePathLock(`${statePath}.lock`, 1000, env);
    if (!lock) throw new Error("version state lock acquisition exceeded one second");
  } catch (error) {
    diagnostic(`could not open lock ${statePath}.lock: ${error}`);
    emit("protocol update pending (version state unavailable)");
    return;
  }
  try {
    let state: JsonMap = new Map<string, JsonValue>([["schema_version", 1n], ["seats", new Map()]]);
    if (existsSync(statePath)) {
      let loaded: JsonValue, schema: number | bigint | undefined;
      try {
        loaded = loads(pyReadUtf8(statePath));
        if (isMap(loaded)) schema = schemaNumber(loaded.has("schema_version") ? loaded.get("schema_version")! : 1n);
      } catch (error) {
        diagnostic(`could not read ${statePath}: ${error}`);
        emit("protocol update pending (version state unreadable)");
        return;
      }
      if (isMap(loaded) && schema! <= 1 && isMap(loaded.get("seats"))) state = loaded;
      else {
        const reason = isMap(loaded) && schema! > 1 ? "unsupported" : "invalid";
        emit(`protocol update pending (${reason} version state)`);
        diagnostic(`${reason} version state in ${statePath}; preserving it`);
        return;
      }
    }
    const seats = state.get("seats") as JsonMap;
    const key = `${team}/${handle}`;
    const seat = seats.has(key) ? seats.get(key) : new Map<string, JsonValue>();
    if (!isMap(seat)) throw new Error(`invalid seat ${key} in ${statePath}; preserving it`);
    const prior = seat.get("last_seen_version");
    if (prior === current) return;
    const baseline = prior === undefined || prior === null;
    if (!baseline) {
      let detail = `protocol changed from v${pyStr(prior)} to v${current}`;
      try {
        const changelog = pyReadUtf8(changelogPath).replace(/\r\n?/g, "\n");
        const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const section = new RegExp(`^## TAP v${escaped}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(changelog)?.[1];
        const lines = section?.split(/[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).map(pyStrip).filter(Boolean);
        if (lines?.length) detail = lines.join(" ");
      } catch (error) {
        // Bad UTF-8 is not a missing changelog: do not consume its notice.
        if (typeof (error as NodeJS.ErrnoException)?.errno !== "number") throw error;
        diagnostic(`could not read changelog ${changelogPath}: ${error}`);
      }
      // The synchronous complete write must succeed before the state can advance.
      emit(detail);
    }
    seat.set("last_seen_version", current);
    seats.set(key, seat);
    try { persist(statePath, state); }
    catch (error) { diagnostic(`could not persist ${baseline ? "baseline" : "banner"} state ${statePath}: ${error}`); }
  } finally { lock.release(); }
}

/** Briefing is advisory: a committed registration must survive every failure here. */
export function versionBriefing(root: string, team: string, handle: string, env: NodeJS.ProcessEnv = process.env): void {
  try { brief(root, team, handle, env); } catch (error) { diagnostic(error); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const fields: Record<string, string> = {};
  let valid = true;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    if (!["--root", "--team", "--handle"].includes(flag) || args[i + 1] === undefined) { valid = false; break; }
    fields[flag] = args[i + 1]!;
  }
  if (!valid || !fields["--root"] || !fields["--team"] || !fields["--handle"]) {
    diagnostic("--root, --team, and --handle are required (no other options)");
    process.exitCode = 64;
  } else versionBriefing(fields["--root"], fields["--team"], fields["--handle"]);
}
