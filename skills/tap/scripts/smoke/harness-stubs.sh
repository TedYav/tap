# Source me. install.sh wires a harness home only when its command is on PATH or
# its hooks file already exists (tap-gjwtw). A smoke that seeds a bare home and
# expects it wired puts these stub commands on PATH: make_harness_stubs <dir>.
make_harness_stubs() {
  local dir="$1" name
  mkdir -p "$dir"
  for name in claude codex cursor-agent agy opencode hermes; do
    printf '#!/bin/sh\nexit 0\n' >"$dir/$name"
    chmod +x "$dir/$name"
  done
}
