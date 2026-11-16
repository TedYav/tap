import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { readStdinByte } from "../stdin-byte";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Bus, BUS_AUTHORITY_MARKER } from "../bus";
import { oldBusRefusal, resolveBus } from "../bushome";
import { acquireRegistryLock } from "../panelock";
import { enrollmentAtFromDoc, loadGlobalRegistry, globalRegistryPath } from "../index-home";
import { ensureRepoCharter, repoCharterAppend, repoCharterLock } from "../first-run";
import { ignoreTap, tapIgnoreNeeded } from "../init-ignore";
import { folderTrustTargets, folderTrustPath, folderTrustGrant, prepareFolderTrust, trustFolder, type FolderTrustResult, type FolderTrustTarget } from "../folder-trust";
import { InitEffects, type InitChange } from "../init-receipt";
import {
  bootstrapPostflipEnroll, bornLiveBootstrap, enrollTeam, enrollmentWouldChange, currentShapedStore, teamRegistryFileRefusal, legacyAgentsAxisStore, oldStoreAction, oldStoreEvidence, oldStoreRefusalText,
  derivedTeamNotice, newEnrollmentRefusal, unownedInitStateRefusal, probeGitRoot, seatedBusRegistry, teamNameForRoot, teamOverrideRefusal, teamRegistryPath, unenrolledSeatsRefusal, writeEmptyTeamRegistry,
} from "../register-authority";

export class InitRefusal extends Error {
  constructor(readonly errorClass: string, readonly action: string, readonly detail: string) { super(detail); }
}

export interface InitOptions {
  /** The operator already agreed to initialise a directory outside git. */
  yes: boolean;
  /** Machine output: never prompt. */
  json: boolean;
  /** First `tap session launch`: refuse linked worktrees and nested non-git folders. */
  forLaunch: boolean;
  /** Decide every refusal, write nothing. */
  dryRun: boolean;
  /** Never offer or write the project instructions. */
  noInstructions?: boolean;
  /** `--team <name>`: the name a new enrollment uses; empty derives it from the folder. */
  team?: string;
}

export interface InitOutcome {
  team: string;
  root: string;
  bus: string;
  inGit: boolean;
  already: boolean;
  /** The folder name a derived team name came from. */
  derivedFrom?: string;
  /** Recovery writes the stored registry location, without bootstrapping another bus. */
  recreateRegistry?: string;
}

function git(cwd: string, ...args: string[]): string | undefined {
  const result=spawnSync("git",["-C",cwd,...args],{encoding:"utf8"});
  return result.status===0 ? result.stdout.trim() : undefined;
}

function ask(question: string): boolean {
  process.stderr.write(question);
  const byte=Buffer.alloc(1);let answer="";
  while(readStdinByte(byte)>0 && byte[0]!==10)answer+=byte.toString();
  return /^(y|yes)$/i.test(answer.trim());
}

function interactive(opts: InitOptions): boolean {
  return !opts.json && !!process.stdin.isTTY && !!process.stderr.isTTY;
}

/** A folder outside git is initialised only on explicit consent. */
function confirmNonGit(root: string, opts: InitOptions): void {
  const retry = opts.forLaunch ? "then rerun tap session launch" : "or cd into a git repository";
  if (opts.yes) {
    process.stderr.write(`tap init: ${root} is not a git repository; initializing TAP here (--yes)\n`);
    return;
  }
  if (interactive(opts)) {
    if (ask(`tap init: ${root} is not a git repository — initialize TAP here anyway? [y/N] `)) return;
    throw new InitRefusal("confirmation_declined", `run tap init --yes in ${root}, ${retry}`, `${root} is not a git repository and initializing it was declined`);
  }
  throw new InitRefusal("confirmation_required", `run tap init --yes in ${root}, ${retry}`, `${root} is not a git repository and nothing confirmed initializing TAP there`);
}

