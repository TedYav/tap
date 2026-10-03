import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { respawnInitialPane, type FailureEvidence } from "../src/launcher/transaction";

// Only the rare kernel fork-refusal observation is simulated. Assertions are
// against the actual owner argv/predicate; real stopped-child behavior and
// tmux identity-bound cleanup are covered by the transaction fixtures.
test.each(["success", "repeat", "positive-pid", "missing", "drift", "other-error", "startup-exit"])("initial respawn %s obeys the bounded no-effect retry table", async mode => {
  const root=mkdtempSync(join(process.env.TAP_INDEX_HOME!,"fork-"));
  mkdirSync(join(root,"bin"));
  const log=join(root,"calls.jsonl"), state=join(root,"state");
  const script=String.raw`
import json,pathlib,sys
args=sys.argv[1:]; root=pathlib.Path(__file__).resolve().parents[1]
mode=MODE
log=root/"calls.jsonl"; state=root/"state"
with log.open("a") as stream: stream.write(json.dumps(args)+"\n")
count=int(state.read_text()) if state.exists() else 0
if "display-message" in args:
    if mode=="missing": raise SystemExit(1)
    print("123:456\t$1\t@1\t%7\t"+("43" if mode=="positive-pid" else "-1")+"\t/private/fork-test.sock")
    raise SystemExit(0)
assert "if-shell" in args and "-F" in args,args
predicate=args[-3]; command=args[-2]
for term in ("#{pid}:#{start_time}","#{session_id}","#{window_id}","#{pane_id}"):
    assert term in predicate,(term,args)
assert command.startswith("respawn-pane"),command
if count:
    assert "#{==:#{pane_pid},-1}" in predicate,predicate
    assert " -k " not in command,command
    if mode=="drift": print("TAP_LAUNCH_IDENTITY_MOVED"); raise SystemExit(0)
else: assert " -k " in command,command
state.write_text(str(count+1))
if mode=="startup-exit" or (count and mode=="success"): raise SystemExit(0)
print("other failure" if mode=="other-error" else "respawn pane failed: fork failed: Device not configured",file=sys.stderr)
raise SystemExit(1)
`.replace("MODE",JSON.stringify(mode));
  const python=process.env.TAP_PYTHON ?? "python3";
  writeFileSync(join(root,"bin/tmux"),`#!/usr/bin/env ${python}\n${script}`,{mode:0o755});
  const evidence={record:{name:"fixture/seat",cwd:root},vessel:{server:"123:456",session:"$1",window:"@1",pane:"%7",socket:"/private/fork-test.sock"}} as FailureEvidence;
  const action=respawnInitialPane(evidence,"exec fake-harness",{...process.env,PATH:`${root}/bin:${process.env.PATH}`});
  if (["success","startup-exit"].includes(mode)) await action; else await expect(action).rejects.toThrow();
  const calls:string[][]=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const attempts=calls.filter(argv=>argv.includes("if-shell"));
  expect(attempts.length).toBe(["success","repeat","drift"].includes(mode)?2:1);
  if(mode==="drift") expect(readFileSync(state,"utf8")).toBe("1");
},10000);
