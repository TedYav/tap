# TAP watch resume (mechanical — no judgment needed)

{{REASON}}

Do exactly this:

1. Settle this message (its id is in the sentinel you received):
      tap read <id-from-the-sentinel> --by <your-handle>
2. RESUME the work you were doing before the block: re-read your work order and keep
   going. This message reassigns nothing and is NOT a stop order. End your turn only
   if you have no in-flight work (e.g. the block was your lane already completing).
3. ONLY if you are blocked, or you believe the run is done, send the armer one line:
      tap send {{ARMER}} --wake -m "<blocked: what needs intervention | done: what proves the run is complete>"
4. Do not disarm this watch. The armer owns run closure; report done-ness to them.

Do NOT `tap reply` to this message — the sender ('watcher') is pane-less and has no
inbox, so a reply cannot be delivered. Settlement alone records that you saw this;
routine status creates a reply loop and is not requested.
