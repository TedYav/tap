import { reservedSeatName, validToken } from "../ids";
import { validateLaunchWorkdir } from "./workdir";
// `tap session launch`: the native port of launcher.py's `new` (cmd_new,
// make_new_record, execute_fresh_launch). Control flow and names mirror the
// incumbent so the two can be read side by side until the flip deletes it.
// Decisions reuse the
// primitives resume.ts already ported; effects go through the shared
// launchTransaction as kind "new", the kind the Python door has always driven.
import { initRoot, InitRefusal } from "../verbs/init";
import { derivedTeamNotice } from "../register-authority";
import { startupTrace, withStartupTrace } from "../startup-trace";
import { beginLifecycleOperation } from "../lifecycle-diagnostics";
import { tmuxSessionNamespace } from "../tmux";
import { detachedReceipt } from "./attach-policy";
import { Notices } from "./catalog-notices";
import { currentBootId } from "./generation";
import { allocateName, namedSessionName, sanitizeComponent, sessionNameForHandle } from "./naming";
import { applyOverrides, looksLikeOption, parseEnvAssignments, resolveRecordTuning, splitLaunchPassthrough } from "./overrides";
import { callerHasTty, callerTty, exitKeepingTerminal, promptChoice, promptName, type AskName, type NameCheck } from "./prompt";
import { pathIsUnder, realOrSelf, rootForCwd } from "./records";
import { timestamp } from "./repair";
import { resolveLaunchPresetArgs } from "./resolve-target";
import { allocatedIndex, attachTailInProcess, baseAlias, cmdSessionResume, findRecordByKey, occupiedSessionNames,
  receipt, registryEntry, unexpiredSeats } from "./resume";
import { claudeChildStoreRoot, claudeSessionTranscriptExists, codexSessionExists, resolvedResumeIdentity, seatReviveTier, seatStoreEnv } from "./resume-identity";
import { attachableState, classifySession, crewPanesIn, entryObservedDead, verifiedSession } from "./observation";
import { NOT_A_SEAT, type ForkUnavailable, describeSessionState, printOffRosterTmuxExists, printSessionExists, printStoppedSession, promptNewCollision, promptOffRosterTmuxCollision,
  promptSessionExists, recordHasResumeArtifact, relativeAge, sessionAttached, tmuxSessionCreatedLabel, type Choose } from "./collision";
import { cloneRecord, err, Exit, refuseIfFlipAuthority, refuseIfResetFenced, registryAuthority, registryState, render, SCRIPTS,
  withRecordDefaults, type RegistryState } from "./resume-prelude";
import { durableRecord, launchHandle, launchTransaction, recordFromRow, withLaunchSignals, type LaunchRecord } from "./transaction";
import { captureModelWindow } from "../opencode-model-windows";
import { handOffLaunchProgress, launchPhase, launchPhasesDone, progressMode, withLaunchProgress } from "./progress";
import { resolveCliTuning, type ResolvedTuning } from "./tuning";
import { freshLaunchSessionId, HERMES_BIN } from "./adapters";
import { HARNESSES } from "./catalog";
import { FORKABLE_HARNESSES, forkSourceFingerprint, storedForkConflict } from "../harness-families";
import { LauncherError, type SessionRecord } from "./types";
import type { PyInt } from "../spool-publication";
import { duplicateHarnessSessionOwner, duplicateRegistrySessionOwner, identityHandle, type IdentityRecord } from "./identity-owner";
import { TapError } from "../context";
import { renderRefusals } from "../error-line";


/** launcher.py build_parser()'s `new` arguments, after the passthrough split. */
export interface NewArgs {
  harness: string | null;
  label: string | null;
  preset: string | null;
  tag: string | null;
  workdir: string | null;
  unique: string | null;
  model: string | null;
  effort: string | null;
  env: string[] | null;
  unset_env: string[] | null;
  fresh: boolean;
  new: boolean;
  attach: boolean;
  dry_run: boolean;
  json: boolean;
  /** `--resume`: open the harness's native conversation picker in the new seat; `--resume=<id>` resumes that id. */
  resume: boolean;
  resume_id: string | null;
  harness_passthrough: string[];
}

/** Harnesses whose CLI opens a conversation picker from a bare resume flag. Cursor's bare picker emission was
 *  removed on purpose (tap-we6b), OpenCode has none, AGY's --continue is "latest" rather than a choice, Hermes has none. */
export const RESUME_PICKER_HARNESSES: readonly string[] = ["claude", "codex"];

/** A conversation id as the harnesses spell them (UUIDs, thread ids): never option-shaped, never blank or spaced. */
export const RESUME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The seat a launch names, resolved read-only the way makeNewRecord will: an exact `--unique` name, or the
 * tag from `--tag`, the seat-name operand or the preset, normalized, with the session name that handle takes.
 * `tag: null` is the unnamed launch, which allocates a fresh name and so can be no seat's own incarnation. The
 * collision ladder's "n" choice can still move a named target, so the launch rechecks the record it reserves. */
export type NamedTarget = { harness: string; base: string; tag: string | null; name: string | null; index: number | null; presetDerived: boolean; tagIsLiteral: boolean };
export function intendedTarget(args: Pick<Resolved, "harness" | "unique" | "tag" | "label" | "preset_resolution">, state: RegistryState, cwd: string): NamedTarget {
  const base = baseAlias(state, cwd);
  if (args.unique) {
    const name = validateExactName(args.unique);
    return { harness: args.harness, base, tag: slashHandle(name, base), name, index: null, presetDerived: false, tagIsLiteral: false };
  }
  let tag = args.tag || args.label;
  // presetDerived records that the tag came from re-inferring the preset name rather than from an explicit
  // --tag/--label; several behaviors branch on it (the RESERVED_HANDLES refusal, the literal-tag path, the
  // create-intent "n"/collision arms in the seat transaction), and a fixture cannot tell the two apart from the
  // resulting tag, so the origin is carried as this flag instead of recomputed.
  let presetDerived = false;
  if (!tag && args.preset_resolution !== null) {
    tag = args.preset_resolution.provenance.name;
    presetDerived = true;
  }
  if (presetDerived && reservedSeatName(tag!)) {
    throw new LauncherError(`handle '${tag}' ${reservedSeatName(tag!)} and cannot name a seat; pass an explicit seat name, or rename the preset`);
  }
  let tagIsLiteral = false;
  if (tag) {
    tagIsLiteral = presetDerived || validToken(tag);
    tag = normalizeTag(args.harness, tagIsLiteral ? tag : sanitizeComponent(tag));
  }
  if (!tag) return { harness: args.harness, base, tag: null, name: null, index: null, presetDerived, tagIsLiteral };
  return { harness: args.harness, base, tag, name: tagIsLiteral ? sessionNameForHandle(base, tag) : namedSessionName(base, tag), index: 1, presetDerived, tagIsLiteral };
}

