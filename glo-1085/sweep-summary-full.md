<!-- ui-benchmark -->
### UI blast radius: 6 of 525 views changed

Base `c89a275ea`, head `9ed2eda43`: every function, bundled and registry plugin pane and shell view, Chromium, white theme, 640 and 1280px, pane bodies compared (the window's top and bottom 42px left out). Data: the week's kept snapshot, offline on both sides.

| View | 640px | 1280px |
|---|---:|---:|
| position-form | 27.6% | 13.9% |
| HALT--root | 16.1% | 19.4% |
| HALT--tab-resumed | 15.8% | 19.2% |
| HALT--detail | 7.3% | 9.4% |
| HALT--tab-long-term | 4.9% | 5.9% |
| HALT--tab-active | 2.3% | 2.4% |

Left out of the count, unsteady (two pictures of the same code differ): ADJ--tab-rates, GIP--root, JODI--tab-markets, OVDV--detail, OVDV--root, PF--tab-watchlist, POLL--detail, POLL--root, SIV--detail, SIV--root, SIV--tab-interest, TOP--root, TRACE--root, TRACE--tab-credit, TRACE--tab-issuer-debt, TRACE--tab-treasury, YAS--tab-cash-flows, YAS--tab-credit, YAS--tab-issuer-debt, YAS--tab-sensitivity, YAS--tab-treasury, new-portfolio-pane--tab-watchlist, new-watchlist-pane--tab-watchlist.

Sheets: /home/vince/.cache/gloom-smoke/glo-1085/bench2/sheets (1), /home/vince/.cache/gloom-smoke/glo-1085/bench2/compare/diff-sheets.
