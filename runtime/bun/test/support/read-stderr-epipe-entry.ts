// Direct entry for tests: the native read door with a stderr whose write throws EPIPE. Bun never
// throws that synchronously on a real closed stderr pipe, so the only way to prove a stderr EPIPE
// is not read as the quiet stdout-closed disposition is to stage it.
import { runNative } from "../../main";
import { cmdRead } from "../../src/verbs/read";

process.stderr.write = (() => {
  throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", syscall: "write", errno: -32 });
}) as typeof process.stderr.write;

process.exit(runNative("read", cmdRead, process.argv.slice(2)));
