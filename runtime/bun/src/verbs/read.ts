import { inheritedActor } from "../context";
import {completeHarnessQueued, firstObservationNonAuthoritative, recordAuthorizedRead, terminalCancelMarker} from "../harness-queue";
import { interruptNotice } from "../submit-phase";
// Native recipient view. Read owns first-observation receipts, unlike done's
// strict replay refusal/replacing settlement: reuse the obligation lock, actor,
// envelope and reset primitives without changing that distinction.
import { existsSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addresseeGrant, historyDirForBus, type GrantResult } from "../addressee-grant";
import { settlingInstance } from "../recipient-instance";
import { callerObservationReason, observeCallerIdentity, resolveSelf, TapError, type ResolvedContext } from "../context";
import { envelopeField, validateEnvelope } from "../envelope";
import { jsonObj } from "../fsatomic";
import { ageNowEpoch, idAgeSeconds, utcStamp, validToken } from "../ids";
import { humanAction, humanLine } from "../native-error";
import { acquireObligationLock } from "../panelock";
import { forwardingReceipt } from "../forwarding-receipt";
import { currentInstance } from "../registry";
import { assertResetUnfenced, markResetGenerationReused } from "../reset";
import { appendRegistryEventOrWarn, registryEventsPath } from "../events";
import { spoolAuthorized, renderDigest, resolveView } from "../payload-view";
import { type ClaimToken, claimAcquire, claimObserve, claimRelease, removeEntry, retireRetainedStagedCopyUnderClaim } from "../spool-sidecar";
import { retainedStagedIdleCopy } from "../delivery-custody";
import { applyTeamOverride } from "../team-override";
import { resolveSelection } from "../team-selection";
import { verbose } from "../verbose";
import { StdoutClosed, writeStdout } from "../stdout-sync";

// Read's adoption and clearing-remedy predicate is the shared addressee grant
// (addressee-grant.ts) — the same policy the Bash doors reach through
// tap_addressee_grant_check, in-process here; it includes the local adoption
// rewrites the native done gate does not. The acting registry is the
// context's for both of the incumbent's registry lookups (it resolved
// `tap_acting_registry "$LOCAL_TEAM"` and `tap_acting_registry` on one bus).
function readGrant(ctx: ResolvedContext, actor: string, to: string, adopted: string, instance: string, id: string, from: string): GrantResult {
  return addresseeGrant({
    registryPath: ctx.registryPath, adoptionRegistryPath: ctx.registryPath, marker: ctx.marker, team: ctx.team,
    historyDir: historyDirForBus(ctx.bus.home), id, from, actor, to, adoptedFrom: adopted, recipientInstance: instance,
  });
}
function failGrant(grant: GrantResult, id: string): never {
  throw new TapError(1,grant.errorClass,grant.next+(grant.errorClass === "not_addressee" ? `; inspect: tap show ${id}; or tap read ${id} --force (recorded)` : ""),grant.detail);
}
/** First observation wins: stage the COMPLETE receipt in a 0600 sibling temp,
 *  fsync it, and only then publish with an exclusive link — the native shape of
 *  the deleted `tap_atomic_write_new`. Only EEXIST on the DESTINATION link is a
 *  tolerable failure (somebody else observed first). The staging name is
 *  exclusive: a collision retries under a fresh UUID (a name this call never
 *  created is never unlinked), and once the temp fd is owned, EVERY failure —
 *  write, fsync, close, or a non-EEXIST link — is receipt_unwritable and the
 *  owned temp is unlinked on the way out, so no read is reported without its
 *  record and no staging file is left behind. Exported for the publication
 *  discriminator that races it, as adoptParkedForRead is for adoption. */
