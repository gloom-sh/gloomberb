# All-pane comparison

Base `4c11d3c99f0849cda8e9a7f296272fc7d73d2a22`; head `9a04f6db778bbe451c7811a5c57bea829102bd7d`.

All 168 supported entries completed on both revisions: 160 pane/plugin entries and 8 shell entries. Every root has its 640 and 1280 px capture in dark and light. Both revisions use the same offline replay. Every recorded measurement has an image; the final dataset has no missing root configurations, duplicate measurements, or failed captures.

The deeper-state comparison is incomplete: seven non-root configurations occur on only one side. These belong to views that also vary between captures of the same revision:

| Available only | View | Theme | Width |
|---|---|---|---:|
| Before | HM--tab-main-portfolio | Dark | 640 |
| Before | HM--tab-us-etfs | Dark | 640 |
| After | CFNG--detail | Dark | 640 |
| After | CFNG--detail | Dark | 1280 |
| After | FXC--detail | Light | 1280 |
| After | FXC--detail | Dark | 640 |
| After | HN--detail | Light | 1280 |

| Theme | Total views | Changed views | Same-code unstable views excluded |
|---|---:|---:|---:|
| Dark | 517 | 0 | 15 |
| Light | 517 | 1 | 15 |

Totals include unstable views; changed counts exclude them.

The combined UI token audit passed: 597 measured views across 181 function and shell entries, with four existing allowlist matches. It includes the broad sweep, targeted Earnings controls and supplemental desktop components.

Incomplete comparison: the same 517 view IDs occur in both themes. Across both widths and themes, 1 of 517 views changed after excluding 15 unstable views from the changed count.

The final datasets contain 2060 before and 2063 after measurements. All seven one-sided configurations above belong to unstable views, and none is a root. Each side also has 72 state records skipped because they require a second navigation step, beyond the sweep's one-step depth, and 63 gated view IDs. Their IDs are retained in broad-sweep.json; these states do not establish deeper interaction coverage.

The intended Earnings Names-menu change is covered separately in all four width/theme configurations. The default Earnings root is pixel-identical in those four pairs. See the [Earnings capture sheets](README.md#captures).

The broad comparison retains the existing VIX error-content variation at light 640 px. Its geometry and controls are unchanged. A [controlled fixture](vix-error-order.json) reproduces both labels on both revisions by reversing which failed request finishes first. The [four before/after sheets](README.md#existing-error-content-variation) preserve that result.

Views excluded as unstable changed when the same revision was captured again. Repeated instances were checked for matching routing, settings and bindings; new repeats were pinned to their original instances. Their names and the complete entry-level coverage are in [broad-sweep.json](broad-sweep.json). The benchmark compares pane bodies, omitting the top and bottom 42 px, with 2% colour tolerance and a 0.05% changed-pixel threshold.

Capture setup was corrected on both sides for Gas Storage routing, the empty custom chart, the default watchlist and the unconfigured broker console. Original attempts are retained. Three transient capture failures recovered after the requested pane body became ready. All four corrected entries have complete matching root configurations.

The browser-omitted functions are covered by the existing [supplemental desktop sheets](README.md#supplemental-desktop-sheets) and Earnings captures. These verify the shared Earnings component; the EVTS command itself was not separately opened. Signed-out/offline captures do not verify live broker connections or every deeper interaction. TV channel 3 images are not republished; their measurements remain in these totals.
