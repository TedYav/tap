import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  TapError,
  teamRootFromBus,
} from "../context";
import { atomicWrite, ensureAscii } from "../fsatomic";
import { Bus } from "../bus";
import { pyJson, seatMap, type Seat } from "../registry";
import { acquirePathLock } from "../panelock";
import {
  flipMarkerState,
  globalRegistryPath,
  enrollmentAt,
  legacyTeamsPath,
  loadGlobalRegistry,
  type FlipState,
} from "../index-home";
import { oldBusRefusal, requireResolvedBus, resolveBus, repoRoot, type BusRule } from "../bushome";
import { PYTHON_SPACE } from "../terminal-text";
import { metaBytes, parseJsonPreserving, pyInt } from "../spool-publication";
import { writeIndexSnapshot } from "../index-snapshot";
import { shellQuote } from "../slices/message-construction";
import { backlogThresholds, spoolBacklogs } from "../spool-backlog";
import { busHomeForEnrolled, selectCaller } from "../selector";
import { isOldStoreRefusal, oldStoreAction, oldStoreRefusalText, teamRegistryRefusal } from "../register-authority";
import { readRegistry, observe, observedRows } from "./team";
import { cmdRefresh } from "./refresh";
import { notificationAvailability } from "../notifications";
import { injectionFaultOrRefuse } from "./injection-fault";
import { feedbackCardFault } from "../injection-behavior";
import { crewLifetimeHealth } from "../crew-lifetime";
import { noAgentRecovery, recordedWithoutAgent } from "../observe";
import { observePaneResult, ServerUnresponsive, tmuxReadOnly } from "../tmux";
import { seatIsRelaunchable } from "../launcher/complete";
import { HARNESSES, resolveHarnessPolicy } from "../launcher/catalog";
import { Notices } from "../launcher/catalog-notices";
import { PERMISSION_HARNESSES } from "../launcher/permissions";
import { recordFromRow } from "../launcher/transaction";
import { recordHasResumeArtifact } from "../launcher/resume-identity";
import { agyIdentityHookSpec } from "../install-manifest";
import { agyConversationStore, agyRootStatus } from "../agy-conversation";
import { cmdSeatDoctor } from "./doctor-seat";

const ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_PAYLOAD_FIELDS = ["id", "from", "to", "kind", "path"];
const QUARANTINE_WITHDRAWABLE = "did not match launcher expectation";
const STUCK_AFTER_SECONDS = 1800;
// Python re-whitespace (chr(c).isspace(), 29 code points) — the canonical
// PYTHON_SPACE class the native parity readers export, not JavaScript's \s.
const PY_WHITESPACE_RE = new RegExp(`[${PYTHON_SPACE}]`, "u");

export interface Finding {
  severity: "info" | "warning" | "error";
  name: string;
  detail: Record<string, unknown>;
  problem: string;
  next?: string;
  attention?: boolean;
  verboseLines?: string[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function git(root: string, args: string): string | null {
  const run = spawnSync("git", ["-C", root, ...args.split(" ").filter(Boolean)], {
    encoding: "utf8",
    timeout: 5000,
  });
  return run.status === 0 ? (run.stdout ?? "").trim() : null;
}

// realpath that tolerates nonexistent tails (Python os.path.realpath is
// lexical there): resolve the longest existing prefix, append the rest.
function lexicalRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // fall through to the prefix walk
  }
  const parts = p.split("/");
  for (let i = parts.length - 1; i >= 2; i -= 1) {
    const prefix = parts.slice(0, i).join("/");
    try {
      return realpathSync(prefix) + "/" + parts.slice(i).join("/");
    } catch {
      // try a shorter prefix
    }
  }
  return p;
}

function selectedSocket(env: NodeJS.ProcessEnv): string {
  const raw = env.TAP_TMUX_SOCKET_PATH || (!env.TAP_TMUX_SOCKET && env.TMUX
    ? env.TMUX.split(",")[0] ?? ""
    : join(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, env.TAP_TMUX_SOCKET || "default"));
  return lexicalRealpath(raw);
}

/** Minimal frontmatter reader: `---` fenced `key: value` head lines. */
function frontmatter(raw: string): { fields: Record<string, string>; error?: string } {
  // Incumbent parity: no BOM tolerance — a byte-order mark means the first
  // line is not exactly `---`, so the payload is torn.
  const lines = raw.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return { fields: {}, error: "no opening frontmatter fence" };
  const fields: Record<string, string> = {};
  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (line === "---") {
      closed = true;
      break;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const value = line.slice(idx + 1);
    if (/^[ \t]/.test(value)) fields[line.slice(0, idx)] = value.replace(/^[ \t]+/g, "");
  }
  if (!closed) return { fields: {}, error: "no closing frontmatter fence" };
  return { fields };
}

// Python glob("*.md") parity: leading-dot names are ALWAYS excluded; only the
// leading-underscore exclusion is conditional. Payload enumeration keeps both
// exclusions; the input-backup and watch-log scans pass includeUnderscore
// (the retired globs inventoried _draft.md/_prompt.md).
function listMd(dir: string, includeUnderscore = false): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".md") && !n.startsWith(".") && (includeUnderscore || !n.startsWith("_")))
      .sort();
  } catch {
    return [];
  }
}