export function firstObservation(path: string, fields: Record<string,string>): boolean {
  const dir = dirname(path);
  const unwritable = () => new TapError(1,"receipt_unwritable",`check permissions on ${dir}`,`could not write the receipt for '${fields.id}' — refusing to report a read that left no record`);
  let temp = "";
  try {
    let fd = -1;
    for (let attempt = 0; fd === -1; attempt++) {
      temp = join(dir, `.tap.${process.pid}.${crypto.randomUUID()}`);
      try { fd = openSync(temp, "wx", 0o600); }
      catch (error) {
        temp = "";
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 8) throw unwritable();
      }
    }
    try {
      try {
        writeFileSync(fd, jsonObj(fields)+"\n");
        fsyncSync(fd);
      } finally { closeSync(fd); }
    } catch { throw unwritable(); }
    try { linkSync(temp,path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw unwritable();
    }
  } finally {
    if (temp) { try { unlinkSync(temp); } catch { /* owned cleanup is best-effort */ } }
  }
}
function forceEvent(ctx: ResolvedContext, actor: string, to: string, pane: string, detail: string): void {
  appendRegistryEventOrWarn("tap read", {
    log: registryEventsPath(ctx.bus.home),
    actor, action: "read_forced", handle: to, pane, team: ctx.team, detail,
  });
}
/** Scratch-only mutation barrier; production callers never enter it. Same shape
 *  as done.ts: `.reached` announces this reader is past the mail gates and one
 *  step from the obligation lock, the test drives its race from that signal,
 *  then `.release` lets the read proceed. Keyed by id so other reads run free. */
function readTestBarrier(stage: string, id: string): void {
  const base = process.env.TAP_READ_TEST_BARRIER;
  if (!base || !process.env.TAP_SCRATCH_ONLY || process.env.TAP_READ_TEST_ID !== id) return;
  writeFileSync(`${base}.${stage}.${process.pid}.reached`, "1\n");
  const release = `${base}.${stage}.release`;
  const deadline = Date.now() + 60_000;
  while (!existsSync(release)) {
    if (Date.now() >= deadline) throw new Error(`read test barrier timed out at ${stage}`);
    Bun.sleepSync(5);
  }
}
/** The forwarded-custody publication the incumbent reached by subprocess: the
 *  helper runs in process here, acquiring its own registry lock (never a second
 *  acquisition beside it) and revalidating selection, actor instance and grant
 *  before the exclusive link. Returns whether THIS call created the receipt.
 *  The incumbent mapped every subprocess failure to one refusal; a thrown
 *  helper keeps exactly that mapping, since the classification (busy registry,
 *  replaced seat, revoked custody) is already stated by the refusing gate. */
function publishForwardedReceipt(payload: string, receipt: string, fields: Record<string,string>, actor: string, instance: string, team: string, id: string): boolean {
  let created: boolean;
  try { created = forwardingReceipt("first",payload,receipt,actor,instance,team,jsonObj(fields)+"\n") === "created"; }
  catch {
    throw new TapError(1,"not_addressee","inspect tap team and retry read","forwarding custody could not be revalidated; no receipt written");
  }
  return created;
}
/** A reader that closed stdout early (`tap read <id> | head -1`) is the consumer's
 *  choice, not a failure: the receipt is written before any output, so the note
 *  is already settled. Exit quietly with success rather than a stack trace, and
 *  stop — a digest's remaining members are not settled behind output nobody sees.
 *  Only a closed STDOUT is quiet (writeStdout tags it); a stderr EPIPE on a real
 *  refusal stays the failure it is. */