/** The handle a target registers under, or null for an unnamed launch (a fresh allocation owns nothing yet).
 * The naming function needs the harness too: a `--unique` name outside the team base has no tag and no base
 * prefix, so its handle is the harness name (`manual` registers as `claude`). */
type ResumeTarget = Pick<LaunchRecord, "harness" | "base"> & { name: string | null; tag?: string | null; index?: number | bigint | PyInt | null };
const targetHandle = (target: ResumeTarget): string | null => target.name === null ? null
  : launchHandle({ name: target.name, harness: target.harness, base: target.base, tag: target.tag ?? null, index: target.index ?? null } as LaunchRecord);

/**
 * `--resume=<id>`: an id another seat already holds refuses, under the same uniqueness contract seat-up and
 * relaunch apply: this cohort first, then every enrolled registry. The seat's own incarnation is not another
 * owner: `tap launch claude writer --fresh --resume=<id>` may reopen the conversation the incumbent `writer`
 * holds, matched by the handle the target registers under at this root, never by a probe's spelling. Called
 * before any effect with the intended target, and again on the record the transaction will reserve, since the
 * collision ladder can move a named target. The register-time duplicate-owner quarantine remains the backstop
 * for a conversation picked in the picker.
 */
export function assertUniqueResumeIdForLaunch(id: string | null, target: ResumeTarget, state: RegistryState, root: string): void {
  if (id === null) return;
  const { harness } = target;
  const self = targetHandle(target);
  const probe: IdentityRecord = { name: target.name ?? "", harness, cwd: root, base: target.base, tag: target.tag ?? "", index: target.index ?? null, harness_session_id: id };
  const cohort = self === null ? state.sessions : state.sessions.filter(record => launchHandle(record) !== self);
  const inCohort = duplicateHarnessSessionOwner(cohort, probe, id);
  const registryPath = registryAuthority(root).path;
  // Both paths name the owner as team/handle, as the registry scan does.
  const owner = inCohort !== null ? `${String(state.team.name ?? target.base)}/${identityHandle(inCohort)}`
    : duplicateRegistrySessionOwner(probe, registryPath ? { root, registryPath, handle: self ?? "" } : undefined);
  if (owner === null) return;
  throw new TapError(2, "launch_resume_identity_owned", "resume that seat instead (tap session resume <seat>), or pick another conversation",
    `tap launch --resume: refusing resume for ${self === null ? "a new seat" : `seat ${self}`}: native ${harness} session id ${id} already belongs to expected seat ${owner}`, "tap launch");
}

/**
 * `--resume=<id>`: the conversation must exist in the harness's own store before anything is reserved or
 * replaced, so a mistyped id under `--fresh` cannot stop the incumbent and then fail when the harness starts.
 * The store is probed as the seat child will read it (its declared and unset env, its own root spelling or the
 * default under its HOME, never TAP's alias); a policy that refuses or degrades is left to the launch's own handling.
 */
export function refuseMissingExactConversation(args: { harness: string; resume_id: string | null; env: string[] | null; unset_env: string[] | null;
  preset_resolution: { env: Record<string, string> } | null }, cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const id = args.resume_id;
  if (id === null || !["claude", "codex"].includes(args.harness)) return;
  const probe: SessionRecord = { name: "probe", harness: args.harness, cwd, base: "", harness_session_id: id,
    harness_env: { ...(args.preset_resolution?.env ?? {}), ...parseEnvAssignments(args.env ?? []) }, harness_unset_env: args.unset_env ?? [] };
  // The store the CHILD reads: its declared and unset env applied, and TAP's alias roots left out, since the
  // launcher never passes them to the child (its own CLAUDE_CONFIG_DIR / CODEX_HOME, else the default under HOME).
  const seat = seatStoreEnv(probe, env);
  if (seat === null) return;
  const exists = args.harness === "claude" ? claudeSessionTranscriptExists(id, seat, claudeChildStoreRoot(seat)) : codexSessionExists(id, seat);
  if (exists) return;
  throw new TapError(2, "no_exact_resume_identity", "check the id against the harness's own session list, or omit =<id> to choose in the picker",
    `--resume=${id}: no ${args.harness} conversation with that id is in this machine's store; nothing was launched or replaced`, "tap launch");
}

/** The refusal a `--resume` launch earns before any effect when the harness has no picker. */
export function refuseResumeWithoutPicker(args: { resume: boolean; resume_id: string | null }, harness: string): void {
  if (!args.resume && args.resume_id === null) return;
  if (RESUME_PICKER_HARNESSES.includes(harness)) return;
  throw new TapError(2, "launch_resume_unsupported", "tap launch --help",
    `--resume opens the native conversation picker for ${RESUME_PICKER_HARNESSES.join(" and ")} only; ${harness} has none. Launch it fresh, or bring a conversation in with tap in after the harness's own resume`, "tap launch");
}

const VALUE_FLAGS: Record<string, keyof NewArgs> = {
  "--workdir": "workdir", "--preset": "preset", "--tag": "tag", "--unique": "unique", "--model": "model", "--effort": "effort",
};
const APPEND_FLAGS: Record<string, "env" | "unset_env"> = { "--env": "env", "--unset-env": "unset_env" };
const BOOL_FLAGS: Record<string, "fresh" | "new" | "attach" | "dry_run" | "json"> = {
  "--fresh": "fresh", "--new": "new", "--attach": "attach", "--dry-run": "dry_run", "--json": "json",
};

