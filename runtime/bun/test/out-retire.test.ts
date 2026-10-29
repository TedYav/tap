// R3 checkpoint A — the ordinary `tap out|unregister` retirement owner is
// native end to end. Every case drives the public door (main.ts out|unregister):
// plain, dash, and --kill forms, the fault-injection knobs the incumbent named,
// and the lossless registry representation.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loads } from "../src/watch-detect";
import { KERNEL_LOCK, kernelLockArgs } from "../src/panelock";
import { claimTmuxStart, physicalSocketPath } from "../src/tmux";
import { removeScratchTree } from "./support/scratch";
import { disposeSenderGone, type DeadlineRow } from "../src/spool-deadline";

const ROOT = join(import.meta.dir, "../..");
const MAIN = join(import.meta.dir, "../main.ts");

// Roots this file created, and only those, are removed in cleanup — never a
// global tmpdir prefix scan. Per-test removal keeps each lsof +D sweep small;
// one whole-run afterAll sweep timed out under compute load.
const scratch: string[] = [];
afterEach(() => {
  for (const p of scratch.splice(0)) {
    try { chmodSync(p, 0o755); } catch { /* already writable */ }
    removeScratchTree(p);
  }
}, 30000);

interface Fix { root: string; cwd: string; bus: string; registry: string; index: string; fakeBin: string; state: string; env: Record<string, string>; }
function fix(o: { team?: string; tmux?: boolean } = {}): Fix {
  const root = realpathSync(mkdtempSync(join(process.env.TMUX_TMPDIR ?? tmpdir(), "tap-r3out.")));
  scratch.push(root);
  const cwd = join(root, "team"), bus = join(cwd, ".tap", "bus"), index = join(root, "idx"), fakeBin = join(root, "bin"), state = join(root, "tmux-state");
  const registry = join(cwd, ".tap", "team-registry.json");
  for (const d of [bus, join(bus, "payloads"), join(bus, "receipts"), join(bus, "spool"), index, fakeBin, state, join(state, "sessions")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { [o.team ?? "t"]: { root: cwd, registry_location: registry, state: "registered" } } }));
  writeFileSync(join(bus, "reset-generation.json"), '{"state":"pristine"}\n');
  if (o.tmux) {
    writeFileSync(join(state, "epoch"), "900:100");
    writeFileSync(join(state, "sessions", "observer"), "");
    writeFileSync(join(state, "panes"), "%900\tobserver\t@900\n");
    writeFileSync(join(fakeBin, "tmux"), TMUX_SH, { mode: 0o755 });
  } else {
    writeFileSync(join(fakeBin, "tmux"), "#!/bin/sh\necho 'no server running on /fixture/absent' >&2\nexit 1\n", { mode: 0o755 });
  }
  const env: Record<string, string> = { ...process.env, HOME: join(root, "u"), TAP_HOME: bus, TAP_INDEX_HOME: index, TAP_LOCK_DIR: join(root, "locks"), TAP_TMUX_SOCKET: `r3out-${process.pid}`, TAP_SESSION_MANIFEST: join(root, "sess.json"), TAP_VERSION_SEEN_PATH: join(root, "seen.json"), TAP_SPOOL_DISABLE_DELIVERER: "1", FAKE_STATE: state } as Record<string, string>;
  delete (env as Record<string, string | undefined>).TMUX;
  delete (env as Record<string, string | undefined>).TMUX_PANE;
  delete (env as Record<string, string | undefined>).TAP_SELF;
  env.PATH = `${fakeBin}:${env.PATH}`;
  env.FAKE_SOCKET_PATH = physicalSocketPath(env);
  return { root, cwd, bus, registry, index, fakeBin, state, env };
}

