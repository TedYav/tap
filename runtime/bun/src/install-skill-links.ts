import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readManifestRecord, writeManifestAtomically, type ManifestEntry } from "./install-manifest";
import { probeHarness, SKILL_LABEL_KEYS, wiresHome } from "./install-harness-state";
import { aliasBody, aliasDirectory, canonicalSkillName, CORE_SKILLS, OPTIONAL_SKILLS, LEGACY_SKILL_NAMES, flatSkillName, REPO_LOCAL_SKILLS, RETIRED_SKILLS, SKILL_HOMES, savedFullKit, skillManifestPath } from "./skill-policy";
import { installSkillPlugin, skillPluginReady } from "./install-skill-plugin";

/** The uninstall manifest owns the literal target, including dangling links. */
export function removeOwnedLink(path: string, target: string, apply = true): string {
  try {
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target) return "preserved changed target";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already missing";
    throw error;
  }
  if (apply) rmSync(path);
  return "removed";
}
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const stat = (path: string) => lstatSync(path,{throwIfNoEntry:false});
function owned(entry: ManifestEntry | undefined): boolean {
  if (!entry) return false;
  const value = stat(entry.path);
  if (!value) return false;
  return entry.kind === "symlink" ? value.isSymbolicLink() && readlinkSync(entry.path) === entry.target
    : entry.kind === "file" && value.isFile() && !value.isSymbolicLink() && digest(readFileSync(entry.path)) === entry.sha256;
}

/** A fixable integration failure; native effects remain recorded for retry/uninstall. */
export type SkillLinkFailure = { ok: false; label: string; path: string; code: string; verb: "read" | "write"; remedy: string; partial: boolean };
export type SkillLinkResult = { ok: true } | SkillLinkFailure;

/** A blocker the caller can name and fix; any other Error is a defect and still throws. */
class LinkBlocked extends Error {
  constructor(readonly path: string, readonly code: string, readonly remedy: string, readonly verb: "read" | "write" = "write") { super(`${code} at ${path}`); }
}

/** The first existing non-directory on the way to `path`: the file squatting where a directory should be. */
function inTheWay(path: string): string | undefined {
  for (let p = path; ; p = dirname(p)) {
    let value;
    try { value = statSync(p); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (dirname(p) === p) return undefined; continue; }
      return undefined;
    }
    return value.isDirectory() ? undefined : p;
  }
}

/** An atomic write stages a sibling temp file; the user cares about the file it was replacing. */
function writeNamed(dest: string, bytes: string): void {
  try { writeManifestAtomically(dest, bytes); } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === "string") Object.assign(error as object, { path: dest, dest: undefined });
    throw error;
  }
}

