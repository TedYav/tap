# Antigravity survey specimens

The fixtures retain observed survey text, footer variants and composer geometry.
Upper-body content is synthetic; no project paths, code or work history are included.

- `original.txt`: CLI 1.1.16 survey with the shortcuts/Gemini 3.7 footer. The original
  source capture has SHA-256
  `a097520d09c4bdd968b97297084c00e9abbb5286fc6a360ae43592b038f42df2`;
  this sanitized fixture intentionally has a different hash.
- `current-running.txt`: September 7, 2026 live survey in a 92x42 pane, active work
  behind the overlay and the `esc to cancel` / Gemini 3.8 footer.
- `current-restored.txt`: observed empty composer after one literal `0`, with active
  work continuing and no recovery Enter.

The operator-owned live probe sent `0` to two identity-checked survey panes; input
returned without Enter. Raw captures remain local and are not repository artifacts.
Public tests replay the sanitized current shape through native MAIN and Bash send.
