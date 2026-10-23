// Child-only instrumentation: the chooser reports precisely which work ran
// before the user selected an option. Real observations still run afterwards.
import { mock } from "bun:test";
const fs = await import("node:fs");
const child = await import("node:child_process");
const native = { readdirSync: fs.readdirSync, spawnSync: child.spawnSync, spawn: child.spawn };
const events: string[] = [];
let chosen = false;
mock.module("node:fs", () => ({ ...fs,
  readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
    if (!chosen && /(?:projects|sessions)/.test(String(args[0]))) events.push("native-store");
    return native.readdirSync(...args);
  },
}));
mock.module("node:child_process", () => ({ ...child,
  spawnSync: (...args: Parameters<typeof child.spawnSync>) => {
    if (!chosen) events.push(`${String(args[0])} ${JSON.stringify(args[1])}`);
    return native.spawnSync(...args);
  },
  spawn: (...args: Parameters<typeof child.spawn>) => {
    if (!chosen) events.push(`${String(args[0])} ${JSON.stringify(args[1])}`);
    return native.spawn(...args);
  },
}));
const { cmdSessionLaunch } = await import("../../src/launcher/new");
const [answers = "q", ...args] = process.argv.slice(2);
const keys = answers.split(",");
process.exitCode = await cmdSessionLaunch(args, undefined, {
  hasTty: () => true,
  choose: (_verb, question, options) => {
    process.stdout.write(`MENU ${JSON.stringify({ events, question, options })}\n`);
    chosen = true;
    return keys.shift() ?? "q";
  },
  ...(process.env.SCRIPTED_REAL_ATTACH ? {} : { attach: async (target: string) => { process.stdout.write(`ATTACH ${target}\n`); return 0; } }),
  run: async record => { process.stdout.write(`RUN ${record.name}\n`); return 0; },
});