const syntaxRefusal = (detail: string, errorClass = "launch_arg_invalid"): never => {
  throw new TapError(2, errorClass, "tap launch --help", detail, "tap launch");
};
/**
 * split_new_passthrough, then the argparse surface. The split already sends
 * every unrecognized flag to the harness tail, so only exact spellings and
 * `--flag=value` reach this parser.
 */
export function parseNew(argv: string[], warn: (message: string) => void = () => {}): NewArgs {
  let own: string[], passthrough: string[];
  try { [own, passthrough] = splitLaunchPassthrough(["new", ...argv], warn); }
  catch (error) {
    // Splitter refusals share this syntax boundary; do not echo arbitrary
    // positional text (which may contain terminal controls or newlines).
    if (error instanceof LauncherError && error.errorClass === "launch_arg_invalid")
      syntaxRefusal("unexpected positional argument; use -- before bare harness arguments");
    if (error instanceof LauncherError && error.errorClass === "preset_passthrough")
      syntaxRefusal("--preset is never forwarded; move it before harness passthrough begins", "preset_passthrough");
    throw error;
  }
  const args: NewArgs = { harness: null, label: null, preset: null, tag: null, workdir: null, unique: null, model: null, effort: null,
    env: null, unset_env: null, fresh: false, new: false, attach: false, dry_run: false, json: false, resume: false, resume_id: null, harness_passthrough: passthrough };
  const positionals: string[] = [];
  const expectedOne = (flag: string): never => syntaxRefusal(`${flag} requires a value`);
  for (let i = 1; i < own.length; i++) {
    const token = own[i]!;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : undefined;
    if (Object.hasOwn(VALUE_FLAGS, flag) || Object.hasOwn(APPEND_FLAGS, flag)) {
      const next = own[i + 1];
      const value = inline ?? (next === undefined || looksLikeOption(next) ? expectedOne(flag) : own[++i]!);
      if (Object.hasOwn(APPEND_FLAGS, flag)) (args[APPEND_FLAGS[flag]!] ??= []).push(value);
      else (args as unknown as Record<string, string>)[VALUE_FLAGS[flag]!] = value;
    } else if (Object.hasOwn(BOOL_FLAGS, flag) && inline === undefined) {
      args[BOOL_FLAGS[flag]!] = true;
    } else if (flag === "--resume") {
      // Optional value in the = form only: `--resume <id>` would take the seat name as the id.
      if (inline === undefined) args.resume = true;
      else if (inline === "") syntaxRefusal("--resume= needs a conversation id, or omit the = to open the picker");
      // The id becomes a bare operand in the harness argv (`codex resume <id>`), so an option-looking or
      // malformed value would change what the harness does: refuse it here, before any effect.
      else if (!RESUME_ID.test(inline)) syntaxRefusal("--resume=<id> takes a conversation id (letters, digits, '.', '_', ':' or '-', not starting with '-'); omit the = to open the picker");
      else args.resume_id = inline;
    } else if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
    } else syntaxRefusal("unrecognized launch option");
  }
  if (positionals.length > 2) syntaxRefusal("too many launch positional arguments");
  [args.harness = null, args.label = null] = positionals;
  return args;
}

/** One rendering boundary for public preflight and the direct launcher door. */
export function parseLaunchCommand(argv: string[], warn?: (message: string) => void): NewArgs | number {
  let args: NewArgs | undefined;
  const code = renderRefusals("tap launch", () => { args = parseNew(argv, warn); return 0; },
    { ...process.env, TAP_JSON: process.env.TAP_JSON === "1" || argv.includes("--json") ? "1" : "0" });
  return args ?? code;
}

type PresetResolution = { harness: string; model: string | null; harness_passthrough: string[]; env: Record<string, string>;
  provenance: { name: string; source_path: string; config_digest: string } };
export type Resolved = NewArgs & { harness: string; preset_resolution: PresetResolution | null };

/** resolve_new_preset_args: the preset or bare harness this launch names. */
function resolveNewPresetArgs(args: NewArgs, notices: Notices): Resolved {
  const values = resolveLaunchPresetArgs(process.env, notices, { preset: args.preset, harness: args.harness, label: args.label,
    model: args.model, effort: args.effort, verb: null, usage: null }) as {
    harness: string; label: string | null; preset_name: string | null; catalog: { presets: Record<string, PresetResolution> } | null };
  const resolution = values.catalog !== null && values.preset_name !== null ? values.catalog.presets[values.preset_name] ?? null : null;
  return { ...args, harness: values.harness, label: values.label, preset_resolution: resolution };
}

const newLabelRequestsResume = (args: Resolved): boolean => !!args.label && !args.tag && !args.unique && /^\d+$/.test(args.label);

/** refuse_tuning_on_resume_delegation: tuning describes a NEW seat; resume replays the record (and a fork its source's). */
export function refuseTuningOnResumeDelegation(args: NewArgs, door: string, replays = "a resume replays the stored record"): void {
  const supplied = ([["--workdir", args.workdir], ["--model", args.model], ["--effort", args.effort], ["--unset-env", args.unset_env], ["--env", args.env]] as const)
    .filter(([, value]) => value !== null).map(([flag]) => flag as string);
  if (args.harness_passthrough.length) {
    const leading = args.harness_passthrough.find(token => token.startsWith("-"));
    supplied.push(leading ? `harness passthrough (${leading})` : "harness passthrough");
  }
  // A picker or exact `--resume` describes a NEW seat too; a delegated resume would drop it silently.
  if (args.resume || args.resume_id !== null) supplied.push(args.resume_id !== null ? `--resume=${args.resume_id}` : "--resume");
  if (!supplied.length) return;
  const joined = supplied.join(" and ");
  throw new LauncherError(`launch_tuning_not_resumable: ${joined} cannot apply to ${door}: ${replays}`,
    "launch_tuning_not_resumable", `drop ${joined}, or pass --fresh to launch a new seat that can carry it`,
    `${joined} cannot apply to ${door}: ${replays}`);
}

