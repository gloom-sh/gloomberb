# Treasury futures price notation evidence

Before: `11689928330b46831b657730e46538a26a5ab1bb` (`origin/main` at reproduction).
After: `425a893ae2920b8b64e97b80072124d428e72dc5`. Captures were made before the commit; the tested implementation matches this commit.

Each image stacks before above after at the stated viewport width. Both sides use the real web app with the same deterministic sample responses through the shared Gloom Cloud adapter. These are rendering fixtures, not live market observations. The sample quote `112.515625` should display as `112-16½`; values used in calculations remain decimal.

| View | 640 px | 1280 px |
|---|---|---|
| Continuous Treasury Overview | [Capture](captures/overview-continuous-640.png) | [Capture](captures/overview-continuous-1280.png) |
| Listed Treasury Overview | [Capture](captures/overview-listed-640.png) | [Capture](captures/overview-listed-1280.png) |
| Continuous Treasury chart and pointer crosshair | [Capture](captures/chart-continuous-640.png) | [Capture](captures/chart-continuous-1280.png) |
| Listed Treasury chart and pointer crosshair | [Capture](captures/chart-listed-640.png) | [Capture](captures/chart-listed-1280.png) |
| Realized-volatility price panel and crosshair | [Capture](captures/realized-volatility-640.png) | [Capture](captures/realized-volatility-1280.png) |
| Quote monitor, generics beside continuous and listed contracts | [Capture](captures/quotes-640.png) | [Capture](captures/quotes-1280.png) |
| Watchlist, all five Treasury roots | [Capture](captures/watchlist-640.png) | [Capture](captures/watchlist-1280.png) |
| Watchlist quick-add listed-contract price preview | [Capture](captures/quick-add-640.png) | [Capture](captures/quick-add-1280.png) |
| Search listing identity | [Capture](captures/search-640.png) | [Capture](captures/search-1280.png) |
| Search selection opens listed-contract Overview | [Capture](captures/search-selected-640.png) | [Capture](captures/search-selected-1280.png) |

Search result rows show identity and venue; the selected contract opens its Overview, which shows the shared price notation. The quick-add preview uses a listed contract; the existing continuous-symbol input filter is outside this formatting change.

All-pane benchmark and UI token results are included alongside these captures. The sweep includes catalog views, bundled and registry plugin panes, and shell views at 640 and 1280 px on the same kept data snapshot.

[All-pane benchmark and blast-radius sheet](benchmark/summary.md) · [UI tokens](benchmark/ui-tokens.md) · [Validation](validation.md)
