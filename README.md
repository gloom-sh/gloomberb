# Account sync and web function review evidence

- [Two-account sync reproduction](sync/README.md), including a fixture that fails on the original main commit and passes after the fix.
- [Web command and saved-pane captures](web/README.md), before and after at 640 and 1280 px in dark and light themes.
- [All-pane UI benchmark](web/benchmark/summary.md), with [coverage notes and component-family comparisons](web/benchmark/README.md).
- [Signed-out terminal and desktop smoke](terminal-report.md).

Each web sheet puts before on the left and after on the right, with rows ordered 13F, ERN, EVTS and HDS.

| Theme and width | Command search | Saved-pane restore |
| --- | --- | --- |
| Dark, 640 px | [Sheet](web/sheets/white-640-command.jpg) | [Sheet](web/sheets/white-640-restore.jpg) |
| Dark, 1280 px | [Sheet](web/sheets/white-1280-command.jpg) | [Sheet](web/sheets/white-1280-restore.jpg) |
| Light, 640 px | [Sheet](web/sheets/paper-640-command.jpg) | [Sheet](web/sheets/paper-640-restore.jpg) |
| Light, 1280 px | [Sheet](web/sheets/paper-1280-command.jpg) | [Sheet](web/sheets/paper-1280-restore.jpg) |

Original PNGs are retained under `web/before` and `web/after`. The conditional HDS account-wall capture is a simulated 401 response, not its normal signed-out state.
