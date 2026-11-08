#!/usr/bin/env bash
# Sourced by smokes that run install.sh with a fresh TAP_INDEX_HOME. install.sh stages
# the pinned fzf, which downloads its archive from GitHub. When the operator's own
# verified cache already holds that archive, point install-fzf.ts at it
# (TAP_FZF_TEST_ARCHIVE) so ordinary runs need no network. Otherwise leave the
# variable unset and the installer downloads as before. The installer re-checks the
# sha256 either way; this only chooses where the bytes come from (tap-335zf).
#
# The asset key and cache path come from fzf-tool.ts run under the same bun the
# installer uses, never from another runtime's idea of the platform: a mixed-arch
# host (x86 python under Rosetta, arm64 bun) would otherwise pick the wrong archive.
# The account's passwd home. Not $HOME, which the suite sandboxes, and not Bun's
# os.userInfo().homedir, which returns $HOME (unlike Node's), so a sandboxed run
# never found the real cache through it.
tap_fzf_account_home() {
  python3 -I -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null
}
tap_pin_fzf_archive() {
  [ -n "${TAP_FZF_TEST_ARCHIVE:-}" ] && return 0
  local root home cached
  root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" || return 0
  command -v bun >/dev/null 2>&1 || return 0
  home="$(tap_fzf_account_home)" || return 0
  [ -n "$home" ] || return 0
  # Any failure (unsupported platform, missing cache, mismatched sha256) prints nothing.
  cached="$(bun -e '
    const { fileMatches, fzfTool } = await import(process.argv[1] + "/runtime/bun/src/fzf-tool.ts");
    try {
      const tool = fzfTool({ TAP_INDEX_HOME: process.argv[2] + "/.tap" });
      if (fileMatches(tool.cache, tool.sha256)) console.log(tool.cache);
    } catch {}
  ' "$root" "$home" 2>/dev/null)" || return 0
  [ -n "$cached" ] && export TAP_FZF_TEST_ARCHIVE="$cached"
  return 0
}
tap_pin_fzf_archive
