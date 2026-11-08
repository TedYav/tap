import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolveContext, TapError } from "../context";
import { draftEntries, inputBackupBody, inputBackupIncomplete, INCOMPLETE_DRAFT_NOTICE } from "../input-backup";
import { validToken } from "../ids";

interface DraftIO {
  tty: boolean;
  out(text: string): void;
  err(text: string): void;
  ask(): Promise<string>;
  copy(text: string): boolean;
}
function options(argv: string[]) {
  let list = argv[0] === "list", indexOnly = false, id = "", count = 5, hasCount = false;
  for (let i = list ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--list") { list = true; indexOnly = true; }
    else if (arg === "-n") {
      const value = argv[++i] ?? "";
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new TapError(1, "usage_error", "tap help draft", "-n requires a positive integer");
      count = Number(value); hasCount = true;
    }
    else if (arg === "--" && i === argv.length - 1) break;
    else if (arg.startsWith("-") || id || !validToken(arg)) throw new TapError(1, "usage_error", "tap help draft", `unexpected argument '${arg}'`);
    else id = arg;
  }
  if (list && id) throw new TapError(1, "usage_error", "tap help draft", "list cannot be combined with a backup id");
  if (hasCount && !list) throw new TapError(1, "usage_error", "tap draft list -n <count>", "-n requires list");
  return { list, indexOnly, id, count };
}
const display = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export async function recoverDraft(argv: string[], directory: string, io: DraftIO): Promise<number> {
  const { list, indexOnly, id, count } = options(argv);
  const entries = draftEntries(directory).flatMap(entry => {
    try {
      const raw = readFileSync(entry.path, "utf8");
      return [{ ...entry, id: basename(entry.path.toString(), ".md"), body: inputBackupBody(raw), incomplete: inputBackupIncomplete(raw) }];
    } catch {
      io.err(`tap draft: skipping unreadable or invalid backup ${display(basename(entry.path.toString()))}\n`);
      return [];
    }
  });
  if (!entries.length) {
    if (id) throw new TapError(2, "no_draft", "tap draft list", `no backed-up draft for '${id}' on this team`);
    io.out("tap draft: no drafts backed up on this team\n");
    return 0;
  }
  const visible = entries.slice(0, count);
  const rows = list ? visible.map((e, i) => `${i + 1}. ${display(e.created.toString())}  ${display(e.handle.toString())}  ${display(e.id)}${e.incomplete ? "  [incomplete]" : ""}\n${e.body.split("\n").map(line => `   ${display(line)}`).join("\n")}\n`).join("\n") : "";
  if (list && (indexOnly || !io.tty)) {
    io.out(rows);
    return 0;
  }
  let selected = entries[0]!;
  if (id) {
    const exact = entries.find(e => e.id === id);
    const matches = exact ? [exact] : entries.filter(e => e.payload.equals(Buffer.from(id)));
    if (matches.length > 1) throw new TapError(1, "ambiguous_draft", "tap draft list", `multiple backups for '${id}'; select a full backup id`);
    const match = matches[0];
    if (!match) throw new TapError(2, "no_draft", "tap draft list", `no backed-up draft for '${id}' on this team`);
    selected = match;
  } else if (list) {
    io.err(rows);
    const answer = (await io.ask()).trim();
    if (!answer || answer.toLowerCase() === "q") return 0;
    if (!/^[1-9][0-9]*$/.test(answer) || Number(answer) > visible.length) {
      io.err("tap draft: invalid selection; nothing copied\n"); return 1;
    }
    selected = visible[Number(answer) - 1]!;
  }
  if (selected.incomplete) {
    io.err(`${INCOMPLETE_DRAFT_NOTICE}; clipboard unchanged\n`);
    io.out(selected.body);
    return 2;
  }
  if (!io.copy(selected.body)) io.err("tap draft: clipboard unavailable; printed draft only\n");
  else if (io.tty) io.err("tap draft: copied to clipboard\n");
  io.out(selected.body);
  return 0;
}

export async function cmdDraft(argv: string[]): Promise<number> {
  options(argv);
  const ctx = resolveContext();
  return recoverDraft(argv, join(ctx.bus.home, "input-backups"), {
    tty: !!process.stdin.isTTY,
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
    ask: async () => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      // A dead terminal (pty closed) ends the question as an empty answer —
      // the same cancel Ctrl-D produces — instead of parking it forever.
      let detach: () => void = () => {};
      const gone = new Promise<string>(resolve => {
        const end = () => resolve("");
        prompt.once("close", end);
        process.stdin.once("error", end);
        detach = () => process.stdin.off("error", end);
      });
      try { return await Promise.race([prompt.question("Copy draft number (Enter/q cancels): "), gone]); }
      finally { detach(); prompt.close(); }
    },
    copy: text => spawnSync("pbcopy", [], { input: text }).status === 0,
  });
}
