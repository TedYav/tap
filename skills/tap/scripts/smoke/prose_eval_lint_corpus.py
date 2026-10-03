#!/usr/bin/env python3
"""Red fixtures for prose_eval_lint — prove the lint fails on the known bomb shape.

Validates the instrument on a planted copy of opencode-sessionstart-bind's
failure mode before trusting greens on the live tree. Also proves two-way
anti-masking: a stale allowlist entry fails. And proves the wild latent→live
transition on the PATH-shadow cousin shape (session-id-capture /
sessionstart-pending-bind): silent without bare eval; reds once a prose
backtick lands inside the unquoted body.
"""

from __future__ import annotations

import os
import shutil
import tempfile

import prose_eval_lint as lint

# Exact shape of the tap-psif bomb (unquoted <<FAKE, shebang stub, prose backtick).
BOMB = """#!/usr/bin/env bash
WORK="$(mktemp -d)"
mkdir -p "$WORK/fakebin"
MARKER="$WORK/binds.log"
cat > "$WORK/fakebin/tap" <<FAKE
#!/usr/bin/env bash
# Records the session id `tap in` was handed, one line per invocation.
exit 0
FAKE
chmod +x "$WORK/fakebin/tap"
"""

SAFE = """#!/usr/bin/env bash
WORK="$(mktemp -d)"
mkdir -p "$WORK/fakebin"
cat > "$WORK/fakebin/tap" <<'FAKE'
#!/usr/bin/env bash
# Records the session id that tap-in was handed.
exit 0
FAKE
chmod +x "$WORK/fakebin/tap"
"""

# Wild latent shape from session-id-capture / sessionstart-pending-bind (pre-fix):
# unquoted PATH-shadowed tap stub, body free of bare eval. Lint must stay silent —
# these are latent, not live. One prose backtick in a comment flips them to the bomb.
COUSIN_LATENT = """#!/usr/bin/env bash
MOCKBIN="$(mktemp -d)"
TAP="/repo/bin/tap"
cat > "$MOCKBIN/tap" <<TAP
#!/usr/bin/env bash
exec bash "$TAP" "\\$@"
TAP
chmod +x "$MOCKBIN/tap"
"""

COUSIN_LIVE = """#!/usr/bin/env bash
MOCKBIN="$(mktemp -d)"
TAP="/repo/bin/tap"
cat > "$MOCKBIN/tap" <<TAP
#!/usr/bin/env bash
# Records the session id `tap in` was handed — one prose backtick.
exec bash "$TAP" "\\$@"
TAP
chmod +x "$MOCKBIN/tap"
"""

# Forms the first regex missed (confident green): trailing redirect, <<-WORD, << WORD.
BOMB_TRAILING = """#!/usr/bin/env bash
WORK="$(mktemp -d)"
mkdir -p "$WORK/fakebin"
cat <<FAKE > "$WORK/fakebin/tap"
#!/usr/bin/env bash
# Records the session id `tap in` was handed.
exit 0
FAKE
chmod +x "$WORK/fakebin/tap"
"""

BOMB_DASH = """#!/usr/bin/env bash
WORK="$(mktemp -d)"
mkdir -p "$WORK/fakebin"
cat > "$WORK/fakebin/tap" <<-FAKE
	#!/usr/bin/env bash
	# Records the session id `tap in` was handed.
	exit 0
FAKE
chmod +x "$WORK/fakebin/tap"
"""

BOMB_SPACE = """#!/usr/bin/env bash
WORK="$(mktemp -d)"
mkdir -p "$WORK/fakebin"
cat > "$WORK/fakebin/tap" << FAKE
#!/usr/bin/env bash
# Records the session id `tap in` was handed.
exit 0
FAKE
chmod +x "$WORK/fakebin/tap"
"""


def run_collect(smoke_dir: str):
    real = lint.SMOKE
    lint.SMOKE = smoke_dir
    try:
        return lint.collect_hits()
    finally:
        lint.SMOKE = real


def assert_red(failures: int, smoke_dir: str, name: str, body: str) -> int:
    path = os.path.join(smoke_dir, f"{name}.test.sh")
    open(path, "w", encoding="utf-8").write(body)
    hits = [h for h in run_collect(smoke_dir) if name in h["file"] and "backtick" in h["spans"]]
    if not hits:
        print(f"FAIL {name} invisible — lint misses this form", flush=True)
        return failures + 1
    print(f"ok   {name} reds at line {hits[0]['line']}", flush=True)
    return failures


