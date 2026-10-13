# Sentinel (the wire poke — zero authority) — source part 1 of 2

> Normative TAP v0.23 source fragment. Search the group index for adjacent parts.

<!-- tap-source id=source-0073 start=469392 end=477281 sha256=5acd528e591defc02172f9e49471dbdda10f79338c95733a1f8c07ffebfa385d fragment=1/2 transform=wrapper_prefix -->
<!-- TAP_SOURCE_BYTES_BEGIN -->
## Sentinel (the wire poke — zero authority)

```
[[TAP v0.23 <ask|note> [<team>/]<id> [tag ...] [preview="text"] [path=<abs>][: inline note body]]]
```

One line identifying a payload, with optional display hints. It carries no authority; the recipient reads the payload before acting. The courier injects this into the recipient's pane. **Slots 1–3 are fixed, positional, and always present:** the version (`v0.23`, no `=`), the obligation (`ask` or `note`, never omitted — the one word every reader must see), and the full minted id. Everything after slot 3 is order-free and present only when true.

**The one id-less form is the nudge doorbell** (tap-xe42x): `[[TAP v0.23 nudge]]` or `[[TAP v0.23 nudge message="<json string>"]]`, typed only by `tap nudge` ([nudge](./nudge.md)). It identifies no payload, so slot 3 is absent; the payload parser refuses it (`a nudge doorbell names no payload id`) and `runtime/bun/src/nudge-wire.ts` owns its strict grammar. It carries no sender, reply or task: the seat continues its work and checks `tap poll`.

**Optional previews (2026-09-08; amends the protocol-diet ruling).**
`[sentinel] preview = false` is the machine-config default. Toggle it with
`tap config set sentinel.preview true|false` (a round-trip-safe edit of the machine
config; the render reads the file per delivery, so the new value takes effect on
the next delivery). With it enabled,
`send`, `assign` and `reply` display a preview as
`preview="text"` before any `path=`. The value is JSON-quoted. A digest carries
`preview(<item-id>)="text"` for each item that has a hint; it never presents one
item's hint as the digest's own. Explicit `--preview` overrides the derived preview.
Without it, rendering derives the first non-empty body line after the envelope,
trimmed and cut at a word boundary within `[sentinel] preview_chars` UTF-8 bytes
(default 120; positive integer). Derived text is never stored in the envelope or
digest index; `sentinel_preview:` continues to mean an explicit hint. With the toggle off,
sentinels retain their existing bytes even when the caller passes the flag.

**Picker-safe hints (tap-7r3fn.208).** A rendered hint never carries a token-initial
`@` or `/`: every whitespace-delimited token loses its leading `@` and `/` run
(`@codex review` becomes `codex review`; `on tap#2312 @` becomes `on tap#2312`), and a
hint left empty renders no `preview=`. OpenCode's composer opens a mention or command
picker for such a token and the picker swallows the submit Enter, which leaves the
sentinel staged and refuses later deliveries to that seat. The wire is
recipient-agnostic, so the rule covers every recipient and every source (explicit,
derived, digest item, spooled before the rule landed): it applies where the hint
renders, never in the stored `sentinel_preview:` or the body. Mid-token `@` and `/`
(`user@host`, `a/b`) open nothing and stay. `/` is stripped as a precaution; the
specimen was `@`, so revisit it if OpenCode is shown never to open a picker for `/`
after `[[TAP`. Text without a trigger is rendered byte-for-byte.

The courier stores the explicit hint as base64 UTF-8 in its owned
`sentinel_preview:` envelope field and copies it into digest items. Writer
copies of that field are discarded; there is no `summary:` key. Rendering reads
the current toggle for direct delivery, replay, cross-team and pointer forms,
digest items, and `tap poll`. Thus changing the toggle also changes how queued
messages appear. Missing or unreadable config disables previews.

An explicit hint is trimmed and limited to 240 UTF-8 bytes at a word boundary. A word
longer than that limit is omitted. Text containing `]]`, controls or line
separators is dropped; explicit hints produce a stderr notice and derived hints
are omitted silently. An unsafe first body line does not fall through to later
lines. Delivery continues. **A rejected explicit hint is not an absent one
(tap-zlfg5).** When `--preview` was given on `send`, `assign` or `reply` (even
blank) and sanitization dropped it, the courier stamps `sentinel_preview: -`. `-`
is outside the base64 alphabet, so every reader decodes it to no preview, and the
digest index copies it like any hint. The sender's override stands: no preview is
shown, and the body's first line is not derived in its place. A send with no
`--preview` carries no field and derives as before; `reply` forwards the flag only
when the caller gave it. `tap resend` re-rings the same canonical, so its stored field rides
unchanged (an accepted hint stays that hint, `-` stays `-`, an absent field
stays absent). A rejected hint still yields no `preview=`, so an
inline-eligible note body may ride the wire as `: body`, the same as with the
toggle off. The shell-body
guard checks `--preview` for shell-evaluated backticks and `$()`; use single
quotes for literal shell syntax. These lossy hints are distinct from the
lossless `: body` form and suppress that form when present. They grant no read,
reply or settlement authority: **read the payload before acting**. Existing
v0.22/v0.23 sentinels without a preview remain readable.

