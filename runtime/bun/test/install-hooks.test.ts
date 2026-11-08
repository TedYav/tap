import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// The oracle was captured ONCE from python3 (install.sh heredocs parsed
// verbatim + scripts/codex_hook_config.py) — this file never runs python3.
// Each case runs the module CLI as a real subprocess, so exit codes,
// stdout, stderr and the resulting file bytes are compared against what the
// Python actually did. Ephemeral mkdtemp paths are normalized away. Six
// cases embed foreign-runtime wording in stderr (python tracebacks, errno
// phrasing, python JSON-parser messages); those pin the exit, the file
// bytes and the WARNING/line prefix up to the path, while every other case
// compares output byte for byte.

const ORACLE = (JSON.parse(readFileSync(new URL("./fixtures/install-hooks-oracle.json", import.meta.url), "utf8")) as {
  cases: Record<string, { exit: number; stdout: string; stderr: string; inputs: Record<string, string>; files: Record<string, string> }>;
}).cases;

const REPO = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO, "runtime", "bun", "src", "install-hooks.ts");

const ADVISORY = "/repo/hooks/tap-advisory.sh";
const GUARD = "/repo/hooks/tap-shell-body-guard.ts";
const CURSOR_HOOK = "/repo/hooks/tap-cursor-session-start.sh";
const CODEX_HOOK = "/repo/hooks/tap-codex-session-start.sh";

const b64 = (s: string): Buffer => Buffer.from(s, "base64");

type Mode = "claude" | "agents" | "codex-config" | "codex-legacy" | "cursor" | "gemini";

// Per-case invocation shape only. Input bytes live in the fixture
// (expected.inputs, base64) — captured from python3 once, never retyped here.
const MODES: Record<string, Mode> = {
  "claude-fresh": "claude",
  "claude-legacy": "claude",
  "claude-done": "claude",
  "claude-foreign": "claude",
  "claude-readonly": "claude",
  "claude-corrupt": "claude",
  "claude-bom": "claude",
  "agents-fresh": "agents",
  "agents-bom": "agents",
  "agents-fence": "agents",
  "agents-dangling": "agents",
  "codex-fresh": "codex-config",
  "codex-done": "codex-config",
  "codex-legacy": "codex-config",
  "codex-foreign": "codex-config",
  "codex-malformed": "codex-config",
  "codex-crlf": "codex-config",
  "codex-crlf-firstinstall": "codex-config",
  "codex-toml-cr-only": "codex-config",
  "codex-crlf-features-only": "codex-config",
  "codex-missing-file": "codex-config",
  "codex-unreadable": "codex-config",
  "codex-readonly": "codex-config",
  "legacy-taponly": "codex-legacy",
  "legacy-mixed": "codex-legacy",
  "legacy-absent": "codex-legacy",
  "legacy-clean": "codex-legacy",
  "legacy-invalid": "codex-legacy",
  "cursor-fresh": "cursor",
  "cursor-bom": "cursor",
  "cursor-legacy": "cursor",
  "cursor-absent": "cursor",
  "gemini-clean": "gemini",
  "gemini-done": "gemini",
  "gemini-nonobject": "gemini",
  "gemini-invalid": "gemini",
  "gemini-bom": "gemini",
  "claude-numbers": "claude",
  "claude-nonascii": "claude",
  "claude-hooks-null": "claude",
  "claude-nonobject-root": "claude",
  "claude-null-row": "claude",
  "claude-session-wired-then-null": "claude",
  "claude-session-hooks-string": "claude",
  "claude-session-hooks-null": "claude",
  "claude-session-hooks-map": "claude",
  "claude-session-hooks-emptystr": "claude",
  "claude-pretool-command-int": "claude",
  "claude-pretool-null-row": "claude",
  "cursor-hooks-list": "cursor",
  "cursor-root-nonobject": "cursor",
  "legacy-array": "codex-legacy",
  "legacy-hooks-array": "codex-legacy",
  "claude-nonutf8": "claude",
  "agents-nonutf8": "agents",
  "cursor-nonutf8": "cursor",
  "legacy-nonutf8": "codex-legacy",
  "agents-two-sections": "agents",
  "agents-crlf": "agents",
  "codex-toml-indent-features": "codex-config",
  "codex-toml-nonutf8-hooksline": "codex-config",
  "codex-toml-mixed-eol": "codex-config",
  "codex-toml-mixed-eol-2": "codex-config",
  "gemini-reordered": "gemini",
};

