/**
 * The goalie tick, ported from skills/tap/scripts/tap-goalie.sh @ 68dcc90 (R6 U2).
 *
 * The tick is the goalie's whole program: fence -> arm -> per-seat judge probes ->
 * prune -> the board-level deadlock pass (census, quorum, queue age, exceptions,
 * the wake ladder, tick log). This module owns the ORDER and the bytes; the lease
 * transactions stay in goalie-lease.ts, and the true externals (pane state, bus
 * activity, registry pane checks, the courier, escalation, the backlog probe)
 * arrive through `GoalieDoors` so the differential replays the same doors the
 * capture ran. The courier argv is Bun's own `send` entry (courier-argv.ts);
 * TAP_COURIER_SCRIPT substitutes a stand-in courier. The errexit-sensitive verb/loop shapes collapse to the loop's
 * bytes, per the watch precedent (leader ruling).
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { courierArgv } from "./courier-argv";
import { validToken } from "./ids";
import { envelopeBodyBytes } from "./envelope";
import { goalieDeliveryHealth } from "./goalie-delivery";
import { isFile, readLoose } from "./watch-lease";
import { activePane, courierDisposition, readRegistryText, seatMapOf } from "./watch-tick";
import { spoolTeamName } from "./context";
import { busActivity } from "./watch-detectors";
import { seatState } from "./seat-state";
import {
  field,
  observeSeat,
  pruneSeats,
  seatsFor,
  set as leaseSet,
  setRequestStatus,
  snapshotLines,
} from "./goalie-lease";
import { tapScriptsDir } from "./scripts-dir";

/**
 * The production doors: native seat state and bus activity for the reads,
 * real spawns for the courier, escalation, and the backlog probe. The courier's
 * stderr lands in the door result (the incumbent piped it through a
 * `.send.<pid>.err` file and read its first line on failure — the door's
 * captured stderr is the same bytes without the litter).
 */
export interface GoalieResolvedContext {
  busHome: string;
  registryPath: string;
  authorityTeam: string;
}
export function realGoalieDoors(
  scriptsDir: string,
  env: NodeJS.ProcessEnv = process.env,
  resolved?: GoalieResolvedContext,
): GoalieDoors {
  // The selected context travels with EVERY child effect: a custom send/ready/
  // escalate seam (unlike the public bin/tap) cannot rediscover the bus, and a
  // state-reading ready command would silently answer from ambient pins.
  const effectEnv = (doorEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const merged: NodeJS.ProcessEnv = { ...env };
    if (resolved) {
      merged.TAP_HOME = resolved.busHome;
      merged.TAP_REGISTRY = resolved.registryPath;
    }
    for (const [k, v] of Object.entries(doorEnv ?? {})) if (v !== undefined) merged[k] = v;
    return merged;
  };
  const spawn = (argv: string[], spawnEnv: NodeJS.ProcessEnv): GoalieDoorResult => {
    const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", env: spawnEnv });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return {
    lib: (fn, args, doorEnv) => {
      // R6 U3: the bus-activity Bash reader is gone; the door is the ported
      // clock over the same canonical payloads/receipts. The team is the
      // ENROLLMENT name (spoolTeamName), not registry content: post-flip that
      // file is pre-authority and may be decoy or relocated.
      if (fn === "tap_supervision_bus_activity") {
        const home = resolved?.busHome ?? env.TAP_HOME ?? "";
        const team = resolved?.authorityTeam
          ?? spoolTeamName(home, env.TAP_INDEX_HOME);
        return {
          status: 0,
          stdout: busActivity(home + "/payloads", home + "/receipts",
            BigInt(args[0] ?? "0"), BigInt(args[1] ?? "0"), args[2] ?? "", team),
          stderr: "",
        };
      }
      if (fn === "tap_seat_state") {
        const home = resolved?.busHome ?? env.TAP_HOME ?? "";
        const registry = resolved?.registryPath ?? env.TAP_REGISTRY ?? home + "/registry.json";
        return { status: 0, stdout: seatState(args[0] ?? "", { registry, home, env: effectEnv(doorEnv) }), stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `goalie: no lib door '${fn}'\n` };
    },
    courier: (argv, doorEnv) => spawn(argv, effectEnv(doorEnv)),
    escalate: (argv, doorEnv) => spawn(argv, { ...effectEnv(doorEnv), BUN_BE_BUN: "1" }),
    ready: (argv, doorEnv) => spawn(argv, effectEnv(doorEnv)),
  };
}

/** The `tap goalie tick` entry: one whole tick against the RESOLVED acting bus.
 * `ctx` is the public context (cmdGoalie resolves it once); without one the env
 * resolves it here, and no TAP_HOME at all is the incumbent's silent no-op. */
export function tickEntry(env: NodeJS.ProcessEnv = process.env, scriptsDir?: string,
  ctx?: { bus: { home: string }; registryPath: string }): {
  rc: number;
  stdout: string;
  stderr: string;
} {
  let home: string, registry: string;
  if (ctx) {
    home = ctx.bus.home;
    // resolveContext already selected the acting registry through index
    // authority; the selected answer IS the answer. An ambient TAP_REGISTRY
    // pin must not override it (the pin predates selection and may be stale).
    registry = ctx.registryPath;
  } else {
    home = env.TAP_HOME ?? "";
    if (home === "") return { rc: 0, stdout: "", stderr: "" };
    registry = env.TAP_REGISTRY || home + "/registry.json";
  }
  const scripts = scriptsDir
    ?? fs.realpathSync(tapScriptsDir());
  const res = goalieTick({
    home,
    registry,
    authorityTeam: spoolTeamName(home, env.TAP_INDEX_HOME),
    scriptsDir: scripts,
    env,
    doors: realGoalieDoors(scripts, env, {
      busHome: home, registryPath: registry,
      authorityTeam: spoolTeamName(home, env.TAP_INDEX_HOME),
    }),
  });
  return { rc: res.rc, stdout: res.stdout, stderr: res.stderr };
}

export interface GoalieDoorResult {
  status: number;
  stdout: string;
  stderr: string;
}
export interface GoalieDoors {
  /** Bus predicates, by their lib.sh names: tap_seat_state and tap_supervision_bus_activity (both native now). */
  lib(fn: string, args: string[], env?: Record<string, string>): GoalieDoorResult;
  /** The courier: `courierArgv([<to>, -m, <body>, ... --json])`. */
  courier(argv: string[], env: Record<string, string>): GoalieDoorResult;
  /** Human escalation via the native escalation leaf. */
  escalate(argv: string[], env: Record<string, string>): GoalieDoorResult;
  /** The backlog probe: `bash -c <TAP_GOALIE_READY_CMD>`. */
  ready(argv: string[], env: Record<string, string>): GoalieDoorResult;
}
export interface GoalieTickInput {
  /** The bus root ($TAP_HOME). */
  home: string;
  registry: string;
  /** skills/tap/scripts of the pinned tree (templates and the native escalation leaf). */
  scriptsDir: string;
  env: Record<string, string | undefined>;
  authorityTeam?: string;
  /** Ordered door-effect records; the differential compares these byte-for-byte. */
  effects?: string[][];
  doors: GoalieDoors;
}

/** Python `str()` for JSON scalars: None renders "None", absent renders "". */
function pyStr(v: unknown): string {
  if (v === null) return "None";
  if (v === undefined) return "";
  return String(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Python `int(x or 0)`; a non-numeric string raises in Python — the caller skips. */
function pyIntOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "" || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^-?\d+$/.test(s)) return Number(s);
    return null; // int("5.5") -> ValueError
  }
  return null;
}
/** Python `datetime.fromisoformat` (Z -> +00:00, naive -> UTC, date-only allowed) -> epoch seconds.
 *
 * `Date.UTC` normalizes out-of-range fields (month 13, hour 25) where python raises
 * ValueError, so every field is range-checked against the real calendar before any
 * arithmetic. Fractional seconds are parsed to MICROSECONDS (python datetime's
 * precision; beyond-six digits truncate) and the final timestamp truncates toward
 * zero like `int(when.timestamp())` — never rounds, or a `.9999` stamp would drift
 * one second and move staleness/expiry thresholds.
 */