const TMUX_SH = `#!/bin/sh
set -e
S="$FAKE_STATE"
enc() { printf '%s' "$1" | sed 's|/|__|g'; }
session_id() { printf '$'; printf '%s' "$1" | cksum | cut -d ' ' -f 1; }
pane_line() { grep -F "$1" "$S/panes" 2>/dev/null | grep -F "$1	" | head -1; }
fld() { printf '%s\n' "$1" | cut -f"$2"; }
while [ "$1" = "-L" ] || [ "$1" = "-S" ]; do shift 2; done
if [ -f "$S/no-server" ]; then echo "$(cat "$S/no-server")" >&2; exit 1; fi
if [ "$1" = "$FAKE_LAST_READ" ] || { [ "$FAKE_LAST_READ" = socket ] && case "$*" in *socket_path*) true ;; *) false ;; esac; }; then
  if [ "$FAKE_LAST_FAILURE" = timeout ]; then sleep 1; else echo 'fork failed: Device not configured' >&2; exit 1; fi
fi
case "$1" in
  display-message)
    shift; target=""; fmt=""
    while [ "$#" -gt 0 ]; do case "$1" in
      -p) shift ;; -t) target="$2"; shift 2 ;; *) fmt="$1"; shift ;;
    esac; done
    case "$fmt" in
      *pane_id*session_name*start_time*)
        line="$(pane_line "$target")" || { echo "cannot find pane $target" >&2; exit 1; }
        printf '%s\t%s\t%s\n' "$(fld "$line" 1)" "$(fld "$line" 2)" "$(cat "$S/epoch")" ;;
      "#{pane_id}")
        [ -z "$target" ] && { echo "%900"; exit 0; }
        line="$(pane_line "$target")" || { echo "cannot find pane $target" >&2; exit 1; }
        fld "$line" 1 ;;
      *pid*start_time*) cat "$S/epoch" ;;
      "#{socket_path}") printf '%s\\n' "$FAKE_SOCKET_PATH" ;;
      "#{session_name}")
        line="$(pane_line "$target")" || { echo "cannot find pane $target" >&2; exit 1; }
        fld "$line" 2 ;;
      "#{window_id}")
        line="$(pane_line "$target")" || { echo "cannot find pane $target" >&2; exit 1; }
        fld "$line" 3 ;;
      *) echo "" ;;
    esac ;;
  has-session)
    name="$(printf '%s' "$3" | sed 's/^=//')"
    [ -f "$S/sessions/$(enc "$name")" ] && exit 0
    exit 1 ;;
  list-sessions)
    [ -z "$FAKE_SNAPSHOT_FAIL" ] || { echo 'permission denied' >&2; exit 1; }
    for file in "$S"/sessions/*; do
      [ -f "$file" ] || continue
      name="$(basename "$file" | sed 's|__|/|g')"
      case "$*" in *start_time*) printf '%s\\t%s\\t0\\n' "$name" "$(cat "$S/epoch")" ;; *) printf '%s\\n' "$name" ;; esac
    done ;;
  list-panes)
    [ -z "$FAKE_SNAPSHOT_FAIL" ] || { echo 'permission denied' >&2; exit 1; }
    case "$*" in *pane_current_command*)
      while IFS="\t" read -r pid sess win; do
        [ -f "$S/sessions/$(enc "$sess")" ] || continue
        printf '%s\\t%s:0.0\\t%s\\tclaude\\t1\\t%s\\t0\\n' "$sess" "$sess" "$pid" "$(cat "$S/epoch")"
      done < "$S/panes"
      [ -z "$FAKE_POISONED_FOREIGN" ] || printf 'foreign\\ttruncated\\n'
      exit 0 ;;
    esac
    case "$*" in *session_id*)
      if [ -f "$S/effect" ] && [ -n "$FAKE_OBSERVATION_FAIL_AFTER_KILL" ]; then echo 'permission denied' >&2; exit 1; fi
      found=0
      while IFS="\t" read -r pid sess win; do
        [ -f "$S/sessions/$(enc "$sess")" ] || continue
        printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$pid" "$sess" "$(session_id "$sess")" "$win" "$(cat "$S/epoch")"
        found=1
      done < "$S/panes"
      [ "$found" = 1 ] || { echo 'no server running on private fixture' >&2; exit 1; }
      exit 0 ;;
    esac
    shift; target=""
    while [ "$#" -gt 0 ]; do case "$1" in -a|-F) shift ;; -t) target="$2"; shift 2 ;; *) shift ;; esac; done
    bare="$(printf '%s' "$target" | sed 's/^=//')"
    while IFS="	" read -r pid sess win; do
      [ -z "$pid" ] && continue
      if [ -z "$target" ] || [ "$sess" = "$bare" ]; then printf '%s\n' "$pid"; fi
    done < "$S/panes"
    exit 0 ;;
  if-shell)
    printf 'attempt\\n' >> "$S/effect"
    if [ -n "$FAKE_KILL_FAIL" ]; then echo 'kill refused' >&2; exit 1; fi
    line="$(pane_line "$4")"
    name="$(fld "$line" 2)"
    rm -f "$S/sessions/$(enc "$name")"
    printf '%s\\n' "$name" >> "$S/killed.log"
    exit 0 ;;
  kill-session)
    name="$(printf '%s' "$3" | sed 's/^=//')"
    if [ -n "$FAKE_KILL_FAIL" ]; then echo "kill refused" >&2; exit 1; fi
    f="$S/sessions/$(enc "$name")"
    [ -f "$f" ] || { echo "cannot find session $name" >&2; exit 1; }
    rm -f "$f"
    printf '%s\n' "$name" >> "$S/killed.log"
    exit 0 ;;
  *) exit 0 ;;
esac
`

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane: "t/alice", session: "t/alice", delivery: "pane", pane_id: "%1", server_epoch: "srv:900:100", instance: "alice|a1", ...over };
}
function reg(f: Fix, seats: Record<string, unknown>, key = "seats"): void {
  const text = JSON.stringify({ schema: "0.20", team: { name: "t" }, [key]: seats }, (_k, v) => (typeof v === "bigint" ? `__BIGINT:${v}__` : v), 2)
    .replace(/"__BIGINT:(\d+)__"/g, "$1");
  writeFileSync(f.registry, `${text}\n`);
}
type RunOut = { code: number; out: string; err: string };
function run(f: Fix, args: string[], over: Record<string, string | undefined> = {}): RunOut {
  const env = { ...f.env, ...over } as NodeJS.ProcessEnv;
  for (const k of Object.keys(over)) if (over[k] === undefined) delete env[k];
  const r = Bun.spawnSync([process.execPath, MAIN, ...args], { cwd: f.cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function plain(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]));
  if (Array.isArray(v)) return v.map(plain);
  return v;
}
function seatsOf(f: Fix, key = "seats"): Record<string, Record<string, unknown>> {
  const doc = plain(loads(readFileSync(f.registry, "utf8"))) as Record<string, Record<string, Record<string, unknown>>>;
  return (doc[key] ?? {}) as Record<string, Record<string, unknown>>;
}
function events(f: Fix): string[] {
  const p = join(f.bus, "registry-events.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}
function gen(f: Fix): Record<string, unknown> {
  return JSON.parse(readFileSync(join(f.bus, "reset-generation.json"), "utf8")) as Record<string, unknown>;
}
function tombs(f: Fix): string[] {
  const d = join(f.cwd, ".tap", "team-history");
  return existsSync(d) ? readdirSync(d) : [];
}
function killedLog(f: Fix): string[] {
  const p = join(f.state, "killed.log");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}
function fakePanes(f: Fix, panes: Record<string, [string, string]>): void {
  writeFileSync(join(f.state, "panes"), Object.entries({ "%900": ["observer", "@900"] as [string, string], ...panes }).map(([id, [sess, win]]) => `${id}\t${sess}\t${win}`).join("\n") + "\n");
}
function fakeSession(f: Fix, name: string): void {
  writeFileSync(join(f.state, "sessions", name.replaceAll("/", "__")), "");
}

function otherTeam(f: Fix): Fix {
  const b = fix({ team: "b" });
  reg(b, { alice: row({ delivery: "poll", pane_id: "%77", pane: "b/alice", session: "b/alice" }) });
  const doc = JSON.parse(readFileSync(b.registry, "utf8"));
  doc.team.name = "b";
  writeFileSync(b.registry, JSON.stringify(doc));
  const index = JSON.parse(readFileSync(join(f.index, "global-registry.json"), "utf8"));
  index.teams.b = { root: b.cwd, registry_location: b.registry, state: "registered" };
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify(index));
  return b;
}

for (const args of [["out", "b/alice"], ["unregister", "b:alice"], ["out", "alice", "--team", "b"], ["out", "b/alice", "--kill"]]) {
  test(`explicit out selection defeats cwd and ambient bus: ${args.join(" ")}`, () => {
    const a = fix(); reg(a, { alice: row({ delivery: "poll" }) });
    const b = otherTeam(a);
    const before = readFileSync(a.registry, "utf8");
    const result = run(a, args);
    expect(result.code).toBe(0);
    expect(seatsOf(b).alice).toBeUndefined();
    expect(readFileSync(a.registry, "utf8")).toBe(before);
    expect(events(b)).toHaveLength(1);
    expect(tombs(b)).toHaveLength(1);
    expect(gen(b).state).toBe("reused");
    expect(events(a)).toEqual([]);
    expect(tombs(a)).toEqual([]);
    expect(gen(a).state).toBe("pristine");
  });
}

test("explicit out selection refuses absent targets and conflicting or malformed selectors", () => {
  const a = fix(); reg(a, { alice: row({ delivery: "poll" }) });
  const b = otherTeam(a);
  const before = [a, b].map(f => readFileSync(f.registry, "utf8"));
  for (const args of [["b/missing"], ["b/missing", "--kill"], ["missing", "--team", "b"], ["unknown/alice"],
    ["b/alice", "--team", "b"], ["b/alice", "--team", "t"], ["b/alice/extra"], ["b/"],
    ["alice", "--team"], ["alice", "--team", "b", "--team", "b"]]) {
    const result = run(a, ["out", ...args]);
    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("nothing to remove");
    expect([a, b].map(f => readFileSync(f.registry, "utf8"))).toEqual(before);
    for (const f of [a, b]) {
      expect(events(f)).toEqual([]);
      expect(tombs(f)).toEqual([]);
      expect(gen(f).state).toBe("pristine");
    }
  }
  const malformed = run(a, ["out", "--json", "b/alice/extra"]);
  expect(JSON.parse(malformed.out)).toMatchObject({ ok: false, error_class: "usage_error" });
  expect(malformed.err).not.toContain("SelectorError");
});

test("explicit out selection stays on its team after registry relocation", async () => {
  const a = fix(); reg(a, { alice: row({ delivery: "poll" }) });
  const b = otherTeam(a);
  const before = [a, b].map(f => readFileSync(f.registry, "utf8"));
  const barrier = join(a.root, "barrier");
  const proc = Bun.spawn([process.execPath, MAIN, "out", "b/alice"], {
    cwd: a.cwd, env: { ...a.env, TAP_SCRATCH_ONLY: a.root, TAP_OUT_RETIRE_TEST_BARRIER: barrier, TAP_OUT_RETIRE_TEST_STAGE: "after-select" },
    stdout: "pipe", stderr: "pipe",
  });
  const deadline = Date.now() + 10000;
  while (!existsSync(barrier + ".ready") && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(barrier + ".ready")).toBe(true);
  const moved = join(b.cwd, ".tap", "relocated.json");
  writeFileSync(moved, before[1]!);
  const index = JSON.parse(readFileSync(join(a.index, "global-registry.json"), "utf8"));
  index.teams.b.registry_location = moved;
  writeFileSync(join(a.index, "global-registry.json"), JSON.stringify(index));
  writeFileSync(barrier + ".continue", "");
  expect(await proc.exited).toBe(0);
  expect([a, b].map(f => readFileSync(f.registry, "utf8"))).toEqual(before);
  expect(JSON.parse(readFileSync(moved, "utf8")).seats.alice).toBeUndefined();
  expect(events(a)).toEqual([]);
  expect(events(b)).toHaveLength(1);
}, 20000);

test("plain out: one removal line, one event, reset mark, tombstone under flip", () => {
  const f = fix(); reg(f, { alice: row() });
  const r = run(f, ["out", "alice"]);
  expect(r.code).toBe(0);
  expect(r.out.split("removed from the registry").length - 1).toBe(1);
  expect(seatsOf(f).alice).toBeUndefined();
  expect(events(f).length).toBe(1);
  expect(gen(f)).toEqual({ state: "reused", first_mutation: "unregister" });
  expect(tombs(f).length).toBe(1);
  const tombDoc = JSON.parse(readFileSync(join(f.cwd, ".tap", "team-history", tombs(f)[0]!), "utf8")) as Record<string, unknown>;
  expect(Object.keys(tombDoc)).toEqual(["handle", "instance", "retired_at", "retired_by", "row"]);
  expect(tombDoc.instance).toBe("alice|a1");
});

test("plain out preserves unknown wide numbers and sections through the lossless doc", () => {
  const live = fix(); reg(live, { alice: row(), carol: row({ pane: "t/carol", pane_id: "%2", pane_pid: 9007199254740993n }) });
  const doc = { mystery: { deep: [1, 2] }, schema: "0.20", seats: { alice: row(), carol: row({ pane: "t/carol", pane_id: "%2", pane_pid: 9007199254740993n }) }, zeta: 1 };
  writeFileSync(live.registry, JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? `__BIGINT:${v}__` : v), 2).replace(/"__BIGINT:(\d+)__"/g, "$1") + "\n");
  const r2 = run(live, ["out", "alice"]);
  expect(r2.code).toBe(0);
  const text = readFileSync(live.registry, "utf8");
  expect(text).toContain('"mystery"');
  expect(text).toContain("9007199254740993");
  expect(Object.keys(JSON.parse(text))).toEqual(["mystery", "schema", "seats", "zeta"]);
  expect(tombs(live).length).toBe(1);
});

