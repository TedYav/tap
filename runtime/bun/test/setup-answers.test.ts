import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setupMachine } from "../src/verbs/machine";
import { stubHarnessCommands } from "./support/harness-stubs";

const repo = resolve(import.meta.dir,"../../..");
const originalEnv = {...process.env};
const roots: string[] = [];
afterEach(()=>{process.env={...originalEnv};for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

// installMachineSkills logs "install: skipped <label> — <home> does not exist"
// for every harness home this fixture doesn't create; harmless noise the
// runner's undeclared-skip detector otherwise mistakes for an intentional skip.
const SKIPPED_INSTALL_LINE = /^install: skipped .+ does not exist \(no .+ install detected\)$/;
let restoreLogs: (() => void) | undefined;
beforeEach(() => {
  const origLog = console.log, origError = console.error;
  restoreLogs = () => { console.log = origLog; console.error = origError; };
  const filter = (orig: typeof console.log) => (...args: unknown[]) => {
    if (typeof args[0] === "string" && SKIPPED_INSTALL_LINE.test(args[0])) return;
    orig(...args);
  };
  console.log = filter(origLog); console.error = filter(origError);
});
afterEach(() => restoreLogs?.());
function fixture(source?: string) {
  const root=mkdtempSync(join(tmpdir(),"tap-answers-"));roots.push(root);
  const config=join(root,"config/tap/config.toml"), home=join(root,"home"), tools=join(root,"tools");
  mkdirSync(home);mkdirSync(tools);
  // Stub every harness command except codex (the plugin() recorder writes that one on demand).
  stubHarnessCommands(tools,["claude","cursor-agent","agy","opencode","hermes"]);
  if(source!==undefined){mkdirSync(join(root,"config/tap"),{recursive:true});writeFileSync(config,source);}
  const env={...originalEnv,HOME:home,XDG_CONFIG_HOME:join(root,"config"),TAP_INDEX_HOME:join(root,"index"),TAP_INSTALL_BIN:join(root,"bin"),SHELL:"/bin/zsh",TAP_SETUP_OPEN_GUIDE:"0",PATH:tools+":"+originalEnv.PATH};
  const trace=join(root,"plugin-calls");
  const plugin=(code=0)=>writeFileSync(join(tools,"codex"),`#!/bin/sh\nprintf '%s\\n' "$*" >> '${trace}'\necho plugin-output\necho plugin-error >&2\nexit ${code}\n`,{mode:0o755});
  const run=(input:unknown,raw=false)=>{
    const file=join(root,"answers.json");writeFileSync(file,raw?String(input):JSON.stringify(input));
    return Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--json"],{env,stdin:"ignore",timeout:5000});
  };
  return {root,home,config,env,trace,plugin,run};
}
const receipt=(result:ReturnType<typeof Bun.spawnSync>)=>JSON.parse(result.stdout!.toString());

test("empty JSON is a no-op without a config, shell, plugins or machine state",()=>{
  const f=fixture();f.plugin();const result=f.run({});
  expect(result.exitCode).toBe(0);
  expect(receipt(result).notes.join(" ")).toContain("No changes requested");
  for(const path of [f.config,join(f.home,".zshrc"),f.trace,f.env.TAP_INDEX_HOME])expect(existsSync(path)).toBe(false);
});

const invalid: [unknown,string][] = [
  [null,"answers"], [[],"answers"], [true,"answers"], [{version:1},"answers.version"],
  [{skillAliases:true},"answers.skillAliases"], [{fullKit:"yes"},"fullKit"],
  [{harnesses:null},"harnesses"], [{harnesses:{unknown:{}}},"harnesses.unknown"],
  [{harnesses:{codex:{extra:1}}},"harnesses.codex.extra"],
  [{harnesses:{codex:{presets:12}}},"harnesses.codex.presets"],
  [{harnesses:{codex:{presets:["missing"],permissions:"auto"}}},"harnesses.codex.presets"],
  [{harnesses:{codex:{presets:"skip"}}},"harnesses.codex.permissions"],
  [{harnesses:{codex:{permissions:"ask"}}},"harnesses.codex.permissions"],
  [{harnesses:{opencode:{permissions:"auto"}}},"harnesses.opencode.permissions"],
  [{harnesses:{codex:{presets:"simple",permissions:"auto"}}},"starterEffort"],
  [{starterEffort:"ultra"},"starterEffort"], [{starterEffort:"Default"},"starterEffort"], [{shellIntegration:"yes"},"shellIntegration"],
  [{plugins:{codex:["unknown"]}},"plugins.codex"], [{plugins:{cursor:[]}},"plugins.cursor"],
  [{harnesses:{codex:{permissions:"auto"}}},"write"],
  [{write:"replace"},"write"], [{replaceCandidate:"yes"},"replaceCandidate"],
  [{notifications:{notifier:"command"}},"notifications.command"],
  [{notifications:{command:["echo","prefix{body}"]}},"placeholders"],
  [{notifications:{command:["echo","bad\0arg"]}},"notifications.command"],
  [{notifications:{command:[]}},"notifications.command"],
  [{notifications:{timeout_seconds:2}},"notifications.timeout_seconds"],
  [{onboarding:"ask"},"onboarding"], [{onboarding:{init:"maybe"}},"onboarding.init"],
  [{onboarding:{extra:1}},"onboarding.extra"],
  [{injection:"wait"},"injection"], [{injection:{behavior:"interrupt"}},"injection.behavior"],
  [{injection:{behavior:"warn"}},"injection.behavior"], [{injection:{cue:true}},"injection.cue"],
];
for(const [input,field] of invalid)test(`invalid ${JSON.stringify(input)} refuses without effects`,()=>{
  const source="# personal\nversion=3\n[notifications]\nnotifier=\"system\"\n";
  const f=fixture(source);f.plugin();
  const result=f.run(input);
  expect(result.exitCode).toBe(1);
  expect(receipt(result)).toMatchObject({ok:false,error_class:"setup_refused",action:"tap help setup"});
  expect(receipt(result).detail).toContain(field);
  expect(result.stderr.toString()).toBe("");
  expect(readFileSync(f.config,"utf8")).toBe(source);
  for(const path of [join(f.home,".zshrc"),f.trace,f.env.TAP_INDEX_HOME])expect(existsSync(path)).toBe(false);
  expect(Array.from(new Bun.Glob("*.backup-*").scanSync(join(f.root,"config/tap")))).toHaveLength(0);
});

test("invalid later decisions cannot follow earlier config, shell or plugin effects",()=>{
  const f=fixture("version=3\n");f.plugin();
  const result=f.run({harnesses:{codex:{presets:"simple",permissions:"bypass"}},starterEffort:"high",write:"apply",shellIntegration:true,plugins:{codex:["ponytail"]},notifications:{command:["{body}"]}});
  expect(result.exitCode).toBe(1);
  expect(readFileSync(f.config,"utf8")).toBe("version=3\n");
  expect(existsSync(join(f.home,".zshrc"))).toBe(false);expect(existsSync(f.trace)).toBe(false);
});

test("non-TTY zero-preset apply saves independent permissions and leaves effects omitted",()=>{
  const f=fixture();const result=f.run({harnesses:{claude:{presets:"skip",permissions:"auto"},codex:{presets:"skip",permissions:"bypass"}},write:"apply"});
  expect(result.exitCode).toBe(0);
  const config=Bun.TOML.parse(readFileSync(f.config,"utf8")) as any;
  expect(config.presets).toBeUndefined();expect(config.harness.claude.permissions).toBe("auto");expect(config.harness.codex.permissions).toBe("bypass");
  expect(config.harness.codex.env.PONYTAIL_DEFAULT_MODE).toBe("off");
  expect(existsSync(join(f.home,".zshrc"))).toBe(false);expect(existsSync(f.trace)).toBe(false);
});

test("onboarding and injection answers write their config keys and omission preserves them",()=>{
  const f=fixture();const choices={harnesses:{codex:{presets:"skip",permissions:"auto"}},onboarding:{init:"auto"},injection:{behavior:"wait"},write:"apply"};
  expect(f.run(choices).exitCode).toBe(0);
  const config=Bun.TOML.parse(readFileSync(f.config,"utf8")) as any;
  expect(config.onboarding.init).toBe("auto");
  expect(config.injection.behavior).toBe("wait");
  const source=readFileSync(f.config,"utf8");
  expect(f.run({harnesses:{codex:{presets:"skip",permissions:"auto"}},write:"apply"}).exitCode).toBe(0);
  expect(readFileSync(f.config,"utf8")).toBe(source);
  expect(f.run({...choices,injection:{behavior:"clobber"}}).exitCode).toBe(0);
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).injection.behavior).toBe("clobber");
});

