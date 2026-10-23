import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pidHasAncestor } from "./process-ancestry";
import { procStartEpoch } from "./reset";
import { acquireExistingFlock, flockState, namesCurrentFile, type FlockState } from "./remind-lock";

export interface CodexProcess { pid: string; start: string }
export interface CodexResetBoundary {
  home: string; oldSession: string; owner: CodexProcess; processUuid: string; afterId: number;
}
export interface CodexThreadStart { session: string; logId: number; loggedAt: number; writerLock: "would-block" }
export const RESET_THREAD_ROWS_SQL = "SELECT id, thread_id, ts FROM logs WHERE id > ? AND process_uuid = ? AND thread_id IS NOT NULL AND thread_id != ? AND NOT EXISTS (SELECT 1 FROM logs p WHERE p.thread_id = logs.thread_id AND p.id <= ?) ORDER BY id LIMIT 513";
export function sameCodexProcess(boundary: CodexResetBoundary, owner: CodexProcess | null): boolean {
  return !!owner && owner.pid === boundary.owner.pid && owner.start === boundary.owner.start;
}
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** npm's Node launcher owns the pane; the native logging process is its child. */
export function codexProcessInPane(processUuid: string, panePid: string,
  fx = { start: procStartEpoch, hasAncestor: pidHasAncestor }): CodexProcess | null {
  const pid=/^pid:([1-9][0-9]{0,9}):[^:]+$/.exec(processUuid)?.[1];
  if (!pid || Number(pid)>2147483647 || !/^[1-9][0-9]*$/.test(panePid)) return null;
  const start=fx.start(pid);
  if (!start || !fx.hasAncestor(Number(pid),panePid) || fx.start(pid)!==start) return null;
  return {pid,start};
}
/** Codex serializes lock creation/removal with this same coordination lock. */
export function codexWriterState(home: string, session: string): FlockState {
  const directory=join(home,"thread-writer-locks");
  const coordination=acquireExistingFlock(join(directory,".coordination.lock"));
  if (!coordination) return "unknown";
  let fd: number | undefined;
  try {
    const path=join(directory,`${session}.lock`);
    fd=openSync(path,constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile() || !namesCurrentFile(fd,path,true)) return "unknown";
    const state=flockState(fd);
    return namesCurrentFile(fd,path,true) ? state : "unknown";
  } catch (error) { return (error as NodeJS.ErrnoException).code==="ENOENT" ? "not-held" : "unknown"; } finally {
    try { if (fd!==undefined) closeSync(fd); } finally { coordination.release(); }
  }
}
/** A materialized rollout waits for native binding, even if its prefix is partial. */
export function codexRolloutAbsent(home: string, thread: CodexThreadStart): boolean {
  if (!THREAD_ID.test(thread.session) || !Number.isFinite(thread.loggedAt)) return false;
  try {
    // Codex chooses its local date. Three UTC dates cover all local offsets.
    for (const offset of [-86400,0,86400]) {
      const date=new Date((thread.loggedAt+offset)*1000).toISOString().slice(0,10).replaceAll("-","/");
      const directory=join(home,"sessions",date);
      let names: string[];
      try {
        if (!lstatSync(directory).isDirectory()) return false;
        names=readdirSync(directory);
      } catch (error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") continue; return false; }
      if (names.length>10000 || names.some(name=>name.startsWith("rollout-") && name.includes(thread.session))) return false;
    }
    return true;
  } catch { return false; }
}
function codexHome(transcript: string): string | null {
  if (!isAbsolute(transcript)) return null;
  // The verified rollout binds the store; a worker's ambient HOME does not.
  for (let parent=dirname(transcript); parent!==dirname(parent); parent=dirname(parent)) {
    if (basename(parent)==="sessions") return dirname(parent);
  }
  return null;
}
function readStore<T>(home: string, read: (db: Database)=>T): T | null {
  let db: Database | undefined;
  try {
    db=new Database(join(home,"logs_2.sqlite"),{readonly:true});
    db.exec("PRAGMA busy_timeout=50");
    return read(db);
  } catch { return null; } finally { db?.close(); }
}
/** One SQLite snapshot binds the old thread to this process and fences prior rows. */
export function captureCodexResetBoundary(transcript: string, oldSession: string, resolveOwner: (processUuid:string)=>CodexProcess | null): CodexResetBoundary | null {
  const home=codexHome(transcript);
  if (!home || !THREAD_ID.test(oldSession)) return null;
  return readStore(home,db=>{
    const row=db.query("SELECT process_uuid, (SELECT COALESCE(MAX(id),0) FROM logs) AS after_id FROM logs WHERE thread_id = ? AND process_uuid IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(oldSession) as {process_uuid:string;after_id:number} | null;
    if (!row || !Number.isSafeInteger(row.after_id) || row.after_id<0) return null;
    const owner=resolveOwner(row.process_uuid);
    if (!owner || !owner.start || !row.process_uuid.startsWith(`pid:${owner.pid}:`)) return null;
    return {home,oldSession,owner:{...owner},processUuid:row.process_uuid,afterId:row.after_id};
  });
}
/** Logs precede lazy rollout creation. A writer lock excludes native auxiliary threads. */
export function nextCodexResetThread(boundary: CodexResetBoundary, owner: CodexProcess | null,
  probe: (home:string,session:string)=>FlockState = codexWriterState): CodexThreadStart | null {
  if (!sameCodexProcess(boundary,owner)) return null;
  return readStore(boundary.home,db=>{
    const rows=db.query(RESET_THREAD_ROWS_SQL).all(boundary.afterId,boundary.processUuid,boundary.oldSession,boundary.afterId) as {id:number;thread_id:string;ts:number}[];
    if (rows.length>512) return null;
    const distinct=new Map<string,{id:number;thread_id:string;ts:number}>();
    for (const row of rows) {
      if (!THREAD_ID.test(row.thread_id)) continue;
      if (!Number.isFinite(row.ts)) return null;
      if (!distinct.has(row.thread_id)) distinct.set(row.thread_id,row);
    }
    const candidates: CodexThreadStart[]=[];
    for (const row of distinct.values()) {
      const state=probe(boundary.home,row.thread_id);
      if (state==="unknown") return null;
      if (state==="held") candidates.push({session:row.thread_id,logId:row.id,loggedAt:row.ts,writerLock:"would-block"});
    }
    return candidates.length===1 ? candidates[0]! : null;
  });
}
