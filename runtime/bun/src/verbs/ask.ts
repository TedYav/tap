/** One fresh headless invocation; no TAP context, registration or lifecycle. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { ASK_HELP } from "../help";
import { HARNESSES, configDirectory, isRegularFile } from "../launcher/catalog";
import { loadPresetCatalog, requirePreset, type ResolvedPreset } from "../launcher/catalog-listing";
import { Notices } from "../launcher/catalog-notices";
import { refuseJoinedArguments } from "../launcher/resolve-target";
import { modelArgv } from "../launcher/tuning";
import { LauncherError } from "../launcher/types";
import { facadeSecureRead } from "../slices/preset-api";
import { INHERITED_IDENTITY_ENV } from "../session-store";
import { pyFloatString } from "../spool-publication";

// promptFlag: the harness takes the prompt as that flag's VALUE (agy's Go-style
// --print, hermes's argparse --oneshot), so the prompt rides the joined
// `--flag=prompt` form, which a leading-dash prompt cannot deform. dashDash:
// the harness takes the prompt as a positional (yargs, commander), so `--`
// keeps a leading-dash prompt positional. The outer deadline below bounds every
// adapter; no harness-native timeout flag is forwarded.
type Adapter = { binary: string; args?: string[]; stdin?: boolean; suffix?: string[]; modelFirst?: boolean; promptFlag?: string; dashDash?: boolean };
const ADAPTERS: Record<string, Adapter> = {
  claude: { binary: "claude", args: ["--print", "--no-session-persistence"], stdin: true },
  codex: { binary: "codex", args: ["exec", "--ephemeral", "--color", "never"], stdin: true, suffix: ["-"] },
  opencode: { binary: "opencode", args: ["run"], dashDash: true },
  cursor: { binary: "cursor-agent", args: ["--print", "--mode", "ask"], dashDash: true },
  hermes: { binary: "hermes", modelFirst: true, promptFlag: "--oneshot" },
  agy: { binary: "agy", promptFlag: "--print" },
};
const harnessList = Object.keys(ADAPTERS).join(", ");
if (Object.keys(ADAPTERS).sort().join() !== [...HARNESSES].sort().join()) throw new Error("tap ask adapter table must cover the canonical harness set");
const isHarness = (value: string) => Object.hasOwn(ADAPTERS, value);
const fail = (message: string, code = 1): number => { process.stderr.write(`tap ask: ${message}\n`); return code; };
function refuse(env: NodeJS.ProcessEnv, errorClass: string, detail: string, action: string): number {
  if (env.TAP_JSON === "1") process.stdout.write(`${JSON.stringify({ ok: false, error_class: errorClass, action, detail })}\n`);
  else fail(`${detail}; next: ${action}`);
  return 1;
}

type Parsed = { harness: string; path?: string; body?: string; model?: string | null; extra: string[]; env: Record<string, string> };
function parse(argv: string[], env: NodeJS.ProcessEnv, notices: Notices): Parsed | number {
  if (argv.length === 1 && ["help", "-h", "--help"].includes(argv[0]!)) { process.stdout.write(ASK_HELP); return 0; }
  const usage = () => fail('usage: tap ask <preset|harness> -f <prompt.md> | -m "..."');
  if (!argv.length) return usage();
  let harness = "", path: string | undefined, body: string | undefined, model: string | undefined, preset: string | undefined;
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (["-f", "-m", "--model", "--preset"].includes(arg) || arg.startsWith("--preset=")) {
      const key = arg.startsWith("--preset=") ? "--preset" : arg;
      const previous = key === "-f" ? path : key === "-m" ? body : key === "--model" ? model : preset;
      if (previous !== undefined) return fail(`${key} may be passed only once`);
      const value = arg.startsWith("--preset=") ? arg.slice(9) : argv[++i];
      if (value === undefined) return fail(`${key} requires ${key === "-f" ? "a prompt file" : key === "-m" ? "a body" : "a value"}`);
      if (key === "-f") path = value;
      else if (key === "-m") body = value;
      else if (key === "--model") model = value;
      else preset = value;
    } else if (arg.startsWith("-")) return fail(`unknown option '${arg}'`);
    else {
      if (positional) return fail(`unexpected argument '${arg}'`);
      positional = true; harness = arg;
    }
  }
  try { refuseJoinedArguments('tap ask <preset|harness> -f <prompt.md> | -m "..."', harness, preset); }
  catch (error) {
    if (!(error instanceof LauncherError) || !error.errorClass) throw error;
    return refuse(env, error.errorClass, error.detail ?? error.message, error.action ?? "");
  }
  const explicit = preset !== undefined;
  if (explicit) {
    if (harness && !isHarness(harness)) return fail(`unexpected argument '${harness}' (with --preset, the positional may only be the expected harness: ${harnessList})`);
  } else if (harness && !isHarness(harness)) preset = harness;
  else if (!harness) return usage();
  let resolved: ResolvedPreset | undefined;
  if (preset !== undefined) {
    try {
      const catalog = loadPresetCatalog(env, notices.sink, facadeSecureRead, configDirectory(env), isRegularFile);
      resolved = catalog.presets.get(preset);
      if (!resolved) {
        if (explicit) requirePreset(catalog, preset);
        return refuse(env, "harness_or_preset_not_found", `'${preset}' is neither a known harness nor a known preset; canonical harnesses: ${harnessList}`, "run tap presets to see the presets this machine offers");
      }
    } catch (error) {
      // Infrastructure/program failures are not evidence of absent configuration.
      if (!(error instanceof LauncherError) || !error.errorClass) throw error;
      if (!explicit && error.errorClass === "preset_config_missing") return refuse(env, "harness_or_preset_not_found", `'${preset}' is not a known harness, and no preset config was loaded (${error.detail}); canonical harnesses: ${harnessList}`, "pass a harness name, or create a preset catalog (tap presets)");
      return refuse(env, error.errorClass, error.detail ?? error.message, error.action ?? "");
    }
    if (model !== undefined) return refuse(env, "preset_not_composable", `preset '${preset}' is complete; --model cannot override it`, "drop the preset and pass tuning by flag, or drop --model");
    if (explicit && isHarness(harness) && harness !== resolved.harness) return refuse(env, "preset_harness_mismatch", `preset '${preset}' uses harness '${resolved.harness}', not requested harness '${harness}'`, `pass '${resolved.harness}' as the harness, or choose a preset whose harness is '${harness}'`);
    const adapter = ADAPTERS[resolved.harness]!;
    const owned = new Set([...(adapter.args ?? []).filter(a => a.startsWith("-")), "--model", ...(adapter.promptFlag ? [adapter.promptFlag] : [])]);
    const clash = resolved.param_keys.map(key => `--${key}`).filter(key => owned.has(key)).sort();
    if (clash.length) return refuse(env, "preset_adapter_conflict", `preset '${preset}' sets ${clash.join(" and ")}, which tap ask already fixes for harness '${resolved.harness}'`, `drop ${clash[0]} from the preset, or use tap crew add / tap session launch, which do not fix it`);
    harness = resolved.harness;
  }
  if (!isHarness(harness)) return fail(`unknown harness '${harness}' (choose: ${harnessList})`);
  if (path !== undefined && body !== undefined) return fail("-f and -m are alternatives; pass exactly one");
  if (path === undefined && body === undefined) return fail('-f <prompt.md> or -m "..." is required');
  return { harness, path, body, model: resolved ? resolved.model : model, extra: resolved?.harness_passthrough ?? [], env: resolved?.env ?? {} };
}

function readPrompt(path: string): string | number {
  let fd: number;
  try { fd = openSync(path || ".", constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return fail(`prompt file not found: ${path}`);
    if (e.code === "EISDIR") return fail(`prompt path is not a regular file: ${path}`);
    return fail(`could not read prompt file '${path}': ${e.message}`);
  }
  let bytes: Buffer;
  try {
    if (!fstatSync(fd).isFile()) return fail(`prompt path is not a regular file: ${path}`);
    bytes = readFileSync(fd);
  } catch (error) { return fail(`could not read prompt file '${path}': ${(error as Error).message}`); }
  finally { closeSync(fd); }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail(`prompt file is not valid UTF-8: ${path}`); }
}

/** Python :g: six significant decimal digits, exact binary rounding (ties even). */
export function askDuration(value: number): string {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0), exponent = Number((raw >> 52n) & 2047n);
  let n = raw & ((1n << 52n) - 1n), d = 1n;
  if (exponent) n |= 1n << 52n;
  const power = (exponent || 1) - 1023 - 52;
  if (power >= 0) n <<= BigInt(power); else d <<= BigInt(-power);
  let e = Math.floor(Math.log10(value));
  const scale = 5 - e;
  if (scale >= 0) n *= 10n ** BigInt(scale); else d *= 10n ** BigInt(-scale);
  let q = n / d;
  if (2n * (n % d) > d || (2n * (n % d) === d && q % 2n !== 0n)) q++;
  if (q >= 1000000n) { q /= 10n; e++; }
  const digits = q.toString().padStart(6, "0");
  if (e < -4 || e >= 6) {
    const fraction = digits.slice(1).replace(/0+$/, "");
    return `${digits[0]}${fraction ? `.${fraction}` : ""}e${e < 0 ? "-" : "+"}${Math.abs(e).toString().padStart(2, "0")}`;
  }
  const fixed = e >= 0 ? `${digits.slice(0, e + 1)}.${digits.slice(e + 1)}` : `0.${"0".repeat(-e - 1)}${digits}`;
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM still proves presence, including a group disappearing during reap.
    // Keep the bounded grace; an actual TERM/KILL denial remains an error.
    if (code === "EPERM") return true;
    throw error;
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function terminate(child: Bun.Subprocess): Promise<void> {
  signalGroup(child.pid, "SIGTERM");
  const deadline = performance.now() + 1000;
  // A reaped parent does not mean its process group is gone.
  while (groupAlive(child.pid) && performance.now() < deadline) await Bun.sleep(20);
  if (groupAlive(child.pid)) signalGroup(child.pid, "SIGKILL");
  await child.exited;
}

