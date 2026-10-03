# OpenCode splash readiness fixtures

`constructed-splash.txt` is constructed from the 2026-09-04 tap-7r3fn.36
incident report. The reporter preserved a later `tap peek` description of the
four-line OpenCode banner, but not the raw same-instant tmux frame or its width.
It is therefore a labelled characterization fixture, not incident capture
evidence.

`healthy-idle-band.txt` is the ANSI-stripped, bottom-chrome excerpt of a live
healthy OpenCode pane captured read-only at approximately 2026-09-04T11:13Z:

```text
timeout 5 tmux capture-pane -p -J -t tap/palm-review:0.0
```

The original 24-line, 2,120-byte capture had SHA-256
`ee6e43d5785130bcb67f528a613a4d9efaad89c526debcd6292ce532f428cb4e`.
Only the relevant final input-band rows are retained here. This is a positive
ready control, not a generating-pane specimen or a splash capture.

2026-09-26: the retained rows were passed through the same-length fixture
map, so this excerpt no longer matches that original byte
for byte; the hash above stays a record of the capture it names.
