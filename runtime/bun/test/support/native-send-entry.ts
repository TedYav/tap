#!/usr/bin/env bun

import { runNative, loadNativeHandler } from "../../main";

process.exitCode = await runNative("send", (await loadNativeHandler("send"))!, process.argv.slice(2));