test("selected harness omission keeps a saved valid permission and exact existing bytes",()=>{
  const source='# personal\nversion=3\n[harness.codex]\npermissions="bypass" # consent\n[presets.mine]\nharness="codex"\n';
  const f=fixture(source);const result=f.run({harnesses:{codex:{presets:"skip"}}});
  expect(result.exitCode).toBe(0);expect(readFileSync(f.config,"utf8")).toBe(source);
  expect(receipt(result).notes.join(" ")).toContain("No changes requested");
});

test("apply preserves unrelated bytes and records their exact backup",()=>{
  const source='# personal\nversion=3\n[harness.codex]\npermissions = "bypass" # choice\n[notifications]\nnotifier="system"\n';
  const f=fixture(source);const result=f.run({harnesses:{codex:{permissions:"auto"}},write:"apply"});
  expect(result.exitCode).toBe(0);
  expect(readFileSync(f.config,"utf8")).toBe(source.replace('permissions = "bypass"','permissions = "auto"'));
  const backups=Array.from(new Bun.Glob("config.toml.backup-*").scanSync(join(f.root,"config/tap")));
  expect(backups).toHaveLength(1);expect(readFileSync(join(f.root,"config/tap",backups[0]!),"utf8")).toBe(source);
});

test("candidate stays inactive and its replacement requires explicit consent",()=>{
  const f=fixture('version=3\n[harness.codex]\npermissions="bypass"\n');
  const choices={harnesses:{codex:{permissions:"auto"}},write:"candidate"};
  expect(f.run(choices).exitCode).toBe(0);
  const candidate=join(f.root,"config/tap/config.candidate.toml");writeFileSync(candidate,"# previous candidate\nversion=3\n");
  expect(f.run(choices).exitCode).toBe(1);expect(readFileSync(candidate,"utf8")).toContain("previous candidate");
  expect(f.run({...choices,replaceCandidate:true}).exitCode).toBe(0);
  expect((Bun.TOML.parse(readFileSync(candidate,"utf8")) as any).harness.codex.permissions).toBe("auto");
  expect(readFileSync(f.config,"utf8")).toContain('permissions="bypass"');
  expect(f.run({...choices,replaceCandidate:true,shellIntegration:true}).exitCode).toBe(1);
});

test("explicit catalog names retain tuning without starterEffort",()=>{
  const f=fixture();expect(f.run({harnesses:{codex:{presets:["astra"],permissions:"auto"}},write:"apply"}).exitCode).toBe(0);
  const reference=Bun.TOML.parse(readFileSync(join(repo,"skills/tap/config/config.v3.toml"),"utf8")) as any;
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).presets.astra).toEqual(reference.presets.astra);
});

