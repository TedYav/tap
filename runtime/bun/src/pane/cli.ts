#!/usr/bin/env bun
/**
 * The pane reader's ONE door for Bash callers.
 *
 * Every verdict travels as a TOKEN and, where there is content, a `\x1f` and
 * the bytes — never as an exit status carrying meaning on its own. An exit
 * status cannot distinguish "the answer is no" from "the module failed to
 * load", and this family's answers gate typing into someone's terminal, so the
 * adapters select on the token and refuse anything they do not recognize
 * (charter rule 19: infrastructure failure never maps to predicate-false).
 *
 * The adapter, not this file, maps a token to the incumbent's exit code. That
 * keeps the incumbent's rc ladder written down exactly once, in the shell where
 * its callers read it.
 */
import { readFileSync } from "node:fs";
import { readStdinFrame } from "../terminal-text";
import { stripAnsi } from "./geometry";
import {
  captureInputFrame, escapedInputLine, escapedPromptFromFrame, hasControlCharacter,
  inputHasInjectedContent, inputHasMatch, inputHasPasteCollapse, inputLine,
  inputRegion, inputRegionHasContinuation, inputStateFromRegion, paneAlertState,
  frameIo, framePairIo, pendingInputProbe, realPaneIo, type PaneIo,
} from "./reader";
import { dimPromptInput, textHasPasteCollapse } from "./geometry";
import { inputHash, writeInputBackup } from "./draft";
import { clearOwnInjection, clobberBand, DARK_EFFECTS } from "../deliver";
import type { BoundRecipient } from "../courier";

const US = "\x1f";
const out = (s: string): void => { process.stdout.write(s); };

const stdin = readStdinFrame;

/**
 * Verbs that read a pane take their frame from stdin and their width from a
 * trailing argv slot: the ADAPTER captures, this door decides. Verbs that act on
 * a pane (the draft restore and the notice) keep the real io, because an effect
 * cannot be replayed from a frame.
 */
/**
 * Parse a length-prefixed capture pair: "<bytes-of-escaped>\n<escaped><plain>".
 *
 * SPLIT ON BYTES, NOT CHARACTERS. The header is `wc -c`, a BYTE count, and an
 * earlier version sliced a decoded string — whose indices are UTF-16 code units.
 * The prompt glyph alone is three bytes, so the halves were silently mis-split.
 * Decode each half only after the byte slice.
 *
 * REFUSES rather than guessing. A frame that is not length-prefixed is not
 * quietly treated as an escaped capture with a missing plain view: the caller
 * declares its mode (see `--frame`), because manufacturing a plain view from
 * escaped bytes is the defect this protocol exists to remove.
 */
function pairFromBytes(bytes: Uint8Array, width: string): PaneIo {
  const nl = bytes.indexOf(0x0a);
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  const n = nl < 0 ? NaN : Number(dec.decode(bytes.subarray(0, nl)));
  if (nl < 0 || !Number.isInteger(n) || n < 0 || nl + 1 + n > bytes.length) {
    throw new Error("pane/cli: frame verbs require a length-prefixed capture pair");
  }
  return framePairIo(
    dec.decode(bytes.subarray(nl + 1, nl + 1 + n)),
    dec.decode(bytes.subarray(nl + 1 + n)),
    width,
  );
}

