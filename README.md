# Linear: GLO-667 chart verification

Product head: a5aaeed43488f846d8cdf43097abe099108259b8
Reproduction baseline: 060ab828879dd6d515f2abf96a892ae5eaf9f90d (current main when work began). Rebased on 6261f25e9 before the final checks; those intervening changes did not touch charts.

## Focused synthetic checks

- Before: 48 desktop pointer scenarios failed because no per-series value tags existed.
- After: 112/112 pointer scenarios passed, plus the real chart-composer keyboard/pointer readout check.
- Desktop and browser hosts, 640/1280 px, dark white/light paper themes, docked/floating, two/three series, percent, left/right units, carried/missing observations, stacked volume/RSI, and six tags in short panes. Pointer-height changes, leaving the plot and rapid resize are checked.
- Values are compared with scene observations and shared formatting. Exact-value anchors and unobstructed badge centres are compared with projection heights. Collision leaders retain the exact height while displaced badges stay readable. Missing values are not invented.
- 406 focused unit/integration tests passed, including the desktop capability profile with enableCapabilityHandlers false, price formatting and market valuation.
- Terminal readout logic is unchanged. No terminal smoke was needed for this DOM-only change.

## App-wide comparison

The offline survey attempted all 160 catalog/bundled-plugin entries and their visible tabs: 1,688 frames before and 1,688 after, at 640/1280 in both themes. Every external data request was refused. This covers chrome, forms, empty/error and signed-out states, not populated data for every pane. Unsupported web functions can show the empty workspace; aliases can share a root. Two bundled external plugins are included. Registry-only extensions were not installed.

There were four changed frames above a 16-channel pixel threshold: GE and CMP loading text (360 and 229 pixels), and COT and FUT tab hover/focus (92 and 75 pixels). The largest difference is 0.071% of a frame. These are timing/input noise, not chart changes. Other captured frames are identical at that threshold.

The neighbour sheets put the synthetic chart next to the real shared article reader, synthetic table, Options Calculator form, and the bundled Polls plugin populated with invented polls. The plugin's static trend chart remains static because that caller explicitly disables interaction. Reader body type and chart/metadata type retain their existing role distinction; controls, spacing and chrome are unchanged. The new labels inherit the shared axis typography and each plotted series colour.

## Limits

Not checked: native macOS app/WebKit chart rendering, signed-in/Pro data states, populated live data across every function, or registry-only/native extensions. No production data, accounts or subscriptions were changed. The PR stays draft until checks are green.

All images here use invented observations or the offline signed-out app. `sheets.json` maps every contact-sheet tile to its capture name.
