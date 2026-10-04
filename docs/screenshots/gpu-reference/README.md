# GPU reference-index screenshots

Captured from this change on 2026-10-04, based on merged History change #1342. No production requests, merge or deployment.

The loopback API replay combines recorded provider observations from backend #668 with **509 real anonymous reference readings across 12 series**. Reference A has 92 daily values per series (2026-07-04 through 2026-10-03); Reference B has seven values per series (2026-09-28 through 2026-10-04). Backend #670 retains private evidence; only anonymised public projections reach this repo. Numbers are not transformed. History selects Reference A H100 SXM; muted A/B colours distinguish the third-party comparisons. The wide chart legend and narrow chart strip retain third-party/anonymised attribution.

Desktop captures use the repository's shared desktop pane screenshot renderer with a local replay and no external market-data bridge. The default 2x device scale means the PNG pixel dimensions are twice the logical size in the table. Terminal captures are rasterizations of real styled OpenTUI frame spans, including braille cells, not a separate UI implementation. Each tab/size was visually inspected. A real tmux smoke then exercised selection and refresh against the same replay, with no hook/update-depth/listener warnings. All profiles are under `~/.cache/gloom-smoke/gpu-reference`, and tmux was stopped.

| Tab | Desktop 1280x540 | Desktop 720x360 | Terminal 1280x540 | Terminal 720x360 |
| --- | --- | --- | --- | --- |
| Board | [PNG](desktop-board-1280x540.png) | [PNG](desktop-board-720x360.png) | [PNG](terminal-board-1280x540.png) | [PNG](terminal-board-720x360.png) |
| History | [PNG](desktop-history-1280x540.png) | [PNG](desktop-history-720x360.png) | [PNG](terminal-history-1280x540.png) | [PNG](terminal-history-720x360.png) |
| Changes | [PNG](desktop-changes-1280x540.png) | [PNG](desktop-changes-720x360.png) | [PNG](terminal-changes-1280x540.png) | [PNG](terminal-changes-720x360.png) |
| Equities | [PNG](desktop-equities-1280x540.png) | [PNG](desktop-equities-720x360.png) | [PNG](terminal-equities-1280x540.png) | [PNG](terminal-equities-720x360.png) |

## Limits and checks

- Provider rows and Changes are recorded data. No new provider history is fabricated for this reference change.
- Equity quotes/daily closes are intentionally unavailable in this replay; figures remain blank and the warning is shown. Equity price accuracy is outside this change's audit.
- The terminal captures run under the required 12 GB virtual-memory limit, separately per tab after a native Bun crash in a multi-tab batch. Isolated captures pass. Chromium image generation uses a bounded timeout outside the test process because Chromium's address-space reservation cannot start under that virtual-memory cap.
- This short smoke does not establish long-horizon memory stability.
- Focused GPU/shared chart-table tests, full typecheck, Knip, manifest and proxy-host checks pass. Headless History retains reference provenance, exact published values and null supplier URLs.
