#!/usr/bin/env bun

import { runNative, loadNativeHandler } from "../../main";

process.exitCode = await runNative("reply", (await loadNativeHandler("reply"))!, process.argv.slice(2));
