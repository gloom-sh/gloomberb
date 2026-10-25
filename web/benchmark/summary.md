<!-- ui-benchmark -->
### UI blast radius: 36 of 562 views changed, 15 pictured on one side only

> [!WARNING]
> **3 views pictured on the base but not on the head:** 13F--detail, 13F--tab-events, 13F--tab-history. A view the change removed is meant; one the head failed to draw (a build without a plugin, a pane that did not open) is not, and the count leaves it out.
>
> **12 views pictured on the head only:** 13F--tab-crowding, ADR--tab-13f, ADR--tab-holders, ERN--root, EVTS--root, HDS--root, HDS--tab-13d-g, HDS--tab-chart, MOST--tab-13f, MOST--tab-holders, T--tab-13f, T--tab-holders.
>
> **Did not open on the head:** debug-log, TBO, VIEW, IBKR, PL, BR.
>
> Did not open on the base: BR, EVTS, debug-log, HDS, TBO, VIEW, IBKR, ERN, PL.

Base `4c11d3c99`, head `badc3ac62`: every function, bundled and registry plugin pane and shell view, Chromium, white theme, 640 and 1280px, pane bodies compared (the window's top and bottom 42px left out). Data: fixed offline responses on both sides, with one fixed clock and pinned registry plugins; no live market-data snapshot.

| View | 640px | 1280px |
|---|---:|---:|
| 13F--detail | base only | base only |
| 13F--tab-crowding | head only | head only |
| 13F--tab-events | base only | base only |
| 13F--tab-history | base only | base only |
| ADR--tab-13f | head only | head only |
| ADR--tab-holders | head only | head only |
| ERN--root | head only | head only |
| EVTS--root | head only | head only |
| HDS--root | head only | head only |
| HDS--tab-13d-g | head only | head only |
| HDS--tab-chart | head only | head only |
| MOST--tab-13f | head only | head only |
| MOST--tab-holders | head only | head only |
| T--tab-13f | head only | head only |
| T--tab-holders | head only | head only |
| HELP--root | 20.4% | 16.0% |
| 13F--root | 6.0% | 5.8% |
| command-bar | 2.2% | 1.1% |
| ADR--tab-hiring-momentum | 0.02% | 0.22% |
| MOST--tab-hiring-momentum | 0.02% | 0.22% |
| T--tab-hiring-momentum | 0.02% | 0.22% |
| ADR--tab-dividends | 0.01% | 0.18% |
| MOST--tab-dividends | 0.01% | 0.18% |
| T--tab-dividends | 0.01% | 0.18% |
| ADR--tab-tweets | 0.04% | 0.17% |
| MOST--tab-tweets | 0.04% | 0.17% |
| T--tab-tweets | 0.04% | 0.17% |
| ADR--tab-news | 0.10% | 0.16% |
| MOST--tab-news | 0.10% | 0.16% |
| T--tab-news | 0.10% | 0.16% |
| and 21 more | |

Left out of the count, unsteady (two pictures of the same code differ): ANR--root, CHOKE--root, OSA--detail, VIX--root, VIX--tab-cross-asset, VIX--tab-history, VOLS--root, VOLS--tab-history.

Sheets: see the accompanying blast-radius sheets and per-family comparison artifacts.

Coverage notes: the native CLI inventory also contains eight intentionally browser-omitted commands: `BR`, `ORD`, `NOTE`, `debug-log`, `VIEW`, `PL`, `MOST`, `TBO`. The registry command `IBKR` declares only CLI, terminal and desktop targets. Their attempts remain in the coverage metadata; zero-view results do not add pictures to the denominator. See [browser exclusions](browser-catalog-exclusions.json) and [requested/observed pane mismatches](observed-pane-mismatches.json). A fuzzy match does not establish coverage of the requested pane.

| Side | Command | Requested pane | Observed pane |
| --- | --- | --- | --- |
| before | 13F | thirteenf-funds | alerts |
| before | MOST | market-movers | ticker-research |
| before | NOTE | quick-notes | changelog |
| before | ORD | broker-orders | earnings-ripple |
| after | MOST | market-movers | ticker-research |
| after | NOTE | quick-notes | changelog |
| after | ORD | broker-orders | earnings-ripple |

Capture repairs: complete repeated ATS, ETF and SEC captures replace incomplete or incorrectly discovered initial attempts. The initial LAY detail records came from Enter closing the gallery; the single CFNG detail picture came from a root loading-to-error transition. These false detail outcomes remain explicitly unmeasured. The [repair ledger](capture-repairs/ledger.json) records every correction and hashes the preserved originals. All remaining normal view records have both required pictures and measurements.

A bounded paired VIX retry resolved the remaining error-detail variation: both revisions produced identical pictures at both widths for all three views. The [six original/repeated 640 px cross-asset pictures](repeat-pictures/vix-cross-asset-640/) preserve the evidence. Same-code timing variation is excluded only at views with complete repeat pictures and no stable difference at another width.
