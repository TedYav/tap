/** Inject OpenCode's direct session identity into each tool shell. */
import type { Plugin } from "@opencode-ai/plugin"

export default (async () => ({
  "shell.env": async (input, output) => {
    if (!input.sessionID) return
    output.env.OPENCODE_SESSION_ID = input.sessionID
  },
})) satisfies Plugin
