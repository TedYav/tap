import {appendFileSync,copyFileSync,linkSync,existsSync,fsyncSync,closeSync,openSync,lstatSync,mkdirSync,readdirSync,readFileSync,unlinkSync,utimesSync} from "node:fs";
import {basename,dirname,join} from "node:path";
import {createHash} from "node:crypto";
import {parseEnvelope,validateEnvelope} from "./envelope";
import {acquireObligationLock,acquirePathLock} from "./panelock";
import {resolveContext,TapError} from "./context";
import {assertResetUnfenced,markResetGenerationReused,withResetCustody} from "./reset";

import {archiveRows,archivedPayload,type ArchiveRow} from "./bus-archive-index";
import { RETRY_IDLE_SUBMIT_SUFFIX, RETRY_MARKER_SUFFIX } from "./retry";
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RECEIPTS=new Set(["placed","done","sent","attempted","idle-submit","submit-phases.jsonl","harness-queued","read","authorized-read","submit-unverified.frame","submit-unverified.json","unconfirmed","cancelled","opencode-submit-unverified.ansi","retries.jsonl"]);
const TERMINAL_RECEIPT=/\.(?:placed|done|sent|attempted|idle-submit|harness-queued|read|authorized-read|unconfirmed|cancelled)$/;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function regular(path:string) {const stat=lstatSync(path);if(!stat.isFile() || stat.isSymbolicLink())throw new Error(`not an ordinary file: ${path}`);return stat;}
function directory(path:string) {if(existsSync(path)){if(!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())throw new Error(`not an ordinary directory: ${path}`);}else mkdirSync(path);}
function names(path:string):string[]{try{return readdirSync(path);}catch(e:any){if(e.code==="ENOENT")return [];throw e;}}
function references(text:string,protectedIds:Set<string>,ids:Set<string>,suffixes:Map<string,string[]>) {for(let token of text.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g)??[]){while(token){if(ids.has(token))protectedIds.add(token);for(const id of suffixes.get(token)??[])protectedIds.add(id);const end=token.lastIndexOf(".");if(end<0)break;token=token.slice(0,end);}}}
function flush(path:string){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
function copyVerified(source:string,dest:string) {
 const stat=regular(source),bytes=readFileSync(source);
 if(existsSync(dest)){regular(dest);if(!readFileSync(dest).equals(bytes))throw new Error(`archive differs from active bytes: ${dest}`);flush(dest);flush(dirname(dest));return;}
 const temp=join(dirname(dest),`.archive-copy-${process.pid}-${crypto.randomUUID()}`);
 try {
  copyFileSync(source,temp,1);
  utimesSync(temp,stat.atime,stat.mtime);flush(temp);
  if(!readFileSync(temp).equals(bytes))throw new Error(`archive copy verification failed: ${dest}`);
  linkSync(temp,dest); // Publish complete bytes without replacing any existing evidence.
  flush(dirname(dest));
 } finally {try{unlinkSync(temp);}catch{ /* Interrupted staging stays outside indexed history. */ }}
}

export function archiveBus(home:string,days=7,dryRun=false,now=Date.now()) {
 if(!Number.isSafeInteger(days)||days<1)throw new Error("--older-than requires whole days, at least 1d");
 assertResetUnfenced(home,"tap bus archive");
 const archive=join(home,"archive");
 if(existsSync(archive) && (!lstatSync(archive).isDirectory()||lstatSync(archive).isSymbolicLink()))throw new Error("archive directory must not be a symlink");
 const lock=dryRun?null:acquirePathLock(join(home,"archive.lock"),0);
 if(!dryRun&&!lock)throw new Error("another bus archive job is active");
 try {
  const index=archiveRows(home),payloads=join(home,"payloads"),receipts=join(home,"receipts"),spool=join(home,"spool");
  for(const dir of [payloads,receipts,spool,join(spool,"digests")])if(existsSync(dir)&&(!lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink()))throw new Error(`unsafe active directory: ${dir}`);
  const spoolNames=names(spool);
  const ids=new Set(names(payloads).filter(n=>n.endsWith(".md")&&ID.test(n.slice(0,-3))).map(n=>n.slice(0,-3)));
  const receiptNames=names(receipts);
  // Retry attempt and idle-submit markers name <id>, never a phantom `<id>.retry-<uuid>`.
  const receiptIds=receiptNames.filter(n=>TERMINAL_RECEIPT.test(n)).map(n=>{const retry=RETRY_MARKER_SUFFIX.exec(n)??RETRY_IDLE_SUBMIT_SUFFIX.exec(n);return retry?n.slice(0,retry.index):n.replace(TERMINAL_RECEIPT,"");});
  const allIds=new Set([...receiptIds,...ids,...index.keys(),...spoolNames.filter(n=>n.endsWith(".md")).map(n=>n.slice(0,-3))]);
  const suffixes=new Map<string,string[]>();
  for(const id of allIds){const suffix=id.match(/-([a-f0-9]{12})$/)?.[1];if(suffix)suffixes.set(suffix,[...(suffixes.get(suffix)??[]),id]);}
  const byId=new Map<string,string[]>(),unknownReceipts=new Set<string>();
  for(const name of receiptNames) {
   if(name.endsWith(".lock"))continue;
   let prefix=name;
   while(prefix.includes(".")) {prefix=prefix.slice(0,prefix.lastIndexOf("."));if(allIds.has(prefix)){{const suffix=name.slice(prefix.length+1);if(!RECEIPTS.has(suffix)&&!RETRY_MARKER_SUFFIX.test("."+suffix)&&!RETRY_IDLE_SUBMIT_SUFFIX.test("."+suffix))unknownReceipts.add(prefix);}const row=byId.get(prefix)??[];row.push(name);byId.set(prefix,row);break;}}
  }
  // Indexed rows with leftover active receipts are interrupted cleanup, not open work.
  for(const id of index.keys())if(byId.has(id))ids.add(id);
  const protectedIds=new Set<string>(),candidate=new Map<string,{row:ArchiveRow;files:string[];stats:Map<string,string>}>();
  const cutoff=now-days*86400000;
  const fingerprint=(p:string)=>{const s=regular(p);return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;};
  const retained:Record<string,number>={};
  const keep=(reason:string)=>{retained[reason]=(retained[reason]??0)+1;};
  const counts={retained_reasons:retained,scanned:ids.size,eligible:0,archived:0,protected:0,retained:0,bytes:0,dry_run:dryRun,older_than:`${days}d`};
  for(const id of ids) {
   const payload=join(payloads,id+".md"),settlement=["done","cancelled"].map(s=>join(receipts,`${id}.${s}`)).find(existsSync);
   const prior=index.get(id);
   const payloadSource=existsSync(payload)?payload:prior?archivedPayload(home,id):payload;
   regular(payloadSource);const raw=readFileSync(payloadSource,"utf8");
   if(!settlement&&!prior){keep("unsettled");references(raw,protectedIds,allIds,suffixes);continue;}
   try {
    if(settlement)regular(settlement);
    let marker:any;
    try{marker=settlement?JSON.parse(readFileSync(settlement,"utf8")):{at:prior!.settled_at};}catch{keep("malformed-settlement");references(raw,protectedIds,allIds,suffixes);continue;}
    const at=Date.parse(marker?.at);if(!Number.isFinite(at)){keep("malformed-settlement");references(raw,protectedIds,allIds,suffixes);continue;}if(at>=cutoff){keep("recent-settlement");continue;}
    if(unknownReceipts.has(id)){keep("unknown-receipt");continue;}
    if(!validateEnvelope(raw).ok || parseEnvelope(raw).fields.id!==id){keep("malformed-payload");continue;}
    const files=[...(existsSync(payload)?[payload]:[]),...(byId.get(id)??[]).sort().map(n=>join(receipts,n))];
    if(!files.length)continue;
    const stats=new Map(files.map(p=>[p,fingerprint(p)]));
    if(files.some(p=>regular(p).mtimeMs>=cutoff)){keep("recent-file");continue;}
    if(spoolNames.some(n=>n===id+".md"||n===id+".meta.json")){keep("spooled");protectedIds.add(id);continue;}
    const row:ArchiveRow=prior??{id,month:new Date(at).toISOString().slice(0,7),settled_at:new Date(at).toISOString(),payload_sha256:sha(readFileSync(payloadSource)),receipts:(byId.get(id)??[]).sort()};
    if(prior){
     if(sha(readFileSync(archivedPayload(home,id)))!==prior.payload_sha256 || sha(readFileSync(payloadSource))!==prior.payload_sha256)throw new Error(`archive payload differs for ${id}`);
     const archivedReceipts=join(archive,prior.month,"receipts");
     if(!lstatSync(archivedReceipts).isDirectory()||lstatSync(archivedReceipts).isSymbolicLink())throw new Error("unsafe archive receipts");
     for(const n of prior.receipts)regular(join(archivedReceipts,n));
     if((byId.get(id)??[]).some(n=>!prior.receipts.includes(n)))throw new Error(`new receipt appeared for archived ${id}`);
    }
    candidate.set(id,{row,files,stats});
   }catch(error){throw new Error(`cannot establish archive eligibility for ${id}: ${error}`);}
  }
  // Open spool and digest references protect history even when that history is settled.
  for(const n of names(spool))if(n.endsWith(".md")||n.endsWith(".json")){const p=join(spool,n);regular(p);references(readFileSync(p,"utf8"),protectedIds,allIds,suffixes);}
  for(const n of names(join(spool,"digests")))if(n.endsWith(".json")){const p=join(spool,"digests",n);regular(p);references(readFileSync(p,"utf8"),protectedIds,allIds,suffixes);}
  for(const [id,c] of candidate) {
   if(protectedIds.has(id)){keep("referenced");counts.protected++;continue;}
   const obligation=dryRun?null:acquireObligationLock(id,0);
   if(!dryRun&&!obligation){keep("busy");continue;}
   try {
   counts.eligible++;
   if(dryRun)continue;
   const moved=withResetCustody(home,"bus archive",()=>{
   assertResetUnfenced(home,"tap bus archive");
   if(c.files.some(p=>fingerprint(p)!==c.stats.get(p)))throw new Error(`active evidence changed during archive: ${id}`);
   directory(archive);flush(home);const month=join(archive,c.row.month);directory(month);directory(join(month,"payloads"));directory(join(month,"receipts"));flush(month);flush(archive);
   for(const file of c.files)copyVerified(file,join(month,file===join(payloads,id+".md")?"payloads":"receipts",basename(file)));
   if(!index.has(id)) {
    const file=join(archive,"index.ndjson");if(existsSync(file))regular(file);
    // A leading newline separates any interrupted final append from this complete row.
    appendFileSync(file,"\n"+JSON.stringify(c.row)+"\n",{mode:0o600});
    index.set(id,c.row);
   }
   flush(join(archive,"index.ndjson"));flush(archive);
   // Copies and index are durable before any active file is unlinked.
   markResetGenerationReused(home,"bus-archive");
   for(const file of c.files){if(fingerprint(file)!==c.stats.get(file))throw new Error(`active evidence changed before unlink: ${id}`);counts.bytes+=regular(file).size;unlinkSync(file);}
   counts.archived++;
   },0);
   if(!moved.ok)throw new Error(`${moved.refusal}: ${moved.detail}`);
   }finally{obligation?.release();}
  }
  counts.retained=counts.scanned-counts.eligible;return counts;
 } finally {lock?.release();}
}
function runBus(argv:string[]):number {
 if(argv.shift()!=="archive")throw new TapError(1,"usage_error","tap help bus","usage: tap bus archive [--older-than 7d] [--dry-run]");
 let days=7,dry=false;
 while(argv.length){const arg=argv.shift();if(arg==="--dry-run")dry=true;else if(arg==="--older-than"){const value=argv.shift()??"";if(!/^\d+d$/.test(value))throw new Error("--older-than expects days, for example 7d");days=Number(value.slice(0,-1));}else throw new Error(`unknown archive option: ${arg}`);}
 const ctx=resolveContext();const r=archiveBus(ctx.bus.home,days,dry);
 console.log(`tap bus archive: ${dry?"would archive":"archived"} ${dry?r.eligible:r.archived} payloads; retained ${r.retained} (${r.protected} referenced); ${r.bytes} bytes${dry?" (dry-run)":""}`);
 if(Object.keys(r.retained_reasons).length)console.log("retained: "+Object.entries(r.retained_reasons).map(([reason,n])=>`${reason}=${n}`).join(", "));return 0;
}
export function cmdBus(argv:string[]):number {
 try{return runBus([...argv]);}catch(error){if(error instanceof TapError)throw error;throw new TapError(1,"archive_refused","tap bus archive --dry-run",String(error));}
}
if(import.meta.main){try{process.exitCode=cmdBus(Bun.argv.slice(2));}catch(error){console.error(`tap bus archive: ${error}`);process.exitCode=1;}}
