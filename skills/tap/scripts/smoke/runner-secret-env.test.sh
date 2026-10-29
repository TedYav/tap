#!/usr/bin/env bash
# Removing a runner's secret scrub must expose only these fake credentials.
# Exercise the real Bun, shared pins, smoke and probe entry points.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
WORK="$(mktemp -d /tmp/tse.XXXXXX)"
trap 'rm -rf "${WORK:?}"' EXIT
python3 -I -B - "$ROOT" "$WORK" <<'PY'
import json, os, pathlib, shutil, subprocess, sys

root, work = map(pathlib.Path, sys.argv[1:])
repo = work / "repo"
for directory in ("scripts", "runtime/bun/test", "skills/tap/scripts/smoke", "tmp/seat"):
    (repo / directory).mkdir(parents=True)
for name in ("smoke-all.sh", "probe.sh", "ignored-state-tripwire.py", "suite-slot-run.py", "suite_slot.py"):
    shutil.copy2(root / "scripts" / name, repo / "scripts" / name)
for name in ("smoke-preflight.sh", "smoke_hermeticity_lint.py"):
    shutil.copy2(root / "skills/tap/scripts/smoke" / name, repo / "skills/tap/scripts/smoke" / name)

# Literal expectations, independent of the scrub implementation. Empty and
# multiline values must be removed too; classification reads names only.
names = ["REPLICATE_API_TOKEN", "RUNNER_TEST_API_KEY", "RUNNER_TEST_SECRET",
         "RUNNER_TEST_PASSWORD", "RUNNER_TEST_CREDENTIALS", "API_KEY", "TOKEN",
         "SECRET", "PASSWORD", "CREDENTIALS", "AWS_ACCESS_KEY_ID",
         "AWS_SECRET_ACCESS_KEY", "AZURE_OPENAI_KEY", "SSH_PRIVATE_KEY",
         "SSH_KEY", "AUTH_COOKIE", "HF_TOKENS", "DIRENV_DIFF",
         "GOOGLE_APPLICATION_CREDENTIALS", "TAP_RUNNER_TEST_TOKEN"]
env = dict(os.environ)
env.update({name: "fake-runner-credential" for name in names})
env["RUNNER_TEST_SECRET"] = "fake-first-line\nfake-second-line"
env["RUNNER_TEST_PASSWORD"] = ""
env["RUNNER_TEST_SETTING"] = "retained"
env["RUNNER_TEST_TOKEN_LIMIT"] = "17"
env["TAP_SMOKE_BUN"] = os.environ.get("TAP_SMOKE_BUN") or shutil.which("bun")
failures = []

def run(label, argv, marker):
    result = subprocess.run(argv, cwd=repo, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    fake_values = ("fake-runner-credential", "fake-first-line", "fake-second-line")
    if result.returncode or marker not in result.stdout or any(value in result.stdout for value in fake_values):
        failures.append(label)
        print(f"runner-secret-env: {label} FAILED (exit {result.returncode})")
        print(result.stdout)
    else:
        print(f"runner-secret-env: {label}: ok")

shell_check = '''
for name in %s; do
  if printenv "$name" >/dev/null; then
    echo "inherited secret present: $name" >&2; exit 1
  fi
done
# A fixture can opt in with an explicit fake after entry.
export REPLICATE_API_TOKEN=fixture-only
[ "$(printenv REPLICATE_API_TOKEN)" = fixture-only ] || exit 1
echo secret-boundary-ok
''' % " ".join(names)

# Shared pins run in a child shell, inside the outer runner's private roots.
run("sandbox-pins", ["bash", "-c", '. "$1"\n' + shell_check,
                    "bash", str(root / "skills/tap/scripts/smoke/sandbox-pins.sh")],
    "secret-boundary-ok")

bun_test = repo / "runtime/bun/test/secrets.test.ts"
bun_test.write_text('''import { test, expect } from "bun:test";
test("inherited secrets are absent and explicit fake credentials work", () => {
  for (const name of %s) {
    // Do not let an assertion render credential values, even on failure.
    if (Object.hasOwn(process.env, name)) throw new Error("inherited secret present: " + name);
  }
  expect(process.env.RUNNER_TEST_SETTING).toBe("retained");
  expect(process.env.RUNNER_TEST_TOKEN_LIMIT).toBe("17");
  process.env.REPLICATE_API_TOKEN = "fixture-only";
  expect(process.env.REPLICATE_API_TOKEN).toBe("fixture-only");
  delete process.env.REPLICATE_API_TOKEN;
});
''' % json.dumps(names))
run("bun", ["bash", str(root / "runtime/bun/test/run.sh"), str(bun_test)],
    "run.sh: ran 1 file:")

smoke_test = repo / "skills/tap/scripts/smoke/secrets.test.sh"
smoke_test.write_text("#!/usr/bin/env bash\nset -eu\n" + shell_check)
run("smoke", ["bash", str(repo / "scripts/smoke-all.sh"), "--only",
              "skills/tap/scripts/smoke/secrets.test.sh"], "all 1 files passed")
probe = repo / "tmp/seat/secrets.sh"
probe.write_text("#!/usr/bin/env bash\nset -eu\n" + shell_check)
run("probe", ["bash", str(repo / "scripts/probe.sh"), "tmp/seat/secrets.sh"], "probe: ok")
if failures:
    sys.exit("runner-secret-env: failed boundaries: " + ", ".join(failures))
PY
