// Entry for nudge-cross-team-fences.test.ts: one cmdNudge call from the Sender team's root.
import { cmdNudge } from "../../src/verbs/nudge";
import { resolve } from "node:path";
try { process.exitCode = cmdNudge(["Target/peer"], resolve(import.meta.dir, "../../../../skills/tap/scripts"), new Set(["codex"])); }
catch (error) { console.error(String(error)); process.exitCode = (error as { code?: number }).code ?? 1; }