type Flags = { loose?: boolean; readonlyDir?: boolean; unreadable?: string; dangling?: boolean };

const FLAGS: Record<string, Flags> = {
  "claude-readonly": { loose: true, readonlyDir: true },
  "claude-corrupt": { loose: true },
  // R1: python text-mode keeps a leading BOM (U+FEFF); json.load refuses it.
  "claude-bom": { loose: true },
  "gemini-bom": { loose: true },
  "agents-dangling": { loose: true, dangling: true },
  "codex-unreadable": { loose: true, unreadable: "config.toml" },
  "codex-readonly": { loose: true, readonlyDir: true },
  "legacy-invalid": { loose: true },
  "gemini-invalid": { loose: true },
  // Python crash wording (tracebacks) — contract is rc + untouched bytes +
  // loud failure; decoded-WARNING wording pins only through its path prefix.
  "claude-hooks-null": { loose: true },
  "claude-nonobject-root": { loose: true },
  "claude-null-row": { loose: true },
  "claude-session-hooks-string": { loose: true },
  "claude-session-hooks-null": { loose: true },
  "claude-session-hooks-map": { loose: true },
  "claude-pretool-command-int": { loose: true },
  "claude-nonutf8": { loose: true },
  "agents-nonutf8": { loose: true },
  "cursor-hooks-list": { loose: true },
  "legacy-array": { loose: true },
  // rc0 cases with native-only wording (or silence): byte-strict.
  "legacy-hooks-array": {},
  "cursor-root-nonobject": {},
  "codex-crlf-firstinstall": {},
  "codex-crlf-features-only": {},
  "codex-toml-cr-only": {},
  "legacy-nonutf8": { loose: true },
};

const TARGET: Record<Mode, (dir: string) => string[]> = {
  claude: dir => ["claude", join(dir, "settings.json"), ADVISORY, GUARD],
  agents: dir => ["agents", join(dir, "AGENTS.md")],
  "codex-config": dir => ["codex-config", join(dir, "config.toml"), CODEX_HOOK, GUARD],
  "codex-legacy": dir => ["codex-legacy", join(dir, "hooks.json")],
  cursor: dir => ["cursor", join(dir, "hooks.json"), CURSOR_HOOK, GUARD],
  gemini: dir => ["gemini", join(dir, "hooks.json"), GUARD],
};

// Recorded scratch dirs were ephemeral mkdtemps; normalize every s2orb-*
// absolute path on the recorded side and our own scratch path on the live
// side to the same placeholder.
const RECORDED_SCRATCH = /\/var\/folders\/[^\s"',:]*s2orb-[A-Za-z0-9_]+/g;

const normalizeRecorded = (text: string): string => text.replace(RECORDED_SCRATCH, "@SCRATCH@");
const normalizeLive = (text: string, dir: string): string => text.split(dir).join("@SCRATCH@");

function filesOf(dir: string, skip?: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const walk = (rel: string): void => {
    const full = rel ? join(dir, rel) : dir;
    let st;
    try {
      st = statSync(full);
    } catch {
      return; // dangling link or unprobeable entry: skipped, as the instrument skips it
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(full)) walk(rel ? `${rel}/${name}` : name);
    } else if (rel !== skip) {
      try {
        out[rel] = readFileSync(full);
      } catch {
        // unreadable bytes: mirrored from the instrument's skip
      }
    }
  };
  walk("");
  return out;
}

// For loose cases: everything up to and including the first ":" after the
// first @SCRATCH@ is the pinned prefix (foreign-runtime detail follows).
function prefixThroughPath(text: string): string {
  const at = text.indexOf("@SCRATCH@");
  if (at === -1) return text;
  const colon = text.indexOf(":", at);
  return colon === -1 ? text : text.slice(0, colon + 1);
}

