// A `ps -o ppid= -o tty=` row read from the OS process table without running `ps`.
//
// Codex's auto sandbox refuses to exec setuid binaries, so `ps` cannot run inside a seat's tool
// shell and the caller-pane walk would never find its terminal. libproc's proc_pidinfo works
// there and reports ancestors outside the sandbox too. Darwin only; any other host, or any
// failure, returns null and the caller keeps its existing "observation unavailable" refusal.
import { dlopen, FFIType, ptr } from "bun:ffi";

const NODEV = 0xffffffff;
const PROC_PIDTBSDINFO = 3;
const BSDINFO_SIZE = 136;
const S_IFCHR = 0o020000;

export type Libc = { pidinfo: (pid: number, flavor: number, arg: bigint, buf: ReturnType<typeof ptr>, size: number) => number;
  devname: (dev: number, type: number, buf: ReturnType<typeof ptr>, len: number) => unknown };
let libc: Libc | null | undefined;

/** Executable/parent/birth from the same proc_bsdinfo record as the tty fallback.
 * Layout: Apple XNU bsd/sys/proc_info.h, struct proc_bsdinfo. Birth is rounded
 * to seconds to agree with ps lstart and existing persisted fingerprints. */
export function libprocIdentity(pid: number): { pid: number; ppid: number; start: number; command: string } | null {
  const lib = process.platform === "darwin" ? load() : null;
  if (!lib) return null;
  try {
    const info = new Uint8Array(BSDINFO_SIZE);
    if (lib.pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(info), BSDINFO_SIZE) !== BSDINFO_SIZE) return null;
    const view = new DataView(info.buffer);
    if (view.getUint32(12, true) !== pid) return null;
    const name = info.subarray(48, 64), end = name.indexOf(0);
    const command = new TextDecoder().decode(name.subarray(0, end < 0 ? name.length : end));
    const start = Number(view.getBigUint64(120, true)) * 1000;
    if (!command || !Number.isSafeInteger(start) || start <= 0) return null;
    return { pid, ppid: view.getUint32(16, true), start, command };
  } catch { return null; }
}

function load(): Libc | null {
  if (libc !== undefined) return libc;
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      devname_r: { args: [FFIType.i32, FFIType.u16, FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    });
    libc = { pidinfo: lib.symbols.proc_pidinfo, devname: lib.symbols.devname_r };
  } catch {
    libc = null;
  }
  return libc;
}

/** "<ppid> <tty>" for `pid` (tty is `??` without a controlling terminal), or null when unreadable. `lib` is injectable for tests. */
export function libprocRow(pid: number, lib: Libc | null = process.platform === "darwin" ? load() : null): string | null {
  if (!lib) return null;
  try {
    const info = new Uint8Array(BSDINFO_SIZE);
    if (lib.pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(info), BSDINFO_SIZE) !== BSDINFO_SIZE) return null;
    const view = new DataView(info.buffer);
    const ppid = view.getUint32(16, true);
    const tdev = view.getUint32(108, true);
    if (tdev === NODEV) return `${ppid} ??`;
    const name = new Uint8Array(64);
    if (!lib.devname(tdev | 0, S_IFCHR, ptr(name), name.length)) return `${ppid} ??`;
    const end = name.indexOf(0);
    const tty = new TextDecoder().decode(name.subarray(0, end < 0 ? name.length : end));
    return `${ppid} ${tty || "??"}`;
  } catch {
    return null;
  }
}