async function main(): Promise<number> {
  const a = process.argv;
  const verb = a[2] ?? "";
  const FRAME_VERBS = new Set(["inputline", "inputregion", "escaped-inputline", "continuation", "has-match", "has-paste-collapse",
    "has-injected", "probe"]);
  // The adapter hands over BOTH captures the incumbent took, length-prefixed so
  // the split is binary-safe: "<bytes-of-escaped>\n<escaped><plain>". A pane can
  // contain any control byte, so a sentinel separator would not be safe here.
  // Legacy single-frame input (no header) is refused rather than derived.
  // TWO INPUT MODES, DECLARED BY THE CALLER, never inferred from the bytes.
  //
  // `--frame`: the caller supplies ONE escaped frame it already holds, which is
  // all the incumbent had in that mode too (`tap_slice_delivery_disposition`
  // captures once and hands it to the hermes arm). So this mode derives, exactly
  // as the incumbent did, and `frameIo` is its reader — not a fixture-only
  // helper. Reading this mode as a pair is what broke the live hermes
  // disposition path at 90131fbc6: it answered `unobservable`/`inject` where the
  // incumbent answered `draft`/`park` (review).
  //
  // Otherwise: the adapter captured BOTH views and hands them over together.
  const width = process.env.TAP_PANE_WIDTH ?? "";
  const suppliedFrame = a.includes("--frame");
  const io = !FRAME_VERBS.has(verb) ? realPaneIo
    : suppliedFrame ? frameIo(await stdin(), width)
    : pairFromBytes(await Bun.stdin.bytes(), width);

  switch (verb) {
    case "inputline": {
      const v = inputLine(io, a[3]!, a[4]!);
      if (!v.ok) { out("no-band"); return 0; }
      out(`text${US}${v.line}`);
      return 0;
    }
    case "inputregion": {
      // A TOKEN, not an exit status. `tap_bun_call` collapses every non-zero
      // exit to 1 and prints `slice_failed`, so a verdict spelled as an exit
      // code would arrive at the adapter indistinguishable from the module
      // failing to load — the exact confusion rule 19 forbids.
      const v = inputRegion(io, a[3]!, a[4]!);
      out(v.status === "no-band" ? "no-band" : `text${US}${v.region}`);
      return 0;
    }
    case "escaped-inputline": out(escapedInputLine(io, a[3]!, a[4]!)); return 0;
    case "escaped-prompt": out(escapedPromptFromFrame(await stdin(), a[3] ?? "")); return 0;
    case "capture-frame": {
      const c = captureInputFrame(io, a[3]!, a[4]!, a[5] === "1");
      if (!c.ok) return 1;
      out(c.frame);
      return 0;
    }
    case "continuation": out(inputRegionHasContinuation(io, a[3]!, a[4]!) ? "yes" : "no"); return 0;
    case "has-match": {
      const mode = a[6] === "exact" ? "exact" : a[6] === "id" ? "id" : null;
      if (mode === null) { out("no"); return 0; }
      out(inputHasMatch(io, a[3]!, a[4]!, a[5]!, mode) ? "yes" : "no");
      return 0;
    }
    case "has-paste-collapse": out(inputHasPasteCollapse(io, a[3]!, a[4]!) ? "yes" : "no"); return 0;
    case "has-injected": {
      const mode = a[7] === "exact" ? "exact" : "id";
      out(inputHasInjectedContent(io, a[3]!, a[4]!, a[5]!, a[6] === "1", mode) ? "yes" : "no");
      return 0;
    }
    case "text-paste-collapse": out(textHasPasteCollapse(a[3] ?? "", a[4] ?? "") ? "yes" : "no"); return 0;
    case "dim-prompt":
      out(dimPromptInput(a[3] ?? "", await stdin(), a[4] ?? "", a[5] ?? "") ? "yes" : "no");
      return 0;
    case "text-control": out(hasControlCharacter(await stdin()) ? "yes" : "no"); return 0;
    case "input-state":
      out(inputStateFromRegion(a[3] ?? "", a[4] ?? "", a[5] ?? "", a[6] ?? "", a[7] ?? ""));
      return 0;
    case "probe": {
      // Two captures, taken by the adapter. A band that changed between them is
      // being typed into right now, and a backup of either sample is a backup
      // of neither.
      // The SECOND observation is a pair too. Packing only the first would leave
      // the escaped/plain reconstruction defect alive in the instability read —
      // the sample a backup would be taken from.
      const io2 = pairFromBytes(new TextEncoder().encode(process.env.TAP_PANE_FRAME2 ?? ""), width);
      const p = pendingInputProbe(io, a[3]!, a[4]!, Number(a[5] ?? "0") || 0, io2);
      out([p.state, String(p.recoverable), p.reason, p.hash, String(p.bytes), p.text].join(US));
      return 0;
    }
    case "alert-state": out(paneAlertState(stripAnsi(await stdin()))); return 0;
    case "backup-write": {
      // The text is the one field that can be arbitrary bytes, so it arrives on
      // stdin; everything else is a bounded token.
      const text = await stdin();
      out(writeInputBackup({
        directory: a[3]!, handle: a[4]!, payloadId: a[5]!, pane: a[6]!, paneId: a[7]!,
        paneCommand: a[8]!, inputHash: a[9] || inputHash(text), recoveryPolicy: a[10] ?? "", text,
      }));
      return 0;
    }
    case "backup-body": out(readFileSync(a[3]!, "utf8")); return 0;
    case "clobber": {
      // `clobber <backup-dir> <handle> <payload-id> <pane> <pane-id> <server-epoch> <harness> <cmd> <strip-wire|->
      // ` — the one backup-then-clear door for Bash routes, over the SAME
      // production effects native delivery uses. `strip-wire` of `-` means the
      // whole band is foreign (a human draft); otherwise the exact wire is
      // removed from the backup body. The verdict travels as a token with
      // backup-path/lines/chip columns, never as an exit status.
      const [directory, handle, payloadId, pane, paneId, serverEpoch, harness, cmd, stripWire] = a.slice(3);
      // Arity, not content: an empty pane-id is a legitimate unbound call.
      if (directory === undefined || handle === undefined || payloadId === undefined
        || pane === undefined || serverEpoch === undefined || harness === undefined
        || cmd === undefined || stripWire === undefined) {
        process.stderr.write("tap: pane cli: clobber requires backup-dir, handle, payload-id, pane, pane-id, server-epoch, harness, cmd, strip-wire\n");
        return 2;
      }
      // The caller captures the full pane observation after its registry guard;
      // the door re-authorizes that generation before every pane key.
      const bound: BoundRecipient | undefined = paneId
        ? { paneId, serverEpoch, harness } : undefined;
      const v = clobberBand(pane, cmd, bound, DARK_EFFECTS,
        { directory, handle, payloadId, pane, paneId }, stripWire === "-" ? "" : stripWire);
      const backupPath = "backupPath" in v ? v.backupPath ?? "" : "";
      const lines = "lines" in v ? v.lines : 0;
      const chip = "chip" in v && v.chip ? 1 : 0;
      out([v.kind, backupPath, lines, chip].join(US));
      return 0;
    }
    case "clear-own": {
      // `clear-own <payload-id> <pane> <pane-id> <server-epoch> <harness> <cmd> <wire>`: the
      // withheld-injection take-back (tap-arm4w). The verdict is a token, never an exit status.
      const [payloadId, pane, paneId, serverEpoch, harness, cmd, wire] = a.slice(3);
      if (wire === undefined || !payloadId || !pane || !paneId || !serverEpoch || !harness || !cmd) {
        process.stderr.write("tap: pane cli: clear-own requires payload-id, pane, pane-id, server-epoch, harness, cmd, wire\n");
        return 2;
      }
      out(clearOwnInjection(pane, cmd, { paneId, serverEpoch, harness }, DARK_EFFECTS, payloadId, wire));
      return 0;
    }
    default:
      process.stderr.write(`tap: pane cli: unknown verb '${verb}'\n`);
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
