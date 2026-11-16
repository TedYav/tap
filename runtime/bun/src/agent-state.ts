import { opencodeShellMode, opencodeTerminalOverprint } from "./opencode-composer";
/*
 * Agent-state rule mechanics and selected rule data are adapted from Herdr
 * 4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c, licensed Apache-2.0.
 *
 * TAP modifications: rewritten in TypeScript; fixed to bundled screen rules
 * and a Codex pane-title working signal; removed remote updates, manifests,
 * and temporal fallback; added TAP harness aliases and fail-closed unknown
 * results. See
 * runtime/bun/third_party/herdr/README.md for provenance.
 */

import { createHash } from "node:crypto";

import { HARNESS_ALIASES } from "./harness-families";
import { codexPlaceholder, readStdinFrame, withoutCodexPaint } from "./terminal-text";

const CODEX_QUEUED_MESSAGES = /(?:^|\n)([•*] Messages to be submitted after next tool call \(press esc to\s+interrupt and send immediately\)\n(?:[ \t]+↳[^\n]*(?:\n[ \t]{4,}[^\n]*)*\n)+)[ \t\n\u2800-\u28ff]*$/;

export type AgentState = "working" | "blocked" | "error" | "idle" | "booting" | "overprint" | "unknown";

export interface AgentStateResult {
  agentState: AgentState;
  reason: string;
}

/** A turn has stopped and its composer is usable; this does not prove empty input. */
export function agentAtRest(state: AgentState): boolean {
  return state === "idle" || state === "error";
}

interface Gate {
  contains?: string[];
  regex?: RegExp[];
  lineRegex?: RegExp[];
  all?: Gate[];
  any?: Gate[];
  not?: Gate[];
}

type Region =
  | { kind: "bottom_non_empty_lines"; count: number }
  | { kind: "last_non_empty_line" }
  | { kind: "claude_live_input" }
  | { kind: "claude_live_footer" }
  | { kind: "claude_error_footer" }
  | { kind: "claude_live_status" }
  | { kind: "claude_live_modal" }
  | { kind: "claude_last_message" }
  | { kind: "codex_live_composer" }
  | { kind: "codex_before_composer" }
  | { kind: "codex_last_message" }
  | { kind: "cursor_live_composer" }
  | { kind: "cursor_live_modal" }
  | { kind: "opencode_live_input" }
  | { kind: "opencode_live_modal" }
  | { kind: "opencode_last_message" }
  | { kind: "agy_live_input" }
  | { kind: "agy_live_modal" }
  | { kind: "hermes_live_input" }
  | { kind: "hermes_live_modal" };

interface Rule extends Gate {
  id: string;
  state: Exclude<AgentState, "unknown">;
  priority: number;
  region: Region;
}

const CLAUDE_PROMPT = /^\s*❯(?:\s| |$)/u;
// `✢ Crystallizing… (8m 57s · ↓ 53.1k tokens)`, or with a phase first:
// `✽ Elucidating… (running PreToolUse hook · 1m 19s · ↓ 5.5k tokens)`. Present
// tense, ellipsis, an elapsed clock as one `·` part of the parenthesis; group 1
// is the clock. The done line is past tense (`✻ Brewed for 42s · done 5:59 AM
// [· N shells still running]`): no ellipsis, no parenthesis, never a match.
export const CLAUDE_SPINNER = /^\s*[·✢✳✶✻✽*]\s+\S[^()]*…\s*\((?:[^()·]*·\s*)*?(\d+[dhms](?:\s*\d+[dhms])*)\s*(?:·|\))/u;

/**
 * The status row above Claude's input band: the nearest row that starts at
 * column 0. The spinner and the done line start there, and so do Claude's
 * transcript rows (`⏺ …`). Every live row Claude paints between the spinner and
 * the band is indented: queued messages (`  ❯ …`), `  ⎿  Tip:` blocks and their
 * continuations, and right-aligned notices (`✔ Update installed`). A row under
 * a full-width row is a wrapped continuation, even at column 0, so it is
 * skipped too.
 */
export function claudeStatusRow(screen: string): string | null {
  const band = bracketedRegion(screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""), CLAUDE_PROMPT);
  if (!band) return null;
  const width = Math.max(0, ...band.input.split("\n").filter(row => /^\s*─{10,}/u.test(row)).map(row => Bun.stringWidth(row.trimEnd())));
  const rows = band.above.split("\n");
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (!row.trim() || /^\s/.test(row)) continue;
    // Raw captures pad blank rows with spaces to the pane width: a
    // whitespace-only row is never content, while a content row keeps its
    // full width (a wrap can end on a real space).
    const prev = rows[i - 1] ?? "";
    if (i > 0 && width > 0 && prev.trim() && Bun.stringWidth(prev) >= width) continue;
    return row;
  }
  return null;
}

type Harness = "claude" | "codex" | "cursor" | "opencode" | "agy" | "hermes";

