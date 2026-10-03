// The refusal line for a verb module run as its OWN process — the
// `bun <module>` direct-run path, where main.ts's router is not
// on the stack to render a TapError. Same bytes as `tap_error_line`
// (lib.sh:370) and as the router's `nativeError`.

import { TapError } from "./context";
import { ensureAscii } from "./fsatomic";
import { humanAction, humanLine } from "./native-error";

/** `<label>: <detail>; next: <action>` with newlines flattened, as the incumbent prints. */
export function tapErrorLine(error: TapError, fallbackLabel: string): string {
  const label = error.verbLabel ?? fallbackLabel;
  const detail = humanLine(error.detail || error.errorClass.replace(/_/g, " "));
  return `${label}: ${detail}; next: ${humanAction(error.action)}\n`;
}

/**
 * `tap_error_json`: the refusal as one compact JSON object on STDOUT, which
 * is what `tap_fail` prints when the caller exported `TAP_JSON=1`. Python's
 * `json.dumps` escapes non-ASCII and DEL; `ensureAscii` now escapes both
 * (tap-u2nfe closed the DEL gap), so the DEL replace below is redundant belt,
 * kept until a separate cleanup retires it.
 */
export function tapErrorJson(error: TapError): string {
  const parts = [`"ok":false`, `"error_class":${JSON.stringify(error.errorClass)}`, `"action":${JSON.stringify(error.action)}`];
  if (error.detail) parts.push(`"detail":${JSON.stringify(error.detail)}`);
  if (error.effect) parts.push(`"effect":${JSON.stringify(error.effect)}`);
  return `${ensureAscii(`{${parts.join(",")}}`).replace(/\x7f/g, "\\u007f")}\n`;
}

/**
 * `tap_fail`, as one boundary: the refusal is rendered HERE, by the verb,
 * before any router sees it. Two reasons, both parity. The incumbent honoured
 * an EXPORTED `TAP_JSON=1` on every verb that sourced lib.sh, whether or not
 * the verb had a --json flag, and printed the refusal to stdout as JSON with
 * the detail's bytes intact; and its line form flattened CR/LF in the detail,
 * which the router's own renderer (main.ts `nativeError`) does not — so a
 * refusal quoting a user-supplied argument that carried a newline would print
 * as two lines on one door and one line on the other (partner review F2).
 * A TapError is the refusal it always was. An ordinary Error TAGGED with a
 * non-empty string `tapErrorClass` (plus optional string `tapAction`) — the
 * shape bus.ts throws for structural refusals it has no TapError to express —
 * renders as the refusal it declares, normalized to code 1 with the message
 * as detail and the fallback label for the line. Anything else propagates as
 * the crash it is.
 */
export function renderRefusals(fallbackLabel: string, body: () => number, env: NodeJS.ProcessEnv = process.env): number {
  try {
    return body();
  } catch (error) {
    const refusal = asTapRefusal(error, fallbackLabel);
    if (!refusal) throw error;
    if (env.TAP_JSON === "1") process.stdout.write(tapErrorJson(refusal));
    else process.stderr.write(tapErrorLine(refusal, fallbackLabel));
    return refusal.code;
  }
}

/** Async boundary for verbs that pause at the interactive target picker. */
export async function renderRefusalsAsync(fallbackLabel: string, body: () => Promise<number>, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const refusal = asTapRefusal(error, fallbackLabel);
    if (!refusal) throw error;
    if (env.TAP_JSON === "1") process.stdout.write(tapErrorJson(refusal));
    else process.stderr.write(tapErrorLine(refusal, fallbackLabel));
    return refusal.code;
  }
}

/**
 * The refusal an error declares, if any: an actual TapError verbatim (code,
 * class, action, detail, verbLabel all preserved), or a tagged ordinary Error
 * normalized to code 1 and the supplied fallback label.
 */
function asTapRefusal(error: unknown, fallbackLabel: string): TapError | null {
  if (error instanceof TapError) return error;
  if (!(error instanceof Error)) return null;
  const tagged = error as Error & { tapErrorClass?: unknown; tapAction?: unknown };
  if (typeof tagged.tapErrorClass !== "string" || tagged.tapErrorClass === "") return null;
  const action = typeof tagged.tapAction === "string" ? tagged.tapAction : "";
  return new TapError(1, tagged.tapErrorClass, action, error.message, fallbackLabel);
}

/** Run a verb body as a process entry (the `exec bun <module>` door). */
export function runEntry(fallbackLabel: string, body: () => number): number {
  return renderRefusals(fallbackLabel, body);
}