test("default starter effort pins none and keeps roles as a labelled prior",()=>{
  const f=fixture();
  expect(f.run({harnesses:{claude:{presets:"simple",permissions:"auto"},codex:{presets:"simple",permissions:"auto"},opencode:{presets:"simple"}},starterEffort:"default",write:"apply"}).exitCode).toBe(0);
  const reference=Bun.TOML.parse(readFileSync(join(repo,"skills/tap/config/config.v3.toml"),"utf8")) as any;
  const {presets}=Bun.TOML.parse(readFileSync(f.config,"utf8")) as any;
  // One starter per model per vendor harness; OpenCode has none, so setup asks instead.
  expect(Object.keys(presets).sort()).toEqual(["astra","fable","luna","opus","sol","sonnet"]);
  for(const name of ["opus","fable","sonnet"]){
    expect(presets[name].params).toEqual({model:reference.presets[name].params.model});
    expect(presets[name].description).toBe(`${reference.presets[name].params.model} at the harness default effort`);
  }
  for(const name of ["astra","sol","luna"])expect(JSON.stringify(presets[name].params)).not.toContain("model_reasoning_effort");
  expect(presets.astra.params.config).toEqual(reference.presets.astra.params.config.filter((v:string)=>!v.startsWith("model_reasoning_effort")));
  const {metadata}=presets.opus, prior=reference.presets.opus.metadata;
  expect(metadata.primary_roles).toEqual(prior.primary_roles);expect(metadata.avoid_roles).toEqual(prior.avoid_roles);
  expect(metadata.starter).toBe(true);expect(metadata.unadjusted_starter_prior).toBe(true);
  expect(metadata.summary).toBe(`Starter prior written for ${reference.presets.opus.description}; this preset pins no effort: ${prior.summary}`);
  for(const field of ["intelligence","cost_level","speed"])expect(metadata[field]).toBeUndefined();
  expect(Bun.spawnSync([join(repo,"bin/tap"),"presets","--json"],{env:f.env,stdin:"ignore",timeout:5000}).exitCode).toBe(0);
});

test("a starter named explicitly takes a supplied effort; another named variant keeps catalog tuning",()=>{
  const f=fixture();
  expect(f.run({harnesses:{claude:{presets:["opus","opus-high"],permissions:"auto"}},starterEffort:"default",write:"apply"}).exitCode).toBe(0);
  const reference=Bun.TOML.parse(readFileSync(join(repo,"skills/tap/config/config.v3.toml"),"utf8")) as any;
  const {presets}=Bun.TOML.parse(readFileSync(f.config,"utf8")) as any;
  expect(presets.opus.params.effort).toBeUndefined();
  expect(presets["opus-high"]).toEqual(reference.presets["opus-high"]);
});

const SHELL_BEGIN="# >>> tap shell integration >>>",SHELL_END="# <<< tap shell integration <<<";
const COMPDEF_LINE="(( $+functions[compdef] )) && { autoload -Uz _tap && compdef _tap tap; } || { autoload -Uz compinit && compinit; }";
const HELPER_LINE='tap_launch() { local preset="$1" name="$1"; shift; if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then name="$name-$1"; shift; fi; tap session launch "$preset" "$name" "$@"; }';
/** The block a preview printed after its heading, markers included. */
function previewedBlock(note:string,heading:string,begin:string,end:string):string{
  const at=note.indexOf(heading);expect(at,note).toBeGreaterThan(-1);
  const shown=note.slice(at+heading.length);
  return shown.slice(shown.indexOf(begin),shown.indexOf(end)+end.length);
}
const blockOf=(text:string,begin:string,end:string)=>text.slice(text.indexOf(begin),text.indexOf(end)+end.length);

test("dry-run prints the managed block exactly as the write lands it; aliases cover selected presets already saved",()=>{
  const f=fixture(),rc=join(f.home,".zshrc");
  const first={harnesses:{claude:{presets:["opus"],permissions:"auto"}},write:"apply"};
  expect(f.run(first).exitCode).toBe(0);
  const saved=readFileSync(f.config,"utf8");
  const again={harnesses:{claude:{presets:["opus","fable"]}},write:"apply",shellIntegration:true};
  const file=join(f.root,"again.json");writeFileSync(file,JSON.stringify(again));
  const preview=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json"],{env:f.env,stdin:"ignore",timeout:5000});
  expect(preview.exitCode).toBe(0);
  const note=receipt(preview).notes.join("\n");
  expect(note).toContain(`Would add the managed TAP shell block (PATH, completion and the tap_launch helper) to ${rc}, with these preset aliases:`);
  expect(note).toContain("  alias opus='tap_launch opus'");expect(note).toContain("  alias fable='tap_launch fable'");
  // The preview carries every line the write will land: markers, PATH, both completion lines, the helper, the aliases.
  const previewed=previewedBlock(note,"The block, exactly as it would be written:\n",SHELL_BEGIN,SHELL_END);
  expect(previewed.split("\n")).toEqual([SHELL_BEGIN,`export PATH='${f.env.TAP_INSTALL_BIN}':"$PATH"`,`fpath=('${join(f.env.TAP_INSTALL_BIN,"../share/zsh/site-functions")}' $fpath)`,COMPDEF_LINE,HELPER_LINE,"alias fable='tap_launch fable'","alias opus='tap_launch opus'",SHELL_END]);
  expect(existsSync(rc)).toBe(false);expect(readFileSync(f.config,"utf8")).toBe(saved);
  expect(f.run(again).exitCode).toBe(0);
  const block=readFileSync(rc,"utf8");
  expect(blockOf(block,SHELL_BEGIN,SHELL_END)).toBe(previewed);
  // opus was saved by the earlier run: it gains an alias and its config bytes are untouched.
  expect(block).toContain("alias opus='tap_launch opus'");expect(block).toContain("alias fable='tap_launch fable'");
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).presets.opus).toEqual((Bun.TOML.parse(saved) as any).presets.opus);
  expect(f.run({harnesses:{claude:{presets:["opus","fable","sonnet"]}},write:"apply",shellIntegration:true}).exitCode).toBe(0);
  const repeat=readFileSync(rc,"utf8");
  for(const name of ["opus","fable","sonnet"])expect(repeat.split(`alias ${name}=`)).toHaveLength(2);
  const settled=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json"],{env:f.env,stdin:"ignore",timeout:5000});
  expect(receipt(settled).notes.join("\n")).toContain("no new preset aliases");
  expect(readFileSync(rc,"utf8")).toBe(repeat);
});

