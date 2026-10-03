#!/usr/bin/env bun
import { runNative } from "../../main";
import { cmdShow } from "../../src/verbs/show";
try { process.exitCode = runNative("show", cmdShow, process.argv.slice(2)); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