function readJsonFile(path: string): { missing: true } | { value: unknown } | { error: string } {
  // A shared diagnostic input is a FILE: a FIFO or directory must not block
  // readFileSync (os.path.isfile parity, symlink-following). Missing stays
  // missing; anything non-regular is unreadable.
  try {
    if (!statSync(path).isFile()) return { error: "not a regular file" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { error: String(e) };
  }
  let raw: string;
  try {
    // ignoreBOM preserves a leading U+FEFF in the decoded text so JSON.parse
    // rejects it, matching Python json.load (the established reader pattern).
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { error: String(e) };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch (e) {
    return { error: String(e) };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function cmdDoctor(argv: string[], scriptsDir: string): number | Promise<number> {
  const delimiter = argv.indexOf("--");
  let json = argv.slice(0, delimiter < 0 ? argv.length : delimiter).includes("--json");
  if (json) process.env.TAP_JSON = "1";
  let handle = "", positional = false;
  let pruneInputBackups = false;
  let pruneWatchLogs = false;
  let fix = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg) throw new TapError(1, "usage_error", "tap help doctor", "a seat handle must not be empty");
    if (!positional && arg === "--") { positional = true; continue; }
    if (positional) {
      if (handle) throw new TapError(1, "usage_error", "tap help doctor", `unexpected arg '${arg}'`);
      handle = arg;
    } else if (arg === "--json") {
      json = true;
      process.env.TAP_JSON = "1";
    } else if (arg === "--prune-input-backups") pruneInputBackups = true;
    else if (arg === "--prune-watch-logs") pruneWatchLogs = true;
    else if (arg === "--fix") fix = true;
    else if (arg.startsWith("--")) {
      throw new TapError(1, "unknown_option", "tap help doctor", `unknown option '${arg}'`);
    } else if (!handle) {
      handle = arg;
    } else {
      throw new TapError(1, "usage_error", "tap help doctor", `unexpected arg '${arg}'`);
    }
  }
  if (handle) {
    if (fix || pruneInputBackups || pruneWatchLogs) throw new TapError(1, "usage_error", "tap help doctor", "a seat handle cannot be combined with --fix or prune options");
    return cmdSeatDoctor(handle, json, scriptsDir);
  }
  if (fix && (pruneInputBackups || pruneWatchLogs)) {
    throw new TapError(
      1,
      "usage_error",
      "run the prune and fix operations separately",
      "--fix cannot be combined with doctor prune options",
    );
  }

  // tap-0y4u: doctor diagnoses the selected bus, so a GENUINELY unenrolled
  // cwd is refused before anything is read or materialized — no ensureDirs,
  // ever. Only genuine absence is unanchored_bus: an invalid marker or an
  // enrolled-but-unreachable root proceeds to its existing authority findings
  // and remedies. Explicit TAP_HOME (env) and dotdir/legacy buses are grounded
  // by existing.
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const { home: busHome, rule } = resolveBus(root, process.env);
  if (rule === "default" && enrollmentAt(root).status === "missing") {
    throw new TapError(
      4,
      "unanchored_bus",
      "run tap init in your project to enroll it (git init first if it is not a repository), or set TAP_HOME to an existing bus directory",
      `cwd-derived default bus is not grounded; name a bus with TAP_HOME or run from an enrolled checkout (${root})`,
    );
  }
  const bus = new Bus(busHome);
  const payloadsDir = bus.payloadsDir;
  const receiptsDir = bus.receiptsDir;
  const spoolDir = join(busHome, "spool");
  const inputBackupsDir = join(busHome, "input-backups");
  const watchLogsDir = join(busHome, "watch", "evaluator-prompts");

  const findings: Finding[] = [];
  let authority: string | null = rule === "old_store" ? "old_store" : null;
  // Incumbent human order: authority/migration preludes render on stdout in
  // finish(), after the bus header and before the installation line. Collected
  // during classification; never flushed in JSON mode or on the --fix early
  // return.
  const preludes: string[] = [];
  if (rule === "old_store") findings.push(oldStoreFinding(oldBusRefusal(busHome)));

  // Flip marker authority. Authority findings never stop the run: the
  // incumbent recorded the exit and let every safe scan continue. In JSON
  // mode the finding joins the report; in human mode the ERROR line prints
  // immediately (the incumbent bash printed it) and is not repeated.
  const flip: FlipState = flipMarkerState();
  let withRegistry = true;
  if (flip === "invalid") {
    authority = "invalid_flip";
    const problem =
      "ERROR: global-registry.json is present but unreadable or wrong schema (invalid_flip); next: repair the marker in place (do not remove it after a real cutover — removal re-enables bus decoys), then tap doctor";
    if (json) {
      findings.push({
        severity: "error",
        name: "invalid_flip",
        detail: {
          error_class: "invalid_flip",
          action: "tap doctor",
          detail:
            "global-registry.json is present but unreadable or wrong schema — repair in place; do not remove after a real cutover",
        },
        problem,
      });
    } else {
      preludes.push(`tap doctor: ${problem.replace(/^ERROR: /, "")}`);
    }
  }
  if (flip === "absent" && existsSync(legacyTeamsPath())) {
    if (!json) {
      preludes.push(`tap doctor: ${oldStoreRefusalText(legacyTeamsPath(), "legacy_teams_json")}; next: ${oldStoreAction("legacy_teams_json")}`);
    }
  }

  // Acting registry under a live marker; unreachable is a finding, not a refusal.
  let registryPath = join(busHome, "registry.json");
  if (flip === "live") {
    const acting = actingRegistryFor(cwd, busHome, rule);
    if (acting.ok) {
      registryPath = acting.path;
    } else if (acting.oldStore) {
      withRegistry = false;
      const finding = oldStoreFinding(acting.oldStore);
      if (json && rule !== "old_store") findings.push(finding);
      else preludes.push(`tap doctor: ${acting.oldStore.detail}; next: ${acting.oldStore.action}`);
    } else {
      authority = "acting_registry_unreachable";
      withRegistry = false;
      const reset = readJsonFile(join(busHome, "reset-generation.json"));
      const door = "value" in reset && isRecord(reset.value) && reset.value.state === "pristine" ? "reset" : "lost";
      const problem =
        door === "reset"
          ? "ERROR: acting team-registry unreachable after deliberate reset (acting_registry_unreachable); next: tap init — do not restore (that undoes the reset); do not scan the bus mirror"
          : "ERROR: acting team-registry unreachable under live flip marker (acting_registry_unreachable); next: tap init to recreate a blank registry — do not scan the bus mirror";
      if (json) {
        const detailText =
          door === "reset"
            ? "acting team-registry unreachable after deliberate reset — next: tap init (do not restore; that undoes the reset)"
            : "acting team-registry unreachable under live flip marker — next: tap init to recreate a blank registry; refuse bus decoy scan";
        findings.push({
          severity: "error",
          name: "acting_registry_unreachable",
          detail: { error_class: "acting_registry_unreachable", action: "tap init", detail: detailText, door },
          problem,
        });
      } else {
        preludes.push(`tap doctor: ${problem.replace(/^ERROR: /, "")}`);
      }
    }
  }

  // --fix: prune dangling index rows, then compose the native team refresh.
  if (fix) {
    requireResolvedBus({ home: busHome, rule });
    pruneDanglingTeams(json);
    return cmdRefreshFor(json, scriptsDir);
  }

  const installation = installLine();
  try {
    const detail = notificationAvailability(process.env);
    findings.push({ severity: detail.available ? "info" : "warning", name: "notifier", detail,
      problem: `notifier=${detail.notifier} source=${detail.source} executable=${detail.requested} available=${detail.available}; ${detail.limitation}`,
      ...(detail.available ? {} : { next: "tap help escalate" }) });
  } catch (error) {
    findings.push({ severity: "warning", name: "notifier", detail: { available: false,
      error_class: error instanceof TapError ? error.errorClass : "notify_config_invalid", detail: String(error) },
      problem: `notifier unavailable: ${error instanceof Error ? error.message : error}`, next: "tap help escalate" });
  }

  // Delivery refuses an invalid injection.behavior with no pane effect; surface
  // the same refusal here so a stalled delivery is diagnosable.
  const injectionFault = injectionFaultOrRefuse(process.env);
  if (injectionFault) {
    findings.push({ severity: "warning", name: "injection_behavior",
      detail: { error_class: "injection_behavior_invalid", detail: injectionFault },
      problem: `delivery is refused until config.toml is fixed: ${injectionFault}` });
  }
  // An unusable injection.feedback_card fails safe: the courier holds at a Claude
  // feedback card instead of dismissing it (tap-89a57).
  let cardFault: string | null = null;
  try { cardFault = feedbackCardFault(process.env); } catch { /* unreadable config is the finding above */ }
  if (cardFault) {
    findings.push({ severity: "warning", name: "feedback_card",
      detail: { error_class: "feedback_card_invalid", detail: cardFault },
      problem: `delivery holds at Claude feedback cards instead of dismissing them until config.toml is fixed: ${cardFault}` });
  }

  // Checkout freshness (tap-3ywn). The checkout under diagnosis is the tap
  // checkout the running verb belongs to; TAP_CHECKOUT_ROOT overrides for
  // fixtures. Never flips the exit.
  const checkoutRoot = process.env.TAP_CHECKOUT_ROOT || realpathSafe(scriptsDir, "../../..");
  // A release artifact (tap-7r3fn.192) is not a checkout: report the release it
  // came from instead of a CANNOT-CHECK with a clone-oriented next step.
  const release = releaseMarker(checkoutRoot);
  const co = release ? null : checkoutFinding(checkoutRoot);
  if (release) {
    findings.push({
      severity: "info",
      name: "release",
      detail: release,
      problem: `release ${release.version} (source ${release.commit.slice(0, 12)}, ${release.platform}, bun ${release.bun}) at ${checkoutRoot}`,
    });
  }
  if (co) {
    findings.push({
      severity: "warning",
      name: "checkout_freshness",
      detail: { status: co.status, problem: co.problem, next: co.next },
      problem: co.problem,
      next: co.next,
    });
  }

  // Scan order mirrors the incumbent. Registry-dependent scans are skipped
  // only under acting_registry_unreachable; everything else still runs.
  // An old store is reported once; its rows never feed the startup, unbound, tmux or Codex scans.
  const recoveryRoot = teamRootFromBus(busHome);
  if (scanRegistry(registryPath, findings, withRegistry, recoveryRoot)) withRegistry = false;
  if (withRegistry) scanAgyIdentityHook(registryPath, findings, process.env, checkoutRoot);
  const liveElsewhere = new Map<string, string>();
  scanStartup(registryPath, findings, withRegistry, liveElsewhere, recoveryRoot);
  // A wrong socket can leave a live seat stored as suspended. Reconcile the
  // earlier registry/startup advice with the complete alternate-server evidence.
  for (const finding of findings) {
    const socket = liveElsewhere.get(str(finding.detail.handle));
    if (!socket || !["suspended_agent", "retained_resume_failure"].includes(finding.name)) continue;
    const next = `export TAP_TMUX_SOCKET_PATH=${shellQuote(socket)}`;
    finding.next = next;
    finding.detail.next = next;
  }
  if (withRegistry) scanCrewSupervision(registryPath, findings);
  if (withRegistry) scanSeatHealth(registryPath, scriptsDir, findings, liveElsewhere, recoveryRoot);
  scanDanglingIndex(findings);
  scanTmuxServers(registryPath, findings, process.env, withRegistry);
  scanTmuxClientHazards(findings, process.env);
  if (withRegistry) scanCodexSeats(registryPath, findings, process.env);
  scanInputBackups(inputBackupsDir, pruneInputBackups, findings);
  scanWatchLogs(watchLogsDir, pruneWatchLogs, findings);
  scanSpool(spoolDir, findings);
  const { torn, unattributed } = scanPayloads(payloadsDir, receiptsDir, findings);

  return finish(findings, { busHome, rule, json, verbose: process.env.TAP_VERBOSE === "1", authority, torn, unattributed, installation, preludes });
}

function realpathSafe(base: string, rel: string): string {
  try {
    return realpathSync(join(base, rel));
  } catch {
    return join(base, rel);
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

type OldStoreFinding = { errorClass: string; action: string; detail: string };

function oldStoreFinding(refusal: OldStoreFinding): Finding {
  return {
    severity: "error",
    name: "old_store",
    detail: { error_class: "old_store", action: refusal.action, detail: refusal.detail },
    problem: `ERROR: ${refusal.detail} (old_store)`,
    next: refusal.action,
  };
}

function actingRegistryFor(cwd: string, busHome: string, rule: BusRule): { ok: true; path: string } | { ok: false; oldStore?: OldStoreFinding } {
  // An explicit custom TAP_HOME remains a supported registry-less scratch bus,
  // even when cwd belongs to an enrolled team. If the named bus is that team's
  // real bus, use its acting registry; never mix the cwd registry with another bus.
  if (rule === "env") {
    // The FULL explicit home is normalized lexically (Node resolve) before
    // classification: aliases ending in `/.`, `/..` mixes, or repeated
    // separators of a MISSING canonical home must not dodge the fail-closed
    // path (resolved()/realpath only normalizes homes that already exist).
    const canonicalCandidate = resolve(busHome);
    if (!canonicalCandidate.endsWith("/.tap/bus")) {
      return { ok: true, path: join(busHome, "registry.json") };
    }
    // A canonical explicit home (…/.tap/bus) is that root's team
    // bus: a live marker that does not cleanly enroll the root fails closed —
    // missing/invalid/unreachable/ambiguous all refuse. Enrollment is
    // re-sampled here, so a marker disappearing between samples fails closed
    // too. Only noncanonical explicit homes keep the scratch exception.
    const at = enrollmentAt(teamRootFromBus(canonicalCandidate));
    if (at.status !== "ok") return { ok: false };
    if (canonicalPath(busHome) !== canonicalPath(busHomeForEnrolled(at.rootReal))) return { ok: false };
    return { ok: true, path: at.registryLocation };
  }
  // Under a live marker, an implicit canonical bus (dotdir) is that
  // root's team bus, exactly like an explicit canonical home: a live marker
  // that does not cleanly enroll the root — with an existing acting
  // registry — fails closed. A stale bus mirror is never scanned.
  if (rule === "old_store") return { ok: false, oldStore: oldBusRefusal(busHome) };
  if (rule === "dotdir") {
    const at = enrollmentAt(teamRootFromBus(busHome));
    if (at.status !== "ok") return { ok: false };
    if (!existsSync(at.registryLocation)) return { ok: false };
    if (canonicalPath(busHome) !== canonicalPath(busHomeForEnrolled(at.rootReal))) return { ok: false };
    return { ok: true, path: at.registryLocation };
  }
  try {
    const selection = selectCaller({ cwd, env: process.env });
    if (selection.registryLocation && existsSync(selection.registryLocation)) {
      return { ok: true, path: selection.registryLocation };
    }
    return { ok: false };
  } catch (error) {
    // An old-format acting registry is a named finding, never "unreachable".
    if (isOldStoreRefusal(error)) return { ok: false, oldStore: error as OldStoreFinding };
    return { ok: false };
  }
}

function installLine(): Record<string, unknown> {
  const entry = Bun.which("tap");
  let installedReal: string | null = null;
  try {
    installedReal = entry ? realpathSync(entry) : null;
  } catch {
    installedReal = entry;
  }
  const head = installedReal ? git(dirname(installedReal), "rev-parse HEAD") : null;
  return {
    tap: { entry, resolved: installedReal, head },
  };
}

function scanAgyIdentityHook(registryPath: string, findings: Finding[], env: NodeJS.ProcessEnv, checkout: string): void {
  const registry = readJsonFile(registryPath);
  if (!("value" in registry) || !isRecord(registry.value) || !isRecord(registry.value.seats)
    || !Object.values(registry.value.seats).some(row => isRecord(row) && row.harness === "agy"
      && row.delivery !== "poll" && row.status !== "historical")) return;
  // An empty exact-id lookup checks readability/schema without selecting an id.
  const store = agyRootStatus("", env);
  if (store.kind === "unavailable") findings.push({ severity: "warning", name: "agy_identity_store",
    detail: { status: store.kind, path: agyConversationStore(env), reason: store.detail },
    problem: `Antigravity native identity store is unavailable: ${store.detail}; new identity capture is refused`,
    next: "start agy and submit a turn; if this persists, check its conversation_summaries.db permissions and schema" });
  const home = env.HOME || "";
  const configured = env.TAP_GEMINI_HOME || env.GEMINI_HOME || join(home, ".gemini");
  const gemini = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
  const path = join(gemini, "config/hooks.json");
  let status = "missing";
  try {
    if (existsSync(path)) {
      const data = statSync(path).isFile() ? JSON.parse(readFileSync(path, "utf8")) : null;
      const hook = isRecord(data) ? data["tap-session-identity"] : null;
      const expected = agyIdentityHookSpec(join(checkout, "hooks/tap-agy-identity.sh"));
      if (!isRecord(data)) status = "invalid";
      else if (isRecord(hook) && hook.enabled === false) status = "disabled";
      else if (isRecord(hook)) {
        const wired = Object.entries(expected).every(([event, handlers]) => {
          const rows = hook[event], handler = handlers[0]!;
          return Array.isArray(rows) && rows.some(item => isRecord(item)
            && item.command === handler.command && (item.type === undefined || item.type === "command")
            && typeof item.timeout === "number" && item.timeout > 0 && item.timeout <= handler.timeout);
        });
        if (wired && existsSync(join(checkout, "hooks/tap-agy-identity.sh"))) return;
        status = "stale";
      }
    }
  } catch { status = "unreadable"; }
  findings.push({ severity: "warning", name: "agy_identity_hook", detail: { status, path },
    problem: `Antigravity native identity hook is ${status}; conversation ids may be absent or stale`,
    next: `bash ${shellQuote(join(checkout, "install.sh"))} --sync; then submit a turn in the agy seat` });
}

/** The artifact's tap-release.json, when the root holds a readable one. */
function releaseMarker(root: string): { version: string; commit: string; platform: string; bun: string } | null {
  try {
    const marker = JSON.parse(readFileSync(join(root, "tap-release.json"), "utf8"));
    const fields = [marker.version, marker.commit, marker.platform, marker.bun];
    return fields.every(field => typeof field === "string" && field !== "") ? { version: marker.version, commit: marker.commit, platform: marker.platform, bun: marker.bun } : null;
  } catch {
    return null;
  }
}

function checkoutFinding(root: string): { status: string; problem: string; next: string } | null {
  const inside = git(root, "rev-parse --is-inside-work-tree");
  if (inside !== "true") {
    return {
      status: "cannot_check",
      problem: `checkout CANNOT-CHECK — ${root} is not a git checkout (absence is not live)`,
      next: "run tap from the persistent primary git checkout",
    };
  }
  const origin = git(root, "rev-parse --verify origin/main");
  if (origin === null) {
    return {
      status: "cannot_check",
      problem: `checkout CANNOT-CHECK — origin/main ref is missing in ${root}; live tap may be running old code`,
      next: `git -C ${root} fetch origin main`,
    };
  }
  const ancestor = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", "origin/main", "HEAD"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (ancestor.status === 0) return null;
  if (ancestor.status === 1) {
    const short = (git(root, "rev-parse --short origin/main") ?? "").slice(0, 9);
    const head = (git(root, "rev-parse --short HEAD") ?? "").slice(0, 9);
    return {
      status: "stale",
      problem: `checkout STALE — origin/main (${short}) is not an ancestor of HEAD (${head}); live tap still runs old code`,
      next: `bash ${root}/install.sh --sync`,
    };
  }
  return {
    status: "cannot_check",
    problem: `checkout CANNOT-CHECK — could not compare HEAD to origin/main in ${root}`,
    next: "retry; if a git lock is held, wait and re-run",
  };
}

function seatRecovery(handle: string, seat: unknown, team: unknown, root: string, registryPath: string): string {
  if (isRecord(seat) && (seat.crew === true || seat.crew === 1)) {
    const preset = isRecord(seat.preset) ? str(seat.preset.name) : "";
    const manual = `preserve the stored launch recipe for ${shellQuote(handle)} before removing its row: less ${shellQuote(registryPath)}; then tap help crew`;
    // A preset replays its own env/options. A plain add cannot replay these
    // explicit fields or override permissions; never print secret env values.
    if (!preset && ((isRecord(seat.harness_env) && Object.keys(seat.harness_env).length > 0)
      || (Array.isArray(seat.passthrough) && seat.passthrough.length > 0))) return manual;
    // Typed --env keys, --unset-env keys and -- arguments sit on top of any preset.
    if (["harness_env_set", "harness_unset_env", "harness_tail"].some(key => Array.isArray(seat[key]) && (seat[key] as unknown[]).length > 0)) return manual;
    if (seat.permissions !== undefined && seat.permissions !== null) {
      try {
        const permissions = PERMISSION_HARNESSES.includes(str(seat.harness))
          ? resolveHarnessPolicy(str(seat.harness), process.env, new Notices(() => {})).permissions : "bypass";
        if (seat.permissions !== permissions) return manual;
      } catch { return manual; }
    }
    const cwd = str(seat.cwd) || str(seat.launch_workdir) || str(seat.registered_from_worktree)
      || (isRecord(team) ? str(team.worktree_root) : "") || root;
    const location = ` --cwd ${shellQuote(cwd)}`;
    if (preset) return `tap team refresh, then tap crew add ${shellQuote(preset)} ${shellQuote(handle)}${location}`;
    const model = str(seat.model) ? shellQuote(str(seat.model)) : "<model>";
    return HARNESSES.includes(str(seat.harness))
      ? `tap team refresh, then tap crew add ${shellQuote(str(seat.harness))} ${shellQuote(handle)} --model ${model}${location}`
      : "tap help crew";
  }
  if (isRecord(seat) && seatIsRelaunchable(seat, true) && str(seat.session) && HARNESSES.includes(str(seat.harness))) {
    if (seat.harness === "cursor" && str(seat.harness_session_id)) {
      const record = recordFromRow(handle, seat, isRecord(team) ? team : {}, root);
      if (record && !recordHasResumeArtifact(record)) return `tap session launch cursor ${shellQuote(handle)} --fresh`;
    }
    return `tap session resume ${shellQuote(handle)}`;
  }
  // The row names a shell or TAP's own runtime, not an agent: registering it
  // again from the same place records the same thing.
  if (isRecord(seat) && recordedWithoutAgent(str(seat.harness))) return noAgentRecovery(handle);
  return `tap register ${shellQuote(handle)} --pane <new-target>`;
}

/** Returns true when the registry is an old format, so the caller skips every other row read. */
function scanRegistry(registryPath: string, findings: Finding[], withRegistry: boolean, root: string): boolean {
  if (!withRegistry) return false;
  let doc: Record<string, unknown>;
  const read = readJsonFile(registryPath);
  if ("missing" in read) {
    findings.push({
      severity: "warning",
      name: "no_registry",
      detail: { path: registryPath },
      problem: "warning: no registry.json found",
      next: "tap register <name> to create one",
    });
    return false;
  }
  if ("error" in read || !isRecord(read.value)) {
    const error = "error" in read ? read.error : "registry.json is not a JSON object";
    findings.push({
      severity: "warning",
      name: "registry_unreadable",
      detail: { error },
      problem: `warning: could not read registry.json (${error})`,
    });
    return false;
  }
  doc = read.value;
  // An old-format registry is reported once by name; its rows are not read as seats.
  const oldStore = teamRegistryRefusal(registryPath, doc);
  if (oldStore) {
    findings.push(oldStoreFinding(oldStore));
    return true;
  }
  if (!isRecord(doc.team)) {
    findings.push({
      severity: "warning",
      name: "registry_no_team",
      detail: {},
      problem: "warning: registry has no team provenance block (legacy schema)",
      next: "re-register to add provenance",
    });
  }
  const seats = seatMap(doc);
  for (const handle of Object.keys(seats).sort()) {
    const seat = seats[handle];
    if (!seat) continue;
    if (seat.status === undefined) {
      findings.push({
        severity: "warning",
        name: "registry_legacy_entry",
        detail: { handle },
        problem: `warning: registry entry '${handle}' has no status field (legacy entry)`,
        next: "re-register to upgrade provenance",
      });
    }
    if (seat.status === "suspended") {
      const reason = str(seat.status_reason) || "unknown";
      const next = seatRecovery(handle, seat, doc.team, root, registryPath);
      findings.push({
        severity: "warning",
        name: "suspended_agent",
        attention: true,
        detail: { handle, reason, next },
        problem: `attention: suspended agent '${handle}'  reason: ${reason}`,
        next,
      });
    }
    const capture = seat.identity_capture_result;
    if (isRecord(capture) && capture.decision === "quarantined") {
      const expected = str(capture.expected_harness_session_id);
      const observed = str(capture.observed_harness_session_id) || "(none reported)";
      const reason = str(seat.identity_quarantine_reason) || str(capture.reason);
      const withdrawable = reason.includes(QUARANTINE_WITHDRAWABLE);
      let next: string;
      if (withdrawable && observed === "(none reported)") {
        // tap-386g: --accept-observed-identity refuses when no id was ever
        // observed, so recommending it would send the operator into a wall.
        next = "waiting on the seat to report an id; the verb will work once it does";
      } else if (withdrawable) {
        next = `if that pane really is ${handle}: tap register ${handle} --accept-observed-identity  (do NOT use tap out/tap in — it clears this by deleting the seat row)`;
      } else {
        const standing = expected ? `  (expectation ${expected} is standing too)` : "";
        next = `no verb withdraws this one — it is not the launcher's question, so --accept-observed-identity will not clear it; resolve what the reason names (the other seat's claim on that id, or the resume binding) and let the seat re-register${standing}`;
      }
      findings.push({
        severity: "warning",
        name: "identity_quarantine_standing",
        attention: true,
        detail: { handle, expected: expected || "(none recorded)", observed, reason },
        problem: `attention: seat '${handle}' has a standing identity quarantine  expected: ${expected}  observed: ${observed}${reason ? `  reason: ${reason}` : ""}`,
        next,
      });
    }
  }
  return false;
}

function scanCrewSupervision(registryPath: string, findings: Finding[]): void {
  const read = readJsonFile(registryPath);
  if (!("value" in read) || !isRecord(read.value)) return;
  try {
    const socket = tmuxReadOnly(["display-message", "-p", "#{socket_path}"]);
    if (socket.code !== 0) return;
    const currentSocket = socket.stdout.trim();
    for (const [handle, row] of Object.entries(seatMap(read.value))) {
      if ((row.crew !== true && row.crew !== 1) || !/^%\d+$/.test(str(row.pane_id)) ||
        (str(row.server_socket) && str(row.server_socket) !== currentSocket)) continue;
      const pane = observePaneResult(str(row.pane_id));
      if (pane.status !== "ok" || pane.observation.session !== str(row.session)) continue;
      if (crewLifetimeHealth(str(row.pane_id)) !== "legacy_supervised") continue;
      const next = "tap team refresh";
      findings.push({ severity: "warning", name: "crew_legacy_lifetime", detail: { handle, pane_id: row.pane_id },
        problem: `crew '${handle}' still has pre-upgrade parent-bound lifetime`, next });
    }
  } catch (error) {
    if (!(error instanceof ServerUnresponsive)) throw error;
    // The independent server scan reports the deadline; supervision is unknown.
  }
}

function scanStartup(registryPath: string, findings: Finding[], withRegistry: boolean, liveElsewhere: Map<string, string>, root: string): void {
  // Native equivalent of startup_trace.py diagnose(): retained resume
  // failures from the registry, plus the registry-independent tmux probes.
  if (withRegistry) {
    const read = readJsonFile(registryPath);
    if ("value" in read && isRecord(read.value)) {
      const seats = seatMap(read.value);
      const logPath = join(process.env.TAP_INDEX_HOME || join((process.env.HOME ?? ""), ".tap"), "logs", "startup.jsonl");
      const rowKeys = [
        "status", "status_reason", "delivery", "session", "harness", "harness_session_id",
        "transcript_path", "registered_from_worktree", "instance", "pane", "pane_id",
        "boot_id", "server_epoch",
      ];
      for (const handle of Object.keys(seats).sort()) {
        const row = seats[handle];
        if (!row) continue;
        const reason = str(row.status_reason);
        if (
          row.status === "suspended" &&
          str(row.delivery) !== "poll" &&
          !row.crew &&
          ["pane_gone", "session_replaced", "repair_failed", "restart_failed"].includes(reason) &&
          (str(row.session) && str(row.harness))
        ) {
          const state: Record<string, unknown> = {};
          const envSecrets = secretEnvValues();
          for (const k of rowKeys) if (row[k] !== undefined) state[k] = cleanRetained(row[k], 0, envSecrets);
          const next = seatRecovery(handle, row, read.value.team, root, registryPath);
          findings.push({
            severity: "info",
            name: "retained_resume_failure",
            detail: { handle, state, trace: logPath, next },
            problem: `seat '${handle}' retains its conversation after suspended/${reason}`,
            next,
          });
        }
      }
    }
  }
  startupTmuxProbes(findings, process.env, registryPath, withRegistry, liveElsewhere);
}

function startupTmuxProbes(findings: Finding[], env: NodeJS.ProcessEnv, registryPath: string, withRegistry: boolean, liveElsewhere: Map<string, string>): void {
  // startup_trace.py socket_path() parity.
  const trace = join(env.TAP_INDEX_HOME || join(env.HOME ?? "", ".tap"), "logs", "startup.jsonl");
  const socket = selectedSocket(env);
  const probe = spawnSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}\t#{exit-empty}\t#{exit-unattached}"], {
    encoding: "utf8",
    timeout: 2000,
  });
  // Only a completed, non-timeout failure can classify as offline; a probe
  // that errored or timed out (even with partial output) is unknown.
  if (probe.status !== null && probe.status !== 0 && /no server running|No such file or directory/i.test(probe.stderr ?? "")) {
    const next = "tap session resume <seat>";
    findings.push({
      severity: "info",
      name: "tmux_offline",
      detail: { socket, trace, next },
      problem: "tmux is offline; retained seats can be resumed after a reboot",
      next,
    });
    // Resume advice would launch a duplicate while the seats live elsewhere:
    // the mismatch finding replaces the offline one.
    if (scanSocketMismatch(findings, env, socket, "offline", registryPath, withRegistry, liveElsewhere)) {
      const at = findings.findIndex((f) => f.name === "tmux_offline");
      if (at >= 0) findings.splice(at, 1);
    }
    return;
  }
  if (probe.status !== 0) return;
  const parts = (probe.stdout ?? "").trim().split("\t");
  const pid = parts[0] ?? "";
  const exitEmpty = parts[1] ?? "";
  const exitUnattached = parts[2] ?? "";
  if (exitEmpty === "on") {
    const next = "no recovery needed while sessions are running";
    findings.push({
      severity: "info",
      name: "tmux_exit_empty",
      detail: { pid, socket, next },
      problem: "tmux exits when its last session closes",
      next,
    });
  }
  if (exitEmpty === "off") {
    findings.push({
      severity: "info",
      name: "tmux_persistent_server",
      detail: { pid, socket, exit_empty: "off", behavior: "server stays alive after its last session closes", next: "no action needed" },
      problem: "tmux has exit-empty off: the server stays alive after its last session closes; TAP sets this when starting a server",
      next: "no action needed",
    });
  }
  if (exitUnattached === "on") {
    const next = `tmux -S ${shellQuote(socket)} set-option -s exit-unattached off`;
    findings.push({
      severity: "warning",
      name: "tmux_exit_unattached",
      detail: { pid, socket, next },
      problem: "tmux exit-unattached is on: every detached launch (new-session -d) is killed as soon as it starts",
      next,
    });
  }
  if (!/^\d+$/.test(pid)) return;
  // A probe that fails or times out is unknown, never an empty server. Empty is
  // the established positive answer: a successful read with no rows, or the
  // exact `no current target` a live exit-empty-off server gives an empty
  // namespace (tmux 3.7c; see seat-stop's snapshot).
  const panes = spawnSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8", timeout: 2000 });
  const emptyServer = panes.status === 0
    ? (panes.stdout ?? "").trim() === ""
    : panes.status !== null && (panes.stderr ?? "").trim() === "no current target";
  if (emptyServer) {
    scanSocketMismatch(findings, env, socket, "empty", registryPath, withRegistry, liveElsewhere);
  }
  let cwd: string | null = null;
  if (process.platform === "linux") {
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = null;
    }
  } else {
    const lsof = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000 });
    for (const line of (lsof.stdout ?? "").split("\n")) {
      if (line.startsWith("n/")) {
        cwd = line.slice(1);
        break;
      }
    }
  }
  if (cwd && !isDir(cwd)) {
    const next = "restart tmux from your home directory after stopping its sessions";
    findings.push({
      severity: "info",
      name: "tmux_cwd_missing",
      detail: { pid, socket, cwd, next },
      problem: "tmux's working directory was deleted",
      next,
    });
  }
}

