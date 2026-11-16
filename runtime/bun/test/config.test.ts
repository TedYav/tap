/**
 * tap config get|set|path — round-trip-safe machine-config verb. Every case
 * runs through bin/tap so native routing is part of the control, with an
 * isolated XDG_CONFIG_HOME owning the whole machine-config surface.
 */
import { afterAll, expect, test } from "bun:test";
import { closeSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { acquireNoFollowLock } from "../src/digest-window";
import { lookupHelp } from "../src/help";
import { TOP_LEVEL_KEYS } from "../src/launcher/catalog-listing";
import { serializeToml } from "../src/verbs/machine";
import { DEFAULTS, EFFECTS } from "../src/verbs/config";
import { injectionBehavior } from "../src/injection-behavior";

const root = resolve(import.meta.dir, "../../..");
const tapBin = join(root, "bin/tap");
const work = mkdtempSync(join(tmpdir(), "tap-config-verb-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let index = 0;

function run(args: string[], xdg: string, env: NodeJS.ProcessEnv = {}) {
  return Bun.spawnSync([tapBin, "config", ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: xdg, ...env },
    cwd: work,
  });
}

function fixture(text?: string, mode = 0o600): string {
  const dir = join(work, String(index++));
  if (text !== undefined) {
    mkdirSync(join(dir, "tap"), { recursive: true });
    writeFileSync(join(dir, "tap/config.toml"), text, { mode });
    chmodSync(join(dir, "tap/config.toml"), mode);
  }
  return dir;
}

const pathOf = (dir: string) => join(dir, "tap/config.toml");

test("operator opt-in and age defaults are visible without creating a config", () => {
  const dir = fixture();
  for (const [key, value] of [["recovery.operator", "off"], ["recovery.operator_after", "20m"]]) {
    const result = run(["get", key!, "--json"], dir);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ key, value, source: "default" });
  }
  expect(existsSync(pathOf(dir))).toBe(false);
});

test("notification argv round-trips through the locked config editor without touching neighboring values", () => {
  const original = '# keep\n[notifications]\nnotifier = "system" # selected\ncommand = ["old", "#literal"] # argv\n\n[other]\nvalue = "unchanged"\n';
  const dir = fixture(original);
  const args = '["/path with spaces/notify", "--", "{body}", "literal # $() `x`"]';
  const set = run(["set", "notifications.command", args], dir);
  expect(set.exitCode, set.stderr.toString()).toBe(0);
  expect(set.stdout.toString()).toContain("next escalation");
  expect(JSON.parse(run(["get", "notifications.command"], dir).stdout.toString())).toEqual(JSON.parse(args));
  expect(readFileSync(pathOf(dir), "utf8")).toBe(original.replace('["old", "#literal"]', JSON.stringify(JSON.parse(args))));
  const before = readFileSync(pathOf(dir), "utf8");
  for (const invalid of ["not an array", "[1]", '[]', '[""]', '["unterminated]']) {
    expect(run(["set", "notifications.command", invalid], dir).exitCode).toBe(1);
    expect(readFileSync(pathOf(dir), "utf8")).toBe(before);
  }
});

const rich = `version = 3  # machine catalog
# presets live below

[presets.alpha]
harness = "claude"
params.model = "opus"          # tuned
description = "alpha preset"

[harness.claude]
permissions = "bypass"

[sentinel]
preview = false  # display hints
`;

test("leaf help bypasses config resolution and parsing without effects", () => {
  for (const text of [undefined, rich, "invalid [[["]) {
    const dir = fixture(text);
    for (const leaf of ["path", "get", "set"]) {
      for (const flag of ["--help", "-h"]) {
        const result = run([leaf, flag], dir);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe(lookupHelp(["config", leaf]).stdout);
        expect(result.stdout.toString()).toContain(`tap config ${leaf}`);
        expect(result.stderr.toString()).toBe("");
        expect(existsSync(pathOf(dir))).toBe(text !== undefined);
        if (text !== undefined) expect(readFileSync(pathOf(dir), "utf8")).toBe(text);
        expect(existsSync(`${pathOf(dir)}.lock`)).toBe(false);
      }
      const invalidPath = run([leaf, "--help"], "relative", { HOME: "relative" });
      expect(invalidPath.exitCode).toBe(0);
      expect(invalidPath.stdout.toString()).toBe(lookupHelp(["config", leaf]).stdout);
      expect(invalidPath.stderr.toString()).toBe("");
    }
  }
});

