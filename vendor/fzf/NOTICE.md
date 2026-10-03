# Bundled fzf notices

TAP installs the official fzf 0.74.4 platform executable from
https://github.com/junegunn/fzf/releases/tag/v0.74.4 into its private tools directory.
The archive digests in manifest.json come from the upstream checksums.txt retained
here. Executable digests were computed from those verified archives. No executable
is committed to this repository.

LICENSE is fzf's MIT license. The additional *.LICENSE files retain the license
notices for the modules listed by fzf v0.74.4's go.mod (including optional/indirect
modules): fastwalk v1.0.14, tcell v2.9.0, go-shellwords 2aa3b3277741, go-isatty
v0.0.24, uniseg v0.4.7, golang.org/x/sys v0.35.0, x/term v0.34.0, encoding v1.0.1,
go-colorful v1.2.0, go-runewidth v0.0.16, and x/text v0.28.0. These notices are
copied next to the installed executable. Sources are their respective upstream
repositories at those pinned versions.

The release binaries embed the Go 1.27.1 runtime. Its BSD license is retained
in go.LICENSE alongside the module notices.
