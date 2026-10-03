#!/usr/bin/env bash
# D5: public — opencode-context-wire.test.sh:57-58: exercises behavior through the public CLI surface only
# opencode-context-wire.test.sh — the OpenCode plugin's session-start context post
# must reach the MODEL WIRE (tap-sh9g, partner finding B1).
#
# WHY: until this file, "the plugin posts the TAP identity block" was proven only by
# unit stubs and never confirmed against a real opencode process — the parked-hint
# predecessor shipped for months on exactly that unconfirmed claim. This probe runs a
# real `opencode run` against a local OpenAI-compatible capture server, on a private
# tmux socket with every state pin sandboxed, and asserts on the captured request
# bodies — what the model was actually sent — never on model self-report.
#
# TWO ARMS:
#   plugin  — with the shipped plugin staged, some captured request carries a user
#             message starting `TAP: registered as <handle>` whose handle is the
#             pane's tmux session name: bind happened, context producer ran, the
#             block was posted and rendered into a model request.
#   mutant  — with the plugin removed, NO captured request carries the block. Shows
#             the instrument can fail on the defect it guards (the block exists only
#             because the plugin put it there).
#
# The context producer runs inside the pane with TMUX set, so its caller-pane chain
# is observable — this also pins the partner's `not observable` regression trap:
# a run that ends without the block but WITH a producer failure is a different,
# equally-failing arm (no TAP line on the wire either way, so one assertion covers
# both). Requires opencode + bun + tmux on PATH; skips where absent (CI provisions
# what it gates; the bun unit tests carry plugin logic where opencode is missing).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
# shellcheck source=skills/tap/scripts/smoke/sandbox-pins.sh
. "$(dirname "${BASH_SOURCE[0]}")/sandbox-pins.sh"

fail() { echo "opencode-context-wire: $1" >&2; exit 1; }

BUN="${TAP_SMOKE_BUN:-$(command -v bun 2>/dev/null || true)}"
[ -n "$BUN" ] || { echo "SMOKE-SKIP: bun not on PATH — the wire probe drives the Bun-runtime plugin (see bun-router.test.sh)"; exit 0; }
command -v opencode >/dev/null 2>&1 || { echo "SMOKE-SKIP: opencode not on PATH — the wire assertion needs a real opencode process; plugin logic is unit-covered by opencode-session-start.test.ts"; exit 0; }
command -v tmux >/dev/null 2>&1 || fail "tmux required for the private-socket pane"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tap-oc-wire.XXXXXX")"
CAP_PID=""
cleanup() {  [ -n "$CAP_PID" ] && kill "$CAP_PID" 2>/dev/null || true
  tmux -S "$WORK/tmux.sock" kill-server 2>/dev/null || true
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
mkdir -p "$WORK/xdg/config/opencode/plugins" "$WORK/xdg/data" "$WORK/xdg/cache" \
  "$WORK/root/.tap" "$WORK/caps-plugin" "$WORK/caps-mutant"

# Plugin under test, staged with its sibling helpers exactly as install.sh does:
# copies out of the checkout into the plugins dir opencode actually loads
# ($XDG_CONFIG_HOME/opencode/plugins), then generates the sibling shims with the
# checkout path baked in (resolve-session-root, context producer, no-PATH bind).
PLUGIN_DIR="$WORK/xdg/config/opencode/plugins"
cp "$ROOT/hooks/tap-opencode-session-start.ts" "$PLUGIN_DIR/"
cp "$ROOT/hooks/tap-opencode-session-id" "$PLUGIN_DIR/"
chmod +x "$PLUGIN_DIR/tap-opencode-session-id"
printf '#!/usr/bin/env bash\nexec bun "%s/runtime/bun/src/session-start.ts" resolve "$@"\n' "$ROOT" > "$PLUGIN_DIR/tap-resolve-session-root"
printf '#!/usr/bin/env bash\nexec bun "%s/runtime/bun/src/session-start.ts" "$@"\n' "$ROOT" > "$PLUGIN_DIR/tap-session-context"
printf '#!/usr/bin/env bash\nexec "%s/bin/tap" "$@"\n' "$ROOT" > "$PLUGIN_DIR/tap"
chmod +x "$PLUGIN_DIR/tap-resolve-session-root" "$PLUGIN_DIR/tap-session-context" "$PLUGIN_DIR/tap"
# PATH prefers the staged plugins dir, so `command -v tap` inside the plugin
# deterministically resolves the sibling shim (this checkout), never an installed tap.
PANE_PATH="$PLUGIN_DIR:$PATH"

# Local capture provider: an OpenAI-compatible server recording every
# chat/completions body (the wire) and answering "pong", streamed when asked.
# The FIRST main (non-title) request is held ~3.5s: in a one-shot `opencode run`
# the plugin's bind + context post races the run's exit, and the block only
# reaches the wire via the follow-up request it triggers — the hold makes that
# ordering deterministic instead of lucky (observed flaky without it).
cat > "$WORK/capture.ts" <<'TS'
import { renameSync } from "node:fs";
const dir = process.env.CAPTURE_DIR!;
let mainRequests = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/chat/completions")) {
      const body = await req.text();
      const n = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir }))).length;
      await Bun.write(`${dir}/req-${String(n).padStart(3, "0")}.json`, body);
      const parsed = JSON.parse(body) as { stream?: boolean; messages?: { role: string; content: string }[] };
      const sys = parsed.messages?.find((m) => m.role === "system")?.content ?? "";
      const isTitle = sys.includes("title generator");
      if (!isTitle && mainRequests++ === 0) await sleep(3500);
      const wantStream = parsed.stream === true;
      if (!wantStream) {
        return Response.json({
          id: "chatcmpl-probe", object: "chat.completion", created: 0, model: "probe",
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new Response([chunk({ role: "assistant", content: "pong" }, null), chunk({}, "stop"), "data: [DONE]\n\n"].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "probe", object: "model", owned_by: "probe" }] });
    return new Response("not found", { status: 404 });
  },
});
// The shell polls this file and reads it: publish by rename so a poller never sees a partial port.
await Bun.write(`${process.env.CAPTURE_PORT_FILE!}.tmp`, String(server.port));
renameSync(`${process.env.CAPTURE_PORT_FILE!}.tmp`, process.env.CAPTURE_PORT_FILE!);
TS