const MAX_ALT_SOCKETS = 12;

// TAP's resolved socket is positively offline or empty, yet the registry's seat
// sessions answer on another socket (a shell alias like `tmux -L dev`, or a
// different TMUX_TMPDIR): `tmux attach` cannot find them. Candidates are the
// sockets seats recorded plus those in the user's tmux socket directory. A seat
// that recorded its socket only counts on that socket; a legacy row without one
// matches by session name alone. Read-only and bounded: only list-sessions is
// issued, each probe is capped, and an alternate that fails to answer is
// unknown, never evidence. Unrelated sessions give no finding. Returns whether a
// mismatch was reported.
function scanSocketMismatch(
  findings: Finding[],
  env: NodeJS.ProcessEnv,
  socket: string,
  state: "offline" | "empty",
  registryPath: string,
  withRegistry: boolean,
  liveElsewhere: Map<string, string>,
): boolean {
  if (!withRegistry) return false;
  const read = readJsonFile(registryPath);
  if (!("value" in read) || !isRecord(read.value)) return false;
  const own = lexicalRealpath(socket);
  const bySession = new Map<string, Map<string, string>>();
  const recorded: string[] = [];
  for (const [handle, seat] of Object.entries(seatMap(read.value))) {
    const pane = str(seat.pane);
    const session = str(seat.session) || (pane.includes(":") ? (pane.split(":")[0] ?? "") : "");
    if (!session) continue;
    const rec = str(seat.server_socket);
    const key = rec.startsWith("/") ? lexicalRealpath(rec) : "";
    if (key && !recorded.includes(key)) recorded.push(key);
    const where = bySession.get(session) ?? new Map<string, string>();
    where.set(handle, key);
    bySession.set(session, where);
  }
  if (bySession.size === 0) return false;
  const candidates = [...recorded];
  const dir = join(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
  try {
    for (const name of readdirSync(dir).sort()) {
      const path = lexicalRealpath(join(dir, name));
      if (!candidates.includes(path)) candidates.push(path);
    }
  } catch {
    // No readable directory: recorded sockets alone remain.
  }
  let probed = 0;
  let reported = false;
  for (const path of candidates) {
    if (path === own) continue;
    try {
      if (!lstatSync(path).isSocket()) continue;
    } catch {
      continue;
    }
    if (probed >= MAX_ALT_SOCKETS) break;
    probed += 1;
    const run = spawnSync("tmux", ["-S", path, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 1000 });
    if (run.status !== 0) continue;
    const sessions = (run.stdout ?? "").split("\n").filter((l) => {
      const where = bySession.get(l);
      return where !== undefined && [...where.values()].some(key => !key || key === path);
    });
    if (sessions.length === 0) continue;
    // Recovery consumes every matching handle, not the five-session display sample.
    for (const session of sessions) {
      for (const [handle, key] of bySession.get(session)!) {
        if (!key || key === path) liveElsewhere.set(handle, path);
      }
    }
    const next = `export TAP_TMUX_SOCKET_PATH=${shellQuote(path)}`;
    findings.push({
      severity: "warning",
      name: "tmux_socket_mismatch",
      detail: { socket, state, alternate_socket: path, sessions: sessions.slice(0, 5), count: sessions.length, next },
      problem: `TAP's tmux socket ${socket} is ${state}, but ${sessions.length} TAP seat session(s) are on ${path} (${sessions.slice(0, 5).join(", ")}); tmux attach cannot see them from TAP's socket`,
      next,
    });
    reported = true;
  }
  return reported;
}

function scanSeatHealth(registryPath: string, scriptsDir: string, findings: Finding[], liveElsewhere: Map<string, string>, root: string): void {
  const read = readRegistry(registryPath, false, false);
  if (!read.ok || !read.rows) return;
  const census = observe(read.rows, scriptsDir);
  if (census.code !== 0) return;
  const orows = observedRows(read.rows, census.rows, census.serverEpoch, {}, selectedSocket(process.env));
  // The observation projection omits launch cwd/env; recovery needs the same
  // complete row the launcher uses to locate a Cursor conversation store.
  const raw = readJsonFile(registryPath);
  if (!("value" in raw) || !isRecord(raw.value)) return;
  const stored = seatMap(raw.value);
  for (const row of orows) {
    const seat = stored[row.handle];
    if (!seat || seat.status !== "active" || seat.status_reason === "launching" || row.delivery === "poll" || row.foreignNamespace || liveElsewhere.has(row.handle)) continue;
    const unavailable = row.status === "gone" || row.status === "offline";
    const bindingMissing = row.status === "unknown" && ["designated_pane_missing", "address_rebound"].includes(row.statusReason);
    // Failed probes stay unknown. A missing/rebound binding is a repair
    // finding, not evidence that it is safe to start another conversation.
    if (!unavailable && !bindingMissing) continue;
    const next = bindingMissing ? "tap team refresh" : seatRecovery(row.handle, seat, raw.value.team, root, registryPath);
    findings.push({
      severity: "warning", attention: true,
      name: bindingMissing ? "seat_binding_missing" : "seat_unavailable",
      detail: { handle: row.handle, status: row.status, reason: row.statusReason, next },
      problem: bindingMissing
        ? `registered active seat '${row.handle}' has an unresolved pane binding (${row.statusReason})`
        : `registered active seat '${row.handle}' is ${row.status} (${row.statusReason})`,
      next,
    });
  }
  const handles = orows.filter((r) => r.status === "unbound").map((r) => r.handle).sort();
  if (handles.length === 0) return;
  findings.push({
    severity: "warning",
    name: "seats_unbound",
    attention: true,
    detail: { count: handles.length, handles, next: "tap doctor --fix" },
    problem: `attention: ${handles.length} seats unbound: session alive, binding lost`,
    next: "tap doctor --fix (or: tap team refresh)",
  });
}

function scanDanglingIndex(findings: Finding[]): void {
  const snap = loadGlobalRegistry();
  // An invalid marker only reports its authority failure: no team rows are
  // read and no `tap doctor --fix` remedy is recommended against it.
  if (snap.marker !== "live") return;
  if (!isRecord(snap.doc)) return;
  const teams = snap.doc.teams;
  if (!isRecord(teams)) return;
  const dangling = Object.keys(teams).filter((team) => {
    const entry = teams[team];
    if (!isRecord(entry)) return false;
    if (str(entry.state) === "historical") return false;
    const root = str(entry.root);
    return root !== "" && !isDir(root);
  }).sort();
  if (dangling.length === 0) return;
  findings.push({
    severity: "warning",
    name: "dangling_index_teams",
    attention: true,
    detail: { count: dangling.length, teams: dangling, next: "tap doctor --fix" },
    problem: `attention: ${dangling.length} dangling team index rows: roots missing`,
    next: "tap doctor --fix",
  });
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  // os.path.isfile() parity: follows symlinks; a directory or FIFO is not one.
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Incumbent parity: startup_trace.py's clean() sanitized retained state
// before it was emitted. Secret-named environment entries and object keys use
// the incumbent key set; values from those entries are redacted wherever they
// occur, inline assignments are redacted, strings are bounded to 600
// characters and arrays to 20, and nothing unsupported serializes. Smallest
// local form; not a general sanitizer.
const SECRET_KEY_RE = /key|token|secret|password|passwd|credential|authorization/i;
// The retired sanitizer's full inline-assignment grammar: the NAME is any
// non-space run containing a keyword (`api_token_value=`, `password_hash:`),
// so suffixes cannot hide the value. No leading \b around the keyword itself.
const RETAINED_SECRET_ASSIGNMENT_RE = /(\b\S*(?:key|token|secret|password)\S*)(["']?\s*[=:]\s*)[^\s"']+/gi;
// Incumbent clean() dropped these keys outright.
const RETAINED_OMITTED_KEYS = new Set([
  "prompt", "initial_prompt", "argv", "shell_command", "harness_env", "passthrough",
]);

function secretEnvValues(): string[] {
  const values: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v && SECRET_KEY_RE.test(k)) values.push(v);
  }
  return values;
}

function cleanRetained(value: unknown, depth = 0, envSecrets: string[] = []): unknown {
  if (typeof value === "string") {
    let out = value;
    // Environment secret values are replaced before any bound applies.
    for (const secret of envSecrets) out = out.split(secret).join("<redacted>");
    out = out.replace(RETAINED_SECRET_ASSIGNMENT_RE, "$1$2<redacted>");
    return out.slice(0, 600);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => cleanRetained(v, depth + 1, envSecrets));
  if (typeof value === "object" && depth < 8) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RETAINED_OMITTED_KEYS.has(k)) continue;
      // A secret-named key redacts its whole value; it is not recursed.
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = cleanRetained(v, depth + 1, envSecrets);
    }
    return out;
  }
  return null;
}

