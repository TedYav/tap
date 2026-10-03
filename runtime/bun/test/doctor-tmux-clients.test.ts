import { describe, expect, test } from "bun:test";

import {
  flagsHaveNonblock,
  isAttachClientCommand,
  parseLsofFileFlags,
  parsePsSnapshot,
  scanTmuxClientHazards,
  type CommandResult,
  type Finding as HazardFinding,
} from "../src/verbs/doctor";

// Detector inputs are the exact evidence shapes of the 2026-09-03 incident
// (tmp/incident-tmux-20260903T214037Z: pgrp.txt, lsof-server-59772.txt), not
// invented summaries: the regression control reproduces the detector's real
// evidence path. Nothing here talks to the host tmux server or clients — every
// process observation is a fixture through the injected runner.

const INCIDENT_PS = [
  "  20642 17179 10569 ttys049 tmux attach-session -t =tap/terra-researcher",
  "  73190 70468 66052 ttys053 tmux attach-session -t =sidecar/opus",
  "  74221 74221 74221 ttys042 tmux attach -t tap/fable-7-3-leader",
  "  73449 73449 10569 ttys049 -zsh",
  "  10580 10569 10569 ttys049 tmux list-sessions -F #{session_name}",
  "   1234 1234 0 ?? tmux attach-session -t =background-launch",
  "   9999 9999 1234 ttys070 grep tmux attach-session notes.txt",
  "   4242 4242 900 ttys060 tmux -T RGB attach-session -t =tap/three",
].join("\n");

const INCIDENT_LSOF = [
  "COMMAND   PID   USER   FD   TYPE         FILE-FLAG             DEVICE   SIZE/OFF                NODE NAME",
  "tmux    59772 tapdev  cwd    DIR                                 1,13       1152           239697475 /srv/work/tap",
  "tmux    59772 tapdev    0u   CHR            R,W;SH                3,2        0t0                 336 /dev/null",
  "tmux    59772 tapdev    5u  unix            R,W,NB 0xff5d525b5d698c77        0t0                     /private/tmp/tmux-502/default",
  "tmux    59772 tapdev    7u   CHR    R,W,0x10000;SH              16,48 0x101b1395               14597 /dev/ttys048",
  "tmux    59772 tapdev    8u   CHR    R,W,NB,0x10000             15,157 0t33482819                 605 /dev/ptmx",
  "tmux    59772 tapdev   43u   CHR R,W,NB,0x11000;SH              16,42 0x1248734a               15441 /dev/ttys042",
  "tmux    59772 tapdev   52u   CHR    R,W,0x10000;SH              16,49 0t83864939               14789 /dev/ttys049",
  "tmux    59772 tapdev    3   PIPE                   0x380e22015d835a36      16384                     ->0x67f19187aa4c2647",
].join("\n");

const PS_ARGS = "ps -axo pid=,pgid=,tpgid=,tty=,command=";
const PROBE_ARGS = "tmux -S /tmp/fake/tmux-socket display-message -p #{pid}";
const LSOF_ARGS = "lsof +fg -nP -p 59772";

