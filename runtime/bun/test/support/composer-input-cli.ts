// Read-only precondition for the watch regress fixture, using the native reader.
import { composerInput } from "../../src/submit-frame";
const input = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await Bun.stdin.bytes());
const result = composerInput(input, process.argv[2] ?? "");
process.stdout.write(result.state === "text" ? `text\x1f${result.text}` : result.state);
