# Claude compact wrapping, September 23

`claude-control-wrap-20260923.ansi` is the raw `capture-pane -p -e` frame that
`tap self compact` saved when it refused nightwatch's compact at 17:21Z
(tap-arm4w). The pane is 145 columns wide, running Claude Code 2.1.280. The
composer holds the expected command byte for byte. Continuation row 1 ends at
`load-flake` (131 cells), yet `specimens` would only have reached cell 141,
which is box width minus four. The old matcher treated that break as a typed
newline and withheld Enter.

`claude-control-wrap-20260923-probe100.ansi` comes from a sandboxed live probe:
sandbox HOME, the runner's private tmux socket, and no Enter pressed. Across 36
probe frames at 69, 100 and 145 columns, no row exceeded width minus four.
A word ending exactly at that cell sometimes stayed and sometimes wrapped, so
fixed-width greedy wrapping does not describe this renderer.
