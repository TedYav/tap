// `tap out` through the native door with an injected fzf, so a test can stand
// in for the human. Knobs (env): OUT_PICK=<handle> selects it; OUT_PICK=esc or
// unset cancels; OUT_PICK=^C interrupts; OUT_PICK_TERMINAL=0 has no terminal;
// OUT_PICK_NO_FZF=1 has no fzf; OUT_PICK_MUTATE=1 changes the chosen row while
// the picker is open; OUT_PICK_LOG records what the picker saw, and with
// OUT_PICK_PROBE the lock state observed from a child process during the pick.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { runNative } from "../../main";
import { cmdOutRetire } from "../../src/out-retire";
import { FzfToolError } from "../../src/fzf-tool";
import type { FzfEffects } from "../../src/fzf";

const env = process.env;
const effects: FzfEffects = {
  terminal: () => env.OUT_PICK_TERMINAL !== "0",
  binary: () => {
    if (env.OUT_PICK_NO_FZF === "1") throw new FzfToolError("fzf_unavailable", "run ./install.sh", "managed fzf is missing");
    return "fake-fzf";
  },
  run: async (_binary, args, input) => {
    let locks: unknown = null;
    if (env.OUT_PICK_PROBE) {
      const probe = Bun.spawnSync([process.execPath, env.OUT_PICK_PROBE, env.OUT_PICK_REGISTRY!, env.TAP_HOME!], { env, stdout: "pipe", stderr: "pipe" });
      locks = JSON.parse(probe.stdout.toString());
    }
    const choice = env.OUT_PICK ?? "esc";
    if (env.OUT_PICK_MUTATE === "1") {
      const doc = JSON.parse(readFileSync(env.OUT_PICK_REGISTRY!, "utf8"));
      doc.seats[choice].note = "changed while the picker was open";
      writeFileSync(env.OUT_PICK_REGISTRY!, `${JSON.stringify(doc, null, 2)}\n`);
    }
    if (env.OUT_PICK_LOG) appendFileSync(env.OUT_PICK_LOG, `${JSON.stringify({ args, rows: input.split("\0").filter(Boolean), locks })}\n`);
    if (choice === "esc") return { code: 1, output: "esc\0" };
    if (choice === "^C") return { code: 130, output: "" };
    return { code: 0, output: `\0${choice}\0` };
  },
};
// Callers spell the verb (`out ...`) as on the public door; the handler takes what follows it.
const argv = process.argv.slice(2);
if (argv[0] === "out") argv.shift();
process.exitCode = await runNative("out", args => cmdOutRetire(args, "out", effects), argv);