// Startup dialogs wrap their own text at narrow widths: Codex at 24 columns
// splits its key hint into `enter continue · esc` / `quit`, and Claude at 30
// into `Enter to confirm · Esc to` / `cancel` (tap-rlebf.1). Words may break
// across rows, so these phrases match any whitespace between words; the hint
// still begins its own row and closes the screen, and the dialog may fill a
// taller tail than its 200-column form.
const TRUST_TAIL = 40;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wrapped = (phrase: string): RegExp => new RegExp(phrase.split(" ").map(escapeRegex).join("\\s+"), "i");
const closingHint = (hint: string): RegExp => new RegExp(`(?:^|\\n)[ \\t]*${wrapped(hint).source}\\s*$`, "i");
const tail = (count: number): Region => ({ kind: "bottom_non_empty_lines", count });
const live = (kind: Exclude<Region["kind"], "bottom_non_empty_lines">): Region => ({ kind });

const RULES: Record<Harness, Rule[]> = {
  claude: [
    {
      id: "usage_limit_modal",
      state: "blocked",
      priority: 950,
      region: tail(TRUST_TAIL),
      lineRegex: [/^\s*What do you want to do\?\s*$/],
      regex: [
        new RegExp(`^[ \\t]*(?:❯\\s*)?${wrapped("1. Stop and wait for limit to reset").source}[ \\t]*$`, "im"),
        new RegExp(`^[ \\t]*(?:❯\\s*)?${wrapped("2. Wait here, then continue automatically at").source}\\s+[^\\n]+$`, "im"),
        new RegExp(`^[ \\t]*(?:❯\\s*)?${wrapped("3. Switch to usage credits").source}[ \\t]*$`, "im"),
        closingHint("Enter to confirm · Esc to cancel"),
      ],
    },
    {
      id: "usage_limit",
      state: "error",
      // A resumed turn's live spinner/interrupt hint supersedes this footer.
      priority: 400,
      region: live("claude_error_footer"),
      lineRegex: [/^\s*⚠ Usage limit reached · limit resets\b/],
    },
    {
      id: "usage_limit",
      state: "error",
      priority: 700,
      region: live("claude_last_message"),
      lineRegex: [/^⏺ (?:Usage limit reached(?: again)? ·|Automatic continue cancelled · \/rate-limit-options)/],
    },
    {
      id: "api_error",
      state: "error",
      priority: 700,
      region: live("claude_last_message"),
      lineRegex: [/^⏺ API Error: /],
    },
    {
      // Workspace trust at startup in a new folder (auto mode, tap-3oox6). Its
      // default row is "No, exit". Both choices and the key hint are rows of
      // their own, the hint closes the screen, and no other row carries the
      // composer glyph, so a draft quoting the dialog is not one.
      id: "trust_prompt",
      state: "blocked",
      priority: 950,
      region: tail(TRUST_TAIL),
      lineRegex: [/^\s*(?:❯\s*)?No, exit\s*$/, /^\s*(?:❯\s*)?Yes, I trust this folder\s*$/],
      regex: [wrapped("quick safety check"), closingHint("Enter to confirm · Esc to cancel")],
      not: [{ lineRegex: [/^\s*❯(?!\s*(?:No, exit|Yes, I trust this folder)\s*$)/] }],
    },
    {
      // First-run sign-in: "Select login method:" over numbered
      // account choices, and before it on a fresh config the text-style
      // (theme) picker, which only appears while onboarding — and so sign-in —
      // is unfinished. Neither screen has a composer: a row carrying the
      // composer glyph outside a numbered choice, or the composer's rule
      // border, means the text is a transcript quote, not this screen.
      id: "sign_in",
      state: "blocked",
      priority: 950,
      region: tail(TRUST_TAIL),
      any: [
        { lineRegex: [/^\s*Select login method:\s*$/, /^\s*(?:❯\s*)?1\.\s+Claude account with subscription\b/] },
        { lineRegex: [/^\s*Choose the text style that looks best with your terminal\s*$/, /^\s*To change this later, run \/theme\s*$/] },
      ],
      not: [{ lineRegex: [/^\s*❯(?!\s*(?:\d\.\s|✔\s))/] }, { lineRegex: [/^\s*─{10,}\s*$/] }],
    },
    {
      id: "permission_prompt",
      state: "blocked",
      priority: 900,
      region: live("claude_live_modal"),
      contains: ["do you want to proceed?"],
      all: [{ any: [{ contains: ["yes"] }, { contains: ["no"] }] }],
      not: [{ contains: ["conversation interrupted"] }],
    },
    {
      id: "interrupt_hint_working",
      state: "working",
      priority: 500,
      region: live("claude_live_footer"),
      lineRegex: [/esc to interrupt(?:\s|·|$)/i],
    },
    {
      // Current Claude Code dropped the footer hint above; the live spinner
      // row is the running turn (tap-7txco). The done line never matches.
      id: "spinner_working",
      state: "working",
      priority: 500,
      region: live("claude_live_status"),
      lineRegex: [CLAUDE_SPINNER],
    },
    {
      id: "prompt_idle",
      state: "idle",
      priority: 100,
      region: live("claude_live_input"),
      lineRegex: [/^\s*❯(?:\s| |$)/],
    },
  ],
  codex: [
    {
      id: "codex-update-available",
      state: "blocked",
      priority: 950,
      region: tail(TRUST_TAIL),
      // A narrow picker can show only one choice. The heading, selected
      // update choice and closing key hint establish this startup menu.
      regex: [wrapped("Update available"), closingHint("enter continue · esc skip")],
      lineRegex: [/^\s*›\s*[123]\.\s+(?:Update now\b.*|Skip(?: until next version)?)\s*$/],
      not: [{ lineRegex: [/^\s*›(?!\s*[123]\.\s)/] }],
    },
    {
      id: "usage_limit",
      state: "error",
      priority: 700,
      region: live("codex_last_message"),
      lineRegex: [/^■ You[’']ve hit your usage limit\./],
    },
    {
      id: "model_capacity",
      state: "error",
      priority: 700,
      region: live("codex_last_message"),
      lineRegex: [/^■ Selected model is at capacity\. Please try a different model\./],
    },
    {
      id: "codex-hook-trust",
      state: "blocked",
      priority: 950,
      region: tail(TRUST_TAIL),
      regex: [...["Hooks need review", "Review hooks", "Trust all and continue", "Continue without trusting"].map(wrapped),
        closingHint("enter confirm · esc skip")],
    },
    {
      // Folder trust at startup in a new folder (tap-3oox6). Its default row
      // is "Trust and continue", so Enter would trust the folder. Both choices
      // and the key hint are rows of their own, the hint closes the screen, and
      // no other row carries the composer glyph.
      id: "codex-folder-trust",
      state: "blocked",
      priority: 950,
      region: tail(TRUST_TAIL),
      lineRegex: [/^\s*(?:›\s*)?1\.\s+Trust and continue\s*$/, /^\s*(?:›\s*)?2\.\s+Quit\s*$/],
      regex: [wrapped("Trust this folder?"), closingHint("enter continue · esc quit")],
      not: [{ lineRegex: [/^\s*›(?!\s*\d\.\s)/] }],
    },
    {
      // First-run sign-in. This menu marks its choice with `>`,
      // not the composer's `›`; any `›` row means a live composer, so a
      // transcript quoting the menu is not this screen.
      id: "sign_in",
      state: "blocked",
      priority: 950,
      region: tail(TRUST_TAIL),
      regex: [wrapped("Choose how you want to use Codex."), closingHint("Press enter to continue")],
      lineRegex: [/^\s*(?:>\s*)?1\.\s+Sign in with ChatGPT\s*$/],
      not: [{ lineRegex: [/^\s*›/] }],
    },
    {
      id: "screen_working",
      state: "working",
      priority: 200,
      region: live("codex_before_composer"),
      any: [
        { lineRegex: [/^\s*[•*]\s*Working\b.*esc to interrupt/] },
        { regex: [CODEX_QUEUED_MESSAGES] },
      ],
    },
    {
      id: "live_strong_blocker",
      state: "blocked",
      priority: 900,
      region: live("last_non_empty_line"),
      any: [
        { contains: ["press enter to confirm or esc to cancel"] },
        { contains: ["enter to submit answer"] },
        { contains: ["allow command?"] },
      ],
    },
    {
      id: "weak_blocker",
      state: "blocked",
      priority: 600,
      region: live("last_non_empty_line"),
      any: [
        { contains: ["[y/n]"] },
        { contains: ["yes (y)"] },
      ],
    },
    {
      id: "prompt_idle",
      state: "idle",
      priority: 100,
      region: live("codex_live_composer"),
      lineRegex: [/^\s*[›❯»](?:\s|$)/],
    },
  ],
  cursor: [
    {
      id: "approval_prompt",
      state: "blocked",
      priority: 300,
      region: live("cursor_live_modal"),
      // The run choice keeps its `(y)` key wherever the selection arrow sits;
      // the list ends on `(esc or n)`.
      lineRegex: [/^\s*(?:→\s+)?\S.*\(y\)\s*$/],
    },
    {
      id: "stop_hint_working",
      state: "working",
      priority: 100,
      region: live("cursor_live_composer"),
      contains: ["ctrl+c to stop"],
    },
    {
      id: "prompt_idle",
      state: "idle",
      priority: 50,
      region: live("cursor_live_composer"),
      lineRegex: [/^\s*→\s+(?:Add a follow-up|Plan, search, build anything)\s*$/],
    },
  ],
  opencode: [
    {
      id: "rate_limit",
      state: "error",
      priority: 200,
      region: live("opencode_last_message"),
      regex: [/^Too Many Requests: You've exceeded your subscription rate limits\./],
    },
    {
      id: "permission_required",
      state: "blocked",
      priority: 300,
      region: live("opencode_live_modal"),
      contains: ["permission required"],
      any: [
        { contains: ["enter confirm"] },
        { contains: ["enter submit"] },
        { contains: ["esc dismiss"] },
      ],
    },
    {
      id: "interrupt_hint_working",
      state: "working",
      priority: 110,
      region: live("opencode_live_input"),
      any: [
        { contains: ["esc interrupt"] },
        { contains: ["esc to interrupt"] },
        { regex: [/(?:■|⬝){4,}/] },
      ],
    },
    {
      id: "composer_idle",
      state: "idle",
      priority: 50,
      region: live("opencode_live_input"),
      contains: ["╹▀", "ctrl+p commands"],
      not: [{ contains: ["esc interrupt"] }, { contains: ["esc to interrupt"] }],
    },
  ],
  agy: [
    {
      id: "permission_prompt",
      state: "blocked",
      priority: 300,
      region: live("agy_live_modal"),
      contains: ["requesting permission for:"],
      any: [
        { contains: ["do you want to proceed?"] },
        { contains: ["tab amend"] },
      ],
    },
    {
      id: "trust_prompt",
      state: "blocked",
      priority: 300,
      region: live("agy_live_modal"),
      contains: ["do you trust the contents of this project?", "yes, i trust this folder"],
    },
    {
      id: "generating_working",
      state: "working",
      priority: 100,
      region: live("agy_live_input"),
      any: [{ contains: ["generating"] }, { contains: ["esc to cancel"] }],
    },
    {
      id: "shortcuts_idle",
      state: "idle",
      priority: 50,
      region: live("agy_live_input"),
      contains: ["? for shortcuts"],
      not: [{ contains: ["generating"] }, { contains: ["esc to cancel"] }],
    },
  ],
  hermes: [
    {
      id: "dangerous_command_approval",
      state: "blocked",
      priority: 900,
      region: live("hermes_live_modal"),
      contains: ["dangerous"],
      all: [{
        any: [
          { contains: ["enter to confirm"] },
          { contains: ["allow once"] },
        ],
      }],
    },
    {
      id: "interrupt_status_working",
      state: "working",
      priority: 500,
      region: tail(2),
      any: [{ contains: ["msg=interrupt"] }, { contains: ["ctrl+c cancel"] }],
    },
    {
      // Hermes paints "⚕ ❯" for the whole turn, typed text or not; the hint
      // the rule above reads is gone once a `/queue` wire sits in it.
      id: "working_prompt",
      state: "working",
      priority: 500,
      region: live("hermes_live_input"),
      lineRegex: [/^\s*⚕\s+❯/],
    },
    {
      id: "prompt_idle",
      state: "idle",
      priority: 50,
      region: live("hermes_live_input"),
      lineRegex: [/^\s*(?:[A-Za-z0-9._-]+\s+)?❯\s*$/],
    },
  ],
};

function normalizeHarness(value: string): Harness | null {
  const name = value.split("/").pop()?.toLowerCase() ?? "";
  const alias = Object.hasOwn(HARNESS_ALIASES, name) ? HARNESS_ALIASES[name] : undefined;
  if (alias) return alias;
  for (const harness of Object.keys(RULES) as Harness[]) {
    if (name === harness || name.startsWith(`${harness}-`)) return harness;
  }
  return null;
}

function bottomNonEmptyLines(screen: string, count: number): string {
  const lines = screen.split("\n");
  let remaining = count;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0 && remaining > 0; i--) {
    if (lines[i]!.trim()) {
      start = i;
      remaining--;
    }
  }
  return start === lines.length ? "" : lines.slice(start).join("\n");
}

/** The input band bracketed by rules around a `prompt` row, plus the rows above and below it. */
export function bracketedRegion(screen: string, prompt: RegExp): { above: string; input: string; footer: string } | null {
  const lines = screen.split("\n");
  const isRule = (line: string): boolean => /^\s*─{10,}(?:\s+[^─\n]+\s+─+)?\s*$/u.test(line);
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isRule(lines[i]!)) continue;
    if (bottom < 0) {
      bottom = i;
      continue;
    }
    let first = i + 1;
    while (first < bottom && !lines[first]!.trim()) first++;
    if (first < bottom && prompt.test(lines[first]!)) {
      return { above: lines.slice(0, i).join("\n"), input: lines.slice(i).join("\n"), footer: lines.slice(bottom + 1).join("\n") };
    }
    bottom = i;
  }
  return null;
}

