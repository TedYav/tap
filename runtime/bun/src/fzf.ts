import { spawn } from "node:child_process";
import { TapError } from "./context";
import { managedFzf, FzfToolError } from "./fzf-tool";
import { callerOwnsForegroundTty } from "./launcher/prompt";

export interface PickerChoice<T> { id: string; label: string; value: T }
export interface PickOptions { verb: string; query?: string; multi?: boolean; prompt?: string; header?: string }
export type PickResult<T> = { kind: "selected"; values: T[] } | { kind: "cancelled" } | { kind: "interrupted" };
export interface FzfOutput { code: number | null; signal?: NodeJS.Signals | null; output: string }
export interface FzfEffects {
  terminal: () => boolean;
  binary: (env: NodeJS.ProcessEnv) => string;
  run: (binary: string, args: string[], input: string, env: NodeJS.ProcessEnv) => Promise<FzfOutput>;
}
export const displayText = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function pickerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of ["FZF_DEFAULT_OPTS", "FZF_DEFAULT_OPTS_FILE", "FZF_DEFAULT_COMMAND"]) delete clean[key];
  return clean;
}

/** Await the child before returning or propagating a signal: fzf owns termios. */
export const runFzf: FzfEffects["run"] = (binary, args, input, env) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { env, stdio: ["pipe", "pipe", "inherit"] });
  const chunks: Buffer[] = [];
  let bytes = 0, failure: Error | undefined, received: NodeJS.Signals | undefined;
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
    const handler = () => { received = signal; child.kill(signal); };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  child.on("error", error => { failure = error; });
  child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") failure = error; });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) { failure = new Error("fzf returned too much data"); child.kill("SIGTERM"); }
    else chunks.push(chunk);
  });
  child.on("close", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (failure) reject(failure);
    else resolve({ code, signal: received || signal, output: Buffer.concat(chunks).toString("utf8") });
  });
  child.stdin.end(input);
});
const realEffects: FzfEffects = { terminal: callerOwnsForegroundTty, binary: managedFzf, run: runFzf };

export async function pick<T>(choices: PickerChoice<T>[], options: PickOptions, effects = realEffects, env = process.env): Promise<PickResult<T>> {
  const fail = (kind: string, detail: string): never => { throw new TapError(1, kind, `tap help ${options.verb}`, detail, `tap ${options.verb}`); };
  if (env.TAP_JSON === "1" || env.TERM === "dumb" || !effects.terminal()) {
    throw new TapError(1, "no_terminal", `supply an explicit target or handle list; tap help ${options.verb}`, "picker needs a foreground terminal and human output", `tap ${options.verb}`);
  }
  if (!choices.length) fail("no_candidates", "no eligible targets to select");
  const values = new Map<string, T>();
  for (const row of choices) {
    if (!row.id || /[\x00-\x20\x7f-\x9f]/.test(row.id) || values.has(row.id)) fail("picker_invalid_candidates", "picker has an invalid or duplicate target identifier");
    values.set(row.id, row.value);
  }
  const args = ["--read0", "--print0", "--sync", "--delimiter=\t", "--with-nth=2..", "--accept-nth=1",
    "--expect=esc", "--layout=reverse", "--border", "--no-select-1", "--no-exit-0",
    options.multi ? "--multi" : "--no-multi", `--query=${options.query || ""}`,
    `--prompt=${displayText(options.prompt || "Select > ")}`, `--header=${displayText(options.header || "Type to search · Enter select · Esc cancel")}`];
  if (options.multi) args.push("--bind=space:toggle+down");
  if (env.NO_COLOR !== undefined) args.push("--color=bw");
  const input = choices.map(row => `${row.id}\t${displayText(row.label)}\0`).join("");
  let result: FzfOutput;
  try { result = await effects.run(effects.binary(env), args, input, pickerEnvironment(env)); }
  catch (error) { if (error instanceof TapError) throw error; if (error instanceof FzfToolError) throw new TapError(1, error.errorClass, error.action, error.detail); return fail("fzf_failed", `picker failed: ${error instanceof Error ? error.message : error}`); }
  if (result.signal === "SIGINT" || (!result.signal && result.code === 130)) return { kind: "interrupted" };
  if (result.signal) throw new TapError(result.signal === "SIGHUP" ? 129 : 143, "picker_interrupted", "retry from a terminal", `picker ended on ${result.signal}`);
  // --expect prints the Escape key even with no matching rows; fzf then exits
  // 1 rather than 0. This explicit key receipt is still cancellation.
  if (result.code === 1 && result.output === "esc\0") return { kind: "cancelled" };
  if (result.code !== 0) return fail("fzf_failed", `picker exited with ${result.code ?? "no status"}; no targets selected`);
  const parts = result.output.split("\0");
  if (parts.pop() !== "") return fail("fzf_invalid_output", "picker returned an incomplete selection");
  const key = parts.shift();
  if (key === "esc") return { kind: "cancelled" };
  if (key !== "" || !parts.length || (!options.multi && parts.length !== 1)) return fail("fzf_invalid_output", "picker returned an invalid selection");
  const selected: T[] = [], seen = new Set<string>();
  for (const id of parts) {
    if (!values.has(id) || seen.has(id)) return fail("fzf_invalid_output", "picker returned an unoffered or duplicate target");
    seen.add(id); selected.push(values.get(id)!);
  }
  return { kind: "selected", values: selected };
}
