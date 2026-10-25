# Signed-out terminal check

Base: `origin/main` at `4c11d3c99f0849cda8e9a7f296272fc7d73d2a22` (terminal catalog and affected panes unchanged by the web fix).

Started the real terminal app in a 128 by 42 tmux session with an isolated, signed-out profile. The local remote endpoint operated the actual command bar, activated its first result, and read the live pane list. Each command was offered as enabled, opened populated data, and restored after restarting the same profile with the exact pane instance id retained:

- `13F`: fund performance table.
- `ERN AAPL`: company earnings history and implied/realized move chart.
- `EVTS`: market earnings calendar.
- `HDS AAPL`: institutional holder table.

Files in `terminal/` keep the command result JSON and text captures before/after activation and restoration. `panes-before-restart.json` and `panes-after-restart.json` have the same instance ids. No React hook, update depth, listener leak, or error signatures appeared in the captured runtime logs. RSS was 306 MB after startup and 511 MB after opening four data panes; this short smoke does not establish long-run memory behavior.

Anonymous endpoint checks returned HTTP 200 for 13F fund search, the SEC ticker-holder index, beneficial owners, market holders, earnings calendar, and earnings history. FUNCTION_HELP entries for all four functions have no access restriction. The missing web commands are a catalog omission, not an account or Pro gate.

Desktop renderer check: `gloom shot ERN AAPL --strict --width 1280 --height 720` completed with 13 rows, and the equivalent 13F capture completed with 37 rows. HDS and EVTS initially reached the 60-second smoke limit; both completed on a serial 120-second retry under the shared sweep lock at low priority, with populated tables. All four screenshots are in [desktop/](desktop/), with the final retry status in [retry-results.json](desktop/retry-results.json). These checks use the shared DOM pane renderer while signed out. The native Electrobun window was not launched.

Cleanup: terminal tmux session killed, isolated GLOOMBERB_HOME removed, temporary screenshot folders removed, and no process from this smoke remains.
