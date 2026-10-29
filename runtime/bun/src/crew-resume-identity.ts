import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LauncherError } from "./launcher/types";
import { NATIVE_CONVERSATION_ID, nativeConversationExists } from "./native-conversation";
import { duplicateIdentityOwner } from "./session-identity-owner";
import { isMap, loads, type JsonMap } from "./watch-detect";
import { TapError } from "./context";

export function assertCrewResumeIdentity(harness: string, id: string, cwd: string, childEnv: NodeJS.ProcessEnv): void {
  if (!NATIVE_CONVERSATION_ID.test(id)) throw new LauncherError("--resume requires one exact native conversation id", "launch_arg_invalid", "pass --resume <native-id>");
  if (!nativeConversationExists(harness, id, cwd, childEnv)) throw new LauncherError(
    `no verified ${harness} conversation '${id}' in the native store for cwd '${cwd}'; nothing launched`,
    "no_exact_resume_identity", "use the original cwd and preset/environment, or check the id in the harness's session list");
}

/** Same owner census as registration; the locked caller may supply its current lossless document. */
export function assertCrewResumeUnheld(harness: string, id: string, registryPath: string, handle = "",
  env: NodeJS.ProcessEnv = process.env, lockedDoc?: JsonMap): void {
  const doc = lockedDoc ?? loads(readFileSync(registryPath, "utf8"));
  if (!isMap(doc)) throw new LauncherError("crew registry is not an object", "registry_invalid", "tap team doctor");
  let owner: string;
  try { owner = duplicateIdentityOwner(id, handle, harness, registryPath, doc, env.TAP_INDEX_HOME || join(env.HOME || homedir(), ".tap")); }
  catch (error) {
    if (!(error instanceof TapError)) throw error;
    throw new LauncherError(error.detail, error.errorClass, error.action, error.detail);
  }
  if (owner) throw new LauncherError(`native ${harness} session id ${id} already belongs to expected seat ${owner}`,
    "duplicate_identity_owner", `resume ${owner} instead, or choose an unheld native conversation`);
}
