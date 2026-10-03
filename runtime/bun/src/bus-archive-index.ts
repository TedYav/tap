import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from "node:fs";
import {basename,join} from "node:path";
import {createHash} from "node:crypto";
export interface ArchiveRow {id:string;month:string;settled_at:string;payload_sha256:string;receipts:string[]}
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MONTH=/^\d{4}-(?:0[1-9]|1[0-2])$/;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const cache=new Map<string,{stamp:string;rows:Map<string,ArchiveRow>;invalid:boolean}>();
export function archiveRows(home:string,strict=false): Map<string,ArchiveRow> {
 const rows=new Map<string,ArchiveRow>();
 const root=join(home,"archive");
 try{const st=lstatSync(root);if(!st.isDirectory()||st.isSymbolicLink())throw new Error("unsafe archive directory");}catch(error:any){if(error.code==="ENOENT")return rows;throw error;}
 const file=join(root,"index.ndjson");
 let st;try{st=regular(file);}catch(error:any){if(error.code==="ENOENT")return rows;throw error;}
 const stamp=`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
 const cached=cache.get(file);
 if(cached?.stamp===stamp){if(strict&&cached.invalid)throw new Error(`archive index unreadable: ${file}; refusing placement`);return cached.rows;}
 let invalid=false;
 for(const line of readFileSync(file,"utf8").split("\n")) {
  if(!line.trim())continue;
  try {
  let row:ArchiveRow;
  try {row=JSON.parse(line);} catch(error) {
   const fragment=line.trim();
   if(!fragment.endsWith("}")&&(fragment.startsWith('{"id":')||'{"id":'.startsWith(fragment)))continue;
   throw error;
  }
  if(!row || typeof row.id!=="string" || typeof row.month!=="string" || typeof row.settled_at!=="string" || !ID.test(row.id) || !MONTH.test(row.month) || !/^[a-f0-9]{64}$/.test(row.payload_sha256) || !Number.isFinite(Date.parse(row.settled_at)) || !Array.isArray(row.receipts) || row.receipts.some(n=>typeof n!=="string" || basename(n)!==n || !n.startsWith(row.id+".")))throw new Error("invalid archive index record");
  const old=rows.get(row.id);
  if(old && JSON.stringify(old)!==JSON.stringify(row))throw new Error(`conflicting archive index records for ${row.id}`);
  rows.set(row.id,row);
  } catch {invalid=true;}
 }
 if(invalid)console.error(`tap: unreadable rows in ${file}; ignoring them for history lookup; run tap bus archive`);
 cache.set(file,{stamp,rows,invalid});
 if(strict&&invalid)throw new Error(`archive index unreadable: ${file}; refusing placement`);
 return rows;
}
function regular(path:string) {const stat=lstatSync(path);if(!stat.isFile() || stat.isSymbolicLink())throw new Error(`not an ordinary file: ${path}`);return stat;}
export function archivedPayload(home:string,id:string):string {
 const row=archiveRows(home).get(id);
 if(!row)return "";
 const path=join(home,"archive",row.month,"payloads",id+".md");
 for(const dir of [join(home,"archive",row.month),join(home,"archive",row.month,"payloads")])if(!lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink())throw new Error("unsafe archive path");
 regular(path);if(sha(readFileSync(path))!==row.payload_sha256)throw new Error("archived payload hash mismatch");return path;
}

/** The archived payload behind one index row, for address resolution: month,
 *  payload and receipt directories must be real directories, every receipt the
 *  row names must be a real file, and the payload bytes must hash to the row.
 *  Returns the canonical (symlink-resolved) path. */
export function archivedHistoryPayload(home:string,row:ArchiveRow):string {
 const month=join(home,"archive",row.month),path=join(month,"payloads",row.id+".md"),receipts=join(month,"receipts");
 for(const dir of [month,join(month,"payloads")])if(!safeDir(dir))throw new Error("unsafe archive path");
 if(!safeDir(receipts))throw new Error("unsafe archive receipt directory");
 for(const name of row.receipts){let st;try{st=lstatSync(join(receipts,name));}catch{throw new Error("missing or unsafe archived receipt");}if(!st.isFile()||st.isSymbolicLink())throw new Error("missing or unsafe archived receipt");}
 let st;try{st=lstatSync(path);}catch{throw new Error("missing or unsafe archived payload");}
 if(!st.isFile()||st.isSymbolicLink())throw new Error("missing or unsafe archived payload");
 if(sha(readFileSync(path))!==row.payload_sha256)throw new Error("archived payload hash mismatch");
 return realpathSync(path);
}
function safeDir(path:string):boolean {try{const st=lstatSync(path);return st.isDirectory()&&!st.isSymbolicLink();}catch{return false;}}

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
