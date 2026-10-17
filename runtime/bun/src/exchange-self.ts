import { callerPaneObservation, observeCallerPaneChain, resolveSelf, TapError, type Context } from "./context";

/** Omitted read target: observe the caller, then apply the usual identity gates. */
export function exchangeSelf(ctx: Context, verb: "poll" | "outstanding"): string {
  const chain = observeCallerPaneChain(process.env, ctx);
  const caller = callerPaneObservation(chain);
  const action = `tap ${verb} <handle>`;
  if (!caller) {
    throw new TapError(1, "not_in_tmux", action,
      `caller pane is not observable (${chain.ok ? "no pane" : chain.reason}); pass the positional handle`);
  }
  try { return resolveSelf(ctx, caller, 1).handle; }
  catch (error) {
    if (error instanceof TapError && caller.status !== "ok") {
      throw new TapError(error.code, error.errorClass, `${error.action}  OR  ${action}`, error.detail);
    }
    throw error;
  }
}
