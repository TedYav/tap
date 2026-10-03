// Shared fixture + helpers extracted verbatim from the former
// runtime/bun/test/send-reply-flip.test.ts (suite split, Deliverable B unit 1).
// Each component test file imports these and registers its own scratch
// cleanup via afterEach(() => flushScratch(), 40_000). Measured components
// each run in a separate run.sh invocation, which gives each one a private
// process and a private scratch registry; aggregate discovery (bun-suite)
// runs files serially until the pool PR, so the registry is not shared
// across concurrently executing files there either.
import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stampEnvelope } from "../../src/envelope";
import { KERNEL_LOCK, kernelLockArgs } from "../../src/panelock";
import { removeScratchTree } from "./scratch";
import { writeLiveFence } from "./live-fence";

export const NATIVE_SEND = join(import.meta.dir, "native-send-entry.ts");
export const NATIVE_REPLY = join(import.meta.dir, "native-reply-entry.ts");
export const MAIN = join(import.meta.dir, "..", "..", "main.ts");
// Explicit native-door fixture for pre-cutover guards; public cutover controls drive MAIN.
export const REENABLED = join(import.meta.dir, "reenabled-router-entry.ts");
export const scratch: string[] = [];

// Bash-door sends leave short-lived children holding the scratch cwd; the
// ownership check stays exactly as strict (an owned tree is never removed),
// it is only given a bounded window to become unowned before it refuses.
export async function flushScratch(): Promise<void> {
  for (const path of scratch.splice(0)) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { removeScratchTree(path); break; }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(250);
      }
    }
  }
}

