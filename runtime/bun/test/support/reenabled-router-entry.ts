#!/usr/bin/env bun

// tap-h9czh: the re-enable door as a test entry. Routes exactly like
// main.ts (same handlers, same fallback) without main.ts's onboarding and
// overdue preludes, so tests of native send/reply guards reach the verb
// directly.
import { resolve } from "node:path";

import { NATIVE_HANDLERS, route, routerFallback } from "../../main";

const scripts = resolve(import.meta.dir, "../../../../skills/tap/scripts");
process.exitCode = await route(
  process.argv.slice(2),
  NATIVE_HANDLERS,
  routerFallback(scripts),
  process.env.TAP_BUN_ROUTE_TRACE,
);
