/** Native folder trust, including its normal project settings. No separate approval dialogs. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite } from "./fsatomic";
import { readSecureBytes, table } from "./config-file";
import { acquireNoFollowLock } from "./remind-lock";
import { editTomlKey } from "./verbs/config";

type Doc = Record<string, unknown>;
const rawJson = JSON as unknown as { rawJSON(source: string): unknown; isRawJSON(value: unknown): boolean };
const object = (value: unknown): value is Doc => table(value) && !rawJson.isRawJSON(value);
export type FolderTrustTarget = { harness: string; path: string; format: "codex" | "claude" | "agy" | "cursor" };
export type FolderTrustResult = { harness: string; status: "trusted" | "already_trusted" | "failed"; detail?: string };

export function folderTrustPath(target: FolderTrustTarget): string {
  // A dangling link is existing operator state, not an absent config.
  return lstatSync(target.path, { throwIfNoEntry: false }) ? realpathSync(target.path) : target.path;
}

/** The concrete native setting the operator is consenting to. */
export function folderTrustGrant(target: FolderTrustTarget, folder: string): string {
  const key = JSON.stringify(folder);
  switch (target.format) {
    case "codex": return `projects[${key}].trust_level = "trusted"`;
    case "claude": return `projects[${key}].hasTrustDialogAccepted = true`;
    case "agy": return `trustedWorkspaces includes ${key}`;
    case "cursor": return `.workspace-trusted with workspacePath = ${key}, trustMethod = "cli-flag"`;
  }
}

/** Read-only preparation, also used under apply's lock. */
export function prepareFolderTrust(path: string, folder: string, format: FolderTrustTarget["format"]) {
  const before = existsSync(path) ? readSecureBytes(path).bytes : null;
  const source = before ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(before) : "";
  return { before, source, edited: editFolderTrust(source, folder, format) };
}

function absolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

/** Match the installed harness's native store, including its location overrides. */
export function folderTrustTargets(folder: string, env: NodeJS.ProcessEnv = process.env,
  installed = (command: string) => Bun.which(command, { PATH: env.PATH }) !== null): { targets: FolderTrustTarget[]; failures: FolderTrustResult[] } {
  const home = () => absolute(env.HOME || "", "HOME");
  const targets: FolderTrustTarget[] = [];
  const failures: FolderTrustResult[] = [];
  const add = (command: string, harness: string, format: FolderTrustTarget["format"], locate: () => string) => {
    if (!installed(command)) return;
    try { targets.push({ harness, format, path: locate() }); }
    catch (error) { failures.push({ harness, status: "failed", detail: (error as Error).message }); }
  };
  add("codex", "Codex", "codex", () => join(absolute(env.CODEX_HOME || join(home(), ".codex"), "CODEX_HOME"), "config.toml"));
  add("agy", "Antigravity", "agy", () => join(home(), ".gemini/antigravity-cli/settings.json"));
  add("claude", "Claude", "claude", () => {
    const config = absolute(env.CLAUDE_CONFIG_DIR || join(home(), ".claude"), "CLAUDE_CONFIG_DIR");
    const legacy = join(config, ".config.json");
    return existsSync(legacy) ? legacy : join(env.CLAUDE_CONFIG_DIR || home(), ".claude.json");
  });
  add("cursor-agent", "Cursor", "cursor", () => {
    // Cursor's workspace-paths.js r_: the marker is shared by later launches.
    const slug = folder.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("Cursor cannot name a folder-trust marker for this directory");
    return join(absolute(env.CURSOR_DATA_DIR?.trim() || join(home(), ".cursor"), "CURSOR_DATA_DIR"), "projects", slug, ".workspace-trusted");
  });
  return { targets, failures };
}

function objectAt(doc: Doc, key: string): Doc {
  if (doc[key] === undefined) doc[key] = {};
  if (!object(doc[key])) throw new Error(`existing ${key} is not an object`);
  return doc[key] as Doc;
}

export function editFolderTrust(source: string, folder: string, format: FolderTrustTarget["format"]): string {
  let parsed: unknown;
  try {
    parsed = source ? (format === "codex" ? Bun.TOML.parse(source) : JSON.parse(source,
      (_key, value, context?: { source: string }) => typeof value === "number" && context?.source ? rawJson.rawJSON(context.source) : value)) : {};
  }
  catch { throw new Error(`existing configuration is not valid ${format === "codex" ? "TOML" : "JSON"}; left unchanged`); }
  if (!object(parsed)) throw new Error("configuration must be an object");
  const doc = parsed as Doc;
  if (format === "codex") {
    const project = objectAt(objectAt(doc, "projects"), folder);
    if (project.trust_level === "trusted") return source;
    project.trust_level = "trusted";
    const edited = editTomlKey(source, ["projects", folder, "trust_level"], '"trusted"');
    // The text editor locates a key; the parser proves that nothing else changed.
    if (!isDeepStrictEqual(Bun.TOML.parse(edited), doc)) throw new Error("could not edit this TOML layout without changing other settings");
    return edited;
  }
  if (format === "claude") {
    const project = objectAt(objectAt(doc, "projects"), folder);
    if (project.hasTrustDialogAccepted === true) return source;
    project.hasTrustDialogAccepted = true;
  } else if (format === "agy") {
    const trusted = doc.trustedWorkspaces ?? [];
    if (!Array.isArray(trusted) || trusted.some(path => typeof path !== "string")) throw new Error("trustedWorkspaces must be a string array");
    if (trusted.includes(folder)) return source;
    doc.trustedWorkspaces = [...trusted, folder];
  } else {
    // Do not overwrite a marker belonging to a different path with the same native slug.
    if (source) {
      if (doc.workspacePath !== folder) throw new Error("existing Cursor marker does not name this directory");
      return source;
    }
    Object.assign(doc, { workspacePath: folder, trustedAt: new Date().toISOString(), trustMethod: "cli-flag" });
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function trustFolder(folder: string, targets: FolderTrustTarget[]): FolderTrustResult[] {
  const canonical = realpathSync(folder);
  return targets.map((target): FolderTrustResult => {
    try {
      const path = folderTrustPath(target);
      mkdirSync(dirname(path), { recursive: true });
      const lock = acquireNoFollowLock(`${path}.tap-folder-trust.lock`, 2500);
      if (!lock) throw new Error("folder-trust update is busy; retry");
      try {
        const { before, source, edited } = prepareFolderTrust(path, canonical, target.format);
        if (edited === source) return { harness: target.harness, status: "already_trusted" };
        // Native harnesses do not share TAP's lock: refuse observed concurrent edits.
        if (before ? !readFileSync(path).equals(before) : existsSync(path)) throw new Error("configuration changed while preparing the update; retry");
        atomicWrite(path, edited, before ? statSync(path).mode & 0o777 : 0o600);
        return { harness: target.harness, status: "trusted" };
      } finally { lock.release(); }
    } catch (error) {
      return { harness: target.harness, status: "failed", detail: (error as Error).message };
    }
  });
}
