// The fixture builder for the retired `observe.ts --from-env` door.
//
// `payloadFromEnv` was a src export with only test callers after the
// team-unbound-state port deleted the door's last CLI edge, so it moved here
// (tap-8esm5). Its consumers — team-unbound-state.test.ts and
// observe-env-fixture.test.ts — drive `payloadFromEnv` + `observeRows`
// in-process, and this builder assembles exactly the payload the deleted
// door's adapter assembled from its env, TAP_OBS_* knob for knob.
//
// THE ENVIRONMENT IS READ HERE, standing in for the process the adapter
// spawned, exactly as the Python read it in the process Bash spawned. That is
// deliberate: slice 1 shipped a defect where an in-process native caller
// silently lost a configured `TAP_REGISTRY_EVENT_LIMIT`, because the Bash
// adapter's env had reached the old writer only by virtue of being a child
// process and an in-process call has no such inheritance moment. Every knob
// this builder honors is resolved from the env passed in, never defaulted at
// a call site.
import { readFileSync } from "node:fs";
import type { ObservePayload, RowInput } from "../../src/observe";

function readTextFile(path: string): string {
  // An UNSET path is "no snapshot was offered" and reads as empty, exactly as
  // the incumbent's caller passed no file. A SET path that cannot be read is a
  // different fact and must not collapse into the first: the deleted
  // `_read_text_file` let the error propagate, so a nonempty
  // TAP_OBS_SESSIONS_FILE that vanished exited 1 with no classification.
  //
  // Swallowing it produced an affirmative empty inventory at rc=0 — an active
  // row became `gone / session_absent` where the incumbent said
  // `unknown / harness_unobservable`, and Bash refresh admits `gone` to the
  // trim candidates. A missing file must never authorize a claim about what
  // exists (review, F1).
  if (!path) return "";
  return readFileSync(path, "utf8");
}

export function payloadFromEnv(rows: RowInput[], env: NodeJS.ProcessEnv = process.env): ObservePayload {
  const payload: ObservePayload = {
    rows,
    now_boot: env.TAP_OBS_NOW_BOOT ?? "",
    legacy_boot: env.TAP_OBS_LEGACY_BOOT ?? "",
    now_ts: Number.parseInt(env.TAP_OBS_NOW_TS || "0", 10) || 0,
    tap_boot_id_set: env.TAP_OBS_BOOT_SET === "1",
    tap_boot_id_legacy_set: env.TAP_OBS_LEGACY_SET === "1",
    sessions_rc: Number.parseInt(env.TAP_OBS_SESSIONS_RC || "1", 10),
    panes_rc: Number.parseInt(env.TAP_OBS_PANES_RC || "1", 10),
    ps_rc: Number.parseInt(env.TAP_OBS_PS_RC || "1", 10),
    sessions_text: readTextFile(env.TAP_OBS_SESSIONS_FILE ?? ""),
    panes_text: readTextFile(env.TAP_OBS_PANES_FILE ?? ""),
    ps_text: readTextFile(env.TAP_OBS_PS_FILE ?? ""),
    session_scope: env.TAP_OBS_SESSION_SCOPE ?? "",
  };
  // Absent => parse raw epochs. Present (even "") => the pin wins. `in` is the
  // test, not truthiness, because "" is a meaningful pin.
  if ("TAP_SERVER_EPOCH" in env) payload.server_epoch_pin = env.TAP_SERVER_EPOCH ?? "";
  return payload;
}
