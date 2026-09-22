# Realized volatility captures

Captured on 2026-09-22 from the Phase 2 realized-volatility implementation.

| File | View | Capture time (UTC) |
| --- | --- | --- |
| [desktop-hvg-aapl.png](desktop-hvg-aapl.png) | AAPL history, close-to-close, 10/30/90 sessions, 1Y | 15:01:45 |
| [desktop-hvt-aapl.png](desktop-hvt-aapl.png) | AAPL cone, all seven windows, 2Y | 15:05:35 |
| [desktop-composer-aapl.png](desktop-composer-aapl.png) | AAPL price and daily RV30, 1Y | 15:09:18 |

Daily history came through the asset-data-router: 1,254 observations from 2021-09-22 through 2026-09-21. Current HV30 is 21.411771344191846%. The graph's separate current ATM IV point is 22.75%, a listed 24-day tenor observed at 2026-09-22 14:45 UTC from gloomberb-cloud. It is not historical IV.

All volatility values use 252-session annualization and display percentages once. Independent numeric checks covered all 35 estimator/window combinations within 1e-12; the 1Y and 2Y cone samples contain 251 and 500 observations respectively. All captures were visually inspected. The cone and composer screenshots passed the generic screenshot evidence check. The graph capture has no semantic mismatch, but its generic evidence check reports unusable because it does not classify these chart-only pixels; graph validation was visual and numeric.

Separate Kitty terminal validation showed live price while RV30 remains 21.411771344191845%, dated 2026-09-21. Changing the live quote does not add a closing observation to the daily volatility window. A restart retained a custom 60-session Yang-Zhang selection before the capture was reset to 30-session close-to-close.

These review assets belong only on the screenshots branch.