/** Outside git there is no checkout boundary: an enrolled ancestor owns this folder. */
function enrolledAt(root: string, inGit: boolean, snap: ReturnType<typeof loadGlobalRegistry>) {
  if(snap.marker==="invalid")return {status:"invalid"} as const;
  if(snap.marker!=="live" || !snap.doc)return {status:"missing"} as const;
  let dir=root;
  for(;;){
    const at=enrollmentAtFromDoc(snap.doc,dir);
    if(at.status!=="missing" || inGit)return at;
    const parent=dirname(dir);
    if(parent===dir)return at;
    dir=parent;
  }
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

const retryVerb=(opts: InitOptions): string=>opts.forLaunch ? "tap session launch" : "tap init";

/** Only successful creation/recreation owns the first-team instruction offer. */
function completeInitialization(outcome: InitOutcome, opts: InitOptions): InitOutcome {
  if (opts.dryRun || opts.noInstructions || outcome.already || process.env.TAP_SETUP_REPO_PENDING === "1") return outcome;
  try { if (!repoCharterAppend(outcome.root)) return outcome; }
  catch { signpostHeadsUp(); return outcome; }
  let create = true;
  // --yes answers every question this command would ask, the signpost included.
  if (!opts.yes && interactive(opts)) {
    process.stderr.write(existsSync(join(outcome.root, "AGENTS.md"))
      ? "AGENTS.md exists — append the TAP signpost? [Y/n] "
      : "No AGENTS.md here — create one with the TAP signpost? [Y/n] ");
    const byte = Buffer.alloc(1); let answer = ""; let newline = false;
    while (readStdinByte(byte) > 0) { if (byte[0] === 10) { newline = true; break; } answer += byte.toString(); }
    // The affirmative default belongs to a completed empty line (Enter), never
    // to a terminal that ended mid-prompt: EOF/EIO is absent consent, and
    // applying the default there would write AGENTS.md because the pane died.
    if (!newline || !/^(y|yes|n|no)?$/i.test(answer.trim())) throw new InitRefusal("confirmation_required", `run tap setup --repo when ready`, `no completed yes/no signpost answer; no AGENTS.md was written`);
    create = !/^(n|no)$/i.test(answer.trim());
  }
  if (create) ensureRepoCharter(outcome.root, outcome.inGit, signpostHeadsUp);
  else console.error("tap init: project signpost skipped; run tap setup --repo when ready.");
  return outcome;
}

function signpostHeadsUp(): void {
  console.error("tap: AGENTS.md has no readable TAP signpost; run tap setup --repo.");
}


export function initRoot(cwd: string, opts: InitOptions): InitOutcome {
  const invalidTeam=teamOverrideRefusal(opts.team ?? "");
  if(invalidTeam)throw new InitRefusal(invalidTeam.errorClass,invalidTeam.action,invalidTeam.detail);
  const probe=probeGitRoot(cwd);
  if(probe.kind==="unobservable")throw new InitRefusal("git_unobservable","make `git rev-parse --show-toplevel` work here (install git or repair the repository), then retry",`cannot tell whether ${cwd} is inside a git repository: ${probe.detail}`);
  const inGit=probe.kind==="repo",root=realpathSync(inGit ? probe.top : cwd),bus=join(root,".tap/bus");
  // Init decides for THIS root's canonical bus, never an ambient TAP_HOME.
  const env: NodeJS.ProcessEnv={...process.env,TAP_HOME:bus};
  const indexHome=env.TAP_INDEX_HOME;

  const snap=loadGlobalRegistry(indexHome);
  const enrolled=enrolledAt(root,inGit,snap);
  if(enrolled.status==="invalid")throw new InitRefusal("invalid_flip","tap doctor","global-registry.json is present but unreadable or wrong schema");
  if(enrolled.status==="ambiguous")throw new InitRefusal("ambiguous_team","tap doctor",`more than one enrolled team claims ${root}`);
  if(resolveBus(root,{}).rule==="old_store"){
    const refusal=oldBusRefusal(bus);
    throw new InitRefusal(refusal.errorClass,refusal.action,refusal.detail);
  }
  if(enrolled.status==="ok" || enrolled.status==="unreachable"){
    if(opts.forLaunch && enrolled.rootReal!==root)throw new InitRefusal("nested_team_root",`cd ${enrolled.rootReal}, then rerun tap session launch`,`${root} is inside team '${enrolled.name}' at ${enrolled.rootReal}`);
    if(enrolled.status==="ok"){
      const loc=enrolled.registryLocation;
      if(legacyAgentsAxisStore(loc))throw new InitRefusal("old_store",oldStoreAction("agents_axis"),oldStoreRefusalText(loc,"agents_axis"));
      if(!currentShapedStore(loc)){
        const old=teamRegistryFileRefusal(loc);
        if(old)throw new InitRefusal(old.errorClass,old.action,old.detail);
        throw new InitRefusal("registry_invalid","tap doctor",`${loc} is not a current {"schema":"0.20","team":{...},"seats":{...}} team registry`);
      }
    }
    if(enrolled.status==="ok")return {team:enrolled.name,root:enrolled.rootReal,bus:join(enrolled.rootReal,".tap/bus"),inGit,already:true};
    // Enrolled but its registry is gone: recreate it where the index says, under the enrolled name.
    const loc=enrolled.registryLocation;
    if(!loc)throw new InitRefusal("registry_unreachable","tap doctor",`team '${enrolled.name}' is enrolled without a registry_location`);
    // Only a registry that is truly gone is recreated; an unreadable or
    // non-file entry at the stored path is someone's bytes, never overwritten.
    const unreachable=()=>new InitRefusal("registry_unreachable",`fix ${loc} (it exists but is not a readable regular file), then retry`,`the enrolled registry for team '${enrolled.name}' at ${loc} is unreadable`);
    if(existsSync(loc) || isSymlink(loc))throw unreachable();
    if(opts.dryRun)return {team:enrolled.name,root:enrolled.rootReal,bus:join(enrolled.rootReal,".tap/bus"),inGit,already:false,recreateRegistry:loc};
    try {
      mkdirSync(dirname(loc),{recursive:true});
      const lock=acquireRegistryLock(loc,Infinity);
      if(!lock)throw new InitRefusal("registry_busy","retry",`could not lock ${loc}`);
      try {
        if(existsSync(loc) || isSymlink(loc))throw unreachable();
        writeEmptyTeamRegistry(loc,enrolled.name,enrolled.rootReal);
      } finally { lock.release(); }
    } catch(error) {
      if(error instanceof InitRefusal)throw error;
      throw new InitRefusal("registry_unreachable","tap doctor",`could not recreate ${loc}: ${(error as Error).message}`);
    }
    // Re-enroll under the index ladder after publishing, as registration does:
    // a gone-team purge that raced the recreation must not leave this live
    // registry de-enrolled (purgeGoneEnrollment relies on this writer contract).
    const reenrolled=enrollTeam(enrolled.rootReal,loc,env,{authorizedInitRoot:enrolled.rootReal,team:enrolled.name});
    if(!reenrolled.ok || reenrolled.skipped)throw new InitRefusal("enroll_failed","tap doctor",`recreated ${loc} but could not re-enroll team '${enrolled.name}': ${reenrolled.ok ? "root is not indexable" : reenrolled.detail}`);
    return completeInitialization({team:enrolled.name,root:enrolled.rootReal,bus:join(enrolled.rootReal,".tap/bus"),inGit,already:false}, opts);
  }

  // A new enrollment: every refusal is decided before the first write.
  if(snap.marker==="absent"){
    const evidence=oldStoreEvidence(indexHome || join(env.HOME!,".tap"),bus,teamRegistryPath(root),env);
    if(evidence.length>0)throw new InitRefusal("old_store",oldStoreAction(evidence[0]!.kind),oldStoreRefusalText(evidence[0]!.path,evidence[0]!.kind));
    // Refuse, never adopt: enrolling would start a new team-registry.json beside these seats.
    const seated=seatedBusRegistry(bus);
    if(seated){const u=unenrolledSeatsRefusal(seated,root,retryVerb(opts));throw new InitRefusal(u.errorClass,u.action,u.detail);}
  }
  if(opts.forLaunch && inGit && git(root,"rev-parse","--path-format=absolute","--git-dir")!==git(root,"rev-parse","--path-format=absolute","--git-common-dir")){
    throw new InitRefusal("linked_worktree","launch from your enrolled team's root, or run tap init here to make this worktree its own team",
      `launch would create a team for linked worktree ${root}; refusing implicit enrollment`);
  }
  const authorization={authorizedInitRoot:root,team:opts.team};
  const refusal=newEnrollmentRefusal(root,env,authorization);
  if(refusal)throw new InitRefusal(refusal.errorClass,refusal.action,refusal.detail);
  const unowned = unownedInitStateRefusal(root);
  if(unowned)throw new InitRefusal(unowned.errorClass,unowned.action,unowned.detail);
  // A dry run writes nothing, so the real launch asks for consent itself.
  if(opts.dryRun){
    const chosen=teamNameForRoot(root,opts.team);
    return {team:chosen.ok ? chosen.team : "",root,bus,inGit,already:false,derivedFrom:chosen.ok ? chosen.derivedFrom : undefined};
  }
  if(!inGit)confirmNonGit(root,opts);

  if(inGit){
    try { ignoreTap(root); }
    catch(error) { throw new InitRefusal("gitignore_failed","fix the repository .gitignore, then rerun tap init",`could not ignore .tap/: ${(error as Error).message}`); }
  }
  // Init's receipt covers bootstrap only. A detached maintenance worker would
  // otherwise create additional paths after the receipt has been printed.
  try { new Bus(bus).ensureDirs(false); }
  catch(error) {
    const e=error as Error & {tapErrorClass?: string; tapAction?: string};
    throw new InitRefusal(e.tapErrorClass ?? "bus_unwritable",e.tapAction ?? "tap doctor",e.message);
  }
  const born=bornLiveBootstrap(root,env,authorization);
  if(born.status==="refusal"){
    const r=born.refusal;
    if(r.kind==="old_store" && r.path && r.store)throw new InitRefusal("old_store",oldStoreAction(r.store),oldStoreRefusalText(r.path,r.store));
    if(r.kind==="unenrolled_seats" && r.path){const u=unenrolledSeatsRefusal(r.path,root,retryVerb(opts));throw new InitRefusal(u.errorClass,u.action,u.detail);}
    if(r.kind==="invalid_marker")throw new InitRefusal("invalid_flip","tap doctor","global-registry.json is present but unreadable or wrong schema");
    throw new InitRefusal("born_live_unavailable","tap doctor",r.detail ?? "the machine index could not be initialised");
  }
  if(born.status==="not_indexable")throw new InitRefusal("not_indexable","tap doctor",`${root} cannot be enrolled in the machine index`);
  const created=bootstrapPostflipEnroll(root,env,authorization);
  if(!created.ok)throw new InitRefusal(created.errorClass,created.action,created.detail);
  return completeInitialization({team:created.team,root,bus,inGit,already:false,derivedFrom:created.derivedFrom}, opts);
}

function printChanges(changes: InitChange[], undo: string[], dryRun: boolean): void {
  console.log(dryRun ? "tap init: dry run (no writes)" : "tap init: changes");
  if (!changes.length) console.log("  no changes");
  for (const change of changes) console.log(`  ${change.action} ${change.path}`);
  for (const step of undo) console.log(`  undo: ${step}`);
}

function undoSteps(changes: InitChange[], root: string): string[] {
  const steps: string[] = [];
  if (changes.some(change => change.path === join(root, "AGENTS.md"))) {
    steps.push(`remove the block from <!-- tap:begin --> through <!-- tap:end --> (case-insensitive markers) in ${join(root, "AGENTS.md")}; preserve other instructions`);
  }
  if (changes.some(change => change.path === join(root, ".gitignore"))) {
    steps.push(`remove only the .tap/ line added to ${join(root, ".gitignore")}; preserve other ignore rules`);
  }
  if (steps.length) steps.push("tap uninstall removes recorded installation artifacts; project instruction and ignore edits require these manual steps");
  return steps;
}

type Receipt = { changes: InitChange[]; undo: string[]; dry_run: boolean };
function failure(json: boolean, error_class: string, action: string, detail: string, receipt?: Receipt & { initialized?: boolean }): void {
  if(json)console.log(JSON.stringify({ok:false,error_class,action,detail,...receipt}));
  else {
    console.error(`${detail}; next: ${action}`);
    if (receipt) printChanges(receipt.changes, receipt.undo, receipt.dry_run);
  }
}

function initializationEffects(outcome: InitOutcome, opts: InitOptions): InitEffects {
  const effects = new InitEffects();
  if (outcome.already) return effects;
  const root = outcome.root, index = dirname(globalRegistryPath());
  if (!outcome.recreateRegistry) {
    if (outcome.inGit) {
      try { if (tapIgnoreNeeded(root)) effects.add(join(root, ".gitignore"), true); }
      catch (error) { throw new InitRefusal("gitignore_failed", "fix the repository .gitignore, then rerun tap init", `could not ignore .tap/: ${(error as Error).message}`); }
    }
    effects.add(join(outcome.bus, "payloads"));
    effects.add(join(outcome.bus, "receipts"));
    effects.add(join(root, ".tap/.gitignore"));
    effects.add(join(outcome.bus, BUS_AUTHORITY_MARKER));
  }
  const registry = outcome.recreateRegistry || teamRegistryPath(root);
  effects.add(registry);
  effects.add(`${registry}.lock`);
  effects.add(globalRegistryPath(), !outcome.recreateRegistry || enrollmentWouldChange(root, outcome.team, registry));
  effects.add(join(index, "teams.json.lock"));
  effects.add(`${globalRegistryPath()}.lock`);
  if (!opts.noInstructions && process.env.TAP_SETUP_REPO_PENDING !== "1") {
    try {
      if (repoCharterAppend(root)) {
        effects.add(join(root, "AGENTS.md"), true);
        effects.add(repoCharterLock(root));
      }
    } catch { /* Apply leaves unsafe or partial instructions intact, with an advisory. */ }
  }
  return effects;
}

function trustEffects(effects: InitEffects, folder: string, targets: FolderTrustTarget[]): FolderTrustResult[] {
  return targets.map(target => {
    try {
      const path = folderTrustPath(target);
      // Apply creates its parent and persistent lock even for an invalid config.
      effects.add(`${path}.tap-folder-trust.lock`);
      const prepared = prepareFolderTrust(path, folder, target.format);
      effects.add(path, prepared.edited !== prepared.source);
      return { harness: target.harness, status: prepared.edited === prepared.source ? "already_trusted" : "trusted" };
    } catch (error) {
      return { harness: target.harness, status: "failed", detail: (error as Error).message };
    }
  });
}

export function cmdInit(argv: string[], initialize: typeof initRoot = initRoot): number {
  const known=["--json","--yes","--for-launch","--dry-run","--no-trust-folders","--no-instructions"];
  const opts: InitOptions={json:argv.includes("--json"),yes:argv.includes("--yes"),forLaunch:argv.includes("--for-launch"),dryRun:argv.includes("--dry-run"),noInstructions:argv.includes("--no-instructions"),team:""};
  const usage="tap init [--json] [--yes] [--dry-run] [--no-instructions] [--no-trust-folders] [--team <name>]";
  const empty: Receipt = { changes: [], undo: [], dry_run: opts.dryRun };
  const flags: string[]=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]!=="--team"){flags.push(argv[i]!);continue;}
    const value=argv[++i];
    if(!value){failure(opts.json,"usage_error",usage,"--team needs a value",opts.forLaunch ? undefined : empty);return 1;}
    opts.team=value;
  }
  if(flags.some(arg=>!known.includes(arg))){failure(opts.json,"usage_error",usage,"Unknown init argument",opts.forLaunch ? undefined : empty);return 1;}
  const cwd=process.cwd();
  // Internal launch/bootstrap keeps its existing wire and never grants folder trust.
  if (opts.forLaunch) {
    try {
      const outcome = initialize(cwd, opts);
      const notice = !outcome.already && outcome.derivedFrom ? derivedTeamNotice(outcome.team,outcome.derivedFrom) : "";
      if(notice)process.stderr.write(`tap session: ${notice}\n`);
      if(opts.dryRun)console.log(JSON.stringify({ok:true,team:{name:outcome.team,root:outcome.root},already_initialized:outcome.already}));
      else if(!outcome.already)process.stderr.write(`tap session: initialized team '${outcome.team}' at ${outcome.root}\n`);
      return 0;
    } catch (error) {
      if(!(error instanceof InitRefusal))throw error;
      failure(true,error.errorClass,error.action,error.detail);
      return 1;
    }
  }

  let outcome: InitOutcome;
  let effects = new InitEffects();
  try {
    // Resolve and validate against the same authority before inventorying paths.
    outcome = initialize(cwd, { ...opts, dryRun: true });
    effects = initializationEffects(outcome, opts);
  } catch (error) {
    const refusal = error instanceof InitRefusal ? error : new InitRefusal("init_preview_failed", "fix the reported path, then rerun tap init", (error as Error).message);
    failure(opts.json,refusal.errorClass,refusal.action,refusal.detail,empty);
    return 1;
  }
  const receipt = (): Receipt => {
    const changes = effects.changes(opts.dryRun);
    return { changes, undo: undoSteps(changes, outcome.root), dry_run: opts.dryRun };
  };
  const folder = realpathSync(cwd);
  const { targets, failures } = argv.includes("--no-trust-folders") ? { targets: [], failures: [] } : folderTrustTargets(folder);
  const offered = opts.yes || interactive(opts);
  // Observe these exact paths before apply, including partial trust failures.
  const projectedTrust = offered ? [...trustEffects(effects, folder, targets), ...failures] : [];
  let folderTrust: FolderTrustResult[] = [];
  let accepted = opts.yes;
  if (!opts.dryRun) {
    try { outcome = initialize(cwd, opts); }
    catch (error) {
      const initialized = currentShapedStore(outcome.recreateRegistry || teamRegistryPath(outcome.root));
      const r = { ...receipt(), initialized };
      if (error instanceof InitRefusal) failure(opts.json,error.errorClass,error.action,error.detail,r);
      else failure(opts.json,"init_failed","tap doctor",`initialization failed: ${(error as Error).message}`,r);
      return 1;
    }
  }
  try {
    if (!opts.dryRun && (targets.length || failures.length) && !accepted && interactive(opts)) {
      process.stderr.write(`Directory: ${folder}\n`);
      for (const target of targets) {
        let path = target.path;
        try { path = folderTrustPath(target); } catch { /* The failed target still needs disclosure. */ }
        process.stderr.write(`${target.harness}: ${path} — ${folderTrustGrant(target, folder)}\n`);
      }
      for (const failed of failures) process.stderr.write(`${failed.harness}: cannot locate trust configuration (${failed.detail})\n`);
      process.stderr.write("Grants each harness's normal folder trust, including project settings and hooks where applicable. Separate approval dialogs are not accepted.\nTrust current directory in installed harnesses Y/n ");
      const byte = Buffer.alloc(1); let answer = ""; let newline = false;
      while (readStdinByte(byte) > 0) { if (byte[0] === 10) { newline = true; break; } answer += byte.toString(); }
      if (!newline || !/^(y|yes|n|no)?$/i.test(answer.trim())) throw new Error("no completed yes/no answer; no folder trust was changed");
      accepted = !/^(n|no)$/i.test(answer.trim());
    }
    if (opts.dryRun) folderTrust = projectedTrust;
    else if (accepted) folderTrust = [...trustFolder(folder, targets), ...failures];
    else if ((targets.length || failures.length) && !opts.json) console.error(interactive(opts)
      ? "tap init: folder trust skipped. Some harnesses may require manual trust before use here. tap init --yes grants it later."
      : `tap init: folder trust skipped (no terminal to ask); next: tap init --yes to trust this folder in ${[...targets,...failures].map(target=>target.harness).join(", ")}.`);
  } catch (error) {
    const r = receipt();
    if (opts.json) console.log(JSON.stringify({ ok: false, error_class: "folder_trust_failed", initialized: !opts.dryRun, folder_trust: folderTrust, action: "rerun tap init to retry folder trust", detail: (error as Error).message, ...r }));
    else failure(false,"folder_trust_failed","rerun tap init to retry folder trust",(error as Error).message,r);
    return 1;
  }
  const grants = targets.flatMap(target => {
    const result = folderTrust.find(result => result.harness === target.harness);
    return result && result.status !== "failed" ? [{ harness: target.harness, path: folderTrustPath(target), setting: folderTrustGrant(target, folder), status: opts.dryRun ? "would_grant" : result.status }] : [];
  });
  const failed = folderTrust.filter(result=>result.status === "failed");
  const r = receipt();
  const previewNote = opts.dryRun ? "Assumes acceptance of terminal offers and any outside-Git consent; --yes accepts them without a terminal. Use --no-instructions or --no-trust-folders to omit them. No locks are acquired; concurrent edits and later write/lock failures cannot be predicted." : undefined;
  const notice = !outcome.already && outcome.derivedFrom ? derivedTeamNotice(outcome.team,outcome.derivedFrom) : "";
  if (notice) (opts.json ? console.error : console.log)(notice);
  const trustReceipt = opts.dryRun ? folderTrust.map(result => result.status === "trusted" ? { ...result, status: "would_trust" } : result) : folderTrust;
  if (opts.json) console.log(JSON.stringify({ok:!failed.length,...(failed.length ? {error_class:"folder_trust_failed",initialized:!opts.dryRun,action:"fix the reported harness configuration, then rerun tap init --yes"} : {}),team:{name:outcome.team,root:outcome.root},bus:outcome.bus,in_git:outcome.inGit,migrated:false,primary_counts:null,late:false,late_counts:null,already_initialized:outcome.already,folder_trust:trustReceipt,folder_trust_grants:grants,...r,...(previewNote ? {preview_note:previewNote} : {})}));
  else {
    if (!opts.dryRun) console.log(outcome.already ? `already initialized: team ${outcome.team}` : `successfully initialized team: ${outcome.team}\nbus: ${outcome.bus}`);
    printChanges(r.changes,r.undo,opts.dryRun);
    for (const grant of grants) console.log(`  ${grant.status} ${grant.harness}: ${grant.path} — ${grant.setting}`);
    if (previewNote) console.log(`  preview: ${previewNote}`);
    for (const result of failed) console.error(`tap init: ${result.harness}: ${result.detail}; next: fix the reported configuration, then rerun tap init --yes`);
  }
  if (!opts.dryRun && !outcome.already && !outcome.inGit) console.error("tap init: not a git repository; skipped .gitignore setup.");
  return failed.length ? 1 : 0;
}
if(import.meta.main)process.exitCode=cmdInit(process.argv.slice(2));
