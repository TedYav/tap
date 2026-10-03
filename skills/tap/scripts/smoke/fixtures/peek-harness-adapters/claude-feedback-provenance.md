# Claude feedback-panel controls

`claude-feedback-truncated.ansi` is the unchanged raw capture recorded at 2026-09-01 21:36Z from HerdrAuditNight/fable-herdr-audit-driver, pane %214. Its feedback panel sits above a truncated legacy sentinel. The viewport has no bottom composer border. Source: primary checkout `tmp/lane-lead-9-1/specimens/20260901T2136-truncated-digest-sentinel-claude-band.ansi`.

`claude-feedback-empty-constructed.ansi` derives from that capture: it removes the active input text and adds a bottom composer border. This constructed frame tests the guard when ordinary native geometry would otherwise allow injection. Neither frame proves why the original paste truncated. Plain `.txt` companions remove ANSI sequences only.

The panel must be dismissed and the composer inspected manually. A truncated prefix establishes neither ownership of all input nor absence of an earlier effect; it never authorizes automatic clearing or reinjection.
