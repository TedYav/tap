// Preloaded by a release artifact's libexec/tap/bun before any TAP child runs.
// The shim sets BUN_BE_BUN=1 so the compiled router acts as Bun; be-bun-scrub.ts
// removes it before the child's own code runs, including from the environment
// Bun.spawn hands a grandchild by default.
import { scrubBunBeBun } from "./be-bun-scrub";

scrubBunBeBun();