test("invalid flip marker refuses without retry (human and JSON once)", () => {
  const f = fix(); reg(f, { alice: row() });
  writeFileSync(join(f.index, "global-registry.json"), '{"schema":"0.19"}\n');
  const r = run(f, ["out", "alice"]);
  expect(r.code).toBe(1);
  expect(seatsOf(f).alice).toBeDefined();
  expect(r.err).toContain("registry flip marker is present but invalid");
  expect(r.err).toContain("tap doctor");
  expect(events(f).length).toBe(0);
  expect(gen(f)).toEqual({ state: "pristine" });
  const f2 = fix(); reg(f2, { alice: row() });
  writeFileSync(join(f2.index, "global-registry.json"), '{"schema":"0.19"}\n');
  const j = run(f2, ["out", "alice", "--json"]);
  expect(j.code).toBe(1);
  const parsed = JSON.parse(j.out) as Record<string, unknown>;
  expect(parsed).toMatchObject({ ok: false, error_class: "invalid_flip", action: "tap doctor" });
  expect(j.out.split("\n").filter((l) => l.trim()).length).toBe(1);
});

test("failed publication keeps the row and removes this attempt's tombstone", () => {
  const f = fix(); reg(f, { alice: row() });
  const dotTap = join(f.cwd, ".tap");
  chmodSync(dotTap, 0o555);
  const r = run(f, ["out", "alice"]);
  chmodSync(dotTap, 0o755);
  expect(r.code).toBe(1);
  expect(r.err).toContain("repair registry");
  expect(seatsOf(f).alice).toBeDefined();
  expect(tombs(f).length).toBe(0);
});

test("dash picks the single dead seat and keeps poll siblings; note prints once", () => {
  const f = fix({ tmux: true }); reg(f, { bob: row({ pane: "t/bob", pane_id: "%9", session: "t/bob", server_epoch: "" }), carol: row({ pane: "t/carol", pane_id: "%8", session: "t/carol", server_epoch: "", delivery: "poll" }) });
  const r = run(f, ["out", "-"]);
  expect(r.code).toBe(0);
  expect(seatsOf(f).bob).toBeUndefined();
  expect(seatsOf(f).carol).toBeDefined();
  expect(r.out).toContain("'-' removed 'bob' (most recently exited)");
  expect(events(f).length).toBe(1);
});

test("dash stamps exited_at then refuses ambiguous dead seats", () => {
  const f = fix({ tmux: true }); reg(f, { bob: row({ pane: "t/bob", pane_id: "%9", session: "t/bob", server_epoch: "" }), carol: row({ pane: "t/carol", pane_id: "%8", session: "t/carol", server_epoch: "" }) });
  const r = run(f, ["out", "-"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("tap unregister <name>");
  expect(r.err).toContain("2 dead seats");
  expect(r.err).toContain("candidates: bob carol");
  const seats = seatsOf(f);
  expect(seats.bob).toBeDefined();
  expect(seats.carol).toBeDefined();
  expect(String(seats.bob!.exited_at)).toContain("T");
  expect(String(seats.carol!.exited_at)).toContain("T");
});

test("dash refuses when every pane seat is poll-dead (live count 0)", () => {
  const f = fix({ tmux: true }); reg(f, { carol: row({ pane: "t/carol", pane_id: "%8", session: "t/carol", server_epoch: "", delivery: "poll" }) });
  const r = run(f, ["out", "-"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no eligible exited seats");
});

test("dash is incompatible with --kill", () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const r = run(f, ["out", "-", "--kill"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("'-' is incompatible with --kill");
  expect(seatsOf(f).alice).toBeDefined();
});

test("absent --kill stays idempotent; poll --kill retires without tmux effects", () => {
  const f = fix(); reg(f, {});
  const bytes = readFileSync(f.registry, "utf8");
  const r = run(f, ["out", "ghost", "--kill"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("'ghost' is not registered — nothing to remove");
  expect(readFileSync(f.registry, "utf8")).toBe(bytes);
  expect(events(f).length).toBe(0);
  expect(tombs(f).length).toBe(0);
  expect(gen(f)).toEqual({ state: "pristine" });
  const f2 = fix(); reg(f2, { alice: row({ delivery: "poll" }) });
  const r2 = run(f2, ["out", "alice", "--kill", "--json"]);
  expect(r2.code).toBe(0);
  expect(JSON.parse(r2.out)).toMatchObject({ ok: true, lifecycle_action: "out-hard", mechanism: "hard-removal", outcome: "retired" });
  expect(seatsOf(f2).alice).toBeUndefined();
  expect(events(f2).length).toBe(1);
  expect(tombs(f2).length).toBe(1);
});

test("plain retirement can clean malformed non-identity metadata", () => {
  const f = fix(); reg(f, { alice: row({ status: { damaged: [1, "state"] } }) });
  expect(run(f, ["out", "alice"]).code).toBe(0);
  expect(seatsOf(f).alice).toBeUndefined();
  expect(tombs(f)).toHaveLength(1);
});

test("dash-selected crew becoming live refuses without a stop or row retirement", async () => {
  const f = fix({ tmux: true }); reg(f, { alice: row({ crew: true }) });
  fakePanes(f, {});
  const barrier = join(f.root, "barrier");
  const proc = Bun.spawn([process.execPath, MAIN, "out", "-", "--json"], { cwd: f.cwd,
    env: { ...f.env, TAP_SCRATCH_ONLY: f.root, TAP_OUT_RETIRE_TEST_BARRIER: barrier, TAP_OUT_RETIRE_TEST_STAGE: "after-dash-select" }, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 10000;
  while (!existsSync(barrier + ".ready") && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(barrier + ".ready")).toBe(true);
  fakePanes(f, { "%1": ["t/alice", "@1"] }); fakeSession(f, "t/alice");
  writeFileSync(barrier + ".continue", "");
  expect(await proc.exited).toBe(1);
  expect(JSON.parse(await new Response(proc.stdout).text())).toMatchObject({ error_class: "lifecycle_refused" });
  expect(seatsOf(f).alice).toBeDefined();
  expect(killedLog(f)).toEqual([]); expect(events(f)).toEqual([]); expect(tombs(f)).toEqual([]);
}, 20000);

test("kill by proven pane id: authority re-test under the lock, tombstone before kill", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const r = run(f, ["out", "alice", "--kill"]);
  expect(r.code).toBe(0);
  expect(seatsOf(f).alice).toBeUndefined();
  expect(killedLog(f)).toEqual(["t/alice"]);
  expect(r.out).toContain("stopped tmux session 't/alice'");
  expect(events(f).length).toBe(1);
  expect(tombs(f).length).toBe(1);
});

test("kill of an unstamped row takes the name arm", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row({ server_epoch: "" }) });
  const r = run(f, ["unregister", "alice", "--kill"]);
  expect(r.code).toBe(0);
  expect(seatsOf(f).alice).toBeUndefined();
  expect(killedLog(f)).toEqual(["t/alice"]);
});

test("a moved pane identity under the lock refuses with the row intact", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%2": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const r = run(f, ["out", "alice", "--kill"]);
  expect(r.code).toBe(1);
  expect(seatsOf(f).alice).toBeDefined();
  expect(killedLog(f)).toEqual([]);
  expect(tombs(f).length).toBe(0);
});

test("live kill failure with the registry restored but the tombstone unlink failing retains exactly one tombstone", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const j = run(f, ["out", "alice", "--kill"], { FAKE_KILL_FAIL: "1", TAP_TEST_UNREGISTER_UNLINK_FAIL: "1", TAP_JSON: "1" });
  expect(j.code).toBe(1);
  const receipt = JSON.parse(j.out);
  expect(receipt).toMatchObject({ ok: false, error_class: "session_kill_failed" });
  expect(receipt.detail).toContain("history remains at");
  // Guards: the kill fault fired (nothing was killed) and the restore path ran
  // (the row is back); the retained tombstone is what the unlink fault left.
  expect(killedLog(f)).toEqual([]);
  expect(seatsOf(f).alice).toBeDefined();
  expect(tombs(f).length).toBe(1);
  expect(events(f).at(-1)).toContain("outcome=registry_restored");
});

test("live kill failure rolls the registry back and unlinks the tombstone", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const r = run(f, ["out", "alice", "--kill"], { FAKE_KILL_FAIL: "1" });
  expect(r.code).toBe(1);
  expect(seatsOf(f).alice).toBeDefined();
  expect(killedLog(f)).toEqual([]);
  expect(tombs(f).length).toBe(0);
  expect(events(f).at(-1)).toContain("outcome=registry_restored");
  expect(gen(f).state).toBe("reused");
  const j = run(f, ["out", "alice", "--kill"], { FAKE_KILL_FAIL: "1", TAP_JSON: "1" });
  expect(j.code).toBe(1);
  expect(JSON.parse(j.out)).toMatchObject({ ok: false, error_class: "session_kill_failed" });
  // One-owner/one-attempt control: the single rollback left a coherent state,
  // so the refusal's remedy (retry without the fault) retires cleanly.
  expect(r.err).toContain("tap out t/alice --kill");
  const remedy = run(f, ["out", "t/alice", "--kill"]);
  expect(remedy.code).toBe(0);
  expect(seatsOf(f).alice).toBeUndefined();
  expect(killedLog(f)).toEqual(["t/alice"]);
  expect(tombs(f).length).toBe(1);
});

for (const fault of ["FAKE_KILL_FAIL", "TAP_TEST_UNREGISTER_SAVE_FAIL"]) {
  test(`hard-removal remedy stays on the selected team: ${fault}`, () => {
    const a = fix({ tmux: true }); reg(a, { alice: row() });
    const b = otherTeam(a);
    writeFileSync(b.registry, JSON.stringify({ schema: "0.20", team: { name: "b" }, seats: {
      alice: row({ pane: "b/alice", session: "b/alice", pane_id: "%2" }),
    } }));
    fakePanes(a, { "%1": ["t/alice", "@1"], "%2": ["b/alice", "@2"] });
    fakeSession(a, "t/alice"); fakeSession(a, "b/alice");
    const before = readFileSync(a.registry, "utf8");
    const result = run(a, ["shutdown", "b/alice", "--json"], { [fault]: "1" });
    expect(result.code).toBe(1);
    const receipt = JSON.parse(result.out);
    expect(receipt.action).toBe(`tap out b/alice ${fault === "FAKE_KILL_FAIL" ? "--kill" : "--hard"}`);
    expect(seatsOf(b).alice).toBeDefined();
    const retry = run(a, receipt.action.split(" ").slice(1));
    expect(retry.code).toBe(0);
    expect(seatsOf(b).alice).toBeUndefined();
    expect(readFileSync(a.registry, "utf8")).toBe(before);
    expect(killedLog(a)).toEqual(["b/alice"]);
    expect(existsSync(join(a.state, "sessions", "t__alice"))).toBe(true);
  });
}

test("poll shutdown preserves the requested action in human output", () => {
  const f = fix(); reg(f, { alice: row({ delivery: "poll" }) });
  const result = run(f, ["shutdown", "alice"]);
  expect(result.code).toBe(0);
  expect(result.out).toBe("tap shutdown: 'alice' removed from the registry\n");
  expect(seatsOf(f).alice).toBeUndefined();
  expect(events(f).at(-1)).toContain("lifecycle_action=shutdown");
});

test("shutdown preserves malformed registry refusals before missing-seat diagnosis", () => {
  for (const bytes of ["{not json", "[]\n"]) {
    const f = fix(); reg(f, {}); writeFileSync(f.registry, bytes);
    const result = run(f, ["shutdown", "alice", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error_class: "registry_invalid" });
    expect(readFileSync(f.registry, "utf8")).toBe(bytes);
    expect(tombs(f)).toEqual([]);
    expect(gen(f)).toEqual({ state: "pristine" });
  }
});

test("both retirement help doors describe crew hard dismissal", () => {
  const f = fix(); reg(f, {});
  for (const topic of ["out", "unregister"]) {
    const result = run(f, ["help", topic]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("--kill|--hard");
    expect(result.out).toContain("recorded crew pane");
    expect(result.out).not.toContain("--kill refuses");
  }
});

test("an unreadable post-stop observation preserves retirement and reports one unknown receipt", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] }); fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const result = run(f, ["shutdown", "alice", "--json"], { FAKE_OBSERVATION_FAIL_AFTER_KILL: "1" });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.out)).toMatchObject({ ok: false, lifecycle_action: "shutdown", mechanism: "hard-removal", outcome: "stop_unverified" });
  expect(seatsOf(f).alice).toBeUndefined();
  expect(tombs(f)).toHaveLength(1);
  expect(events(f).at(-1)).toContain("outcome=stop_unverified");
  expect(readFileSync(join(f.state, "effect"), "utf8")).toBe("attempt\n");
  expect(result.out).toContain("do not retry");
});