test("path prints the resolved file and refuses trailing arguments", () => {
  const dir = fixture();
  const ok = run(["path"], dir);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toBe(`${pathOf(dir)}\n`);
  const extra = run(["path", "junk"], dir);
  expect(extra.exitCode).toBe(1);
  expect(extra.stderr.toString()).toContain("unexpected argument 'junk'");
});

test("get reads scalars: booleans, dotted-in-table keys, and the reference catalog", () => {
  const dir = fixture(rich);
  expect(run(["get", "sentinel.preview"], dir).stdout.toString()).toBe("false\n");
  expect(run(["get", "presets.alpha.params.model"], dir).stdout.toString()).toBe('"opus"\n');
  expect(run(["get", "version"], dir).stdout.toString()).toBe("3\n");

  const reference = fixture(readFileSync(join(root, "skills/tap/config/config.v3.toml"), "utf8"));
  expect(run(["get", "sentinel.preview"], reference).stdout.toString()).toBe("false\n");
  expect(run(["get", "harness.agy.permissions"], reference).stdout.toString()).toBe('"auto"\n');
});

test("set replaces only the target line: comments, spacing, and unrelated tables survive byte-for-byte", () => {
  const dir = fixture(rich);
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(
    "tap config: sentinel.preview: false -> true\ntap config: takes effect on the next delivery\n");
  expect(readFileSync(pathOf(dir), "utf8")).toBe(rich.replace(
    "preview = false  # display hints",
    "preview = true  # display hints"));
});

test("set edits a dotted-in-table key line in place", () => {
  const dir = fixture(rich);
  const result = run(["set", "presets.alpha.params.model", "sonnet"], dir);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toBe(rich.replace(
    'params.model = "opus"          # tuned',
    'params.model = "sonnet"          # tuned'));
  expect(run(["get", "presets.alpha.params.model"], dir).stdout.toString()).toBe('"sonnet"\n');
});