test("the shell-block preview names only the parts the write will put in the block",()=>{
  const preview=(mutate:(f:ReturnType<typeof fixture>)=>void)=>{
    const f=fixture();mutate(f);
    const file=join(f.root,"preview.json");writeFileSync(file,JSON.stringify({harnesses:{claude:{presets:["opus"],permissions:"auto"}},write:"apply",shellIntegration:true}));
    const result=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json"],{env:f.env,stdin:"ignore",timeout:5000});
    expect(result.exitCode).toBe(0);
    return {note:receipt(result).notes.join("\n"),f};
  };
  // Bash gets no completion lines; the install bin is not yet on PATH.
  const bash=preview(f=>{f.env.SHELL="/bin/bash";});
  expect(bash.note).toContain(`Would add the managed TAP shell block (PATH and the tap_launch helper) to ${join(bash.f.home,".bashrc")}`);
  expect(bash.note).not.toContain("completion");
  // Zsh with the install bin already on PATH gets no PATH line.
  const onPath=preview(f=>{f.env.PATH=f.env.TAP_INSTALL_BIN+":"+f.env.PATH;});
  expect(onPath.note).toContain(`Would add the managed TAP shell block (completion and the tap_launch helper) to ${join(onPath.f.home,".zshrc")}`);
  // Both: only the helper remains.
  const neither=preview(f=>{f.env.SHELL="/bin/bash";f.env.PATH=f.env.TAP_INSTALL_BIN+":"+f.env.PATH;});
  expect(neither.note).toContain("Would add the managed TAP shell block (the tap_launch helper) to");
});

test("the first managed block leaves an alias the person already defined alone",()=>{
  const f=fixture(),rc=join(f.home,".zshrc"),mine="alias opus='printf user-owned'\n";
  expect(f.run({harnesses:{claude:{presets:["opus","fable"],permissions:"auto"}},write:"apply"}).exitCode).toBe(0);
  writeFileSync(rc,mine);
  const answers={harnesses:{claude:{presets:["opus","fable"]}},write:"apply",shellIntegration:true};
  const file=join(f.root,"mine.json");writeFileSync(file,JSON.stringify(answers));
  const preview=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json"],{env:f.env,stdin:"ignore",timeout:5000});
  const note=receipt(preview).notes.join("\n");
  expect(note).toContain("  alias fable='tap_launch fable'");expect(note).not.toContain("alias opus=");
  expect(f.run(answers).exitCode).toBe(0);
  const text=readFileSync(rc,"utf8");
  expect(text.startsWith(mine)).toBe(true);expect(text.split("alias opus=")).toHaveLength(2);
  expect(text).toContain("alias fable='tap_launch fable'");
});

test("a saved custom preset can be selected for an alias; a wrong harness or unsafe name refuses",()=>{
  const custom='version = 3\n[presets.my-model]\nharness = "opencode"\ndescription = "mine"\nparams.model = "provider/model"\n[presets."bad name"]\nharness = "opencode"\nparams.model = "provider/other"\n[presets.opencode]\nharness = "opencode"\nparams.model = "provider/third"\n';
  const f=fixture(custom),rc=join(f.home,".zshrc");
  expect(f.run({harnesses:{opencode:{presets:["my-model"]}},shellIntegration:true}).exitCode).toBe(0);
  expect(readFileSync(rc,"utf8")).toContain("alias my-model='tap_launch my-model'");
  expect(readFileSync(f.config,"utf8")).toBe(custom);
  for(const [answers,detail] of [
    [{harnesses:{claude:{presets:["my-model"],permissions:"auto"}},shellIntegration:true,write:"apply"},"is not a claude preset"],
    [{harnesses:{opencode:{presets:["bad name"]}},shellIntegration:true},"cannot alias"],
    [{harnesses:{opencode:{presets:["opencode"]}},shellIntegration:true},"has a harness name"],
    [{harnesses:{opencode:{presets:["absent"]}},shellIntegration:true},"neither saved in this config nor in the shipped catalog"],
  ] as [unknown,string][]){
    const result=f.run(answers);expect(result.exitCode).toBe(1);expect(receipt(result).detail).toContain(detail);
  }
  expect(readFileSync(rc,"utf8").split("alias ")).toHaveLength(2);expect(readFileSync(f.config,"utf8")).toBe(custom);
});

test("an unreadable install manifest refuses a first shell block before config or shell effects",()=>{
  const f=fixture();mkdirSync(f.env.TAP_INDEX_HOME,{recursive:true});
  writeFileSync(join(f.env.TAP_INDEX_HOME,"install-manifest.json"),"{}");
  const answers={harnesses:{claude:{presets:["opus"],permissions:"auto"}},write:"apply",shellIntegration:true};
  const file=join(f.root,"manifest.json");writeFileSync(file,JSON.stringify(answers));
  const preview=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json"],{env:f.env,stdin:"ignore",timeout:5000});
  expect(preview.exitCode).toBe(1);expect(receipt(preview).detail).toContain("invalid manifest");
  const result=f.run(answers);
  expect(result.exitCode).toBe(1);expect(receipt(result).error_class).toBe("setup_refused");
  expect(existsSync(f.config)).toBe(false);expect(existsSync(join(f.home,".zshrc"))).toBe(false);
});

