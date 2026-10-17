import { keybindingInstalled, uninstallKeybinding } from "./keybinding";
import { defaultsInstalled, uninstallDefaults } from "./tmux-defaults";
import { closeSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { TapError } from "../context";
import { tapErrorJson, tapErrorLine } from "../error-line";
import { humanLine } from "../native-error";
import { collectDifferences } from "./config";
import { PERMISSION_HARNESSES } from "../launcher/permissions";
import { DEFAULT_EFFORT, PLUGINS, STARTER_EFFORTS, parseSetupChoices, prepareSetup, selectSetupPresets, type SetupChoices, type SetupSnapshot } from "./machine-choices";
export { applyEffort } from "./machine-choices";
import { acquireNoFollowLock } from "../digest-window";
import { isRetiredVersion } from "../launcher/catalog-listing";
import { installMachineSkills, removeOwnedLink } from "../install-skill-links";
import { readIndexJson } from "../index-home";
import { CORE_SKILLS, savedFullKit, skillManifestPath } from "../skill-policy";
import { removeSkillPlugin, RETAINED_LISTING } from "../install-skill-plugin";
import { CODEX_BEGIN, SHELL_BLOCK_BEGIN, SHELL_BLOCK_BEGINS, SHELL_BLOCK_END, SHELL_BLOCK_MARKERS, readManifestRecord, scanManifestEntries } from "../install-manifest";
import { relocateCodexEndMarker } from "../codex-fence";
import { archiveHistory, removeRoots } from "../install-history";
import { tapRoot } from "../scripts-dir";

const REPO = tapRoot();
type Entry = { kind: string; path: string; [key: string]: any };
type Manifest = { version: number; repo: string; targets?: Record<string,string>; entries: Entry[]; historyPending?: boolean };
export type Prompt = (question: string) => Promise<string>;
const home = () => process.env.HOME!;
const index = () => process.env.TAP_INDEX_HOME || join(home(), ".tap");
const configDir = () => {
  const root = process.env.XDG_CONFIG_HOME || join(home(), ".config");
  if (!isAbsolute(root)) throw new Error("XDG_CONFIG_HOME must be absolute; use an absolute path or unset it");
  return join(root, "tap");
};
const manifestPath = skillManifestPath;
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function readManifest(): Manifest {
  const path = manifestPath();
  if (!existsSync(path)) return {version: 1, repo: REPO, entries: []};
  if (lstatSync(path).isSymbolicLink()) throw new Error(`preserve and inspect symlink manifest ${path}`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.version !== 1 || !Array.isArray(value.entries) || typeof value.repo !== "string") throw new Error(`invalid manifest ${path}; preserve it and inspect before rerunning install`);
  return value;
}
function atomic(path: string, content: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`preserving symlink ${path}`);
  mkdirSync(dirname(path), {recursive:true});
  const temp = `${path}.tap-${process.pid}`;
  writeFileSync(temp,content,{mode:0o600});
  renameSync(temp,path);
}
function saveManifest(manifest: Manifest) { atomic(manifestPath(), JSON.stringify(manifest,null,2)+"\n"); }
function record(entry: Entry) {
  const manifest = readManifest();
  manifest.entries = manifest.entries.filter(e => !(e.kind === entry.kind && e.path === entry.path));
  manifest.entries.push(entry);
  saveManifest(manifest);
}
async function confirm(ask: Prompt, question: string, fallback: "y" | "n"): Promise<boolean> {
  const answer = (await ask(`${question} [${fallback === "y" ? "Y/n" : "y/N"}] `)).trim();
  return answer === "" ? fallback === "y" : /^(y|yes)$/i.test(answer);
}
async function interact(operation: (ask: Prompt) => Promise<number>, output: NodeJS.WriteStream = process.stdout): Promise<number> {
  if (!process.stdin.isTTY || !output.isTTY) {
    console.error("tap: an interactive terminal is required; next: run this command in a terminal (tap setup --machine or tap uninstall)");
    return 2;
  }
  const rl = createInterface({input:process.stdin,output});
  const abort = new AbortController();
  const abortError = (): Error => { const error = new Error("the operation was aborted"); error.name = "AbortError"; return error; };
  const interrupt = () => { if (!abort.signal.aborted) abort.abort(); };
  // A prompt whose terminal is gone (pty closed: EOF, or EIO once the master
  // vanished) must end the wizard, not wait or spin on an unreadable stdin.
  // Once aborted, a question with that signal can resolve as an empty answer
  // instead of rejecting, which would apply unchosen defaults — so ask() gates
  // on the signal first and rejects like the Ctrl-C path does.
  const gone = () => interrupt();
  rl.once("close", gone);
  process.stdin.once("error", gone);
  rl.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  try { return await operation(question => abort.signal.aborted ? Promise.reject(abortError()) : rl.question(question, {signal: abort.signal})); }
  finally { process.off("SIGINT", interrupt); process.stdin.off("error", gone); rl.close(); }
}
export function serializeToml(document: Record<string,any>, bareKeys = false): string {
  const lines: string[] = [];
  const scalar = (v: any): string => typeof v === "object" && !Array.isArray(v) ? "{ " + Object.entries(v).map(([k,x])=>`${JSON.stringify(k)} = ${scalar(x)}`).join(", ")+" }" : Array.isArray(v) ? `[${v.map(scalar).join(", ")}]` : JSON.stringify(v);
  const key = (name: string) => bareKeys && /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  const emit = (obj: Record<string,any>, path: string[]) => {
    if (path.length) lines.push("",`[${path.map(key).join(".")}]`);
    for (const [k,v] of Object.entries(obj)) if (typeof v !== "object" || v === null || Array.isArray(v)) lines.push(`${key(k)} = ${scalar(v)}`);
    for (const [k,v] of Object.entries(obj)) if (typeof v === "object" && v !== null && !Array.isArray(v)) emit(v,[...path,k]);
  };
  emit(document,[]);
  return lines.join("\n")+"\n";
}
const binaries: Record<string,string> = {claude:"claude",codex:"codex",cursor:"cursor-agent",opencode:"opencode",agy:"agy",hermes:"hermes"};
const searchPath = () => [process.env.PATH || "",join(home(),".local/bin"),"/opt/homebrew/bin","/usr/local/bin"].join(":");
const catalog = () => Bun.TOML.parse(readFileSync(join(REPO,"skills/tap/config/config.v3.toml"),"utf8")) as {presets:Record<string,any>};
type SetupPlan = ReturnType<typeof prepareSetup>;
type Log = (message: string) => void;