/** lsof's command name for a tmux server: macOS reports `tmux`; Linux reports the title tmux sets, `tmux: server` (its clients are `tmux: client`). */
const isTmuxServerCommand = (command: string): boolean => command === "tmux" || command === "tmux: server";
/** A socket path as lsof names it: Linux appends the socket type (` type=STREAM`) to the path. */
const lsofSocketPath = (name: string): string => name.replace(/ type=[A-Z]+$/, "");

function scanTmuxServers(registryPath: string, findings: Finding[], env: NodeJS.ProcessEnv, withRegistry: boolean): void {
  const lsof = spawnSync("lsof", ["-nP", "-a", "-c", "tmux", "-U", "-Fpcn"], { encoding: "utf8", timeout: 5000 });
  if (lsof.status !== 0) return;
  const records = new Map<string, { command: string; sockets: Set<string> }>();
  let pid = "";
  for (const line of (lsof.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) {
      if (!/^\d+$/.test(line.slice(1))) continue;
      pid = line.slice(1);
    } else if (line.startsWith("c")) {
      if (!pid) continue;
      records.set(pid, { command: line.slice(1), sockets: new Set() });
    } else if (line.startsWith("n")) {
      if (!pid || !line.slice(1).startsWith("/")) continue;
      records.get(pid)?.sockets.add(lsofSocketPath(line.slice(1)));
    }
  }
  const live = [...records.entries()].filter(([, r]) => isTmuxServerCommand(r.command)).map(([p]) => p);
  const recorded = new Set<string>();
  if (withRegistry) {
    const read = readJsonFile(registryPath);
    if ("value" in read && isRecord(read.value)) {
      for (const seat of Object.values(seatMap(read.value))) {
        const m = str(seat.server_epoch).match(/^srv:(\d+):.+$/);
        if (m?.[1]) recorded.add(m[1]);
      }
    }
  }
  const intersected = live.filter((p) => recorded.has(p)).sort((a, b) => Number(a) - Number(b));
  const def = selectedSocket(env);
  const defReal = lexicalRealpath(def);
  if (withRegistry && intersected.length > 0) {
    const probe = spawnSync("tmux", ["-S", def, "display-message", "-p", "#{pid}"], { encoding: "utf8", timeout: 5000 });
    if (probe.status !== 0) {
      const ppids = spawnSync("ps", ["-axo", "ppid="], { encoding: "utf8", timeout: 5000 });
      const tokens = ppids.status === 0 ? (ppids.stdout ?? "").split("\n").map((l) => l.trim()) : [];
      for (const pidNum of intersected) {
        const panes = tokens.filter((t) => t === pidNum).length;
        findings.push({
          severity: "info",
          name: "server_unresponsive",
          detail: { pid: Number(pidNum), panes, socket: def },
          problem: `server_unresponsive pid ${pidNum} socket ${def} with ${panes} panes; responsive probe failed`,
        });
      }
    }
  }
  // Socket age is inventory, not liveness evidence. Keep this independent of
  // registry health and do not probe or change another server for the census.
  const sockets: { pid: number; socket: string; age_seconds: number }[] = [];
  for (const [pidNum, rec] of [...records.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
    if (!isTmuxServerCommand(rec.command)) continue;
    for (const socket of [...rec.sockets].sort()) {
      const socketReal = lexicalRealpath(socket);
      if (socketReal === defReal) continue;
      let ageSeconds: number;
      try {
        ageSeconds = Math.floor(Date.now() / 1000) - Math.floor(statSync(socketReal).mtimeMs / 1000);
      } catch {
        continue;
      }
      sockets.push({ pid: Number(pidNum), socket, age_seconds: Math.max(0, ageSeconds) });
    }
  }
  if (sockets.length) {
    const count = new Set(sockets.map(row => row.pid)).size;
    findings.push({
      severity: "info", name: "tmux_other_servers", detail: { count, sockets },
      problem: `other tmux servers: ${count}; socket age does not establish health`,
      next: "tap --verbose doctor for the inventory",
      verboseLines: sockets.map(row => `other tmux server pid ${row.pid}  socket: ${row.socket}  age: ${Math.floor(row.age_seconds / 3600)}h`),
    });
  }
}

// --- tmux client tty hazards (tap-7r3fn.17.1) ------------------------------
//
// Read-only diagnostics for the 2026-09-03 incident shape (two readers of one
// tty): (a) attach clients whose process group is not their terminal's
// foreground process group, and (b) a responsive server's client terminal fds
// that lack O_NONBLOCK. The scan reports observed evidence only; it never
// signals clients, touches the server, or explains what backgrounded a client
// (the incident's launch trigger remains unresolved). Every observation runs
// through the injectable runner so tests exercise exact evidence fixtures
// without touching the host tmux server or clients.

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface TmuxClientHazardDeps {
  run(cmd: string, args: string[], timeoutMs: number): CommandResult | null;
  platform: NodeJS.Platform;
  socket(env: NodeJS.ProcessEnv): string;
}

export interface PsRow {
  pid: string;
  pgid: string;
  tpgid: string;
  tty: string;
  command: string;
}

export interface LsofChrRow {
  fd: string;
  type: string;
  flags: string;
  name: string;
}

const TMUX_CLIENT_PS_TIMEOUT_MS = 5000;
const TMUX_CLIENT_PROBE_TIMEOUT_MS = 2000;
const TMUX_CLIENT_LSOF_TIMEOUT_MS = 5000;
// tmux's attach-session aliases (tmux man page), matched as the first
// non-option token after the tmux binary; -S/-L/-c/-f take a value. Only a
// process whose executable IS tmux (argv[0] basename) counts: a program
// merely carrying "tmux attach-session" as data must not become a reported
// client, and its pid must not receive exit advice.
const TMUX_ATTACH_SUBCOMMANDS = new Set(["attach-session", "attach", "at", "a"]);
const TMUX_VALUE_FLAGS = new Set(["-S", "-L", "-c", "-f", "-T"]);

// The `= formats` ps invocation prints data only (no header), so every
// nonempty line should parse; a line that does not means the snapshot is
// truncated or off-shape. `complete: false` names that unknown without
// discarding the rows that did parse.
export function parsePsSnapshot(stdout: string): { rows: PsRow[]; complete: boolean } {
  const rows: PsRow[] = [];
  let complete = true;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const tokens = line.trim().split(/\s+/);
    const [pid, pgid, tpgid, tty] = tokens as [string, string, string, string];
    if (tokens.length < 5 || !/^\d+$/.test(pid) || !/^\d+$/.test(pgid) || !/^-?\d+$/.test(tpgid)) {
      complete = false;
      continue;
    }
    rows.push({ pid, pgid, tpgid, tty, command: tokens.slice(4).join(" ") });
  }
  return { rows, complete };
}