async function invoke(parsed: Parsed, prompt: string, env: NodeJS.ProcessEnv, notices: Notices): Promise<number> {
  const adapter = ADAPTERS[parsed.harness]!;
  const executable = Bun.which(adapter.binary, { PATH: env.PATH });
  if (!executable) return fail(`${parsed.harness} CLI is unavailable (missing executable '${adapter.binary}')`, 127);
  const raw = env.TAP_ASK_TIMEOUT_SECONDS;
  const timeout = raw === undefined ? 900 : pyFloatString(raw);
  if (timeout === null || !Number.isFinite(timeout) || timeout <= 0) return fail(`TAP_ASK_TIMEOUT_SECONDS must be positive, got '${raw}'`);
  const duration = askDuration(timeout), model = modelArgv(parsed.harness, parsed.model);
  const tail = adapter.promptFlag ? [`${adapter.promptFlag}=${prompt}`] : adapter.dashDash ? ["--", prompt] : [prompt];
  const args = [executable, ...(adapter.modelFirst ? model : []), ...(adapter.args ?? []),
    ...(adapter.modelFirst ? [] : model), ...parsed.extra, ...(adapter.stdin ? adapter.suffix ?? [] : tail)];
  if (args.some(arg => arg.includes("\0"))) return fail("embedded null byte");
  const childEnv = { ...env };
  // A headless one-shot owns no seat: the invoker's harness identity and tmux pane pins must not
  // reach it (a preset may still set one explicitly below).
  for (const key of [...INHERITED_IDENTITY_ENV, "TMUX", "TMUX_PANE"]) delete childEnv[key];
  for (const [key, value] of Object.entries(parsed.env)) {
    // Compared against the AMBIENT value: the scrub above removed identity keys from childEnv.
    if (env[key] !== undefined && env[key] !== value) notices.emit(`tap ask: overriding ambient ENV var ${key} with the declared value`);
    childEnv[key] = value;
  }
  // A one-shot child inherits workspace hooks, but owns no TAP seat.
  // Set after preset env so a preset cannot accidentally re-enable binding.
  childEnv.TAP_STATELESS = "1";
  let cancel: (signal: number) => void;
  const cancellation = new Promise<number>(resolve => { cancel = resolve; });
  const onInt = () => cancel(2), onTerm = () => cancel(15);
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let child: Bun.Subprocess | undefined;
  try {
    try { child = Bun.spawn(args, { env: childEnv, detached: true, stdin: adapter.stdin ? Buffer.from(prompt, "utf8") : "ignore", stdout: "pipe", stderr: "inherit" }); }
    catch (error) { return fail(`could not start ${parsed.harness} executable '${adapter.binary}': ${(error as Error).message}`, 127); }
    // The answer is relayed, not inherited: only a tap that measures stdout can
    // refuse the silent-success shape (exit 0, empty stdout, stderr complaint).
    const stream = child.stdout;
    if (!(stream instanceof ReadableStream)) return fail(`could not capture ${parsed.harness} stdout`);
    const reader = stream.getReader();
    let relayed = 0;
    const relay = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          relayed += value.byteLength;
          process.stdout.write(value);
        }
      } catch { /* a failing tap stdout ends the relay; already-counted bytes stand */ }
    })();
    // A grandchild holding the pipe open must not out-wait the answer: once the
    // child is gone, drain briefly, then take the reader back.
    const settle = async () => {
      await Promise.race([relay, Bun.sleep(1000)]);
      try { await reader.cancel(); } catch {}
    };
    const deadline = performance.now() + timeout * 1000;
    const expired = new Promise<"timeout">((resolve) => {
      const tick = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) resolve("timeout");
        else timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
      };
      tick();
    });
    const result = await Promise.race([
      cancellation.then(signal => ({ signal })), expired,
      child.exited.then(status => ({ status })),
    ]);
    if (result === "timeout" || "signal" in result) {
      await terminate(child);
      await settle();
      return result === "timeout" ? fail(`${parsed.harness} timed out after ${duration}s`, 124) : 128 + result.signal;
    }
    await settle();
    // CPython exposes an independently signalled child as SystemExit(-signal).
    if (child.signalCode) return (256 - osConstants.signals[child.signalCode]) & 255;
    if (result.status === 0 && relayed === 0) return fail(`${parsed.harness} produced no output (exit 0)`);
    return result.status;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  }
}

export async function cmdAsk(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const notices = new Notices();
  notices.suppress(env.TAP_JSON === "1");
  try {
    const parsed = parse(argv, env, notices);
    if (typeof parsed === "number") return parsed;
    const prompt = parsed.body ?? readPrompt(parsed.path!);
    if (typeof prompt === "number") return prompt;
    return await invoke(parsed, prompt, env, notices);
  } catch (error) { return fail((error as Error).message); }
}

if (import.meta.main) process.exitCode = await cmdAsk(process.argv.slice(2));
