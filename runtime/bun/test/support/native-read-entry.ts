// Direct module entry for tests: run the native read verb with no Bash door.
import { runNative } from "../../main";
import { cmdRead } from "../../src/verbs/read";

const argv = process.argv.slice(2);
try {
  process.exitCode = runNative("read", cmdRead, argv);
} catch (error) {
  throw error;
}