test("simple leaves a starter name saved under another harness alone and gives it no alias",()=>{
  const mine='version = 3\n[presets.opus]\nharness = "opencode"\nparams.model = "provider/opus-like"\n';
  const f=fixture(mine);
  expect(f.run({harnesses:{claude:{presets:"simple",permissions:"auto"}},starterEffort:"default",shellIntegration:true,write:"apply"}).exitCode).toBe(0);
  const {presets}=Bun.TOML.parse(readFileSync(f.config,"utf8")) as any;
  expect(presets.opus).toEqual({harness:"opencode",params:{model:"provider/opus-like"}});
  expect(Object.keys(presets).sort()).toEqual(["fable","opus","sonnet"]);
  const rc=readFileSync(join(f.home,".zshrc"),"utf8");
  expect(rc).toContain("alias fable=");expect(rc).toContain("alias sonnet=");expect(rc).not.toContain("alias opus=");
});

test("adding first config preset refuses to shadow a legacy catalog",()=>{
  const f=fixture("version=3\n"),legacy=join(f.root,"config/tap/presets.toml");
  writeFileSync(legacy,'version=2\n[presets.mine]\nharness="codex"\n');
  const result=f.run({harnesses:{codex:{presets:["astra"],permissions:"auto"}},write:"apply"});
  expect(result.exitCode).toBe(1);expect(receipt(result).detail).toContain("legacy presets.toml");
  expect(readFileSync(f.config,"utf8")).toBe("version=3\n");expect(readFileSync(legacy,"utf8")).toContain("presets.mine");
});

test("notifier patch retains existing command and configures without sending",()=>{
  const f=fixture('version=3\n[notifications]\nnotifier="system"\ncommand=["echo", "{body}"] # retained\n');
  expect(f.run({notifications:{notifier:"command"},write:"apply"}).exitCode).toBe(0);
  expect(readFileSync(f.config,"utf8")).toContain('command=["echo", "{body}"] # retained');
  const marker=join(f.root,"notification-sent"),command=join(f.root,"notify");
  writeFileSync(command,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
  expect(f.run({notifications:{notifier:"command",command:[command,"{title}","{body}","{urgency}"]},write:"apply"}).exitCode).toBe(0);
  expect(existsSync(marker)).toBe(false);
});

test("interactive and file choices produce identical bytes and equivalent shell/plugin effects",async()=>{
  const source="# untouched\nversion=3\n";
  const terminal=fixture(source);terminal.plugin();process.env=terminal.env;
  const answers=["auto","wait","skip","skip","auto","bypass","y","command",'["echo","{body}"]',"y","y","y","n","n","n","n","n"];
  expect(await setupMachine(async question=>{if(!answers.length)throw new Error(question);return answers.shift()!;},["codex","claude"])).toBe(0);
  expect(answers).toHaveLength(0);
  const file=fixture(source);file.plugin();
  const result=file.run({harnesses:{codex:{presets:"skip",permissions:"auto"},claude:{presets:"skip",permissions:"bypass"}},fullKit:true,notifications:{notifier:"command",command:["echo","{body}"]},write:"apply",shellIntegration:true,plugins:{codex:["ponytail"]},onboarding:{init:"auto"},injection:{behavior:"wait"}});
  expect(result.exitCode).toBe(0);
  expect(readFileSync(file.config,"utf8")).toBe(readFileSync(terminal.config,"utf8"));
  expect(readFileSync(join(file.home,".zshrc"),"utf8").replaceAll(file.root,"ROOT")).toBe(readFileSync(join(terminal.home,".zshrc"),"utf8").replaceAll(terminal.root,"ROOT"));
  expect(readFileSync(file.trace,"utf8")).toBe(readFileSync(terminal.trace,"utf8"));
  expect((Bun.TOML.parse(readFileSync(file.config,"utf8")) as any).injection.behavior).toBe("wait");
});

test("plugin failure reports partial apply while retaining the accepted config",()=>{
  const f=fixture();f.plugin(7);
  const result=f.run({harnesses:{codex:{permissions:"auto"}},write:"apply",plugins:{codex:["ponytail"]}});
  expect(result.exitCode).toBe(1);expect(receipt(result)).toMatchObject({ok:false,error_class:"setup_partial"});
  expect(receipt(result).detail).toContain(`config ${f.config}`);expect(result.stderr.toString()).toBe("");
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).harness.codex.permissions).toBe("auto");
  expect(readFileSync(f.trace,"utf8").trim()).toBe("plugin marketplace add DietrichGebert/ponytail");
});

test("invalid JSON, FIFO answers, and FIFO config refuse without blocking",()=>{
  const f=fixture();expect(f.run("{bad",true).exitCode).toBe(1);
  const fifo=join(f.root,"answers.fifo");expect(Bun.spawnSync(["mkfifo",fifo]).exitCode).toBe(0);
  const args=[join(repo,"bin/tap"),"setup","--machine","--answers",fifo,"--json"];
  const result=Bun.spawnSync(args,{env:f.env,stdin:"ignore",timeout:2000});
  expect(result.exitCode).toBe(1);expect(receipt(result).detail).toContain("not a regular file");
  mkdirSync(join(f.root,"config/tap"),{recursive:true});expect(Bun.spawnSync(["mkfifo",f.config]).exitCode).toBe(0);
  expect(f.run({}).exitCode).toBe(1);expect(lstatSync(f.config).isFIFO()).toBe(true);
});