test("hard retirement preserves unrelated wide numbers through the shared codec", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] }); fakeSession(f, "t/alice");
  reg(f, { alice: row(), poll: row({ delivery: "poll", pane_pid: 9007199254740993n }) });
  expect(run(f, ["out", "alice", "--hard"]).code).toBe(0);
  expect(readFileSync(f.registry, "utf8")).toContain("9007199254740993");
});

test("hard removal refuses other durable co-tenants without effects", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"], "%2": ["t/alice", "@1"], "%3": ["t/alice", "@1"], "%4": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, {
    alice: row(),
    bob: row({ pane: "t/bob", pane_id: "%2", session: "t/alice", server_epoch: "", instance: "bob|b1" }),
    // Explicit non-string status must NOT become active/pending: eve keeps her
    // row untouched while the missing-status frank still suspends.
    eve: row({ pane: "t/eve", pane_id: "%3", session: "t/alice", server_epoch: "", instance: "eve|e1", status: null }),
    frank: row({ pane: "t/frank", pane_id: "%4", session: "t/alice", server_epoch: "", instance: "frank|f1" }),
  });
  const r = run(f, ["out", "alice", "--kill"]);
  expect(r.code).toBe(1);
  const seats = seatsOf(f);
  expect(seats.alice).toBeDefined();
  expect(seats.bob!.status).toBeUndefined();
  expect(seats.eve!.status).toBeNull();
  expect(seats.frank!.status).toBeUndefined();
  expect(killedLog(f)).toEqual([]);
});

test("TAP_TEST_UNREGISTER_SAVE_FAIL publishes nothing and discloses cleanup", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const r = run(f, ["out", "alice", "--kill"], { TAP_TEST_UNREGISTER_SAVE_FAIL: "1" });
  expect(r.code).toBe(1);
  expect(seatsOf(f).alice).toBeDefined();
  expect(killedLog(f)).toEqual([]);
  expect(tombs(f).length).toBe(0);
  const j = run(f, ["out", "alice", "--kill"], { TAP_TEST_UNREGISTER_SAVE_FAIL: "1", TAP_JSON: "1" });
  expect(JSON.parse(j.out)).toMatchObject({ ok: false, error_class: "registry_save_failed" });
  const j2 = run(f, ["out", "alice", "--kill"], { TAP_TEST_UNREGISTER_SAVE_FAIL: "1", TAP_TEST_UNREGISTER_UNLINK_FAIL: "1", TAP_JSON: "1" });
  expect(JSON.parse(j2.out)).toMatchObject({ ok: false, error_class: "history_cleanup_failed" });
  expect(j2.out).toContain("inspect retained history");
});

test("TAP_TEST_UNREGISTER_RESTORE_FAIL retains the tombstone and names the remedy", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const j = run(f, ["out", "alice", "--kill"], { FAKE_KILL_FAIL: "1", TAP_TEST_UNREGISTER_RESTORE_FAIL: "1", TAP_JSON: "1" });
  expect(j.code).toBe(1);
  expect(JSON.parse(j.out)).toMatchObject({ ok: false, error_class: "registry_restore_failed" });
  expect(j.out).toContain("registry restore failed; history remains");
  expect(tombs(f).length).toBe(1);
  // A failed restore leaves the published (row-removed) registry on disk; the
  // refusal names the repair instead of pretending the row came back.
  expect(seatsOf(f).alice).toBeUndefined();
  const f2 = fix({ tmux: true });
  fakePanes(f2, { "%1": ["t/alice", "@1"] });
  fakeSession(f2, "t/alice");
  reg(f2, { alice: row() });
  const j2 = run(f2, ["out", "alice", "--kill"], { FAKE_KILL_FAIL: "1", TAP_TEST_UNREGISTER_RESTORE_FAIL: "1", TAP_TEST_UNREGISTER_UNLINK_FAIL: "1", TAP_JSON: "1" });
  expect(JSON.parse(j2.out)).toMatchObject({ ok: false, error_class: "registry_restore_failed" });
  expect(j2.out).toContain("history remains at");
  expect(j2.out).toContain("repair from the retained history");
  expect(tombs(f2).length).toBe(1);
});

test("crew --kill retires an already absent crew without a session stop", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row({ crew: true }) });
  const j = run(f, ["out", "alice", "--kill"], { TAP_JSON: "1" });
  expect(j.code).toBe(0);
  const parsed = JSON.parse(j.out) as Record<string, unknown>;
  expect(parsed).toMatchObject({ ok: true, lifecycle_action: "out-hard", mechanism: "crew-dismiss", outcome: "retired_pane_retained" });
  expect(seatsOf(f).alice).toBeUndefined();
  expect(killedLog(f)).toEqual([]);
});

