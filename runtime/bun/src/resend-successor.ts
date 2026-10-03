// One successor invocation after durable resend preparation. It runs send,
// never resend; any failure leaves the original withdrawn. Send has no Bash
// body to delegate to (cut sprint E), so the successor is native end to end.
import { dirname } from "node:path";
import { cmdSend } from "./verbs/send";
import { AGENT_FAMILIES } from "./harness-families";
import { runNative } from "../main";

const emitted: string[] = JSON.parse(process.argv[2]!);
const [, script, ...args] = emitted;
process.exitCode = runNative("send", argv => cmdSend(argv, dirname(script!), AGENT_FAMILIES), args);
