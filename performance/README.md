# Locked performance checks

The single locked navigation benchmark flagged slower input handling and more redrawn cells. Timing and redraw causality remain inconclusive under severe shared-host contention; this is not a passing performance result.

Observed median p50: 13.11 → 51.79 ms. Median redrawn cells: 92.0 → 412. Source launch disables update checks; the recording does not identify which pane caused redraws.

Memory before: 120 ticker navigations, late heap slope 0.02 MiB/ticker (limit 0.3); passed.
Memory after: 120 ticker navigations, late heap slope 0.04 MiB/ticker (limit 0.3); passed.

All observed app processes ran at nice 19. No benchmark rerun was performed. Memory coverage does not establish long-term leak absence.

[Measurements and run limits](comparison.json) · [Smoke cleanup](cleanup.json).
