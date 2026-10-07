# GPU history evidence

Captured on 2026-10-04. Before: `c4c162ee0c4bc5da37f08a4edfd3ab2a029b6ab1`. After: this change. Both use the same dated data through a local replay of the service/store API output from [the companion backend change](https://github.com/vincelwt/gloomberb-platform/pull/668). No production requests were made for these captures.

The replay contains 359 official AWS historical observations from 46 monthly versions (January 2023 through September 2026), 97 previously captured live observations, 11 Azure effective-date metadata records, and four price-change events. Only permitted provider rows are included. The selected A100 view shows two of those events. The A100 40GB history starts on 2023-01-04 and ends at the last captured live observation on 2026-10-03.

Every tab was inspected at both sizes with both renderers. Desktop images come from the shared desktop screenshot renderer. Terminal images are rasterizations of the real styled OpenTUI capture frames; an additional tmux run verified navigation and refresh.

| Tab | Renderer | Size | Before | After |
| --- | --- | --- | --- | --- |
| Board | Desktop | 1280x540 | [Before](before-desktop-board-1280x540.png) | [After](after-desktop-board-1280x540.png) |
| Board | Desktop | 720x360 | [Before](before-desktop-board-720x360.png) | [After](after-desktop-board-720x360.png) |
| Board | Terminal | 1280x540 | [Before](before-terminal-board-1280x540.png) | [After](after-terminal-board-1280x540.png) |
| Board | Terminal | 720x360 | [Before](before-terminal-board-720x360.png) | [After](after-terminal-board-720x360.png) |
| History | Desktop | 1280x540 | [Before](before-desktop-history-1280x540.png) | [After](after-desktop-history-1280x540.png) |
| History | Desktop | 720x360 | [Before](before-desktop-history-720x360.png) | [After](after-desktop-history-720x360.png) |
| History | Terminal | 1280x540 | [Before](before-terminal-history-1280x540.png) | [After](after-terminal-history-1280x540.png) |
| History | Terminal | 720x360 | [Before](before-terminal-history-720x360.png) | [After](after-terminal-history-720x360.png) |
| Changes | Desktop | 1280x540 | [Before](before-desktop-changes-1280x540.png) | [After](after-desktop-changes-1280x540.png) |
| Changes | Desktop | 720x360 | [Before](before-desktop-changes-720x360.png) | [After](after-desktop-changes-720x360.png) |
| Changes | Terminal | 1280x540 | [Before](before-terminal-changes-1280x540.png) | [After](after-terminal-changes-1280x540.png) |
| Changes | Terminal | 720x360 | [Before](before-terminal-changes-720x360.png) | [After](after-terminal-changes-720x360.png) |
| Equities | Desktop | 1280x540 | [Before](before-desktop-equities-1280x540.png) | [After](after-desktop-equities-1280x540.png) |
| Equities | Desktop | 720x360 | [Before](before-desktop-equities-720x360.png) | [After](after-desktop-equities-720x360.png) |
| Equities | Terminal | 1280x540 | [Before](before-terminal-equities-1280x540.png) | [After](after-terminal-equities-1280x540.png) |
| Equities | Terminal | 720x360 | [Before](before-terminal-equities-720x360.png) | [After](after-terminal-equities-720x360.png) |

The dated markers distinguish evidence points from the step segments between them. The chart starts at the first plotted observation, with bounded trailing padding. Historical records show their year and provenance, and the latest price period stops at the final observation. Changes use the observation date for observed history instead of backdating to effective-date metadata.

## Coverage limits

- No historical archive rows were recovered in this run, so the images do not demonstrate archive coloring. Regression tests cover archive markers, labels and evidence export.
- The monthly sample does not support the 1D, 7D or 30D comparison windows. They remain unavailable.
- Equity quotes were replayed from the prior recorded 2026-10-02 response. A complete daily series was unavailable, so 5D and 1M remain blank.
- The record columns show publication provenance; the full source and evidence URLs remain available in headless output.

## Validation

- 45 focused GPU and shared chart-table tests passed, with 158 assertions.
- Full typecheck, Knip, plugin manifest and web proxy allowlist checks passed.
- Headless History and Changes commands succeeded against the same local API replay and retained provenance and evidence URLs.
- The real tmux smoke covered tab navigation and refresh with no hook, update-depth or listener warnings.
- Local full-suite runs stopped on Bun native runtime crashes under the required 12 GB virtual-memory limit, including on the pinned Bun version. CI runs the full suite.
- The broad navigation and memory benchmarks could not complete against a replay that only serves GPU endpoints. The missing ECST and ticker responses are unrelated to the GPU history change.
