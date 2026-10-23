// The claude activity observer and the pane classifier agree on the same real
// frames. The seat-state verdicts over these frames (formerly a Bash-stub run
// of lib.sh `tap_seat_state`) live in seat-state.test.ts's "claude busy footer".
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectAgentState } from "../src/agent-state";
import { classifyPane } from "../src/pane-state";

const fixture=(name:string)=>readFileSync(join(import.meta.dir,"fixtures/agent-state/claude",`${name}.txt`),"utf8");
const idle=fixture("done-real");
// This older capture ends with an API 529 error despite its historical name.
const errored=fixture("idle-real");
// The live prompt row is "❯" + NBSP; a plain "❯ " first matches scrollback.
const typed=(frame:string,text:string)=>frame.replace("❯\u00a0",`❯\u00a0${text}`);
for(const [state, source] of [["idle", idle], ["error", errored]] as const) {
  for(const draft of ["", "human draft", "explain esc to interrupt", "first line\nesc to interrupt"]) {
    test(`${state} Claude activity is independent of composer contents: ${JSON.stringify(draft)}`,()=>{
      const frame=typed(source,draft);
      expect(detectAgentState("claude",frame).agentState).toBe(state);
      expect(classifyPane(frame,"claude",false).kind).toBe(draft ? "draft" : "ready");
    });
  }
}
test("positive busy footer outranks draft",()=>{
  expect(detectAgentState("claude",typed(idle,"human draft")+"\nWorking · esc to interrupt\n").agentState).toBe("working");
});
test("real blocked frame is blocked",()=>{
  expect(detectAgentState("claude",fixture("blocked-real")).agentState).toBe("blocked");
});
