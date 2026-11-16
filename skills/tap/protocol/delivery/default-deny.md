# Default-deny: no TAP key answers a prompt (tap-rlebf.1)

An approval prompt or a workspace-trust dialog is a decision that belongs to the
operator, or to a policy the operator set. No TAP key path may answer one. Enter
selects the highlighted choice, a digit selects a numbered one, an arrow moves
the highlight, and typed text can carry an answer key: Cursor's `Run (once)
(y)` takes the first `y`.

The invariant: **at a recognized prompt, no TAP key may answer it. On a frame
TAP cannot classify, delivery holds, and no TAP key may commit a choice or move
a selection.** Revisit if a harness ever commits a choice on Escape or `0`.

## The rule per path

Every path that writes into a harness pane reads the frame first.

| Path | At a recognized prompt | At a frame no rule classifies |
|---|---|---|
| Courier paste and submit Enter (and its retries) | Holds before paste; withholds every Enter after it, under every authority, the queue-prefix bypass included | Holds. `--no-spool`, forced and queue-prefix attempts inject past an unreadable band only on a screen a rule classifies |
| Cursor's steering Enter | Re-reads the frame after the first Enter; withholds the second at a prompt | Withholds the second when the frame has no readable composer or the screen is unclassified |
| Urgent interrupt (Escape, Escape Escape, C-c) | Holds before the key | Holds before the key when the band read would hold delivery; a wedge that reads working keeps its key |
| Draft clear and restore (C-u, BSpace, paste) | Holds; the band reads unobservable | Holds |
| Idle staged-submit Enter | Needs two `idle` samples; a prompt is never idle | Holds |
| Nudge Enter | Holds; needs the staged sentinel alone in the composer | Holds without that proof |
| Recovery keys (nudge, detective) | Only a lone Escape, which dismisses | Only Escape, `0` (a survey's dismissal) and the editing keys C-u and BSpace. Enter and 1-9 commit; arrows, Tab, Home and End move a highlight the operator's next Enter would take |
| Seat picker typing (`tap pick --pane`) | Types nothing when any harness's prompt rule matches | Types: the one operator-directed exception, below |
| agy survey `0`, Codex compact Escape/Enter, the clear chain | Fire only on a positively read survey, working or idle state | Hold |
| Copy-mode cancel (`-X cancel`) | Not application input | Not application input |
| Codex startup update Skip | One Escape only for `codex-update-available`, under the launch or delivery license below | Holds |
| [Approval timeout](approval-timeout.md) reject | Only a lone Escape, from a recovery run, on a positively classified request past its harness's timeout, gated on the team policy and that row's captured evidence; never an approve key | Holds: no request, no key |

The recovery door decides by the frame, never by the caller's action label.
Escape is the one key every harness treats as dismissal, so it is the only key
a recognized approval or trust prompt may receive. That key comes from a
recovery run. The startup update menu has its own narrow delivery exception below.

## Codex update Skip

A Codex seat or crew that TAP starts runs with `-c check_for_update_on_startup=false`,
so it offers no update menu. The override is argv only and yields to the same
key set in a preset, harness policy or `--` tail; Codex's `config.toml` is not
edited. When Codex's own `version.json` names a release newer than the one the
pane shows, launch prints one line with both versions. That cache is refreshed
only when Codex checks for itself. The Escape below remains for panes joined
with `tap in`, for a seat that re-enables the check, and for a Codex that does
not honor the key.

Launcher readiness and courier delivery may send one Escape when the shared
classifier positively identifies `codex-update-available` and both version
numbers are readable. Escape chooses Skip; TAP never selects the update or
runs an installer. Fresh, resumed and restarted session creation use the same
readiness path. Diagnosis remains read-only.

Before Escape, the owner rechecks the pane, server generation, process and
operation authority. Operator holds, copy-mode and effect fences still refuse.
Delivery spends its existing attempt license before this first key and may
continue only within that attempt. An urgent send omits its usual interrupt
after a verified Skip. Drain readiness reports `recover:codex-update` so queued
mail can reach this guarded recovery before its delivery deadline; the result
grants no payload input.

After Escape, an escaped capture and a successful title read must prove an
empty composer on the same process. A draft, unreadable frame, changed target
or remaining dialog stops the operation without a second Escape. Uncertain
delivery retains its spent license; uncertain startup retains its session for
inspection. A lost launch owner or cancellation grants no further pane or
binding mutation. Before the key, the launcher disarms its failure callback so
a subsequent harness exit cannot delete the retained pane. Trace and delivery events record actor, pane, versions and
outcome; a successful launch receipt also reports both versions.

**The one operator-directed exception.** `tap pick --pane` runs from the
operator's own tmux popup and types a seat name into the operator's own pane.
TAP does not know which harness, shell or editor owns that pane, so it cannot
classify it. It refuses whenever any harness's prompt rule matches the pane.
Otherwise it types, because the operator chose the pane and is watching it.

If a real frame on a delivery path reads unknown and costs liveness (for
example, a Cursor pair that never completes), the remedy is a rule that
classifies that frame. A key into an unknown frame is never the remedy.

## Narrow panes

Harnesses wrap their own dialogs at word boundaries. At 24 columns Codex's trust
hint is `enter continue · esc` / `quit`. At 30, Claude's is `Enter to confirm ·
Esc to` / `cancel`. The trust rules match any whitespace between the words of
the title and the hint, over the bottom 40 nonempty rows. The hint must still
begin its own row and close the screen. The rule for a live-composer row stays
as it was, so a draft that quotes the dialog's words, wrapped or not, does not
count as a dialog.

## Evidence

`runtime/bun/test/no-approve-keys.test.ts` drives each harness's real prompt
captures through native courier admission (plain, urgent, `--no-spool` and
queue-prefix), the recovery effect door, the seat picker and Cursor's steering
Enter. It also covers unclassified frames on those paths. The other rows rest
on their own guards and tests: `approval-delivery`, `staged-idle-submit`,
`self-compact`, `typed-prefix` and `agy-survey`. Hermes has no real prompt
capture yet (tap-3oox6), so its synthetic frame stands in for these guards. It
is not a captured Hermes prompt: the approval timeout does not recognize the real
one and has no Hermes observation or escalation until the follow-up capture. The narrow-pane
fixtures are live captures from a private bus. The probe sent no keys and
changed no config.
