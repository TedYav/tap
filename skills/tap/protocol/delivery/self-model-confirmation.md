# Self-switch model confirmation

After TAP's own `/model` submit ends unverified, the self-switch worker may accept
Claude's **Switch model?** dialog with one Enter. It reads one unjoined frame and
requires the complete dialog, including the selected **1. Yes, switch to** row,
matching model explanation, No row and confirmation footer. Whitespace after the
dialog rule is collapsed so complete wrapped dialogs work at narrow widths.
Clipped, unreadable or other frames receive no key. The worker rechecks the bound seat,
pane identity, custody fences and normal (not copy-mode) pane before Enter, while
holding the submit lock. This is a named completion of the already-typed local
command, not a re-delivery under `.claude/rules/no-retry-after-possible-effect.md`:
no text is typed again, no interrupt is inherited, and there is at most one Enter
per model switch step, with no retry even on a failed key result. The outcome
records acceptance; only the usual fresh transcript result confirms the switch.
An accepted but unproven switch skips effort and warns in the resume note.
This authority never answers permission prompts or model dialogs outside TAP's
own self-switch operation.