export function teamFixture(opts: {
  command?: string;
  parkAfter?: number;
  parkOnInject?: boolean;
  harnessQueue?: boolean;
  codexChevron?: boolean;
  cursorIdle?: "escaped" | "plain";
  generation?: Record<string, unknown>;
  fence?: boolean;
  inbound?: { id: string; from: string; to: string; extra?: Record<string, string> };
  seats?: Record<string, unknown>;
  /** The relay pane (ua:0.0) reports this command from its SECOND command
   *  read on — a denylist family (bash/sh/…) the pre-effect re-observation
   *  reads as harness drift (the proof's first read still binds claude). */
  relayPaneCommand?: string;
  /** After this many command reads of the relay pane (ua) the read fails
   *  outright, so the pre-effect re-observation classifies pane gone. */
  relayPaneGoneAfter?: number;
  /** The worktree directory's basename (default "team"). Review round 3:
   *  the relay from_team derivation must follow the bus anchor's root
   *  basename, not a literal, so the parity arms need a root NOT named
   *  team. */
  teamDirBasename?: string;
  /** Writes <bus>/registry.json with this team.name — the readable branch
   *  of tap_resolve_team_target's TAP_TT_LOCAL_TEAM derivation
   *  (lib.sh:6978-6987). Absent keeps the bus registry missing, so the
   *  basename branch fires. */
  busRegistryName?: string;
  /** The relay pane's SHALLOW command from its first read on (review round 5):
   *  an unsupported shallow command ("node", a version string) that the deep
   *  family resolution must resolve through pane process evidence. */
  relayPaneShallow?: string;
  /** Arms a file whose readable content OVERRIDES the relay pane's reported
   *  command on every read (review round 5): the TAP_SEND_AFTER_ROUTE_HOOK
   *  writes into it (its path rides the inherited FAKE_RELAY_FLIP_FILE), so
   *  the drift the place-time guard must catch is created after route. Both
   *  doors read the same fake tmux, so the channel is door-neutral. */
   relayHookFlipFile?: boolean;
   /** The relay pane's reported pane_pid (default 4242, review round 5). */
   relayPanePid?: string;
   /** Review round 5: one synthetic row appended to the process table the
    *  harness-evidence walk reads (the fixture's fake `ps`). The compute
    *  runner reaps fire-and-forget children, so a live impersonator process
    *  cannot carry the walk — the row names the agent-family executable the
    *  wrapper allegedly hides (`<pid> <pgid> <tpgid> <comm> <command>`). */
   relayPsRow?: string;
   /** Checkpoint B (U3): a file whose existence makes the UB recipient pane
    *  read DEAD from the first observation on (lone pane_id empty, pane_dead
    *  1, 3-field row omitted, 4-field read failing) — the Step A pre-place
    *  dead-pane scenario. The arm creates the file before the send. */
   recipientGone?: boolean;
  }) {
  const root = mkdtempSync(join(tmpdir(), "tap-send-reply-flip."));
  scratch.push(root);
  const wt = join(root, opts.teamDirBasename ?? "team");
  const bus = join(wt, ".tap", "bus");
  const registry = join(wt, ".tap", "team-registry.json");
  const index = join(root, "index");
  const bin = join(root, "bin");
  const reached = join(root, "observe-reached");
  const release = join(root, "observe-release");
  const once = join(root, "observe-once");
  const count = join(root, "observe-count");
  const band = join(root, "band");
  const submitted = join(root, "submitted");
  mkdirSync(join(bus, "payloads"), { recursive: true });
  mkdirSync(join(bus, "receipts"), { recursive: true });
  if (opts.busRegistryName) {
    writeFileSync(join(bus, "registry.json"), JSON.stringify({ schema: "0.20", team: { name: opts.busRegistryName }, seats: {} }));
  }
  mkdirSync(index);
  mkdirSync(bin);
  spawnGit(wt);

  writeFileSync(registry, JSON.stringify({
    schema: "0.20",
    team: { name: "flip", worktree_root: wt },
    seats: {
      ua: { status: "active", pane: "ua:0.0", pane_id: "%6", server_epoch: "srv:123:456", instance: "ua|A", harness: "claude" },
      ub: { status: "active", pane: "ub:0.0", pane_id: "%7", server_epoch: "srv:123:456", instance: "ub|A", harness: "claude" },
      ...opts.seats,
    },
  }));
  writeFileSync(join(index, "global-registry.json"), JSON.stringify({
    schema: "0.20",
    teams: { flip: { root: wt, registry_location: registry, state: "registered" } },
  }));
  if (opts.generation) {
    writeFileSync(join(bus, "reset-generation.json"), `${JSON.stringify(opts.generation)}\n`);
  }
  if (opts.fence) writeLiveFence(join(bus, "reset.fence.json"));
  // Idle Cursor chrome before submission, escaped (SGR-dimmed live shape) or
  // plain. After submission the frame deliberately falls through to composer
  // chrome that lacks Cursor geometry — the unverified landing control.
  const cursorIdleFrame = opts.cursorIdle
    ? join(root, `cursor-idle.${opts.cursorIdle}`)
    : "";
  if (opts.cursorIdle === "escaped") {
    writeFileSync(cursorIdleFrame,
      " \x1b[48;2;32;32;32m \x1b[2m→ \x1b[0;7m\x1b[48;2;32;32;32mA\x1b[0;2m\x1b[48;2;32;32;32mdd a follow-up\x1b[0m");
  } else if (opts.cursorIdle === "plain") {
    writeFileSync(cursorIdleFrame, " → Add a follow-up");
  }
  if (opts.inbound) {
    const path = join(bus, "payloads", `${opts.inbound.id}.md`);
    const extra = { ...opts.inbound.extra };
    const epoch = extra.epoch;
    delete extra.epoch;
    writeFileSync(path, stampEnvelope(`---\n${epoch ? `epoch: ${epoch}\n` : ""}---\nquestion\n`, {
      id: opts.inbound.id, from: opts.inbound.from, to: opts.inbound.to,
      kind: "discuss", path, reply: "expected",
      ...extra,
    }));
  }

  // Review round 5: the fixture's ps passes everything through except the
  // process-table read the harness-evidence walk makes (observe.ts PS_ARGV);
  // when FAKE_PS_ROW is set the table gains one synthetic row. The compute
  // runner reaps fire-and-forget children within a beat, so a live
  // impersonator process cannot carry the walk.
  writeFileSync(join(bin, "ps"), `#!/bin/sh
if [ "$*" = "-Ao pid=,pgid=,tpgid=,comm=,command=" ]; then
  /bin/ps -Ao 'pid=,pgid=,tpgid=,comm=,command=' || exit $?
  [ -n "$FAKE_PS_ROW" ] && printf '%s\\n' "$FAKE_PS_ROW"
  exit 0
fi
exec /bin/ps "$@"
`, { mode: 0o755 });

  writeFileSync(join(bin, "tmux"), `#!/bin/sh
# Review round 5: the route hook's flip file carries EITHER a command (the
# pane's reported command after the hook) or "id:<pane-id>" (the pane id the
# reads report — the recycle scenario). Review round 6: "gone" makes every
# ua-targeted observation fail from the hook onward — the pane the hook
# killed. Parse once, apply at every ua slot.
flip_cmd=
flip_id=
flip_gone=
if [ -n "$FAKE_RELAY_FLIP_FILE" ] && [ -r "$FAKE_RELAY_FLIP_FILE" ]; then
  _flip=$(cat "$FAKE_RELAY_FLIP_FILE")
  case "$_flip" in
    id:*) flip_id=\${_flip#id:} ;;
    gone) flip_gone=1 ;;
    *) flip_cmd=$_flip ;;
  esac
fi
case " $* " in
  *"set-option"*"window-style"*"bg="*)
    # tap-12ys6: the park cue's tint, held at a barrier so a test can probe
    # reset custody while the flash (which holds the pane lock) is running.
    if [ -n "$FAKE_FLASH_BARRIER" ]; then
      : > "$FAKE_FLASH_BARRIER.reached"
      while [ ! -e "$FAKE_FLASH_BARRIER.release" ]; do sleep 0.01; done
    fi
    exit 0
    ;;
  *"list-sessions"*)
    printf 'ua\\t123:456\\n'
    printf 'ub\\t123:456\\n'
    ;;
  *" -X cancel"*)
    # U3 checkpoint B: tap_exit_copy_mode's cancellation op
    # (lib.sh:9038, send-keys -X cancel) clears the pane's copy-mode flag.
    rm -f "$FAKE_IN_MODE"
    exit 0
    ;;
  *"list-panes -a -F #{pane_id}"*) printf '%%6\\n%%7\\n' ;;
  *"list-panes"*)
    relay_cmd=$FAKE_RELAY_COMMAND
    [ -n "$FAKE_RELAY_SHALLOW" ] && relay_cmd=$FAKE_RELAY_SHALLOW
    [ -n "$flip_cmd" ] && relay_cmd=$flip_cmd
    relay_slot=%6
    [ -n "$flip_id" ] && relay_slot=$flip_id
    case " $* " in
      *"=ub"*|*" ub:"*|*" ub "*) printf 'ub\\tub:0.0\\t%%7\\t%s\\t%s\\t123:456\\t0\\n' "$FAKE_COMMAND" "$FAKE_RELAY_PID" ;;
      *) printf 'ua\\tua:0.0\\t%s\\t%s\\t%s\\t123:456\\t0\\n' "$relay_slot" "$relay_cmd" "$FAKE_RELAY_PID" ;;
    esac
    ;;
  *"#{pane_id}"*"#{session_name}"*"#{pid}:#{start_time}"*)
    # The Bash observer's 3-field fmt (tap_pane_observe, hard gate) also
    # matches the pane_id+session_name arm below, so it must be answered first
    # — pane id, session, epoch — or the gate reads a 4-field answer whose
    # third field is not digits:digits and defers the clobber as unobservable.
    if [ "$FAKE_RELAY_GONE_AFTER" -gt 0 ] || [ -n "$flip_gone" ]; then
      # The Bash courier's pre-effect pane read (tap_pane_observe) is this
      # arm: an OBSERVED miss (the row omitted, exit 0) classifies pane gone.
      # The native door never reads this format, so the gate is Bash-only.
      # Review round 6: the hook's "gone" form drives the same gate.
      case " $* " in
        *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*) exit 0 ;;
      esac
    fi
    pane_id=%7
    session=ub
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*)
        pane_id=%6; session=ua
        [ -n "$flip_id" ] && pane_id=$flip_id
        ;;
      *" ub:"*|*"=ub"*|*" ub "*)
        # Checkpoint B (U3): a dead UB pane omits its 3-field row — the
        # observed miss the Bash courier's tap_pane_observe classifies gone.
        if [ -n "$FAKE_UB_GONE" ] && [ -f "$FAKE_UB_GONE" ]; then exit 0; fi
        [ -f "$FAKE_PANE_ID" ] && pane_id=$(cat "$FAKE_PANE_ID")
        ;;
    esac
    printf '%s\\t%s\\t123:456\\n' "$pane_id" "$session"
    ;;
  *"#{pane_id}"*"#{session_name}"*)
    n=0
    [ -f "$FAKE_COUNT" ] && n=$(cat "$FAKE_COUNT")
    n=$((n + 1))
    printf '%s' "$n" > "$FAKE_COUNT"
    if [ "$n" -gt "$FAKE_PARK_AFTER" ]; then
      if mkdir "$FAKE_ONCE" 2>/dev/null; then
        : > "$FAKE_REACHED"
        while [ ! -e "$FAKE_RELEASE" ]; do sleep 0.01; done
      fi
    fi
    if [ -f "$FAKE_GONE" ]; then exit 0; fi
    dead=0
    [ -f "$FAKE_DEAD" ] && dead=1
    pane_id=%7
    session=ub
    cmd=$FAKE_COMMAND
    case " $* " in
      *" ua:"*|*"=ua"*|*" ua "*|*" %6 "*)
        pane_id=%6; session=ua; cmd=$FAKE_RELAY_COMMAND
        [ -n "$FAKE_RELAY_SHALLOW" ] && cmd=$FAKE_RELAY_SHALLOW
        [ -n "$flip_cmd" ] && cmd=$flip_cmd
        [ -n "$flip_id" ] && pane_id=$flip_id
        case " $* " in
          *"display-message"*)
            # The pre-effect re-observation (observePaneResult) lands HERE —
            # its display-message format carries pane_id and session_name, so
            # it matches this arm before the lone pane_current_command arm
            # below. The shared relay counter counts COMMAND reads: the
            # proof's paneCurrentCommand read is #1, so the gates below fire
            # only on the later re-observation.
            m=0
            [ -f "$FAKE_RELAY_CMD_OBS" ] && m=$(cat "$FAKE_RELAY_CMD_OBS")
            m=$((m + 1))
            printf '%s' "$m" > "$FAKE_RELAY_CMD_OBS"
            # Review round 6: the hook's "gone" form is the native pane-gone
            # point — the first post-hook observation fails outright.
            if [ -n "$flip_gone" ]; then exit 0; fi
            if [ "$FAKE_RELAY_GONE_AFTER" -gt 0 ] && [ "$m" -gt "$FAKE_RELAY_GONE_AFTER" ]; then exit 0; fi
            if [ "$FAKE_RELAY_FLIP_AFTER" -gt 0 ] && [ "$m" -gt "$FAKE_RELAY_FLIP_AFTER" ]; then cmd=$FAKE_RELAY_COMMAND; fi
            printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$pane_id" "$session" "$FAKE_RELAY_PID" "$cmd" "$dead"
            exit 0
            ;;
        esac
        ;;
    esac
    case " $* " in
      *" ub:"*|*"=ub"*|*" ub "*)
        [ -f "$FAKE_PANE_ID" ] && pane_id=$(cat "$FAKE_PANE_ID")
        # Checkpoint B (U3): the recipient pane reads DEAD from the first
        # observation on — the native observePaneResult lands here.
        if [ -n "$FAKE_UB_GONE" ] && [ -f "$FAKE_UB_GONE" ]; then exit 0; fi
        ;;
    esac
    printf '%s\\t%s\\t4242\\t%s\\t%s\\n' "$pane_id" "$session" "$cmd" "$dead"
    ;;
  *"#{session_name}"*"#{pid}:#{start_time}"*)
    case " $* " in
      *" ub:"*|*"=ub"*) printf 'ub\\t123:456\\n' ;;
      *) printf 'ua\\t123:456\\n' ;;
    esac
    ;;
  *"#{pid}:#{start_time}"*) printf '123:456\\n' ;;
  *"#{window_index}"*"#{pane_index}"*)
    # The pane-drift heal's address probe (display-message -p -t <pane_id>
    # '#{session_name}:#{window_index}.#{pane_index}'). No other observer
    # carries window_index/pane_index, so the arm shadows nothing.
    printf 'ub:0.0\\n' ;;
  *"#{pane_current_command}"*)
    # Relay pre-effect gates (review round 2): the pane's command read is
    # counted, so a test can flip the reported family AFTER the identity proof
    # (harness drift) or fail the read outright (observed pane gone).
    n=0
    [ -f "$FAKE_RELAY_CMD_OBS" ] && n=$(cat "$FAKE_RELAY_CMD_OBS")
    n=$((n + 1))
    printf '%s' "$n" > "$FAKE_RELAY_CMD_OBS"
    case " $* " in
      *"=ua"*|*" ua:"*|*" ua "*|*" %6 "*)
        # Review round 5: the hook's channel wins (command form only — the
        # id: form is the recycle scenario and rides the pane id slots), then
        # the shallow override. The ua fallthrough reports the relay pane's
        # OWN command (FAKE_RELAY_COMMAND), not the ub seat's: the denylist
        # gate must see the same pane truth every other read reports.
        if [ -n "$flip_cmd" ]; then printf '%s\\n' "$flip_cmd"; exit 0; fi
        if [ -n "$FAKE_RELAY_SHALLOW" ]; then printf '%s\\n' "$FAKE_RELAY_SHALLOW"; exit 0; fi
        if [ -n "$flip_gone" ]; then exit 1; fi
        if [ "$FAKE_RELAY_GONE_AFTER" -gt 0 ] && [ "$n" -gt "$FAKE_RELAY_GONE_AFTER" ]; then exit 1; fi
        if [ "$FAKE_RELAY_FLIP_AFTER" -gt 0 ] && [ "$n" -gt "$FAKE_RELAY_FLIP_AFTER" ]; then printf '%s\\n' "$FAKE_RELAY_COMMAND"; exit 0; fi
        printf '%s\\n' "$FAKE_RELAY_COMMAND"
        exit 0
        ;;
    esac
    printf '%s\\n' "$FAKE_COMMAND" ;;
  *"#{pane_in_mode}"*)
    # The incumbent's relay pane-gone point is tap_exit_copy_mode's
    # pane_in_mode read (lib.sh:9081-9087): tmux 3.6a answers a dead
    # target with exit 0 and an EMPTY expansion, which the caller reads as
    # pane gone. In the gone arm the relay pane's read goes empty.
    case " $* " in
      *"=ua"*|*" ua:"*|*" ua "*|*" %6 "*)
        if [ "$FAKE_RELAY_GONE_AFTER" -gt 0 ] || [ -n "$flip_gone" ]; then exit 0; fi
        ;;
    esac
    if [ -f "$FAKE_IN_MODE" ]; then printf '1\\n'; else printf '0\\n'; fi ;;
  *"#{pane_pid}"*) printf '%s\\n' "$FAKE_RELAY_PID" ;;
  *"#{pane_dead}"*)
    # Review round 6: the hook's "gone" form is a DEAD pane — the incumbent's
    # post-hook liveness check (tap-send.sh:1413) reads pane_dead before
    # PANE_CMD classification, so the ua target answers dead from the hook
    # onward and the send refuses rc 3 there. Checkpoint B (U3): the UB
    # recipient answers dead under FAKE_UB_GONE (Step A pre-place).
    case " $* " in
      *"=ua"*|*" ua:"*|*" ua "*|*" %6 "*)
        [ -n "$flip_gone" ] && printf '1\\n' || printf '0\\n'
        ;;
      *"=ub"*|*" ub:"*|*" ub "*)
        if [ -n "$FAKE_UB_GONE" ] && [ -f "$FAKE_UB_GONE" ]; then printf '1\\n'; else printf '0\\n'; fi
        ;;
      *) printf '0\\n' ;;
    esac ;;
  *"#{session_windows}"*) printf '1\\n' ;;
  *"#{pane_id}"*)
    # Review round 6: tap_pane_alive (lib.sh:8010) reads the lone pane_id and
    # treats EMPTY as a dead pane, so the hook's "gone" form answers empty
    # for the ua target — the incumbent's rc 3 human-relay point (:1412).
    # Checkpoint B (U3): the UB recipient reads empty (dead) under
    # FAKE_UB_GONE — Step A's liveness read, pre-place.
    case " $* " in
      *"=ua"*|*" ua:"*|*" ua "*|*" %6 "*)
        [ -n "$flip_gone" ] && exit 0
        ;;
      *"=ub"*|*" ub:"*|*" ub "*)
        if [ -n "$FAKE_UB_GONE" ] && [ -f "$FAKE_UB_GONE" ]; then exit 0; fi
        ;;
    esac
    printf '%%7\\n' ;;
  *"capture-pane"*)
    if [ -n "$FAKE_RAW_CAPTURE" ]; then cat "$FAKE_RAW_CAPTURE"; exit 0; fi
    if [ -n "$FAKE_CURSOR_IDLE" ] && [ ! -e "$FAKE_SUBMITTED" ]; then
      cat "$FAKE_CURSOR_IDLE"
      exit 0
    fi
    # A hermes seat shows the frame the classifier's golden corpus holds
    # (fixtures/agent-state/hermes/idle.txt): status row, rules, handle prompt.
    case "$FAKE_COMMAND" in
      hermes*)
        printf ' ⚕ deepseek-v4-pro │ 50K/1M │ 5%% │ ✓ 0s\\n──────────────────────────────────────────\\nops-hermes ❯ '
        if [ -e "$FAKE_BAND" ] && [ ! -e "$FAKE_SUBMITTED" ]; then cat "$FAKE_BAND"; fi
        printf '\\n──────────────────────────────────────────\\n'
        exit 0 ;;
    esac
    # Review round 5: the flip channel can re-family the pane mid-send — a
    # codex pane shows a codex composer, and the shared classifier reads the
    # band only through a recognized composer. The staged sentinel stays
    # VISIBLE here (never marked submitted), so a delivery attempt ends
    # "Enter unconfirmed" on both doors.
    if [ "$flip_cmd" = codex ]; then
      printf '› '
      [ ! -e "$FAKE_BAND" ] || cat "$FAKE_BAND"
      printf '\\n'
      exit 0
    fi
    # Match a real Claude composer width. Ten box cells are 30 bytes on macOS
    # awk but only 10 characters on Linux gawk, below the region-reader floor.
    if [ "$FAKE_CODEX_CHEVRON" = 1 ]; then
      printf 'Synthetic transcript\\n'
      if [ -e "$FAKE_SUBMITTED" ]; then
        printf '» \\n'
      else
        printf '» '
        if [ -e "$FAKE_BAND" ]; then
          # Two prompt cells plus 87 content cells: a synthetic 89-column pane.
          fold -w 87 "$FAKE_BAND"
        fi
        printf '\\n'
      fi
      printf '\\n  gpt-6-astra ultra fast · Context 66%% left · /synthetic · weekly 19%% left · Ma…\\n'
    elif [ "$FAKE_HARNESS_QUEUE" = 1 ] && [ "$FAKE_COMMAND" = codex ]; then
      if [ -e "$FAKE_SUBMITTED" ]; then cat "$FAKE_BAND"; printf '\\n• Working (esc to interrupt)\\n› \\ngpt-6-astra high · Context 80%% left · /tmp\\n'
      else printf '› '; [ ! -e "$FAKE_BAND" ] || cat "$FAKE_BAND"; printf '\\n'; fi
    elif [ "$FAKE_HARNESS_QUEUE" = 1 ] && [ ! -e "$FAKE_SUBMITTED" ]; then
      # A genuine mid-turn queue starts from a working seat: Claude frames carry busy
      # pre-state evidence (tap-7txco), and an idle start reads as a fast-starting delivery.
      printf '──────────────────────────────────────────\\n❯ '
      [ ! -e "$FAKE_BAND" ] || cat "$FAKE_BAND"
      printf '\\n──────────────────────────────────────────\\nesc to interrupt\\n'
    elif [ -e "$FAKE_SUBMITTED" ]; then
      if [ "$FAKE_HARNESS_QUEUE" = 1 ]; then
        cat "$FAKE_BAND"
        printf '\\n──────────────────────────────────────────\\n❯ \\n──────────────────────────────────────────\\nesc to interrupt\\n'
      elif [ -f "$FAKE_CHIP" ]; then printf '› [Pasted text #1]\\n──────────────────────────────────────────\\n'
      else printf '› \\n──────────────────────────────────────────\\n'; fi
    elif [ -e "$FAKE_BAND" ]; then printf '› '; cat "$FAKE_BAND"; printf '\\n──────────────────────────────────────────\\n'
    else printf '› \\n──────────────────────────────────────────\\n'; fi
    ;;
  *"load-buffer"*)
    [ "$FAKE_CODEX_CHEVRON" != 1 ] || cat > "$FAKE_RESTORE_BUFFER" ;;
  *"paste-buffer"*)
    if [ "$FAKE_CODEX_CHEVRON" = 1 ]; then
      cat "$FAKE_RESTORE_BUFFER" >> "$FAKE_BAND"
      rm -f "$FAKE_SUBMITTED"
    fi ;;
  *"send-keys"*)
    printf '%s\\n' "$*" >> "$FAKE_ALL_KEYS"
    case " $* " in
      *" -l -- "*)
        if [ -f "$FAKE_INJECT_FAIL" ]; then exit 1; fi
        if [ "$FAKE_PARK_ON_INJECT" = 1 ]; then
          if mkdir "$FAKE_ONCE" 2>/dev/null; then
            : > "$FAKE_REACHED"
            while [ ! -e "$FAKE_RELEASE" ]; do sleep 0.01; done
          fi
        fi
        rm -f "$FAKE_SUBMITTED"
        for last do :; done
        if [ "$FAKE_CODEX_CHEVRON" = 1 ]; then
          # Real literal input appends; overwriting would conceal concatenation.
          printf '%s' "$last" >> "$FAKE_BAND"
        else
          printf '%s' "$last" > "$FAKE_BAND"
        fi
        printf '%s\n' "$*" >> "$FAKE_KEYS" ;;
      *" C-u "*|*" C-u")
        [ "$FAKE_CODEX_CHEVRON" != 1 ] || : > "$FAKE_BAND" ;;
      *" Enter "*)
        if [ -f "$FAKE_ENTER_FAIL" ]; then exit 0; fi
        : > "$FAKE_SUBMITTED"
        [ "$FAKE_CODEX_CHEVRON" != 1 ] || : > "$FAKE_BAND"
        printf '%s\n' "$*" >> "$FAKE_KEYS" ;;
    esac
    ;;
esac
exit 0
`, { mode: 0o755 });

  const socketPath = join(mkdtempSync(join(process.env.TMUX_TMPDIR!, "s.")), "tmux");
  const xdgConfig = join(root, "xdg-config");
  mkdirSync(xdgConfig, { recursive: true });
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: xdgConfig,
    TAP_HOME: bus,
    TAP_INDEX_HOME: index,
    TAP_SESSION_MANIFEST: join(root, "sessions.json"),
    OPENCODE_DB_PATH: join(root, "opencode.db"),
    TAP_VERSION_SEEN_PATH: join(root, "version-seen.json"),
    TAP_LOCK_DIR: join(root, "locks"),
    TAP_SELF: "ua",
    TAP_TMUX_SOCKET_PATH: socketPath,
    TAP_SPOOL_DISABLE_DELIVERER: "1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    FAKE_ONCE: once,
    FAKE_COUNT: count,
    FAKE_REACHED: reached,
    FAKE_RELEASE: release,
    FAKE_BAND: band,
    FAKE_KEYS: join(root, "keys"),
    FAKE_SUBMITTED: submitted,
    FAKE_CHIP: join(root, "chip"),
    FAKE_PANE_ID: join(root, "pane-id"),
    FAKE_GONE: join(root, "pane-gone"),
    FAKE_DEAD: join(root, "pane-dead"),
    FAKE_IN_MODE: join(root, "pane-in-mode"),
    FAKE_INJECT_FAIL: join(root, "inject-fail"),
    FAKE_ENTER_FAIL: join(root, "enter-fail"),
    FAKE_CODEX_CHEVRON: opts.codexChevron ? "1" : "0",
    FAKE_ALL_KEYS: join(root, "all-keys"),
    FAKE_RESTORE_BUFFER: join(root, "restore-buffer"),
    FAKE_HARNESS_QUEUE: opts.harnessQueue ? "1" : "0",
    FAKE_CURSOR_IDLE: cursorIdleFrame,
    FAKE_COMMAND: opts.command ?? "claude",
    FAKE_RELAY_COMMAND: opts.relayPaneCommand ?? "claude",
    // A denylist relayPaneCommand flips the pane's reported command family
    // AFTER its first command read (the identity proof binds that one), so
    // the pre-effect re-observation is what sees the drift.
    FAKE_RELAY_FLIP_AFTER: opts.relayPaneCommand ? "1" : "0",
    FAKE_RELAY_GONE_AFTER: String(opts.relayPaneGoneAfter ?? 0),
    FAKE_RELAY_CMD_OBS: join(root, "relay-cmd-obs"),
    // Review round 5 seams: shallow-command wrapper, the route hook's
    // override channel, and the relay pane's reported pid.
    FAKE_RELAY_SHALLOW: opts.relayPaneShallow ?? "",
    FAKE_RELAY_FLIP_FILE: opts.relayHookFlipFile ? join(root, "hook-flip") : "",
    FAKE_RELAY_PID: opts.relayPanePid ?? "4242",
    FAKE_PS_ROW: opts.relayPsRow ?? "",
    FAKE_UB_GONE: opts.recipientGone ? join(root, "ub-gone") : "",
    FAKE_PARK_AFTER: String(opts.parkAfter ?? 99),
    FAKE_PARK_ON_INJECT: opts.parkOnInject ? "1" : "0",
  } as NodeJS.ProcessEnv;
  delete env.TAP_DRIVER_FORCE_TMUX;
  delete env.TAP_EPOCH;
  writeFileSync(socketPath, "socket\n");
  return { root, wt, bus, env, reached, release };
}