function incidentFixtures(): Record<string, CommandResult | null> {
  return {
    [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" },
    [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" },
    [LSOF_ARGS]: { status: 0, stdout: INCIDENT_LSOF, stderr: "" },
  };
}

function runScan(
  outputs: Record<string, CommandResult | null> = incidentFixtures(),
  platform: NodeJS.Platform = "darwin",
): { findings: HazardFinding[]; calls: string[] } {
  const calls: string[] = [];
  const findings: HazardFinding[] = [];
  scanTmuxClientHazards(findings, {}, {
    run: (cmd, args, timeoutMs) => {
      calls.push([cmd, ...args].join(" "));
      expect(timeoutMs).toBeGreaterThan(0);
      const key = [cmd, ...args].join(" ");
      if (!(key in outputs)) throw new Error(`fixture runner got an unexpected call: ${key}`);
      return outputs[key] ?? null;
    },
    platform,
    socket: () => "/tmp/fake/tmux-socket",
  });
  return { findings, calls };
}

describe("doctor tmux client hazard scan (tap-7r3fn.17.1)", () => {
  test("the ps snapshot parser reads padded columns and flags incomplete snapshots", () => {
    const parsed = parsePsSnapshot(INCIDENT_PS);
    expect(parsed.rows.length).toBe(8);
    expect(parsed.complete).toBe(true);
    expect(parsed.rows[0]).toEqual({
      pid: "20642", pgid: "17179", tpgid: "10569", tty: "ttys049",
      command: "tmux attach-session -t =tap/terra-researcher",
    });
    // A mixed snapshot — valid rows plus a truncated one — is incomplete, but
    // the rows that did parse survive.
    const mixed = parsePsSnapshot(`${INCIDENT_PS}\n  5000 5000 900 ttys0`);
    expect(mixed.rows.length).toBe(8);
    expect(mixed.complete).toBe(false);
  });

  test("only a process whose executable is tmux matches the attach lens", () => {
    expect(isAttachClientCommand("tmux attach-session -t =tap/x")).toBe(true);
    expect(isAttachClientCommand("/opt/homebrew/bin/tmux -S /tmp/s attach -t x")).toBe(true);
    expect(isAttachClientCommand("tmux -L other attach-session")).toBe(true);
    // -T takes a value (terminal features); the value is not a subcommand.
    expect(isAttachClientCommand("tmux -T RGB attach-session -t work")).toBe(true);
    // A non-tmux executable carrying tmux words as data is not a client.
    expect(isAttachClientCommand("grep tmux attach-session notes.txt")).toBe(false);
    expect(isAttachClientCommand("python launcher.py tmux attach-session")).toBe(false);
    expect(isAttachClientCommand("tmux list-sessions -F #{session_name}")).toBe(false);
    expect(isAttachClientCommand("tmux -S /tmp/s new-session -d")).toBe(false);
    expect(isAttachClientCommand("/bin/sh -c tmux attach-session -t x")).toBe(false);
  });

  test("flagsHaveNonblock reads the lsof +fg open-flag group before the ';'", () => {
    expect(flagsHaveNonblock("R,W,NB,0x11000;SH")).toBe(true);
    expect(flagsHaveNonblock("R,W,0x10000;SH")).toBe(false);
    expect(flagsHaveNonblock("R,W;SH")).toBe(false);
  });

  test("the lsof +fg parser keeps CHR rows and reports a shape it cannot fully parse", () => {
    const parsed = parseLsofFileFlags(INCIDENT_LSOF);
    expect(parsed.complete).toBe(true);
    expect(parsed.rows.map((r) => r.fd).sort()).toEqual(["0u", "43u", "52u", "7u", "8u"]);
    expect(parsed.rows.find((r) => r.fd === "52u")).toEqual({
      fd: "52u", type: "CHR", flags: "R,W,0x10000;SH", name: "/dev/ttys049",
    });
    // A PIPE row drops its FILE-FLAG column; a torn CHR line must turn the
    // whole read unknown, never a silent partial.
    const torn = INCIDENT_LSOF.replace(
      "R,W,NB,0x11000;SH              16,42 0x1248734a               15441 /dev/ttys042",
      "R,W,NB,0x11000;SH",
    );
    expect(parseLsofFileFlags(torn).complete).toBe(false);
  });

  test("both incident hazards are detected with exact evidence", () => {
    const { findings } = runScan();
    const clients = findings.filter((f) => f.name === "background_attach_client");
    // 4242 covers the separated -T value: tmux -T RGB attach-session.
    expect(clients.map((f) => f.detail.pid).sort((a, b) => Number(a) - Number(b))).toEqual([4242, 20642, 73190]);
    const ttys049 = clients.find((f) => f.detail.pid === 20642)!;
    expect(ttys049.severity).toBe("warning");
    expect(ttys049.detail).toEqual({
      pid: 20642, pgid: 17179, tty: "ttys049", foreground_pgid: 10569,
      command: "tmux attach-session -t =tap/terra-researcher",
    });
    expect(ttys049.problem).toContain("pgid 17179");
    expect(ttys049.problem).toContain("ttys049");
    expect(ttys049.next).toBeTruthy();

    const fds = findings.filter((f) => f.name === "blocking_client_tty_fd");
    expect(fds.map((f) => f.detail.fd).sort()).toEqual(["52u", "7u"]);
    const fd52 = fds.find((f) => f.detail.fd === "52u")!;
    expect(fd52.severity).toBe("warning");
    expect(fd52.detail).toEqual({
      server_pid: 59772, fd: "52u", tty: "/dev/ttys049", flags: "R,W,0x10000;SH",
      client_pids: [20642],
    });
    expect(fd52.problem).toContain("59772");
    expect(fd52.problem).toContain("O_NONBLOCK");
    expect(fd52.next).toBeTruthy();
  });

  test("benign controls stay clean: a foreground attach, its NB fd, pane masters and non-tmux rows", () => {
    const { findings } = runScan();
    const pids = findings.filter((f) => f.name === "background_attach_client").map((f) => f.detail.pid);
    expect(pids).not.toContain(74221); // pgid == tpgid: the safe foreground attach
    expect(pids).not.toContain(1234); // no controlling tty: nothing to share
    expect(pids).not.toContain(10580); // tmux but not an attach client
    expect(pids).not.toContain(73449); // zsh, not a tmux client
    const names = findings.map((f) => f.name);
    expect(names).not.toContain("tmux_client_hazards_unverified");
    const blockingTtys = findings.filter((f) => f.name === "blocking_client_tty_fd").map((f) => f.detail.tty);
    expect(blockingTtys).not.toContain("/dev/ttys042"); // the NB foreground control fd
    expect(blockingTtys).not.toContain("/dev/ptmx"); // pane masters, not client terminals
    expect(blockingTtys).not.toContain("/dev/null");
  });

  test("a mixed snapshot with a malformed potential-hazard row is never an all-clear", () => {
    // Benign valid rows (foreground attach only) plus a truncated row that
    // would have been a background attach client: the valid rows classify
    // clean, and the dropped row is named unknown instead of vanishing.
    const { findings } = runScan({
      [PS_ARGS]: {
        status: 0,
        stdout: "  74221 74221 74221 ttys042 tmux attach -t tap/fable-7-3-leader\n  6000 6000 100 ttys0",
        stderr: "",
      },
      [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" },
      [LSOF_ARGS]: { status: 0, stdout: INCIDENT_LSOF, stderr: "" },
    });
    expect(findings.filter((f) => f.name === "background_attach_client")).toEqual([]);
    const unverified = findings.filter((f) => f.name === "tmux_client_hazards_unverified");
    expect(unverified.length).toBe(1);
    expect(unverified[0]!.detail.reason).toBe("partial_unparsed");
    expect(String(unverified[0]!.problem)).toContain("not checked");
  });

  test("a fully clean observation (foreground clients, all fds NB) produces no finding at all", () => {
    const cleanPs = [
      "  500 500 500 ttys010 tmux attach -t =tap/one",
      "  501 501 501 ttys011 tmux attach-session -t =tap/two",
    ].join("\n");
    const cleanLsof = [
      "COMMAND  PID USER   FD   TYPE         FILE-FLAG         DEVICE SIZE/OFF NODE NAME",
      "tmux    900   u    0u   CHR            R,W;SH            3,2      0t0  336 /dev/null",
      "tmux    900   u    8u   CHR  R,W,NB,0x10000          15,10  0t1234  605 /dev/ptmx",
      "tmux    900   u   43u   CHR R,W,NB,0x11000;SH         16,10  0t5678 1234 /dev/ttys010",
    ].join("\n");
    const { findings } = runScan({
      [PS_ARGS]: { status: 0, stdout: cleanPs, stderr: "" },
      [PROBE_ARGS]: { status: 0, stdout: "900\n", stderr: "" },
      ["lsof +fg -nP -p 900"]: { status: 0, stdout: cleanLsof, stderr: "" },
    });
    expect(findings).toEqual([]);
  });

  test.each([
    ["ps missing", { [PS_ARGS]: null, [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" }, [LSOF_ARGS]: { status: 0, stdout: INCIDENT_LSOF, stderr: "" } }],
    ["ps failed", { [PS_ARGS]: { status: 1, stdout: "", stderr: "ps: error" }, [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" }, [LSOF_ARGS]: { status: 0, stdout: INCIDENT_LSOF, stderr: "" } }],
    ["ps shape unparsed", { [PS_ARGS]: { status: 0, stdout: "garbage\n", stderr: "" }, [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" }, [LSOF_ARGS]: { status: 0, stdout: INCIDENT_LSOF, stderr: "" } }],
    ["ps partially unparsed", { [PS_ARGS]: { status: 0, stdout: `${INCIDENT_PS}\n  5000 5000 900 ttys0`, stderr: "" }, [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" }, [LSOF_ARGS]: { status: 0, stdout: INCIDENT_LSOF, stderr: "" } }],
    ["lsof missing", { [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" }, [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" }, [LSOF_ARGS]: null }],
    ["lsof failed", { [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" }, [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" }, [LSOF_ARGS]: { status: 1, stdout: "", stderr: "lsof: permission denied" } }],
    ["lsof shape unparsed", { [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" }, [PROBE_ARGS]: { status: 0, stdout: "59772\n", stderr: "" }, [LSOF_ARGS]: { status: 0, stdout: "garbage\n", stderr: "" } }],
    ["probe timed out", { [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" }, [PROBE_ARGS]: null }],
    ["probe failed", { [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" }, [PROBE_ARGS]: { status: 2, stdout: "", stderr: "error connecting to /tmp/fake/tmux-socket" } }],
    ["probe invalid pid", { [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" }, [PROBE_ARGS]: { status: 0, stdout: "900:100\n", stderr: "" } }],
  ])("an unavailable or failing evidence source is unknown, never an all-clear (%s)", (_label, outputs) => {
    const { findings } = runScan(outputs as Record<string, CommandResult | null>);
    const unverified = findings.filter((f) => f.name === "tmux_client_hazards_unverified");
    expect(unverified.length).toBeGreaterThan(0);
    for (const f of unverified) {
      expect(f.severity).toBe("warning");
      expect(String(f.problem)).toContain("not checked");
    }
  });

  test.each([
    ["probe timed out", null, "probe_unresponsive"],
    ["probe failed", { status: 2, stdout: "", stderr: "error connecting" }, "probe_failed"],
    ["probe invalid pid", { status: 0, stdout: "900:100\n", stderr: "" }, "probe_invalid"],
  ] as const)("the unverified finding names the probe reason (%s)", (_label, probe, reason) => {
    const { findings } = runScan({
      [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" },
      [PROBE_ARGS]: probe as CommandResult | null,
    });
    const unverified = findings.filter((f) => f.name === "tmux_client_hazards_unverified");
    expect(unverified.length).toBe(1);
    expect(unverified[0]!.detail.reason).toBe(reason);
    // The unreachable-server arms add no fd claim of their own.
    expect(findings.filter((f) => f.name === "blocking_client_tty_fd")).toEqual([]);
  });

  test("the classic no-server refusal is the one silent N/A: offline owns it", () => {
    const { findings } = runScan({
      [PS_ARGS]: { status: 0, stdout: INCIDENT_PS, stderr: "" },
      [PROBE_ARGS]: { status: 1, stdout: "", stderr: "no server running on /tmp/fake/tmux-socket" },
    });
    expect(findings.map((f) => f.name)).toEqual([
      "background_attach_client", "background_attach_client", "background_attach_client",
    ]);
  });

  test("the detector only issues read-only observations", () => {
    const { calls } = runScan();
    expect([...calls].sort()).toEqual([
      LSOF_ARGS,
      PS_ARGS,
      PROBE_ARGS,
    ]);
  });

  test("on linux only a live attach client's tty classifies; other tty candidates are named not checked", () => {
    const { findings, calls } = runScan(incidentFixtures(), "linux");
    // ttys049 has the live attach client 20642 -> blocking fd 52u classifies.
    // ttys042 has the foreground client 74221 -> NB fd 43u stays clean.
    expect(findings.filter((f) => f.name === "blocking_client_tty_fd").map((f) => f.detail.fd)).toEqual(["52u"]);
    // ttys048 corroborates nothing and must not be guessed: it is named.
    const unclassified = findings.filter((f) => f.name === "tmux_client_hazards_unverified");
    expect(unclassified.length).toBe(1);
    expect(unclassified[0]!.detail.reason).toBe("linux_client_fds_unclassified");
    expect(String(unclassified[0]!.problem)).toContain("not checked");
    // The census idea is gone: no list-panes observation is issued.
    expect(calls.every((c) => !c.includes("list-panes"))).toBe(true);
  });
});
