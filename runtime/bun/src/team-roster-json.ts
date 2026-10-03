#!/usr/bin/env bun
// Internal direct door for machine-wide discovery. It invokes the shared team
// implementation without entering runtime/bun/main.ts's public router, so a
// caller such as `tap team list` does not fan out into nested public team
// invocations while it observes each enrolled roster.
import { resolve } from "node:path";
import { cmdTeam } from "./verbs/team";

process.exitCode = await cmdTeam(process.argv.slice(2), resolve(import.meta.dir, "../../../skills/tap/scripts"));
