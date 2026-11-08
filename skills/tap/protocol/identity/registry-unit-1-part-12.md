# Registry (Unit 1) — source part 12 of 14

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0038 start=241727 end=250204 sha256=6f16f38fa5c7f048f50b7598194187cf7bdc3c62bf12d895a8283904de4d97c2 fragment=12/14 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
**Team calibration view (tap-ypmn).** `tap team calibration` is the roster JOINED to the seat-calibration ledger: per seat, the base calibration row its handle resolves to (exact name, else the longest catalog name such that the handle is `<name>-…` — the same rule presets use), `MODEL @ HARNESS`, `FAMILY`, `TIER`, `VOICE`, the preset roles cell (primary, then secondary in parens), the observed `STATUS`/`ATTACHED` from the roster classifier above, and an `IDLE` cell; then each joined seat's ledger one-liner and its latest DATED disposition bullet. It reuses `tap team`'s own roster rows, so the two surfaces can never disagree about who is live, and it resolves the **acting** registry like every other team verb — a view that renders seat state off an ambient bus path reports live teammates as `gone` (the tap-ypmn defect). A handle that joins no ledger row renders seated and unjoined, never `gone`, and is named in an explicit unjoined block; family comes only from explicit model, preset or ledger evidence, never from the harness. Stored launch model/effort outranks current preset definitions and ledger handle/prefix joins; contradicting joins do not replace it. `IDLE` is sourced from registry/tmux evidence ONLY (tmux `window_activity`) and is contractually a HINT: tmux scopes that timestamp to the window and incoming courier traffic advances it, so nothing may route on it; usage bands and context depth are out of scope for this surface. `--strongest` prints the highest-tier reachable target — active seats plus always-available `Agent tool` rows — as bare handles, one per line, ties included.

Absent-ledger guidance and recorded launch tuning are specified in [Model reference and launch tuning](model-reference.md).

**Team-scoped calibration.** `tap models` is retired; `tap team calibration` remains TEAM-scoped (who is here, joined to that calibration, and free right now). A future catalog reference must keep that distinction: tap-ypmn resulted from a roster join living inside a catalog verb.

Human roster columns, state, context and JSON fields are specified in [Roster observations](roster-observation.md).

[Agent states and usable error composers](agent-state.md).

Claude cache markers and terminal colors are specified in [Model reference and launch tuning](model-reference.md).

Missing token samples render unavailable context without a stale-binding warning. A transcript header positively naming a different session warns and points to `tap team doctor`. Missing or unreadable transcripts, absent header identity, and not-yet-reported usage do not establish a mismatch. JSON state/reason fields retain their existing meanings and never include captured pane text.

Claude activity reporting shares the native observer between the roster and Bash
seat-state reader. A bounded composer is idle with or without draft text; alerts
and genuine busy footer hints retain precedence. Busy-marker words inside the
draft are not generation evidence. Courier input safety still classifies that
text as a draft. A valid unknown observation retains the existing Bash fallback;
a failed or malformed native observation returns unknown immediately.

Crew dismissal is pane-scoped. `tap out <crew>` (including --hard/--kill), `tap shutdown <crew>`, `tap crew shutdown <crew>` and `tap crew remove <crew>` use the same native D dismissal owner (`crew-lifecycle.ts`). The lifecycle matrix selects D for crew out. D checks the recorded pane, invokes the registry-only retirement leaf in process, then checks the pane again before `kill-pane`. It preserves sibling splits and the caller pane; a crew alone in its session is stopped and ends it. Missing, moved or foreign-server identity leaves the process untouched and reports why the row was retired without stopping it.

The retirement leaf in `out-retire.ts` acquires reset mutation custody before the acting-registry lock, revalidates selection and the expected row identity, runs the existing local obligation gate, and publishes through the shared lossless row/tombstone codec. Callers hold no lock; the leaf never calls a public lifecycle entry. A replacement instance refuses before retirement or pane effects. The hard-removal transaction owns its own custody and shares the inner codec rather than acquiring the leaf's locks again.

Receipts distinguish the requested action from the mechanism. JSON uses `lifecycle_action`, `mechanism`, `registry_fate` and `outcome`; crew out and crew shutdown share `mechanism=crew-dismiss`. Registry events keep their fixed fields: ordinary out uses `action=unregistered`, crew shutdown uses `action=shutdown`, and `detail=lifecycle_action=<action>;mechanism=<id>` carries the requested spelling and shared mechanism without changing the event line grammar. A retained pane reports `outcome=retired_pane_retained` and its reason.

**Crew acting registry (tap-dduzi):** Before creating a crew window, `tap crew add` resolves the acting registry through the existing team authority helper. Post-registration recipe persistence uses that registry, including the enrolled post-flip location; the retired bus `registry.json` is not a fallback. An unavailable acting registry refuses before window creation. Registration can MOVE authority (the born-live first-entry fold creates the acting store mid-flight), so after the register child succeeds, `tap crew add` re-resolves the acting registry fresh and persists the recipe there. A failed or empty fresh re-resolution fails closed — best-effort unregister, cleanup of the crew-owned window, and a typed `registry_unreachable` refusal before launch — never a fallback to an ambient or retired store.

**Crew pane address (tap-fgx9):** `tap crew add` resolves `#{session_name}:#{window_index}.#{pane_index}` after `new-window` and registers that address; `pane_id` remains the `%N` id. Registry `pane` is always address-shaped. A bare `%N` passed to `tap register --pane` is canonicalized to the live address before persist (that canonicalize is the load-bearing fix; the post-`new-window` capture is defense-in-depth). Existing id-shaped crew (or seat) `pane` fields left by the pre-fix write path are healed on the next `tap send` bind when the stored `pane_id` still resolves **and** the row's `server_epoch` is not stale relative to `tap_server_epoch_now` — a stale stamp refuses heal rather than writing a recycled address. `tap crew add` captures stdout from registration and launch preparation as their success receipts; if either stage refuses after window creation, add performs that stage's cleanup, preserves its exit status, and forwards any captured structured refusal to stderr. An empty refusal gets an add-owned stage-specific fallback diagnostic on stderr, so neither failure is a silent nonzero exit. `tap crew remove` authorizes `kill-pane` by session membership of the tip (row `session` ↔ live `#{session_name}`), not by bare `%N` existence and not by epoch; foreign tip → skip kill + print the unregister-shaped `kill-pane` hint.


Owner-wide `crew shutdown --json` returns one object with a `results` array, including per-seat failures. A dash-selected crew never receives a pane-stop effect; if it is live again before retirement, dismissal refuses.