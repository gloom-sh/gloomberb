# OVDV market screenshots

Observed option markets captured on 2026-09-22, from 14:12:37 to 14:18:33 UTC. All 24 images use the production OVDV pane and Gloomberb Cloud through the market-data router and shared options coordinator. The feed marks these chains delayed. The selected smile expiry is 2026-12-18.

| Ticker | Renderer | Surface | Smile | Term |
| --- | --- | --- | --- | --- |
| AAPL | Kitty terminal | [Surface](terminal-AAPL-surface.png) | [Smile](terminal-AAPL-smile.png) | [Term](terminal-AAPL-term.png) |
| AAPL | Desktop | [Surface](desktop-AAPL-surface.png) | [Smile](desktop-AAPL-smile.png) | [Term](desktop-AAPL-term.png) |
| SPY | Kitty terminal | [Surface](terminal-SPY-surface.png) | [Smile](terminal-SPY-smile.png) | [Term](terminal-SPY-term.png) |
| SPY | Desktop | [Surface](desktop-SPY-surface.png) | [Smile](desktop-SPY-smile.png) | [Term](desktop-SPY-term.png) |
| NVDA | Kitty terminal | [Surface](terminal-NVDA-surface.png) | [Smile](terminal-NVDA-smile.png) | [Term](terminal-NVDA-term.png) |
| NVDA | Desktop | [Surface](desktop-NVDA-surface.png) | [Smile](desktop-NVDA-smile.png) | [Term](desktop-NVDA-term.png) |
| TSLA | Kitty terminal | [Surface](terminal-TSLA-surface.png) | [Smile](terminal-TSLA-smile.png) | [Term](terminal-TSLA-term.png) |
| TSLA | Desktop | [Surface](desktop-TSLA-surface.png) | [Smile](desktop-TSLA-smile.png) | [Term](desktop-TSLA-term.png) |

Desktop images capture the Electrobun DOM renderer at 3200 x 1980 pixels. Terminal images capture the OpenTUI app in direct Kitty at 1600 x 1000 pixels, with real bitmap capability negotiation. Images retain the observed data and have not been retouched.

All images were visually inspected. All 12 desktop results passed semantic checks for the requested ticker, view, expiry and plotted data. The [capture manifest](capture-manifest.json) includes SHA256 hashes, precise capture times, spot and chain timestamps, rate dates, source filtering counts and verification details.

The initial 13:37 UTC data audit found zero or unusable bid/ask markets. By 14:08 UTC quotes had recovered; the subsequent audit loaded 18 expiry slices for each ticker without request failures. Short-tenor irregularities, rejected quotes and unsupported wing gaps remain visible. Treasury observations are dated 2026-09-18, and the shortest expiries use the published 1M boundary rate. These are point-in-time captures, not guarantees of provider coverage. See [methodology](../../../research-data.md#shared-volatility-calculations) and [usage](../../../usage.md).

Interaction checks covered keyboard rotation and zoom, mouse drag, wheel zoom, point selection, and the tmux table fallback. Fifteen six-tab cycles over 51 seconds showed stable RSS after startup allocation, with no application hook, update-depth or listener warnings. Every owned capture process and tmux session was stopped.
