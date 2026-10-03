#!/usr/bin/env bun

import { createLeafFallback } from "../../main";

const [path, ...argv] = process.argv.slice(2);
if (!path) process.exit(2);
process.exitCode = await createLeafFallback([path])(argv);
