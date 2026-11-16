// Peek owns command orchestration; the shared identity and paired-capture owners stay intact.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TapError, observeCallerIdentity, refuseUnanchoredPane, requireActingRegistry, resolveContext } from "../context";
import { contextUsedPercent } from "../context-census";
import { validToken } from "../ids";
import { errorJson, humanAction, humanLine } from "../native-error";
import { DEFAULT_AGENT_FAMILIES } from "../observe";
import { gatherRowsFromEnv, paneHarnessCommand } from "../observe-gather";
import { captureInputFrame, framePairIo, paneIo, paneRead } from "../pane/reader";
import { parsePreservingBigint, seatMap, type RegistryDoc, type Seat } from "../registry";
import { serverEpochNow } from "../spool-park-report";
import { pyTruthy } from "../spool-publication";
import { bootId, ServerUnresponsive, tmuxReadOnly, type Run } from "../tmux";
import { pythonStr } from "../watch-lease";
import { isOldStoreRefusal } from "../register-authority";
import { tapScriptsDir, artifactBun } from "../scripts-dir";
import { ownBun, ownBunFlags } from "../own-bun";

const scripts = tapScriptsDir();
const subst = (value: string) => value.replace(/\n+$/, "");
type Result = { status: number; stdout: string; stderr: string };
const empty = (status = 0): Result => ({ status, stdout: "", stderr: "" });
// lib.sh's constant, which its adapters pinned over any ambient TAP_OBS_HARNESS_FAMILIES.
const FAMILIES = DEFAULT_AGENT_FAMILIES;
const US = "\x1f";

/**
 * A tmux read whose deadline or fork failure is a failed read, as the Bash client's was.
 * Peek only observes, so it stays outside the courier's submit-rate bucket, as
 * `tmux_deadline.py` did: an exhausted bucket must not read a live pane as gone.
 */
function read(args: string[], env: NodeJS.ProcessEnv): Run {
  try { return tmuxReadOnly(args, env); } catch (error) {
    if (error instanceof ServerUnresponsive) return { code: 1, stdout: "", stderr: `${error.message}\n` };
    throw error;
  }
}

/** `tap_seat_observed_record`: one row through the shared gather, the historical five fields. */
function observedRecord(fields: Record<string, string>, nowBoot: string, env: NodeJS.ProcessEnv): string {
  const session = fields.session || (fields.pane!.includes(":") ? fields.pane!.slice(0, fields.pane!.indexOf(":")) : "");
  const gatherEnv: NodeJS.ProcessEnv = { ...env, TAP_OBS_SESSION_SCOPE: session, TAP_OBS_HARNESS_FAMILIES: FAMILIES.join(" ") };
  if (nowBoot) gatherEnv.TAP_OBS_NOW_BOOT_PIN = nowBoot;
  try {
    const record = gatherRowsFromEnv([{ key: "0", ...fields, session }], gatherEnv)[0] ?? "";
    const [, state = "", reason = "", pane = "", paneId = "", harness = ""] = record.split(US);
    return [state, reason, pane, paneId, harness].join(US);
  } catch {
    // The adapter's refusal: an observation that could not run is unknown, never gone.
    return ["unknown", "harness_unobservable", "", "", ""].join(US);
  }
}

/** `tap_is_launcher_managed`: the raw row names both a session and a harness. */
function launcherManaged(registryPath: string, handle: string): boolean {
  try {
    const row = seatMap(JSON.parse(readFileSync(registryPath, "utf8")) as RegistryDoc)[handle];
    return typeof row?.session === "string" && row.session !== "" && typeof row.harness === "string" && row.harness !== "";
  } catch { return false; }
}

