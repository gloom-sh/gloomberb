# UI benchmark evidence

The official benchmark compares every discovered core command, bundled and registry plugin command, and shell view at 640 and 1280 px in the dark theme. It covers root views, depth-one detail views and root tabs. Additional component and hover crops are omitted. Focused captures in the parent directory also cover the light theme.

Both sides use fixed empty offline responses, one fixed clock and pinned registry plugin versions. This is a UI structure and state comparison, not a live market-data snapshot. The four restored functions are additionally captured with public data in the focused comparison.

`summary.md` and `sheets/` contain the official blast-radius report. `changes.json` lists every view and its per-width comparison. `catalog-coverage.json`, the catalog inventories and the complete view inventories record discovery coverage, including failed or unmeasured states. The repeated-run metadata identifies views whose paired images vary when the code is unchanged. Missing or failed repeat pictures are recorded as capture gaps and are not evidence of visual instability. `compare/` contains the official per-component-family comparison.

The audit sometimes logs an explicit `0 views` result without adding a view record. Scratch bookkeeping preserves that exact log line as a failed catalog attempt (`auditOutcome: zero-views`), without creating a measurement or picture. The benchmark denominator and change counts still come only from actual pictures.

The native CLI inventory includes eight intentionally browser-omitted commands, listed in `browser-catalog-exclusions.json`; the registry command IBKR also declares native targets only. They remain explicit unmeasured attempts when no pane opens. The command resolver can also choose a fuzzy match when a function is absent; its baseline 13F entry opened Alerts. View inventories preserve `observedPaneId`, and `observed-pane-mismatches.json` lists every requested/observed mismatch. Such pictures do not establish coverage of the requested pane. The focused before/after command and saved-layout captures demonstrate the missing functions directly.

The per-family comparison retains raw paired pixel differences. The headline in `summary.md` is the official count after repeated-run classification and lists one-sided views separately. Public repeat-comparison files are scoped to the 18 requested commands; unrequested catalog commands do not imply missing repeat pictures. `repeat-observations.json` records zero capture gaps among the moving views being assessed.

One unchanged TV tab uses a neutral label in the public metadata. This symmetric text-only redaction preserves all comparison counts; `publication-redactions.json` records the raw and published hashes. The repair ledger retains the original comparison hash and separately identifies its redacted public copy.
