// Test-only window resolver for the shell fixtures that seed a park or assert a
// window: `<policy> <team> <handle> <reply> <acting>`, the bytes `deliveryWindowSeconds`
// answers, no newline. Production has no such door — the park, the roster and
// `tap digest-window` call the functions in-process.
import { deliveryWindowSeconds } from "../../src/digest-window";

const [policy, team, handle, reply, acting] = process.argv.slice(2);
try {
  process.stdout.write(deliveryWindowSeconds(policy || "standard", team ?? "", handle ?? "", reply || "expected", acting ?? ""));
} catch (error) {
  process.stderr.write(`tap digest-window: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
