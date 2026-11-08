import {closeSync,lstatSync,openSync,readFileSync,readSync,readdirSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {StringDecoder} from "node:string_decoder";
// Archived history layout (project decision, 2026-11-04): the month buckets ARE the index.
//   archive/<YYYY-MM>/payloads/<id>.md, archive/<YYYY-MM>/receipts/<id>.<kind>
//   archive/<YYYY-MM>/index.ndjson   append-only manifest, one row per archived id
//   archive/index.ndjson             legacy root manifest, frozen; nothing reads it
// A by-id lookup is one readdir of archive/ plus one lstat per month. No reader
// loads a manifest except the archive job, which reads only its target month's.
export interface ArchiveRow {id:string;month:string;settled_at:string;payload_sha256:string;receipts:string[]}
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MONTH=/^\d{4}-(?:0[1-9]|1[0-2])$/;
function safeDir(path:string):boolean {try{const st=lstatSync(path);return st.isDirectory()&&!st.isSymbolicLink();}catch{return false;}}
function lstatOrNull(path:string) {try{return lstatSync(path);}catch(error:any){if(error.code==="ENOENT")return null;throw error;}}

/** Month buckets, newest first. The archive root must be a real directory. */
export function archiveMonths(home:string):string[] {
 const root=join(home,"archive");
 const st=lstatOrNull(root);
 if(!st)return [];
 if(!st.isDirectory()||st.isSymbolicLink())throw new Error("unsafe archive directory");
 return readdirSync(root).filter(name=>MONTH.test(name)).sort().reverse();
}

/** The month bucket holding `id`'s archived payload, or "". Every month is
 *  probed newest first, whatever the id looks like: settlement can land in a
 *  later month than the id's stamp, and custom ids carry no stamp at all.
 *  Unsafe buckets or a non-regular payload refuse rather than answer "absent". */
export function archivedMonth(home:string,id:string):string {
 if(!ID.test(id))return "";
 for(const month of archiveMonths(home)) {
  const bucket=join(home,"archive",month),payloads=join(bucket,"payloads");
  const st=lstatOrNull(join(payloads,id+".md"));
  if(!st)continue;
  if(!safeDir(bucket)||!safeDir(payloads))throw new Error("unsafe archive path");
  if(!st.isFile()||st.isSymbolicLink())throw new Error("missing or unsafe archived payload");
  return month;
 }
 return "";
}

/** The archived payload path for `id`, or "" when it was never archived. */
export function archivedPayload(home:string,id:string):string {
 const month=archivedMonth(home,id);
 return month ? join(home,"archive",month,"payloads",id+".md") : "";
}

/** Address resolution's archived copy: the payload plus a real receipt
 *  directory beside it, symlink-resolved. Bytes were verified when the archive
 *  job copied them; reads do not re-hash (duct tape: a damaged archived copy
 *  shows damaged history, it cannot create or settle mail). */
export function archivedHistoryPayload(home:string,id:string):string {
 const month=archivedMonth(home,id);
 if(!month)return "";
 if(!safeDir(join(home,"archive",month,"receipts")))throw new Error("unsafe archive receipt directory");
 return realpathSync(join(home,"archive",month,"payloads",id+".md"));
}

/** A SEARCH, not a lookup: archived ids ending in `-<suffix>`, by listing every
 *  month's payload directory (names only). Used for short-suffix addressing. */
export function archivedIdsWithSuffix(home:string,suffix:string):string[] {
 const out:string[]=[];
 for(const month of archiveMonths(home)) {
  const payloads=join(home,"archive",month,"payloads");
  if(!safeDir(payloads))continue;
  for(const name of readdirSync(payloads))if(name.endsWith(`-${suffix}.md`))out.push(name.slice(0,-3));
 }
 return out;
}

/** One month's manifest rows, for the archive job's append dedupe. Malformed
 *  rows and torn append fragments are skipped; a missed row only means the
 *  job appends that row again, which no reader depends on. */
export function monthIndexRows(home:string,month:string):Map<string,ArchiveRow> {
 const rows=new Map<string,ArchiveRow>();
 const file=join(home,"archive",month,"index.ndjson");
 const st=lstatOrNull(file);
 if(!st)return rows;
 if(!st.isFile()||st.isSymbolicLink())throw new Error(`not an ordinary file: ${file}`);
 for(const line of indexLines(file)) {
  if(!line.trim())continue;
  try {
   const row=JSON.parse(line) as ArchiveRow;
   if(row && typeof row.id==="string" && ID.test(row.id) && row.month===month)rows.set(row.id,row);
  } catch { /* torn or malformed: re-appended by the next pass if still needed */ }
 }
 return rows;
}
function* indexLines(file:string): Generator<string> {
 const fd=openSync(file,"r");
 try {
  const bytes=Buffer.alloc(65536),decoder=new StringDecoder("utf8");
  let pending="";
  for(;;) {
   const count=readSync(fd,bytes,0,bytes.length,null);
   pending+=count ? decoder.write(bytes.subarray(0,count)) : decoder.end();
   let start=0,end=pending.indexOf("\n");
   while(end!==-1) {
    yield pending.slice(start,end);
    start=end+1;
    end=pending.indexOf("\n",start);
   }
   pending=pending.slice(start);
   if(!count){if(pending)yield pending;return;}
  }
 } finally {closeSync(fd);}
}

function regular(path:string) {const stat=lstatSync(path);if(!stat.isFile() || stat.isSymbolicLink())throw new Error(`not an ordinary file: ${path}`);return stat;}

export interface MaintenanceReport {
 at:number; status:"running"|"complete"|"retry"|"blocked";
 expired:number; reconciled:number; held:number; archived:number; error:string;
}
export function maintenanceReport(home:string):MaintenanceReport|null {
 try {
  const path=join(home,"maintenance.json");regular(path);
  const row=JSON.parse(readFileSync(path,"utf8"));
  return row&&Number.isFinite(row.at)&&["running","complete","retry","blocked"].includes(row.status)
   &&[row.expired,row.reconciled,row.held,row.archived].every(n=>Number.isSafeInteger(n)&&n>=0)
   &&typeof row.error==="string"?row:null;
 }catch{return null;}
}
export function archiveNudge(home:string):string {
 const report=maintenanceReport(home);
 if(report?.status!=="blocked")return "";
 if(report.held)return `bus has ${report.held} parked payloads needing attention; run tap spool list`;
 const cause=report.error.replace(/[\x00-\x1f\x7f]/g," ").slice(0,200);
 return `bus maintenance needs attention: ${cause}; run tap bus archive --dry-run`;
}
if(import.meta.main&&Bun.argv[2]==="notice"){const note=archiveNudge(Bun.argv[3]??"");if(note)console.log(note);}
