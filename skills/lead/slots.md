# Repository slots for lead

Resolve slots in the caller's repository, using the rules below.

- Look first in `.agents/slots/lead/<slot>.md`, then for the exact declared heading in `AGENTS.md`; the first file declaring it wins, with no merging.
- The body ends at the next heading of the same or higher level; duplicate matching headings in the selected file are ambiguous and require STOP.
- If neither file declares the heading, use the absent default and report `Slot strategy-learnings: absent; using <default>.` once.
- An empty, malformed or unreadable binding, or a required target that is missing, requires `STOP: slot strategy-learnings — <reason>`; a failed read is not absence.
- REFERENCE paths are relative to the caller's repository root, canonicalized and confined to that root; moving the binding file does not rebase its targets.
- Discover SKILL targets and prompts through the active harness's installed skill roots, which may be outside the repository; unresolved required rows are broken, never skipped.
- Optional rows say so in prose and report unavailable capabilities explicitly.
- A slot grants no added execution, access, spending or mutation authority.

| Slot | Kind | Heading | Lookup | Shape | Absent default |
| --- | --- | --- | --- | --- | --- |
| `strategy-learnings` | Rows of SKILL / REFERENCE | `Strategy Learnings` | `.agents/slots/lead/strategy-learnings.md`, then `AGENTS.md` | Ordered rows: `kind — target — input -> result`. SKILL rows name a resolvable skill/prompt, input and expected result. REFERENCE rows name repository-relative paths with an explicit selection rule, never newest mtime. | Bounded read of the compounding convention named in `AGENTS.md`; if none is declared, record `no learning pass: no convention declared` in the strategy doc. |
