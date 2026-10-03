// Session naming. Port of completion.sanitize_component plus
// launcher.session_name_for_handle / allocate_name / named_session_name.
//
// Reservation (RESERVED_HANDLES / TAP_RESERVED_HANDLES) is a caller concern —
// not copied here, so this module does not create a third lockstep.

import { parseUnicodeDecimal } from "../unicode-decimal";
export { parseUnicodeDecimal } from "../unicode-decimal";

/**
 * Python `$` in default `re.match`: end of string, or just before a single
 * trailing newline (not `\r\n`, not two newlines).
 */
function pythonDollarBody(name: string): string {
  if (name.endsWith("\n\n")) return name;
  if (name.endsWith("\n")) return name.slice(0, -1);
  return name;
}

export function sanitizeComponent(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "agent";
}

export function sessionNameForHandle(base: string, handle: string): string {
  return `${sanitizeComponent(base)}/${handle}`;
}

export function namedSessionName(base: string, handle: string): string {
  return sessionNameForHandle(base, sanitizeComponent(handle));
}

export function allocateName(
  base: string,
  harness: string,
  tag: string | null,
  existingNames: Iterable<string>,
  literalHandle = false,
): string {
  const raw = tag || harness;
  const handle = literalHandle && tag ? raw : sanitizeComponent(raw);
  const prefix = `${sanitizeComponent(base)}/${handle}`;
  const used = new Set<number>();
  const hyphenPrefix = `${prefix}-`;
  for (const name of existingNames) {
    if (name === prefix) {
      used.add(1);
      continue;
    }
    const body = pythonDollarBody(name);
    if (!body.startsWith(hyphenPrefix)) continue;
    const parsed = parseUnicodeDecimal(body.slice(hyphenPrefix.length));
    if (parsed === null) continue;
    used.add(parsed === 0 ? 1 : parsed);
  }
  let index = 1;
  while (used.has(index)) index += 1;
  return index === 1 ? prefix : `${prefix}-${index}`;
}

export class ResumeNamingValueError extends Error {}

type ResumeNameInput = {
  name: string; harness: string; base: string; default_tag?: string | null;
  int_max_str_digits: number;
};

function validateResumeName(input: ResumeNameInput): void {
  if (!input || [input.name, input.harness, input.base].some(value => typeof value !== "string") ||
      (input.default_tag != null && typeof input.default_tag !== "string") ||
      !Number.isSafeInteger(input.int_max_str_digits) ||
      (input.int_max_str_digits !== 0 && input.int_max_str_digits < 640)) {
    throw new Error("invalid resume naming request");
  }
}

function resumeParts(name: string, limit: number): [string | null, string] | null {
  // Python fullmatch: dot excludes only LF; $ in JS also accepts a final newline.
  const match = /^(?:(\p{Nd}+)|([^\n]+)-(\p{Nd}+))(?![\s\S])/u.exec(name);
  if (!match) return null;
  const digits = Array.from(match[1] ?? match[3]!);
  const values = digits.map(ch => parseUnicodeDecimal(ch));
  if (values.some(value => value === null)) return null;
  if (limit && digits.length > limit) throw new ResumeNamingValueError(
    `Exceeds the limit (${limit} digits) for integer string conversion: value has ${digits.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
  // Decimal text preserves Python's arbitrary integer precision, including raw zero.
  return [match[2] ?? null, values.join("").replace(/^0+(?=\d)/, "")];
}

function expandedName(input: ResumeNameInput, [tag, raw]: [string | null, string]): string {
  const handle = sanitizeComponent(tag || input.default_tag || input.harness);
  return namedSessionName(input.base, raw === "0" || raw === "1" ? handle : `${handle}-${raw}`);
}

export function expandResumeShorthand(input: ResumeNameInput): string | null {
  validateResumeName(input);
  if (input.name.startsWith(`${sanitizeComponent(input.base)}-${sanitizeComponent(input.harness)}-`)) return null;
  const parts = resumeParts(input.name, input.int_max_str_digits);
  return parts ? expandedName(input, parts) : null;
}

export function resumeCandidateNames(input: ResumeNameInput): string[] {
  validateResumeName(input);
  const base = sanitizeComponent(input.base), harness = sanitizeComponent(input.harness);
  // Both selectors exclude this prefix. The plain-tag selector below also
  // excludes the prefix WITHOUT its final dash; shorthand expansion does not.
  if (input.name.startsWith(`${base}-${harness}-`)) return [];
  const parts = resumeParts(input.name, input.int_max_str_digits);
  if (!parts) return input.name.startsWith(`${base}-${harness}`) ? [] : [`${base}-${harness}-${sanitizeComponent(input.name)}`];
  const [tag, raw] = parts;
  const legacy = [base, harness, ...(tag ? [sanitizeComponent(tag)] : [])];
  return [...new Set([
    expandedName({ ...input, default_tag: null }, parts),
    [...legacy, ...(raw === "0" || raw === "1" ? [] : [raw])].join("-"),
    [...legacy, raw].join("-"),
  ])];
}