test("stdin dry-run shows only requested TOML keys and previews effects without applying",()=>{
  const source='version=3\n# unrelated-private-note\n[harness.codex]\npermissions="bypass"\n';
  const f=fixture(source);f.plugin();
  const choices={harnesses:{codex:{permissions:"auto"}},write:"apply",shellIntegration:true,plugins:{codex:["ponytail"]},notifications:{notifier:"system"}};
  const result=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers","-","--dry-run","--json"],{env:f.env,stdin:Buffer.from(JSON.stringify(choices)),timeout:5000});
  expect(result.exitCode).toBe(0);
  const notes=receipt(result).notes.join(" ");
  expect(notes).toContain('- harness.codex.permissions = "bypass"');
  expect(notes).toContain('+ harness.codex.permissions = "auto"');
  expect(notes).toContain("Would install ponytail for codex");
  expect(notes).not.toContain("unrelated-private-note");
  expect(readFileSync(f.config,"utf8")).toBe(source);
  for(const path of [join(f.home,".zshrc"),f.trace,f.env.TAP_INDEX_HOME,`${f.config}.lock`])expect(existsSync(path)).toBe(false);
  expect(Array.from(new Bun.Glob("*.backup-*").scanSync(join(f.root,"config/tap")))).toHaveLength(0);
});

test("dry-run still requires permission and write decisions; stdin apply uses the same writer",()=>{
  const f=fixture();
  const run=(value:unknown,dry=true)=>Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers","-",...(dry?["--dry-run"]:[]),"--json"],{env:f.env,stdin:Buffer.from(JSON.stringify(value)),timeout:5000});
  expect(run({harnesses:{codex:{}}}).exitCode).toBe(1);
  expect(run({harnesses:{codex:{permissions:"auto"}}}).exitCode).toBe(1);
  expect(existsSync(f.config)).toBe(false);
  expect(run({harnesses:{codex:{permissions:"auto"}},write:"apply"},false).exitCode).toBe(0);
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).harness.codex.permissions).toBe("auto");
});

test("interactive preset default skips and never asks unused effort",async()=>{
  const f=fixture();process.env=f.env;
  const answers=["","","","","","","n"],questions:string[]=[];
  expect(await setupMachine(async question=>{questions.push(question);if(!answers.length)throw new Error(question);return answers.shift()!;},["codex"])).toBe(0);
  expect(questions[0]).toContain("(ask/auto)");
  expect(questions[2]).toContain("[skip]");
  expect(questions.some(q=>q.includes("effort"))).toBe(false);
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).presets).toBeUndefined();
});

test("an invalid saved permission is not treated as consent by an omitted file field",()=>{
  const source='version=3\n[harness.codex]\npermissions="unknown"\n';
  const f=fixture(source);const result=f.run({harnesses:{codex:{presets:"skip"}},write:"apply"});
  expect(result.exitCode).toBe(1);expect(receipt(result).detail).toContain("harnesses.codex.permissions");
  expect(readFileSync(f.config,"utf8")).toBe(source);
});

test("repeat shell setup adds a requested alias to its owned block without replacing outside bytes",()=>{
  const f=fixture();f.env.SHELL="/bin/bash";
  const rc=join(f.home,".bashrc");writeFileSync(rc,"# personal before\n");
  expect(f.run({shellIntegration:true}).exitCode).toBe(0);
  writeFileSync(rc,readFileSync(rc,"utf8")+"# personal after\n");
  const choices={harnesses:{codex:{presets:["astra"],permissions:"auto"}},write:"apply",shellIntegration:true};
  expect(f.run(choices).exitCode).toBe(0);
  const text=readFileSync(rc,"utf8");
  expect(text).toStartWith("# personal before\n");expect(text).toEndWith("# personal after\n");
  const shell=Bun.spawnSync(["bash","-c",'source "$1"; alias astra',"_",rc],{env:f.env});
  expect(shell.exitCode).toBe(0);expect(shell.stdout.toString()).toContain("tap_launch astra");
  expect(f.run(choices).exitCode).toBe(0);expect(readFileSync(rc,"utf8")).toBe(text);
});

test("dry-run prints an owned legacy-marker block exactly as the upgrade rewrites it, and the write lands those bytes under the old name",()=>{
  const f=fixture(),rc=join(f.home,".zshrc");
  const begin="# >>> tap aliases >>>",end="# <<< tap aliases <<<";
  const content=[begin,HELPER_LINE,end].join("\n");
  writeFileSync(rc,`# personal\n${content}\n`);
  mkdirSync(f.env.TAP_INDEX_HOME,{recursive:true});
  writeFileSync(join(f.env.TAP_INDEX_HOME,"install-manifest.json"),JSON.stringify({version:1,repo,entries:[{kind:"block",path:rc,begin,end,content}]}));
  const choices={harnesses:{codex:{presets:["astra"],permissions:"auto"}},write:"apply",shellIntegration:true};
  const file=join(f.root,"legacy.json");writeFileSync(file,JSON.stringify(choices));
  const preview=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json"],{env:f.env,stdin:"ignore",timeout:5000});
  expect(preview.exitCode).toBe(0);
  const note=receipt(preview).notes.join("\n");
  expect(note).toContain(`Would update the owned TAP shell block in ${rc}`);
  const previewed=previewedBlock(note,"The block, exactly as it would be rewritten:\n",begin,end);
  expect(previewed.split("\n")).toEqual([begin,`fpath=('${join(f.env.TAP_INSTALL_BIN,"../share/zsh/site-functions")}' $fpath)`,COMPDEF_LINE,HELPER_LINE,"alias astra='tap_launch astra'",end]);
  expect(readFileSync(rc,"utf8")).toBe(`# personal\n${content}\n`);
  expect(f.run(choices).exitCode).toBe(0);
  const written=readFileSync(rc,"utf8");
  expect(blockOf(written,begin,end)).toBe(previewed);
  expect(written).not.toContain("tap shell integration");
});

