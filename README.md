# Earnings industry filters: UI review

Base: `4c11d3c99f0849cda8e9a7f296272fc7d73d2a22`.
Head: `9a04f6db778bbe451c7811a5c57bea829102bd7d`.

The real Earnings pane was rendered with the desktop DOM host and shared components on both revisions. All market values and fund members in these captures are fixed fixtures. The browser made no production writes.

## Captures

Each sheet contains, at full resolution: the old Names menu, the grouped Names menu, the industry list, and the selected semiconductor fund result.

- [Dark, 640 px](sheets/earnings-white-640.jpg)
- [Dark, 1280 px](sheets/earnings-white-1280.jpg)
- [Light, 640 px](sheets/earnings-paper-640.jpg)
- [Light, 1280 px](sheets/earnings-paper-1280.jpg)

Original PNG captures are in `names/before` and `names/after`. The app's theme IDs are `white` (dark) and `paper` (light).

At all four configurations, the default Earnings pane is pixel-identical before and after (0 differing pixels at the benchmark's 2% colour tolerance). The Names menu changes as intended: personal lists, sectors, and industries have shared menu headings; the scrollable industry list shows all nine funds. Clicking Semiconductors (SOXX) requests its holdings and shows only the two fixture constituents, NVDA and AMD; other fixture companies disappear.

Both capture passes finished without runtime exceptions. `check:ui-tokens` passed all 32 targeted pane/control measurements, with no allowlist exceptions.

## Sweep scope

The broader browser sweep finished with complete root coverage and a partial deeper-state comparison. See the [all-pane comparison](broad-sweep.md) for measured changes, one-sided configurations and unstable exclusions. The four intended Names-menu configurations are reported separately from broad root stability.

The combined UI token audit passed: 597 measured views across 181 function and shell entries, with four existing allowlist matches.

The stock all-pane command was attempted. Its terminal catalog includes panes absent from the browser build, and its discovery fallback can label an unrelated pane as the requested function. Those misleading captures are excluded from the results.

The follow-up uses the same UI audit, view walker, token measurements, and pixel comparison, restricted to browser-registered panes and requiring the expected pane ID. It is configured to cover 168 supported function, bundled/registry plugin, and shell entries, at 640 and 1280 px in both themes. Data comes from one copied snapshot with clock `2026-10-21T14:17:46.038Z`, offline on both revisions. The 14 browser-omitted function entries are listed in [unsupported-functions.md](unsupported-functions.md). ERN/EVTS share the Earnings component above; the other twelve real desktop components have 96 additional root captures, with no missing panes or runtime exceptions. Their 48 before/after pairs show no layout changes (three images differ only by a 14-pixel blinking search caret). Their 48 token measurements also pass without allowlist exceptions.

## Supplemental desktop sheets

The 96 supplemental captures appear at their original resolution, before on the left and after on the right. Each sheet contains three panes.

| Theme / width | Sheets |
|---|---|
| Dark / 640 px | [1](sheets/desktop-white-640-01.jpg) · [2](sheets/desktop-white-640-02.jpg) · [3](sheets/desktop-white-640-03.jpg) · [4](sheets/desktop-white-640-04.jpg) |
| Dark / 1280 px | [1](sheets/desktop-white-1280-01.jpg) · [2](sheets/desktop-white-1280-02.jpg) · [3](sheets/desktop-white-1280-03.jpg) · [4](sheets/desktop-white-1280-04.jpg) |
| Light / 640 px | [1](sheets/desktop-paper-640-01.jpg) · [2](sheets/desktop-paper-640-02.jpg) · [3](sheets/desktop-paper-640-03.jpg) · [4](sheets/desktop-paper-640-04.jpg) |
| Light / 1280 px | [1](sheets/desktop-paper-1280-01.jpg) · [2](sheets/desktop-paper-1280-02.jpg) · [3](sheets/desktop-paper-1280-03.jpg) · [4](sheets/desktop-paper-1280-04.jpg) |

## Limits

For browser-omitted functions, desktop root captures supplement the sweep; native service integration and every deeper interaction are not covered. The Earnings fixture verifies rendering and interaction with fixture holdings and calendar responses, not the deployed holdings service. These captures do not verify native Windows rendering or WebKit.

## Existing error-content variation

The VIX Cross-asset view has a content-only difference at 640 px in light mode: the offline error names either VIX or VIX 9D. Geometry and controls match. The loader and pane are unchanged between revisions. A [controlled fixture](vix-error-order.json) reproduces both labels on both revisions by changing which failed history request finishes first; all 23 requests settle. This measured difference remains in the broad comparison count.

- [Dark, 640 px](sheets/vix-cross-asset-white-640.jpg)
- [Dark, 1280 px](sheets/vix-cross-asset-white-1280.jpg)
- [Light, 640 px](sheets/vix-cross-asset-paper-640.jpg)
- [Light, 1280 px](sheets/vix-cross-asset-paper-1280.jpg)

## Interaction checks

The pane-control suite passed 327/327 checks. The [drag and resize benchmark](pane-drag.md) failed absolute pointer-lag checks after its built-in ten-run comparison; its full result is retained separately from the visual comparison.
