// Shell fixture bridge to the native reader. Production imports the reader directly.
import { frameIo, framePairIo, pendingInputText } from "../../src/pane/reader";
const [, , pane = "", harness = "", mode] = process.argv;
const bytes = await Bun.stdin.bytes();
const decode = (part: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(part);
const width = process.env.TAP_PANE_WIDTH ?? "";
const frame = mode === "--frame" ? decode(bytes) : undefined;
const io = (() => {
  if (frame !== undefined) return frameIo(frame, width);
  const nl = bytes.indexOf(10), n = nl < 0 ? NaN : Number(decode(bytes.subarray(0, nl)));
  if (nl < 0 || !Number.isInteger(n) || n < 0 || nl + 1 + n > bytes.length) throw new Error("fixture requires a capture pair");
  return framePairIo(decode(bytes.subarray(nl + 1, nl + 1 + n)), decode(bytes.subarray(nl + 1 + n)), width);
})();
const result = pendingInputText(io, pane, harness, frame);
process.stdout.write(result.status === "text" ? `text\x1f${result.text}` : result.status);