export function cmdRead(argv: string[]): number {
  try { return readVerb(argv); }
  catch (error) {
    if(error instanceof StdoutClosed) return 0;
    throw error;
  }
}
function readVerb(argv: string[]): number {
  let arg="", all=false, item="", force=false, epoch=process.env.TAP_EPOCH ?? "", positional=false;
  let explicit="", team="", by="", byDeclared=false;
  for(let i=0;i<argv.length;i++) {
    const a=argv[i]!;
    if(!positional && a === "--all") all=true;
    else if(!positional && (a === "--item" || a === "--epoch" || a === "--by" || a === "--team")) {
      const value=argv[++i]; if(!value) throw new TapError(1,"usage_error","tap help read",`${a} needs ${a === "--item" ? "an id" : "a value"}`);
      if(a === "--item") item=value; else if(a === "--epoch") epoch=value; else if(a === "--team") team=value;
      else { by=value; byDeclared=true; }
    } else if(!positional && a === "--force") force=true;
    else if(!positional && a === "--") positional=true;
    else if(!positional && a.startsWith("path=")) explicit=a.slice(5);
    else if(!positional && a.startsWith("--")) throw new TapError(1,"unknown_option","tap help read",`unknown option '${a}'`);
    else if(!arg) arg=a;
    else throw new TapError(1,"usage_error","tap help read",`unexpected arg '${a}'`);
  }
  if(!arg) arg=explicit ? `path=${explicit}` : "";
  if(!arg || arg === "path=") throw new TapError(1,"usage_error","tap help read","usage: tap read <id|team/id|12hex> [--force] [--by <me>] [--epoch <n>] [--team <name>]");
  const callerPin=process.env.TAP_HOME ?? "";
  applyTeamOverride(team);
  const ctx=resolveSelection(callerPin,team);
  assertResetUnfenced(ctx.bus.home,"tap read");
  let actor=by || inheritedActor(), identity="declared", pane="";
  if(!actor) {
    const seen=observeCallerIdentity();
    if(seen.state === "inside") { const self=resolveSelf(ctx,{status:"ok",...seen},1); actor=self.handle; pane=self.paneId; identity="pane"; }
    else {
      // The next step is --by. --force alone fails on this same refusal: it
      // widens WHOSE mail may be read, not WHO is reading. The detail carries
      // why the pane could not be observed (whoami's pattern), not one fixed
      // reason.
      const typed=arg.startsWith("path=") ? "<id>" : arg;
      throw new TapError(1,"no_actor",`tap read ${typed} --by <handle>   (add --force to read mail addressed to someone else; it is recorded)   OR   tap register   (join this team)`,`only the addressee reads (caller pane observation: ${callerObservationReason(seen)})`);
    }
  }
  if(!validToken(actor)) throw new TapError(1,"usage_error","tap help read",`actor '${actor}' is not a valid token (^[A-Za-z0-9][A-Za-z0-9._-]*$)`);
  // A digest member re-enters the public door with the member's EFFECTIVE
  // forwarded argv, exactly as the incumbent spawned child parsed it: the
  // member's own parse declares its `--by`/`--team`, so its receipt and reply
  // hints carry that declared identity — never the pane-inferred parent's
  // pane provenance. A member refusal renders and marks the aggregate failed
  // without stranding its siblings.
  const member = (memberPath: string, forward: string[]): number => {
    try { return readVerb([`path=${memberPath}`, ...forward]); }
    catch (error) {
      if (!(error instanceof TapError)) throw error;
      process.stderr.write(`tap read: ${humanLine(error.detail)}; next: ${humanAction(error.action)}\n`);
      return 1;
    }
  };
  return readOne(arg,all,item,explicit);

  function readOne(address: string, allItems=false, selected="", explicit=""): number {
    const view=resolveView(ctx,address,"read",actor,explicit);
    verbose("state_paths",{paths:[view.path,join(ctx.bus.home,"receipts")]});
    if(view.residency === "digest") {
      return renderDigest("read",view.path,allItems,selected,["--by",actor,"--team",ctx.team,...(force ? ["--force"] : []),...(epoch ? ["--epoch",epoch] : [])], (view.team ? view.team + "/" : "") + view.id, member);
    }
    let {id,path,residency,busHome}=view;
    const spoolDir=join(busHome,"spool");
    let claimToken: ClaimToken | null=null;
    if(allItems || selected) throw new TapError(1,"usage_error","tap read <digest-id> --all","--all/--item require a digest");
    const mailGates=(p:string) => {
      const raw=readFileSync(p,"utf8");
      if(!validateEnvelope(raw).ok) throw new TapError(1,"usage_error",`tap show ${id}`,`payload '${id}' has an invalid envelope — inspect it with tap show, which does not require a valid one`);
      const field=(key:string)=>envelopeField(raw,key) ?? "";
      if(field("id") !== id) throw new TapError(1,"usage_error",`tap show ${id}`,`payload '${id}' carries envelope id '${field("id")}' — the envelope does not name the file it lives in; inspect it with tap show`);
      const to=field("to"), from=field("from"), fromTeam=field("from_team"), toTeam=field("to_team"), adopted=field("to_adopted_from"), instance=field("recipient_instance"), reply=field("reply") || "expected";
      if(!["expected","settle-only"].includes(reply)) throw new TapError(1,"unsanctioned_reply",`tap show ${id}`,`payload '${id}' declares an unsanctioned reply expectation '${reply}' (expected|settle-only) — inspect it with tap show; read will not guess an obligation`);
      if(toTeam && toTeam !== ctx.team) throw new TapError(1,"not_addressee",`tap show ${id}   OR   read it from the addressed team's seat`,`'${id}' is addressed to '${toTeam}/${to}', not to a seat on '${ctx.team}' — --force reads on a teammate's behalf, it does not move mail between teams. Inspect it without acking: tap show ${id}.`);
      return {field,to,from,fromTeam,toTeam,adopted,instance,reply};
    };
    let gates=mailGates(path);
    // A digest may promote while read waits for either its obligation lock or
    // spool claim. Follow only the same note's canonical handoff, then refresh
    // envelope gates before the current-authority check below.
    const followPromotion = (next: typeof view): boolean => {
      if(residency !== "spool" || gates.reply !== "settle-only" || existsSync(join(spoolDir,`${id}.md`)) || next.residency !== "payloads" || next.path !== join(busHome,"payloads",`${id}.md`)) return false;
      path=next.path; residency="payloads";
      gates=mailGates(path);
      return true;
    };
    if(gates.to !== actor && !force) { const pg=readGrant(ctx,actor,gates.to,gates.adopted,gates.instance,id,gates.from); if(!pg.ok) failGrant(pg,id); }
    if(residency === "spool") {
      // Queue custody has one owner; the parked grant check runs even under
      // --force — no override takes another recipient's queued mail.
      const g=readGrant(ctx,actor,gates.to,gates.adopted,gates.instance,id,gates.from);
      if(!g.ok) throw new TapError(1,g.errorClass,g.next+`; inspect: tap show ${id}`,g.detail);
    }
    readTestBarrier("gates",id);
    const lock=acquireObligationLock(id);
    if(!lock) throw new TapError(1,"obligation_busy",`retry tap read ${id}`,`another process is acting on '${id}'; refusing to read without exclusive eligibility`);
    try {
      const again=resolveView(ctx,address,"read",actor,explicit);
      if((again.path !== path || again.residency !== residency) && !followPromotion(again)) throw new TapError(1,"not_found",`tap show ${id}`,`'${id}' changed residency while this read was acquiring its lock (was ${residency}, now ${again.residency}); look with tap show`);
      assertResetUnfenced(busHome,"tap read (resolved bus)");
      if(residency === "spool" && gates.reply === "settle-only") {
        // Bounded wait out of a live sender-side claim; only well-formed fresh
        // evidence keeps waiting. Once the parked bytes are gone, the promoting
        // reader canonicalized them before its claim release — re-resolve and
        // revalidate every mail gate before this read proceeds.
        const deadline=Date.now()+5000;
        while(claimObserve(spoolDir,id) === "held" && Date.now()<deadline) Bun.sleepSync(100);
        if(!existsSync(join(spoolDir,`${id}.md`))) {
          let promoted;
          try { promoted=resolveView(ctx,address,"read",actor,explicit); }
          catch { throw new TapError(1,"not_found",`tap show ${id}`,`'${id}' moved while this read was waiting out its claim — another verb is acting on it; look with tap show`); }
          if(!followPromotion(promoted))
            throw new TapError(1,"not_found",`tap show ${id}`,`'${id}' changed residency while this read was waiting out its claim (was spool, now ${promoted.residency}); look with tap show`);
        }
      }
      // Re-read the binding at the lock, matching local seat-adoption rewrites.
      const bound=envelopeField(readFileSync(path,"utf8"),"recipient_instance") ?? "";
      const current=currentInstance(ctx.registryPath,actor);
      const retired=ctx.marker === "live" && residency !== "spool" && gates.to === actor && gates.reply === "settle-only" && !gates.adopted && bound.startsWith(`${actor}|`) && bound.length > actor.length+1 && Boolean(current) && current !== bound;
      const g=readGrant(ctx,actor,gates.to,gates.adopted,bound,id,gates.from);
      if(!g.ok && !(retired && g.instanceMismatch && g.errorClass === "not_addressee") && (!force || g.errorClass !== "not_addressee" || residency === "spool")) failGrant(g,id);
      if(residency === "spool") {
        const claim=claimAcquire(spoolDir,id,true);
        if(claim.status === "held") throw new TapError(1,"spool_busy",`retry tap read ${id}`,`parked payload '${id}' is claimed; leaving it queued`);
        claimToken=claim.token;
        adoptParkedForRead(busHome,spoolDir,id,actor,ctx);
        path=join(busHome,"payloads",`${id}.md`); residency="payloads";
      } else if(residency === "payloads" && retainedStagedIdleCopy(busHome,id)) {
        // Direct rc-5 sends retain the canonical beside an Enter-only spool
        // copy. The recipient's read is first observation: retire that copy
        // under the same obligation → claim order as parked adoption, before
        // publishing .read/.done, so a settled note cannot leave a live waiter.
        const claim=claimAcquire(spoolDir,id,true);
        if(claim.status === "held") throw new TapError(1,"spool_busy",`retry tap read ${id}`,`staged-idle copy '${id}' is claimed; leaving the read unsettled`);
        claimToken=claim.token;
        try {
          if(!retireRetainedStagedCopyUnderClaim(busHome,id)) throw new Error("staged-idle custody changed");
        } catch { throw new TapError(1,"spool_busy",`retry tap read ${id}`,`staged-idle copy '${id}' could not be retired; read remains unsettled`); }
      }
      const receiptHome=residency === "history" ? dirname(dirname(path)) : busHome;
      const done=join(receiptHome,"receipts",`${id}.done`), read=join(receiptHome,"receipts",`${id}.read`), cancelled=join(receiptHome,"receipts",`${id}.cancelled`);
      let settled="", withdrawnReason="", supersededBy="";
      if(residency === "archive") settled="cancelled";
      else if(existsSync(done)) { try { settled=JSON.parse(readFileSync(done,"utf8")).via || "done"; } catch { settled="done"; } }
      // A `.cancelled` receipt carries its own `via`, exactly as `.done` does.
      // Hardcoding "cancelled" here reported a sender WITHDRAWAL (via:
      // withdrawn) as an ordinary cancellation, which is the difference between
      // "your addressee was gone" and "the sender superseded this" — the one
      // fact the tombstone exists to carry.
      else if(existsSync(cancelled)) {
        try {
          const rec=JSON.parse(readFileSync(cancelled,"utf8"));
          settled=rec.via || "cancelled";
          withdrawnReason=typeof rec.reason === "string" ? rec.reason : "";
          supersededBy=typeof rec.superseded_by === "string" ? rec.superseded_by : "";
        } catch { settled="cancelled"; }
      }
      else if(residency === "history") settled="archived";
      // Only a withdrawal gets the tombstone sentence; an ordinary cancellation
      // keeps the wording it has always had.
      const tombstone=settled === "withdrawn"
        ? `superseded: ${withdrawnReason || "no reason given"}${supersededBy ? ` (superseded by: ${supersededBy})` : ""}`
        : "";
      try { mkdirSync(dirname(done),{recursive:true}); }
      catch { throw new TapError(1,"receipt_unwritable",`check permissions on ${dirname(done)}`,`could not create the receipts directory for '${id}'`); }
      const now=utcStamp();
      if(!settled) {
        const fields:Record<string,string>=gates.reply === "settle-only" ? {id,status:"done",at:now,by:actor,via:"read"} : {id,at:now,by:actor};
        if(gates.reply === "settle-only" && (g.grant || gates.adopted)) fields.adopted_from=g.grant || gates.adopted;
        fields.identity=identity;
        if(gates.reply === "settle-only") fields.instance=settlingInstance(ctx.registryPath,actor);
        if(retired) fields.reason="instance_retired";
        if(g.grant) fields.adopted_from=g.grant;
        if(identity === "pane" && pane) fields.pane=pane;
        if(force) { fields.forced="true"; fields.to=gates.to; }
        if(epoch) fields.epoch=epoch;
        // Forwarded and historically delegated custody publishes through the
        // shared selection-current helper: it revalidates grant, actor
        // instance and team under its own registry lock at the only boundary
        // that guards them — publication. The incumbent's compound condition
        // names the same two cases (a recorded adoption grant, or an
        // original-recipient binding) and requires a bound actor instance.
        const forwardInstance = g.ok && g.actorInstance && (g.grant || gates.field("original_recipient_instance")) ? g.actorInstance : "";
        const target = gates.reply === "settle-only" ? done : read;
        const created = forwardInstance
          ? publishForwardedReceipt(path,target,fields,actor,forwardInstance,ctx.team,id)
          : firstObservation(target,fields);
        if(created) markResetGenerationReused(busHome,"read");
      }
      // This invocation's own grant-validated, non-forced, non-retired read of
      // the live canonical payload is the current authority for queued-delivery
      // completion — and only when the immutable first observation is the
      // forced/retired evidence this fix exists for. Cancelled, withdrawn,
      // archived and history inspections are never recipient processing: they
      // carry no evidence and mint no record; the plain receipt-derived call
      // keeps their prior behavior. An immutable first forced/retired
      // observation keeps its bytes as the audit record while THIS read —
      // never that earlier evidence — completes `.sent`. When completion is
      // impossible yet (the queue receipt is recorded after the effect), the
      // authorized evidence is carried durably beside the untouched first
      // observation; the sender may record the queue in the window between the
      // completion check and the record publication (its obligation lock is
      // independent), so completion is reconciled after the evidence persists.
      // Terminal markers fail closed at the source too: a malformed `.cancelled`
      // file or the archive tombstone ends successor evidence before the helper.
      const successor=!force && !retired && g.ok && residency === "payloads"
        && firstObservationNonAuthoritative(busHome,id) && !terminalCancelMarker(busHome,id);
      if(!successor) completeHarnessQueued(busHome,id);
      else {
        const authorized={ by: actor, at: now };
        if(!completeHarnessQueued(busHome,id,authorized)) {
          readTestBarrier("evidence",id);
          recordAuthorizedRead(busHome,id,authorized);
          completeHarnessQueued(busHome,id);
        } else recordAuthorizedRead(busHome,id,authorized); // a prior pane .sent: this genuine read is still evidence
      }
      if(force) forceEvent(ctx,actor,gates.to,pane,`id=${id} identity=${identity} settled=${settled || "no"}`);
      const obligation=gates.reply === "expected" ? "ask" : "note", sender=gates.fromTeam ? `${gates.fromTeam}/${gates.from}` : gates.from;
      const full=process.env.TAP_VERBOSE === "1" || force;
      if(full) writeStdout(`${sender} · ${obligation} · ${idAgeSeconds(id,ageNowEpoch(),()=>{}) ?? "?"}s${force ? ` · forced (to=${gates.to})` : ""}${settled ? ` · already settled (via: ${settled})` : ""}\n\n`);
      // A repeat doorbell (TAP is best effort) lands here: say plainly that nothing is owed.
      else writeStdout(`tap read: ${obligation} ${id} from=${sender} ${settled === "withdrawn" ? "withdrawn" : settled ? "already settled; nothing owed" : obligation === "ask" ? "reply" : "settled"}\n`);
      if(tombstone) writeStdout(`${tombstone}\n`);
      const disruption = interruptNotice(receiptHome, id);
      if(disruption) writeStdout(`tap read: WARNING: ${disruption}\n`);
      const lines=readFileSync(path,"utf8").split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/); let start=0;
      if(lines[0]?.trim() === "---") { const end=lines.findIndex((line,i)=>i>0 && line.trim() === "---"); if(end>=0) start=end+1; }
      writeStdout(lines.slice(start).join("\n").replace(/^\n+|\n+$/g,"")+"\n");
      if(full) {
        writeStdout("\n");
        if(settled === "withdrawn") writeStdout(`→ withdrawn by ${sender}; nothing owed${supersededBy ? ` — answer ${supersededBy} instead` : ""}\n`);
        else if(settled) writeStdout(`→ already settled (via: ${settled}); nothing owed\n`);
        else if(obligation === "note") writeStdout("→ settled on read\n");
        else if(force && (gates.to !== actor || g.instanceMismatch)) {
          writeStdout(`→ ask is bound to another identity; this read settles nothing. The sender clears it: tap cancel ${id} --by ${gates.from || "<sender>"}\n`);
          if(g.instanceMismatch) writeStdout(g.remedy.kind === "command" ? `  to answer as the bound instance instead: ${g.remedy.next} — only where that door is free; look before taking it\n` : g.remedy.kind === "none" ? `  no actor-side clearing path for instance ${bound}: ${g.remedy.next}\n` : `  no actor-side clearing path for instance ${bound} in this bus state\n`);
        } else writeStdout(`→ tap reply ${id}${byDeclared ? ` --by ${actor}` : ""}${team ? ` --team ${team}` : ""} -f <file>\n`);
      }
      return 0;
    } finally {
      lock.release();
      if(claimToken !== null) { try { claimRelease(spoolDir,id,claimToken); } catch { /* the claim is best-effort custody, never a verdict */ } }
    }
  }
}

