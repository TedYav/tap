#!/usr/bin/env bun

import { runNative, NATIVE_HANDLERS } from "../../main";

process.exitCode = runNative("send", NATIVE_HANDLERS.send!, process.argv.slice(2));
