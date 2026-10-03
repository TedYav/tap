import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { TapError } from "./context";
import { isRegularFile } from "./index-home";
import { teamRegistryRefusal } from "./register-authority";
import { isMap, loads, pyStr, type JsonMap, type JsonValue } from "./watch-detect";
const str = (v: JsonValue | undefined): string => v === undefined ? "" : pyStr(v);
const fieldStr = (row: JsonMap, key: string): string => { const v = row.get(key); return v == null ? "" : str(v); };
const realOrSelf = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

export function duplicateIdentityOwner(nativeId: string, targetName: string, harnessFamily: string,
  actingPath: string, doc: JsonMap, indexHome: string): string {
  if (nativeId === "") return "";
  const ownerIn = (candidateReg: JsonValue | null, candidatePath: string, candidateTeam: string): string => {
    // An old-format registry cannot prove the id is unowned: refuse, never "no owner".
    const refusal = candidateReg === null ? null : teamRegistryRefusal(candidatePath, candidateReg);
    if (refusal) throw new TapError(1, refusal.errorClass, refusal.action, refusal.detail);
    if (!isMap(candidateReg)) return "";
    const rows = isMap(candidateReg.get("seats")) ? candidateReg.get("seats") as JsonMap : null;
    if (rows === null) return "";
    let sameRegistry = false;
    try { sameRegistry = realOrSelf(candidatePath) === realOrSelf(actingPath); } catch { sameRegistry = candidatePath === actingPath; }
    for (const [candidateName, candidate] of rows.entries()) {
      if (!isMap(candidate)) continue;
      if (fieldStr(candidate, "harness") !== harnessFamily) continue;
      if (fieldStr(candidate, "harness_session_id") !== nativeId) continue;
      if (sameRegistry && candidateName === targetName) continue;
      return `${candidateTeam}/${candidateName}`;
    }
    return "";
  };
  const localTeam = isMap(doc.get("team")) ? str((doc.get("team") as JsonMap).get("name")) : "";
  const owner = ownerIn(doc, actingPath, localTeam);
  if (owner !== "") return owner;
  const readJson = (p: string): JsonValue | null => {
    try { return loads(readFileSync(p, "utf8")); } catch { return null; }
  };
  const globalReg = readJson(join(indexHome, "global-registry.json"));
  if (isMap(globalReg) && isMap(globalReg.get("teams"))) {
    for (const [indexedName, indexed] of (globalReg.get("teams") as JsonMap).entries()) {
      if (!isMap(indexed)) continue;
      const candidatePath = str(indexed.get("registry_location"));
      if (candidatePath === "" || !isRegularFile(candidatePath)) continue;
      let same = false;
      try { same = realOrSelf(candidatePath) === realOrSelf(actingPath); } catch { /* compare textually when realpath fails */ }
      if (same) continue;
      const found = ownerIn(readJson(candidatePath), candidatePath, indexedName);
      if (found !== "") return found;
    }
  }
  return "";
}