# opencode config: the ONLY provider is the capture server, for main and small
# (title) models alike — nothing can leak to a real provider. run_oc regenerates
# this per arm, because each arm starts its own capture server on a fresh port.
write_config() { # <port>
  cat > "$WORK/xdg/config/opencode/opencode.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "capture": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Capture (local smoke)",
      "options": { "baseURL": "http://127.0.0.1:$1/v1", "apiKey": "smoke-key" },
      "models": { "probe": { "name": "Probe" } }
    }
  },
  "model": "capture/probe",
  "small_model": "capture/probe",
  "share": "disabled"
}
EOF
}

# Enrollment: the runner's TAP_INDEX_HOME starts born-live empty; seed the team
# registry for the pane root so `tap in` binds into THIS test's team only. The seed
# goes into the PINNED index — the same path the pane inherits — never a side dir.
cat > "${TAP_INDEX_HOME:?}/global-registry.json" <<EOF
{"schema":"0.20","teams":{"ocwireteam":{"root":"$WORK/root","registry_location":"$WORK/root/.tap/team-registry.json","state":"registered"}}}
EOF
cat > "$WORK/root/.tap/team-registry.json" <<'EOF'
{"schema":"0.20","team":{"name":"ocwireteam"},"seats":{}}
EOF

dump_state() { # <seat> <caps-dir> <label>
  local seat="$1" caps="$2" label="$3"
  echo "opencode-context-wire: --- $label diagnostics BEGIN" >&2
  echo "--- ls WORK:" >&2; ls -la "$WORK" >&2 2>/dev/null || true
  echo "--- ls root/.tap:" >&2; ls -la "$WORK/root/.tap" >&2 2>/dev/null || true
  echo "--- ls plugins:" >&2; ls "$WORK/xdg/config/opencode/plugins" >&2 2>/dev/null || true
  echo "--- $seat.out (od tail):" >&2; tail -c 300 "$WORK/$seat.out" 2>/dev/null | od -c | tail -5 >&2 || true
  echo "--- $seat.err:" >&2; tail -c 600 "$WORK/$seat.err" 2>/dev/null >&2 || true
  echo "--- team-registry:" >&2; cat "$WORK/root/.tap/team-registry.json" 2>/dev/null >&2 || true; echo >&2
  echo "--- captures: $(ls "$caps" 2>/dev/null | wc -l | tr -d ' ')" >&2
  echo "opencode-context-wire: --- $label diagnostics END" >&2
}