/** Turn a filesystem error into a blocker whose remedy fits what is actually wrong. */
function blockerFor(error: unknown, fallback: string): LinkBlocked | undefined {
  const { code, dest, path } = error as NodeJS.ErrnoException & { dest?: string };
  if (typeof code !== "string") return undefined;
  const target = dest ?? path ?? fallback;
  if (code === "ENOTDIR" || code === "EEXIST") {
    const squatter = inTheWay(target) ?? inTheWay(fallback);
    if (squatter) return new LinkBlocked(squatter, code, `move ${squatter} aside and rerun ./install.sh`);
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new LinkBlocked(target, code, `make ${dirname(target)} writable and rerun ./install.sh`);
  if (code === "ENOSPC") return new LinkBlocked(target, code, `free disk space under ${dirname(target)} and rerun ./install.sh`);
  return new LinkBlocked(target, code, `fix ${code} at ${target} and rerun ./install.sh`);
}

export function formatSkillLinkFailure(f: SkillLinkFailure): string {
  if (f.code === "PLUGIN") return `install: WARNING: ${f.label} TAP plugin not registered; existing owned skill entrypoints were refreshed. Next: ${f.remedy}`;
  const state = f.partial ? `${f.label} skills may be partially linked` : `${f.label} skills NOT linked`;
  return `install: WARNING: skipped ${f.label} skill links — could not ${f.verb} ${f.path} (${f.code}); next: ${f.remedy} (${state}; the rest of the install continues)`;
}

/**
 * Reconcile one harness through the existing literal-target/hash manifest.
 *
 * Loose-link writes are transactional: a failure unwinds this run's links,
 * wrappers, directories and manifest edits. Native registration uses a separate
 * ownership journal; if it fails, only existing owned entrypoints are repaired.
 * Link progress lines are held back and printed
 * only once the harness fully succeeded. A blocker the user can fix (permissions,
 * a full disk, a file in the way) returns a typed failure for the caller to
 * report; anything else is a defect and throws.
 */
export function installSkillLinks(repo: string, label: string, home: string, fullKit = savedFullKit(), log: (line:string)=>void = console.log): SkillLinkResult {
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    log(`install: skipped ${label} — ${home} does not exist (no ${label} install detected)`); return { ok: true };
  }
  // A present home whose harness is not installed is left alone by every writer (tap-gjwtw).
  const key = SKILL_LABEL_KEYS[label], probe = key ? probeHarness(key, home) : undefined;
  if (probe && !wiresHome(probe)) { log(`install: skipped ${label} — present, not wired: ${probe.reason}`); return { ok: true }; }
  const manifestPath = skillManifestPath(), directory = join(home,"skills");
  const lines: string[] = [], undo: Array<() => void> = [];
  let current = directory, snapshotted = false;
  let pluginFailure: SkillLinkFailure | undefined, keepLegacy = false;
  try {
    const native = label === "Claude" || label === "Codex";
    if (native) {
      try { installSkillPlugin(repo, label === "Claude" ? "claude" : "codex", home, log); }
      catch (error) {
        keepLegacy = true;
        pluginFailure = { ok: false, label, path: home, code: "PLUGIN", verb: "write", remedy: (error as Error).message, partial: false };
      }
    }
    let manifest: ReturnType<typeof readManifestRecord>;
    try { manifest = readManifestRecord(manifestPath); } catch (error) {
      // An unreadable manifest is ownership evidence the user must restore, and
      // nothing here has touched it: fail without a write-side remedy.
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === "string") throw new LinkBlocked(manifestPath,code,`make ${manifestPath} readable and rerun ./install.sh`,"read");
      throw error;
    }
    if (label === "shared agents") {
      const targets = manifest.targets as Record<string,string> | undefined;
      for (const [key,host,suffix] of [["CLAUDE_HOME","claude",".claude"],["CODEX_HOME","codex",".codex"]] as const) {
        const nativeHome = targets?.[key] || process.env[`TAP_${key}`] || join(homedir(),suffix);
        if (existsSync(nativeHome) && !skillPluginReady(repo,host,nativeHome)) {
          keepLegacy = true;
          lines.push("install: kept shared TAP entrypoints until native plugin registration succeeds");
          break;
        }
      }
    }
    // A caller-selected harness home may be a symlink, as before. Its skills
    // directory remains user-owned, but each leaf needs independent authority.
    if ((native || label === "shared agents") && existsSync(directory) && !statSync(directory).isDirectory()) {
      log(`install: preserved ${label} skill root ${directory}`);
      return pluginFailure ?? { ok: true };
    }
    const madeDirectory = mkdirSync(directory,{recursive:true});
    if (madeDirectory) undo.push(() => rmSync(madeDirectory,{recursive:true,force:true}));
    const entryAt = (path:string,kind:string) => manifest.entries.find(e=>e.path===path && e.kind===kind);
    const record = (entry:ManifestEntry) => {
      // The manifest is restored only once this run is about to change it.
      if (!snapshotted) {
        snapshotted = true;
        const raw = existsSync(manifestPath) ? readFileSync(manifestPath,"utf8") : undefined;
        undo.push(() => raw === undefined ? rmSync(manifestPath,{force:true}) : writeManifestAtomically(manifestPath,raw));
      }
      manifest.entries = manifest.entries.filter(e=>!(e.path===entry.path && e.kind===entry.kind));
      manifest.entries.push(entry);
      manifest.repo ??= repo;
      writeNamed(manifestPath,JSON.stringify(manifest,null,2)+"\n");
    };
    const unlink = (path:string,target:string) => { removeOwnedLink(path,target); undo.push(() => symlinkSync(target,path)); };
    const optional = OPTIONAL_SKILLS.map(flatSkillName), defaults = CORE_SKILLS.map(flatSkillName);
    const preserved = fullKit === undefined ? OPTIONAL_SKILLS.filter(name =>
      [name, flatSkillName(name), ...(name === "conduct" ? ["conductor"] : [])].some(old => owned(entryAt(join(directory,old),"symlink")))
    ).map(flatSkillName) : [];
    // A failed native migration still needs functioning old entrypoints: their
    // recorded symlinks may target directories this release renamed. Repair
    // only those existing names, then retire them after native registration.
    const desired = keepLegacy ? LEGACY_SKILL_NAMES.filter(name => owned(entryAt(join(directory,name),"symlink")))
      : native || label === "shared agents" ? [] : [...defaults,...(fullKit === true ? optional : preserved)];
    const core = keepLegacy ? desired : defaults;
    const obsolete = keepLegacy ? [] : [...new Set([...RETIRED_SKILLS,...REPO_LOCAL_SKILLS,...LEGACY_SKILL_NAMES])].filter(name => !desired.includes(name));
    for (const name of obsolete) {
      const path=join(directory,name), entry=entryAt(path,"symlink");
      current=path;
      if (owned(entry)) { unlink(path,entry!.target as string); lines.push(`install: unlinked owned ${label} skill ${name}`); }
    }
    for (const name of desired) {
      const path=join(directory,name), existing=stat(path), prior=entryAt(path,"symlink");
      const canonical=canonicalSkillName(name);
      const target=name === "tap" ? join(repo,"skills/tap") : aliasDirectory(manifestPath,name);
      current=path;
      if (existing && (!existing.isSymbolicLink() || !owned(prior))) {
        if (core.includes(name)) throw new LinkBlocked(path,"EEXIST",`move ${path} aside (it was preserved) or choose another ${label} home, then rerun ./install.sh`);
        lines.push(`install: preserved ${label} skill ${name} — unowned or changed ${path}`); continue;
      }
      const source=join(repo,"skills",canonical,"SKILL.md");
      if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`missing shipped skill ${source}; restore the checkout before reinstalling`);
      if (name !== "tap") {
        const wrapper=join(target,"SKILL.md"), bytes=aliasBody(name,canonical,readFileSync(source,"utf8")), old=entryAt(wrapper,"file");
        const root=dirname(target);
        if ([root,target].some(p=>stat(p) && (!stat(p)!.isDirectory() || stat(p)!.isSymbolicLink())) || (stat(wrapper) && !owned(old))) {
          if (core.includes(name)) throw new LinkBlocked(wrapper,"EEXIST",`move ${wrapper} aside (it was preserved), then rerun ./install.sh`);
          lines.push(`install: preserved edited or foreign alias ${name}: ${wrapper}`); continue;
        }
        current=target;
        const madeAlias = mkdirSync(target,{recursive:true});
        if (madeAlias) undo.push(() => rmSync(madeAlias,{recursive:true,force:true}));
        const prev = stat(wrapper) ? readFileSync(wrapper,"utf8") : undefined;
        if (prev!==bytes) {
          current=wrapper;
          writeNamed(wrapper,bytes);
          undo.push(() => prev===undefined ? rmSync(wrapper,{force:true}) : writeManifestAtomically(wrapper,prev));
        }
        record({kind:"file",path:wrapper,sha256:digest(bytes)});
      }
      current=path;
      if (!existing || readlinkSync(path)!==target) {
        if (existing) unlink(path,prior!.target as string);
        symlinkSync(target,path);
        undo.push(() => rmSync(path,{force:true}));
      }
      record({kind:"symlink",path,target});
      lines.push(`install: linked ${label} skill ${path} -> ${target}`);
    }
    for (const name of new Set(LEGACY_SKILL_NAMES)) {
      const dir=aliasDirectory(manifestPath,name), wrapper=join(dir,"SKILL.md"), entry=entryAt(wrapper,"file");
      // Wrappers are shared by every harness, so one that still links this alias
      // (a harness that rolled back keeps its old links) needs the wrapper.
      const needed=manifest.entries.some(e=>e.kind==="symlink" && e.target===dir && owned(e));
      if (!needed && owned(entry)) { const bytes=readFileSync(wrapper,"utf8"); rmSync(wrapper); undo.push(() => writeManifestAtomically(wrapper,bytes)); }
    }
    if (preserved.length) lines.push(`install: preserved optional ${label} skills: ${preserved.join(", ")}; change via tap setup --machine or answers fullKit: true/false.`);
  } catch (error) {
    const blocked = error instanceof LinkBlocked ? error : blockerFor(error,current);
    // Every failure unwinds, defects included: a harness is never left half-linked.
    let partial = false;
    for (const step of undo.reverse()) { try { step(); } catch { partial = true; } }
    if (!blocked) throw error;
    return { ok: false, label, path: blocked.path, code: blocked.code, verb: blocked.verb, remedy: blocked.remedy, partial };
  }
  for (const line of lines) log(line);
  return pluginFailure ?? { ok: true };
}

