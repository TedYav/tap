// Run under pty-caller.py: pin positive outside evidence before exercising
// retirement. A no-TTY runner is intentionally an unobservable caller.
import { observeCallingPane } from "../../src/context";

const caller = observeCallingPane();
if (caller.state !== "outside") throw new Error(`operator terminal is not outside: ${JSON.stringify(caller)}`);
const [main, ...args] = process.argv.slice(2);
const child = Bun.spawnSync([process.execPath, main!, "team", "out", "t", ...args],
  { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
process.exit(child.exitCode);