test("set quotes strings, passes booleans and integers through, and round-trips via get", () => {
  const dir = fixture(rich);
  expect(run(["set", "harness.claude.permissions", "ask"], dir).exitCode).toBe(0);
  expect(run(["get", "harness.claude.permissions"], dir).stdout.toString()).toBe('"ask"\n');
  expect(run(["set", "harness.claude.permissions", "keep spaces  # not a comment"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toContain('permissions = "keep spaces  # not a comment"');
  expect(run(["get", "harness.claude.permissions"], dir).stdout.toString()).toBe('"keep spaces  # not a comment"\n');
  expect(run(["set", "version", "4"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toContain("version = 4  # machine catalog");
  expect(run(["get", "version"], dir).stdout.toString()).toBe("4\n");
});

test("set inserts an absent key into its table and appends an absent table at the end", () => {
  const dir = fixture(rich);
  expect(run(["set", "sentinel.urgent", "false"], dir).exitCode).toBe(0);
  const withUrgent = readFileSync(pathOf(dir), "utf8");
  expect(withUrgent).toContain("[sentinel]\nurgent = false\npreview = false  # display hints");
  expect(run(["set", "roles.driver", "true"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toBe(`${withUrgent}\n[roles]\ndriver = true\n`);
  expect(run(["get", "roles.driver"], dir).stdout.toString()).toBe("true\n");
});

test("set inserts an absent bare top-level key before the first table header", () => {
  const dir = fixture(rich);
  expect(run(["set", "fresh", "5"], dir).exitCode).toBe(0);
  const text = readFileSync(pathOf(dir), "utf8");
  expect(text.indexOf("fresh = 5")).toBeLessThan(text.indexOf("[presets.alpha]"));
  expect(run(["get", "fresh"], dir).stdout.toString()).toBe("5\n");
});

test("set on a missing file creates it with the one table and reports (unset)", () => {
  const dir = fixture();
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(
    "tap config: sentinel.preview: (unset) -> true\ntap config: takes effect on the next delivery\n");
  expect(readFileSync(pathOf(dir), "utf8")).toBe("[sentinel]\npreview = true\n");
});

test("set preserves the file's permissions and refuses to write a parse failure", () => {
  const dir = fixture(rich, 0o644);
  expect(run(["set", "sentinel.preview", "true"], dir).exitCode).toBe(0);
  expect(statSync(pathOf(dir)).mode & 0o777).toBe(0o644);

  const broken = fixture("version = 3\ninvalid [[[\n");
  const result = run(["set", "sentinel.preview", "true"], broken);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("fails to parse; refusing to edit it");
  expect(readFileSync(pathOf(broken), "utf8")).toBe("version = 3\ninvalid [[[\n");
});

test("set refuses when the edit cannot land and writes nothing", () => {
  // A scalar cannot replace a table: the edit would not re-parse to the value.
  const dir = fixture(rich);
  const result = run(["set", "sentinel", "true"], dir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("would not re-parse");
  expect(readFileSync(pathOf(dir), "utf8")).toBe(rich);
});

test("get refusals name the missing file, the unset key, and non-scalar values", () => {
  const empty = fixture();
  const missing = run(["get", "mystery.key"], empty);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr.toString()).toContain("no machine config at");
  const dir = fixture(rich);
  const unset = run(["get", "sentinel.nope"], dir);
  expect(unset.exitCode).toBe(1);
  expect(unset.stderr.toString()).toContain("'sentinel.nope' is not set");
  const table = run(["get", "sentinel"], dir);
  expect(table.exitCode).toBe(1);
  expect(table.stderr.toString()).toContain("not a scalar");
  const broken = run(["get", "version"], fixture("nope ="));
  expect(broken.exitCode).toBe(1);
  expect(broken.stderr.toString()).toContain("fails to parse");
});

test("get on a fresh config prints a known key's default, marked, and exits 0", () => {
  const fresh = fixture(); // no config file at all
  const preview = run(["get", "sentinel.preview"], fresh);
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout.toString()).toBe("false (default)\n");
  expect(preview.stderr.toString()).toBe("");
  expect(run(["get", "injection.behavior"], fresh).stdout.toString()).toBe('"clobber" (default)\n');
  expect(run(["get", "delivery.now_window_seconds"], fresh).stdout.toString()).toBe("10 (default)\n");
  expect(JSON.parse(run(["get", "sentinel.preview", "--json"], fresh).stdout.toString()))
    .toEqual({ key: "sentinel.preview", value: false, source: "default" });
  expect(existsSync(pathOf(fresh))).toBe(false); // get never creates the file
});

test("get answers the default when the file exists but leaves the key unset, and the file wins when set", () => {
  const dir = fixture("[notifications]\ntimeout_seconds = 20\n");
  expect(run(["get", "sentinel.preview"], dir).stdout.toString()).toBe("false (default)\n");
  const set = fixture("[sentinel]\npreview = true\n");
  expect(run(["get", "sentinel.preview"], set).stdout.toString()).toBe("true\n");
  expect(JSON.parse(run(["get", "--json", "sentinel.preview"], set).stdout.toString()))
    .toEqual({ key: "sentinel.preview", value: true, source: "file" });
});

test("get still refuses unknown keys, keys with no single default, and malformed files", () => {
  const fresh = fixture();
  expect(run(["get", "sentinel.nope"], fresh).exitCode).toBe(1);
  expect(run(["get", "recovery.aggressiveness"], fresh).exitCode).toBe(1);
  // unset skills.full_kit means "keep installed optional skills", not false
  expect(run(["get", "skills.full_kit"], fresh).exitCode).toBe(1);
  expect(run(["get", "skills.full_kit"], fixture("[sentinel]\npreview = true\n")).exitCode).toBe(1);
  expect(run(["get", "recovery.aggressiveness"], fixture("[sentinel]\npreview = true\n")).stderr.toString())
    .toContain("is not set");
  const broken = run(["get", "sentinel.preview"], fixture("nope ="));
  expect(broken.exitCode).toBe(1);
  expect(broken.stderr.toString()).toContain("fails to parse");
});

test("get answers a default only for a genuinely absent config, never for an unreachable one", () => {
  const refused = (dir: string) => {
    for (const args of [["get", "sentinel.preview"], ["get", "sentinel.preview", "--json"]]) {
      const result = run(args, dir);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("cannot read");
    }
  };
  // self-referential link
  const loop = fixture();
  mkdirSync(join(loop, "tap"), { recursive: true });
  symlinkSync(pathOf(loop), pathOf(loop));
  refused(loop);
  // dangling link
  const dangling = fixture();
  mkdirSync(join(dangling, "tap"), { recursive: true });
  symlinkSync(join(dangling, "nowhere.toml"), pathOf(dangling));
  refused(dangling);
  // config that sets the key, behind a directory without search permission
  if (process.getuid?.() !== 0) {
    const locked = fixture("[sentinel]\npreview = true\n");
    chmodSync(join(locked, "tap"), 0o000);
    try { refused(locked); } finally { chmodSync(join(locked, "tap"), 0o700); }
  }
  // a plain absent entry is still the fresh-config default
  expect(run(["get", "sentinel.preview"], fixture()).stdout.toString()).toBe("false (default)\n");
});

test("every default key sits under a table with a recorded effect and agrees with its reader", () => {
  for (const key of Object.keys(DEFAULTS)) expect(EFFECTS[key.split(".")[0]!]).toBeDefined();
  expect<unknown>(injectionBehavior({ XDG_CONFIG_HOME: join(work, "no-such-config-home") })).toBe(DEFAULTS["injection.behavior"]);
});

test("usage, unknown subcommands, malformed keys, and relative XDG refuse; help exits 0", () => {
  const dir = fixture(rich);
  expect(run([], dir).exitCode).toBe(1);
  expect(run(["wat"], dir).exitCode).toBe(1);
  expect(run(["wat"], dir).stderr.toString()).toContain("unknown subcommand 'wat'");
  expect(run(["get"], dir).exitCode).toBe(1);
  expect(run(["set", "only-key"], dir).exitCode).toBe(1);
  expect(run(["set", "bad key", "v"], dir).exitCode).toBe(1);
  expect(run(["set", "a..b", "v"], dir).exitCode).toBe(1);
  expect(run(["--help"], dir).exitCode).toBe(0);
  const relative = run(["path"], "relative");
  expect(relative.exitCode).toBe(1);
  expect(relative.stderr.toString()).toContain("absolute XDG_CONFIG_HOME or HOME");
});

test("multiline string bodies and comments cannot impersonate tables or keys", () => {
  // Reviewer specimen (tap-7r3fn.141 HOLD): a triple-quoted description that
  // CONTAINS `[sentinel]` + `preview = false` before the real table.
  const withFake = 'description = """\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = false\n';
  const dir = fixture(withFake);
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toBe('description = """\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = true\n');
  expect(run(["get", "sentinel.preview"], dir).stdout.toString()).toBe("true\n");

  // Idempotent set on an already-true real table behind the same fake: bytes unchanged.
  const idempotent = fixture('description = """\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = true\n');
  expect(run(["set", "sentinel.preview", "true"], idempotent).exitCode).toBe(0);
  expect(readFileSync(pathOf(idempotent), "utf8")).toBe('description = """\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = true\n');

  // Commented-out headers and key lines are inert.
  const commented = fixture('# [sentinel]\n# preview = false\n\n[sentinel]\npreview = false\n');
  expect(run(["set", "sentinel.preview", "true"], commented).exitCode).toBe(0);
  expect(readFileSync(pathOf(commented), "utf8")).toBe('# [sentinel]\n# preview = false\n\n[sentinel]\npreview = true\n');
});

test("set writes through a config symlink to its backing file and refuses a broken link", () => {
  const dir = fixture();
  mkdirSync(join(dir, "tap"), { recursive: true });
  const target = join(dir, "actual.toml");
  writeFileSync(target, "[sentinel]\npreview = false\n");
  symlinkSync(target, pathOf(dir));
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(0);
  expect(lstatSync(pathOf(dir)).isSymbolicLink()).toBe(true);
  expect(readFileSync(pathOf(dir), "utf8")).toBe("[sentinel]\npreview = true\n");
  expect(readFileSync(target, "utf8")).toBe("[sentinel]\npreview = true\n");

  const brokenDir = fixture();
  mkdirSync(join(brokenDir, "tap"), { recursive: true });
  symlinkSync(join(brokenDir, "missing.toml"), pathOf(brokenDir));
  const broken = run(["set", "sentinel.preview", "true"], brokenDir);
  expect(broken.exitCode).toBe(1);
  expect(broken.stderr.toString()).toContain("broken symlink");
  expect(lstatSync(pathOf(brokenDir)).isSymbolicLink()).toBe(true);
});

test("setup-serialized quoting: every header and key quoted still edits, and stays quoted", () => {
  // `tap setup --machine` serializes via serializeToml: `["sentinel"]` /
  // `"preview" = false`. config set must accept that shape and preserve it
  // (reviewer specimen, second HOLD finding).
  const setupShaped = serializeToml({
    version: 3,
    sentinel: { preview: false },
    presets: { fable: { harness: "claude" } },
  });
  expect(setupShaped).toContain('["sentinel"]');
  expect(setupShaped).toContain('"preview" = false');
  const dir = fixture(setupShaped);
  expect(run(["get", "sentinel.preview"], dir).stdout.toString()).toBe("false\n");
  expect(run(["get", "presets.fable.harness"], dir).stdout.toString()).toBe('"claude"\n');

  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toBe(setupShaped.replace('"preview" = false', '"preview" = true'));

  expect(run(["set", "sentinel.urgent", "false"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toContain('["sentinel"]\n"urgent" = false\n"preview" = true');

  expect(run(["set", "roles.driver", "true"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toContain('["roles"]\n"driver" = true');

  expect(run(["set", "version", "4"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toContain('"version" = 4');
  expect(run(["get", "version"], dir).stdout.toString()).toBe("4\n");
});

test("escaped triple quotes and trailing header comments (review round 2 specimens)", () => {
  // `\"""` inside a multiline basic string is an escaped quote plus two
  // literals: it must not close the string and expose the fake table below.
  const escaped = 'description = """\n\\"""\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = false\n';
  const dir = fixture(escaped);
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toBe('description = """\n\\"""\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = true\n');

  const idempotent = fixture('description = """\n\\"""\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = true\n');
  expect(run(["set", "sentinel.preview", "true"], idempotent).exitCode).toBe(0);
  expect(readFileSync(pathOf(idempotent), "utf8")).toBe('description = """\n\\"""\n[sentinel]\npreview = false\n"""\n\n[sentinel]\npreview = true\n');

  // A trailing comment on the header line must not hide the table.
  const commented = fixture("[sentinel] # existing comment\npreview = false\n");
  const edit = run(["set", "sentinel.preview", "true"], commented);
  expect(edit.exitCode).toBe(0);
  expect(readFileSync(pathOf(commented), "utf8")).toBe("[sentinel] # existing comment\npreview = true\n");
});

test("mislocated edit refuses rather than corrupts (self-checking write)", () => {
  // Array-of-tables bodies are a real lexer gap: tableBody does not stop at
  // `[[a.list]]`, so the locator can land on `c` inside the array element.
  // The document-level diff gate must refuse with the differing path and
  // write nothing — the proof that the write holds beyond enumerated cases.
  const withArray = `[a]
x = 1

[[a.list]]
c = 1

[z]
keep = true
`;
  const dir = fixture(withArray);
  const result = run(["set", "a.list.c", "2"], dir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("nothing written");
  expect(readFileSync(pathOf(dir), "utf8")).toBe(withArray);

  // The same document still accepts an ordinary edit outside the array.
  expect(run(["set", "a.x", "5"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toBe(withArray.replace("x = 1", "x = 5"));
});

test("a non-regular config target refuses actionably without blocking (round 3)", () => {
  // Reviewer specimen: config.toml symlinked to a FIFO must refuse BEFORE the
  // read could block on open. The spawn timeout is the control: a regression
  // hangs here instead of refusing.
  const dir = fixture();
  mkdirSync(join(dir, "tap"), { recursive: true });
  const fifo = join(dir, "tap/config.fifo");
  Bun.spawnSync(["mkfifo", fifo]);
  symlinkSync(fifo, pathOf(dir));
  const result = Bun.spawnSync([tapBin, "config", "set", "sentinel.preview", "true"], {
    env: { ...process.env, XDG_CONFIG_HOME: dir },
    cwd: work,
    timeout: 5000,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("is not a regular file");
  expect(lstatSync(pathOf(dir)).isSymbolicLink()).toBe(true);

  // A direct FIFO (no symlink) refuses the same way — for both set and get.
  const direct = fixture();
  mkdirSync(join(direct, "tap"), { recursive: true });
  const directFifo = pathOf(direct);
  Bun.spawnSync(["mkfifo", directFifo]);
  for (const args of [["set", "sentinel.preview", "true"], ["get", "sentinel.preview"]]) {
    const refused = Bun.spawnSync([tapBin, "config", ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: direct },
      cwd: work,
      timeout: 5000,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("is not a regular file");
  }
});

test("noncanonical integers become strings, so the file stays tomllib-parseable", () => {
  // Bun accepts `03` as an integer; Python 3.11 tomllib (the launcher's
  // parser) rejects it. The pass-through is limited to canonical integers.
  const dir = fixture(rich);
  expect(run(["set", "version", "03"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toContain('version = "03"');
  expect(run(["get", "version"], dir).stdout.toString()).toBe('"03"\n');
  expect(run(["set", "fresh", "+10"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toContain("fresh = +10");
});

test("a comment adjacent to a bare value survives without preceding whitespace", () => {
  const dir = fixture("[sentinel]\npreview = false#keep\n");
  expect(run(["set", "sentinel.preview", "true"], dir).exitCode).toBe(0);
  expect(readFileSync(pathOf(dir), "utf8")).toBe("[sentinel]\npreview = true#keep\n");
});

test("invalid UTF-8 config refuses the edit and keeps the bytes", () => {
  const dir = fixture();
  mkdirSync(join(dir, "tap"), { recursive: true });
  const bytes = Buffer.concat([
    Buffer.from("# comment "),
    Buffer.from([0xff]),
    Buffer.from("\n[sentinel]\npreview = false\n"),
  ]);
  writeFileSync(pathOf(dir), bytes);
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("not valid UTF-8");
  expect(readFileSync(pathOf(dir))).toEqual(bytes);
});

test("config set shares the digest writer's descriptor lock", () => {
  const dir = fixture(rich);
  const lock = `${pathOf(dir)}.lock`;
  const fd = acquireNoFollowLock(lock, 500);
  try {
    const held = run(["set", "sentinel.preview", "true"], dir);
    expect(held.exitCode).toBe(1);
    expect(held.stderr.toString()).toContain("config lock busy");
    expect(readFileSync(pathOf(dir), "utf8")).toBe(rich);
  } finally { closeSync(fd); }
  // Age and file existence are not ownership; an unlocked kernel lock is usable.
  const stale = Date.now() / 1000 - 60;
  utimesSync(lock, stale, stale);
  expect(run(["set", "sentinel.preview", "true"], dir).exitCode).toBe(0);
  expect(existsSync(lock)).toBe(true);
  expect(readFileSync(pathOf(dir), "utf8")).toContain("preview = true");
});

test("concurrent digest and config writers preserve both edits", async () => {
  const dir = fixture(rich);
  const fd = acquireNoFollowLock(`${pathOf(dir)}.lock`, 500);
  const env = { ...process.env, XDG_CONFIG_HOME: dir };
  const digest = Bun.spawn([process.execPath, join(root, "runtime/bun/test/fixtures/digest-window-update-probe.ts"),
    pathOf(dir), "tap/peer", "73", "1"], { env, stdout: "pipe", stderr: "pipe" });
  const config = Bun.spawn([tapBin, "config", "set", "sentinel.preview", "true"],
    { env, stdout: "pipe", stderr: "pipe" });
  try {
    try {
      await Bun.sleep(100);
      expect(digest.exitCode).toBeNull();
      expect(config.exitCode).toBeNull();
    } finally { closeSync(fd); }
    expect(await digest.exited, await new Response(digest.stderr).text()).toBe(0);
    expect(await config.exited, await new Response(config.stderr).text()).toBe(0);
    const document = Bun.TOML.parse(readFileSync(pathOf(dir), "utf8"));
    expect(document).toMatchObject({
      sentinel: { preview: true },
      delivery: { overrides: { "tap/peer": { now_window_seconds: 73 } } },
      presets: { alpha: { params: { model: "opus" } } },
    });
  } finally {
    digest.kill(); config.kill();
    await Promise.all([digest.exited, config.exited]);
  }
});

test("config refuses a symlinked shared lock without touching its target", () => {
  const dir = fixture(rich);
  const target = join(dir, "victim");
  writeFileSync(target, "keep");
  symlinkSync(target, `${pathOf(dir)}.lock`);
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("config lock");
  expect(readFileSync(target, "utf8")).toBe("keep");
  expect(readFileSync(pathOf(dir), "utf8")).toBe(rich);
});

test("a config symlink that resolves to a lock-named file is data, never a stale lock", () => {
  // Reviewer specimen (acceptance round): config.toml -> tap/config.lock,
  // mtime old enough to have looked stale under the retired create lock.
  // The kernel lock appends .lock to the resolved data path and is never
  // deleted, so neither acquisition nor release can remove the backing file.
  const dir = fixture();
  mkdirSync(join(dir, "tap"), { recursive: true });
  const backing = join(dir, "tap/config.lock");
  const content = 'version = 3\nkeep = "original"\n\n[sentinel]\npreview = false\n';
  writeFileSync(backing, content);
  const stale = Date.now() / 1000 - 60;
  utimesSync(backing, stale, stale);
  symlinkSync(backing, pathOf(dir));
  const result = run(["set", "sentinel.preview", "true"], dir);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(lstatSync(pathOf(dir)).isSymbolicLink()).toBe(true);
  expect(readFileSync(backing, "utf8")).toBe(content.replace("preview = false", "preview = true"));
});

test("the receipt names the effect class of the key's reader", () => {
  const dir = fixture(rich);
  expect(run(["set", "harness.claude.permissions", "ask"], dir).stdout.toString())
    .toContain("takes effect on the next launch");
  expect(run(["set", "presets.alpha.params.model", "sonnet"], dir).stdout.toString())
    .toContain("takes effect on the next launch");
  const unknown = run(["set", "mystery.key", "v"], dir);
  expect(unknown.exitCode).toBe(0);
  expect(unknown.stdout.toString()).toContain("no recorded reader for 'mystery.key'");
});

test("every catalog top-level table has a recorded reader effect", () => {
  // Any dotted key under a catalog table is settable, so each table needs an
  // EFFECTS entry or its receipt says "effect unknown" for a key TAP does read.
  const missing = TOP_LEVEL_KEYS.filter(key => !(key in EFFECTS));
  expect(missing).toEqual([]);
});

test("the receipt for each previously unmapped table names its reader's timing", () => {
  const expected: Record<string, string> = {
    notes: "next launch",
    delivery: "next delivery or roster read",
    recovery: "next nudge, detective, recovery run, or Antigravity delivery",
    onboarding: "next command in a project not yet initialized",
    skills: "next install, sync, or interactive setup",
  };
  for (const [table, timing] of Object.entries(expected)) {
    const out = run(["set", `${table}.probe`, "x"], fixture("")).stdout.toString();
    expect(out).toContain(`takes effect on the ${timing}`);
    expect(out).not.toContain("no recorded reader");
  }
});

test("every example on the config help page runs as written", () => {
  const full = lookupHelp(["config"]).stdout;
  const page = full.split("\nEXAMPLES\n")[1]!;
  const dir = fixture("");
  const examples = [...page.matchAll(/^ {2}tap config (path|get|set) ([^\n]*?) *(?:  .*)?$/gm)].map(m => [m[1]!, ...m[2]!.split(/\s+/).filter(Boolean)]);
  expect(examples.map(e => e.join(" "))).toEqual(["path", "set injection.behavior wait", "get injection.behavior", "set notifications.timeout_seconds 20"]);
  for (const argv of examples) {
    const r = run(argv, dir);
    expect(r.exitCode, argv.join(" ") + r.stderr.toString()).toBe(0);
  }
  expect(run(["get", "injection.behavior"], dir).stdout.toString()).toBe('"wait"\n');
  expect(run(["get", "notifications.timeout_seconds"], dir).stdout.toString()).toBe("20\n");
  // The one array exception, copied from the page's prose.
  const array = /tap config set notifications\.command '(\[.*?\])'/.exec(full)?.[1];
  expect(array).toBeDefined();
  expect(run(["set", "notifications.command", array!], dir).exitCode).toBe(0);
  expect(JSON.parse(run(["get", "notifications.command"], dir).stdout.toString())).toEqual(JSON.parse(array!));
  expect(run(["set", "notifications.command", "plain"], dir).exitCode).toBe(1);
});