function bracketedInput(screen: string, prompt: RegExp): string {
  return bracketedRegion(screen, prompt)?.input ?? "";
}

function codexLiveComposer(screen: string, ownedComposer = false): string {
  const lines = screen.split("\n");
  const composer = /^\s*[›❯»]/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (!composer.test(line)) continue;
    // A painted placeholder proves empty input. Everything below it is UI,
    // including user-configurable or entirely absent status lines.
    return ownedComposer ? line : codexPlaceholder(lines[i]!) ? "› Ask Codex to do anything" : "";
  }
  return "";
}

function cursorLiveComposer(screen: string): string {
  const lines = screen.split("\n");
  const composer = /^\s*→\s+(?:Add a follow-up|Plan, search, build anything)(?:\s+ctrl\+c to stop)?\s*$/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (composer.test(lines[i]!)) return lines.slice(i).join("\n");
  }
  return "";
}

function opencodeLiveInput(screen: string): string {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    if (/^\s*╹▀/u.test(lines[i]!) && /^\s*┃/u.test(lines[i - 1]!)) {
      return lines.slice(i).join("\n");
    }
  }
  return "";
}

/** The last response, never the current draft or an earlier turn's error. */
function lastMessage(screen: string, harness: "claude" | "codex"): string {
  let above: string;
  if (harness === "claude") {
    const band = bracketedRegion(screen, CLAUDE_PROMPT);
    if (band && /esc to interrupt(?:\s|·|$)/i.test(band.footer)) return "";
    above = band?.above ?? screen;
  } else {
    const rows = screen.split("\n");
    const composer = rows.findLastIndex(row => /^[›❯»]/.test(row));
    above = withoutCodexPaint(rows.slice(0, composer < 0 ? rows.length : composer).join("\n"));
  }
  const rows = above.split("\n");
  const marker = harness === "claude" ? /^(?:⏺|❯)(?:\s|$)/ : /^(?:■|[•*]|[›❯»])(?:\s|$)/;
  const start = rows.findLastIndex(row => marker.test(row));
  if (start < 0) return "";
  const message = rows.slice(start).join("\n");
  // A new running turn supersedes the completed response, even without new prose.
  if (harness === "claude" && rows.slice(start + 1).some(row => CLAUDE_SPINNER.test(row))) return "";
  return message;
}

