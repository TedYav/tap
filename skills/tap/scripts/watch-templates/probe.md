# TAP liveness probe (mechanical — no judgment needed)

The team has been silent past the watch threshold and your seat is the current
escalation rung. This probe checks that you are alive — it reassigns nothing and is
NOT a stop order. Do exactly this:

1. Settle this probe (its id is in the sentinel you received):
      tap read <id-from-the-sentinel> --by <your-handle>
2. ONLY if you are blocked, or you believe the run is done, send the armer one line:
      tap send {{ARMER}} --wake -m "<blocked: what needs intervention | done: what proves the run is complete>"
3. Then RESUME whatever work order you hold: re-read its body and keep working.
   Settling this probe does NOT release you from an assignment. End your turn only if
   you have no in-flight work (nothing assigned, or your lane is already complete).
4. Do not disarm this watch. The armer owns run closure; report done-ness to them.

Do NOT `tap reply` to this message — the sender ('watcher') is pane-less and has no
inbox, so a reply cannot be delivered. Settlement alone is the liveness signal; routine
status creates a reply loop and is not requested.
{{NUDGE}}
