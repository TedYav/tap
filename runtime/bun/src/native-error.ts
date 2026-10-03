// Formatters moved verbatim from main.ts so native form modules render Bash-identical refusals without importing
// main.ts. `tap_error_line` folds LF/CR to spaces so one refusal is one line; single-token actions get
// underscores spaced, space/slash passes through; TAP_JSON=1 refusal is JSON.
import { ensureAscii } from "./fsatomic";

export function humanAction(action: string): string {
  const flat = action.replace(/[\r\n]/g, " ");
  return /[ /]/.test(flat) ? flat : flat.replace(/_/g, " ");
}

export function humanLine(text: string): string {
  return text.replace(/[\r\n]/g, " ");
}

export function errorJson(errorClass: string, action: string, detail: string, effect?: "none"): string {
  const obj: Record<string, unknown> = { ok: false, error_class: errorClass, action };
  if (detail) obj.detail = detail;
  if (effect) obj.effect = effect;
  return `${ensureAscii(JSON.stringify(obj))}\n`;
}