test("TAP_SCRATCH_ONLY outside the bus root refuses a kill", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  const r = run(f, ["out", "alice", "--kill"], { TAP_SCRATCH_ONLY: "/nonexistent-scratch" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("refusing to clear state outside the declared scratch prefix");
  expect(killedLog(f)).toEqual([]);
});

test("dash refuses a valid non-object registry without touching its bytes", () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const bytes = readFileSync(f.registry, "utf8");
  writeFileSync(f.registry, "[]\n");
  const before = {
    events: existsSync(join(f.bus, "registry-events.log")) ? readFileSync(join(f.bus, "registry-events.log"), "utf8") : "",
    tombs: tombs(f).length,
    gen: readFileSync(join(f.bus, "reset-generation.json"), "utf8"),
  };
  const j = run(f, ["out", "-"], { TAP_JSON: "1" });
  expect(j.code).toBe(1);
  expect(JSON.parse(j.out)).toMatchObject({ ok: false, error_class: "registry_invalid" });
  expect(readFileSync(f.registry, "utf8")).toBe("[]\n");
  expect(bytes).toContain("alice");
  const after = {
    events: existsSync(join(f.bus, "registry-events.log")) ? readFileSync(join(f.bus, "registry-events.log"), "utf8") : "",
    tombs: tombs(f).length,
    gen: readFileSync(join(f.bus, "reset-generation.json"), "utf8"),
  };
  expect(after).toEqual(before);
});

test("dash refuses a seat-less object as old_store and leaves its bytes, tombs and generation", () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const seatless = '{"mystery": 1, "schema": "0.20", "team": {"name": "t"}}\n';
  writeFileSync(f.registry, seatless);
  const r = run(f, ["out", "-"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("old TAP registry format (seats not an object)");
  expect(readFileSync(f.registry, "utf8")).toBe(seatless);
  expect(tombs(f).length).toBe(0);
  expect(gen(f)).toEqual({ state: "pristine" });
});

test("a held registry lock is waited out, not refused (incumbent blocking flock)", async () => {
  const f = fix(); reg(f, { alice: row() });
  const lockPath = `${f.registry}.lock`;
  const marker = `${lockPath}.held`;
  // KERNEL_LOCK + kernelLockArgs keep the holder platform-correct (lockf/flock).
  // The holder proves the hold with a marker before sleeping past the old
  // 5s framework default, so a bounded acquirer would refuse and only the
  // unbounded wait succeeds. The explicit timeout sits safely above the
  // six-second hold (the Linux runner default is 5000ms).
  const holder = Bun.spawn([KERNEL_LOCK, ...kernelLockArgs(lockPath, Infinity, ["sh", "-c", `: > '${marker}'; sleep 6`])], { stdout: "ignore", stderr: "ignore" });
  const markerDeadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < markerDeadline) await new Promise((r) => setTimeout(r, 20));
  expect(existsSync(marker)).toBe(true);
  const started = Date.now();
  const r = run(f, ["out", "alice"]);
  const elapsed = Date.now() - started;
  expect(r.code).toBe(0);
  expect(elapsed).toBeGreaterThanOrEqual(5000);
  expect(seatsOf(f).alice).toBeUndefined();
  expect(events(f).length).toBe(1);
  await holder.exited;
}, 20000);

