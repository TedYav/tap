import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVessel, respawnInitialPane, type FailureEvidence } from "../src/launcher/transaction";
import { LaunchCommandError } from "../src/launcher/process";

test("an empty PID preserves physical vessel identity but a malformed record does not", () => {
  expect(parseVessel("123:456\t$1\t@1\t%7\t\t/private/fork-test.sock")).toEqual({
    server: "123:456", session: "$1", window: "@1", pane: "%7", socket: "/private/fork-test.sock",
  });
  expect(parseVessel("123:456\t$1\t@1\t%7\tbad\t/private/fork-test.sock")).toBeNull();
  expect(parseVessel("123:456\t$1\t@1\t%7\t/private/fork-test.sock")).toBeNull();
});

// The shim records every effect: a refused fork must never respawn that pane again.
test.each(["fork-refused", "empty-pid", "other-error", "startup-exit", "ownership-moved"])("initial respawn %s attempts the owned pane once", async mode => {
  const root=mkdtempSync(join(process.env.TAP_INDEX_HOME!,"fork-"));
  mkdirSync(join(root,"bin"));
  const log=join(root,"calls.jsonl");
  const script=String.raw`
import json,pathlib,sys
args=sys.argv[1:]; root=pathlib.Path(__file__).resolve().parents[1]
mode=MODE
log=root/"calls.jsonl"
with log.open("a") as stream: stream.write(json.dumps(args)+"\n")
if "display-message" in args:
    print("123:456\t$1\t@1\t%7\t"+("" if mode=="empty-pid" else "-1")+"\t/private/fork-test.sock")
    raise SystemExit(0)
assert "if-shell" in args and "-F" in args,args
predicate=args[-3]; command=args[-2]
for term in ("#{pid}:#{start_time}","#{session_id}","#{window_id}","#{pane_id}"):
    assert term in predicate,(term,args)
assert command.startswith("respawn-pane"),command
if mode=="ownership-moved": print("TAP_LAUNCH_IDENTITY_MOVED"); raise SystemExit(0)
if mode=="startup-exit": raise SystemExit(0)
print("other failure" if mode=="other-error" else "respawn pane failed: fork failed: Device not configured",file=sys.stderr)
raise SystemExit(1)
`.replace("MODE",JSON.stringify(mode));
  const python=process.env.TAP_PYTHON ?? "python3";
  writeFileSync(join(root,"bin/tmux"),`#!/usr/bin/env ${python}\n${script}`,{mode:0o755});
  const evidence={record:{name:"fixture/seat",cwd:root},vessel:{server:"123:456",session:"$1",window:"@1",pane:"%7",socket:"/private/fork-test.sock"}} as FailureEvidence;
  const action=respawnInitialPane(evidence,"exec fake-harness",{...process.env,PATH:`${root}/bin:${process.env.PATH}`});
  if (mode === "startup-exit") await action;
  else if (mode === "ownership-moved") await expect(action).rejects.toThrow("creation identity changed before respawn");
  else {
    const error = await action.catch(error => error);
    expect(error).toBeInstanceOf(LaunchCommandError);
    expect(error.result.stderr.trim()).toBe(mode === "other-error" ? "other failure" : "respawn pane failed: fork failed: Device not configured");
  }
  const calls:string[][]=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const attempts=calls.filter(argv=>argv.includes("if-shell"));
  expect(attempts).toHaveLength(1);
  expect(attempts[0]!.at(-2)).toContain(" -k ");
},10000);