/** OpenCode's last error block, above the separate input box and model row. */
function opencodeLastMessage(screen: string): string {
  const rows = screen.split("\n");
  const bottom = rows.findLastIndex(row => /^\s*╹▀/.test(row));
  let start = bottom < 0 ? rows.length : bottom;
  if (bottom >= 0) while (start > 0 && /^\s*┃/.test(rows[start - 1]!)) start--;
  let end = start;
  while (end > 0 && (!rows[end - 1]!.trim() || /^\s*▣\s/.test(rows[end - 1]!))) end--;
  let message = end;
  while (message > 0 && /^\s*┃/.test(rows[message - 1]!)) message--;
  return rows.slice(message, end).map(row => row.replace(/^\s*┃\s?\s?/, "").trimEnd()).join("\n").trim();
}

/** An error releases input only when this frame proves the harness's composer. */
function errorComposer(harness: Harness, screen: string, ownedCodexComposer: boolean): boolean {
  const plain = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (harness === "claude") return bracketedRegion(plain, CLAUDE_PROMPT) !== null;
  if (harness === "codex") return codexLiveComposer(screen, ownedCodexComposer) !== "";
  if (harness === "opencode") return opencodeLiveInput(plain) !== "";
  return false;
}

function modalWithoutInput(screen: string, input: string, footer: RegExp, lines: number = 6, footerRows: number = 1): string {
  if (input) return "";
  return footer.test(bottomNonEmptyLines(screen, footerRows)) ? bottomNonEmptyLines(screen, lines) : "";
}

