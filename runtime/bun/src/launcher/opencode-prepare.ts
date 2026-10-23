/** Prepare OpenCode 2 session state before its TUI opens; no shared service or prompt is started. */
import { Notices } from "./catalog-notices";
import { requireOpenCode2 } from "./opencode-version";
import { realpathSync } from "node:fs";
import { INHERITED_IDENTITY_ENV } from "../session-store";
import { LauncherError, type SessionRecord } from "./types";
import { launchCommand } from "./process";
import { launchWorkdir } from "./workdir";
import { openCodeServerMode } from "./opencode-mode";
import { admitSharedOpenCode } from "./opencode-shared-service";
import { openCodeAPI, readOpenCodeService } from "../opencode-service";
import { sameOpenCodeService, type OpenCodeService } from "../opencode-shared";

const PREPARE_BUDGET_MS = 20_000;
type Model = { providerID: string; id: string; variant?: string };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const unavailable = (detail: string): never => {
  throw new LauncherError(detail, "opencode_model_unavailable", "choose a model and variant available in OpenCode, then retry", detail);
};

export async function prepareOpenCodeSession(record: SessionRecord, environment: NodeJS.ProcessEnv, signal?: AbortSignal, notices = new Notices()): Promise<string | null> {
  const requested = record.launch_tuning?.model ?? record.model ?? null;
  const effort = record.launch_tuning?.effort ?? null;
  const shared = openCodeServerMode(record, environment) === "shared";
  let service: OpenCodeService | undefined;
  const env: NodeJS.ProcessEnv = { ...environment, TAP_STATELESS: "1" };
  for (const key of INHERITED_IDENTITY_ENV) delete env[key];
  const directory = realpathSync(launchWorkdir(record));
  const deadline = Date.now() + PREPARE_BUDGET_MS;
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error("preparation exceeded its 20 second budget");
    if (service) return openCodeAPI(service, path, method, body);
    const result = await launchCommand(["opencode", "api", "--standalone", method, path,
      ...(body === undefined ? [] : ["--data", JSON.stringify(body)])], { cwd: directory, env, signal, timeoutMs });
    signal?.throwIfAborted();
    if (result.code !== 0) throw new Error(`OpenCode API exited ${result.code}`);
    try { return JSON.parse(result.stdout); } catch { throw new Error("OpenCode API returned invalid JSON"); }
  };
  try {
    requireOpenCode2(env, directory);
    if (shared) {
      service = await admitSharedOpenCode(directory, environment, signal);
      const { password: _password, ...fingerprint } = service;
      record.opencode_service = fingerprint;
      if (record.harness_session_id) {
        const session = (await api("GET", `/api/session/${record.harness_session_id}`))?.data;
        const current = readOpenCodeService(environment);
        if (session?.id !== record.harness_session_id || session.parentID || session.location?.directory !== directory ||
          !current || !sameOpenCodeService(service, current)) throw new Error("the native resume session or service generation could not be verified");
        return session.id;
      }
    }
    let model: Model | undefined;
    let variant = effort || undefined;
    if (requested) {
      const hash = requested.indexOf("#"), ref = hash < 0 ? requested : requested.slice(0, hash);
      const inline = hash < 0 ? undefined : requested.slice(hash + 1);
      if (hash >= 0 && (!inline || inline.includes("#"))) unavailable(`invalid OpenCode model variant in '${requested}'`);
      if (inline && variant && inline !== variant) unavailable(`OpenCode model variant '${inline}' conflicts with --effort '${variant}'`);
      variant ??= inline;
      const slash = ref.indexOf("/");
      if (slash <= 0 || slash === ref.length - 1) unavailable(`OpenCode model '${requested}' must be provider/model, optionally followed by #variant`);
      model = { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) };
    }
    if (model || variant) {
      const query = new URLSearchParams({ "location[directory]": directory }).toString();
      let candidate: any;
      if (model) {
        const response = await api("GET", `/api/model?${query}`);
        if (!object(response) || !Array.isArray(response.data)) throw new Error("OpenCode model catalog is unreadable");
        candidate = response.data.find((entry: any) => entry.providerID === model!.providerID && entry.id === model!.id && entry.enabled !== false);
      } else {
        const response = await api("GET", `/api/model/default?${query}`);
        candidate = response?.data;
      }
      if (!object(candidate) || typeof candidate.providerID !== "string" || typeof candidate.id !== "string")
        unavailable(`OpenCode model '${requested ?? "default"}' is unavailable in ${directory}`);
      if (variant && (!Array.isArray(candidate.variants) || !candidate.variants.some((entry: any) => entry.id === variant)))
        unavailable(`OpenCode model '${candidate.providerID}/${candidate.id}' has no variant '${variant}'`);
      model = { providerID: candidate.providerID, id: candidate.id, ...(variant ? { variant } : {}) };
    }
    const response = await api("POST", "/api/session", { location: { directory }, ...(model ? { model } : {}) });
    const session = response?.data;
    if (!object(session) || typeof session.id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(session.id) || session.location?.directory !== directory)
      throw new Error("OpenCode did not return a session in the requested directory");
    if (model && (session.model?.providerID !== model.providerID || session.model?.id !== model.id || (session.model?.variant ?? "default") !== (model.variant ?? "default")))
      throw new Error("OpenCode did not retain the requested model and variant");
    if (service) {
      const current = readOpenCodeService(environment);
      if (!current || !sameOpenCodeService(service, current)) throw new Error("native service changed during preparation");
    }
    return session.id;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof LauncherError) throw error;
    const cause = error instanceof Error ? error.message : String(error);
    if (shared || requested || effort) {
      const detail = `OpenCode session preparation failed: ${cause}; requested tuning was not applied`;
      throw new LauncherError(detail, "opencode_prepare_failed", shared ? "inspect the shared OpenCode service and retry; no seat was launched" : "start opencode --standalone in this directory to resolve its startup error, then retry", detail);
    }
    notices.emit(`tap session: OpenCode session preparation failed: ${cause}; launching without a prepared session. TAP context arrives on a later model step or turn.`);
    return null;
  }
}
