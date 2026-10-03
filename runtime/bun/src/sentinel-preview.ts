import { PYTHON_SPACE } from "./terminal-text";
/** Optional, lossy display hints. Payload read/reply remains the authority. */
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { envelopeField, parseEnvelope } from "./envelope";

function previewConfig(): { enabled: boolean; bytes: number } {
  const base = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : "");
  const defaults = { enabled: false, bytes: 120 };
  if (!isAbsolute(base)) return defaults;
  try {
    const doc = Bun.TOML.parse(readFileSync(join(base, "tap/config.toml"), "utf8")) as any;
    const bytes = doc.sentinel?.preview_chars;
    return { enabled: doc.sentinel?.preview === true,
      bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 120 };
  } catch { return defaults; }
}

export function previewsEnabled(): boolean { return previewConfig().enabled; }

export function sanitizePreview(text: string, warn = true, bytes = 240): string {
  if (!text) return "";
  if (/\]\]|[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text)) {
    if (warn) console.error("tap: unsafe --preview dropped; message delivery continues");
    return "";
  }
  text = text.trim();
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  let prefix = "";
  for (const char of text) {
    if (Buffer.byteLength(prefix + char, "utf8") > bytes) break;
    prefix += char;
  }
  // A word ending exactly at the limit is complete only if whitespace follows.
  if (!/^\s/u.test(text.slice(prefix.length))) prefix = prefix.replace(/\s*\S+$/u, "");
  return prefix.trimEnd();
}

export function encodePreview(text: string): string {
  return Buffer.from(sanitizePreview(text, previewsEnabled()), "utf8").toString("base64");
}

/**
 * `sentinel_preview:` value for "the sender gave --preview and it was rejected":
 * not base64 (`-` is outside the alphabet), so every reader's round-trip check
 * already decodes it to no preview, and an explicit field stops render-time
 * derivation from the body. The stamper drops empty values, hence a token.
 */
export const PREVIEW_SUPPRESSED = "-";

/** The stamp for a send: absent when no --preview was given (derivation applies),
 * the encoded hint when it survived sanitization, else the suppression token. */
export function stampPreview(given: boolean, text: string): string | undefined {
  return given ? encodePreview(text) || PREVIEW_SUPPRESSED : undefined;
}

export function storedPreview(path: string): string {
  try { return envelopeField(readFileSync(path, "utf8"), "sentinel_preview") || ""; }
  catch { return ""; }
}

export function payloadPreview(path: string): string {
  const config = previewConfig();
  if (!config.enabled) return "";
  try {
    const raw = readFileSync(path, "utf8");
    const explicit = envelopeField(raw, "sentinel_preview");
    if (explicit !== undefined) return decodePreview(explicit);
    const line = parseEnvelope(raw).body.split("\n").find(line => line.trim());
    return line === undefined ? "" : sanitizePreview(line, false, config.bytes);
  } catch { return ""; }
}

/** A digest may be rendered before its canonical payloads leave the spool. */
export function digestItemPreview(item: { path: string; sentinel_preview?: unknown }): string {
  if (typeof item.sentinel_preview === "string") return decodePreview(item.sentinel_preview);
  try { readFileSync(item.path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && basename(dirname(item.path)) === "payloads")
      return payloadPreview(join(dirname(item.path), "../spool", basename(item.path)));
    return "";
  }
  return payloadPreview(item.path);
}

export function decodePreview(encoded: string): string {
  return previewsEnabled() ? rawPreview(encoded) : "";
}

/** The stored hint's text regardless of the preview toggle, for carrying it to a
 * successor send; "" for the suppression token or a value no reader would render. */
export function rawPreview(encoded: string): string {
  if (encoded === PREVIEW_SUPPRESSED) return "";
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) return "";
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return sanitizePreview(decoded);
  } catch { return ""; }
}

/** A token-initial `@` or `/`: OpenCode's composer opens its mention or command
 * picker for one, and the picker swallows the submit Enter (tap-7r3fn.208). */
const PICKER_TRIGGER = /(^|\s)[@/]/u;

export function hasPickerTrigger(text: string): boolean { return PICKER_TRIGGER.test(text); }

/**
 * The hint as it may ride the wire: every token loses its leading `@` and `/`
 * ("@codex review" -> "codex review", "on tap#2312 @" -> "on tap#2312"). The wire
 * is recipient-agnostic, so this applies to every recipient and to explicit,
 * derived and digest-item hints alike; a mid-token `@` or `/` ("user@host", "a/b")
 * opens nothing and stays. Text with no trigger is returned unchanged. Hints are
 * lossy by contract; the body is never touched.
 */
export function pickerSafePreview(text: string): string {
  if (!hasPickerTrigger(text)) return text;
  return text.replace(/(^|\s)[@/]+/gu, "$1").replace(/\s{2,}/gu, " ").trim();
}

/** JSON quoting separates the hint from bare tags, pointer and lossless body. */
export function previewFields(path: string, kind: string): string {
  if (!previewsEnabled()) return "";
  if (kind !== "digest") {
    const text = pickerSafePreview(payloadPreview(path));
    return text ? ` preview=${JSON.stringify(text)}` : "";
  }
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(doc.items)) return "";
    return doc.items.map((item: { id?: unknown; path?: unknown; sentinel_preview?: unknown }) => {
      if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.id) || typeof item.path !== "string") return "";
      const text = pickerSafePreview(digestItemPreview({path: item.path, sentinel_preview: item.sentinel_preview}));
      return text ? ` preview(${item.id})=${JSON.stringify(text)}` : "";
    }).join("");
  } catch { return ""; }
}

/** Remove quoted display text before the legacy header/body split. Captures can
 * wrap inside a marker or string; only complete marked fields are recognized. */
export function maskPreviewText(inner: string): string {
  // The gaps are PYTHON's whitespace class, not JavaScript's: this mask is the
  // band parser's first step (`stuck-sentinel.ts`), it was an inline Python
  // program until this PR, and the two sets disagree about U+0085, U+001C-1F
  // and U+FEFF — which is enough to move a header/body split.
  return inner.replace(new RegExp(
    `([${PYTHON_SPACE}])p[${PYTHON_SPACE}]*r[${PYTHON_SPACE}]*e[${PYTHON_SPACE}]*v[${PYTHON_SPACE}]*i[${PYTHON_SPACE}]*e[${PYTHON_SPACE}]*w`
    + `(?:[${PYTHON_SPACE}]*\\([A-Za-z0-9][A-Za-z0-9._${PYTHON_SPACE}-]*\\))?[${PYTHON_SPACE}]*=[${PYTHON_SPACE}]*"(?:\\\\[\\s\\S]|[^"\\\\])*"`, "g"),
    '$1preview=""');
}

if (import.meta.main) {
  const [mode, value = "", kind = ""] = Bun.argv.slice(2);
  process.stdout.write(mode === "encode" ? encodePreview(value)
    : mode === "enabled" ? (previewsEnabled() ? "true" : "false")
    : previewFields(value, kind));
}