function regionText(screen: string, region: Region, ownedCodexComposer = false): string {
  const raw = screen;
  screen = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  switch (region.kind) {
    case "bottom_non_empty_lines":
      return bottomNonEmptyLines(screen, region.count);
    case "last_non_empty_line":
      return bottomNonEmptyLines(screen, 1);
    case "claude_live_input":
      return bracketedInput(screen, /^\s*❯(?:\s| |$)/u);
    case "claude_live_status":
      return claudeStatusRow(screen) ?? "";
    case "claude_last_message":
      return lastMessage(screen, "claude");
    case "claude_error_footer":
      return bracketedRegion(screen, CLAUDE_PROMPT)?.footer ?? "";
    case "claude_live_footer": {
      const band = bracketedRegion(screen, /^\s*❯(?:\s| |$)/u);
      // Draft text is not a working hint; wrapped footer chrome may occupy three rows.
      return bottomNonEmptyLines(band ? band.footer : screen, 3);
    }
    case "claude_live_modal": {
      const footer = /esc to cancel.*tab to amend/i;
      const rows = screen.trimEnd().split("\n");
      let lastFooter = -1;
      for (let i = rows.length - 1; i >= 0; i--) if (footer.test(rows[i]!)) { lastFooter = i; break; }
      const tail = rows.slice(lastFooter + 1).filter(row => row.trim());
      const width = Math.max(0, ...rows.filter(row => /^\s*─{10,}\s*$/.test(row)).map(row => row.trim().length));
      let queued = lastFooter >= 0 && tail.length > 0;
      for (let i = 0; i < tail.length; i++) {
        const row = tail[i]!;
        if (/^\s*❯\s+\S/.test(row)) continue;
        // An unindented continuation must follow a full-width physical row;
        // otherwise arbitrary output after an old prompt is not a queue.
        if (i === 0 || /[❯›─]/.test(row) || !(width > 0 && tail[i - 1]!.length >= width)) queued = false;
      }
      const modal = queued ? rows.slice(0, lastFooter + 1).join("\n") : screen;
      return modalWithoutInput(modal, bracketedInput(modal, /^\s*❯(?:\s| |$)/u), footer, 15);
    }
    case "codex_live_composer":
      return codexLiveComposer(raw, ownedCodexComposer);
    case "codex_last_message":
      return lastMessage(screen, "codex");
    case "codex_before_composer": {
      if (!codexLiveComposer(raw, ownedCodexComposer)) return "";
      const rows = screen.split("\n");
      const start = rows.findLastIndex(row => /^\s*[›❯»]/.test(row));
      // The painted hint establishes a live composer; quoted draft rows cannot.
      if (start < 0) return "";
      // Paint above the composer is chrome (tap-8nmot): strip it before the
      // queue/region readers, exactly as CODEX_QUEUED_MESSAGES already
      // tolerates paint in its tail class.
      const before = withoutCodexPaint(rows.slice(0, start).join("\n"));
      // A wrapped queue may hide the working row. Require the queue block to
      // reach this composer, with only animation/blank padding after its items.
      const queue = before.match(CODEX_QUEUED_MESSAGES);
      return queue?.[1] ?? bottomNonEmptyLines(before, 4);
    }
    case "cursor_live_composer":
      return cursorLiveComposer(screen);
    case "cursor_live_modal":
      return modalWithoutInput(screen, cursorLiveComposer(screen), /\(esc or n\)\s*$/i, 8);
    case "opencode_live_input":
      return opencodeLiveInput(screen);
    case "opencode_last_message":
      return /esc (?:to )?interrupt|(?:■|⬝){4,}/.test(opencodeLiveInput(screen)) ? "" : opencodeLastMessage(screen);
    case "opencode_live_modal":
      return modalWithoutInput(
        screen,
        opencodeLiveInput(screen),
        /enter (?:confirm|submit)|esc dismiss/i,
        // 1.18 paints a bare `┃` gutter row below the key hints.
        12,
        2,
      );
    case "agy_live_input":
      return bracketedInput(screen, /^\s*>/);
    case "agy_live_modal":
      // 1.2.9's dialog footer is `↑/↓ Navigate · tab Amend …` above `esc to
      // cancel`; only the live dialog paints that key-hint pair, so it needs no
      // band test (a transcript echo of the turn reads as a band). Three rows
      // allow the hint line to wrap on a narrow pane.
      // 1.2.14's workspace-trust dialog (auto mode, untrusted folder) ends
      // `↑/↓ Navigate · enter Confirm` above the model row (tap-3oox6). The hint
      // must open its row and nothing of a live composer (its border, the
      // shortcuts cue) may follow it, so a draft quoting it does not count.
      {
        const foot = bottomNonEmptyLines(screen, 3).split("\n");
        const hint = foot.findIndex(row => /^\s*↑\/↓ navigate\s*·\s*(?:tab amend|enter confirm)/i.test(row));
        if (hint >= 0 && !foot.slice(hint + 1).some(row => /^\s*─{10,}\s*$|\? for shortcuts/.test(row))) return bottomNonEmptyLines(screen, 12);
      }
      return modalWithoutInput(screen, bracketedInput(screen, /^\s*>/), /tab amend/i);
    case "hermes_live_input":
      // The working "⚕ ❯" composer is a live input too (tap-rhajr); the modal
      // region below keeps the at-rest shape, so a modal is never masked by it.
      return bracketedInput(screen, /^\s*(?:[A-Za-z0-9._-]+\s+|⚕\s+)?❯(?:\s|$)/);
    case "hermes_live_modal":
      return modalWithoutInput(
        screen,
        bracketedInput(screen, /^\s*(?:[A-Za-z0-9._-]+\s+)?❯(?:\s|$)/),
        /enter to confirm|allow once/i,
      );
  }
}

