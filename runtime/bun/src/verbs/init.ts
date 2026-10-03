import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { readStdinByte } from "../stdin-byte";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Bus } from "../bus";
import { oldBusRefusal, resolveBus } from "../bushome";
import { acquireRegistryLock } from "../panelock";
import { enrollmentAtFromDoc, loadGlobalRegistry } from "../index-home";
import { ensureRepoCharter } from "../first-run";
import { ignoreTap } from "../init-ignore";
import {
  bootstrapPostflipEnroll, bornLiveBootstrap, enrollTeam, currentShapedStore, teamRegistryFileRefusal, legacyAgentsAxisStore, oldStoreAction, oldStoreEvidence, oldStoreRefusalText,
  derivedTeamNotice, newEnrollmentRefusal, probeGitRoot, seatedBusRegistry, teamNameForRoot, teamOverrideRefusal, teamRegistryPath, unenrolledSeatsRefusal, writeEmptyTeamRegistry,
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
    process.stderr.write(`tap init: warning: ${root} is not a git repository; initializing TAP here anyway (--yes)\n`);
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
  if (opts.dryRun || outcome.already || process.env.TAP_SETUP_REPO_PENDING === "1") return outcome;
  let create = true;
  // --yes answers every question this command would ask, the signpost included.
  if (!existsSync(join(outcome.root, "AGENTS.md")) && !opts.yes && interactive(opts)) {
    process.stderr.write("No AGENTS.md here — create one with the TAP signpost? [Y/n] ");
    const byte = Buffer.alloc(1); let answer = ""; let newline = false;
    while (readStdinByte(byte) > 0) { if (byte[0] === 10) { newline = true; break; } answer += byte.toString(); }
    // The affirmative default belongs to a completed empty line (Enter), never
    // to a terminal that ended mid-prompt: EOF/EIO is absent consent, and
    // applying the default there would write AGENTS.md because the pane died.
    if (!newline) throw new InitRefusal("confirmation_required", `rerun tap init in ${outcome.root} once the terminal is back`, `the terminal ended before the signpost answer; no AGENTS.md was written`);
    create = !/^(n|no)$/i.test(answer.trim());
  }
  if (create) ensureRepoCharter(outcome.root, outcome.inGit);
  else console.error("tap init: project signpost skipped; run tap setup --repo when ready.");
  return outcome;
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
    if(enrolled.status==="ok" || opts.dryRun)return {team:enrolled.name,root:enrolled.rootReal,bus:join(enrolled.rootReal,".tap/bus"),inGit,already:true};
    // Enrolled but its registry is gone: recreate it where the index says, under the enrolled name.
    const loc=enrolled.registryLocation;
    if(!loc)throw new InitRefusal("registry_unreachable","tap doctor",`team '${enrolled.name}' is enrolled without a registry_location`);
    // Only a registry that is truly gone is recreated; an unreadable or
    // non-file entry at the stored path is someone's bytes, never overwritten.
    const unreachable=()=>new InitRefusal("registry_unreachable",`fix ${loc} (it exists but is not a readable regular file), then retry`,`the enrolled registry for team '${enrolled.name}' at ${loc} is unreadable`);
    if(existsSync(loc) || isSymlink(loc))throw unreachable();
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
  try { new Bus(bus).ensureDirs(); }
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

function failure(json: boolean, error_class: string, action: string, detail: string): void {
  if(json)console.log(JSON.stringify({ok:false,error_class,action,detail}));
  else console.error(`${detail}; next: ${action}`);
}

export function cmdInit(argv: string[]): number {
  const known=["--json","--yes","--for-launch","--dry-run"];
  const opts: InitOptions={json:argv.includes("--json"),yes:argv.includes("--yes"),forLaunch:argv.includes("--for-launch"),dryRun:argv.includes("--dry-run"),team:""};
  const usage="tap init [--json] [--yes] [--team <name>]";
  const flags: string[]=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]!=="--team"){flags.push(argv[i]!);continue;}
    const value=argv[++i];
    if(!value){failure(opts.json,"usage_error",usage,"--team needs a value");return 1;}
    opts.team=value;
  }
  if(flags.some(arg=>!known.includes(arg)) || (opts.dryRun && !opts.forLaunch)){failure(opts.json,"usage_error",usage,"Unknown init argument");return 1;}
  const machine=opts.json || opts.forLaunch;
  const cwd=process.cwd();
  let outcome: InitOutcome;
  try { outcome=initRoot(cwd,opts); }
  catch(error) {
    if(!(error instanceof InitRefusal))throw error;
    failure(machine,error.errorClass,error.action,error.detail);
    return 1;
  }
  const notice=!outcome.already && outcome.derivedFrom ? derivedTeamNotice(outcome.team,outcome.derivedFrom) : "";
  if(opts.forLaunch){
    if(notice)process.stderr.write(`tap session: ${notice}\n`);
    // A dry run hands the launcher the name the real launch would enroll, so its preview uses the same session namespace.
    if(opts.dryRun)console.log(JSON.stringify({ok:true,team:{name:outcome.team,root:outcome.root},already_initialized:outcome.already}));
    else if(!outcome.already)process.stderr.write(`tap session: initialized team '${outcome.team}' at ${outcome.root}\n`);
    return 0;
  }
  if(!outcome.already){
    if(!outcome.inGit)console.error("tap init: not a git repository; skipped .gitignore setup.");
  }
  // JSON stdout stays one object, so the derived-name notice goes to stderr there.
  if(notice)(opts.json ? console.error : console.log)(notice);
  if(opts.json)console.log(JSON.stringify({ok:true,team:{name:outcome.team,root:outcome.root},bus:outcome.bus,in_git:outcome.inGit,migrated:false,primary_counts:null,late:false,late_counts:null,already_initialized:outcome.already}));
  else if(outcome.already)console.log(`already initialized: team ${outcome.team}`);
  else console.log(`successfully initialized team: ${outcome.team}\nbus: ${outcome.bus}`);
  return 0;
}
if(import.meta.main)process.exitCode=cmdInit(process.argv.slice(2));
