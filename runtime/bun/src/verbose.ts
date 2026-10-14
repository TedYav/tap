const VERBOSE_SECRET = /token|secret|password|passwd|credential|api[_-]?key|authorization/i;

/** Callers retain their own secret-name contract and argument-list handling. */
export function redact(text: string, env = process.env, secret = VERBOSE_SECRET): string {
  const value = String.raw`(?:'[^']*'|"(?:\\.|[^"])*"|[^\s;]+)`;
  for (const [key, value] of Object.entries(env)) {
    if (value && secret.test(key)) text = text.split(value).join("<redacted>");
  }
  text = text.replace(/(\bauthorization\s*:\s*)[^\r\n]+/gi, "$1<redacted>");
  text = text.replace(new RegExp(`(["']?(\\b[A-Za-z_][A-Za-z0-9_-]*)["']?\\s*(?:=|:)\\s*)(${value})`, "g"),
    (all, key, name) => secret.test(name) ? `${key}<redacted>` : all);
  return text.replace(new RegExp(`(--[A-Za-z_-]+)(\\s+)(${value})`, "g"),
    (all, key, space) => secret.test(key) ? `${key}${space}<redacted>` : all);
}

/** Opt-in diagnostics; stdout and verb-local --verbose are unchanged. */
export function verbose(event: string, fields: Record<string, unknown>, env = process.env): void {
  if (env.TAP_VERBOSE !== "1") return;
  const secret = VERBOSE_SECRET;
  function clean(value: unknown): unknown {
    if (typeof value === "string") return redact(value, env);
    if (Array.isArray(value)) {
      return value.map((v, i) => i > 0 && typeof value[i - 1] === "string" &&
        /^--[^=]+$/.test(value[i - 1]) && secret.test(value[i - 1]) ? "<redacted>" : clean(v));
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, clean(v)]));
    return value;
  }
  try { process.stderr.write(`tap verbose: ${JSON.stringify(clean({ event, ...fields }))}\n`); } catch { /* diagnostics are best effort */ }
}