function gateMatches(gate: Gate, text: string): boolean {
  const lower = text.toLowerCase();
  if (!(gate.contains ?? []).every((needle) => lower.includes(needle.toLowerCase()))) return false;
  if (!(gate.regex ?? []).every((regex) => regex.test(text))) return false;
  if (!(gate.lineRegex ?? []).every((regex) => text.split("\n").some((line) => regex.test(line)))) {
    return false;
  }
  if (!(gate.all ?? []).every((nested) => gateMatches(nested, text))) return false;
  if ((gate.any?.length ?? 0) > 0 && !gate.any!.some((nested) => gateMatches(nested, text))) {
    return false;
  }
  if ((gate.not ?? []).some((nested) => gateMatches(nested, text))) return false;
  return true;
}

/** ownedCodexComposer requires the caller to prove its exact staged input on this same frame. */
export function detectAgentState(harnessName: string, screen: string, paneTitle = "", ownedCodexComposer = false): AgentStateResult {
  const harness = normalizeHarness(harnessName);
  if (!harness) return { agentState: "unknown", reason: "unrecognized_harness" };

  if (harness === "opencode" && opencodeShellMode(screen)) return { agentState: "blocked", reason: "shell_mode" };
  let matched: Rule | null = null;
  for (const rule of RULES[harness]) {
    if (!gateMatches(rule, regionText(screen, rule.region, ownedCodexComposer))) continue;
    // Error text never establishes a modal. Without composer proof, retain
    // the existing unknown/booting answer and exact-staged-input safeguards.
    if (rule.state === "error" && !errorComposer(harness, screen, ownedCodexComposer)) continue;
    if (!matched || rule.priority > matched.priority) matched = rule;
  }
  // A modal or terminal error outranks a title left spinning by the failed turn.
  if (harness === "codex" && matched?.state !== "blocked" && matched?.state !== "error" && /^[\u2800-\u28ff]/u.test(paneTitle)) {
    return { agentState: "working", reason: "title_working" };
  }
  if (matched) return { agentState: matched.state, reason: matched.id };
  // agy hides its `? for shortcuts` idle cue while the composer holds text.
  // Our own wire there is named, never idle: idle licenses control injection.
  if (harness === "agy" && /^\s*>\s*\[\[TAP\s/m.test(regionText(screen, live("agy_live_input")))) {
    return { agentState: "unknown", reason: "sentinel_unsubmitted" };
  }
  if (harness === "opencode" && !opencodeLiveInput(screen)) {
    // tap-cl1es: name the cause. A booting pane whose screen carries the
    // claude-mem-style overprint is not starting up — the debris split the
    // composer's geometry. The roster says so instead of the generic booting.
    if (opencodeTerminalOverprint(screen)) return { agentState: "overprint", reason: "terminal_overprint" };
    return { agentState: "booting", reason: "input_band_absent" };
  }
  return { agentState: "unknown", reason: "no_matching_rule" };
}


// Bash activity observers reuse the roster reader; this is not input safety.
if (import.meta.main) {
  if (process.argv[2] !== "claude-seat-state") process.exit(2);
  console.log(detectAgentState("claude", await readStdinFrame()).agentState);
}

/** Human approval is a deliberate stop even when the harness process is healthy. */
export function approvalPrompt(harness: string, screen: string): boolean {
  // Claude/Codex keep their historical prefix match; the rest use normalizeHarness.
  const name = harness.startsWith("claude") ? "claude" : harness.startsWith("codex") ? "codex" : harness;
  return detectAgentState(name, screen).agentState === "blocked";
}

/**
 * A positively classified tool-approval request: the narrow subset of
 * `approvalPrompt` that the approval timeout may act on (tap-rlebf.2).
 * Trust dialogs, question prompts, `[y/n]` lines and shell mode are blocked
 * but never requests. `denyLabel` is true only when this same frame labels
 * the harness's mapped deny control (Escape) as deny or cancel; OpenCode
 * paints no such label and Hermes has no real capture, so both stay false.
 */
export interface ApprovalRequest {
  harness: Harness;
  rule: string;
  fingerprint: string;
  excerpt: string;
  denyLabel: boolean;
}

interface RequestShape {
  rule: string;
  /** The request's discriminator rows, or null when the frame lacks the shape. */
  rows(lines: string[]): { rows: string[]; after: string[] } | null;
  denyLabel(after: string[]): boolean;
}

const RULE_ROW = /^\s*─{10,}\s*$/u;
const lastIndex = (lines: string[], pattern: RegExp): number => lines.findLastIndex(line => pattern.test(line));

/** Rows strictly between the nearest `stop` row above `anchor` and the anchor. */
function rowsAbove(lines: string[], anchor: number, stop: RegExp, limit = 30): string[] | null {
  for (let i = anchor - 1; i >= Math.max(0, anchor - limit); i--) {
    if (stop.test(lines[i]!)) return lines.slice(i + 1, anchor);
  }
  return null;
}

const REQUEST_SHAPES: Partial<Record<Harness, RequestShape>> = {
  claude: {
    rule: "permission_prompt",
    rows(lines) {
      const ask = lastIndex(lines, /^\s*Do you want to proceed\?\s*$/);
      if (ask < 0) return null;
      const after = lines.slice(ask + 1);
      if (!after.some(row => /^\s*(?:❯\s*)?\d+\.\s+No\s*$/.test(row))) return null;
      const body = rowsAbove(lines, ask, RULE_ROW);
      if (!body) return null;
      // The rotating "Tip:" block is chrome, not the request.
      const rows: string[] = [];
      let tipIndent = -1;
      for (const row of body) {
        const indent = row.length - row.trimStart().length;
        if (/^\s*Tip:/.test(row)) { tipIndent = indent; continue; }
        if (tipIndent >= 0 && indent === tipIndent && rows.length > 0) continue;
        tipIndent = -1;
        rows.push(row);
      }
      return { rows, after };
    },
    denyLabel: after => after.some(row => /^\s*Esc to cancel\b/i.test(row)),
  },
  codex: {
    rule: "live_strong_blocker",
    rows(lines) {
      if (!/press enter to confirm or esc to cancel/i.test(lines.at(-1) ?? "")) return null;
      const first = lastIndex(lines, /^\s*(?:›\s*)?1\.\s+Yes\b/);
      if (first < 0) return null;
      // Up to and including the transcript item that raised the request.
      for (let i = first - 1; i >= Math.max(0, first - 30); i--) {
        if (/^\s*›/.test(lines[i]!)) return { rows: lines.slice(i + 1, first), after: lines.slice(first) };
        if (/^\s*[•⚠]\s/.test(lines[i]!)) return { rows: lines.slice(i, first), after: lines.slice(first) };
      }
      return null;
    },
    denyLabel: after =>
      after.some(row => /^\s*(?:›\s*)?\d+\.\s+No\b.*\(esc\)\s*$/i.test(row)) && /esc to cancel/i.test(after.at(-1) ?? ""),
  },
  cursor: {
    rule: "approval_prompt",
    rows(lines) {
      const ask = lastIndex(lines, /^\s*Run this command\?\s*$/);
      if (ask < 0) return null;
      const rows = rowsAbove(lines, ask, RULE_ROW, 12);
      return rows ? { rows, after: lines.slice(ask + 1) } : null;
    },
    denyLabel: after => after.some(row => /^\s*(?:→\s+)?Skip\b.*\(esc or n\)\s*$/i.test(row)),
  },
  opencode: {
    rule: "permission_required",
    rows(lines) {
      const gutter = lines.map(row => row.replace(/^\s*┃/u, ""));
      const ask = lastIndex(gutter, /^\s*△\s+Permission required\s*$/);
      if (ask < 0) return null;
      const options = gutter.findIndex((row, i) => i > ask && /^\s*Allow once\s+Allow always\s+Reject\b/.test(row));
      if (options < 0) return null;
      return { rows: gutter.slice(ask + 1, options), after: gutter.slice(options) };
    },
    denyLabel: () => false,
  },
  agy: {
    rule: "permission_prompt",
    rows(lines) {
      const ask = lastIndex(lines, /^\s*Requesting permission for:\s*$/);
      if (ask < 0) return null;
      const first = lines.findIndex((row, i) => i > ask && /^\s*(?:>\s*)?1\.\s/.test(row));
      if (first < 0) return null;
      const after = lines.slice(first);
      if (!after.some(row => /^\s*(?:>\s*)?\d+\.\s+No, cancel\s*$/.test(row))) return null;
      return { rows: lines.slice(ask + 1, first), after };
    },
    denyLabel: after => after.some(row => /^\s*esc to cancel\b/i.test(row)),
  },
  hermes: {
    // Synthetic shape only (no real capture yet): never attests a deny label.
    rule: "dangerous_command_approval",
    rows(lines) {
      const ask = lastIndex(lines, /dangerous/i);
      return ask < 0 ? null : { rows: lines.slice(ask, lines.length - 1), after: lines.slice(ask + 1) };
    },
    denyLabel: () => false,
  },
};

const normalizeRow = (row: string): string => row.replace(/^\s*[❯›→>]\s+/u, "").replace(/\s+/g, " ").trim();

export function approvalRequest(harnessName: string, screen: string): ApprovalRequest | null {
  const harness = normalizeHarness(harnessName.startsWith("claude") ? "claude" : harnessName.startsWith("codex") ? "codex" : harnessName);
  if (!harness) return null;
  const shape = REQUEST_SHAPES[harness];
  if (!shape || detectAgentState(harness, screen).reason !== shape.rule) return null;
  const lines = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").filter(row => row.trim());
  const found = shape.rows(lines);
  if (!found) return null;
  const rows = found.rows.map(normalizeRow).filter(Boolean);
  if (rows.length === 0) return null;
  const command = rows.find(row => row.startsWith("$ "));
  const excerpt = (command ?? rows.join(" · ")).slice(0, 200);
  const fingerprint = createHash("sha256").update([harness, shape.rule, ...rows].join("\n")).digest("hex");
  return { harness, rule: shape.rule, fingerprint, excerpt, denyLabel: shape.denyLabel(found.after) };
}

/** Named diagnostic shared by launch, delivery and queue receipts; never an approval grant. */
export const CODEX_HOOK_TRUST_REASON = "codex-hook-trust: Hooks need review; no keys sent. The leader may skip or decline the dialog, then notify the operator: hooks were not trusted; TAP's shell-body guard and SessionStart hooks will not run in this seat until you trust them via Codex's hook review";
export function codexHookTrust(harness: string, screen: string): boolean {
  return detectAgentState(harness, screen).reason === "codex-hook-trust";
}