function isoEpoch(stamp: string): number | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      stamp,
    );
  if (!m) return null;
  const [, yS = "", moS = "", dS = "", hS = "0", miS = "0", sS = "0", frac = "", tz] = m;
  const y = +yS, mo = +moS, d = +dS, h = +hS, mi = +miS, s = +sS;
  if (mo < 1 || mo > 12) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  if (d < 1 || d > daysInMonth) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  let offsetSeconds = 0;
  if (tz !== undefined && tz !== "Z") {
    const digits = tz.slice(1).replace(":", "");
    const oh = +digits.slice(0, 2), om = +digits.slice(2, 4);
    if (oh > 23 || om > 59) return null;
    offsetSeconds = (tz[0] === "-" ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const micros = Math.floor(Number("0" + (frac === "" ? "0" : frac)) * 1e6);
  const totalMicros = (Date.UTC(y, mo - 1, d, h, mi, s) - offsetSeconds * 1000) * 1000 + micros;
  return Math.trunc(totalMicros / 1e6);
}
function pyRepr(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** `EXCEPTION (a|b|c)` + `VALID-UNTIL` evidence: "<tag>\t<until>", "REJECT\t<why>", or "". */
export const parseException = (text: string, _now: string): string => {
  const m = /EXCEPTION\s*\(\s*([abc])\s*\)/.exec(text);
  if (m === null) return "";
  const tag = m[1]!;
  const u = /VALID-UNTIL[: \t]+(\S+)/.exec(text);
  if (u === null) return `REJECT\ttagged (${tag}) but carries no VALID-UNTIL`;
  const until = isoEpoch(u[1]!.trim());
  if (until === null) {
    return `REJECT\tVALID-UNTIL '${u[1]!.trim()}' is not an ISO-8601 timestamp (e.g. 2026-08-19T13:00:00Z, ` +
      "2026-08-19T13:00:00-07:00, or 2026-08-19; no offset means UTC)";
  }
  if (tag === "a") {
    const rows = text.split("\n").filter((ln) =>
      /^\s*(?:[-*]\s*|\d+[.)]\s*)?[a-z][a-z0-9]*-[a-z0-9]+\b/.test(ln),
    );
    if (rows.length === 0) {
      return "REJECT\texception (a) needs the bd ready enumeration, one row per ticket";
    }
    const bad = rows.filter((ln) => !ln.includes("→") && !ln.includes("->")).map((ln) => ln.trim());
    if (bad.length > 0) {
      return `REJECT\texception (a) row ${pyRepr(bad[0]!.slice(0, 60))} names no decision it waits on (use '<id> -> <decision>')`;
    }
  }
  return `${tag}\t${until}`;
};

export function goalieTick(input: GoalieTickInput): { rc: number; stdout: string; stderr: string } {
  const { home, registry, scriptsDir, doors } = input;
  const fx = input.effects ?? [];
  const armPath = home + "/goalie/arm.json";
  const goalieHome = home + "/goalie";
  const tapBin = resolve(scriptsDir, "../../../bin/tap");
  const escalateLeaf = resolve(scriptsDir, "../../../runtime/bun/src/verbs/escalate.ts");
  const stderrOut: string[] = [];
  const wallNow = () => String(Math.floor(Date.now() / 1000));
  // lib.sh's unconditional `TAP_WATCH_IDENTITY="watcher"` (lib.sh:10207) runs at
  // source time, before tap-goalie.sh, so the incumbent's probe/notice sender is
  // ALWAYS the reserved watcher identity here — the env cannot change it.
  const WATCH_IDENTITY = "watcher";

  const recordSet = (pairs: string[]) => {
    fx.push(["set", ...pairs]);
    try {
      leaseSet(armPath, pairs);
    } catch {
      /* best-effort, like every `|| true` call site */
    }
  };

  /** Records the send arguments, then returns the courier argv that carries them. */
  const sendArgv = (to: string, body: string, flags: string[]): string[] => {
    const args = [to, "-m", body, ...flags];
    fx.push(["send", ...args]);
    return courierArgv(scriptsDir, args, input.env);
  };

  /** `_goalie_send_durable`: true sets GOALIE_SEND_STATUS; failure prints the stderr line. */
  let GOALIE_SEND_STATUS = "";
  const sendDurable = (to: string, from: string, kind: string, body: string): boolean => {
    GOALIE_SEND_STATUS = "";
    const argv = sendArgv(to, body, ["--from", from, "--kind", kind, "--fyi", "--wake", "--json"]);
    const res = doors.courier(argv, { TAP_SELF: from });
    const d = courierDisposition(res.status, res.stdout, res.stderr);
    if (d.accepted) {
      GOALIE_SEND_STATUS = d.status;
      return true;
    }
    stderrOut.push(`tap goalie: send to '${to}' failed (rc=${res.status}): ${d.detail}; next: ${d.action}\n`);
    return false;
  };

  const renderJudgePrompt = (lead: string, seat: string, episode: string, token: string): string => {
    let body = "";
    try {
      body = fs.readFileSync(scriptsDir + "/goalie-templates/judge.md", "utf8");
    } catch {
      body = "";
    }
    // `_goalie_render_prompt` runs under command substitution, which strips the
    // template's trailing newlines before the body rides the courier argv.
    return body.replace(/\n+$/, "")
      .split("{{LEAD}}").join(lead)
      .split("{{TARGET}}").join(seat)
      .split("{{EPISODE}}").join(episode)
      .split("{{TOKEN}}").join(token)
      .split("{{TAP_SCRIPT}}").join(tapBin);
  };

  const sendWake = (me: string, to: string, body: string): string => {
    const argv = sendArgv(to, body, ["--from", me, "--kind", "discuss", "--expect-reply", "--json"]);
    const res = doors.courier(argv, { TAP_SELF: me });
    if (res.status !== 0 && res.status !== 5) return "";
    let id = "", path = "";
    try {
      const d = JSON.parse(res.stdout) as Record<string, unknown>;
      const ok = d["status"] === "injected" || d["status"] === "queued" || d["status"] === "pending";
      if (ok) {
        id = d["id"] === null || d["id"] === undefined ? "" : pyStr(d["id"]);
        path = d["path"] === null || d["path"] === undefined ? "" : pyStr(d["path"]);
      }
    } catch {
      /* no parseable result -> no minted id */
    }
    if (id === "") return "";
    if (path === "") path = home + "/payloads/" + id + ".md";
    // READ BACK THE ARTIFACT: anything but an expected stamp means no obligation
    // was minted (the settle-only boundary).
    try {
      const text = fs.readFileSync(path, "utf8");
      if (!text.split("\n").some((ln) => ln === "reply: expected")) return "";
    } catch {
      return "";
    }
    return id;
  };

  const wakeHuman = (handle: string, body: string) => {
    if (!validToken(handle)) {
      stderrOut.push("tap goalie: human notification not attempted: no valid recorded armer\n");
      return false;
    }
    const tmp = goalieHome + "/.escalate." + process.pid + ".md";
    const fileBody = "TAP goalie: the board has no acquisition attempt and the work-feeder has not answered.\n\n" + body + "\n";
    try {
      fs.mkdirSync(goalieHome, { recursive: true });
      fs.writeFileSync(tmp, fileBody);
    } catch {
      return;
    }
    const args = ["-f", tmp, "--from", handle, "--urgent"];
    const argv = [process.execPath, escalateLeaf, ...args];
    fx.push(["escalate", ...args]);
    let notified = false;
    try { notified = doors.escalate(argv, {}).status === 0; } catch { /* best-effort */ }
    if (!notified) stderrOut.push("tap goalie: human notification unconfirmed for recorded armer '" + handle + "'\n");
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return notified;
  };

  /** Returns the logged line ("" when the append failed — a failed append is NOT a stamp). */
  const tickLog = (now: string, verdict: string, working: string, ready: string, detail: string): string => {
    const line =
      new Date(Number(now) * 1000).toISOString().slice(0, 19) + "Z" +
      ` working=${working} ready=${ready} verdict=${verdict}` + (detail !== "" ? ` ${detail}` : "");
    // ORDER IS LOAD-BEARING: append first, stamp second.
    try {
      fs.mkdirSync(goalieHome, { recursive: true });
      fs.appendFileSync(goalieHome + "/tick.log", line + "\n");
    } catch {
      return "";
    }
    try {
      fs.writeFileSync(goalieHome + "/heartbeat", now + "\n");
    } catch {
      /* heartbeat write failure is not modelled separately */
    }
    recordSet(["heartbeat_at", now]);
    return line;
  };

  const objective = (): string => {
    const ledger = field(armPath, "board_ledger") ?? "";
    if (ledger === "") return "<no ledger configured>";
    let text: string;
    try {
      text = fs.readFileSync(ledger, "utf8");
    } catch {
      return "<ledger configured but unreadable>: " + ledger;
    }
    const m = /^\s*OBJECTIVE:[ \t]*(.*)$/m.exec(text);
    if (m === null) {
      return "<undeclared; ledger has no OBJECTIVE: or TRIGGER: line — objectives and triggers written as prose are invisible here>";
    }
    const value = m[1]!.trim();
    return value !== "" ? value : "<declared empty>";
  };

  const triggerOverdue = (now: string): string => {
    const ledger = field(armPath, "board_ledger") ?? "";
    if (ledger === "" || !isFile(ledger)) return "";
    let text: string;
    try {
      text = fs.readFileSync(ledger, "utf8");
    } catch {
      return "";
    }
    const out: string[] = [];
    for (const m of text.matchAll(/^\s*TRIGGER:[ \t]*(.*)$/gm)) {
      const line = m[1]!;
      const bar = line.lastIndexOf("|");
      if (bar < 0) continue;
      const body = line.slice(0, bar).trim();
      const due = line.slice(bar + 1).trim();
      const dm = /^due\s+(\S+)/.exec(due);
      if (dm === null) continue;
      const when = isoEpoch(dm[1]!);
      if (when === null) continue;
      if (Number(now) > when) {
        out.push(`TRIGGER OVERDUE: ${body}, due ${dm[1]}, +${Math.floor((Number(now) - when) / 60)}m`);
      }
    }
    return out.join("\n");
  };

  type WakeReply = { status: "pending" } | { status: "unreadable" } |
    { status: "answered"; id: string; text: string };
  const wakeAnswered = (id: string): WakeReply => {
    const readReply = (rid: string, digest?: unknown): WakeReply => {
      // The only legal move is spool -> payloads. Open in that order and keep
      // the bytes: never return a path for the parser to open a second time.
      for (const dir of ["spool", "payloads"]) {
        let bytes: Buffer;
        try { bytes = fs.readFileSync(`${home}/${dir}/${rid}.md`); }
        catch { continue; }
        const body = envelopeBodyBytes(bytes);
        if (digest !== undefined && (body === null || typeof digest !== "string" ||
            createHash("sha256").update(body).digest("hex") !== digest)) {
          return { status: "unreadable" };
        }
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return { status: "unreadable" }; }
        if (!text.split("\n").includes("in_reply_to: " + id)) return { status: "unreadable" };
        return { status: "answered", id: rid, text };
      }
      return { status: "unreadable" };
    };
    let receipt: Record<string, unknown> | undefined;
    try { receipt = JSON.parse(fs.readFileSync(`${home}/receipts/${id}.done`, "utf8")); }
    catch { /* A reply can arrive before its settlement receipt. */ }
    if (receipt?.["via"] === "reply") {
      const rid = receipt["reply_id"];
      if (typeof rid !== "string" || !validToken(rid) || typeof receipt["reply_sha256"] !== "string") {
        return { status: "unreadable" };
      }
      return readReply(rid, receipt["reply_sha256"]);
    }
    // A pre-receipt reply is still evidence. Enumerate spool before payloads so
    // a move between directory reads cannot disappear from both snapshots.
    for (const dir of ["spool", "payloads"]) {
      let names: string[];
      try { names = fs.readdirSync(home + "/" + dir).filter((n) => n.endsWith(".md")).sort(); }
      catch { continue; }
      for (const n of names) {
        const rid = n.slice(0, -3);
        if (!validToken(rid)) continue;
        const reply = readReply(rid);
        if (reply.status === "answered") return reply;
      }
    }
    return { status: "pending" };
  };

  /** `_goalie_seat_ages`: "<handle>\t<age|UNAGED:structural|UNAGED:unreadable>" rows. */
  const seatAges = (now: string, observer: string): Array<[string, string]> => {
    const seats = seatMapOf(registryText);
    const TAIL_BYTES = 262144;
    const authored = (rec: Record<string, unknown>): boolean => {
      const kind = rec["type"];
      if (kind === "assistant") return true; // claude: the model's own turn
      if (kind !== "response_item") return false; // codex bookkeeping, or unknown
      const payload = rec["payload"];
      if (!isObject(payload)) return false; // REFUSED, not defaulted
      return payload["role"] === undefined || payload["role"] === null || payload["role"] === "assistant";
    };
    const lastSelfAuthored = (path: string): number | null => {
      let size = -1;
      try {
        size = fs.statSync(path).size;
      } catch {
        return null;
      }
      let window = TAIL_BYTES;
      let lines: string[] = [];
      for (;;) {
        let blob: Buffer;
        try {
          const fh = fs.openSync(path, "r");
          try {
            const start = size > window ? size - window : 0;
            const buf = Buffer.alloc(size - start);
            const got = fs.readSync(fh, buf, 0, buf.length, start);
            blob = buf.subarray(0, got);
          } finally {
            fs.closeSync(fh);
          }
        } catch {
          return null;
        }
        lines = blob.toString("utf8").split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const truncated = size > window;
        if (truncated && lines.length > 0) lines = lines.slice(1);
        if (lines.length > 0 || !truncated) break;
        if (window >= size) break;
        window *= 2;
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (line === "") continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isObject(rec)) continue;
        if (!authored(rec)) continue;
        const stamp = rec["timestamp"];
        if (typeof stamp !== "string" || stamp === "") continue;
        const when = isoEpoch(stamp);
        if (when !== null) return when;
      }
      return null;
    };
    const rows: Array<[string, string]> = [];
    for (const handle of [...seats.keys()].sort()) {
      if (handle === observer) continue;
      const entry = seats.get(handle);
      if (!(entry instanceof Map)) continue;
      const ent = entry as Map<string, unknown>;
      const status = ent.has("status") ? pyStr(ent.get("status")) : "active";
      if (status !== "active") continue;
      if (pyStr(ent.get("delivery")) === "poll") continue;
      const kind = pyStr(ent.get("session_store_kind"));
      const path = ent.get("session_store_path");
      if (kind === "db" || kind === "dir" || path === undefined || path === null || pyStr(path) === "") {
        rows.push([handle, "UNAGED:structural"]);
        continue;
      }
      if (!pyStr(path).endsWith(".jsonl")) {
        rows.push([handle, "UNAGED:structural"]);
        continue;
      }
      const when = lastSelfAuthored(pyStr(path));
      if (when === null) {
        rows.push([handle, "UNAGED:unreadable"]);
        continue;
      }
      rows.push([handle, String(Math.max(0, Number(now) - when))]);
    }
    return rows;
  };

  const denominatorSwing = (now: string, aged: number, windowSeconds: string): { persisted: string; message: string } => {
    const tolRaw = input.env.TAP_GOALIE_DENOM_TOLERANCE_PCT;
    const tol = tolRaw === undefined || tolRaw === "" ? 30 : Number(tolRaw);
    // readLoose revives EVERY JSON integer as bigint (exactness), so samples come
    // back bigint and must not be filtered away by a Number.isInteger check --
    // dropping them would shrink the persisted window to one row and silence the
    // denominator tripwire forever.
    const sampleInt = (v: unknown): bigint | null => {
      if (typeof v === "bigint") return v;
      if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
      return null;
    };
    let rows: unknown[] = [];
    try {
      const rec = readLoose(armPath);
      const raw = isObject(rec) ? rec["ageable_samples"] : undefined;
      rows = Array.isArray(raw) ? raw : [];
    } catch {
      rows = [];
    }
    const nowN = BigInt(Number(now));
    const win = BigInt(Number(windowSeconds));
    const kept: Array<[bigint, bigint]> = [];
    for (const r of rows as unknown[]) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const r0 = sampleInt(r[0]), r1 = sampleInt(r[1]);
      if (r0 === null || r1 === null) continue;
      if (nowN - r0 < 0n || nowN - r0 > win) continue;
      kept.push([r0, r1]);
    }
    kept.push([nowN, BigInt(aged)]);
    const bounded = kept.slice(-256);
    // Exact digits, no float round-trip: python's json.dumps(separators=(",", ":")).
    const compact = "[[" + bounded.map(([a, b]) => `${a},${b}`).join("],[") + "]]";
    const lo = bounded.reduce((m, r) => (r[1] < m ? r[1] : m), bounded[0]![1]);
    const hi = bounded.reduce((m, r) => (r[1] > m ? r[1] : m), bounded[0]![1]);
    const tolB = BigInt(tol);
    if (hi === lo) return { persisted: compact, message: "" };
    if (lo <= 0n) {
      if (hi > 0n) return { persisted: compact, message: `${lo} -> ${hi} (population appeared, over ${bounded.length} ticks)` };
      return { persisted: compact, message: "" };
    }
    // EXACT cross-multiplication, not the truncated percent (the truncated value
    // is only for the human-readable message).
    if ((hi - lo) * 100n > tolB * lo) {
      const pct = (hi - lo) * 100n / lo;
      return { persisted: compact, message: `${lo} -> ${hi} (${pct}% swing over ${bounded.length} ticks)` };
    }
    return { persisted: compact, message: "" };
  };

  /** `_goalie_ready`'s four fields. */
  const backlogProbe = (now: string): [string, string, string, string] => {
    const cmd = input.env.TAP_GOALIE_READY_CMD || "bd ready --json";
    const res = doors.ready(["/bin/bash", "-c", cmd], { TAP_GOALIE_NOW: now });
    const raw = res.stdout.replace(/\n+$/, "");
    if (raw === "") return ["?", "?  (backlog probe returned nothing)", "?", ""];
    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch {
      return ["?", "?  (backlog probe output was not readable)", "?", ""];
    }
    if (!Array.isArray(rows)) return ["?", "?  (backlog probe output was not a list)", "?", ""];
    if (rows.length === 0) return ["0", "?  (no ready ticket)", "-", ""];
    const top = isObject(rows[0]) ? (rows[0] as Record<string, unknown>) : {};
    // THE TICK'S OWN CLOCK: `now` already applied the TAP_GOALIE_NOW-or-wall
    // fallback once, and the bash probe received the same value as its env — a
    // second `Date.now()` here would straddle a second boundary and move every
    // ready age by one.
    const nowN = Number(now);
    let best: [number, string] | null = null;
    for (const row of rows) {
      if (!isObject(row)) continue;
      const deps = pyIntOrNull(row["dependency_count"]);
      if (deps === null || deps !== 0) continue;
      const created = row["created_at"];
      if (typeof created !== "string" || created === "") continue;
      const when = isoEpoch(created);
      if (when === null) continue;
      const age = Math.max(0, nowN - when);
      if (best === null || age > best[0]) {
        best = [age, row["id"] === undefined ? "?" : pyStr(row["id"])];
      }
    }
    const ageField = best === null ? "-" : String(best[0]);
    const agedId = best === null ? "" : best[1];
    return [
      String(rows.length),
      `${top["id"] === undefined ? "?" : pyStr(top["id"])} P${top["priority"] === undefined ? "?" : pyStr(top["priority"])} ${top["title"] === undefined ? "?" : pyStr(top["title"])}`,
      ageField,
      agedId,
    ];
  };

  const teammates = (lead: string, observer: string): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    const seats = seatMapOf(registryText);
    for (const handle of [...seats.keys()].sort()) {
      if (handle === observer || handle === lead) continue;
      const entry = seats.get(handle);
      if (!(entry instanceof Map)) continue;
      const ent = entry as Map<string, unknown>;
      const status = ent.has("status") ? pyStr(ent.get("status")) : "active";
      if (status !== "active" || pyStr(ent.get("delivery")) === "poll") continue;
      out.push([handle, pyStr(ent.get("pane"))]);
    }
    return out;
  };

  // --- the tick ------------------------------------------------------------
  if (isFile(home + "/reset.fence.json")) return { rc: 0, stdout: "", stderr: "" };
  if (!isFile(armPath)) return { rc: 0, stdout: "", stderr: "" };
  const now = input.env.TAP_GOALIE_NOW ?? wallNow();

  let armedAt = "", threshold = "", lead = "";
  for (const line of snapshotLines(armPath)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const key = line.slice(0, tab), value = line.slice(tab + 1);
    if (key === "armed_at") armedAt = value;
    else if (key === "threshold_seconds") threshold = value;
    else if (key === "armed_by") lead = value;
  }
  if (armedAt === "") armedAt = now;
  if (threshold === "") threshold = "1500";

  const observer = field(armPath, "goalie_handle") ?? "";
  if (observer === "") {
    const line = tickLog(now, "lease-unresolved", "0", "-",
      "lease carries no goalie_handle; run: tap goalie off && tap goalie on");
    return {
      rc: line === "" ? 1 : 0,
      stdout: line === "" ? "" : `tap goalie: ${line}\n`,
      stderr: "",
    };
  }

  // A failed observation is not an empty board. Validate before per-seat
  // pruning as well as the census, and use this snapshot for both reads.
  const registryText = readRegistryText(registry);
  let registryReadable = false;
  try {
    const doc: unknown = JSON.parse(registryText ?? "");
    registryReadable = isObject(doc) && isObject(doc["seats"]) &&
      Object.values(doc["seats"]).every(isObject);
  } catch { /* typed observer failure below */ }
  if (!registryReadable) {
    const line = tickLog(now, "unreadable-for-cause", "?", "-", "acting registry unreadable; census unavailable");
    return { rc: line === "" ? 1 : 0, stdout: line === "" ? "" : `tap goalie: ${line}\n`, stderr: "" };
  }

  const allSeatAges = seatAges(now, "");
  const lease = readLoose(armPath);
  const delivery = goalieDeliveryHealth({
    home, team: input.authorityTeam ?? spoolTeamName(home, input.env.TAP_INDEX_HOME), observer,
    seat: JSON.parse(registryText!).seats[observer],
    judgeSeats: isObject(lease) ? seatsFor(lease) : undefined,
    now: Number(now), staleSeconds: Number(input.env.TAP_GOALIE_STALE_SECONDS ?? "2400"),
    authoredAge: allSeatAges.find(([handle]) => handle === observer)?.[1],
    state: () => {
      fx.push(["delivery_state", observer, `now=${now}`]);
      return doors.lib("tap_seat_state", [observer], { TAP_WATCH_NOW: now });
    },
  });
  if (delivery.status === "degraded") {
    const line = tickLog(now, "degraded-delivery", "?", "-", `${observer}: ${delivery.reason}`);
    return { rc: line === "" ? 1 : 0, stdout: line === "" ? "" : `tap goalie: ${line}\n`, stderr: "" };
  }

  const active: string[] = [];
  for (const [handle, pane] of teammates(lead, observer)) {
    if (handle === "") continue;
    active.push(handle);
    fx.push(["seat_state", handle, `now=${now}`]);
    const stateRes = doors.lib("tap_seat_state", [handle], { TAP_WATCH_NOW: now });
    let state = stateRes.stdout.replace(/\n+$/, "");
    if (stateRes.status !== 0) state = state !== "" ? state + "\nunknown" : "unknown";
    let activity = now;
    let episode = "", token = "";
    if (pane !== "" && state === "idle-at-prompt") {
      // The incumbent's plain assignment is errexit-sensitive; the port carries
      // the loop shape: a failed probe leaves activity empty -> the armed floor.
      fx.push(["bus_activity", now, armedAt, handle]);
      const act = doors.lib("tap_supervision_bus_activity", [now, armedAt, handle], { TAP_WATCH_NOW: now });
      activity = act.stdout.replace(/\n+$/, "");
      if (activity === "") activity = armedAt;
      fx.push(["observe_seat", armedAt, handle, now, activity, "1", threshold]);
      let minted: { now: bigint; token: string } | null = null;
      try {
        minted = observeSeat(armPath, BigInt(armedAt), handle, BigInt(now), BigInt(activity), true, BigInt(threshold)).minted;
      } catch {
        minted = null;
      }
      if (minted !== null) {
        episode = minted.now.toString();
        token = minted.token;
      }
    } else {
      fx.push(["observe_seat", armedAt, handle, now, now, "0", threshold]);
      try {
        observeSeat(armPath, BigInt(armedAt), handle, BigInt(now), BigInt(now), false, BigInt(threshold));
      } catch {
        /* discarded, like `>/dev/null 2>&1 || true` */
      }
    }
    if (episode === "") continue;

    const judgeBody = renderJudgePrompt(lead, handle, episode, token);
    if (sendDurable(observer, WATCH_IDENTITY, "probe", judgeBody)) {
      fx.push(["request_status", armedAt, handle, episode, GOALIE_SEND_STATUS]);
      try {
        setRequestStatus(armPath, armedAt, handle, episode, GOALIE_SEND_STATUS);
      } catch {
        /* advisory */
      }
      continue;
    }
    fx.push(["request_status", armedAt, handle, episode, "failed"]);
    try {
      setRequestStatus(armPath, armedAt, handle, episode, "failed");
    } catch {
      /* advisory */
    }
    const fallback = `Goalie sidecar could not reach the local goalie seat for '${handle}' idle episode ${episode}. Inspect tap goalie status and the goalie pane.`;
    if (!sendDurable(lead, WATCH_IDENTITY, "notice", fallback)) {
      if (!validToken(lead)) {
        stderrOut.push("tap goalie: human notification not attempted: no valid recorded armer\n");
        continue;
      }
      const args = ["-m", fallback, "--from", lead];
      const argv = [process.execPath, escalateLeaf, ...args];
      fx.push(["escalate", ...args]);
      try {
        if (doors.escalate(argv, {}).status !== 0) stderrOut.push(`tap goalie: human notification unconfirmed for recorded armer '${lead}'\n`);
      } catch {
        stderrOut.push(`tap goalie: human notification unconfirmed for recorded armer '${lead}'\n`);
      }
    }
  }
  fx.push(["prune_seats", armedAt, ...active]);
  try {
    pruneSeats(armPath, armedAt, active);
  } catch {
    /* advisory */
  }

  // --- the deadlock pass (board level, LAST, unconditional) ----------------
  const deadlockPass = (): { rc: number; line: string } => {
    const obs = field(armPath, "goalie_handle") ?? "";
    if (obs === "") {
      const line = tickLog(now, "lease-unresolved", "0", "-",
        "lease carries no goalie_handle; run: tap goalie off && tap goalie on");
      return { rc: line === "" ? 1 : 0, line };
    }
    let aged = 0, stale = 0, unaged = 0, unreadable = 0;
    let unagedNames = "", unreadableNames = "";
    const staleSecs = input.env.TAP_GOALIE_STALE_SECONDS ?? "2400";
    for (const [handle, age] of allSeatAges) {
      if (handle === "" || handle === obs) continue;
      if (age.startsWith("UNAGED")) {
        unaged += 1;
        unagedNames = unagedNames !== "" ? unagedNames + ", " + handle : handle;
        if (age.includes("unreadable")) {
          unreadable += 1;
          unreadableNames = unreadableNames !== "" ? unreadableNames + ", " + handle : handle;
        }
        continue;
      }
      aged += 1;
      if (Number(age) >= Number(staleSecs)) stale += 1;
    }
    const total = aged + unaged;
    const working = String(aged - stale);
    const pct = aged > 0 ? Math.trunc((stale * 100) / aged) : 0;

    const swing = denominatorSwing(now, aged, staleSecs);
    if (swing.persisted !== "") recordSet(["ageable_samples", swing.persisted]);

    const [ready, next, topAgeRaw, agedId] = backlogProbe(now);
    let queueFire = false, queueBlind = false;
    let topAge = topAgeRaw;
    if (topAge === "-") {
      /* legitimately quiet term */
    } else if (topAge === "" || /[^0-9]/.test(topAge)) {
      topAge = "?";
      queueBlind = true;
      queueFire = true;
    } else if (Number(topAge) >= Number(input.env.TAP_GOALIE_QUEUE_AGE_SECONDS ?? "3600")) {
      queueFire = true;
    }
    let readyLog = ready;
    if (queueBlind) {
      readyLog = ready + " QUEUE-AGE UNKNOWN (backlog probe unreadable — firing rather than trusting it)";
    } else if (queueFire) {
      const top = agedId !== "" ? agedId : (next.split(" ")[0] ?? "");
      readyLog = ready + ` QUEUE-AGE ${Math.floor(Number(topAge) / 60)}m top=${top}`;
    }
    if (unreadable !== 0) readyLog += ` UNREADABLE-STORES ${unreadable}`;

    const minSeats = input.env.TAP_GOALIE_QUORUM_MIN_SEATS ?? "5";
    const quorumPct = input.env.TAP_GOALIE_QUORUM_PCT ?? "80";
    if ((aged < Number(minSeats) || pct < Number(quorumPct)) && !queueFire) {
      let detail: string;
      if (aged === 0) detail = "no seat carries an ageable session store";
      else if (aged < Number(minSeats)) {
        detail = `only ${aged} ageable seat(s), below the ${minSeats}-seat quorum floor — a percentage over a tiny board is not a quorum`;
      } else {
        detail = `stale=${stale}/${aged} (${pct}%) unaged=${unaged} of ${total}`;
      }
      if (unreadable !== 0) {
        detail += `; UNREADABLE STORES ${unreadable} (${unreadableNames}) — instrument fault, not coverage`;
      }
      if (swing.message !== "" || unreadable > 0) {
        let cause = "";
        if (swing.message !== "") cause = "ageable denominator unstable: " + swing.message;
        if (unreadable > 0) {
          if (cause !== "") cause += "; ";
          cause += `${unreadable} store(s) unreadable, so the population was not fully read`;
        }
        const line = tickLog(now, "unreadable-for-cause", working, "-", `${cause} — ${detail}`);
        return { rc: line === "" ? 1 : 0, line };
      }
      // Quiet describes the board, not settlement of the feeder's obligation.
      // Pause the ladder with its original id/rung; a later fire resumes it.
      if ((field(armPath, "wake_id") ?? "") === "") {
        recordSet(["deadlock_since", "0", "wake_id", "", "wake_at", "0", "wake_rung", "0",
          "exception_tag", "", "exception_until", "0", "exception_refused", ""]);
      }
      const line = tickLog(now, "quiet", working, "-", detail);
      return { rc: line === "" ? 1 : 0, line };
    }

    let queuePhrase = "";
    if (queueBlind) {
      queuePhrase = "QUEUE-AGE UNKNOWN — the backlog probe could not be read, so this fires rather than trusting it";
    } else if (queueFire) {
      queuePhrase = `QUEUE-AGE ${agedId !== "" ? agedId : "top"} unclaimed and ready for ${Math.floor(Number(topAge) / 60)}m`;
    }
    let quorumLine: string;
    if (queuePhrase !== "" && pct < Number(quorumPct)) {
      quorumLine = `${queuePhrase} (seats: stale ${stale}/${aged}, ${pct}% — below the quorum)`;
    } else {
      quorumLine = `STALE ${stale}/${aged} (${pct}%) idle >=${Math.floor(Number(staleSecs) / 60)}m`;
      if (queuePhrase !== "") quorumLine += "; " + queuePhrase;
    }
    let unagedLine = "";
    if (unaged > 0) {
      unagedLine = `UNAGED ${unaged}/${total} excluded from the quorum: ${unagedNames}`;
      if (unreadable !== 0) {
        unagedLine += `\nUNREADABLE STORES ${unreadable} (${unreadableNames}) — a store is configured and could not be read; that is an instrument fault, not missing coverage`;
      }
    }

    let feeder = field(armPath, "feeder") ?? "";
    if (feeder === "") feeder = lead;
    let owner = feeder;
    if (feeder === "") {
      owner = "<vacant>";
    } else {
      fx.push(["active_pane", feeder]);
      if (!activePane(registry, feeder)) owner = "<vacant>";
    }

    const exTag = field(armPath, "exception_tag") ?? "";
    const exUntil = field(armPath, "exception_until") ?? "";
    if (exTag !== "" && exUntil !== "" && exUntil !== "0" && Number(now) < Number(exUntil)) {
      const line = tickLog(now, "held", working, "-", `exception=${exTag} until=${exUntil}`);
      return { rc: line === "" ? 1 : 0, line };
    }

    const wakeId = field(armPath, "wake_id") ?? "";
    let rung = field(armPath, "wake_rung") ?? "";
    if (rung === "") rung = "0";

    const wakeBody = (ownerV: string, trigger: string): string => {
      const lines: string[] = [];
      lines.push("OBJECTIVE " + objective());
      lines.push(`DEADLOCK · ${quorumLine} · READY ${ready}`);
      if (unagedLine !== "") lines.push(unagedLine);
      lines.push("NEXT " + next);
      lines.push("OWNER " + ownerV);
      if (trigger !== "") lines.push(trigger);
      const refused = field(armPath, "exception_refused") ?? "";
      if (refused !== "") lines.push("YOUR LAST EXCEPTION WAS NOT ACCEPTED: " + refused);
      lines.push("");
      lines.push("Dispatch the ticket named on NEXT, or name IT and the condition that would change your mind.");
      lines.push("An acceptable decline is one of three, tagged, in reply to this wake:");
      lines.push("  EXCEPTION (a) backlog-needs-owner · (b) blocking system issue · (c) hard external failure");
      lines.push("  VALID-UNTIL <ISO-8601: 2026-08-19T13:00:00Z, 2026-08-19T13:00:00-07:00, or 2026-08-19>");
      lines.push("  No offset is read as UTC. Expiry without renewal re-arms deadlock.");
      lines.push("  A named event is NOT accepted — it cannot expire mechanically, so an exception bounded by");
      lines.push("  one would never re-arm.");
      lines.push("  For (a), every enumerated row must name what it waits on:  <id> -> <the decision>");
      return lines.join("\n");
    };
    const done = (verdict: string, r: string, detail: string): { rc: number; line: string } => {
      const line = tickLog(now, verdict, working, r, detail);
      return { rc: line === "" ? 1 : 0, line };
    };

    if (wakeId !== "") {
      const reply = wakeAnswered(wakeId);
      if (reply.status === "unreadable") {
        return done("answered-unreadable", "-", `wake=${wakeId}; reply evidence unavailable or mismatched`);
      }
      if (reply.status === "answered") {
        const exc = parseException(reply.text, now);
        const tab = exc.indexOf("\t");
        const tag = tab < 0 ? exc : exc.slice(0, tab);
        const until = tab < 0 ? "" : exc.slice(tab + 1);
        if (tag === "REJECT") {
          recordSet(["exception_refused", until, "wake_id", "", "wake_at", "0", "wake_rung", "0"]);
          return done("answered-malformed", "-", `refused: ${until}`);
        }
        if (tag !== "") {
          recordSet(["exception_tag", tag, "exception_until", until !== "" ? until : "0",
            "exception_refused", "", "wake_id", "", "wake_at", "0", "wake_rung", "0"]);
          return done("answered-exception", "-", `tag=${tag} until=${until !== "" ? until : "0"}`);
        }
        recordSet(["wake_id", "", "wake_at", "0", "wake_rung", "0", "exception_tag", "", "exception_until", "0"]);
        return done("answered", "-", `reply=${reply.id}`);
      }
      const trigger = triggerOverdue(now);
      const body = wakeBody(owner, trigger);
      if (Number(rung) < 2) {
        const body2 = body + "\nUNANSWERED since the last fire. While this sits, the board has no acquisition attempt.";
        const reminder = `Wake ${wakeId} is still unanswered. Reply to that wake; no new obligation is created.\n` + body2;
        const sent = owner !== "<vacant>" && sendDurable(feeder, WATCH_IDENTITY, "notice", reminder);
        if (sent) {
          recordSet(["wake_rung", "2"]);
          return done("rung2", readyLog, `refired to=${feeder}`);
        }
        wakeHuman(lead, body2);
        recordSet(["wake_rung", "3"]);
        return done("rung3", readyLog, `refire-undeliverable owner=${owner}`);
      }
      if (Number(rung) === 2) {
        const notified = wakeHuman(lead, body);
        recordSet(["wake_rung", "3"]);
        return done("rung3", readyLog, `${notified ? "human-woken" : "human-unconfirmed"} owner=${owner}`);
      }
      return done("rung3-standing", "-", "human escalation rung; wake still unanswered");
    }

    // Rung 1 — first wake for this deadlock.
    const trigger = triggerOverdue(now);
    const body = wakeBody(owner, trigger);
    const since = field(armPath, "deadlock_since") ?? "";
    if (since === "0" || since === "") recordSet(["deadlock_since", now]);
    // `[ "$owner" = '<vacant>' ] || ! active_pane` — short-circuit skips the probe
    // (and its effect) when the owner is already vacant.
    let obsUnreachable = false;
    if (owner !== "<vacant>") {
      fx.push(["active_pane", obs]);
      obsUnreachable = !activePane(registry, obs);
    }
    if (owner === "<vacant>" || obsUnreachable) {
      wakeHuman(lead, body);
      recordSet(["wake_rung", "3", "deadlock_since", now]);
      return done("rung3", readyLog, `no mintable obligation owner=${owner}`);
    }
    const minted = sendWake(obs, feeder, body);
    if (minted === "") {
      wakeHuman(lead, body);
      recordSet(["wake_rung", "3", "deadlock_since", now]);
      return done("rung3", readyLog, `wake send failed owner=${owner}`);
    }
    recordSet(["wake_id", minted, "wake_at", now, "wake_rung", "1", "deadlock_since", now]);
    return done("deadlock", readyLog, `woke=${feeder} id=${minted}`);
  };

  const pass = deadlockPass();
  return {
    rc: pass.rc,
    stdout: pass.line === "" ? "" : `tap goalie: ${pass.line}\n`,
    stderr: stderrOut.join(""),
  };
}