/** `tap_pane_read`: both views captured once, then read from that one pair. */
function paneReadResult(pane: string, harness: string, handle: string, env: NodeJS.ProcessEnv): Result {
  const live = paneIo(env, tmuxReadOnly);
  const io = { capture: (target: string, escaped: boolean, joined: boolean) => {
    try { return live.capture(target, escaped, joined); } catch (error) {
      if (error instanceof ServerUnresponsive) return { code: 1, stdout: "" };
      throw error;
    }
  }, paneWidth: () => "" };
  const escaped = captureInputFrame(io, pane, harness, true);
  const plain = escaped.ok ? captureInputFrame(io, pane, harness, false) : escaped;
  if (!escaped.ok || !plain.ok) {
    return { ...empty(1), stderr: `tap: slice_failed id=${pane} slice=pane-read: classification failed\n` };
  }
  const width = env.TAP_PANE_WIDTH ?? "";
  return { ...empty(), stdout: paneRead(framePairIo(escaped.frame, plain.frame, width), pane, harness, handle, env.TAP_PEEK_JSON === "1") };
}

/** A watcher supplies an environment, not permission to replace its own process globals.
 * Keep the old subprocess boundary; only the command owner on its far side changes. */
export function peekResult(handle: string, scriptsDir: string, env: NodeJS.ProcessEnv): Result {
  const r = spawnSync(ownBun(), [...ownBunFlags(), resolve(scriptsDir, "../../../runtime/bun/src/verbs/peek.ts"), handle], {
    encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readPeek(argv: string[], scriptsDir: string): Result {
  let handle = "", pane = "", json = false;
  let env: NodeJS.ProcessEnv = { ...process.env, TAP_VERB: "tap peek", TAP_PEEK_JSON: "0" };
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--pane") {
        pane = argv[++i] ?? "";
        // The old shell's required-operand error bypassed JSON, even after --json.
        if (!pane) return { status: 1, stdout: "", stderr: "tap peek: --pane needs a value\n" };
      } else if (a === "--json") {
        json = true;
        env = { ...env, TAP_JSON: "1", TAP_PEEK_JSON: "1" };
      } else if (a.startsWith("--")) throw new TapError(1, "unknown_option", "tap help peek", `unknown option '${a}'`);
      else if (!handle) handle = a;
      else throw new TapError(1, "usage_error", "tap help peek", `unexpected arg '${a}'`);
    }
    if (!handle) throw new TapError(1, "usage_error", "tap help peek", "usage: tap peek <handle> [--pane <tmux-target>] [--json]");
    if (!validToken(handle)) throw new TapError(1, "usage_error", "tap help peek", `handle '${handle}' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);

    let harness = "", resolvedId = "", observedEpoch: string | undefined;
    if (pane) {
      if (!read(["display-message", "-p", "-t", pane, "#{pane_id}"], env).stdout.replace(/\n+$/, "")) {
        throw new TapError(3, "pane_gone", "re-open the pane and retry", `pane '${pane}' for '${handle}' is gone`);
      }
    } else {
      let ctx;
      try {
        ctx = resolveContext(process.cwd(), env, { paneFallback: false });
        requireActingRegistry(ctx, 4);
      } catch (error) {
        if (isOldStoreRefusal(error)) throw error;
        const caller = observeCallerIdentity(env);
        if (caller.state === "inside") refuseUnanchoredPane(caller.paneId, process.cwd(), 4, caller, env);
        const reason = caller.state === "outside" ? caller.detail : caller.refusal;
        throw new TapError(4, "unanchored_bus", "run from the enrolled team root",
          `cwd-derived bus has no acting registry and the caller pane is not observable (${reason})`);
      }
      ctx.bus.ensureDirs();
      let row: Seat = {};
      // A missing registry keeps the fresh-team reading; present-but-unreadable
      // bytes refuse — an "unregistered" answer would send the operator to the
      // wrong fix.
      if (existsSync(ctx.registryPath)) {
        try {
          const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(ctx.registryPath));
          const doc = parsePreservingBigint(raw);
          // JSON-valid bytes that are not a registry object get the doctor
          // refusal, same shape check readRegistry applies — "unregistered"
          // would send the operator to the wrong fix.
          if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("registry document must be an object");
          row = seatMap(doc as RegistryDoc)[handle] ?? {};
        } catch {
          throw new TapError(1, "registry_invalid", "tap doctor", `the acting registry '${ctx.registryPath}' could not be read — run: tap doctor`);
        }
      }
      const status = Object.hasOwn(row, "status") ? row.status : "active";
      if (status !== "active" && !(status === "suspended" && row.status_reason === "server_restarted")) row = {};
      const text = (key: string, fallback = "") => pythonStr(pyTruthy(row[key]) ? row[key] : fallback);
      if (!text("pane") && !text("session")) {
        throw new TapError(1, "unregistered", `tap register ${handle} --pane <tmux-target>`, `no pane for '${handle}'`);
      }
      harness = text("harness");
      observedEpoch = serverEpochNow(env, tmuxReadOnly);
      const observed = observedRecord({ status: text("status", "active"), delivery: text("delivery", "pane"),
        pane: text("pane"), pane_id: text("pane_id"), session: text("session"), registered_at: text("registered_at"),
        row_epoch: text("server_epoch"), row_boot: text("boot_id"), harness, status_reason: text("status_reason") },
        bootId(env), env);
      const [state = "", reason = "", resolvedPane = "", paneId = "", observedHarness = ""] = observed.split(US);
      if (!resolvedPane) {
        if (state === "gone") {
          const action = launcherManaged(ctx.registryPath, handle)
            ? `tap session resume ${handle}` : `re-open pane for '${handle}' and run 'tap in'`;
          throw new TapError(3, "pane_gone", action, `session for '${handle}' is gone (${reason || "session_absent"})`);
        }
        if (reason === "address_rebound") {
          throw new TapError(1, "pane_recycled", `tap team   (verify the seat's row)   ·   tap session resume ${handle}`,
            `the stored address for '${handle}' now holds a DIFFERENT pane (${reason}) — refusing to read a pane the session name does not vouch for`);
        }
        throw new TapError(1, "pane_unproven", "tap team   (verify the seat's row)   ·   tap doctor",
          `identity for '${handle}' is unproven (${state}${reason ? `: ${reason}` : ""}) — peek reads only name-proven panes`);
      }
      pane = resolvedPane;
      resolvedId = paneId;
      harness = observedHarness || harness;
    }
    if (!harness) {
      const command = spawnSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_current_command}"], { encoding: "utf8", env });
      harness = paneHarnessCommand(pane, subst(command.stdout ?? ""), FAMILIES, env);
    }
    if (env.TAP_PEEK_CONTEXT === "1") {
      const epoch = serverEpochNow(env, tmuxReadOnly);
      if (!epoch || epoch !== (observedEpoch ?? epoch)) return empty(1);
      // Ambient tmux, unjoined: moving this to socket-aware capture is a separate B1 decision.
      const capture = spawnSync("tmux", ["capture-pane", "-t", resolvedId || pane, "-p"], { encoding: "utf8", env });
      if (capture.status !== 0) return { ...empty(1), stderr: capture.stderr ?? "" };
      if (epoch !== serverEpochNow(env, tmuxReadOnly)) return empty(1);
      const percent = contextUsedPercent(harness, subst(capture.stdout ?? ""));
      return { ...empty(), stdout: percent === null ? "" : `${percent}\n` };
    }
    return paneReadResult(pane, harness, handle, env);
  } catch (error) {
    const tagged = error as Error & { tapErrorClass?: string; tapAction?: string };
    if (!(error instanceof TapError) && !tagged?.tapErrorClass) throw error;
    const code = error instanceof TapError ? error.code : 1;
    const cls = error instanceof TapError ? error.errorClass : tagged.tapErrorClass!;
    const action = error instanceof TapError ? error.action : tagged.tapAction ?? "";
    const detail = error instanceof TapError ? error.detail : tagged.message;
    return json || env.TAP_JSON === "1"
      ? { status: code, stdout: errorJson(cls, action, detail), stderr: "" }
      : { status: code, stdout: "", stderr: `tap peek: ${humanLine(detail)}; next: ${humanAction(action)}\n` };
  }
}

export function cmdPeek(argv: string[], scriptsDir = scripts): number {
  const result = readPeek(argv, scriptsDir);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.status;
}

if (import.meta.main) process.exitCode = cmdPeek(Bun.argv.slice(2));
