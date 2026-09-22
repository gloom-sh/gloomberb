# Options monitor enrichment captures

Captured on 2026-09-22 from the Phase 3 OMON implementation, using live SPY:ARCA option chains and explicit daily price history through the shared market-data router.

| File | View | Capture time (UTC) |
| --- | --- | --- |
| [desktop-omon-spy-sep30-112.png](desktop-omon-spy-sep30-112.png) | Sep 30 expiry, 112-column desktop pane | 15:28:39 |
| [desktop-omon-spy-oct1-80.png](desktop-omon-spy-oct1-80.png) | Oct 1 expiry, 80-column desktop pane | 15:32:10 |
| [terminal-omon-spy-sep30-112.png](terminal-omon-spy-sep30-112.png) | Sep 30 expiry, 112-column Kitty terminal | 15:41:30 |

The Sep 30 capture shows an 8.92 USD ATM straddle and an 11.64 USD fitted one-sigma move. The 25-delta put-minus-call skew is unavailable because the observed strikes do not cover the requested delta. Its adjacent listed-expiry slope is -62.85 volatility points per year to Oct 1.

The Oct 1 capture shows a 9.47 USD ATM straddle, a 12.11 USD fitted one-sigma move, a +1.83 point 25-delta put-minus-call skew, and a +322.91 point annualized slope to Oct 2. The short adjacent interval makes the annualized slope numerically large. Summary labels and the selected expiry remain visible in the narrow desktop layout; the existing chain table scrolls horizontally.

HV30 is 9.7% in both views, calculated from daily closes rather than weekly financials snapshots. The ATM IV and fitted one-sigma move are distinct measures. The warning control remains available for the Treasury tenor boundary, parity quality and observed-strike coverage disclosures.

Both desktop captures were visually inspected and passed the screenshot evidence checks: usable, complete, and no semantic mismatch. Quotes are delayed observations and can change between captures. These are live-market captures, not fixture or failure-injection data.

The terminal capture uses the native OpenTUI renderer in Kitty and was visually inspected. Its observed chain is dated 15:24 UTC. Separate native runtime checks confirmed repeated OMON to OVDV to OMON expiry handoff, selected-tab visibility after resizing, actual mouse selection and navigation, warning disclosure, and stable summary geometry while rates or the adjacent expiry were unavailable. Failure injection was visibly labeled and is not included in this gallery.

These review assets belong only on the screenshots branch.