export function isAttachClientCommand(command: string): boolean {
  const tokens = command.split(/\s+/);
  if ((tokens[0]?.split("/").pop() ?? "") !== "tmux") return false;
  for (let j = 1; j < tokens.length; j += 1) {
    const token = tokens[j] ?? "";
    if (TMUX_VALUE_FLAGS.has(token)) {
      j += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return TMUX_ATTACH_SUBCOMMANDS.has(token);
  }
  return false;
}

export function flagsHaveNonblock(flags: string): boolean {
  return (flags.split(";")[0] ?? "").split(",").includes("NB");
}

// lsof +fg table rows: only CHR rows carry a FILE-FLAG column, and PIPE rows
// drop empty columns, so a CHR row must parse as FD TYPE FILE-FLAG DEVICE
// SIZE/OFF NODE NAME. `complete` is false when any CHR row (a server always
// holds some) failed to parse: an unrecognized shape is unknown, not clean.
export function parseLsofFileFlags(stdout: string): { rows: LsofChrRow[]; complete: boolean } {
  const rows: LsofChrRow[] = [];
  let seen = 0;
  let parsed = 0;
  for (const line of stdout.split("\n")) {
    const tokens = line.split(/\s+/);
    const typeAt = tokens.indexOf("CHR");
    if (typeAt < 1) continue;
    seen += 1;
    if (tokens.length !== typeAt + 6) continue;
    const fd = tokens[typeAt - 1] ?? "";
    const flags = tokens[typeAt + 1] ?? "";
    const name = tokens[typeAt + 5] ?? "";
    if (!/^\d+[uwr]?$/.test(fd) || !name.startsWith("/")) continue;
    parsed += 1;
    rows.push({ fd, type: "CHR", flags, name });
  }
  return { rows, complete: seen > 0 && parsed === seen };
}

function hasRealTty(tty: string): boolean {
  return tty !== "??" && tty !== "?" && tty !== "";
}

function hazardAttachClients(rows: PsRow[]): PsRow[] {
  return rows.filter((r) => isAttachClientCommand(r.command) && hasRealTty(r.tty)
    && /^\d+$/.test(r.pgid) && /^\d+$/.test(r.tpgid) && r.tpgid !== "0" && r.pgid !== r.tpgid);
}

function unverifiedClientHazard(tool: string, reason: string, detail: string): Finding {
  return {
    severity: "warning",
    name: "tmux_client_hazards_unverified",
    detail: { tool, reason, detail: detail || undefined },
    problem: `could not verify tmux client tty hazards (${tool} ${reason}${detail ? `: ${detail}` : ""}) — not checked`,
  };
}

const defaultHazardRun = (cmd: string, args: string[], timeoutMs: number): CommandResult | null => {
  const run = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  if (run.error) return null;
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

export function scanTmuxClientHazards(findings: Finding[], env: NodeJS.ProcessEnv, deps?: Partial<TmuxClientHazardDeps>): void {
  const run = deps?.run ?? defaultHazardRun;
  const platform = deps?.platform ?? process.platform;
  const socket = deps?.socket ? deps.socket(env) : selectedSocket(env);
  const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

  // Hazard (a): attach clients outside their terminal's foreground process
  // group, from one read-only ps snapshot. tpgid is the kernel's foreground
  // group for that tty; a client with no tty or no foreground group is left
  // unclassified rather than guessed.
  const clientTtys = new Map<string, string[]>();
  const ps = run("ps", ["-axo", "pid=,pgid=,tpgid=,tty=,command="], TMUX_CLIENT_PS_TIMEOUT_MS);
  if (!ps) findings.push(unverifiedClientHazard("ps", "unavailable", "the process table could not be read"));
  else if (ps.status !== 0) findings.push(unverifiedClientHazard("ps", "failed", firstLine(ps.stderr)));
  else {
    const { rows, complete } = parsePsSnapshot(ps.stdout);
    // A successful ps that yields no parseable rows is an unrecognized
    // snapshot shape: unknown, never an empty all-clear. A mixed snapshot —
    // valid rows alongside malformed ones — is equally incomplete: the valid
    // rows still classify, and the dropped lines are named, not silent.
    if (rows.length === 0) findings.push(unverifiedClientHazard("ps", "shape_unparsed", "no parseable rows in the ps snapshot"));
    else if (!complete) findings.push(unverifiedClientHazard("ps", "partial_unparsed", "malformed row(s) dropped from the ps snapshot"));
    for (const row of rows) {
      if (!isAttachClientCommand(row.command) || !hasRealTty(row.tty)) continue;
      const pids = clientTtys.get(row.tty) ?? [];
      pids.push(row.pid);
      clientTtys.set(row.tty, pids);
    }
    for (const row of hazardAttachClients(rows).sort((a, b) => Number(a.pid) - Number(b.pid))) {
      findings.push({
        severity: "warning",
        attention: true,
        name: "background_attach_client",
        detail: {
          pid: Number(row.pid), pgid: Number(row.pgid), tty: row.tty,
          foreground_pgid: Number(row.tpgid), command: row.command.slice(0, 200),
        },
        problem: `background tmux attach client pid ${row.pid} (pgid ${row.pgid}) on tty ${row.tty} runs outside the terminal's foreground process group ${row.tpgid} — two readers of one tty can wedge the tmux server`,
        next: "exit that client or bring its process group to the foreground, then attach from a foreground shell",
      });
    }
  }

  // Hazard (b): client terminal fds on the selected-socket server. Every
  // uncertain probe answer is named, not silently skipped: the classic
  // no-server refusal is the one N/A (an offline server has no clients and
  // the offline finding owns that state); a timeout, another error, or a
  // non-numeric pid is not checked.
  const probe = run("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], TMUX_CLIENT_PROBE_TIMEOUT_MS);
  if (!probe) {
    findings.push(unverifiedClientHazard("tmux", "probe_unresponsive", "the server pid probe timed out"));
    return;
  }
  if (probe.status !== 0) {
    if (!/no server running|No such file or directory/i.test(`${probe.stderr}\n${probe.stdout}`)) {
      findings.push(unverifiedClientHazard("tmux", "probe_failed", firstLine(probe.stderr || probe.stdout)));
    }
    return;
  }
  const serverPid = probe.stdout.trim();
  if (!/^\d+$/.test(serverPid)) {
    findings.push(unverifiedClientHazard("tmux", "probe_invalid", firstLine(probe.stdout) || "non-numeric server pid"));
    return;
  }
  const lsof = run("lsof", ["+fg", "-nP", "-p", serverPid], TMUX_CLIENT_LSOF_TIMEOUT_MS);
  if (!lsof) {
    findings.push(unverifiedClientHazard("lsof", "unavailable", "lsof could not be executed"));
    return;
  }
  if (lsof.status !== 0) {
    findings.push(unverifiedClientHazard("lsof", "failed", firstLine(lsof.stderr)));
    return;
  }
  const parsed = parseLsofFileFlags(lsof.stdout);
  if (!parsed.complete) {
    findings.push(unverifiedClientHazard("lsof", "shape_unparsed", "no readable CHR rows in lsof +fg output"));
    return;
  }
  // On macOS a server's client terminals are the /dev/ttysN entries (pane
  // masters are /dev/ptmx), the incident-proven lens. Elsewhere pane ptys and
  // client terminals share a name space and are not even disjoint (tmux
  // permits a nested same-server attach when TMUX is unset), so only fds a
  // live attach client corroborates classify; every other tty-like candidate
  // is named not checked instead of silently skipped or inferred.
  const corroborated = (name: string): boolean => {
    const bare = name.replace(/^\/dev\//, "");
    return clientTtys.has(name) || clientTtys.has(bare);
  };
  const ttyLike = (name: string) => /^\/dev\/(pts\/\d+|tty\w*|ttys\w*)$/.test(name);
  let isClientTerminal: (name: string) => boolean;
  if (platform === "darwin") {
    isClientTerminal = (name: string) => /^\/dev\/ttys\d+$/.test(name);
  } else {
    isClientTerminal = corroborated;
    const unclassified = parsed.rows.filter((r) => ttyLike(r.name) && !corroborated(r.name)).length;
    if (unclassified > 0) {
      findings.push(unverifiedClientHazard("tmux", "linux_client_fds_unclassified",
        `${unclassified} server tty fd(s) could not be classified without a corroborating attach client`));
    }
  }
  for (const row of parsed.rows.filter((r) => isClientTerminal(r.name)).sort((a, b) => Number.parseInt(a.fd, 10) - Number.parseInt(b.fd, 10))) {
    if (flagsHaveNonblock(row.flags)) continue;
    const bare = row.name.replace(/^\/dev\//, "");
    findings.push({
      severity: "warning",
      attention: true,
      name: "blocking_client_tty_fd",
      detail: {
        server_pid: Number(serverPid), fd: row.fd, tty: row.name, flags: row.flags,
        client_pids: (clientTtys.get(row.name) ?? clientTtys.get(bare) ?? []).map(Number),
      },
      problem: `tmux server pid ${serverPid} client terminal fd ${row.fd} (${row.name}) lacks O_NONBLOCK (flags ${row.flags}) — one lost byte on that tty can block the whole server read loop`,
      next: "close that client or reattach it from a foreground shell so the server reopens the tty",
    });
  }
}

function scanCodexSeats(registryPath: string, findings: Finding[], env: NodeJS.ProcessEnv): void {
  const read = readJsonFile(registryPath);
  if (!("value" in read) || !isRecord(read.value)) return;
  const seats = seatMap(read.value);
  for (const handle of Object.keys(seats).sort()) {
    const seat = seats[handle];
    if (!seat || str(seat.harness) !== "codex" || seat.status !== "active" || str(seat.delivery) === "poll") continue;
    const paneId = str(seat.pane_id);
    if (!paneId) continue;
    try {
      const pane = str(seat.pane);
      // Incumbent parity: session comes from `pane` only when it carries a
      // colon; otherwise the stored session field alone decides.
      const session = str(seat.session) || (pane.includes(":") ? pane.split(":")[0] : "");
      const sessions = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}\t#{pid}:#{start_time}"], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...env, TMUX: env.TMUX ?? "" },
      });
      // The name-drift census is best-effort: a failing list-sessions makes
      // `present` false but must NOT suppress the independent stored-pane-id
      // PATH probe below.
      const present = sessions.status === 0 && (sessions.stdout ?? "").split("\n").some((l) => l.split("\t")[0] === session);
      if (session && pane && present) {
        const panes = spawnSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{session_name}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}"], { encoding: "utf8", timeout: 5000 });
        if (panes.status === 0) {
          for (const line of (panes.stdout ?? "").split("\n")) {
            const [name, namePane, namePaneId] = line.split("\t");
            if (name === session && namePane === pane && namePaneId && namePaneId !== paneId) {
              findings.push({
                severity: "warning",
                name: "codex_seat_pane_name_drift",
                attention: true,
                detail: { handle, session, pane, stored_pane_id: paneId, name_pane_id: namePaneId },
                problem: `attention: codex seat '${handle}' pane binding drift: stored id ${paneId}, name-derived id ${namePaneId}`,
                next: `tap in ${handle} from the intended pane`,
              });
              break;
            }
          }
        }
      }
      const pidRun = spawnSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_pid}"], { encoding: "utf8", timeout: 5000 });
      const pid = (pidRun.stdout ?? "").trim();
      if (!/^\d+$/.test(pid)) continue;
      const eww = spawnSync("ps", ["eww", "-p", pid], { encoding: "utf8", timeout: 5000 });
      if (eww.status !== 0) continue;
      // Python `$` parity: it also matches just before one trailing newline;
      // a JS unanchored `$` does not, so `ps eww` output never matched. The
      // lookahead (?=\n?$) reproduces the Python semantics exactly.
      const m = (eww.stdout ?? "").match(/PATH=(.*?)(?:\s[A-Z_][A-Z0-9_]*=|(?=\n?$))/);
      const pathValue = m?.[1] ?? "";
      // An empty PATH is unparsable, not a finding: the incumbent skipped it.
      if (!pathValue) continue;
      const resolvable = pathValue.split(":").some((dir) => dir && existsSync(join(dir, "node")));
      if (!resolvable) {
        findings.push({
          severity: "warning",
          name: "codex_seat_node_unresolvable",
          attention: true,
          detail: { handle, pane_id: paneId, pid },
          problem: `attention: codex seat '${handle}' (pid ${pid}) has no 'node' on PATH — third-party Codex plugin hooks that run bare 'node' will exit 127 (TAP's own hooks use bun and bash and are unaffected)`,
          next: "the seat's PATH comes from the shell tmux started it in, and nvm-style node loads only in a login shell: restart codex from a login shell, or add node's bin dir to that PATH",
        });
      }
    } catch (e) {
      findings.push({
        severity: "warning",
        name: "codex_seat_probe_failed",
        detail: { handle, error: String(e) },
        problem: `warning: codex seat node-PATH probe failed (${String(e)})`,
      });
    }
  }
}

