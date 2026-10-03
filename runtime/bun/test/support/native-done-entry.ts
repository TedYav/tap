#!/usr/bin/env bun

import { runNative } from "../../main";
import { cmdDone } from "../../src/verbs/done";

process.exitCode = runNative("done", cmdDone, process.argv.slice(2));