describe("install-hooks oracle parity (fixture captured once from python3)", () => {
  for (const [name, expected] of Object.entries(ORACLE)) {
    const flags = FLAGS[name] ?? {};
    const mode = MODES[name]!;
    test(name, () => {
      const dir = mkdtempSync(join(tmpdir(), "s2parity-"));
      try {
        for (const [fn, data] of Object.entries(expected.inputs)) {
          writeFileSync(join(dir, fn), b64(data));
        }
        if (flags.dangling) symlinkSync("missing-target.md", join(dir, "AGENTS.md"));
        if (flags.unreadable) chmodSync(join(dir, flags.unreadable), 0);
        if (flags.readonlyDir) chmodSync(dir, 0o500);
        const r = spawnSync(process.execPath, [CLI, ...TARGET[mode](dir)], { encoding: "buffer" });
        if (flags.readonlyDir) chmodSync(dir, 0o700);
        if (flags.unreadable) chmodSync(join(dir, flags.unreadable), 0o644);
        const rc = r.status ?? -1;
        if (rc !== expected.exit) {
          console.log(`[${name}] child rc ${rc} stdout=${JSON.stringify(r.stdout.toString("utf8"))} stderr=${JSON.stringify(r.stderr.toString("utf8"))} error=${String(r.error)}`);
        }
        expect(rc).toBe(expected.exit);

        const live = filesOf(dir, flags.unreadable);
        expect(Object.keys(live).sort()).toEqual(Object.keys(expected.files).sort());
        for (const [fn, recorded] of Object.entries(expected.files)) {
          expect(live[fn]).toEqual(b64(recorded));
        }

        const expOut = normalizeRecorded(b64(expected.stdout).toString("utf8"));
        const expErr = normalizeRecorded(b64(expected.stderr).toString("utf8"));
        const actOut = normalizeLive(r.stdout.toString("utf8"), dir);
        const actErr = normalizeLive(r.stderr.toString("utf8"), dir);
        if (flags.loose) {
          if (expErr.includes("@SCRATCH@")) {
            expect(actErr.length).toBeGreaterThan(0);
            const pinned = prefixThroughPath(expErr);
            expect(actErr.startsWith(pinned) || prefixThroughPath(actErr) === prefixThroughPath(expErr)).toBe(true);
          } else {
            // Foreign-runtime wording with no path anchor (python traceback):
            // the contract is the exit status, the file bytes and that the
            // failure was loud — never the traceback's own bytes.
            expect(actErr.length).toBeGreaterThan(0);
          }
        } else {
          expect(actOut).toBe(expOut);
          expect(actErr).toBe(expErr);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// A second run changes nothing: same rc, byte-identical surface files. The
// second run's stdout may differ ("already wired" shapes); the bytes may not.
describe("install-hooks idempotence (second run changes nothing)", () => {
  for (const name of ["claude-fresh", "agents-fresh", "codex-fresh", "cursor-fresh", "gemini-clean"]) {
    const expected = ORACLE[name]!;
    const mode = MODES[name]!;
    test(`${name} twice`, () => {
      const dir = mkdtempSync(join(tmpdir(), "s2idem-"));
      try {
        const first = spawnSync(process.execPath, [CLI, ...TARGET[mode](dir)], { encoding: "buffer" });
        const firstFiles = filesOf(dir);
        expect(first.status).toBe(0);
        const second = spawnSync(process.execPath, [CLI, ...TARGET[mode](dir)], { encoding: "buffer" });
        expect(second.status).toBe(0);
        const secondFiles = filesOf(dir);
        expect(Object.keys(secondFiles).sort()).toEqual(Object.keys(firstFiles).sort());
        for (const [fn, bytes] of Object.entries(firstFiles)) {
          expect(secondFiles[fn]).toEqual(bytes);
        }
        void expected;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// tap-hvdvp: Codex writes config.toml with toml_edit, which renders tables it
// adds before the document's trailing comments. With TAP's end marker last,
// hook trust ([hooks.state]) and directory trust ([projects."…"]) land inside
// TAP's fence. The installer moves only its own end marker above them.
describe("codex-config: Codex tables appended inside TAP's fence", () => {
  const ROOT = "/Users/dev/work/Example-Org/tap/hooks";
  const hook = `${ROOT}/tap-codex-session-start.sh`, guard = `${ROOT}/tap-shell-body-guard.ts`;
  const block = (h = hook, g = guard, nl = "\n") => reconcileCli("", h, g).file.replace(/^[\s\S]*?(?=# tap-managed:begin)/, "").replaceAll("\n", nl);
  const TRUST = '\n[hooks.state]\n\n[hooks.state."/Users/dev/.codex/config.toml:session_start:0:0"]\ntrusted_hash = "sha256:aa"\n\n[projects."/Users/dev/work/Example-Org/tap"]\ntrust_level = "trusted"\n';
  const END = "# tap-managed:end Codex SessionStart";

  function reconcileCli(initial: string | Buffer, h = hook, g = guard) {
    const dir = mkdtempSync(join(tmpdir(), "s2fence-"));
    try {
      const path = join(dir, "config.toml");
      writeFileSync(path, initial);
      const r = spawnSync(process.execPath, [CLI, "codex-config", path, h, g], { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout.split(dir).join("@"), stderr: r.stderr.split(dir).join("@"), file: readFileSync(path, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Codex's layout after trust: the tables sit between TAP's lines and its end marker.
  const trusted = (nl = "\n") => {
    const b = block(hook, guard, nl);
    return `model = "x"${nl}` + b.replace(`${END}${nl}`, TRUST.replaceAll("\n", nl) + `${END}${nl}`);
  };

  test("trust then sync: only the end marker moves, and a second run is byte-identical", () => {
    const first = reconcileCli(trusted());
    expect(first.status).toBe(0);
    expect(first.file).toBe(`model = "x"\n${block()}`.replace(`${END}\n`, `${END}\n${TRUST}`));
    expect(first.stdout).toContain("install: moved the TAP end marker in @/config.toml above the tables Codex added at lines 19-25; their bytes are unchanged");
    expect(first.stdout).not.toContain("trust the new");
    const second = reconcileCli(first.file);
    expect(second.status).toBe(0);
    expect(second.file).toBe(first.file);
    expect(second.stdout).toBe("install: Codex hooks already wired in config.toml\n");
  });

  test("CRLF files and an end marker without a final newline keep their bytes", () => {
    const crlf = reconcileCli(trusted("\r\n"));
    expect(crlf.status).toBe(0);
    expect(crlf.file).toBe(`model = "x"\r\n${block(hook, guard, "\r\n")}`.replace(`${END}\r\n`, `${END}\r\n${TRUST.replaceAll("\n", "\r\n")}`));
    const noEol = reconcileCli(trusted().replace(/\n$/, ""));
    expect(noEol.status).toBe(0);
    expect(noEol.file.endsWith('trust_level = "trusted"\n')).toBe(true);
    expect(noEol.file).toContain(`statusMessage = "Checking tmux server target"\n${END}\n\n[hooks.state]\n`);
  });

  for (const [name, suffix, lines] of [
    ["a table under TAP's arrays", '\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/foreign/extra"\n', "line 18"],
    ["a comment before any table", "# foreign note\n[hooks.state]\n", "line 17"],
  ] as const) {
    test(`${name} refuses with line numbers and writes nothing`, () => {
      const before = block().replace(`${END}\n`, `${suffix}${END}\n`);
      const r = reconcileCli(before);
      expect(r.status).toBe(1);
      expect(r.file).toBe(before);
      expect(r.stderr).toContain("install: refusing to edit Codex hooks in @/config.toml\n  cause: ");
      expect(r.stderr).toContain(`(${lines})`);
      expect(r.stderr).toContain("TAP's markers are lines 1 and ");
      expect(r.stderr).toContain("  next: back up @/config.toml, ");
    });
  }

  test("a block from another clone is replaced and says which clone it pointed at", () => {
    const old = block("/Users/dev/work/old-tap/hooks/tap-codex-session-start.sh", "/Users/dev/work/old-tap/hooks/tap-shell-body-guard.ts");
    const r = reconcileCli(old.replace(`${END}\n`, `${TRUST}${END}\n`));
    expect(r.status).toBe(0);
    expect(r.file).toBe(block().replace(`${END}\n`, `${END}\n${TRUST}`));
    expect(r.stdout).toContain("install: replaced TAP's Codex hooks that pointed at /Users/dev/work/old-tap/hooks\n");
    expect(r.stdout).toContain("trust the new SessionStart and PreToolUse hooks\n");
  });

  test("the trust note names only the hook that changed", () => {
    const sessionOnly = block().replace(/\[\[hooks\.PreToolUse\]\][\s\S]*?(?=# tap-managed:end)/, "");
    const r = reconcileCli(sessionOnly);
    expect(r.status).toBe(0);
    expect(r.file).toBe(block());
    expect(r.stdout).toBe(`install: wired Codex PreToolUse hook into @/config.toml\ninstall: NOTE — open /hooks in Codex to review and trust the new PreToolUse hook\n`);
  });
});