function scanPayloads(
  payloadsDir: string,
  receiptsDir: string,
  findings: Finding[],
): { torn: number; unattributed: number } {
  let torn = 0;
  let unattributed = 0;
  for (const name of listMd(payloadsDir)) {
    const stem = name.slice(0, -3);
    const path = join(payloadsDir, name);
    let raw = "";
    try {
      // A payload path that is not a regular file (FIFO, directory) would
      // block readFileSync forever: the cannot-read catch records one torn
      // payload instead. os.path.isfile parity, symlink-following.
      if (!isRegularFile(path)) throw new Error("not a regular file");
      raw = readFileSync(path, "utf8");
    } catch (e) {
      torn += 1;
      findings.push({
        severity: "error",
        name: "torn_payload",
        detail: { path: name, reason: `cannot read: ${String(e)}` },
        problem: `torn payload  path: ${name}  cannot read: ${String(e)}`,
      });
      continue;
    }
    if (raw.length === 0) {
      torn += 1;
      findings.push({
        severity: "error",
        name: "torn_payload",
        detail: { path: name, reason: "zero-byte" },
        problem: `torn payload  path: ${name}  reason: zero-byte`,
      });
      continue;
    }
    const { fields, error } = frontmatter(raw);
    if (error) {
      torn += 1;
      findings.push({
        severity: "error",
        name: "torn_payload",
        detail: { path: name, reason: error },
        problem: `torn payload  path: ${name}  ${error}`,
      });
      continue;
    }
    const missing = REQUIRED_PAYLOAD_FIELDS.filter((f) => !fields[f]);
    if (missing.length > 0) {
      torn += 1;
      findings.push({
        severity: "error",
        name: "torn_payload",
        detail: { path: name, missing },
        problem: `torn payload  path: ${name}  missing: ${missing.join(", ")}`,
      });
      continue;
    }
    const badToken = ["id", "from", "to", "kind"].find((f) => !ID_TOKEN_RE.test(fields[f] ?? ""));
    if (badToken) {
      torn += 1;
      findings.push({
        severity: "error",
        name: "torn_payload",
        detail: { path: name, field: badToken },
        problem: `torn payload  path: ${name}  field: '${badToken}' is not sentinel-safe`,
      });
      continue;
    }
    const envPath = fields.path ?? "";
    // Python re-whitespace parity (the explicit 29-code-point class): JS \s
    // misses U+001C–U+001F and wrongly includes U+FEFF.
    if (PY_WHITESPACE_RE.test(envPath) || envPath.includes("]")) {
      torn += 1;
      findings.push({
        severity: "error",
        name: "torn_payload",
        detail: { path: name, field: "path" },
        problem: `torn payload  path: ${name}  field: 'path' is not sentinel-safe`,
      });
      continue;
    }
    if (fields.id !== stem) {
      torn += 1;
      findings.push({
        severity: "error",
        name: "torn_payload",
        detail: { path: name, envelope_id: fields.id },
        problem: `torn payload  path: ${name}  envelope id: '${fields.id}' does not match filename`,
      });
      continue;
    }
    const expectedPath = join(payloadsDir, `${stem}.md`);
    const envReal = canonicalPath(envPath);
    const expReal = canonicalPath(expectedPath);
    if (envReal !== expReal) {
      findings.push({
        severity: "warning",
        name: "external_path",
        detail: { path: name, envelope_path: envPath, expected_path: expectedPath },
        problem: `external-path  path: ${name}  envelope_path: ${envPath}  expected_path: ${expectedPath}  (payload placed with wrong bus path)`,
        next: `recipient should settle via: tap read ${stem} --by <me>`,
      });
    }
    const reply = fields.reply;
    if (reply && reply !== "expected" && reply !== "settle-only") {
      findings.push({
        severity: "warning",
        name: "unsanctioned_reply",
        detail: { path: name, reply },
        problem: `unsanctioned reply:  path: ${name}  reply: ${reply}  (sanctioned: expected|settle-only)`,
        next: "inspect the envelope; hand-placed files often invent reply values",
      });
    }
    // Incumbent parity: os.path.isfile() — a directory or FIFO at a receipt
    // path is not attribution.
    const attributed = ["done", "cancelled", "placed", "sent"].some((s) => isRegularFile(join(receiptsDir, `${stem}.${s}`)));
    if (!attributed) {
      unattributed += 1;
      findings.push({
        severity: "warning",
        name: "unattributed_payload",
        detail: { path: name, id: stem },
        problem: `unattributed payload  id: ${stem}  (no receipts/${stem}.placed or .sent)`,
        next: "hand-written or pre-attribution exit-5 residue; poll lists it as provenance=unattributed",
      });
    }
  }
  return { torn, unattributed };
}