test("dry-run summarizes a starter's calibration notes one line per preset; --verbose lists each key",()=>{
  const f=fixture();
  const choices={harnesses:{claude:{presets:["opus"],permissions:"auto"}},starterEffort:"default",write:"apply"};
  const file=join(f.root,"notes.json");writeFileSync(file,JSON.stringify(choices));
  const dry=(extra:string[])=>{
    const result=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json",...extra],{env:f.env,stdin:"ignore",timeout:5000});
    expect(result.exitCode).toBe(0);
    return receipt(result).notes.join("\n");
  };
  const summary=dry([]);
  expect(summary).toMatch(/\+ presets\.opus\.metadata = \d+ calibration notes \(--verbose lists each\)/);
  expect(summary).not.toContain("presets.opus.metadata.summary");
  expect(summary).toContain('+ presets.opus.harness = "claude"');
  const full=dry(["--verbose"]);
  expect(full).toContain("+ presets.opus.metadata.summary = ");
  expect(full).not.toContain("calibration notes (");
});

test("the closing hint names the presets this run added, the first as the example",()=>{
  const f=fixture();
  const file=join(f.root,"hint.json");writeFileSync(file,JSON.stringify({harnesses:{claude:{presets:["sonnet","opus"],permissions:"auto"}},starterEffort:"default",write:"apply"}));
  // The hint is human output, not a receipt note: read it from the plain-text run.
  const result=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file],{env:f.env,stdin:"ignore",timeout:5000});
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()+result.stderr.toString()).toContain("next: from your work directory, run tap launch opus (or any of: sonnet)");
});

test("dry-run promises preservation rather than new aliases for an edited shell block",()=>{
  const f=fixture();const rc=join(f.home,".zshrc"),source="# >>> tap aliases >>>\n# my edited block\n# <<< tap aliases <<<\n";
  writeFileSync(rc,source);
  const choices={harnesses:{codex:{presets:["astra"],permissions:"auto"}},write:"apply",shellIntegration:true};
  const result=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers","-","--dry-run","--json"],{env:f.env,stdin:Buffer.from(JSON.stringify(choices)),timeout:5000});
  expect(result.exitCode).toBe(0);expect(receipt(result).notes.join(" ")).toContain("no new aliases would be added");
  expect(f.run(choices).exitCode).toBe(0);expect(readFileSync(rc,"utf8")).toBe(source);
});

test("plugin-only candidate mode never points to an unwritten candidate",()=>{
  const f=fixture();f.plugin();
  const result=f.run({write:"candidate",plugins:{codex:["ponytail"]}});
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain("config.candidate.toml");
  expect(existsSync(join(f.root,"config/tap/config.candidate.toml"))).toBe(false);
  expect(readFileSync(f.trace,"utf8")).toContain("plugin add ponytail@ponytail");
});

test("malformed answers and arguments emit one standard JSON failure with no stderr",()=>{
  const f=fixture();
  const malformed=f.run("{broken",true);
  const missing=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers","--json"],{env:f.env,stdin:"ignore"});
  for(const result of [malformed,missing]) {
    expect(result.exitCode).toBe(1);expect(result.stderr.toString()).toBe("");
    expect(receipt(result)).toMatchObject({ok:false,error_class:"setup_refused",action:"tap help setup"});
    expect(Object.keys(receipt(result)).sort()).toEqual(["action","detail","error_class","ok"]);
  }
  expect(existsSync(f.config)).toBe(false);
});

test("human answers refusal has one actionable stderr line and no stdout",()=>{
  const f=fixture();const file=join(f.root,"bad.json");writeFileSync(file,JSON.stringify({"bad\nfield":true}));
  const result=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file],{env:f.env,stdin:"ignore"});
  expect(result.exitCode).toBe(1);expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString().trim().split("\n")).toHaveLength(1);
  expect(result.stderr.toString()).toContain("next: tap help setup");
});

test("preflight errors discard buffered permission notes without causing effects",()=>{
  const f=fixture();f.env.SHELL="/bin/fish";
  const result=f.run({harnesses:{claude:{permissions:"auto"}},write:"apply",shellIntegration:true});
  expect(result.exitCode).toBe(1);expect(result.stderr.toString()).toBe("");
  expect(receipt(result).detail).toContain("shellIntegration");expect(existsSync(f.config)).toBe(false);
});

test("noninteractive plugin output is bounded and cannot corrupt failure JSON",()=>{
  const f=fixture();
  writeFileSync(join(f.root,"tools/codex"),"#!/bin/sh\nhead -c 131072 /dev/zero\n",{mode:0o755});
  const result=f.run({plugins:{codex:["ponytail"]}});
  expect(result.exitCode).toBe(1);expect(result.stderr.toString()).toBe("");
  expect(receipt(result).error_class).toBe("setup_partial");
  expect(result.stdout.byteLength).toBeLessThan(4096);
});

test("new invalid notifier input is exit 1 even in the terminal collector",async()=>{
  const f=fixture();process.env=f.env;
  const answers=["skip","auto","command","not JSON"];
  expect(await setupMachine(async question=>{if(!answers.length)throw new Error(question);return answers.shift()!;},["codex"])).toBe(1);
  expect(existsSync(f.config)).toBe(false);
});