/** Setup and the installer use the same link writer and recorded destinations. */
export function installMachineSkills(repo:string, fullKit:boolean, log:(line:string)=>void = console.log, verbose = false):void {
  const manifest=readManifestRecord(skillManifestPath());
  const targets=manifest.targets as Record<string,string> | undefined;
  const failed:string[]=[], absent:string[]=[];
  let links=0, homes=0;
  for (const [key,[label,suffix]] of Object.entries(SKILL_HOMES)) {
    // fullKit controls flat hosts. Native refresh and shared-root retirement
    // belong to install.sh, not a preference change in the setup wizard.
    if (["CLAUDE_HOME","CODEX_HOME","AGENTS_HOME"].includes(key)) continue;
    const home=targets?.[key] || process.env[`TAP_${key}`] || join(homedir(),suffix);
    let linked=false;
    const result=installSkillLinks(repo,label,home,fullKit,line=>{
      if (line.startsWith(`install: linked ${label} skill `)) {
        links++; linked=true;
        if (verbose) log(line);
      } else if (line === `install: skipped ${label} — ${home} does not exist (no ${label} install detected)`) {
        absent.push(label);
        if (verbose) log(line);
      } else log(line);
    });
    if (linked) homes++;
    if (!result.ok) { log(formatSkillLinkFailure(result)); failed.push(label); }
  }
  log(`install: ${links} skill links refreshed across ${homes} homes (${fullKit ? "full kit" : "core kit"})`);
  if (absent.length) log(`install: optional skill homes absent: ${absent.join(", ")}`);
  log("install: per-link output: rerun tap setup --machine with --verbose");
  // Every home is tried; setup still reports the ones that were not linked.
  if (failed.length) throw new Error(`skill links not installed for: ${failed.join(", ")}`);
}
if (import.meta.main) {
  try {
    const [mode,repo,label,home,...rest]=process.argv.slice(2);
    if(mode!=="install" || !repo || !label || !home || rest.length) throw new Error("expected install <repo> <label> <home>");
    // A fixable blocker was already unwound; warn and exit 0 so the installer
    // carries on to the next harness (optional user-config writers never stop it).
    const result=installSkillLinks(repo,label,home);
    if (!result.ok) console.error(formatSkillLinkFailure(result));
  } catch(error) { console.error(`install: skill links failed: ${error}`);process.exitCode=1; }
}
