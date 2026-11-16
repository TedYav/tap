import { afterEach, expect, test } from "bun:test";
import { writeDigestIndex } from "../src/digest-index";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSentinel as renderUnchecked, assertSentinelWire, parseSentinel } from "../src/sentinel";

// Run every existing constructor case through the delivery gate.
const renderSentinel: typeof renderUnchecked = fields => {
  const wire = renderUnchecked(fields);
  assertSentinelWire(wire);
  return wire;
};

const previous = process.env.XDG_CONFIG_HOME;
const roots: string[] = [];
afterEach(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function setup(enabled: boolean, text = "Requesting gate authorization") {
  const root = mkdtempSync(join(tmpdir(), "preview-")); roots.push(root);
  process.env.XDG_CONFIG_HOME = root; mkdirSync(join(root,"tap"));
  const config = join(root,"tap/config.toml");
  writeFileSync(config, `[sentinel]\npreview = ${enabled}\n`);
  const path = join(root,"message.md");
  writeFileSync(path, `---\nid: message\nsentinel_preview: ${Buffer.from(text).toString("base64")}\n---\nBody is separate\n`);
  return {config, path, fields:{from:"alice",to:"bob",id:"message",kind:"discuss",reply:"expected",path}};
}
test("off is byte-identical; render reads toggle again after queueing", () => {
  const {fields, config} = setup(false);
  expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
  writeFileSync(config,"[sentinel]\npreview = true\n");
  expect(renderSentinel(fields)).toBe('[[TAP v0.23 ask message preview="Requesting gate authorization"]]');
  expect(renderSentinel({...fields,reply:"settle-only"})).toContain('note message preview=');
  expect(renderSentinel({...fields,path:"/missing"})).toBe("[[TAP v0.23 ask message]]");
});
test("unsafe preview cannot close the sentinel or add a line", () => {
  for (const text of ["danger ]] tail", "two\nlines", "tab\there", "escape\x1b"]) {
    const {fields} = setup(true, text); expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
  }
});
test("long unicode previews truncate at a word boundary within 240 bytes", () => {
  const {fields} = setup(true, "éclair ".repeat(80));
  const wire = renderSentinel(fields);
  const text = JSON.parse(wire.slice(wire.indexOf("preview=")+8,-2));
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(240);
  expect(text.endsWith("éclair")).toBe(true); expect(text).not.toContain("�");
});
test("pointer and digest previews stay marked and per-item", () => {
  const {fields,path} = setup(true);
  expect(renderSentinel({...fields,from:"one/alice"})).toContain('preview="Requesting gate authorization" path=');
  const index = path + ".json"; writeFileSync(index,JSON.stringify({items:[{id:"message",path}]}));
  const wire = renderSentinel({...fields,kind:"digest",path:index});
  expect(wire).toContain('preview(message)="Requesting gate authorization"');
  expect(wire).not.toContain(' preview=');
  expect(parseSentinel(wire)).not.toBeNull();
  expect(parseSentinel("[[TAP v0.23 ask message]]")).not.toBeNull();
});

test("preview text cannot supply identity or confuse the stuck-wire parser", async () => {
  const { pendingSentinel } = await import("../src/deliver");
  for (const tail of ['preview="Status: id=decoy to=other"', 'pre\nview="Status: id=decoy"', 'preview(message)="A \\"quote\\"" preview(second)="Next item"']) {
    expect(pendingSentinel(`[[TAP v0.23 ask message ${tail}]]`,"claude")).toEqual({id:"message",to:""});
  }
});

test("digest renders previews from spooled items before canonical move", () => {
  const {config} = setup(true);
  const root = join(config,"../..");
  const bus = join(root,"bus");
  mkdirSync(join(bus,"spool"),{recursive:true});
  mkdirSync(join(bus,"payloads"));
  for (const [id,text] of [["first","First item"],["second","Second item"]]) {
    writeFileSync(join(bus,"spool",`${id}.md`),`---\nid: ${id}\nfrom: alice\nto: bob\nkind: discuss\nreply: expected\nsentinel_preview: ${Buffer.from(text!).toString("base64")}\n---\nbody\n`);
  }
  const index = join(bus,"spool/digests/batch.json");
  // Exercise the native index and renderer used by digest delivery.
  writeDigestIndex({ indexPath:index, digestId:"batch", toTeam:"team", handle:"bob", courier:"courier",
    spoolDir:join(bus,"spool"), payloadsDir:join(bus,"payloads"),
    members:[{id:"first",presettled:false},{id:"second",presettled:false}] });
  expect(renderSentinel({from:"team/courier",to:"team/bob",id:"batch",kind:"digest",reply:"settle-only",path:index}))
    .toBe('[[TAP v0.23 note batch digest preview(first)="First item" preview(second)="Second item"]]');
});

test("missing config preserves the wire without a preview", () => {
  const {fields, config} = setup(true);
  rmSync(config);
  expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
});

test("derived first body line is render-time only and explicit text wins", async () => {
 const {payloadPreview} = await import("../src/sentinel-preview");
 const {path,fields,config} = setup(true);
 const raw = "---\nid: message\nsubject: Envelope is not body\n---\n\n  First body line  \nSecond line\n";
 writeFileSync(path,raw);
 expect(payloadPreview(path)).toBe("First body line");
 expect(renderSentinel(fields)).toContain('preview="First body line"');
 expect(renderSentinel({...fields,from:"foreign/alice"})).toContain('preview="First body line" path=');
 expect(readFileSync(path,"utf8")).toBe(raw);
 writeFileSync(config,"[sentinel]\npreview = false\n");
 expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
 writeFileSync(config,"[sentinel]\npreview = true\n");
 writeFileSync(path,raw.replace("subject:", "sentinel_preview: " + Buffer.from("Explicit wins").toString("base64") + "\nsubject:"));
 expect(payloadPreview(path)).toBe("Explicit wins");
});

test("derived previews use 120 UTF-8 bytes or configured word boundary", async () => {
 const {payloadPreview} = await import("../src/sentinel-preview");
 const {path,config} = setup(true);
 writeFileSync(path,"---\nid: message\n---\n" + "éclair ".repeat(30));
 expect(payloadPreview(path)).toBe(Array(15).fill("éclair").join(" "));
 writeFileSync(config,"[sentinel]\npreview = true\npreview_chars = 15\n");
 expect(payloadPreview(path)).toBe("éclair éclair");
 writeFileSync(config,"[sentinel]\npreview = true\npreview_chars = 12\n");
 expect(payloadPreview(path)).toBe("éclair");
});

test("unsafe first body line is silently omitted, never replaced with a later line", async () => {
 const {payloadPreview} = await import("../src/sentinel-preview");
 for (const line of ["danger ]] end", "tab\there", "escape\x1b", "line\u2028separator", "a".repeat(121)]) {
  const {path,fields} = setup(true);
  writeFileSync(path,"---\nid: message\n---\n"+line+"\nSafe later line\n");
  expect(payloadPreview(path)).toBe("");
  expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
 }
});

test("digest derives each spooled item without storing derived hints", () => {
 const {config} = setup(true);
 const root = join(config,"../..");
 const bus = join(root,"bus");
 mkdirSync(join(bus,"spool"),{recursive:true}); mkdirSync(join(bus,"payloads"));
 for (const [id,text] of [["first","First derived item"],["second","Second derived item"]]) {
  writeFileSync(join(bus,"spool",`${id}.md`),`---\nid: ${id}\nfrom: alice\nto: bob\nkind: discuss\nreply: expected\n---\n\n${text}\n`);
 }
 const index = join(bus,"spool/digests/batch.json");
 writeDigestIndex({ indexPath:index, digestId:"batch", toTeam:"team", handle:"bob", courier:"courier",
   spoolDir:join(bus,"spool"), payloadsDir:join(bus,"payloads"),
   members:[{id:"first",presettled:false},{id:"second",presettled:false}] });
 expect(renderSentinel({from:"team/courier",to:"team/bob",id:"batch",kind:"digest",reply:"settle-only",path:index}))
  .toBe('[[TAP v0.23 note batch digest preview(first)="First derived item" preview(second)="Second derived item"]]');
 expect(readFileSync(index,"utf8")).not.toContain("sentinel_preview");
});

test("digest listings derive from the current canonical body, with explicit item hints winning", async () => {
 const {digestPlan} = await import("../src/digest-items");
 const {path} = setup(true);
 writeFileSync(path,"---\nid: message\n---\nCurrent canonical body\n");
 const input = {doc:{kind:"digest",digest_id:"batch",items:[{id:"message",path}]},path:path+".json",verb:"read" as const,all:false,selected:"",verbose:false};
 expect(digestPlan(input).lines.join("\n")).toContain('preview="Current canonical body"');
 (input.doc.items[0] as any).sentinel_preview = Buffer.from("Explicit item").toString("base64");
 expect(digestPlan(input).lines.join("\n")).toContain('preview="Explicit item"');
});

test("direct renderer derives at render time and respects the disabled toggle", () => {
 const {path,config,fields} = setup(true);
 writeFileSync(path,"---\nid: message\n---\nDerived direct body\n");
 expect(renderSentinel(fields)).toBe('[[TAP v0.23 ask message preview="Derived direct body"]]');
 writeFileSync(config,"[sentinel]\npreview = false\n");
 expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
});

test("renderer keeps old bytes when HOME and XDG_CONFIG_HOME are unset", () => {
 const {path} = setup(true);
 writeFileSync(path,"---\nid: message\n---\nDerived body\n");
 const env: NodeJS.ProcessEnv = {...process.env};
 delete env.HOME; delete env.XDG_CONFIG_HOME;
 const out = Bun.spawnSync([process.execPath,join(import.meta.dir,"support/sentinel-render-cli.ts"),
  "alice","bob","message","discuss","expected","",path], {env,stdout:"pipe",stderr:"pipe"});
 expect({status:out.exitCode,out:out.stdout.toString(),err:out.stderr.toString()}).toEqual({status:0,out:"[[TAP v0.23 ask message]]",err:""});
});

// tap-zlfg5: a sender's rejected --preview is stamped `sentinel_preview: -`
// (PREVIEW_SUPPRESSED); no reader may fall back to deriving from the body.
test("a suppressed explicit hint renders no preview on the direct, digest and listing paths", async () => {
 const {PREVIEW_SUPPRESSED, payloadPreview, decodePreview} = await import("../src/sentinel-preview");
 const {digestPlan} = await import("../src/digest-items");
 expect(decodePreview(PREVIEW_SUPPRESSED)).toBe("");
 const {path,fields,config} = setup(true);
 const root = join(config,"../..");
 writeFileSync(path,`---\nid: message\nsentinel_preview: ${PREVIEW_SUPPRESSED}\n---\nDerivable first line\n`);
 expect(payloadPreview(path)).toBe("");
 expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
 // Control: the same body without the field still derives.
 const bare = join(root,"bare.md");
 writeFileSync(bare,"---\nid: message\n---\nDerivable first line\n");
 expect(renderSentinel({...fields,path:bare})).toBe('[[TAP v0.23 ask message preview="Derivable first line"]]');
 // Digest: the index copies the marker, and neither render nor listing derives.
 const bus = join(root,"bus");
 mkdirSync(join(bus,"spool"),{recursive:true}); mkdirSync(join(bus,"payloads"));
 const head = (id: string, extra: string) => `---\nid: ${id}\nfrom: alice\nto: bob\nkind: discuss\nreply: expected\n${extra}---\nDerivable ${id} line\n`;
 writeFileSync(join(bus,"spool/rejected.md"), head("rejected", `sentinel_preview: ${PREVIEW_SUPPRESSED}\n`));
 writeFileSync(join(bus,"spool/plain.md"), head("plain", ""));
 const index = join(bus,"spool/digests/batch.json");
 writeDigestIndex({ indexPath:index, digestId:"batch", toTeam:"team", handle:"bob", courier:"courier",
   spoolDir:join(bus,"spool"), payloadsDir:join(bus,"payloads"),
   members:[{id:"rejected",presettled:false},{id:"plain",presettled:false}] });
 expect(JSON.parse(readFileSync(index,"utf8")).items[0].sentinel_preview).toBe(PREVIEW_SUPPRESSED);
 expect(renderSentinel({from:"team/courier",to:"team/bob",id:"batch",kind:"digest",reply:"settle-only",path:index}))
  .toBe('[[TAP v0.23 note batch digest preview(plain)="Derivable plain line"]]');
 const rejectedPath = join(bus,"payloads/rejected.md");
 writeFileSync(rejectedPath, head("rejected", `sentinel_preview: ${PREVIEW_SUPPRESSED}\n`));
 const input = {doc:{kind:"digest",digest_id:"batch",items:[{id:"rejected",path:rejectedPath,sentinel_preview:PREVIEW_SUPPRESSED}]},path:index,verb:"read" as const,all:false,selected:"",verbose:false};
 expect(digestPlan(input).lines.join("\n")).not.toContain("preview=");
});

test("stampPreview: absent without the flag; encoded when safe; the token when rejected", async () => {
 const {stampPreview, PREVIEW_SUPPRESSED} = await import("../src/sentinel-preview");
 setup(true);
 expect(stampPreview(false, "")).toBeUndefined();
 expect(stampPreview(false, "ignored")).toBeUndefined();
 expect(stampPreview(true, "Fine hint")).toBe(Buffer.from("Fine hint").toString("base64"));
 for (const bad of ["unsafe ]] hint", "", "   ", "x".repeat(300)]) expect(stampPreview(true, bad)).toBe(PREVIEW_SUPPRESSED);
});

test("rawPreview reads a stored hint with the toggle off; decodePreview does not", async () => {
  const { rawPreview, decodePreview } = await import("../src/sentinel-preview");
  setup(false);
  const hint = Buffer.from("Gate authorization").toString("base64");
  expect(rawPreview(hint)).toBe("Gate authorization");
  expect(decodePreview(hint)).toBe("");
  expect(rawPreview("-")).toBe("");
  expect(rawPreview("not*base64")).toBe("");
});

// tap-7r3fn.208: OpenCode opens its mention/command picker for a token-initial `@`
// or `/` typed into the composer, and the picker swallows the submit Enter. The
// wire is recipient-agnostic, so the contract is too: no rendered hint carries one.
function previewOf(wire: string): string {
  return JSON.parse(wire.slice(wire.indexOf("preview=") + 8, -2));
}
function derived(body: string) {
  const {fields, path} = setup(true);
  writeFileSync(path, `---\nid: message\n---\n${body}\n`);
  return fields;
}
const PICKER_TRIGGER = /(^|\s)[@/]/;

test("the 2026-10-02 specimen: a trailing token-initial @ never reaches the wire", () => {
  const text = "sonnet-qx7k2-reviewer — assessment of the conductor's fail-closed edge on tap#2312 @";
  const {fields} = setup(true, text);
  const wire = renderSentinel(fields);
  expect(wire).not.toMatch(/ @/);
  expect(previewOf(wire)).toBe("sonnet-qx7k2-reviewer — assessment of the conductor's fail-closed edge on tap#2312");
});

test("explicit, derived and digest-item hints are all picker-safe", () => {
  const explicit = setup(true, "ask @codex review /tmp/x then @ 7f1c2d");
  expect(previewOf(renderSentinel(explicit.fields))).toBe("ask codex review tmp/x then 7f1c2d");
  expect(previewOf(renderSentinel(derived("@codex review the // diff")))).toBe("codex review the diff");
  const {fields, path} = setup(true, "gate @ green");
  const index = path + ".json"; writeFileSync(index, JSON.stringify({items:[{id:"message",path}]}));
  expect(renderSentinel({...fields,kind:"digest",path:index})).toContain('preview(message)="gate green"');
});

test("picker-safe hints keep ordinary text byte-for-byte", () => {
  for (const text of ["Requesting gate authorization", "mail user@host about a/b and tap#2312", "100% done: x=1"]) {
    const {fields} = setup(true, text);
    expect(previewOf(renderSentinel(fields))).toBe(text);
  }
});

test("a hint that is only trigger tokens renders no preview", () => {
  const {fields} = setup(true, "@ / @@");
  expect(renderSentinel(fields)).toBe("[[TAP v0.23 ask message]]");
});

test("no rendered wire holds a token-initial @ or / (neutralization is a fixed point)", () => {
  for (const text of ["@@a //b @/c /@d x @ y", " @lead", "end @", "a @b", "tab /x"]) {
    const {fields} = setup(true, text);
    const wire = renderSentinel(fields);
    const hint = wire.includes("preview=") ? previewOf(wire) : "";
    expect(hint).not.toMatch(PICKER_TRIGGER);
  }
});

test("a note body with a picker trigger takes the read path; the body is never rewritten", () => {
  const {fields, path} = setup(false);
  const body = "@codex review tap#2312";
  writeFileSync(path, `---\nid: message\n---\n${body}\n`);
  const note = {...fields, reply: "settle-only", body};
  expect(renderSentinel(note)).toBe("[[TAP v0.23 note message]]");
  expect(readFileSync(path, "utf8")).toContain(`\n${body}\n`);
  expect(renderSentinel({...note, body: "see /tmp/x"})).toBe("[[TAP v0.23 note message]]");
  expect(renderSentinel({...note, body: "mail user@host or a/b"})).toBe("[[TAP v0.23 note message: mail user@host or a/b]]");
});
