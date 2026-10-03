import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Public inspection and cancellation preserve the live Bash spool's custody.
const MAIN_TS = join(import.meta.dir, "..", "main.ts");

function makeHome(): { root: string; spoolDir: string; payloadsDir: string; indexDir: string; lockDir: string } {
  const root = mkdtempSync(join(tmpdir(), "tap-spool-preserve."));
  mkdirSync(join(root, "payloads"));
  mkdirSync(join(root, "receipts"));
  mkdirSync(join(root, "spool"));
  const indexDir = mkdtempSync(join(tmpdir(), "tap-spool-preserve-index."));
  writeFileSync(join(indexDir, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: {} }));
  const lockDir = mkdtempSync(join(tmpdir(), "tap-spool-preserve-locks."));
  return {
    root,
    spoolDir: join(root, "spool"),
    payloadsDir: join(root, "payloads"),
    indexDir,
    lockDir,
  };
}

function plantPair(
  home: ReturnType<typeof makeHome>,
  id: string,
  meta: Record<string, unknown>,
  from = "alice",
): void {
  const body = join(home.spoolDir, `${id}.md`);
  writeFileSync(
    body,
    `---\nid: ${id}\nfrom: ${from}\nto: peer\nkind: discuss\nreply: settle-only\npath: ${body}\n---\nlegacy body ${id}\n`,
  );
  writeFileSync(join(home.spoolDir, `${id}.meta.json`), `${JSON.stringify({
    id,
    target: "peer",
    team: "beta",
    to_team: "beta",
    target_registry: join(home.root, "registry.json"),
    pane: "sess:0.0",
    pane_id: "%401",
    policy: "standard",
    reason: "busy",
    reason_class: "busy",
    deadline_source: "readiness-gate",
    first_spooled_epoch: 1788000000,
    deadline_epoch: 1788000300,
    hold_until_epoch: null,
    ...meta,
  }, null, 2)}\n`);
}

function runSpool(
  home: ReturnType<typeof makeHome>,
  argv: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { rc: number | null; out: string; err: string } {
  const child = spawnSync(process.execPath, [MAIN_TS, "spool", ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      TAP_HOME: home.root,
      TAP_INDEX_HOME: home.indexDir,
      TAP_LOCK_DIR: home.lockDir,
      ...extraEnv,
    },
  });
  return { rc: child.status, out: child.stdout ?? "", err: child.stderr ?? "" };
}

function ownerLockPresent(spoolDir: string): boolean {
  return existsSync(join(spoolDir, "owner.lock")) || readdirSync(spoolDir).includes("owner.lock");
}

  test("public tap spool list/status/cancel leave a live Bash pair byte-identical (Fable option B)", () => {
    const home = makeHome();
    const id = "seat-20260831T000000Z-keep01";
    plantPair(home, id, {});
    const bodyPath = join(home.spoolDir, `${id}.md`);
    const metaPath = join(home.spoolDir, `${id}.meta.json`);
    const bodyBytes = readFileSync(bodyPath);
    const metaBytes = readFileSync(metaPath);
    const snapshot = () => ({
      body: readFileSync(bodyPath),
      meta: readFileSync(metaPath),
      intent: existsSync(join(home.spoolDir, `${id}.json`)),
      canonical: existsSync(join(home.payloadsDir, `${id}.md`)),
      archiveBody: existsSync(join(home.spoolDir, "legacy", `${id}.md`)),
      archiveMeta: existsSync(join(home.spoolDir, "legacy", `${id}.meta.json`)),
      events: existsSync(join(home.root, "registry-events.log")) ? readFileSync(join(home.root, "registry-events.log"), "utf8") : "",
      ownerLock: ownerLockPresent(home.spoolDir),
    });

    const parseList = (out: string) => out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const firstList = runSpool(home, ["list", "--json"]);
    expect(firstList.rc).toBe(0);
    const firstRows = parseList(firstList.out);
    expect(firstRows).toEqual([{ class: "legacy_bash_parks", count: 1, detail: "Shared spool parks; use tap cancel --spooled" }]);
    const firstStatus = runSpool(home, ["status", "--json"]);
    expect(firstStatus.rc).toBe(0);
    const firstStatusRow = JSON.parse(firstStatus.out.trim()) as { intents: number; legacy_bash_parks: number; legacy_bash_parks_note: string };
    expect(firstStatusRow.intents).toBe(0);
    expect(firstStatusRow.legacy_bash_parks).toBe(1);
    expect(firstStatusRow.legacy_bash_parks_note).toContain("tap cancel --spooled");

    const secondList = runSpool(home, ["list", "--json"]);
    expect(secondList.rc).toBe(0);
    expect(parseList(secondList.out)).toEqual(firstRows);
    const secondStatus = runSpool(home, ["status", "--json"]);
    expect(secondStatus.rc).toBe(0);
    expect(JSON.parse(secondStatus.out.trim())).toEqual(JSON.parse(firstStatus.out.trim()));

    const afterInspect = snapshot();
    expect(afterInspect.body.equals(bodyBytes)).toBe(true);
    expect(afterInspect.meta.equals(metaBytes)).toBe(true);
    expect(afterInspect.intent).toBe(false);
    expect(afterInspect.canonical).toBe(false);
    expect(afterInspect.archiveBody).toBe(false);
    expect(afterInspect.archiveMeta).toBe(false);
    expect(afterInspect.events).toBe("");
    expect(afterInspect.ownerLock).toBe(false);

    const cancel = runSpool(home, ["cancel", id], { TAP_SELF: "alice" });
    expect(cancel.rc).not.toBe(0);
    expect(cancel.err).toContain("Bash park — use tap cancel --spooled");
    // The advice is the complete command, and the cancel parser accepts it:
    // run against an empty bus, it reaches the residency refusal, whose own
    // advice is a read-only lookup that parses too. Nothing here mutates.
    const advised = /next: (tap cancel \S+ --spooled --by alice(?: --team \S+)?)\s*$/m.exec(cancel.err)?.[1];
    expect(advised).toStartWith(`tap cancel ${id} --spooled --by alice`);
    const empty = makeHome();
    const tap = (argv: string[]) => spawnSync(process.execPath, [MAIN_TS, ...argv], {
      encoding: "utf8",
      env: { ...process.env, TAP_HOME: empty.root, TAP_INDEX_HOME: empty.indexDir, TAP_LOCK_DIR: empty.lockDir },
    });
    const replay = tap(advised!.split(" ").slice(1));
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain("no local payload");
    // The lookup keeps the bus cancel selected, so it cannot show another bus's same id.
    const shown = new RegExp(`next: tap show ((?:[A-Za-z0-9][A-Za-z0-9._-]*/)?${id})\\s*$`, "m").exec(replay.stderr)?.[1];
    expect(shown).toBeDefined();
    expect(replay.stderr).not.toContain("tap send <id>");
    const lookup = tap(["show", shown!]);
    expect(lookup.stderr).not.toMatch(/usage_error|unknown_option/);
    expect(readdirSync(empty.payloadsDir)).toEqual([]);
    expect(readdirSync(join(empty.root, "receipts"))).toEqual([]);
    const afterCancel = snapshot();
    expect(afterCancel.body.equals(bodyBytes)).toBe(true);
    expect(afterCancel.meta.equals(metaBytes)).toBe(true);
    expect(afterCancel.intent).toBe(false);
    expect(afterCancel.canonical).toBe(false);
  });
