import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { composeReplyAlias } from "../main";
import { removeScratchTree } from "./support/scratch";

const scratch: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = ["TAP_HOME", "TAP_INDEX_HOME", "TAP_ASSIGN_VERB"] as const;

afterEach(() => {
  for (const path of scratch.splice(0)) removeScratchTree(path);
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  savedEnv.clear();
});

function pinEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const FOREIGN_ID = "foreign-sender-20260828T000000Z-k1x5u0abcdef";
const LOCAL_ID = "local-sender-20260828T000000Z-a1b2c3d4e5f6";

interface World {
  localBus: string;
  index: string;
  bodyFile: string;
  foreignPayload: string;
}

function buildWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), "tap-reply-alias-payload."));
  scratch.push(dir);
  const localBus = join(dir, "bus");
  const foreignRoot = join(dir, "foreign-root");
  const foreignBus = join(foreignRoot, ".tap", "bus");
  const index = join(dir, "index");
  mkdirSync(join(localBus, "payloads"), { recursive: true });
  mkdirSync(join(foreignBus, "payloads"), { recursive: true });
  mkdirSync(index, { recursive: true });
  writeFileSync(
    join(index, "global-registry.json"),
    JSON.stringify({
      schema: "0.20",
      teams: {
        "foreign-team": {
          root: foreignRoot,
          registry_location: join(foreignRoot, ".tap", "team-registry.json"),
          state: "registered",
        },
      },
    }) + "\n",
  );
  const envelope = (id: string, from: string, path: string) =>
    `---\nid: ${id}\nfrom: ${from}\nto: receiver\nkind: discuss\nreply: expected\npath: ${path}\n---\ninbound body\n`;
  const foreignPayload = join(foreignBus, "payloads", `${FOREIGN_ID}.md`);
  writeFileSync(foreignPayload, envelope(FOREIGN_ID, "foreign-sender", foreignPayload));
  const localPayload = join(localBus, "payloads", `${LOCAL_ID}.md`);
  writeFileSync(localPayload, envelope(LOCAL_ID, "local-sender", localPayload));
  const bodyFile = join(dir, "body.md");
  writeFileSync(bodyFile, "the reply body\n");
  return { localBus, index, bodyFile, foreignPayload };
}

describe("composeReplyAlias payload pinning", () => {
  test("an id found only through the machine index pins the foreign payload with --payload", () => {
    const world = buildWorld();
    pinEnv("TAP_HOME", world.localBus);
    pinEnv("TAP_INDEX_HOME", world.index);
    pinEnv("TAP_ASSIGN_VERB", undefined);
    const argv = composeReplyAlias(["foreign-sender", "--reply-to", FOREIGN_ID, "-f", world.bodyFile]);
    expect(argv).not.toBeNull();
    const at = argv!.indexOf("--payload");
    expect(at).toBeGreaterThan(0);
    expect(argv!.slice(at, at + 2)).toEqual(["--payload", realpathSync(world.foreignPayload)]);
    expect(argv![0]).toBe(FOREIGN_ID);
  });

  test("a 12-hex suffix alias pins with the canonical id, not the suffix", () => {
    // reply's explicit-payload check requires the reference to equal the
    // pinned file's id, so passing the suffix would refuse.
    const world = buildWorld();
    const suffixId = "foreign-sender-20260828T000000Z-0123456789ab";
    const suffixPayload = join(dirname(world.foreignPayload), `${suffixId}.md`);
    writeFileSync(suffixPayload,
      `---\nid: ${suffixId}\nfrom: foreign-sender\nto: receiver\nkind: discuss\nreply: expected\npath: ${suffixPayload}\n---\ninbound body\n`);
    pinEnv("TAP_HOME", world.localBus);
    pinEnv("TAP_INDEX_HOME", world.index);
    pinEnv("TAP_ASSIGN_VERB", undefined);
    const argv = composeReplyAlias(["foreign-sender", "--reply-to", "0123456789ab", "-f", world.bodyFile]);
    expect(argv).not.toBeNull();
    expect(argv![0]).toBe(suffixId);
    const at = argv!.indexOf("--payload");
    expect(argv!.slice(at, at + 2)).toEqual(["--payload", realpathSync(suffixPayload)]);
  });

  test("an id present on the caller's own bus composes no --payload", () => {
    const world = buildWorld();
    pinEnv("TAP_HOME", world.localBus);
    pinEnv("TAP_INDEX_HOME", world.index);
    pinEnv("TAP_ASSIGN_VERB", undefined);
    const argv = composeReplyAlias(["local-sender", "--reply-to", LOCAL_ID, "-f", world.bodyFile]);
    expect(argv).not.toBeNull();
    expect(argv).not.toContain("--payload");
    expect(argv![0]).toBe(LOCAL_ID);
  });

  // tap-zlfg5: reply reads --preview's presence as the sender's intent, so the
  // alias forwards it only when given: omitted derives, even blank suppresses.
  for (const [route, from, id] of [["local", "local-sender", LOCAL_ID], ["foreign", "foreign-sender", FOREIGN_ID]] as const) {
    test(`${route} alias forwards --preview only when the caller gave it`, () => {
      const world = buildWorld();
      pinEnv("TAP_HOME", world.localBus);
      pinEnv("TAP_INDEX_HOME", world.index);
      pinEnv("TAP_ASSIGN_VERB", undefined);
      const base = [from, "--reply-to", id, "-f", world.bodyFile];
      expect(composeReplyAlias(base)).not.toContain("--preview");
      for (const hint of ["", "   ", "bad ]] hint", "x".repeat(300), "A fine hint"]) {
        const argv = composeReplyAlias([...base, "--preview", hint])!;
        const at = argv.indexOf("--preview");
        expect(argv.slice(at, at + 2)).toEqual(["--preview", hint]);
      }
    });
  }
});