/** resolve_adhoc_tuning: argv tuning through the same fence preset tables face. */
function resolveAdhocTuning(args: Resolved): ResolvedTuning {
  const rawEnv = parseEnvAssignments(args.env ?? []);
  if (args.model === null && args.effort === null && !Object.keys(rawEnv).length) return { model: null, harness_passthrough: [], env: {} };
  if (args.effort && args.harness_passthrough.length) {
    throw new LauncherError("launch_arg_invalid: --effort conflicts with an explicit harness passthrough vector", "launch_arg_invalid",
      "pass effort one way: --effort, or the harness passthrough flag, not both", "--effort conflicts with an explicit harness passthrough vector");
  }
  return resolveCliTuning(args.harness, args.model, args.effort, rawEnv);
}

const overridesOf = (args: NewArgs) => ({ env: args.env ?? [], unset_env: args.unset_env ?? [], argv: args.harness_passthrough });

/** require_launch_commands: absent prerequisites refuse before enrollment or reservation. */
export function requireLaunchCommands(harness: string): void {
  const missing = (detail: string, action: string): never => {
    throw new LauncherError(`missing_prerequisite: ${detail}`, "missing_prerequisite", action, detail);
  };
  if (!Bun.which("tmux", { PATH: process.env.PATH ?? "" })) missing("tmux was not found on PATH", "Install tmux, check `tmux -V` in this terminal, then retry");
  const executable = ({ cursor: "cursor-agent", hermes: HERMES_BIN } as Record<string, string>)[harness] ?? harness;
  if (!Bun.which(executable, { PATH: process.env.PATH ?? "" })) {
    missing(`${executable} was not found on PATH`,
      `Install the ${harness} CLI, put ${executable} on PATH, and start it in this terminal to complete authentication, then retry`);
  }
}

/** _bootstrap_if_unenrolled: first launch initializes the root in one go; init owns every decision.
 *  A dry run returns the team the real launch would enroll, so the preview uses its namespace. */
function bootstrapIfUnenrolled(root: string, dryRun: boolean, json: boolean): string | null {
  const { status } = registryAuthority(root);
  if (status !== "absent" && status !== "live_unenrolled") return null;
  let outcome;
  try { outcome = initRoot(root, { json, yes: false, forLaunch: true, dryRun }); }
  catch (error) {
    if (error instanceof InitRefusal) throw new LauncherError(`tap session refused — ${error.detail}; next: ${error.action}`);
    throw error;
  }
  if (!outcome.already && outcome.derivedFrom) err(`tap session: ${derivedTeamNotice(outcome.team, outcome.derivedFrom)}`);
  if (!outcome.already && !dryRun) err(`tap session: initialized team '${outcome.team}' at ${outcome.root}`);
  return dryRun ? outcome.team || null : null;
}

/** tmux_sessions_for_namespace: only tmux's no-server answer is an empty namespace. */
function tmuxSessionsForNamespace(): Set<string> {
  const namespace = tmuxSessionNamespace(process.env);
  if (!namespace.observable) throw new LauncherError("tmux session-name snapshot is unobservable; refusing to treat the session namespace as empty");
  return namespace.names;
}

const normalizeTag = (harness: string, tag: string | null): string | null => tag === harness ? null : tag;

function validateExactName(name: string): string {
  if (!/^[A-Za-z0-9_/-]+$/.test(name)) throw new LauncherError("--unique names must use only letters, numbers, '_', '-' or '/'");
  return name;
}