function scanInputBackups(dir: string, prune: boolean, findings: Finding[]): void {
  for (const name of listMd(dir, true)) {
    const path = join(dir, name);
    if (prune) {
      try {
        unlinkSync(path);
        findings.push({
          severity: "info",
          name: "input_backup_pruned",
          detail: { path },
          problem: `pruned input-backup  path: ${path}`,
        });
      } catch (e) {
        findings.push({
          severity: "warning",
          name: "input_backup_pruned",
          detail: { path, error: String(e) },
          problem: `warning: could not prune input-backup  path: ${path}  error: ${String(e)}`,
        });
      }
      continue;
    }
    try {
      const raw = readFileSync(path, "utf8");
      const { fields, error } = frontmatter(raw);
      if (error) throw new Error(error);
      findings.push({
        severity: "info",
        name: "input_backup",
        detail: {
          path,
          created_at: fields.created_at ?? "unknown",
          handle: fields.handle ?? "unknown",
          payload_id: fields.payload_id ?? "unknown",
          input_hash: fields.input_hash ?? "unknown",
        },
        problem: `input-backup  path: ${path}  created_at: ${fields.created_at ?? "unknown"}  handle: ${fields.handle ?? "unknown"}  payload_id: ${fields.payload_id ?? "unknown"}  input_hash: ${fields.input_hash ?? "unknown"}`,
      });
    } catch (e) {
      findings.push({
        severity: "warning",
        name: "input_backup_malformed",
        detail: { path, error: String(e) },
        problem: `warning: malformed input-backup  path: ${path}  error: ${String(e)}`,
      });
    }
  }
}

function scanWatchLogs(dir: string, prune: boolean, findings: Finding[]): void {
  for (const name of listMd(dir, true)) {
    const path = join(dir, name);
    if (prune) {
      try {
        unlinkSync(path);
        findings.push({
          severity: "info",
          name: "watch_log_pruned",
          detail: { path },
          problem: `pruned watch-log  path: ${path}`,
        });
      } catch (e) {
        findings.push({
          severity: "warning",
          name: "watch_log_pruned",
          detail: { path, error: String(e) },
          problem: `warning: could not prune watch-log  path: ${path}  error: ${String(e)}`,
        });
      }
      continue;
    }
    try {
      const st = statSync(path);
      const mtime = Math.floor(st.mtimeMs / 1000);
      findings.push({
        severity: "info",
        name: "watch_log",
        detail: { path, mtime, bytes: st.size },
        problem: `watch-log  path: ${path}  mtime: ${mtime}  bytes: ${st.size}`,
      });
    } catch (e) {
      findings.push({
        severity: "warning",
        name: "watch_log_malformed",
        detail: { path, error: String(e) },
        problem: `warning: malformed watch-log  path: ${path}  error: ${String(e)}`,
      });
    }
  }
}