/** Recipient-initiated custody transfer, under the reader's held claim: the
 *  parked grant is rechecked, canonical bytes are linked (never overwritten),
 *  the bus generation is touched, and the queue entry is removed under its
 *  meta lock. Refusal texts and their order mirror the incumbent helper. */
export function adoptParkedForRead(busHome: string, spoolDir: string, id: string, actor: string, ctx: ResolvedContext): void {
  assertResetUnfenced(busHome,"tap read (parked mail)");
  const payload=join(spoolDir,`${id}.md`), canon=join(busHome,"payloads",`${id}.md`);
  if(!existsSync(payload)) throw new TapError(1,"not_found",`retry tap read ${id}`,`parked payload '${id}' moved while acquiring its claim`);
  if(!spoolAuthorized(payload,actor,{registryPath:ctx.registryPath,marker:ctx.marker,team:ctx.team,historyDir:historyDirForBus(busHome)})) throw new TapError(1,"not_recipient",`tap show ${id}`,`parked payload '${id}' is not queued for '${actor}' or an explicitly delegated predecessor`);
  const raw=readFileSync(payload,"utf8");
  if(!validateEnvelope(raw).ok || envelopeField(raw,"id") !== id) throw new TapError(1,"usage_error",`tap show ${id}`,`invalid parked envelope for '${id}'`);
  const field=(key:string)=>envelopeField(raw,key) ?? "";
  if(field("to_team") && field("to_team") !== ctx.team) throw new TapError(1,"not_addressee",`tap show ${id}`,`parked payload '${id}' belongs to another team`);
  const g=readGrant(ctx,actor,field("to"),field("to_adopted_from"),field("recipient_instance"),id,field("from"));
  if(!g.ok) throw new TapError(1,g.errorClass,g.next,g.detail);
  const reply=field("reply");
  if(reply && !["expected","settle-only"].includes(reply)) throw new TapError(1,"unsanctioned_reply",`tap show ${id}`,`invalid reply expectation for '${id}'`);
  try { mkdirSync(join(busHome,"payloads"),{recursive:true}); } catch { /* the link below reports an unusable payloads dir */ }
  try { linkSync(payload,canon); }
  catch {
    let same=false;
    try { same=compareSync(readFileSync(payload),readFileSync(canon)); } catch { /* unreadable canonical bytes are a conflict */ }
    if(!same) throw new TapError(1,"canonical_conflict",`tap show ${id}`,`canonical bytes differ; parked payload '${id}' retained`);
  }
  // Custody changed even if read reuses a receipt or its receipt write fails.
  markResetGenerationReused(busHome,"spool-read");
  removeEntry(spoolDir,id);
  if(existsSync(payload) || existsSync(join(spoolDir,`${id}.meta.json`))) throw new TapError(1,"spool_busy",`retry tap read ${id}`,`canonical payload retained but queue cleanup is incomplete`);
}
function compareSync(a: Buffer, b: Buffer): boolean { return a.equals(b); }