/** slash_handle: the handle a session name carries under this base. */
function slashHandle(name: string, base: string): string | null {
  const prefix = `${sanitizeComponent(base)}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) || null : null;
}

/** The k arm's replacement authority, spread onto the new record. */
type Replacement = Pick<LaunchRecord, "history" | "replacement_record" | "kill_backup_required" | "replaces_session"
  | "replaces_manifest_session">;
/** [n]'s outcome: the session name and the handle it carries, allocated or typed at the name prompt. */
type LadderOutcome = { choice: "n"; nextName: string; handle: string } | { choice: "k"; replacement: Replacement; receipts: string[] };
type LadderInputs = {
  state: RegistryState; cwd: string; base: string; root: string; tag: string; requestedName: string; presetDerived: boolean;
  seated: boolean; live: boolean; existingRecord: LaunchRecord | null; liveSessions: Set<string>;
};

/**
 * make_new_record's ensure ladder (tap-x077): the requested handle is seated or
 * its exact tmux name is live. Gone seats are absorbed without a prompt; live,
 * busy, attached-shell and unobservable incumbents reach a chooser on a
 * terminal and a refusal (exit 2) without one. [r] delegates to resume and
 * never returns here.
 */

/** [r]'s disclosed tier for a collision. An attachable session reattaches on [r]
 * before any stale-store refusal, so it keeps the reattach tier; only a stopped
 * cursor seat with a stored id and no store reaches the refusal ("stale"). The
 * attachable predicate matches resume's sessionAttachable: any present session
 * except a shell or a gone seat. [r] resumes the INCUMBENT, so the tier is the incumbent's. */
export function collisionReviveTier(incumbentHarness: string, storedId: string | null, recordResumable: boolean,
  present: boolean, classification: string): string {
  const attachable = present && attachableState(classification);
  return seatReviveTier(incumbentHarness, storedId, recordResumable, attachable);
}
async function ensureLadder(args: Resolved, deps: LaunchDeps, inputs: LadderInputs): Promise<LadderOutcome> {
  const { state, cwd, base, root, tag, requestedName: name, presetDerived, seated, existingRecord } = inputs;
  const existingEntry = registryEntry(root, tag);
  // Recovery launch commands must retain the preset selection.
  const launchTarget = presetDerived ? tag : args.harness;
  const scoped = state.sessions.filter(record => pathIsUnder(record.cwd, root));
  // The picker's "different handle" door must never offer the incumbent name again.
  const liveOrSeated = await occupiedSessionNames(base, root);
  const occupied = new Set([...liveOrSeated, name, ...scoped.map(record => record.name),
    ...scoped.map(record => sessionNameForHandle(base, launchHandle(record)))]);
  const nextName = allocateName(base, args.harness, tag, occupied, presetDerived);
  const nextHandle = slashHandle(nextName, base) || tag;
  const incumbentHarness = existingRecord?.harness ?? (typeof existingEntry?.harness === "string" && existingEntry.harness
    ? existingEntry.harness : args.harness);
  // A roster seat is live only while its own harness runs; crew windows hold a session, not a seat (tap-9rrat).
  const classification = !inputs.live ? "absent" : await classifySession(name, process.env, undefined,
    seated ? { harness: incumbentHarness, crewPanes: crewPanesIn(state.entries, name) } : undefined);
  let aliveElsewhere: string | null = null;
  if (existingEntry !== null) {
    const verified = await verifiedSession(existingEntry, process.env);
    if (verified !== null && verified !== name) aliveElsewhere = verified;
  }
  const entryDead = existingEntry !== null && await entryObservedDead(existingEntry, process.env);
  // tap-u3bl: [r]'s disclosed tier comes from the same resumability gate the launch uses.
  // tap-we6b rework: a recorded id that failed the artifact probe is not a fresh
  // start either — [r] refuses it, so the chooser must not label the seat "fresh".
  const recordResumable = existingRecord !== null && recordHasResumeArtifact(existingRecord);
  // Only cursor's resume doors refuse a stale id; other harnesses keep their
  // own per-harness tier (claude still opens its native picker).
  const reviveTierWord = collisionReviveTier(incumbentHarness, existingRecord?.harness_session_id ?? null, recordResumable,
    inputs.live, classification);
  const entryAddress = () => String(existingEntry?.pane || existingEntry?.pane_id || "no pane on record");
  const undeadFoundState = (): string => {
    if (classification === "shell") return "an unattended shell session is holding the name";
    if (entryDead) return `a gone seat row (${entryAddress()})`;
    if (existingRecord !== null) return "a stopped session record, no live pane";
    return "the name is registered but its session is gone";
  };
  const rosterHandle = seated ? tag : null;
  const incumbentAge = (): string | null => {
    if (existingRecord !== null) return relativeAge(existingRecord.last_seen || existingRecord.last_launched);
    if (existingEntry !== null) return relativeAge(stamp(existingEntry.exited_at) || stamp(existingEntry.last_seen));
    return null;
  };
  // grok P2: the chooser gates on both streams, the predicate attach mode uses.
  // --json never asks: the collision refuses with its structured error, so stdout
  // stays one object (CLI-FLAG-2) and an [f] fork cannot run without --json.
  const json = args.json || process.env.TAP_JSON === "1";
  const interactive = () => deps.hasTty() && !args.dry_run && !json;
  // A terminal that --json kept from asking: where the no-terminal fallbacks would act
  // (a shell reseat replaces a session), the flag must not authorize them (tap-wj35h).
  const jsonDeclined = deps.hasTty() && !args.dry_run && json;
  // [f] runs `tap session fork`; it is enabled exactly when planFork's checks of
  // the row (harness, stored flags, conversation identity) would pass.
  // The conversation the menu offered to fork, so the [f] arm can refuse a source
  // that changed while the name prompt waited (planFork's own post-chooser check).
  const forkIdentity = (row: Record<string, unknown> | null | undefined): string | null => {
    if (!row) return null;
    const source = recordFromRow(tag, row, state.team as Record<string, unknown>, root);
    const id = source ? resolvedResumeIdentity(source, process.env) : null;
    return id && forkSourceFingerprint(row, id);
  };
  const forkUnavailable = (): ForkUnavailable => {
    const row = state.entries.get(tag);
    if (!row) return NOT_A_SEAT;
    const harness = String(row.harness ?? "");
    if (!FORKABLE_HARNESSES.includes(harness)) return "harness cannot fork";
    const conflict = storedForkConflict(harness, row);
    if (conflict) return `uses ${conflict}`;
    const source = recordFromRow(tag, row, state.team as Record<string, unknown>, root);
    return source && resolvedResumeIdentity(source, process.env) ? null : "no saved chat to fork";
  };
  // Only a chooser's [n] asks for the name; --new and automatic suffixing keep the allocated one.
  let chosen = false;
  const prompted = (answer: string): string => { chosen = true; return answer; };

  let choice: string;
  if (args.new) choice = "n";
  // Explicit stop authority; the transaction still refuses a conflicting live target.
  else if (args.fresh) choice = "k";
  // Only observed-gone preset rows keep automatic suffixing (tap-7r3fn.131).
  else if (presetDerived && entryDead) choice = "n";
  else if (aliveElsewhere !== null) {
    // Fork protection: the handle verifiably lives in another session.
    if (interactive()) {
      choice = prompted(promptSessionExists(deps.choose, name, incumbentHarness,
        describeSessionState(`live in ${aliveElsewhere}`, rosterHandle, null), null, forkUnavailable()));
    } else {
      printSessionExists(tag, launchTarget, `${tag} is live in ${aliveElsewhere}`, nextHandle, json);
      throw new Exit(2);
    }
  } else if (classification === "seat-gone") {
    // tap-9rrat: the seat's harness exited while crew windows hold its session.
    // [r] revives it beside them in a new window; nothing is stopped.
    const held = `${incumbentHarness} exited; other windows still hold the session`;
    if (!interactive()) {
      printSessionExists(tag, launchTarget, `${name}: ${held}; revive it with tap session resume ${tag}`, nextHandle, json);
      throw new Exit(2);
    }
    choice = prompted(promptNewCollision(deps.choose, name, incumbentHarness, describeSessionState(held, rosterHandle, incumbentAge()),
      existingRecord !== null ? reviveTierWord : "fresh", forkUnavailable()));
    // Only the recordless seat reseats; a recorded one keeps [r] on resume.
    if (choice === "r" && existingRecord === null) choice = "k";
  } else if (classification === "shell" && !presetDerived && (existingRecord === null || existingRecord.harness === args.harness)) {
    // A live shell holds the name: reseat fresh (create-intent, no history restore).
    if (jsonDeclined) {
      printSessionExists(tag, launchTarget, `${name} is held by an unattended shell session`, nextHandle, json);
      throw new Exit(2);
    }
    choice = interactive()
      ? prompted(promptNewCollision(deps.choose, name, incumbentHarness, describeSessionState(undeadFoundState(), rosterHandle, incumbentAge()), "fresh",
        forkUnavailable()))
      : "k";
    if (choice === "r") choice = "k";
  } else if (classification === "live" && !seated) {
    // Live tmux, no roster row: a tmux-namespace collision; create never offers resume.
    const createdLabel = tmuxSessionCreatedLabel(name);
    if (interactive()) choice = prompted(promptOffRosterTmuxCollision(deps.choose, name, incumbentHarness, createdLabel));
    else {
      printOffRosterTmuxExists(name, launchTarget, tag, nextHandle, createdLabel, json);
      throw new Exit(2);
    }
  } else if (entryDead && interactive()) {
    // A gone row still occupies the name and launch reseats it (tap-jcma):
    // the reseat chooser, whose [r] relaunches, not the attach chooser.
    choice = prompted(promptNewCollision(deps.choose, name, incumbentHarness,
      describeSessionState(undeadFoundState(), rosterHandle, incumbentAge()), existingRecord !== null ? reviveTierWord : "fresh",
      forkUnavailable()));
    // Only the recordless gone row reseats; a recorded one keeps [r] on resume.
    if (choice === "r" && existingRecord === null) choice = "k";
  } else if (interactive()) {
    let liveDesc: string | null = null;
    if (classification === "live") {
      const attached = sessionAttached(name);
      const nature = attached === null ? "live" : attached ? "live, attached" : "live, running detached";
      liveDesc = describeSessionState(nature, rosterHandle, null);
    }
    // tap-7r3fn.24: with no record, [r] can only start fresh; say so before the press.
    choice = prompted(promptSessionExists(deps.choose, name, incumbentHarness, liveDesc, existingRecord !== null ? reviveTierWord : "fresh",
      forkUnavailable()));
  } else {
    const stopped = entryDead && (classification === "absent" ||
      classification === "unknown" && !tmuxSessionsForNamespace().has(name));
    if (stopped) printStoppedSession(tag, launchTarget, name, json);
    else printSessionExists(tag, launchTarget, `${name} already exists`, nextHandle, json);
    throw new Exit(2);
  }

  if (choice === "r") {
    refuseTuningOnResumeDelegation(args, "the collision chooser's resume arm");
    handOffLaunchProgress();
    throw new Exit(await cmdSessionResume([...(args.dry_run ? ["--dry-run"] : []), "--", incumbentHarness, tag], deps.scriptDir));
  }
  if (choice === "n" && !chosen) return { choice, nextName, handle: nextHandle };
  if (choice === "n" || choice === "f") {
    // The handle the chooser's arm launches: a seat name, free on this team and in tmux.
    const seats = unexpiredSeats(root, inputs.liveSessions);
    const check: NameCheck = handle => {
      if (!handle) return "enter a name";
      if (!validToken(handle)) return `'${handle}' must use letters, digits, '.', '_' or '-'`;
      if (/^\d+$/.test(handle)) return `'${handle}' is a resume index; a new name needs a letter`;
      if (reservedSeatName(handle)) return `'${handle}' ${reservedSeatName(handle)}`;
      if (HARNESSES.includes(handle)) return `'${handle}' names a harness; choose a seat name`;
      // Taken as a direct launch sees it: a seat or a live session. A leftover record
      // off the roster is not (launch ignores it aloud), unlike suffix allocation.
      const session = sessionNameForHandle(base, handle);
      if (seats.has(handle) || liveOrSeated.has(session) || session === name) return `'${handle}' is taken`;
      return null;
    };
    const askName: AskName = deps.askName ?? promptName;
    const ask = async (question: string, suffix: string): Promise<string> => {
      const prefix = suffix.startsWith(`${tag}-`) ? `${tag}-` : "";
      const handle = await askName(question, prefix, suffix.slice(prefix.length), check);
      // Esc or the end of input: quit, nothing changed.
      if (handle === null) throw new Exit(2);
      return handle;
    };
    if (choice === "n") {
      const handle = await ask("Enter a name for the new session: ", nextHandle);
      return { choice, nextName: handle === nextHandle ? nextName : sessionNameForHandle(base, handle), handle };
    }
    const reason = forkUnavailable();
    if (reason !== null) throw new LauncherError(`fork unavailable: ${reason}`, "fork_unavailable", `tap session fork ${tag} --dry-run`, `[f] cannot fork '${tag}': ${reason}`);
    refuseTuningOnResumeDelegation(args, "the collision chooser's fork arm", "a fork replays its source's recipe");
    // The fingerprint is taken before the prompt waits: resolving it afterwards
    // could follow a changed fallback (a claude transcript appearing) on both sides.
    const offered = forkIdentity(state.entries.get(tag));
    const handle = await ask("Enter a name for the fork: ", `${tag}-fork`);
    if (forkIdentity(registryEntry(root, tag)) !== offered) {
      throw new LauncherError(`seat '${tag}' changed`, "fork_source_changed", `tap session fork ${tag} ${handle}`,
        `seat '${tag}' was cleared, restarted or replaced while the fork was being chosen; nothing was launched`);
    }
    handOffLaunchProgress();
    // The fork plans from its own registry read; the checked source travels with it, so a
    // row that changes after this check is refused there too rather than forked.
    const fork = deps.fork ?? (async (argv: string[], expectedSource: string) =>
      (await import("./fork")).cmdSessionFork(argv, deps.scriptDir, { expectedSource }));
    throw new Exit(await fork(["--", tag, handle], offered!));
  }
  if (choice !== "k") throw new Exit(2);
  // [k] is explicit replacement authority: stop by canonical
  // name; backup-before-stop supplies the recovery boundary.
  const receipts: string[] = [];
  const replacement: Replacement = {
    kill_backup_required: true, replaces_session: name, replaces_manifest_session: existingRecord?.name ?? null,
  };
  if (existingRecord !== null) {
    const history = [...existingRecord.history ?? []];
    const previous = existingRecord.harness_session_id;
    if (previous && !history.includes(previous)) history.push(previous);
    replacement.history = history;
    replacement.replacement_record = durableRecord(existingRecord);
    if (recordResumable && previous) {
      receipts.push(`reseated ${name} fresh (previous ${existingRecord.harness} conversation ${previous} kept in history)`);
    }
  }
  if (entryDead) receipts.push(`reclaimed dead seat row '${tag}' (${entryAddress()})`);
  return { choice: "k", replacement, receipts };
}

const stamp = (value: unknown): string | null => typeof value === "string" && value ? value : null;

/** make_new_record: name, collision decision and tuning for a fresh seat. */
export async function makeNewRecord(args: Resolved, state: RegistryState, cwd: string, deps: LaunchDeps): Promise<LaunchRecord> {
  if (args.unique && args.fresh) throw new LauncherError("--fresh is not supported with --unique exact session names");
  const intended = intendedTarget(args, state, cwd);
  const { base, presetDerived } = intended;
  const root = rootForCwd(cwd);
  const liveSessions = tmuxSessionsForNamespace();
  let name: string, tag: string | null, index: number | null;
  let existingRecord: LaunchRecord | null = null;
  let replacement: Replacement | null = null;
  const receipts: string[] = [];
  if (args.unique) {
    name = intended.name!;
    tag = intended.tag;
    index = null;
  } else {
    tag = intended.tag;
    if (tag) {
      const requestedName = intended.name!;
      name = requestedName;
      index = 1;
      existingRecord = findRecordByKey(state.sessions, cwd, tag);
      const seated = unexpiredSeats(root, liveSessions).has(tag);
      const live = liveSessions.has(name);
      if (live || seated) {
        const outcome = await ensureLadder(args, deps, {
          state, cwd, base, root, tag, requestedName, presetDerived, seated, live, existingRecord, liveSessions,
        });
        if (outcome.choice === "n") {
          name = outcome.nextName;
          const suffix = name.startsWith(`${requestedName}-`) ? name.slice(requestedName.length + 1) : name;
          index = /^\d+$/.test(suffix) ? Number(suffix) : 1;
          // A name that is not exactly this seat's numbered sibling is a seat of its own, so the
          // record's handle is the name's: a sanitized allocation (`review.er` → `review-er`)
          // or a typed name never registers under the incumbent's handle.
          if (!(index > 1 && outcome.handle === `${tag}-${index}`)) { tag = outcome.handle; index = 1; }
        } else {
          replacement = outcome.replacement;
          receipts.push(...outcome.receipts);
        }
      } else if (existingRecord !== null) {
        err(`tap session: ignoring leftover record ${name} — not on roster; launch creates a new seat (tap session resume ${tag} to restore history)`);
      }
    } else {
      name = allocateName(base, args.harness, null, await occupiedSessionNames(base, root));
      index = allocatedIndex(name, base, args.harness);
    }
  }
  const tuning = args.preset_resolution === null ? resolveAdhocTuning(args) : null;
  const [model, harnessPassthrough, harnessEnv, preset, passthroughFromConfig] = resolveRecordTuning({
    preset: args.preset_resolution, inherited: null, tuning, model: args.model, harness: args.harness,
  }) as [string | null, string[], Record<string, string>, LaunchRecord["preset"], boolean];
  const record = withRecordDefaults({
    name, harness: args.harness, cwd, base, tag, index, model,
    harness_passthrough: harnessPassthrough, passthrough_from_config: passthroughFromConfig, harness_env: harnessEnv,
    preset, ensure_action: "new", ensure_receipts: receipts,
    // A picker launch mints no id: the picked conversation's SessionStart supplies it. An exact one carries the given id.
    ...(args.resume ? { harness_session_id: null, launch_resume: "picker" as const }
      : args.resume_id !== null ? { harness_session_id: args.resume_id, launch_resume: "exact" as const }
      : { harness_session_id: freshLaunchSessionId(args.harness) }),
    ...(replacement ?? {}),
  } as LaunchRecord);
  return { ...record, ...applyOverrides({ harness_env: record.harness_env, harness_unset_env: record.harness_unset_env,
    harness_tail: record.harness_tail }, overridesOf(args)) };
}

/** cmd_new. */
async function cmdNew(args: NewArgs, cwd: string, notices: Notices, deps: LaunchDeps, trace: { active: boolean }): Promise<number> {
  const resolved = resolveNewPresetArgs(args, notices);
  if (resolved.preset_resolution === null && newLabelRequestsResume(resolved) && !resolved.fresh) {
    refuseTuningOnResumeDelegation(resolved, "a numeric-label resume");
    handOffLaunchProgress();
    // cmd_resume's typed argv; an inactive capsule, as the Python door handed over before activation.
    process.env.TAP_STARTUP_TRACE_CONTEXT = JSON.stringify({ active: false, fields: {} });
    return cmdSessionResume([...(resolved.dry_run ? ["--dry-run"] : []), ...(resolved.json ? ["--json"] : []), "--", resolved.harness, resolved.label!], deps.scriptDir);
  }
  // Everything argv alone decides is decided before the first effect (launcher.py cmd_new).
  refuseResumeWithoutPicker(resolved, resolved.harness);
  // Read-only: an exact id another seat holds refuses before the lifecycle journal, before any bootstrap
  // of an unenrolled root, and before the record. An unenrolled root reads as an empty cohort here; the
  // enrolled registries are still scanned through the global index.
  if (resolved.resume_id !== null) {
    const seen = registryState(cwd, true);
    assertUniqueResumeIdForLaunch(resolved.resume_id, intendedTarget(resolved, seen, cwd), seen, rootForCwd(cwd));
    refuseMissingExactConversation(resolved, rootForCwd(cwd));
  }
  resolveAdhocTuning(resolved);
  applyOverrides({}, overridesOf(resolved));
  const workdir = resolved.workdir === null ? undefined : validateLaunchWorkdir(rootForCwd(cwd), resolved.workdir);
  if (!resolved.dry_run) {
    requireLaunchCommands(resolved.harness);
    beginLifecycleOperation({ verb: "new", cwd: process.cwd(), target: null, boot_id: currentBootId() });
    trace.active = true;
  }
  refuseIfResetFenced(cwd, "session launch");
  refuseIfFlipAuthority(cwd, "tap session launch", true);
  const previewTeam = bootstrapIfUnenrolled(rootForCwd(cwd), resolved.dry_run, resolved.json || process.env.TAP_JSON === "1");
  const state = registryState(cwd, true);
  if (previewTeam) state.team = { ...state.team, name: previewTeam };
  const record = { ...(await makeNewRecord(resolved, state, cwd, deps)), last_launched: timestamp(), ...(workdir === undefined ? {} : { launch_workdir: workdir }) };
  // The ladder may have moved a named target ("n" takes the next free name): the id is rechecked against the
  // seat the transaction will actually reserve, before reservation.
  if (record.launch_resume === "exact") assertUniqueResumeIdForLaunch(record.harness_session_id ?? null, record, state, rootForCwd(cwd));
  return executeFreshLaunch(record, resolved, deps);
}

type Runner = (record: LaunchRecord) => Promise<number>;

/** execute_fresh_launch: the transaction, receipts, then the attach tail. */
async function executeFreshLaunch(record: LaunchRecord, args: NewArgs, deps: LaunchDeps): Promise<number> {
  const attach = args.attach || callerHasTty();
  const rc = await deps.run(record);
  if (args.dry_run) return rc;
  if (rc !== 0) return rc;
  if (record.harness === "opencode" && record.model?.includes("/")) {
    // Best effort: a seat that launched is never failed by a missing or slow `opencode models`.
    launchPhase("Reading model context window");
    try { (deps.captureModelWindow ?? captureModelWindow)(record.model, record.launch_workdir ?? record.cwd); } catch { /* the roster shows an unknown window */ }
  }
  launchPhasesDone();
  for (const line of record.ensure_receipts ?? []) receipt(line);
  // A notice, so --json (one object, no prose) suppresses it like every other notice.
  if (record.launch_resume === "picker" && !args.json && process.env.TAP_JSON !== "1") receipt(`${record.name}: pick the conversation in ${record.harness}'s picker; TAP binds it as this seat's identity when the harness's SessionStart runs${record.harness === "codex" ? " (Codex: once its hooks are trusted)" : ""}; tap whoami then shows the handle, and the seat's harness_session_id in .tap/team-registry.json is the picked conversation; if nothing binds, run tap in from that seat`);
  if (!attach) { receipt(detachedReceipt(record.name, "no controlling terminal", `${record.base}/${launchHandle(record)}`)); return 0; }
  return attachTailInProcess("launch", record);
}

/** The launch door's effects a test may script (the collision chooser's terminal and the transaction),
 *  plus the installed scripts tree every resume hand-off runs from. */
export interface LaunchDeps {
  run: Runner;
  hasTty: () => boolean;
  choose: Choose;
  scriptDir: string;
  /** The [n]/[f] name prompt; promptName by default. */
  askName?: AskName;
  /** The [f] arm: `tap session fork` with this argv; cmdSessionFork by default. */
  fork?: (argv: string[], expectedSource: string) => Promise<number>;
  /** Record an OpenCode seat's model window in the persisted map (tap-8me26); captureModelWindow by default. */
  captureModelWindow?: (model: string, directory: string) => unknown;
}

export async function cmdSessionLaunch(argv: string[], scriptDir = SCRIPTS, overrides: Partial<LaunchDeps> = {}): Promise<number> {
  const jsonRequested = process.env.TAP_JSON === "1" || argv.includes("--json");
  const notices = new Notices();
  notices.suppress(jsonRequested);
  const passthroughWarnings: string[] = [];
  const args = parseLaunchCommand(argv, message => { passthroughWarnings.push(message); });
  if (typeof args === "number") return args;
  if (!jsonRequested) for (const warning of passthroughWarnings.splice(0)) process.stderr.write(`${warning}\n`);
  const cwd = realOrSelf(process.cwd());
  let stderrTty = false;
  try { stderrTty = process.stderr.isTTY === true; } catch { /* no terminal */ }
  const run: Runner = record => withLaunchSignals(async signal => {
    const result = await launchTransaction({ kind: "new", record: cloneRecord(record), dry_run: args.dry_run, json: args.json,
      output_path: callerTty(), terminal: { stderr_tty: stderrTty }, script_dir: scriptDir }, process.env, signal, notices);
    Object.assign(record, result.record);
    return result.code;
  });
  // Dry runs are untraced; a real launch opens its operation on launch_start
  // (the incumbent's deferred begin, activated by require_launch_commands).
  return withStartupTrace(async () => {
    const trace = { active: false };
    let code = 1;
    const deps: LaunchDeps = { run, hasTty: callerHasTty, choose: promptChoice, scriptDir, ...overrides };
    // Phase lines settle (✗ names the failed phase) before the error renders.
    // The parsed --json, not an occurrence in the harness's argument tail.
    const progress = progressMode(stderrTty, args.json || args.dry_run);
    try { code = await withLaunchProgress(progress, () => { launchPhase("Loading TAP config"); return cmdNew(args, cwd, notices, deps, trace); }); }
    catch (error) { code = render(error, jsonRequested); }
    if (trace.active) startupTrace(code === 0 ? "launch_complete" : "launch_failure", { exit_code: code });
    if (code === 0) for (const warning of passthroughWarnings) process.stderr.write(`${warning}\n`);
    return code;
  }, undefined, scriptDir);
}

if (import.meta.main) await exitKeepingTerminal(await cmdSessionLaunch(process.argv.slice(2)));