test("fullKit persists through the preserving writer and explicit No reaps optional links",()=>{
  const f=fixture('# keep this comment\nversion=3\n');mkdirSync(join(f.home,".hermes"));
  expect(f.run({fullKit:true,write:"apply"}).exitCode).toBe(0);
  expect(readFileSync(f.config,"utf8")).toContain('# keep this comment');
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).skills.full_kit).toBe(true);
  const path=join(f.home,".hermes/skills/tap-lead/SKILL.md");expect(readFileSync(path,"utf8")).toContain('name: tap-lead\n');
  const source=readFileSync(f.config,"utf8");expect(f.run({}).exitCode).toBe(0);expect(readFileSync(f.config,"utf8")).toBe(source);expect(existsSync(path)).toBe(true);
  expect(f.run({fullKit:false,write:"apply"}).exitCode).toBe(0);expect(existsSync(path)).toBe(false);expect(existsSync(join(f.home,".hermes/skills/tap/SKILL.md"))).toBe(true);
});
test("fullKit candidate and dry-run leave live links untouched, including saved true",()=>{
  const f=fixture('version=3\n[skills]\nfull_kit=false\n');mkdirSync(join(f.home,".hermes"));
  const file=join(f.root,"full-kit.json");writeFileSync(file,JSON.stringify({fullKit:true,write:"apply"}));
  const dry=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",file,"--dry-run","--json"],{env:f.env});
  expect(dry.exitCode).toBe(0);expect(receipt(dry).notes.join(" ")).toContain("skills.full_kit");expect(existsSync(join(f.home,".hermes/skills"))).toBe(false);
  expect(f.run({fullKit:true,write:"candidate"}).exitCode).toBe(0);expect(existsSync(join(f.home,".hermes/skills"))).toBe(false);expect(readFileSync(f.config,"utf8")).toContain('full_kit=false');
  expect(f.run({fullKit:true,write:"apply"}).exitCode).toBe(0);
  const lead=join(f.home,".hermes/skills/tap-lead");expect(existsSync(lead)).toBe(true);
  expect(f.run({fullKit:false,write:"candidate",replaceCandidate:true}).exitCode).toBe(0);expect(existsSync(lead)).toBe(true);
  // A repeat explicit preference reconciles a missing link even without TOML changes.
  rmSync(lead);expect(f.run({fullKit:true}).exitCode).toBe(0);expect(existsSync(lead)).toBe(true);
});
test("default terminal full-kit No hides plugin prompts and saves the explicit preference",async()=>{
  const f=fixture();process.env=f.env;const questions:string[]=[];
  expect(await setupMachine(async question=>{questions.push(question);return question.startsWith("Add shell")?"n":"";},["codex"])).toBe(0);
  expect(questions.find(q=>q.startsWith("Install the optional full"))).toContain("[y/N]");
  expect(questions.some(q=>q.startsWith("Install ponytail"))).toBe(false);
  expect((Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).skills.full_kit).toBe(false);
});

test("Cursor and AGY permissions are answerable; omitting them keeps the bypass default (tap-6c1me)",()=>{
  const f=fixture();
  expect(f.run({harnesses:{cursor:{presets:"skip",permissions:"auto"},agy:{presets:"skip",permissions:"bypass"}},write:"apply"}).exitCode).toBe(0);
  let harness=(Bun.TOML.parse(readFileSync(f.config,"utf8")) as any).harness;
  expect(harness.cursor.permissions).toBe("auto");expect(harness.agy.permissions).toBe("bypass");
  const g=fixture();
  expect(g.run({harnesses:{cursor:{presets:"skip"}},write:"apply"}).exitCode).toBe(0);
  if(existsSync(g.config))expect((Bun.TOML.parse(readFileSync(g.config,"utf8")) as any).harness?.cursor?.permissions).toBeUndefined();
  expect(g.run({harnesses:{opencode:{presets:"skip",permissions:"auto"}},write:"apply"}).exitCode).not.toBe(0);
});

test("choosing auto turns off a legacy Cursor/AGY bypass param so launches are not refused (tap-6c1me)",()=>{
  const f=fixture('version = 3\n\n[harness.cursor]\npermissions = "bypass"\nparams.yolo = true\n\n[harness.agy.params]\ndangerously-skip-permissions = true\n');
  const r=f.run({harnesses:{cursor:{presets:"skip",permissions:"auto"},agy:{presets:"skip",permissions:"auto"}},write:"apply"});
  expect(r.exitCode,r.stdout.toString()+r.stderr.toString()).toBe(0);
  const {harness}=Bun.TOML.parse(readFileSync(f.config,"utf8")) as any;
  expect(harness.cursor).toEqual({permissions:"auto",params:{yolo:false}});
  expect(harness.agy).toEqual({permissions:"auto",params:{"dangerously-skip-permissions":false}});
  // Bypass leaves the old param alone: it agrees with the launcher's own flags.
  const g=fixture('version = 3\n\n[harness.cursor]\nparams.yolo = true\n');
  expect(g.run({harnesses:{cursor:{presets:"skip",permissions:"bypass"}},write:"apply"}).exitCode).toBe(0);
  expect((Bun.TOML.parse(readFileSync(g.config,"utf8")) as any).harness.cursor.params.yolo).toBe(true);
});

test("full-kit answers summarize links, keep preserved changes visible, and offer verbose detail",()=>{
  const f=fixture('version=3\n');mkdirSync(join(f.home,".hermes/skills/tap-lead"),{recursive:true});
  writeFileSync(join(f.home,".hermes/skills/tap-lead/SKILL.md"),"personal");
  const quiet=f.run({fullKit:true,write:"apply"});
  expect(quiet.exitCode).toBe(0);expect(receipt(quiet).exit_code).toBe(0);
  const output=quiet.stderr.toString();
  expect(output).toMatch(/install: \d+ skill links refreshed across 1 homes \(full kit\)/);
  expect(output).toContain("preserved Hermes skill tap-lead");
  expect(output).not.toContain("install: linked Hermes skill");
  expect(output).not.toContain("install: skipped");
  expect(output).toContain("--verbose");
  const verbose=Bun.spawnSync([join(repo,"bin/tap"),"setup","--machine","--answers",join(f.root,"answers.json"),"--verbose","--json"],{env:f.env,stdin:"ignore",timeout:5000});
  expect(verbose.exitCode).toBe(0);expect(receipt(verbose).exit_code).toBe(0);
  expect(verbose.stderr.toString()).toContain("install: linked Hermes skill");
  expect(verbose.stderr.toString()).toContain("preserved Hermes skill tap-lead");
  expect(readFileSync(join(f.home,".hermes/skills/tap-lead/SKILL.md"),"utf8")).toBe("personal");
});
