// Run one terminal prompt for a PTY test (support/pty-prompt.py drives the keys).
// argv: name <question> <prefix> <suffix>  — promptName; the check refuses
//   "taken" and throws on "boom", and the answer prints as `NAME <json>`
//   (exit 2 when the prompt quits); SIGNAL_AFTER_MS=<n> has a detached shell send
//   SIGNAL_NAME (default TERM) to this process alone after n ms, as `kill` would;
// Like the real entries it exits through exitKeepingTerminal: Bun's own exit
// would write its startup terminal mode back over the one under test.
//   "name-under-progress" asks it inside an animated launch (tap-tl6rh): its spinner
//   must stay off the row while the editor waits.
// argv: choice  — promptChoice with an unavailable [f] row; prints `CHOICE <key>`;
//   "choice-under-progress" asks it inside an animated launch (tap-okayq).
import { spawn } from "node:child_process";
import { validToken } from "../../src/ids";
import { launchPhase, withLaunchProgress } from "../../src/launcher/progress";
import { exitKeepingTerminal, promptChoice, promptName } from "../../src/launcher/prompt";

const [mode, question = "", prefix = "", suffix = ""] = process.argv.slice(2);
if (mode === "choice" || mode === "choice-under-progress") {
  const ask = () => promptChoice("session", "'demo/opus' (cursor): live", [
    ["r", "resume", "Reattach to the running session"],
    ["n", "new", "Start a sibling with a suffixed name"],
    ["f", "fork", "Harness cannot fork", true],
    ["k", "kill", "Stop it and start fresh"],
    ["q", "quit", "Leave everything unchanged"],
  ], "r");
  let key = "";
  if (mode === "choice") key = ask();
  else {
    await withLaunchProgress("animate", async () => {
      launchPhase("Loading TAP config");
      await Bun.sleep(300);
      key = ask();
      return 0;
    });
  }
  process.stdout.write(`CHOICE ${key}\n`);
} else {
  const signalAfter = Number(process.env.SIGNAL_AFTER_MS ?? "");
  if (signalAfter > 0) {
    spawn("/bin/sh", ["-c", `sleep ${signalAfter / 1000}; kill -${process.env.SIGNAL_NAME ?? "TERM"} ${process.pid}`], { detached: true, stdio: "ignore" }).unref();
  }
  let name: string | null;
  // A throw renders and exits as the launch door's render() does.
  try {
    const ask = () => promptName(question, prefix, suffix, value => {
      if (value === "boom") throw new Error("check exploded");
      if (value === "taken") return `'${value}' is taken`;
      // The launcher's own check refuses a non-token the same way (launcher/new.ts).
      return validToken(value) ? null : `'${value}' must use letters, digits, '.', '_' or '-'`;
    });
    if (mode === "name-under-progress") {
      name = null;
      await withLaunchProgress("animate", async () => {
        launchPhase("Loading TAP config");
        await Bun.sleep(300); // the spinner is visibly running before the prompt takes the row
        name = await ask();
        return 0;
      });
    } else name = await ask();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    await exitKeepingTerminal(1);
    throw error;
  }
  if (name !== null) process.stdout.write(`NAME ${JSON.stringify(name)}\n`);
  await exitKeepingTerminal(name === null ? 2 : 0);
}
await exitKeepingTerminal(0);
