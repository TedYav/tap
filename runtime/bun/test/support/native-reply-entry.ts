#!/usr/bin/env bun

import { runNative, NATIVE_HANDLERS } from "../../main";

process.exitCode = runNative("reply", NATIVE_HANDLERS.reply!, process.argv.slice(2));
