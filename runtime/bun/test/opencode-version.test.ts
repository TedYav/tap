import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireOpenCode2 } from "../src/launcher/opencode-version";
import { removeScratchTree } from "./support/scratch";
const bin=mkdtempSync(join(tmpdir(),"oc2-version-"));
afterAll(()=>removeScratchTree(bin));
function version(output:string,code=0){
  writeFileSync(join(bin,"opencode"),`#!/bin/sh\nprintf '%s\\n' '${output}'\nexit ${code}\n`,{mode:0o755});
  return {...process.env,PATH:bin};
}
test("OpenCode 2 is required and an unreadable version never launches",()=>{
  for(const value of ["2.0.0","opencode v2.1.2"])expect(()=>requireOpenCode2(version(value))).not.toThrow();
  for(const value of ["1.18.0","3.0.0","garbage",""])expect(()=>requireOpenCode2(version(value))).toThrow("OpenCode 2.x is required");
  expect(()=>requireOpenCode2(version("2.1.2",1))).toThrow("OpenCode 2.x is required");
});

test("directory-sensitive shims cannot hide an unsupported target version",()=>{
  mkdirSync(join(bin,"target"));const target=realpathSync(join(bin,"target"));
  const env=version("2.1.2");
  writeFileSync(join(bin,"opencode"),`#!/bin/sh
if [ "$(pwd -P)" = '${target}' ]; then echo 1.18.0; else echo 2.1.2; fi
`,{mode:0o755});
  expect(()=>requireOpenCode2(env,bin)).not.toThrow();
  expect(()=>requireOpenCode2(env,target)).toThrow("OpenCode 2.x is required");
});