test("parse refusals keep the incumbent grammar", () => {
  const f = fix(); reg(f, { alice: row() });
  const noValue = run(f, ["out", "--pane"]);
  expect(noValue.code).toBe(1);
  expect(noValue.err).toContain("--pane needs a value");
  const unknown = run(f, ["out", "--wat"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("unknown option '--wat'");
  const extra = run(f, ["out", "alice", "bob"]);
  expect(extra.code).toBe(1);
  expect(extra.err).toContain("unexpected arg 'bob'");
  expect(seatsOf(f).alice).toBeDefined();
});

test("dash honors missing-vs-present status: explicit null excluded, missing status eligible", () => {
  const f = fix({ tmux: true });
  reg(f, {
    carol: row({ pane: "t/carol", pane_id: "%8", session: "t/carol", server_epoch: "", status: null }),
    dave: row({ pane: "t/dave", pane_id: "%7", session: "t/dave", server_epoch: "" }),
  });
  const r = run(f, ["out", "-"]);
  expect(r.code).toBe(0);
  const seats = seatsOf(f);
  // status:null is preserved verbatim — it never becomes a candidacy status,
  // and the scan skips it before stamping exited_at.
  expect(seats.carol).toMatchObject({ status: null });
  expect(seats.carol!.exited_at).toBeUndefined();
  expect(seats.dave).toBeUndefined();
  expect(r.out).toContain("'-' removed 'dave' (most recently exited)");
  expect(events(f).length).toBe(1);
});

test("explicit plain retirement deletes an existing non-object row without a tombstone", () => {
  const f = fix();
  reg(f, { ghost: "stale-scalar", alice: row() });
  const before = gen(f);
  const r = run(f, ["out", "ghost"]);
  expect(r.code).toBe(0);
  const seats = seatsOf(f);
  expect(seats.ghost).toBeUndefined();
  expect(seats.alice).toBeDefined();
  expect(r.out).toContain("'ghost' removed from the registry");
  expect(events(f).length).toBe(1);
  expect(tombs(f).length).toBe(0);
  // No session facts for a scalar row: generation mark, event, no hints.
  expect(gen(f)).not.toEqual(before);
});

function gitShim(f: Fix, teamRoot: string): void {
  writeFileSync(join(f.fakeBin, "git"), `#!/bin/sh\ncase "$1 $2" in\n  "rev-parse --show-toplevel") echo '${teamRoot}' ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
}

test("nameless --team never derives a foreign caller's handle into the selected team", () => {
  const a = fix({ tmux: true }); reg(a, { alice: row() });
  const b = otherTeam(a);
  const teamRoot = join(a.root, "t"); mkdirSync(teamRoot);
  gitShim(a, teamRoot);
  fakePanes(a, { "%1": ["t/alice", "@1"] });
  const before = [a, b].map(f => readFileSync(f.registry, "utf8"));
  for (const flags of [[], ["--kill"]]) {
    const r = run(a, ["out", "--team", "b", "--pane", "%1", ...flags, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error_class: "identity_unverified" });
    expect([a, b].map(f => readFileSync(f.registry, "utf8"))).toEqual(before);
    expect(events(b)).toEqual([]);
    expect(tombs(b)).toEqual([]);
  }
  const local = run(a, ["out", "--team", "t", "--pane", "%1"]);
  expect(local.code).toBe(0);
  expect(seatsOf(a).alice).toBeUndefined();
  expect(readFileSync(b.registry, "utf8")).toBe(before[1]!);
});

test("nameless out derives verbatim from the qualified team/session form", () => {
  const f = fix({ tmux: true });
  const teamRoot = join(f.root, "tap");
  mkdirSync(teamRoot, { recursive: true });
  gitShim(f, teamRoot);
  // No row carries pane_id %4, so pane resolution misses and the handle comes
  // from the session name: tap/claude-code-2 -> claude-code-2 VERBATIM (the
  // incumbent's early return — no suffix or harness stripping).
  fakePanes(f, { "%4": ["tap/claude-code-2", "@4"] });
  reg(f, { "claude-code-2": row({ pane: "t/x", pane_id: "%6", session: "t/other", instance: "cc2|c1" }), bob: row({ pane: "t/bob", pane_id: "%9", session: "t/bob", instance: "bob|b1" }) });
  const r = run(f, ["out", "--pane", "%4"]);
  expect(r.code).toBe(0);
  const seats = seatsOf(f);
  expect(seats["claude-code-2"]).toBeUndefined();
  expect(seats.bob).toBeDefined();
  expect(r.out).toContain("'claude-code-2' removed from the registry");
});

test("nameless out strips the actual team prefix, not a literal", () => {
  const f = fix({ tmux: true });
  const teamRoot = join(f.root, "tap");
  mkdirSync(teamRoot, { recursive: true });
  gitShim(f, teamRoot);
  // tap-alice-2 -> alice-2 under team 'tap' (the strip uses the team argument;
  // the -2 suffix and its index are preserved per the incumbent rule).
  fakePanes(f, { "%4": ["tap-alice-2", "@4"] });
  reg(f, { "alice-2": row({ pane: "t/x", pane_id: "%6", session: "t/other", instance: "a2|c1" }), bob: row({ pane: "t/bob", pane_id: "%9", session: "t/bob", instance: "bob|b1" }) });
  const r = run(f, ["out", "--pane", "%4"]);
  expect(r.code).toBe(0);
  const seats = seatsOf(f);
  expect(seats["alice-2"]).toBeUndefined();
  expect(seats.bob).toBeDefined();
  expect(r.out).toContain("'alice-2' removed from the registry");
});

test("nameless out keeps the bare-session harness-tag rule", () => {
  const f = fix({ tmux: true });
  // claude-ops -> ops (no team prefix; the AGENT_FAMILIES dash strip applies).
  fakePanes(f, { "%4": ["claude-ops", "@4"] });
  reg(f, { ops: row({ pane: "t/x", pane_id: "%6", session: "t/other", instance: "ops|c1" }), bob: row({ pane: "t/bob", pane_id: "%9", session: "t/bob", instance: "bob|b1" }) });
  const r = run(f, ["out", "--pane", "%4"]);
  expect(r.code).toBe(0);
  const seats = seatsOf(f);
  expect(seats.ops).toBeUndefined();
  expect(seats.bob).toBeDefined();
  expect(r.out).toContain("'ops' removed from the registry");
});

test("crew out refuses on an unsettled canonical envelope with extra separator spaces; settles when done", () => {
  const twoSpace = (id: string): string =>
    `---\nid:  ${id}\nfrom:  alice\nto:  bob\nkind:  note\npath:  p\n---\n\nbody\n`;
  const f = fix();
  reg(f, { alice: row({ crew: true }) });
  writeFileSync(join(f.bus, "payloads", "r3env1.md"), twoSpace("r3env1"));
  const r = run(f, ["out", "alice"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("unresolved local obligations");
  expect(r.err).toContain("outbound alice id=r3env1; next: tap outstanding alice");
  expect(seatsOf(f).alice).toBeDefined();
  expect(events(f).length).toBe(0);
  // Settled control: the same envelope with its receipt done-marker no longer
  // blocks, and the crew seat retires with the session note intact.
  const f2 = fix();
  reg(f2, { alice: row({ crew: true }) });
  writeFileSync(join(f2.bus, "payloads", "r3env2.md"), twoSpace("r3env2"));
  writeFileSync(join(f2.bus, "receipts", "r3env2.done"), "");
  const r2 = run(f2, ["out", "alice"]);
  expect(r2.code).toBe(0);
  expect(seatsOf(f2).alice).toBeUndefined();
  expect(events(f2).length).toBe(1);
});

for (const command of [["out"], ["crew", "shutdown"]]) {
  test(`${command.join(" ")} leaves outbound notes and replies readable after crew retirement`, () => {
    const f = fix();
    reg(f, { alice: row({ crew: true }), bob: row({ delivery: "poll", instance: "bob|b1", pane_id: "", session: "" }) });
    for (const kind of ["note", "reply", "placed"]) {
      const id = `crew-${kind}`, path = join(f.bus, "payloads", `${id}.md`);
      writeFileSync(path, `---\nid: ${id}\nfrom: alice\nto: bob\nkind: ${kind}\nreply: settle-only\nrecipient_instance: bob|b1\npath: ${path}\n---\n\ncrew result\n`);
      if (kind !== "placed") writeFileSync(join(f.bus, "receipts", `${id}.sent`), "");
    }
    const result = run(f, [...command, "alice", "--json"]);
    expect(result.code, result.out + result.err).toBe(0);
    expect(seatsOf(f).alice).toBeUndefined();
    expect(result.err).toContain("delivered, unread by bob");
    const poll = run(f, ["poll", "bob"], { TAP_SELF: "bob" });
    expect(poll.code, poll.err).toBe(0);
    expect(poll.out).toContain("crew-placed");
    for (const kind of ["note", "reply", "placed"]) {
      const id = `crew-${kind}`, done = join(f.bus, "receipts", `${id}.done`);
      expect(result.err).toContain(id);
      expect(existsSync(done)).toBe(false);
      const read = run(f, ["read", id, "--by", "bob"], { TAP_SELF: "bob" });
      expect(read.code, read.out + read.err).toBe(0);
      expect(read.out).toContain("crew result");
      expect(JSON.parse(readFileSync(done, "utf8"))).toMatchObject({ by: "bob", via: "read" });
    }
  });
}

for (const direction of ["inbound", "outbound"]) test(`crew retirement still blocks unanswered ${direction} asks`, () => {
  const f = fix(); reg(f, { alice: row({ crew: true }) });
  const id = `open-${direction}`, from = direction === "inbound" ? "bob" : "alice", to = direction === "inbound" ? "alice" : "bob";
  writeFileSync(join(f.bus, "payloads", `${id}.md`), `---\nid: ${id}\nfrom: ${from}\nto: ${to}\nkind: order\nreply: expected\npath: p\n---\n\nwork\n`);
  const result = run(f, ["crew", "shutdown", "alice"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain(`${direction} ${from} id=${id}`);
  expect(seatsOf(f).alice).toBeDefined();
});

test("crew retirement reports spooled outbound notes as queued, without settling them", () => {
  const f = fix(); reg(f, { alice: row({ crew: true }) });
  const path = join(f.bus, "spool", "queued-out.md");
  writeFileSync(path, "---\nid: queued-out\nfrom: alice\nto: bob\nkind: note\nreply: settle-only\npath: p\n---\n\nbody\n");
  const result = run(f, ["out", "alice"]);
  expect(result.code, result.out + result.err).toBe(0);
  expect(result.out).toContain("queued, unread by bob");
  expect(result.out).toContain("may expire undelivered");
  expect(result.out).not.toContain("delivered, unread");
  expect(readFileSync(path, "utf8")).toContain("body");
  expect(existsSync(join(f.bus, "receipts", "queued-out.done"))).toBe(false);
});

for (const deadlineSource of ["readiness-gate", "autosettle-hold"]) test(`retired crew queued note survives ${deadlineSource} expiry as readable canonical content`, async () => {
  const f = fix();
  reg(f, { alice: row({ crew: true }), bob: row({ delivery: "poll", instance: "bob|b1", pane_id: "", session: "" }) });
  const id = "expired-crew-note", path = join(f.bus, "spool", `${id}.md`), canon = join(f.bus, "payloads", `${id}.md`);
  const body = `---\nid: ${id}\nfrom: alice\nto: bob\nkind: note\nreply: settle-only\nrecipient_instance: bob|b1\npath: ${canon}\n---\n\nretained crew result\n`;
  const escalatedAt = new Date(1000_000).toISOString();
  writeFileSync(path, body);
  writeFileSync(join(f.bus, "spool", `${id}.meta.json`), JSON.stringify({ id, target: "bob", escalated_at: escalatedAt, deadline_source: deadlineSource }));
  expect(run(f, ["out", "alice"]).code).toBe(0);
  const deadline: DeadlineRow = { id, target: "bob", reason: "pending-input", reasonClass: "busy", timeoutSeconds: "300", firstEpoch: "1", pane: "", paneId: "", toTeam: "t", targetRegistry: f.registry, policy: "standard", deadlineEpoch: "500", escalatedAt, deadlineSource, holdUntilEpoch: "0" };
  expect(await disposeSenderGone({ home: f.bus, spoolDir: join(f.bus, "spool"), eventLog: join(f.bus, "registry-events.log"), team: "t", verbLabel: "tap test", actingRegistry: f.registry, scriptsDir: "", alert: { mode: "none" }, now: 2800, unroutedGrace: 1800, env: f.env }, deadline)).toBe(true);
  expect(readFileSync(canon, "utf8")).toBe(body);
  expect(existsSync(path)).toBe(false);
  const cancelled = join(f.bus, "receipts", `${id}.cancelled`);
  expect(existsSync(cancelled)).toBe(deadlineSource === "autosettle-hold");
  if (deadlineSource === "autosettle-hold") expect(JSON.parse(readFileSync(cancelled, "utf8")).reason).toBe("sender_gone");
  else {
    const poll = run(f, ["poll", "bob"], { TAP_SELF: "bob" });
    expect(poll.code, poll.err).toBe(0);
    expect(poll.out).toContain(id);
  }
  const read = run(f, ["read", id, "--by", "bob"], { TAP_SELF: "bob" });
  expect(read.code, read.err).toBe(0);
  expect(read.out).toContain("retained crew result");
});

test("JSON crew retirement preserves sender-owned queued-mail notices on stderr", () => {
  const f = fix(); reg(f, { alice: row({ crew: true }) });
  writeFileSync(join(f.bus, "spool", "queued-note.md"), "---\nid: queued-note\nfrom: bob\nto: alice\nkind: note\nreply: settle-only\npath: p\n---\n\nbody\n");
  const result = run(f, ["out", "alice", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ ok: true, mechanism: "crew-dismiss" });
  expect(result.err).toContain("queued-note");
  expect(result.err).toContain("tap cancel queued-note --by bob");
  expect(existsSync(join(f.bus, "spool", "queued-note.md"))).toBe(true);
});

test("dash treats a drained courier bucket as no answer: the live row is retained", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  reg(f, { alice: row() });
  fakeSession(f, "t/alice");
  // Drain the shared per-socket token bucket with a fixed future clock so no
  // refill happens between claims: RATE_CAPACITY claims succeed, then the
  // bucket reports empty. paneAlive must not consult this bucket at all.
  const socket = physicalSocketPath(f.env as unknown as NodeJS.ProcessEnv);
  const future = Date.now() + 3_600_000;
  let drained = false;
  for (let i = 0; i < 64; i++) {
    const claim = claimTmuxStart(socket, future, f.env as unknown as NodeJS.ProcessEnv);
    if (!claim.ok) { drained = true; break; }
  }
  expect(drained).toBe(true);
  const r = run(f, ["out", "-"]);
  // The probe answers through the unthrottled read-only door: the pane is
  // live, so the scan refuses (no dead seats) and never retires the row.
  expect(r.code).toBe(1);
  expect(r.err).toContain("no eligible exited seats");
  expect(seatsOf(f).alice).toBeDefined();
  expect(events(f).length).toBe(0);
  expect(tombs(f).length).toBe(0);
});

test("tagged Bus refusals render as themselves, not registry_invalid", () => {
  // A legacy registry must refuse old_store before any bus or roster effect.
  const f = fix(); reg(f, { alice: row() });
  mkdirSync(join(f.root, "other"), { recursive: true });
  writeFileSync(join(f.index, "global-registry.json"), JSON.stringify({ schema: "0.20", teams: { t: { root: join(f.root, "other"), registry_location: f.registry, state: "registered" } } }));
  mkdirSync(join(f.cwd, "tmp", "tap"), { recursive: true });
  writeFileSync(join(f.cwd, "tmp", "tap", "registry.json"), '{"schema":"0.20","seats":{}}\n');
  rmSync(f.bus, { recursive: true });
  const legacy = run(f, ["out", "-"], { TAP_JSON: "1" });
  expect(legacy.code).toBe(1);
  const parsed = JSON.parse(legacy.out) as Record<string, unknown>;
  expect(parsed).toMatchObject({ ok: false, error_class: "old_store", action: `move ${join(f.cwd, "tmp", "tap")} aside by hand, then run tap init` });
  expect(String(parsed.detail)).toContain("never converts old stores");
  const human = run(f, ["out", "-"]);
  expect(human.code).toBe(1);
  expect(human.err).toContain("old TAP bus location");
  expect(human.err).toContain("aside by hand, then run tap init");
  // bus_authority_unwritable: existing bus whose root cannot be stamped.
  const f2 = fix(); reg(f2, { alice: row() });
  chmodSync(f2.bus, 0o555);
  try {
    const r2 = run(f2, ["out", "-"], { TAP_JSON: "1" });
    expect(r2.code).toBe(1);
    const p2 = JSON.parse(r2.out) as Record<string, unknown>;
    expect(p2).toMatchObject({ ok: false, error_class: "bus_authority_unwritable" });
    expect(String(p2.action)).toContain("fix TAP_HOME's own permissions");
  } finally {
    chmodSync(f2.bus, 0o755);
  }
});

// Codex r4056053326: a dash selection REPLACES form.name while form.dash
// stays true, so the bypass must never apply to it. Control: dash picks the
// dead seat from a live enrollment, the enrollment VANISHES while the run is
// paused after selection (marker deleted), and the second transaction must
// revalidate (team_moved -> rebind) instead of deleting from the formerly
// acting registry through the bypass.
test("dash race with a vanishing enrollment revalidates; formerly acting registry stays intact", async () => {
  // Pre-stamped exited_at: the dash scan publishes stamps by design, so this
  // control asserts semantic preservation, not byte identity.
  const f = fix({ tmux: true }); reg(f, { bob: row({ pane: "t/bob", pane_id: "%9", session: "t/bob", server_epoch: "", exited_at: "2026-09-20T00:00:00Z" }) });
  const barrier = join(f.root, "barrier");
  const beforeDoc = JSON.parse(readFileSync(f.registry, "utf8")) as { seats: Record<string, unknown> };
  const env = { ...f.env, TAP_SCRATCH_ONLY: f.root, TAP_OUT_RETIRE_TEST_BARRIER: barrier, TAP_OUT_RETIRE_TEST_STAGE: "after-select" } as NodeJS.ProcessEnv;
  const proc = Bun.spawn([process.execPath, MAIN, "out", "-"], { cwd: f.cwd, env, stdout: "pipe", stderr: "pipe" });
  const ready = `${barrier}.ready`;
  const deadline = Date.now() + 10000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(existsSync(ready)).toBe(true);
  // The enrollment vanishes while the dash-selected retirement is paused.
  rmSync(join(f.index, "global-registry.json"));
  writeFileSync(`${barrier}.continue`, "");
  await proc.exited;
  // Revalidation refuses the vanished authority (team_moved -> rebind -> the
  // rebound pre-flip bus has no acting registry -> flip_in_progress). Either
  // way the chosen handle is never deleted from mismatched bytes.
  expect(proc.exitCode).toBe(1);
  const afterDoc = JSON.parse(readFileSync(f.registry, "utf8")) as { seats: Record<string, unknown> };
  expect(afterDoc).toEqual(beforeDoc);
  expect(afterDoc.seats.bob).toBeDefined();
}, 20000);

// Codex r4056053327: a selection resolved while live must not ride the
// absent-fresh-marker bypass — the live-to-absent team_moved fence stays.
// Control: explicit bare name over a live enrollment whose marker vanishes
// under the lock; the formerly acting registry must remain byte-identical
// and no row may retire through vanished enrollment authority.
test("live-to-absent flip under the lock keeps the fence for explicit bare names", async () => {
  const f = fix(); reg(f, { alice: row(), keeper: row({ pane: "t/keeper", pane_id: "%9", session: "t/keeper", instance: "keeper|k1" }) });
  const barrier = join(f.root, "barrier");
  const before = readFileSync(f.registry, "utf8");
  const env = { ...f.env, TAP_SCRATCH_ONLY: f.root, TAP_OUT_RETIRE_TEST_BARRIER: barrier, TAP_OUT_RETIRE_TEST_STAGE: "after-select" } as NodeJS.ProcessEnv;
  const proc = Bun.spawn([process.execPath, MAIN, "out", "alice"], { cwd: f.cwd, env, stdout: "pipe", stderr: "pipe" });
  const ready = `${barrier}.ready`;
  const deadline = Date.now() + 10000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(existsSync(ready)).toBe(true);
  // The enrollment authority vanishes while the run holds the pause.
  rmSync(join(f.index, "global-registry.json"));
  writeFileSync(`${barrier}.continue`, "");
  await proc.exited;
  // team_moved refused the stale authority; the rebind lands on the pre-flip
  // default bus where nothing is registered. Either way: no retirement here.
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  const doc = JSON.parse(before) as { seats: Record<string, unknown> };
  expect(doc.seats.alice).toBeDefined();
  expect(doc.seats.keeper).toBeDefined();
}, 20000);

// tap-s1dqn: retirement withdraws the departed seat's unsettled inbound with a
// `.cancelled` receipt (payload kept), and only once the retirement stands.
function inbound(f: Fix, id: string, to: string): void {
  const path = join(f.bus, "payloads", `${id}.md`);
  writeFileSync(path, `---\nid: ${id}\nfrom: lead\nto: ${to}\nkind: discuss\nreply: expected\npath: ${path}\n---\nbody\n`);
}
const withdrawn = (f: Fix, id: string) => existsSync(join(f.bus, "receipts", `${id}.cancelled`));

test("plain out withdraws only the retiring seat's unsettled inbound and keeps the payloads", () => {
  const f = fix(); reg(f, { alice: row(), bob: row({ pane: "t/bob", session: "t/bob", pane_id: "%2", instance: "bob|b1" }) });
  inbound(f, "in-001", "alice");
  inbound(f, "in-002", "bob");
  inbound(f, "in-003", "alice");
  writeFileSync(join(f.bus, "receipts", "in-003.done"), "");
  const r = run(f, ["out", "alice"]);
  expect(r.code, r.err).toBe(0);
  expect(r.out).toContain("withdrew 1 unsettled inbound to 'alice'");
  expect(withdrawn(f, "in-001")).toBe(true);
  expect(JSON.parse(readFileSync(join(f.bus, "receipts", "in-001.cancelled"), "utf8"))).toMatchObject({ by: "tap out", reason: "seat_unresolvable", via: "cancelled", target: "alice" });
  expect(existsSync(join(f.bus, "payloads", "in-001.md"))).toBe(true);
  expect(withdrawn(f, "in-002")).toBe(false);
  expect(withdrawn(f, "in-003")).toBe(false);
  // JSON keeps the retirement receipt as stdout's only line.
  const g = fix(); reg(g, { alice: row({ delivery: "poll" }) });
  inbound(g, "in-004", "alice");
  const j = run(g, ["out", "alice", "--kill", "--json"]);
  expect(j.code, j.err).toBe(0);
  expect(JSON.parse(j.out)).toMatchObject({ ok: true, outcome: "retired" });
  expect(j.err).toContain("withdrew 1 unsettled inbound to 'alice'");
  expect(withdrawn(g, "in-004")).toBe(true);
});

test("out --kill withdraws inbound after a stop, and keeps it when the stop fails and the row is restored", () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["t/alice", "@1"] });
  fakeSession(f, "t/alice");
  reg(f, { alice: row() });
  inbound(f, "k-001", "alice");
  const failed = run(f, ["out", "alice", "--kill"], { FAKE_KILL_FAIL: "1" });
  expect(failed.code).toBe(1);
  expect(seatsOf(f).alice).toBeDefined();
  expect(withdrawn(f, "k-001")).toBe(false);
  const ok = run(f, ["out", "alice", "--kill"]);
  expect(ok.code, ok.err).toBe(0);
  expect(withdrawn(f, "k-001")).toBe(true);
});

for (const spelling of ["--last", "-"]) test(`last selection ${spelling} includes delivery-marked exits and excludes parked or revived rows`, () => {
  const f = fix({ tmux: true });
  fakePanes(f, { "%1": ["shared", "@1"] }); fakeSession(f, "shared");
  reg(f, {
    old: row({ session: "absent", exited_at: "2026-10-20T00:00:00Z" }),
    sharedGone: row({ session: "shared", pane: "shared:9.8", pane_id: "%8", exited_at: "2026-10-20T12:00:00Z" }),
    latest: row({ status: "suspended", status_reason: "pane_gone", session: "shared", pane: "shared:9.9", pane_id: "%7", exited_at: "2026-10-21T00:00:00Z" }),
    live: row({ session: "shared", pane: "shared:0.0" }),
    launching: row({ status_reason: "launching", launch_id: "launch|pending", session: "shared", pane: "shared:9.7", pane_id: "%99", exited_at: "2099-01-01T00:00:00Z" }),
    reportedLive: row({ status: "suspended", status_reason: "pane_gone", session: "shared", pane: "shared:0.0", exited_at: "2099-01-01T00:00:00Z" }),
    pending: row({ status: "pending" }), parked: row({ status: "suspended", status_reason: "session_stopped" }),
    poll: row({ delivery: "poll" }), foreign: row({ team: "other" }), socket: row({ server_socket: "/foreign" }),
  });
  const preview = run(f, ["team", "refresh", "--dry-run", "--json"]);
  expect(preview.code, preview.out + preview.err).toBe(0);
  expect(JSON.parse(preview.out).trimmed.map((r: { handle: string }) => r.handle)).toContain("sharedGone");
  const result = run(f, ["out", spelling]);
  expect(result.code, result.out + result.err).toBe(0);
  expect(seatsOf(f).latest).toBeUndefined();
  expect(Object.keys(seatsOf(f)).sort()).toEqual(["foreign", "launching", "live", "old", "parked", "pending", "poll", "reportedLive", "sharedGone", "socket"]);
});

for (const spelling of ["--last", "-"]) test(`last selection ${spelling} refuses an unreadable snapshot without stamping registry bytes`, () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const before = readFileSync(f.registry, "utf8");
  const result = run(f, ["out", spelling], { FAKE_SNAPSHOT_FAIL: "1" });
  expect(result.code).toBe(1);
  expect(result.err).toContain("unobservable");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(tombs(f)).toEqual([]);
});

for (const extra of [["alice"], ["--pane", "%1"], ["--kill"]]) test(`last selection conflicts with ${extra.join(" ")}`, () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const before = readFileSync(f.registry, "utf8");
  expect(run(f, ["out", "--last", ...extra]).code).toBe(1);
  expect(readFileSync(f.registry, "utf8")).toBe(before);
});

for (const change of ["revival", "replacement", "suspension"]) test(`last selection refuses ${change} before retirement`, async () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const barrier = join(f.root, "last-barrier");
  const proc = Bun.spawn([process.execPath, MAIN, "out", "--last", "--json"], { cwd: f.cwd,
    env: { ...f.env, TAP_SCRATCH_ONLY: f.root, TAP_OUT_RETIRE_TEST_BARRIER: barrier, TAP_OUT_RETIRE_TEST_STAGE: "after-dash-select" }, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 10000;
  while (!existsSync(barrier + ".ready") && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(barrier + ".ready")).toBe(true);
  if (change === "revival") { fakePanes(f, { "%1": ["t/alice", "@1"] }); fakeSession(f, "t/alice"); }
  else { const seats = seatsOf(f); seats.alice![change === "replacement" ? "instance" : "status"] = change === "replacement" ? "new|identity" : "suspended"; reg(f, seats); }
  writeFileSync(barrier + ".continue", "");
  expect(await proc.exited).toBe(1);
  expect(seatsOf(f).alice).toBeDefined();
  expect(tombs(f)).toEqual([]);
}, 20000);

for (const [point, failure] of [["list-sessions", "timeout"], ["socket", "fork"]]) test(`last read ${point} ${failure} has retryable no-effect guidance`, () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const before = readFileSync(f.registry, "utf8");
  const result = run(f, ["out", "--last", "--json"], { FAKE_LAST_READ: point, FAKE_LAST_FAILURE: failure, TAP_TMUX_TIMEOUT_SECONDS: "0.05" });
  expect(result.code).toBe(1);
  const error = JSON.parse(result.out);
  expect(error.error_class).toBe("observation_unobservable");
  expect(error.action).toContain("retry");
  expect(error.action).not.toContain("possible effect");
  expect(readFileSync(f.registry, "utf8")).toBe(before);
  expect(tombs(f)).toEqual([]);
});

for (const spelling of ["--last", "-"]) for (const answer of ["no server running on private fixture", "error connecting to private fixture (No such file or directory)"])
 test(`last empty namespace ${spelling}: ${answer}`, () => {
  const f = fix({ tmux: true });
  writeFileSync(join(f.state, "no-server"), answer);
  reg(f, {
    old: row({ exited_at: "2026-10-20T00:00:00Z" }),
    latest: row({ pane_id: "%9", server_socket: physicalSocketPath(f.env), exited_at: "2026-10-21T00:00:00Z" }),
    foreign: row({ server_socket: "/foreign/socket", exited_at: "2099-01-01T00:00:00Z" }),
    pending: row({ status: "pending" }), stopped: row({ status: "suspended", status_reason: "session_stopped" }),
    launching: row({ status_reason: "launching", launch_id: "pending|1" }), poll: row({ delivery: "poll" }),
    shapeless: { status: "active", delivery: "pane" },
  });
  const result = run(f, ["out", spelling]);
  expect(result.code, result.out + result.err).toBe(0);
  expect(Object.keys(seatsOf(f)).sort()).toEqual(["foreign", "launching", "old", "pending", "poll", "shapeless", "stopped"]);
});

test("last empty namespace revalidates when a server starts before retirement", async () => {
  const f = fix({ tmux: true }); reg(f, { alice: row({ server_socket: physicalSocketPath(f.env) }) });
  writeFileSync(join(f.state, "no-server"), "no server running on private fixture");
  const barrier = join(f.root, "empty-barrier");
  const proc = Bun.spawn([process.execPath, MAIN, "out", "--last", "--json"], { cwd: f.cwd,
    env: { ...f.env, TAP_SCRATCH_ONLY: f.root, TAP_OUT_RETIRE_TEST_BARRIER: barrier, TAP_OUT_RETIRE_TEST_STAGE: "after-dash-select" }, stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 10000;
  while (!existsSync(barrier + ".ready") && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(barrier + ".ready")).toBe(true);
  rmSync(join(f.state, "no-server"));
  fakePanes(f, { "%1": ["t/alice", "@1"] }); fakeSession(f, "t/alice");
  writeFileSync(barrier + ".continue", "");
  expect(await proc.exited).toBe(1);
  expect(seatsOf(f).alice).toBeDefined(); expect(tombs(f)).toEqual([]);
}, 20000);

test("last poisoned foreign panes preserve exact registry bytes", () => {
  const f = fix({ tmux: true }); reg(f, { alice: row() });
  const compact = JSON.stringify(JSON.parse(readFileSync(f.registry, "utf8")));
  writeFileSync(f.registry, compact);
  const result = run(f, ["out", "--last"], { FAKE_POISONED_FOREIGN: "1" });
  expect(result.code).toBe(1);
  expect(readFileSync(f.registry, "utf8")).toBe(compact);
  expect(tombs(f)).toEqual([]);
});
