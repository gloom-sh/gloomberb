# Terminal header update status captures

Source change: `b696464db5f7c2ce06d1bc0d50400d0fab518102`.
Baseline: `5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4`.

[What was already fixed on main](baseline-check.md).

## Terminal

[Capture notes and coverage](terminal/README.md) · [Plain-text before/after frames](terminal/header-frames.md) · [Unchanged-pane comparison](terminal/panes-comparison.json) · [Per-frame hashes](terminal/pane-frame-hashes.json).

| Columns | Dark | Light |
|---|---|---|
| 60 | [Before/after](terminal/header-white-60.png) | [Before/after](terminal/header-paper-60.png) |
| 80 | [Before/after](terminal/header-white-80.png) | [Before/after](terminal/header-paper-80.png) |
| 120 | [Before/after](terminal/header-white-120.png) | [Before/after](terminal/header-paper-120.png) |
| 160 | [Before/after](terminal/header-white-160.png) | [Before/after](terminal/header-paper-160.png) |

The header sheets cover idle, downloading, ready, failed, transient notice, and Restart. They reproduce actual OpenTUI cell text, colours and bold attributes. Only narrow update-status text changes. All 268 retained pane root text-frame pairs remain byte-identical: 244 built-in pairs and 24 external-plugin pairs. The [external-plugin notes](terminal/plugin-capture-notes.md) record the fixed-spinner capture correction, pair provenance, and timeout limit.

## All-pane UI sweep

[Before/after gallery, view index, and coverage limits](ui/README.md) cover 640 and 1280 px in dark and light themes. Missing and unstable variants are documented separately from unchanged views.

## Performance

Both 120-ticker memory checks passed. The locked navigation benchmark flagged slower handling and more redrawn cells; timing and redraw causality remain inconclusive under severe host contention. [Measurements and limits](performance/README.md).
