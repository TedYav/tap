#!/usr/bin/env bun
import { runNative } from "../../main";
import { cmdOutstanding } from "../../src/verbs/outstanding";
process.exitCode = runNative("outstanding", cmdOutstanding, process.argv.slice(2));