function regularText(path: string, field: string): string | undefined {
  const stat = lstatSync(path,{throwIfNoEntry:false});
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`${field}: ${path} is not a regular file; preserving it`);
  return decodeSetupText(readFileSync(path),field);
}
function decodeSetupText(bytes: Uint8Array, field: string): string {
  let text: string;
  try { text = new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
  catch { throw new Error(`${field}: invalid UTF-8`); }
  if (!Buffer.from(text).equals(bytes)) throw new Error(`${field}: invalid UTF-8`);
  return text;
}

function setupSnapshot(): SetupSnapshot {
  try {
    const config = join(configDir(),"config.toml");
    const original = regularText(config,"config");
    const source = original ?? "version = 3\n";
    let previous: Record<string,any>;
    try { previous = Bun.TOML.parse(source); }
    catch { throw new Error(`config: cannot parse ${config}; repair it before setup`); }
    if (isRetiredVersion(previous.version)) throw new Error(`config: retired catalog; migrate ${config} to version 2 or 3 before setup`);
    return {config,existed:original !== undefined,source,previous};
  } catch (error) {
    // Retain the established terminal attention result; answers normalizes refusals to 1.
    throw new TapError(2,"setup_refused","tap help setup",error instanceof Error ? error.message : String(error));
  }
}

const CLAUDE_AUTO_NOTE = "Claude auto may pause on the first TAP message: run `tap init` in your project, then check the attached Claude session and approve any permission prompt.";

function permissionNotes(plan: SetupPlan, notes: string[], log: Log) {
  if (plan.permissions.claude === "auto") {
    const note = CLAUDE_AUTO_NOTE;
    notes.push(note); log(note);
  }
}

/** What auto and bypass mean on each harness whose permissions TAP owns. */
const PERMISSION_EXPLANATIONS: Record<string, string> = {
  claude: "Claude auto uses its automatic permission mode; it may still require attention in the attached session. Bypass skips permission checks.",
  codex: "Codex auto keeps Codex's file sandbox and its automatic approval review (--approve-for-me), not a human approval dialog. TAP also turns on Codex's network proxy with no allowed domains and lets the sandbox write TAP's index folder and the receipt folders of enrolled team buses, so seats can reach the tmux socket and TAP state while other network destinations stay blocked for commands the sandbox runs (Codex's own model traffic is not affected). Bypass disables approvals and sandboxing.",
  cursor: "Cursor auto uses its automatic review (--auto-review): safe tool calls run, the rest wait for you in the attached session. Bypass (--force --sandbox disabled) runs every command without asking.",
  agy: "Antigravity has no automatic approval mode: auto stops for every permission request until you answer it in the attached session. Bypass (--dangerously-skip-permissions) approves every request.",
};

/** Closing text for the interrupt (clobber) choice: the one-sentence WAIT tip. */
function waitTip(choices: SetupChoices, previous: Record<string, any>, interactive: boolean, log: Log) {
  if (!interactive) return;
  const saved = previous.injection?.behavior;
  const chosen = choices.write === "candidate" ? undefined : choices.injection?.behavior;
  const behavior = chosen
    ?? (["clobber", "wait", "warn"].includes(saved) ? (saved === "warn" ? "wait" : saved) : "clobber");
  if (behavior !== "wait") log("Tip: if you need more time, type WAIT (in caps) at your prompt to hold deliveries for two minutes.");
}

/** Terminal answers become the same explicit decision object accepted from a file. */
async function collectSetupChoices(ask: Prompt, snapshot: SetupSnapshot, found: string[], log: Log, notes: string[]): Promise<SetupChoices | undefined> {
  const reference = catalog();
  const choices: SetupChoices = {harnesses:{},write:"apply"};
  const savedInit = snapshot.previous.onboarding?.init;
  const savedInitValid = ["ask", "auto"].includes(savedInit);
  let init = (await ask(`The first time TAP is used in a new project: ask before setting up a team, or set it up automatically? [${savedInitValid ? `keep ${savedInit}` : "ask"}] (ask = you approve each new project once; auto = TAP sets up without asking) (ask/auto): `)).trim().toLowerCase();
  while (init && !["ask", "auto"].includes(init)) init = (await ask("Choose ask or auto, or leave empty to keep the displayed default: ")).trim().toLowerCase();
  if (init) choices.onboarding = {init: init as "ask" | "auto"};
  const savedBehavior = snapshot.previous.injection?.behavior;
  const savedBehaviorValid = ["clobber", "wait", "warn"].includes(savedBehavior);
  const defaultBehavior = savedBehaviorValid ? (savedBehavior === "warn" ? "wait" : savedBehavior) : "interrupt";
  let behavior = (await ask(`How should agents' messages reach you while you're typing in an agent's prompt?
  interrupt  Faster when your permission mode allows delivery into typed text.
             It may clear your draft. TAP saves only text it can
             capture; paste-back is conditional. \`tap draft\` recovers it.
             Pasted content or images may be missing. Type WAIT (in caps) to
             hold deliveries for two minutes if you need more time.
  wait       Messages wait until the agent's input is empty. Nothing interrupts
             your typing, but if you leave text there, messages to that agent
             wait too.
  Choice [${savedBehaviorValid ? `keep ${defaultBehavior}` : "interrupt"}] (interrupt/wait): `)).trim().toLowerCase();
  while (behavior && !["interrupt", "clobber", "wait"].includes(behavior)) behavior = (await ask("Choose interrupt or wait, or leave empty to keep the displayed default: ")).trim().toLowerCase();
  if (behavior) choices.injection = {behavior: behavior === "wait" ? "wait" : "clobber"};
  for (const h of found) {
    const entries = Object.entries(reference.presets).filter(([,p])=>p.harness === h);
    const mode = (await ask(`${h}: keep it simple, choose myself, or skip? [skip] `)).trim().toLowerCase();
    const entry: NonNullable<SetupChoices["harnesses"]>[string] = {};
    choices.harnesses![h] = entry;
    if (!mode || mode === "skip") entry.presets = "skip";
    else if (["choose","myself","choose myself"].includes(mode)) {
      entries.forEach(([name,p],i)=>log(`${i+1}. ${name}: ${p.description}`));
      let selection = (await ask("Select preset numbers separated by commas (empty skips): ")).trim();
      while (selection && selection.split(/[ ,]+/).some(v=>!/^\d+$/.test(v)||Number(v)<1||Number(v)>entries.length)) selection=(await ask("Use only numbers from the list, separated by commas: ")).trim();
      entry.presets = selection ? selection.split(/[ ,]+/).map(n=>entries[Number(n)-1]![0]) : [];
    } else if (mode === "simple" || mode === "keep it simple") {
      if (entries.some(([,p])=>p.metadata?.starter === true)) entry.presets = "simple";
      else {
        log(`${h} has no starter presets, because its models depend on the providers you configured; nothing added. next: rerun and choose from the list, or save your own model with /tap:config-wizard.`);
        entry.presets = "skip";
      }
    }
    else throw new TapError(2,"setup_refused","tap help setup",`harnesses.${h}.presets: unrecognized choice '${mode}'`);
  }
  // Classify as if an effort were supplied, so a starter picked from the list is asked about effort too.
  const {chosen,tuned,selected} = selectSetupPresets({...choices,starterEffort:DEFAULT_EFFORT},snapshot.previous,reference);
  if (tuned.length) {
    let effort = (await ask("Default effort for selected Claude/Codex starter models [default] (default = pin nothing; the harness chooses, as on a bare launch) (default/low/medium/high/xhigh): ")).trim().toLowerCase() || DEFAULT_EFFORT;
    while (!STARTER_EFFORTS.includes(effort)) effort = (await ask("Choose default, low, medium, high, or xhigh: ")).trim().toLowerCase();
    choices.starterEffort = effort;
  }
  if (!Object.keys(chosen).length) log("No new presets selected; existing presets are preserved. Bare launch: tap launch <harness> <name>");
  for (const h of found.filter(h=>PERMISSION_HARNESSES.includes(h))) {
    log(PERMISSION_EXPLANATIONS[h]!);
    const saved = snapshot.previous.harness?.[h]?.permissions;
    const savedValid = ["auto","bypass"].includes(saved);
    const fallback = savedValid ? saved : "auto";
    let answer = (await ask(`${h}: Permission mode [${savedValid ? `keep ${fallback}` : "auto"}] (auto/bypass)${h === "claude" ? `. ${CLAUDE_AUTO_NOTE}` : ""}: `)).trim();
    while (answer && !["auto","bypass"].includes(answer)) answer = (await ask(`${h}: choose auto or bypass, or leave empty to keep the displayed default: `)).trim();
    choices.harnesses![h]!.permissions = (answer || fallback) as "auto" | "bypass";
  }
  choices.fullKit = await confirm(ask,"Install the optional full skill kit for flat hosts? (Claude and Codex have the complete TAP plugin)",savedFullKit(snapshot.previous) === true ? "y" : "n");
  let notifier = (await ask("Notifier [keep existing/system default] (keep/system/command): ")).trim() || "keep";
  while (!["keep","system","command"].includes(notifier)) notifier = (await ask("Choose keep, system, or command: ")).trim();
  if (notifier !== "keep") {
    choices.notifications = {notifier:notifier as "system" | "command"};
    if (notifier === "command") {
      const argv = (await ask("Notifier command as a JSON argv array [keep existing]: ")).trim();
      if (argv) {
        try { choices.notifications.command = JSON.parse(argv); }
        catch { throw new TapError(1,"setup_refused","tap help setup","notifications.command: expected a JSON argv array"); }
      }
    }
  }
  const preview = prepareSetup(snapshot,choices,reference);
  if (preview.changed && snapshot.existed && !(await confirm(ask,`Update existing ${snapshot.config} (keep a backup)?`,"n"))) choices.write = "candidate";
  const target = join(configDir(),"config.candidate.toml");
  if (preview.changed && choices.write === "candidate" && lstatSync(target,{throwIfNoEntry:false})) {
    if (!(await confirm(ask,`Replace existing candidate ${target}?`,"n"))) { log("Existing config and candidate preserved."); return undefined; }
    choices.replaceCandidate = true;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  if (choices.write !== "candidate") {
    if (shellSupported(shell)) {
      // Consent follows the exact effect: the startup file and each alias line. A startup file
      // setup cannot manage (a symlink, say) withdraws the offer; the rest of setup still completes.
      let preview: string | undefined;
      try { preview = describeShellChange(selected); }
      catch (error) { log(`Shell integration is unavailable (${error instanceof Error ? error.message : error}); next: add PATH or aliases to your startup file yourself.`); }
      if (preview !== undefined) {
        log(preview);
        choices.shellIntegration = await confirm(ask,selected.length ? "Add shell aliases?" : "Add shell integration (PATH and completion)?","y");
      }
    }
    else log(`Shell aliases support Bash/Zsh, not ${shell}; next: use tap launch directly or configure your shell manually.`);
  }
  log("Optional plugins are installed separately and will remain after tap uninstall.");
  for (const h of choices.fullKit ? found.filter(h=>["claude","codex"].includes(h)) : []) for (const name of Object.keys(PLUGINS)) {
    if (await confirm(ask,`Install ${name} for ${h}?`,"n")) {
      choices.plugins ??= {}; choices.plugins[h] ??= []; choices.plugins[h]!.push(name);
    }
  }
  return choices;
}

const aliasLine = (name: string) => `alias ${name}=${quote(`tap_launch ${name}`)}`;
/** Selected presets with no alias line of that name yet: exactly the lines a shell write would add. */
const missingAliases = (names: string[], original: string) => names
  .filter(name=>!original.split("\n").some(line=>line.trimStart().startsWith(`alias ${name}=`))).map(aliasLine);
/** The dry-run's alias lines, each noting a command of that name the alias would take precedence over. */
function aliasPreview(lines: string[], names: string[]): string {
  if (!lines.length) return "no new preset aliases (an alias is added for each preset selected in these answers that has none yet).";
  const shadowed = names.map(name=>[name,Bun.which(name,{PATH:searchPath()})] as const).filter(([name,path])=>path && lines.includes(aliasLine(name)));
  return ["these preset aliases:",...lines.map(line=>`  ${line}`),
    ...shadowed.map(([name,path])=>`  note: the alias ${name} would take precedence over ${path} in interactive shells`)].join("\n");
}

const TAP_LAUNCH_HELPER = 'tap_launch() { local preset="$1" name="$1"; shift; if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then name="$name-$1"; shift; fi; tap session launch "$preset" "$name" "$@"; }';
/** The wizard once wrote this obsolete PATH element; an upgrade strips only it. */
const OBSOLETE_PATH_ELEMENT = "/opt/python@3.11/libexec/bin";
const installBinDir = () => process.env.TAP_INSTALL_BIN || join(home(), ".local", "bin");
const shellStartupFile = (shell: string) => join(home(),shell.endsWith("bash") ? ".bashrc" : ".zshrc");

/** The parts a fresh managed block carries: the write emits them and the preview names them. */
function freshBlockParts(shell: string) {
  const binDir = installBinDir();
  const pathLine = (process.env.PATH || "").split(":").includes(binDir) ? [] : [`export PATH=${quote(binDir)}:"$PATH"`];
  const completion = shell.endsWith("zsh") ? zshCompletionLines(binDir) : [];
  return { pathLine, completion };
}

const shellSupported = (shell: string) => /(?:^|\/)(?:bash|zsh)$/.test(shell);

/** The marker pair a startup file carries: the current spelling, else the legacy one a block written before the rename still uses. */
function shellBlockMarkers(original: string): readonly [string, string] | undefined {
  return SHELL_BLOCK_MARKERS.find(([begin,end]) => original.includes(begin) || original.includes(end));
}

type ShellPlan =
  | { kind: "fresh"; path: string; block: string; pathLine: string[]; completion: string[]; aliases: string[] }
  | { kind: "upgrade"; path: string; owned: Entry; content: string; block: string; prunedPath: boolean; completionAdded: boolean; completionPresent: boolean; aliases: string[] }
  | { kind: "preserve"; path: string };

/**
 * One plan serves the dry run and the write, so the bytes the preview prints are the bytes
 * the write lands. An undefined manifest means ownership cannot be proven: an existing block
 * is then preserved, never rewritten.
 */
function planShellChange(shell: string, names: string[], original: string, manifest: Manifest | undefined, symlink: boolean): ShellPlan {
  const path = shellStartupFile(shell);
  const markers = shellBlockMarkers(original);
  if (!markers) {
    const {pathLine,completion} = freshBlockParts(shell);
    const aliases = missingAliases(names,original);
    return { kind:"fresh", path, block:[SHELL_BLOCK_BEGIN,...pathLine,...completion,TAP_LAUNCH_HELPER,...aliases,SHELL_BLOCK_END].join("\n"), pathLine, completion, aliases };
  }
  const [begin,end] = markers;
  const owned = !symlink && manifest ? ownedShellBlock(path,original,manifest,markers) : undefined;
  if (!owned) return { kind:"preserve", path };
  const start = original.indexOf(begin), stop = original.indexOf(end) + end.length;
  const content = original.slice(start,stop);
  const zsh = shell.endsWith("zsh");
  const completion = zshCompletionLines(installBinDir());
  const lines = content.split("\n");
  const prunedLines: string[] = [];
  for (const line of lines) {
    if (!line.includes(OBSOLETE_PATH_ELEMENT)) { prunedLines.push(line); continue; }
    // The wizard wrote one line: export PATH='<brew>/bin:<brew>/opt/python@3.11/libexec/bin':"$PATH".
    // Strip only the obsolete element so Homebrew's bin prefix survives; drop
    // the line entirely when nothing but the python element remained.
    const stripped = line.replace(/:[^:'"]*\/opt\/python@3\.11\/libexec\/bin(?=['"])/, "");
    if (!stripped.includes(OBSOLETE_PATH_ELEMENT)) prunedLines.push(stripped);
  }
  const pruned = prunedLines.join("\n");
  const completionAdded = zsh && !prunedLines.some(line => completion.includes(line));
  const aliases = missingAliases(names,original);
  let block = completionAdded ? pruned.replace(begin,[begin,...completion].join("\n")) : pruned;
  if (aliases.length) block = block.replace(end,[...aliases,end].join("\n"));
  return { kind:"upgrade", path, owned, content, block, prunedPath: pruned !== content, completionAdded, completionPresent: zsh && lines.includes(completion[0]!), aliases };
}

/** What a shell write would do, read from the same file and ownership record the write uses. */
function describeShellChange(names: string[]): string {
  const shell = process.env.SHELL || "/bin/zsh";
  const path = shellStartupFile(shell);
  const original = regularText(path,"shellIntegration") ?? "";
  // Every shell write records its block, so an unreadable manifest refuses here, before any effect.
  const plan = planShellChange(shell,names,original,readManifest(),false);
  if (plan.kind === "fresh") {
    const parts = [...(plan.pathLine.length ? ["PATH"] : []), ...(plan.completion.length ? ["completion"] : []), "the tap_launch helper"];
    const held = parts.length > 1 ? `${parts.slice(0,-1).join(", ")} and ${parts.at(-1)}` : parts[0];
    return [`Would add the managed TAP shell block (${held}) to ${path}, with ${aliasPreview(plan.aliases,names)}`, "The block, exactly as it would be written:", plan.block].join("\n");
  }
  if (plan.kind === "upgrade") {
    const head = `Would update the owned TAP shell block in ${path}, preserving existing definitions, refreshing TAP's own PATH and completion lines where outdated, and adding ${aliasPreview(plan.aliases,names)}`;
    return plan.block === plan.content ? `${head}\nNo line in that block would change.` : [head, "The block, exactly as it would be rewritten:", plan.block].join("\n");
  }
  return `Would preserve the unowned or edited TAP shell block in ${path}; no new aliases would be added.`;
}

function ownedShellBlock(path: string, original: string, manifest: Manifest, [begin,end]: readonly [string,string]): Entry | undefined {
  if (original.split(begin).length !== 2 || original.split(end).length !== 2) return undefined;
  const start = original.indexOf(begin), stop = original.indexOf(end);
  if (stop < start) return undefined;
  const content = original.slice(start,stop+end.length);
  return manifest.entries.find(entry=>entry.kind === "block" && entry.path === path && entry.begin === begin && entry.end === end && entry.content === content);
}

// Zsh completion: put TAP's function directory on fpath, then register `_tap` without a
// second compinit when the user's own startup already ran one (compdef exists only
// after compinit); otherwise run compinit once so the fpath entry is scanned.
function zshCompletionLines(binDir: string): string[] {
  return [`fpath=(${quote(join(binDir, "../share/zsh/site-functions"))} $fpath)`,
    "(( $+functions[compdef] )) && { autoload -Uz _tap && compdef _tap tap; } || { autoload -Uz compinit && compinit; }"];
}

function applyShellIntegration(names: string[], log: Log) {
  const shell = process.env.SHELL || "/bin/zsh";
  const path = shellStartupFile(shell);
  const original = existsSync(path) ? readFileSync(path,"utf8") : "";
  const symlink = existsSync(path) && lstatSync(path).isSymbolicLink();
  let manifest: Manifest | undefined;
  try { manifest = readManifest(); }
  catch { /* Missing or invalid ownership evidence preserves the existing block. */ }
  const plan = planShellChange(shell,names,original,manifest,symlink);
  if (plan.kind === "fresh") {
    record({kind:"block",path,begin:SHELL_BLOCK_BEGIN,end:SHELL_BLOCK_END,content:plan.block});
    atomic(path,original+(original.endsWith("\n") || !original ? "" : "\n")+plan.block+"\n");
    const wrote = [...(plan.pathLine.length ? ["PATH"] : []), ...(plan.completion.length ? ["zsh completion"] : []),
      ...(plan.aliases.length ? [`${plan.aliases.length} preset alias${plan.aliases.length === 1 ? "" : "es"}`] : []), "tap_launch helper"];
    log(`Wrote the TAP shell block to ${path}: ${wrote.join(", ")}`);
    return;
  }
  let upgraded = false;
  if (plan.kind === "upgrade") {
    if (plan.block !== plan.content) {
      record({ ...plan.owned, content: plan.block });
      atomic(path, original.replace(plan.content, plan.block));
      if (plan.prunedPath) log(`Removed the obsolete python PATH line from the owned TAP alias block at ${path}`);
      if (plan.completionAdded) log(`Enabled zsh completion in the owned TAP alias block at ${path}`);
      if (plan.aliases.length) log(`Added ${plan.aliases.length} preset aliases to the owned TAP block at ${path}`);
      upgraded = true;
    } else if (plan.completionPresent) {
      log(`Zsh completion is already enabled in the owned TAP alias block at ${path}`);
      upgraded = true;
    }
  }
  if (!upgraded) log(`Existing TAP alias block preserved in ${path}; edit it to add new choices.`);
  if (original.includes("Scripts")) log(`Check the existing PATH in ${path}: TAP now installs to ${join(home(),".local/bin")}.`);
}

async function applySetup(snapshot: SetupSnapshot, plan: SetupPlan, json: boolean, interactive: boolean, notes: string[], log: Log, dryRun = false, verbose = false): Promise<number> {
  const {choices,chosen,selected,changed,edited} = plan;
  const {config,existed,source,previous} = snapshot;
  const plugins = Object.entries(choices.plugins ?? {}).sort().flatMap(([h,names])=>[...new Set(names)].sort().map(name=>({h,name})));
  // Preflight all selected effects before creating even the config lock.
  if (Object.keys(chosen).length && !Object.keys(previous.presets ?? {}).length && lstatSync(join(configDir(),"presets.toml"),{throwIfNoEntry:false})) {
    throw new Error("harnesses.presets: migrate the legacy presets.toml catalog before adding config presets; both files preserved");
  }
  const target = choices.write === "candidate" ? join(configDir(),"config.candidate.toml") : config;
  const candidate = choices.write === "candidate" && changed ? regularText(target,"replaceCandidate") : undefined;
  if (candidate !== undefined && choices.replaceCandidate !== true) throw new Error("replaceCandidate: true is required to replace an existing candidate");
  if (choices.fullKit !== undefined && choices.write !== "candidate") readManifestRecord(skillManifestPath());
  let shellPreview = "";
  if (choices.shellIntegration) {
    const shell = process.env.SHELL || "/bin/zsh";
    if (!shellSupported(shell)) throw new Error(`shellIntegration: unsupported shell ${shell}; use Bash or Zsh`);
    shellPreview = describeShellChange(selected);
  }
  for (const {h} of plugins) if (!Bun.which(binaries[h]!,{PATH:searchPath()})) throw new Error(`plugins.${h}: CLI not found; install it before requesting plugins`);
  if (!changed && !choices.shellIntegration && !plugins.length && choices.fullKit === undefined) {
    const note = "No changes requested; existing settings preserved.";
    notes.push(note); log(note); waitTip(choices,snapshot.previous,interactive,log); return 0;
  }
  if (dryRun) {
    if (regularText(config,"config") !== (existed ? source : undefined)) throw new TapError(2,"setup_refused","tap help setup","config: changed during setup; rerun with the current file");
    const lines = [`Dry run: no effects. TOML-key diff for ${target}:`];
    const keyOf = (path: string[]) => path.map(part=>/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join(".");
    // A starter's calibration notes are many keys nobody chose one by one: one line per preset
    // unless --verbose, and always in full when a note already saved would change.
    const isNewNote = (change: {path: string[]; before?: unknown}) => !verbose && change.path.length > 3 && change.path[0] === "presets" && change.path[2] === "metadata" && change.before === undefined;
    const noteCounts = new Map<string, number>();
    for (const change of plan.changes) if (isNewNote(change)) noteCounts.set(change.path[1]!,(noteCounts.get(change.path[1]!) ?? 0)+1);
    const summarized = new Set<string>();
    for (const change of plan.changes) {
      if (isNewNote(change)) {
        const preset = change.path[1]!;
        if (summarized.has(preset)) continue;
        summarized.add(preset);
        const n = noteCounts.get(preset)!;
        lines.push(`+ ${keyOf(["presets",preset,"metadata"])} = ${n} calibration note${n === 1 ? "" : "s"} (--verbose lists each)`);
        continue;
      }
      const key = keyOf(change.path);
      if (change.before !== undefined) lines.push(`- ${key} = ${JSON.stringify(change.before)}`);
      const annotation = key === "harness.codex.env.PONYTAIL_DEFAULT_MODE" && change.before === undefined
        ? " # default: Ponytail is an optional third-party plugin that makes the agent favor the simplest solution; off has no effect when it is not installed" : "";
      lines.push(`+ ${key} = ${JSON.stringify(change.after)}${annotation}`);
    }
    if (changed && choices.write === "apply" && existed) lines.push("Would back up the original config before applying.");
    if (candidate !== undefined) lines.push("Would replace the existing inactive candidate.");
    if (choices.fullKit !== undefined) lines.push(choices.write === "candidate" ? "Full-kit preference remains inactive in candidate config; live skill links unchanged." : `Would ${choices.fullKit ? "install the full flat-host skill kit" : `keep the ${CORE_SKILLS.length} default skills and remove unchanged owned optional links`}.`);
    if (choices.shellIntegration) lines.push(shellPreview);
    for (const {h,name} of plugins) lines.push(`Would install ${name} for ${h}.`);
    const note = lines.join("\n"); notes.push(note); log(note); return 0;
  }
  let started = false;
  const completed: string[] = [];
  try {
    if (regularText(config,"config") !== (existed ? source : undefined)) throw new TapError(2,"setup_refused","tap help setup","config: changed during setup; rerun with the current file");
    if (changed) {
      mkdirSync(dirname(config),{recursive:true});
      const lock = acquireNoFollowLock(`${config}.lock`,2500);
      try {
        if (regularText(config,"config") !== (existed ? source : undefined)) throw new TapError(2,"setup_refused","tap help setup","config: changed during setup; rerun with the current file");
        if (choices.write === "candidate" && regularText(target,"replaceCandidate") !== candidate) throw new Error("replaceCandidate: candidate changed during setup; nothing written");
        if (choices.write === "apply" && existed) {
          const backup = `${config}.backup-${Date.now()}-${process.pid}`;
          writeFileSync(backup,source,{mode:0o600,flag:"wx"}); started = true;
          completed.push(`backup ${backup}`);
          log(`Backup: ${backup}`);
        }
        atomic(target,edited); started = true; completed.push(`config ${target}`);
      } finally { closeSync(lock); }
      log(`Wrote ${target}`);
    }
    if (choices.fullKit !== undefined && choices.write !== "candidate") { started = true; installMachineSkills(REPO,choices.fullKit,log,verbose); completed.push("skill links reconciled"); }
    if (choices.shellIntegration) { started = true; applyShellIntegration(selected,log); completed.push("shell integration processed"); }
    for (const {h,name} of plugins) {
      const {market,source:pluginSource} = PLUGINS[name]!;
      const commands = [[h,"plugin","marketplace","add",pluginSource],[h,"plugin",h === "codex" ? "add" : "install",`${name}@${market}`]];
      for (const command of commands) {
        log(command.join(" ")); started = true;
        if (!interactive) {
          // Each finite, selected plugin command has bounded output. Do not let it
          // corrupt the one-object failure response before its exit is known.
          await new Promise<void>((done,fail)=>{
            const child = execFile(command[0]!,command.slice(1),{env:{...process.env,PATH:searchPath()},maxBuffer:64*1024},(error,stdout,stderr)=>{
              if (error) { fail(new Error(`plugins.${h}: command failed (${error.code ?? "spawn error"}); inspect ${command.join(" ")}`)); return; }
              if (stdout.trim()) log(stdout.trimEnd());
              if (stderr.trim()) log(stderr.trimEnd());
              done();
            });
            child.stdin?.end();
          });
        } else {
          const child = Bun.spawn(command,{env:{...process.env,PATH:searchPath()},stdin:"inherit",stdout:json ? 2 : "inherit",stderr:"inherit"});
          if (await child.exited !== 0) throw new Error(`plugins.${h}: command failed; inspect ${command.join(" ")}`);
        }
        completed.push(command.join(" "));
      }
    }
    if (interactive) {
      const installed=Bun.which(join(process.env.TAP_INSTALL_BIN || join(home(),".local/bin"),"tap")) || Bun.which("tap");
      if(installed) {
        const executable=realpathSync(installed);
        const revision=Bun.spawnSync(["git","-C",dirname(executable),"rev-parse","HEAD"],{stdout:"pipe",stderr:"pipe"});
        log(`Installed TAP: ${installed} -> ${executable}; HEAD ${revision.exitCode===0 ? revision.stdout.toString().trim() : "unavailable"}`);
      } else log("Installed TAP: unavailable on PATH");
      const sheet = join(REPO,"docs/cheatsheet.html");
      if (process.env.TAP_SETUP_OPEN_GUIDE !== "0" && existsSync(sheet) && process.platform === "darwin") {
        const result = Bun.spawnSync(["open",sheet],{stdout:"ignore",stderr:"pipe"});
        if (result.exitCode) log(`Open the guide: ${sheet}`);
      } else log(`Guide: ${sheet}`);
    }
    if (changed && choices.write === "candidate") log(`next: review ${target}; it is inactive until adopted.`);
    else {
      // Every preset this run added or aliased, in config order; the first is the example, the rest are named so none looks arbitrary.
      const names = [...Object.keys(chosen), ...selected.filter(name => !Object.hasOwn(chosen,name))];
      const harness = Object.keys(choices.harnesses ?? {})[0];
      const others = names.length > 1 ? ` (or any of: ${names.slice(1).join(", ")})` : "";
      log(names.length ? `next: from your work directory, run tap launch ${names[0]}${others}` : harness ? `next: from your work directory, run tap launch ${harness} <name>` : "Requested setup effects applied.");
    }
    waitTip(choices,snapshot.previous,interactive,log);
  } catch (error) {
    if (!started) throw error;
    const detail = `${error instanceof Error ? error.message : error}; completed effects retained: ${completed.join("; ") || "an effect was attempted; inspect its state"}. The failed operation may also have applied effects.`;
    throw new TapError(1,"setup_partial","inspect completed setup effects before retrying",humanLine(detail));
  }
  return 0;
}

async function finishSetup(operation: (notes: string[], log: Log)=>Promise<number>, json: boolean, answers = false): Promise<number> {
  const notes: string[] = [], diagnostics: string[] = [];
  const output: Log = json ? console.error : console.log;
  const log: Log = answers ? message=>diagnostics.push(message) : output;
  try {
    const status = await operation(notes,log);
    for (const message of diagnostics) output(message);
    if (json) console.log(JSON.stringify({exit_code:status,notes}));
    return status;
  } catch (error) {
    const partial = error instanceof TapError && error.errorClass === "setup_partial";
    const code = answers ? 1 : error instanceof TapError ? error.code : error instanceof Error && error.name === "AbortError" ? 2 : 1;
    const failure = partial ? error : new TapError(code,"setup_refused","tap help setup",
      humanLine(`${error instanceof Error ? error.message : error}; no setup effects applied`));
    if (json) process.stdout.write(tapErrorJson(failure));
    else process.stderr.write(tapErrorLine(failure,"tap setup"));
    return failure.code;
  }
}
export async function setupMachine(ask: Prompt, detected?: string[], json = false, dryRun = false, verbose = false): Promise<number> {
  configDir();
  return finishSetup(async(notes,log)=>{
    const found = detected ?? Object.keys(binaries).filter(h=>Bun.which(binaries[h]!,{PATH:searchPath()}));
    log("Pre-release beta: expect bugs; send bug reports and feature requests to ted@tedyav.com.");
    log(`Detected executables: ${found.join(", ") || "none"}. This does not verify login or model access.`);
    if (!found.length) { log(`No supported CLI detected (${Object.values(binaries).join(", ")}); install and sign in before running tap setup --machine. To request another harness: https://github.com/TedYav/tap/issues`); return 0; }
    const snapshot = setupSnapshot();
    const choices = await collectSetupChoices(ask,snapshot,found,log,notes);
    if (!choices) return 0;
    return applySetup(snapshot,prepareSetup(snapshot,choices,catalog()),json,true,notes,log,dryRun,verbose);
  },json);
}
export async function setupMachineAnswers(input: unknown, json = false, dryRun = false, verbose = false): Promise<number> {
  return finishSetup(async(notes,log)=>{
    const choices = parseSetupChoices(input);
    const snapshot = setupSnapshot();
    const plan = prepareSetup(snapshot,choices,catalog());
    permissionNotes(plan,notes,log);
    return applySetup(snapshot,plan,json,false,notes,log,dryRun,verbose);
  },json,true);
}

export async function cmdSetupMachine(argv: string[]): Promise<number> {
  let file: string | undefined;
  const json = argv.includes("--json") || process.env.TAP_JSON === "1";
  const answers = argv.some(arg=>arg === "--answers" || arg.startsWith("--answers="));
  const dryRun = argv.includes("--dry-run");
  const verbose = argv.includes("--verbose");
  for (let i=0;i<argv.length;i++) {
    if (argv[i] === "--machine" || argv[i] === "--json" || argv[i] === "--dry-run" || argv[i] === "--verbose") continue;
    if (argv[i] === "--answers" && file === undefined && argv[i+1] && !argv[i+1]!.startsWith("--")) { file=argv[++i]; continue; }
    if (answers) return finishSetup(async()=>{throw new Error("arguments: expected tap setup --machine --answers <file|-> [--dry-run] [--json] [--verbose]");},json,true);
    console.error("Usage: tap setup --machine [--answers <file|->] [--dry-run] [--json] [--verbose]"); return 2;
  }
  if (file !== undefined) {
    let input: unknown;
    try {
      const text = file === "-" ? decodeSetupText(readFileSync(0),"answers") : regularText(resolve(file),"answers");
      if (text === undefined) throw new Error(`answers: file not found: ${file}`);
      try { input = JSON.parse(text); } catch { throw new Error("answers: invalid JSON"); }
    } catch (error) { return finishSetup(async()=>{throw error;},json,true); }
    return setupMachineAnswers(input,json,dryRun,verbose);
  }
  try { return await interact(ask=>setupMachine(ask,undefined,json,dryRun,verbose),json ? process.stderr : process.stdout); }
  catch (error) { console.error(`tap setup: ${error}; next: tap setup --machine`); return 2; }
}

/**
 * A dry run's planned effects: path -> the text it would hold, or null once
 * removed. Later entries read through it, so a preview reports exactly the
 * outcomes the real run would.
 */
export type Plan = Map<string, string | null>;

/** A TAP-created JSON document whose remainder is only empty containers (Cursor's version stamp included). */
function jsonHusk(value: unknown, top = true): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).every(([key, item]) => (top && key === "version" && item === 1) || jsonHusk(item, false));
}

/**
 * Removes a recorded block with its line ending. The Codex fence also drops
 * the blank line the installer put before it; other blocks keep theirs.
 */
function spliceBlock(raw: string, content: string, separated: boolean): string {
  const at = raw.indexOf(content);
  const before = raw.slice(0, at);
  return (separated ? before.replace(/(^|\n)\r?\n$/, "$1") : before) + raw.slice(at + content.length).replace(/^\r?\n/, "");
}

/** Writes the remainder, or deletes a file TAP created once only its empty skeleton is left. */
function settle(entry: Entry, next: string, husk: boolean, done: string, plan?: Plan): string {
  if (entry.created_containers?.created_file && husk) {
    if (plan) plan.set(entry.path, null); else rmSync(entry.path);
    return `${done} and deleted the file TAP created`;
  }
  if (plan) plan.set(entry.path, next); else atomic(entry.path, next);
  return `${done} from`;
}

export function removeEntry(entry: Entry, plan?: Plan): string {
  if (entry.kind === "native-plugin" || entry.kind === "native-marketplace") {
    const outcome = removeSkillPlugin(entry, !!plan, undefined, new Set(plan ? [...plan].filter(([, value]) => value === null).map(([path]) => path) : []));
    if (outcome === "removed") plan?.set(entry.path, null);
    return outcome;
  }
  if (entry.kind === "migration") return "already migrated; old path untouched";
  if (entry.kind === "git-config") {
    const current = Bun.spawnSync(["git","-C",entry.path,"config","--local","--get","core.hooksPath"]);
    if (current.stdout.toString().trim() !== entry.value) return "preserved changed core.hooksPath";
    if (!plan) {
      const result = Bun.spawnSync(["git","-C",entry.path,"config","--local","--unset","core.hooksPath"]);
      if (result.exitCode !== 0) throw new Error(`could not unset core.hooksPath at ${entry.path}`);
    }
    return "unset core.hooksPath in";
  }
  if (plan?.get(entry.path) === null) return "already missing";
  let stat;
  try { stat = lstatSync(entry.path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already missing";
    throw error;
  }
  if (entry.kind === "symlink") {
    const outcome = removeOwnedLink(entry.path, entry.target, !plan);
    if (outcome === "removed") plan?.set(entry.path, null);
    return outcome;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return "preserved changed file type";
  let raw = plan?.get(entry.path) ?? readFileSync(entry.path,"utf8");
  if (entry.kind === "block" && entry.begin === CODEX_BEGIN) {
    // Tables Codex appended inside TAP's fence (hook or project trust) move
    // below the end marker first, so removing the block never takes them.
    const owned = entry.content.split("\n").slice(1,-1).filter((line: string)=>line.trim()).length;
    try { raw = relocateCodexEndMarker(Buffer.from(raw),owned).raw.toString("utf8"); }
    catch (error) { return `preserved TAP block (${(error as Error).message})`; }
  }
  if (entry.kind === "file") {
    if (hash(readFileSync(entry.path)) !== entry.sha256) return "preserved edited file";
    if (plan) plan.set(entry.path, null); else rmSync(entry.path);
    return "removed";
  }
  if (entry.kind === "block") {
    if (!raw.includes(entry.content)) return "preserved edited or missing TAP block";
    if (raw.indexOf(entry.content) !== raw.lastIndexOf(entry.content)) return "preserved ambiguous TAP blocks";
    let next=spliceBlock(raw,entry.content,entry.begin === CODEX_BEGIN);
    const created=entry.created_containers;
    if(created && entry.path.endsWith(".toml")) {
      try {
        const parsed=Bun.TOML.parse(next) as any;
        const expected=structuredClone(parsed);
        if(!parsed.hooks || !Object.keys(parsed.hooks).length) {
          if(created.hooks) {
            next=next.replace(/^\[hooks\][ \t]*\r?\n(?=\s*(?:\[|$))/m,"");
            delete expected.hooks;
          }
          if(created.features_hooks && parsed.features?.hooks===true) {
            next=next.replace(/(^\[features\][^\[]*?)^hooks[ \t]*=[ \t]*true[ \t]*\r?\n/m,"$1");
            delete expected.features.hooks;
            if(created.features) {
              next=next.replace(/^\[features\][ \t]*\r?\n(?=\s*(?:\[|$))/m,"");
              if(!Object.keys(expected.features).length)delete expected.features;
            }
          }
        }
        // As in config set: text matching locates; parsed values authorize the write.
        // Only recorded owned keys/empty containers may differ after block removal.
        const differences: string[]=[];
        collectDifferences(expected,Bun.TOML.parse(next),[],differences);
        if(differences.length)return "preserved ambiguous TOML containers";
      } catch { return "preserved ambiguous TOML containers"; }
    }
    return settle(entry,next,!next.trim(),SHELL_BLOCK_BEGINS.includes(entry.begin) ? "removed the TAP alias block" : "removed the TAP block",plan);
  }
  const data = JSON.parse(raw);
  if (entry.kind === "json-key") {
    if (!equal(data[entry.key],entry.value)) return "preserved changed JSON entry";
    delete data[entry.key];
    return settle(entry,JSON.stringify(data,null,2)+"\n",jsonHusk(data),`removed TAP's ${entry.key} entry`,plan);
  }
  if (entry.kind === "hook") {
    const rows = data.hooks?.[entry.event];
    if (!Array.isArray(rows)) return "already missing";
    let removed = false;
    data.hooks[entry.event] = rows.flatMap((row: any) => {
      if (!entry.nested) {
        if (equal(row,entry.value)) { removed = true; return []; }
        return [row];
      }
      if (!Array.isArray(row?.hooks)) return [row];
      const kept = row.hooks.filter((leaf: any)=> !equal(leaf,entry.value));
      if (kept.length === row.hooks.length) return [row];
      removed = true;
      if (!kept.length && Object.keys(row).every(k=>["hooks","matcher"].includes(k))) return [];
      return [{...row,hooks:kept}];
    });
    if (!removed) return "preserved changed or missing hook";
    const created=entry.created_containers;
    if(created?.events?.includes(entry.event) && !data.hooks[entry.event].length)delete data.hooks[entry.event];
    if(created?.hooks && !Object.keys(data.hooks).length)delete data.hooks;
    return settle(entry,JSON.stringify(data,null,2)+"\n",jsonHusk(data),`removed TAP ${entry.event} hook`,plan);
  }
  return "preserved unknown manifest kind";
}
export function historyPaths(): string[] {
  const paths = [index(),configDir()];
  const registry = join(index(),"global-registry.json");
  if (existsSync(registry)) {
    const data = readIndexJson(registry);
    if (!data.teams || typeof data.teams !== "object" || Array.isArray(data.teams)) throw new Error(`invalid registry ${registry}; preserve history and inspect it`);
    for (const team of Object.values(data.teams) as any[]) {
      if (typeof team.root !== "string" || !isAbsolute(team.root)) throw new Error("invalid team root; history preserved");
      paths.push(join(team.root,".tap"));
    }
  }
  const unique = [...new Set(paths.map(p=>resolve(p)))];
  for (const path of unique) if (path === "/" || path === resolve(home()) || path === REPO) throw new Error(`unsafe history path ${path}`);
  return unique.filter(p=>existsSync(p)).filter(p=>!unique.some(other=>other!==p && p.startsWith(other+"/")));
}
/** A planned outcome in the future tense; the real run prints the past tense. */
function wouldDo(outcome: string): string {
  return outcome
    .replace(/^removed /, "would remove ").replace(/^removed$/, "would remove")
    .replace(/^unset /, "would unset ").replace(/^preserved /, "would preserve ")
    .replace(" and deleted the file", " and delete the file");
}

/**
 * What removed files leave under the index home that is not history: the
 * runtime lock directory and directories the removed files emptied.
 * `gone` names every path the run removed (or would remove).
 */
function leftovers(gone: Set<string>, apply: boolean): string[] {
  const root = resolve(index()), lines: string[] = [];
  const vacated = (dir: string): boolean => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return false; }
    return names.every(name => {
      const path = join(dir, name);
      if (gone.has(path)) return true;
      const stat = lstatSync(path, {throwIfNoEntry:false});
      return !!stat && stat.isDirectory() && vacated(path);
    });
  };
  const emptied = new Set<string>();
  for (const path of gone) {
    let dir = dirname(path), top: string | undefined;
    while (dir.startsWith(`${root}/`) && vacated(dir)) { top = dir; dir = dirname(dir); }
    if (top) emptied.add(top);
  }
  for (const dir of [...emptied].sort()) {
    if ([...emptied].some(other => other !== dir && dir.startsWith(`${other}/`))) continue;
    if (apply) rmSync(dir, {recursive:true});
    lines.push(`${apply ? "removed" : "would remove"} emptied directory: ${dir}`);
  }
  const locks = join(root, "locks");
  if (existsSync(locks)) {
    // A lock is removed only when lsof proves nothing holds it; a missing or
    // failing lsof keeps it, since removing a live server's lock breaks it.
    const probe = Bun.spawnSync([Bun.which("lsof") ?? "/usr/sbin/lsof", "+D", locks], {stdout:"pipe", stderr:"pipe"});
    if (probe.exitCode === 1 && !probe.stdout.toString().trim()) {
      if (apply) rmSync(locks, {recursive:true});
      lines.push(`${apply ? "removed" : "would remove"} runtime locks (not history): ${locks}`);
    } else {
      lines.push(`${apply ? "preserved" : "would preserve"} runtime locks: ${locks}; a process may hold them. next: after TAP stops, remove them: rm -rf ${quote(locks)}`);
    }
  }
  return lines;
}

/** A bootstrap layout only, as watch-run's currentReleaseSource checks it: the marker names this version directory and a sibling current link resolves into the same versions/. */
function bootstrapRelease(repo: string): { real: string; versions: string; current: string } | null {
  try {
    const real = realpathSync(repo), versions = dirname(real), current = join(dirname(versions), "current");
    if (basename(versions) !== "versions") return null;
    const marker = JSON.parse(readFileSync(join(real, "tap-release.json"), "utf8"));
    if (marker.schema !== 1 || marker.version !== basename(real)) return null;
    if (!lstatSync(current).isSymbolicLink() || dirname(realpathSync(current)) !== versions) return null;
    return { real, versions, current };
  } catch { return null; }
}

/**
 * The closing line about TAP's own files. A clone is one directory. A bootstrap release
 * runs from <prefix>/versions/<version>, which <prefix>/current links to; deleting the
 * link alone would leave every version, and a running agent session still uses one.
 */
export function installSourceAdvice(repo: string, preserved: boolean): string {
  const release = bootstrapRelease(repo);
  if (!release) {
    return preserved ? `Keep TAP's clone at ${repo} until you resolve the preserved artifacts above.` : `TAP no longer uses its clone at ${repo}; it is safe to delete: rm -rf ${quote(repo)}`;
  }
  const { real, versions, current } = release;
  // Advice runs after uninstall's effects, so an unlistable directory must not fail the run.
  let kept: string[] | null = null;
  try { kept = readdirSync(versions).filter(name => !name.startsWith(".")).sort(); } catch {}
  const held = kept ? `${kept.length} release${kept.length === 1 ? "" : "s"} (${kept.join(", ")})` : "every installed release";
  const where = `TAP's release files remain: ${current} links to ${real}, and ${versions} keeps ${held}.`;
  if (preserved) return `${where} Keep them until you resolve the preserved artifacts above.`;
  return `${where} Deleting current alone leaves every version. Agent sessions that are still running use these files; once none runs, remove the release: rm -rf ${quote(current)} ${quote(versions)}`;
}

export type UninstallOptions = { dryRun?: boolean; yes?: boolean; history?: "keep" | "archive" | "delete" };

/** The tmux lookup key and the tmux defaults live outside the install manifest, so they are removed (or previewed) even when the manifest has nothing else. */
async function uninstallKeybindingOnly(ask: Prompt, options: UninstallOptions): Promise<number> {
  let code = 0;
  if (keybindingInstalled()) {
    if (options.dryRun) { for (const line of uninstallKeybinding(false).lines) console.log(line); }
    else if (!options.yes && !(await confirm(ask, "Remove the tmux lookup key (tap keybinding)?", "n"))) { console.log("Uninstall cancelled; next: tap keybinding remove when ready."); }
    else {
      const outcome = uninstallKeybinding(true);
      for (const line of outcome.lines) console.log(line);
      if (outcome.preserved) { console.log("Uninstall stopped before removing TAP itself, so the tmux binding does not point at a deleted executable. next: fix the problem above (or restart tmux), then rerun tap uninstall"); return 2; }
    }
  }
  if (defaultsInstalled()) {
    if (options.dryRun) { for (const line of uninstallDefaults(false).lines) console.log(line); return code; }
    if (!options.yes && !(await confirm(ask, "Remove the tmux defaults (tap tmux-defaults)?", "n"))) { console.log("Uninstall cancelled; next: tap tmux-defaults remove when ready."); return code; }
    const outcome = uninstallDefaults(true);
    for (const line of outcome.lines) console.log(line);
    if (outcome.preserved) console.log(uninstallDefaultsPreservedNote());
  }
  return code;
}

/** Unlike the keybinding, unreadable defaults strand nothing that points at TAP's executable: uninstall continues past them. */
function uninstallDefaultsPreservedNote(): string {
  return "TAP's tmux defaults could not be removed (their files cannot be read); they are inert once TAP is gone — tmux's source-file -q ignores an unreadable file — so uninstall continues. next: when readable, tap tmux-defaults remove, or delete the file and its marked source line yourself";
}

export async function uninstallMachine(ask: Prompt, options: UninstallOptions = {}): Promise<number> {
  const manifest = readManifest();
  console.log("Uninstall removes TAP integration; agent sessions keep running. To stop them first, run tap down <team/seat> for each session before uninstalling.");
  if (!existsSync(manifestPath())) { console.log("Nothing to uninstall: no install manifest. History, dependencies, and plugins are preserved."); return await uninstallKeybindingOnly(ask, options); }
  // Detect an omitted record without deleting an artifact on inferred ownership.
  if (manifest.targets) {
    let found: Entry[];
    try { found = scanManifestEntries(manifestPath()); }
    catch (error) { throw new Error(`cannot inspect install manifest: ${(error as Error).message}`); }
    for (const foundEntry of found) {
      if (!manifest.entries.some(e=>e.path===foundEntry.path && e.kind===foundEntry.kind && e.event===foundEntry.event && e.key===foundEntry.key && (e.kind!=="hook" || e.value?.command===foundEntry.value?.command))) console.log(`Unrecorded TAP artifact (preserved): ${foundEntry.path}; next: rerun ./install.sh to reconcile the manifest`);
    }
  }
  if (!manifest.entries.length && !manifest.historyPending) { console.log("Nothing to uninstall: all recorded artifacts already removed. History, dependencies, and plugins are preserved."); return await uninstallKeybindingOnly(ask, options); }
  const history = historyPaths(); // Capture enrolled roots before removing anything.
  if (options.dryRun) {
    const plan: Plan = new Map();
    console.log("Dry run: no effects. Planned outcomes:");
    for (const entry of [...manifest.entries].sort((a,b) => Number(a.kind === "native-marketplace") - Number(b.kind === "native-marketplace"))) console.log(`${wouldDo(removeEntry(entry, plan))}: ${entry.path}`);
    const gone = new Set([...plan].filter(([, text]) => text === null).map(([path]) => path));
    for (const line of leftovers(gone, false)) console.log(line);
    for (const line of uninstallKeybinding(false).lines) console.log(line);
    for (const line of uninstallDefaults(false).lines) console.log(line);
    const choice = options.history ?? "keep";
    console.log(`History (${choice}${options.history ? "" : ", the default"}):\n${history.map(p=>`  ${p}`).join("\n")}`);
    console.log(`next: tap uninstall --yes${options.history ? ` --history ${choice}` : ""}`);
    return 0;
  }
  if (!options.yes) {
    console.log("Recorded removal list:");
    for (const entry of manifest.entries) console.log(entry.kind === "migration" ? `  migration history (no removal): ${entry.path} -> ${entry.destination}` : `  ${entry.kind}: ${entry.path}${entry.event ? ` (${entry.event})` : ""}`);
    if (keybindingInstalled()) console.log("  tmux lookup key: TAP's own tmux conf, its source line in your tmux.conf, and its live binding (tap keybinding)");
    if (defaultsInstalled()) console.log("  tmux defaults: TAP's tmux-defaults.conf and its marked source line in your tmux.conf (tap tmux-defaults)");
    console.log("Changed files/targets are preserved. Dependencies and unrelated plugins stay. Recorded TAP plugin registrations are removed only while their source matches.");
    if (!(await confirm(ask, "Remove these TAP artifacts?", "n"))) { console.log("Uninstall cancelled; next: tap uninstall when ready."); return 0; }
  }
  // The binding runs the installed tap, so it goes first; if tmux refuses, nothing else is removed.
  const keybinding = uninstallKeybinding(true);
  for (const line of keybinding.lines) console.log(line);
  if (keybinding.preserved) { console.log("Uninstall stopped before removing TAP itself, so the tmux binding does not point at a deleted executable. next: fix the problem above (or restart tmux), then rerun tap uninstall"); return 2; }
  const defaults = uninstallDefaults(true);
  for (const line of defaults.lines) console.log(line);
  if (defaults.preserved) console.log(uninstallDefaultsPreservedNote());
  const remaining: Entry[] = [], gone = new Set<string>();
  let retained = false; // a marketplace listing that still names the clone
  // The run may already have removed the tap launcher, so recovery names the clone's own executable.
  const rerun = `${quote(join(manifest.repo,"bin/tap"))} uninstall`;
  for (const entry of [...manifest.entries].sort((a,b) => Number(a.kind === "native-marketplace") - Number(b.kind === "native-marketplace"))) {
    const outcome = removeEntry(entry);
    console.log(`${outcome}: ${entry.path}`);
    if (outcome === RETAINED_LISTING) retained = true;
    if (outcome.startsWith("preserved")) remaining.push(entry);
    else if (outcome === "removed" || outcome.endsWith("deleted the file TAP created")) gone.add(entry.path);
  }
  manifest.entries = remaining;
  manifest.historyPending = true;
  saveManifest(manifest);
  for (const line of leftovers(gone, true)) console.log(line);
  console.log("TAP history locations:\n"+history.filter(existsSync).map(p=>`  ${p}`).join("\n"));
  console.log("Unindexed project history remains in each project’s .tap/ directory.");
  let choice: string = options.history ?? (options.yes ? "keep" : (await ask("Keep, archive, or delete your TAP history? [keep] ")).trim().toLowerCase() || "keep");
  while (!["keep","archive","delete"].includes(choice)) choice = (await ask("Choose keep, archive, or delete: ")).trim().toLowerCase();
  if (choice === "keep") {
    console.log("History kept at the locations above.");
    manifest.historyPending = false; saveManifest(manifest);
  }
  else {
    if (remaining.length) { console.log(`Some installed artifacts were preserved; history kept so their records survive. next: review those artifacts and rerun ${rerun}`); return 2; }
    if (choice === "archive") {
      const archive = join(home(),`tap-history-${new Date().toISOString().replaceAll(":","").replaceAll(".","")}.tar.gz`);
      // Removal happens only after archiveHistory returns: a failed archive
      // or verification leaves every original in place (astra item 6).
      try {
        archiveHistory(archive, history);
      } catch (error) {
        console.error(`${(error as Error).message}`);
        console.error(`Archive verification failed; originals preserved. next: inspect archive and rerun ${rerun}`);
        return 2;
      }
      // The archive is now the only copy: always tell the user where it lives.
      console.log(`Verified history archive: ${archive}`);
      try {
        removeRoots(history);
      } catch (error) {
        // Verification passed and removal failed partway: some roots are
        // already gone, the verified archive is the recovery copy.
        const root = (error as NodeJS.ErrnoException).path ?? `${(error as Error).message}`;
        console.error(`History archive verified at ${archive}; could not remove ${root}. next: inspect archive and rerun ${rerun}`);
        return 2;
      }
    } else for (const path of history) rmSync(path,{recursive:true});
  }
  console.log("Dependencies and unrelated plugins remain installed.");
  console.log(installSourceAdvice(manifest.repo, remaining.length > 0 || retained));
  return 0;
}

const UNINSTALL_USAGE = "Usage: tap uninstall [--dry-run] [--yes] [--history keep|archive|delete]";

export async function cmdUninstall(argv: string[]): Promise<number> {
  const options: UninstallOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--history" || arg.startsWith("--history=")) {
      const value = arg === "--history" ? argv[++i] : arg.slice("--history=".length);
      if (value !== "keep" && value !== "archive" && value !== "delete") { console.error(`tap uninstall: --history takes keep, archive or delete\n${UNINSTALL_USAGE}`); return 2; }
      options.history = value;
    } else if (arg === "--help" || arg === "-h") { console.log(`${UNINSTALL_USAGE}\n${UNINSTALL_HELP}`); return 0; }
    else { console.error(`tap uninstall: unknown argument ${arg}\n${UNINSTALL_USAGE}`); return 2; }
  }
  const noPrompt: Prompt = async question => { throw new Error(`unexpected prompt with --yes: ${question}`); };
  try {
    if (options.dryRun || options.yes) return await uninstallMachine(noPrompt, options);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("tap uninstall: removal needs consent and there is no terminal; next: tap uninstall --dry-run to preview, then tap uninstall --yes [--history keep|archive|delete]");
      return 2;
    }
    return await interact(ask=>uninstallMachine(ask, options));
  } catch (error) { console.error(`tap uninstall: ${error}; next: inspect the preserved manifest and rerun tap uninstall`); return 2; }
}

const UNINSTALL_HELP = `  Removes what the install manifest records: links, hook entries, TAP blocks,
  and files TAP created once only TAP's empty skeleton remains. Edited
  artifacts, dependencies and unrelated plugins stay. Then keeps, archives or deletes
  TAP history, and says how to remove TAP's clone or release files.
  --dry-run            preview every outcome; changes nothing; no terminal needed
  --yes                consent without prompts (history defaults to keep)
  --history <choice>   keep, archive (verified tar.gz in $HOME), or delete
  Without a terminal, --yes or --dry-run is required.
Examples:
  tap uninstall --dry-run
  tap uninstall --yes --history archive`;

if (import.meta.main) {
  const [verb,...argv] = process.argv.slice(2);
  process.exitCode = verb === "setup" ? await cmdSetupMachine(argv) : await cmdUninstall(argv);
}