function scanSpool(spoolDir: string, findings: Finding[]): void {
  // Threshold validation precedes the best-effort readdir early return: bad
  // configuration fails even when spool/ is absent.
  const [countMin, probesMin] = backlogThresholds(process.env);
  const now = Math.floor(Date.now() / 1000);
  let metas: string[] = [];
  try {
    metas = readdirSync(spoolDir).filter((n) => n.endsWith(".meta.json")).sort();
  } catch (e) {
    // Only a missing spool directory is an empty spool; any other read
    // failure (ENOTDIR, EACCES, ...) is a nonzero refusal naming the path.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new TapError(1, "spool_unreadable", "tap doctor", `spool directory unreadable (${spoolDir})`);
  }
  for (const name of metas) {
    const id = name.slice(0, -".meta.json".length);
    let meta: Record<string, unknown>;
    const read = readJsonFile(join(spoolDir, name));
    if (!("value" in read) || !isRecord(read.value)) {
      const error = "error" in read ? read.error : "meta is not a JSON object";
      findings.push({
        severity: "warning",
        name: "spool_orphan_meta",
        detail: { id, error },
        problem: `warning: malformed spool meta  id: ${id}  error: ${error}`,
      });
      continue;
    }
    meta = read.value;
    const payloadPath = join(spoolDir, `${id}.md`);
    if (!existsSync(payloadPath)) {
      findings.push({
        severity: "warning",
        name: "spool_orphan_meta",
        detail: { id, target: str(meta.target) || "unknown" },
        problem: `warning: orphan spool meta (no payload)  id: ${id}  target: ${str(meta.target) || "unknown"}`,
      });
      continue;
    }
    const target = str(meta.target) || "unknown";
    const reason = str(meta.reason) || "unknown";
    const reasonClass = str(meta.reason_class) || "busy";
    const attempts = pyInt(meta.attempts) ?? 0;
    const firstEpoch = pyInt(meta.first_spooled_epoch);
    const age = firstEpoch ? now - firstEpoch : null;
    const threshold = pyInt(meta.timeout_seconds) || STUCK_AFTER_SECONDS;
    // Incumbent truthiness: JSON false/0/""/null are not escalated.
    const escalated = Boolean(meta.escalated_at);
    if (age !== null && age >= threshold) {
      const blocker = `delivery remained queued after drain attempts — needs a human; try: tap nudge ${target} or tmux send-keys Enter on their pane`;
      findings.push({
        severity: "warning",
        name: "stuck_spool",
        attention: true,
        detail: {
          id, to: target, reason, reason_class: reasonClass, attempts, age,
          escalated, blocker,
        },
        problem: `attention: stuck spool  id: ${id}  to: ${target}  reason: ${reason}  reason_class: ${reasonClass}  attempts: ${attempts}  age: ${age}s  escalated: ${escalated ? "yes" : "no"}`,
        next: blocker,
      });
    } else {
      findings.push({
        severity: "info",
        name: "spool",
        detail: {
          id, to: target, reason, reason_class: reasonClass, attempts, age,
          busy_pending_probes: pyInt(meta.busy_pending_probes) ?? 0,
        },
        problem: `spool  id: ${id}  to: ${target}  reason: ${reason}  reason_class: ${reasonClass}  attempts: ${attempts}  age: ${age !== null ? age : "unknown"}s`,
      });
    }
  }
  // tap-hgf07: the validated shared thresholds feed the backlog scan here;
  // ordinary spool-scan failures stay best-effort.
  let reports: ReturnType<typeof spoolBacklogs> = [];
  try {
    reports = spoolBacklogs(spoolDir, now, countMin, probesMin);
  } catch {
    return;
  }
  for (const r of reports) {
    if (!r.condition) continue;
    findings.push({
      severity: "warning",
      name: "persistent_spool_backlog",
      attention: true,
      detail: {
        to: r.target, count: r.count, ids: r.ids, age: r.age_seconds,
        busy_pending_probes: r.busy_pending_probes, witness_id: r.witness_id,
        last_busy_probe_at: r.last_busy_probe_at,
        parking_to_last_busy_seconds: r.parking_to_last_busy_seconds,
        blocker: r.remedy,
      },
      problem: `attention: persistent spool backlog  ${r.line}`,
      next: r.remedy,
    });
  }
}

// Unknown numeric fields survive a prune: the marker is parsed with the
// preserving parser (floats keep their lexeme class, wide integers keep
// their digits) and rendered through the Python-compatible renderer
// (json.dump(indent=2, sort_keys=True) parity), never through a JSON
// round-trip that would round, normalize, or lose them.
function parseIndexPreserving(path: string): Record<string, unknown> | null {
  try {
    const doc = parseJsonPreserving(readFileSync(path, "utf8"));
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function pruneDanglingTeams(json: boolean): void {
  // tap-hgf07 parity: the incumbent required schema 0.20 before enumerating.
  // An invalid marker must never be repaired by pruning — its bytes stay.
  const snap = loadGlobalRegistry();
  if (snap.marker !== "live") return;
  if (!isRecord(snap.doc) || !isRecord(snap.doc.teams)) return;
  const current = parseIndexPreserving(globalRegistryPath());
  if (!current || !isRecord(current.teams)) return;
  const teams = current.teams as Record<string, unknown>;
  const dangling = Object.keys(teams).filter((team) => {
    if (!ID_TOKEN_RE.test(team)) return false;
    const entry = teams[team];
    if (!isRecord(entry)) return false;
    if (str(entry.state) === "historical") return false;
    // A malformed root (non-string or empty) is never a prune candidate: only
    // a valid missing string root is.
    const root = entry.root;
    if (typeof root !== "string" || root === "") return false;
    return !isDir(root);
  }).sort();
  // Reversibility (tap-k140): the first delete snapshots the index beside
  // itself, under the lock that delete runs under, once per run. A snapshot
  // that cannot be written prunes nothing — every later row keeps its place
  // and the refusal names the retry. The composed team refresh still runs:
  // it trims team registries, never the index.
  let snapshotWritten = false;
  for (const team of dangling) {
    const entry = teams[team] as Record<string, unknown>;
    const root = entry.root;
    if (typeof root !== "string" || root === "") continue;
    if (isDir(root)) continue;
    const lock = acquirePathLock(`${globalRegistryPath()}.lock`);
    if (!lock) {
      throw new TapError(1, "registry_invalid", "tap doctor", `could not prune dangling team index row '${team}'`);
    }
    try {
      const freshSnap = loadGlobalRegistry();
      if (freshSnap.marker !== "live") continue;
      const fresh = parseIndexPreserving(globalRegistryPath());
      if (!fresh || !isRecord(fresh.teams)) continue;
      const freshTeams = fresh.teams as Record<string, unknown>;
      const cur = freshTeams[team];
      if (!isRecord(cur)) continue;
      if (str(cur.state) === "historical") continue;
      const curRoot = cur.root;
      if (typeof curRoot !== "string" || curRoot === "") continue;
      if (isDir(curRoot)) continue;
      if (!snapshotWritten) {
        let snapshot: ReturnType<typeof writeIndexSnapshot>;
        try {
          snapshot = writeIndexSnapshot(globalRegistryPath(), "doctor-fix");
        } catch {
          process.stderr.write("tap doctor: warning: fix; next: could not write an index snapshot; no rows were pruned - retry 'tap doctor --fix'\n");
          return;
        }
        snapshotWritten = true;
        process.stderr.write(`tap doctor: index snapshot '${snapshot.path}' (sha256 ${snapshot.sha256}); restore: cp ${shellQuote(snapshot.path)} ${shellQuote(globalRegistryPath())}\n`);
      }
      delete freshTeams[team];
      atomicWrite(globalRegistryPath(), metaBytes(fresh as Parameters<typeof metaBytes>[0]));
      if (!json) {
        process.stdout.write(`tap doctor: pruned dangling team index row ${team} (root ${root})\n`);
      }
    } finally {
      lock.release();
    }
  }
}

function cmdRefreshFor(json: boolean, scriptsDir: string): number | Promise<number> {
  // --fix composes the native team refresh reconciler directly and RETURNS its
  // result for the router to await: a dynamic import() would run
  // fire-and-forget, and the old DoctorExit(0) here exited doctor before
  // refresh did anything.
  return cmdRefresh(json ? ["--json"] : [], scriptsDir);
}

function finish(
  findings: Finding[],
  opts: {
    busHome: string;
    rule: BusRule | string;
    json: boolean;
    verbose: boolean;
    authority: string | null;
    torn: number;
    unattributed: number;
    installation: Record<string, unknown>;
    preludes: string[];
  },
): number {
  const clean = opts.torn === 0 && opts.authority === null;
  // Count named seats with warning findings, not duplicate findings about a
  // seat. This is separate from bus integrity and is not a clean bill of health
  // for seats whose observations could not be completed.
  const seatAttention = new Set(findings.filter(f => f.severity === "warning").flatMap(f => {
    if (typeof f.detail.handle === "string") return [f.detail.handle];
    return Array.isArray(f.detail.handles) ? f.detail.handles.filter((h): h is string => typeof h === "string") : [];
  })).size;
  if (opts.json) {
    const report = {
      ok: clean,
      bus: { home: opts.busHome, rule: opts.rule },
      installation: opts.installation,
      findings: findings.map((f) => ({ severity: f.severity, name: f.name, detail: f.detail })),
      summary: { torn: opts.torn, unattributed: opts.unattributed, clean, seat_attention: seatAttention },
    };
    process.stdout.write(`${ensureAscii(JSON.stringify(report))}\n`);
    return clean ? 0 : 1;
  }
  process.stdout.write(`tap doctor: bus=${opts.busHome} rule=${opts.rule}\n`);
  // Incumbent human order: preludes sit between the bus header and the
  // installation line.
  for (const line of opts.preludes) process.stdout.write(`${line}\n`);
  process.stdout.write(`tap doctor: ${describeInstallation(opts.installation)}\n`);
  for (const f of findings) {
    const line = f.next ? `${f.problem}; next: ${f.next}` : f.problem;
    if (f.problem.startsWith("ERROR:")) {
      process.stdout.write(`tap doctor: ${f.problem.replace(/^ERROR: /, "")}\n`);
    } else if (f.attention) {
      process.stderr.write(`tap doctor: attention: ${f.problem.replace(/^attention: /, "")}${f.next ? `; next: ${f.next}` : ""}\n`);
    } else if (f.severity === "warning") {
      // Incumbent parity: every warning rendered through tap_warning, which
      // inserts `warning:` — label exactly once.
      process.stderr.write(`tap doctor: ${line.startsWith("warning:") ? line : `warning: ${line}`}\n`);
    } else {
      // Incumbent parity: info findings render their next advice inline
      // (retained resume failures, tmux probes).
      process.stdout.write(`tap doctor: ${line}\n`);
    }
    if (opts.verbose) for (const line of f.verboseLines ?? []) process.stdout.write(`tap doctor: ${line}\n`);
  }
  if (seatAttention > 0) process.stdout.write(`tap doctor: seat health: ${seatAttention} seat(s) need attention\n`);
  if (opts.torn > 0) {
    process.stderr.write(`tap doctor: ${opts.torn} torn-payload finding(s) — bus integrity fail\n`);
    return 1;
  }
  if (opts.authority) {
    process.stderr.write(`tap doctor: authority error (${opts.authority}) — not clean\n`);
    return 1;
  }
  if (opts.unattributed > 0) {
    process.stdout.write(`tap doctor: bus integrity: clean of torn payloads — ${opts.unattributed} unattributed warning(s) (labeled, not hidden)\n`);
  } else {
    process.stdout.write("tap doctor: bus integrity: clean — no torn payloads on the bus\n");
  }
  return 0;
}

function describeInstallation(installation: Record<string, unknown>): string {
  const tap = installation.tap as { entry: string | null; resolved: string | null; head: string | null };
  return `installed TAP: ${tap.entry ?? "unavailable"} -> ${tap.resolved ?? "unavailable"}; HEAD ${tap.head ?? "unavailable"}`;
}
