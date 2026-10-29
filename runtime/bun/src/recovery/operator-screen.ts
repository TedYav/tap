import { detectAgentState } from "../agent-state";
import { classifyPane } from "../pane-state";

export interface OperatorSurface { kind: "menu" | "composer" | "draft" | "protected" | "unknown"; modal?: string; selected?: string; footer?: string; escapeOnly?: boolean }
const plain = (text: string) => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const inner = (line: string) => plain(line).trim().replace(/^[│┃]\s?/, "").replace(/\s?[│┃]$/, "").trim();
const escapeHint = /\besc(?:ape)?\s+(?:to\s+)?(?:go\s+)?(?:cancel|close|back|dismiss)\b/i;
const quitHint = /\bq\s+(?:to\s+)?(?:quit|back|close)\b/i;
const protectedPrompt = /\b(?:permission required|requesting permission|approval mode|do you want to proceed|trust (?:this|the) (?:folder|directory|workspace)|sign in|log in|login|authenticate|install(?:ation)? (?:update|required|now)|update available|authorize access)\b/i;

function unboxedMenu(harness: string, rows: string[]): OperatorSurface | null {
  const lines = rows.map(plain);
  const start = lines.findLastIndex(line => /^\s*(?:Settings|Keymap|Select Model(?: and Effort)?|Help|Commands|Themes)\s*$/i.test(line));
  if (start < 0) return null;
  const body = lines.slice(start), tail = body.at(-1)?.trim() ?? "";
  const footer = escapeHint.test(tail) ? tail : /^(?:back|cancel|close|dismiss)$/i.test(tail) ? body.slice(-2).join(" ").trim() : "";
  if (!escapeHint.test(footer) || protectedPrompt.test(body.join("\n"))) return null;
  // A Codex list cursor is flush left. A draft begins with the cursor on its
  // first text row, not on a selected item beneath this unprefixed title.
  if (harness.startsWith("codex") && !body.slice(1, -1).some(line => /^[›❯]\s+\S/.test(line))) return null;
  return { kind: "menu", modal: body.join("\n"), footer, escapeOnly: true };
}

/** Current viewport only. The terminal's last closed box owns a menu; history and worker-provided ranges do not. */
export function operatorSurface(harness: string, frame: string): OperatorSurface {
  if (!/^(claude|codex|opencode)(?:-|$)/.test(harness)) return { kind: "unknown" };
  if (detectAgentState(harness, frame).agentState === "blocked") return { kind: "protected" };
  const rows = frame.trimEnd().split("\n"), last = rows.length - 1;
  const unboxed = unboxedMenu(harness, rows);
  // Codex's generic input reader also sees the list's `›` as draft text.
  // Its exact unboxed title/list/closing-footer shape owns only Escape here.
  if (harness.startsWith("codex") && unboxed) return unboxed;
  const pane = classifyPane(frame, harness, false);
  if (pane.kind === "ready") return { kind: "composer" };
  if (pane.kind === "draft" || pane.kind === "queued") return { kind: "draft" };
  if (unboxed) return unboxed;
  if (!/^\s*[╰└]─{5,}[╯┘]\s*$/.test(plain(rows[last] ?? ""))) return { kind: "unknown" };
  let start = -1;
  for (let i = last - 1; i >= 0; i--) {
    if (/^\s*[╭┌]─{5,}[╮┐]\s*$/.test(plain(rows[i]!))) { start = i; break; }
    if (/^\s*[╰└]─{5,}[╯┘]\s*$/.test(plain(rows[i]!))) return { kind: "unknown" };
  }
  if (start < 0) return { kind: "unknown" };
  const body = rows.slice(start + 1, last), lines = body.map(inner), modal = lines.join("\n");
  if (protectedPrompt.test(modal)) return { kind: "protected" };
  const footer = lines.findLast(line => line !== "") ?? "";
  if (!escapeHint.test(footer)) return { kind: "unknown" };
  const selections: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const glyph = /^[❯›→>]\s+(.*)$/.exec(lines[i]!);
    const inverse = /\x1b\[(?:\d+;)*7(?:;\d+)*m([^\x1b]+)\x1b\[(?:0|27)m/.exec(body[i]!);
    if (glyph) selections.push(glyph[1]!.replace(/^\d+[.)]\s+/, "").trim());
    else if (inverse) selections.push(inner(inverse[1]!));
  }
  return { kind: "menu", modal, footer, ...(selections.length === 1 ? { selected: selections[0] } : {}) };
}

export function operatorKeyRefusal(harness: string, frame: string, key: string): string {
  if (!["Escape", "q", "Enter"].includes(key)) return "operator key is outside the navigation vocabulary; movement has no proven screen contract";
  const surface = operatorSurface(harness, frame);
  if (surface.kind !== "menu") return `operator navigation stops at ${surface.kind}`;
  if (key === "Escape") return "";
  if (/\b(?:search|filter|type(?: here| to))\b/i.test(surface.modal ?? "")) return "a search or filter field permits only its explicit cancel key";
  if (surface.escapeOnly) return "this unboxed screen authorizes only its explicit close key";
  if (key === "q") return quitHint.test(surface.footer!) ? "" : "no live modal q-to-close binding";
  return surface.selected && /^(?:Close|Cancel|Back)(?:\s+[([](?:Enter|Return)[)\]])?$/i.test(surface.selected)
    ? "" : "Enter requires exactly one selected Close, Cancel or Back row";
}