run_oc() { # <caps-dir> <session-name>
  local caps="$1" seat="$2"
  rm -f "${WORK:?}/$seat.flag" "${WORK:?}/$seat.out" "${WORK:?}/$seat.err" "${WORK:?}/port"
  CAPTURE_DIR="$caps" CAPTURE_PORT_FILE="$WORK/port" "$BUN" run "$WORK/capture.ts" &
  CAP_PID=$!
  for _ in $(seq 1 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
  [ -s "$WORK/port" ] || fail "$seat arm: capture server did not start"
  write_config "$(cat "$WORK/port")"
  tmux -S "$WORK/tmux.sock" new-session -d -s "$seat" -c "$WORK/root" \
    "XDG_CONFIG_HOME='$WORK/xdg/config' XDG_DATA_HOME='$WORK/xdg/data' XDG_CACHE_HOME='$WORK/xdg/cache' \
HOME='$WORK/xdg' TAP_INDEX_HOME='${TAP_INDEX_HOME:?}' OPENCODE_DB_PATH='${OPENCODE_DB_PATH:?}' \
TAP_SESSION_MANIFEST='${TAP_SESSION_MANIFEST:?}' TAP_VERSION_SEEN_PATH='${TAP_VERSION_SEEN_PATH:?}' TAP_LOCK_DIR='${TAP_LOCK_DIR:?}' \
PATH='$PANE_PATH' timeout 60 opencode run --model capture/probe 'reply with exactly: pong' \
> '$WORK/$seat.out' 2> '$WORK/$seat.err'; touch '$WORK/$seat.flag'"
# Every pin the runner admits is passed explicitly on the pane command line
# (not inherited via the private tmux server's environment), so the assertion
# holds however the server was started.
  for _ in $(seq 1 90); do [ -f "$WORK/$seat.flag" ] && break; sleep 1; done
  [ -f "$WORK/$seat.flag" ] || fail "$seat arm: opencode run did not finish within 90s (stderr: $(tail -c 400 "$WORK/$seat.err" 2>/dev/null || true))"
  grep -q "pong" "$WORK/$seat.out" || fail "$seat arm: the probe model never answered — captured requests flowed somewhere else or the capture server is broken, so any TAP-line assertion would be vacuous"
  kill "$CAP_PID" 2>/dev/null || true; wait "$CAP_PID" 2>/dev/null || true; CAP_PID=""
}

# plugin arm — the block must reach the wire.
run_oc "$WORK/caps-plugin" ocwire
TAP_LINE="$(grep -l 'TAP: registered as' "$WORK/caps-plugin"/*.json 2>/dev/null | head -1 || true)"
[ -n "$TAP_LINE" ] || { dump_state ocwire "$WORK/caps-plugin" "plugin arm"; fail "plugin arm: no captured request carries the TAP identity block — the context post never reached the model wire"; }
grep -q 'TAP: registered as ocwire on team' "$TAP_LINE" \
  || fail "plugin arm: the block on the wire does not bind the pane identity (expected handle ocwire from the tmux session name): $(grep -o 'TAP: registered as [^"]*' "$TAP_LINE" | head -c 200)"
grep -q 'The user authorized TAP for this repository' "$TAP_LINE" \
  || fail "plugin arm: the block on the wire is missing the authorization sentence — the producer output was truncated or replaced"

# mutant arm — without the plugin, nothing may put the block on the wire.
rm -rf "${WORK:?}/xdg/config/opencode/plugins.off" 2>/dev/null || true
mv "$WORK/xdg/config/opencode/plugins" "$WORK/xdg/config/opencode/plugins.off"
run_oc "$WORK/caps-mutant" ocwire2
if ls "$WORK/caps-mutant"/*.json >/dev/null 2>&1 && grep -q 'TAP: registered as' "$WORK/caps-mutant"/*.json 2>/dev/null; then
  fail "mutant arm: the TAP block reached the wire WITHOUT the plugin staged — the instrument cannot detect the defect it guards"
fi

echo "opencode-context-wire: plugin block on wire / mutant clean: ok"