export function spawnGit(wt: string) {
  mkdirSync(wt, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", wt]);
}

export function waitFor(path: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!existsSync(path) && Date.now() < deadline) Bun.sleepSync(10);
  expect(existsSync(path)).toBe(true);
}

export function payloads(bus: string): string[] {
  try {
    return readdirSync(join(bus, "payloads")).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

export function placed(bus: string): string[] {
  try {
    return readdirSync(join(bus, "receipts")).filter((name) => name.endsWith(".placed")).sort();
  } catch {
    return [];
  }
}

export function assertParked(fx: ReturnType<typeof teamFixture>, id: string, reason: string) {
  expect(existsSync(join(fx.bus, "spool", `${id}.md`))).toBe(true);
  const meta = JSON.parse(readFileSync(join(fx.bus, "spool", `${id}.meta.json`), "utf8"));
  expect(meta.id).toBe(id);
  expect(meta.reason).toBe(reason);
  expect(meta.policy).toBe("standard");
  expect(meta.attempt_fence).toBe(1);
  expect(existsSync(join(fx.bus, "payloads", `${id}.md`))).toBe(false);
  expect(existsSync(join(fx.bus, "receipts", `${id}.placed`))).toBe(true);
  expect(existsSync(join(fx.bus, "receipts", `${id}.sent`))).toBe(false);
  return meta;
}

export function paneObserveCount(fx: ReturnType<typeof teamFixture>): number {
  const path = fx.env.FAKE_COUNT as string;
  if (!existsSync(path)) return 0;
  return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
}

export function resetLockProbe(bus: string) {
  return spawnSync(KERNEL_LOCK, kernelLockArgs(join(bus, "reset.fence.json.lock"), 0, ["true"]), {
    encoding: "utf8",
  });
}

export function startPoller(fx: ReturnType<typeof teamFixture>, stop: string, log: string, seen: string) {
  writeFileSync(log, "");
  writeFileSync(seen, "");
  return Bun.spawn(["sh", "-c", `
    while [ ! -e "$STOP" ]; do
      bun ${JSON.stringify(MAIN)} poll ub >> "$LOG" 2>/dev/null || true
      for f in "$BUS/payloads"/*.md; do
        [ -e "$f" ] || continue
        echo "canonical:$(basename "$f")" >> "$SEEN"
      done
      for f in "$BUS/receipts"/*.placed; do
        [ -e "$f" ] || continue
        echo "placed:$(basename "$f")" >> "$SEEN"
      done
      sleep 0.01
    done
  `], {
    cwd: fx.wt,
    env: { ...fx.env, TAP_SELF: "ub", STOP: stop, LOG: log, SEEN: seen, BUS: fx.bus },
    stdout: "pipe",
    stderr: "pipe",
  });
}
