# UI benchmark

**0 of 490 views changed.** All four shards completed.

Base `23ee2cf78a94c40aa0b81f5d58e6159a44eb858e`; head `f3cb85fc5970b7918d3542eccf4278a90d602811`. The base is the pinned main revision used for the rebase.

| View | 640px | 1280px |
|---|---:|---:|
| command-bar | 0% | 0% |
| theme-picker | 0% | 0% |
| command-bar-search | 0% | 0% |

The inner text field measures 360px at a 640px window and 784px at a 1280px window on both revisions. The outer prompt and attached sheet frames remain 816px wide at 1280px. [The comparison sheet](restored-shells-sheet.jpg) shows the matching edges.

UI tokens passed: 2 values covered by the existing allowlist; 0 registry-plugin warnings. No token exceptions were added for this change.

## Coverage and limits

- Both sides use Bun 1.3.11, pinned Chromium 155.0.8059.39, the same offline replay, white theme, 640px and 1280px widths, and 800px height. Data-dependent authenticated states are not exhaustively covered.
- The sweep attempts the complete function catalog and shell views, root views, the detail opened by Enter, and root tabs at depth 1. Nested tabs beyond that depth and hover variants are outside this run.
- The lock contains 21 registry entries: 4 are now built in, 2 are bundled plugins, and 15 additional registry plugins were built. No plugin checkout failed.
- Denominator reconciliation: baseline has 547 view records but 490 pictured views. The 57 records without pictures are 56 nested-tab records skipped at depth 2 and `LAY--detail`: Enter activates a layout and closes the gallery, leaving no original pane to measure or photograph, although the harness lists a detail record. Head has 546 records and 489 pictured views with the same 57 nonpictured records. `CFNG--detail` was pictured only on the baseline and is excluded as unsteady. The union of pictured views is 490, the official denominator. All 57 nonpictured records and reasons are listed for each side in `summary.json`. These differ from catalog entries that returned no measurable root view at all.
- Head measurements: 489 views from 170 functions and shell views, 974 width measurements. Baseline: 490 views and 979 width measurements.
- Explicit failed opens: baseline none; head none. Stable views pictured on one side only: baseline-only none; head-only none. The baseline-only unstable detail is listed above.
- Pixel comparison errors: none.
- Catalog entries returning no measurable view: baseline `BR`, `ERN`, `EVTS`, `HDS`, `IBKR`, `PL`, `TBO`, `VIEW`, `debug-log`; head `BR`, `ERN`, `EVTS`, `HDS`, `IBKR`, `PL`, `TBO`, `VIEW`, `debug-log`.
- Head skipped/unmeasured tab records: 56. Reasons: 56 × revealed 2 presses deep; the sweep opens 1. Per-view metadata is in `summary.json`.
- 12 views were excluded from the changed-view decision because two captures of the same revision differed. The official denominator includes all pictured views. Excluded views: `VOLS--tab-curve`, `VOLS--root`, `FI--root`, `FI--tab-bonds`, `FI--tab-issuer-debt`, `FI--tab-treasury`, `GE--root`, `CFNG--detail`, `CHOKE--root`, `OSA--detail`, `VIX--root`, `VIX--tab-cross-asset`.
- Pixel comparison omits the window's top and bottom 42px. A view is counted as changed above 0.05% differing body pixels. The three shell comparisons above are exactly zero.

## Local recovery

One baseline invocation exited 143 before completion. Its remaining entries were resumed with the same clean pinned revision and unchanged web build; all 53 intended shard entries completed. Raw interrupted and resumed measurements were preserved. One partial SIV root measurement at 640px was duplicated by the complete redraw; the duplicate was removed by `(id, width, theme)`, keeping the completed redraw and its matching screenshot. No duplicate view IDs remain. This was an interrupted local invocation, not a failed pane.