**Tags are bare words from a closed set:** `urgent`, `critical`, `escalate`, `digest`, `agent-interrupt`, `retry`. `agent-interrupt` follows `urgent` only on the direct send that may press the recipient's interrupt key (tap-1i81h): Claude renders the cancelled tool call as "interrupted by user", so the next line names an agent as the source. Spool redelivery never interrupts and never carries it. `escalate` describes content and grants no interrupt authority. An explicitly interrupting escalation carries both `escalate urgent`; an ordinary escalation carries only `escalate`. Both forms use the existing closed-set tag parser. Old `escalate`-only wires remain readable and never license pane effects. `retry` marks the sender's explicit [same-ID retry](./reliability.md#explicit-same-id-retry): this doorbell may have rung before. It grants no authority, does not claim the duplicate is proven, and comes last, after any `agent-interrupt`; a retry rings as ordinary delivery, so in practice the two never co-occur and an urgent original re-rings without `urgent`. Attempt number, actor and timing stay in the durable records, not on the wire. `critical` is reserved parse-side and has no producer. Every other `kind` leaves the wire and stays in the envelope; delivery mode never rides the wire, because the recipient already received the message however it landed.

**A `<team>/` prefix on the id slot is a BUS LOCATOR, not a label naming who spoke.** The canonical payload lives on the SENDER's bus: split the first `/` to locate that bus and use the remainder as the file id. Verified delivery separately advances the recipient’s bound delivery clock. Ids on disk are never qualified.

**The prefix locates the bus; the id's first field is sender CONVENTION only (tap-7r3fn.8, ruling 63).** A minted id is `<handle>-<UTC ts>-<12 hex>`, so its first field is normally the sending handle — but nothing derives the sender from it in code, and nothing may start: the file carries `from:`. The two are independent, and conflating them is a live hazard rather than a pedantic distinction. `tap send --id` and a writer-supplied frontmatter `id:` are validated by charset alone (`validId`, `runtime/bun/src/ids.ts`), so a chosen id's first field need not be the sender; the prefix is still correct, because the courier computes it from `from_team`/`to_team`, which no caller can supply. **Suppressing the prefix on the grounds that the first field looks unfamiliar would drop a valid bus locator and make the id read as same-team — a silent wrong-bus read.** If a future feature ever does derive the sender from an id, it must constrain `--id` and the frontmatter `id:` first; the measured cost of doing so is recorded on that bead.

**Unknown tokens are MALFORMED and reported, never skipped.** A positional version header selects that grammar before any legacy-key search; inline prose cannot supply legacy `id=` or `to=` fields. This retires the v0.22 tolerance that let a reader skip unknown trailing tokens so an old parser could still recover an `id`; that tolerance also let a wrong-shaped sentinel look well-formed, and one shape per release removes the case it existed for.

**The reader rejoins a slot across a visual wrap.** One implementation answers for every reader — `runtime/bun/src/stuck-sentinel.ts`, which the native delivery path reaches through `pendingSentinel`; there is no second grammar to keep in agreement. The input band is captured without `-J`, so tmux wrapping delivers a long sentinel as several lines. The old key=value grammar rejoined itself for free — `id=` anchored the left and a `\s+KEY=` lookahead the right — and positional slots have neither anchor, so each slot is joined greedily until its own pattern matches. That is safe because every slot's target is closed or right-anchored: the version is `v<major>.<minor>`, the obligation is one of two words, and the id is `[<team>/]<handle>-<YYYYMMDDTHHMMSSZ>-<12hex>`, whose two suffix fields are fixed-width and always present. **Never parse an id from the left.**

**`: ` after the header starts an inline note body** (spec §1): notes only, and only when the body is already wire-safe byte for byte — no newline, no control character, no `]]`, at most **200 bytes**. It is never transformed; an ineligible body simply takes the read path, and a body with a token-initial `@` or `/` is ineligible for the picker reason above. Bytes rather than characters is deliberate: `${#body}` counts characters under a UTF-8 `LC_CTYPE` and bytes under `LC_ALL=C`, and `tap send` runs in the operator's environment, so a character limit makes the two runtimes disagree on the wire wherever the locale does not cooperate. The payload file and the receipt chain are always written — inline is a delivery form, not a second record. **A body never rides alongside `path=`:** both can run to the end of the line and the grammar does not say which wins, so a payload path containing `": "` would parse as a short pointer plus a body made of the rest of the path.

**Version drift is a notice, not a mechanism.** A seat that sees a different version on the wire loads `/tap`; `tap read` echoes the version and does nothing else about it.

**`path=` survives where the id alone does NOT resolve (v0.23, tap-7r3fn.8; tap-7r3fn.3.3).** Same-bus digest ids resolve through `tap read` and `tap show`, so digest sentinels omit the pointer. The **bare-recipient manual relay** (`--cross-worktree --pane <bare-handle>`), which never learns the recipient's team, so nothing a reader looks up finds the bus. And a send whose **sender team does not resolve through the machine index** — probed at construction time with the same resolver the reader will use, under `tap_authority_context` polarity: an absent marker takes the legacy worktree-scan door, while an invalid or unreadable one refuses the render rather than guessing, because a pointer chosen by a coin flip is worse than a refusal. Everywhere else the pointer is gone and the full id in slot 3 is what a reader pastes into `tap read` / `tap show`.