def main() -> int:
    failures = 0
    tmp = tempfile.mkdtemp(prefix="prose-eval-corpus-")
    try:
        bomb_path = os.path.join(tmp, "planted-bomb.test.sh")
        open(bomb_path, "w", encoding="utf-8").write(BOMB)
        hits = run_collect(tmp)
        bomb_hits = [
            h for h in hits if "planted-bomb" in h["file"] and "backtick" in h["spans"]
        ]
        if not bomb_hits:
            print(f"FAIL planted bomb invisible — hits={hits}", flush=True)
            failures += 1
        else:
            print(
                f"ok   planted bomb reds at line {bomb_hits[0]['line']}",
                flush=True,
            )

        # Quoted twin must stay green.
        safe_dir = tempfile.mkdtemp(prefix="prose-eval-safe-", dir=tmp)
        open(os.path.join(safe_dir, "quoted-safe.test.sh"), "w", encoding="utf-8").write(SAFE)
        safe_hits = run_collect(safe_dir)
        if safe_hits:
            print(f"FAIL quoted safe stub still hits: {safe_hits}", flush=True)
            failures += 1
        else:
            print("ok   quoted heredoc stub is silent", flush=True)

        # Wild cousins: silent until a backtick lands inside the unquoted body.
        cousin_dir = tempfile.mkdtemp(prefix="prose-eval-cousin-", dir=tmp)
        open(os.path.join(cousin_dir, "cousin-latent.test.sh"), "w", encoding="utf-8").write(
            COUSIN_LATENT
        )
        latent_hits = run_collect(cousin_dir)
        if latent_hits:
            print(f"FAIL cousin latent shape should be silent: {latent_hits}", flush=True)
            failures += 1
        else:
            print("ok   wild cousin shape (no bare eval) is silent — latent, not live", flush=True)

        open(os.path.join(cousin_dir, "cousin-live.test.sh"), "w", encoding="utf-8").write(
            COUSIN_LIVE
        )
        live_hits = [
            h
            for h in run_collect(cousin_dir)
            if "cousin-live" in h["file"] and "backtick" in h["spans"]
        ]
        if not live_hits:
            print("FAIL cousin+backtick comment invisible — lint misses wild transition", flush=True)
            failures += 1
        else:
            print(
                f"ok   wild cousin + one prose backtick reds at line {live_hits[0]['line']}",
                flush=True,
            )

        # Previously-missed forms (confident-green blind spots).
        form_dir = tempfile.mkdtemp(prefix="prose-eval-forms-", dir=tmp)
        failures = assert_red(failures, form_dir, "bomb-trailing-redirect", BOMB_TRAILING)
        failures = assert_red(failures, form_dir, "bomb-dash-heredoc", BOMB_DASH)
        failures = assert_red(failures, form_dir, "bomb-space-word", BOMB_SPACE)

        # Stale allowlist entry must fail main() even when tree is clean.
        clean_dir = tempfile.mkdtemp(prefix="prose-eval-clean-", dir=tmp)
        open(os.path.join(clean_dir, "clean.test.sh"), "w", encoding="utf-8").write(SAFE)
        real_smoke, real_allow = lint.SMOKE, lint.ALLOWLIST
        lint.SMOKE = clean_dir
        lint.ALLOWLIST = [
            ("clean.test.sh", 999, "stale on purpose — no hit at this line"),
        ]
        try:
            import io
            import contextlib

            err = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                rc = lint.main()
        finally:
            lint.SMOKE, lint.ALLOWLIST = real_smoke, real_allow
        if rc != 1 or "STALE" not in err.getvalue():
            print(f"FAIL stale allowlist not refused (rc={rc}, err={err.getvalue()!r})", flush=True)
            failures += 1
        else:
            print("ok   stale allowlist entry fails (two-way anti-masking)", flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print(f"FAIL prose-eval-lint-corpus — {failures} check(s)", flush=True)
        return 1
    print("PASS prose-eval-lint-corpus", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
