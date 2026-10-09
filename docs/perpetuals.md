# Perpetual markets

`PERP` opens per-market History and Evidence. An optional market or underlying selects contracts: `PERP BTC`, `PERP TSLA`, or `PERP hyperliquid:xyz:TSLA`. Without one it shows BTC. Stock descriptions (`DES`) and quote cards (`QQ`, when tall enough) link their matching stock perpetuals, showing mark, premium versus the underlying last price, interval-labelled funding, USD open interest and premium versus oracle.

Stock links follow the selected listing and only appear when its underlying identity is confirmed. The same ticker on another exchange may belong to another company. A linked cross-listing still uses the perpetual's own reference listing, currency and share units for its premium.

This is a **Pro dataset**. Free accounts receive a fixed preview of three markets per asset class and a latest-value stock/market preview. Full history, rankings and the complete universe require Pro. Trading and order routing belong to a separate plugin.

History offers paid funding, collected open interest, mark/oracle premium and hourly candles with 1D, 7D, 30D, 90D and 365D windows. The market field takes a base asset, underlying symbol or canonical market identity and shows the one market it names; it does not list partial matches. An unqualified symbol prefers its default crypto contract, then the xyz stock contract. Use the canonical identity for another contract or venue. A name no market carries shows the pane's empty state; `gloomberb fn PERP XYZZY` fails and suggests markets that work. Evidence keeps observation time, source time, units, confidence, contract constraints and correction records. `o` opens the primary source; `d`, `f`, `g` open the underlying description, financials and chart where mapped.

The full market board, rankings and comparison UI belong to the external perpetuals plugin. The built-in function focuses on one market's history and evidence, and can be opened independently. There is no plugin dependency. The backend board, rankings and comparison endpoints remain available for consumers.

`a` opens the existing event-alert form with the market prefilled. Choose funding per eight hours, 24h open-interest change, premium versus oracle, or closed-market premium, then an above/below threshold in percent. The alert uses the existing cloud rule synchronization, crossing, cooldown and delivery history. Delivery requires Pro. Delisted or stale contracts are excluded from rankings and alerts.

History keeps the same figures for every series: the series itself, its change over the range, the mark and open interest. When every point of a series shares one observation basis, the legend names it and the table leaves the column out. Evidence groups the market, funding, open interest, the listed underlying (for stock perpetuals) and the contract terms.

## Coverage and interpretation

The initial enabled venue is Hyperliquid: the default crypto perpetual universe plus every public HIP-3 dex returned by discovery, including stock, index, energy, metal and FX contracts. Classification is conservative; unclassified contracts retain their identity. Availability of a perpetual does not establish eligibility to trade it or ownership of its referenced asset. The venue name in Evidence identifies the contract's trading venue, not a routing data provider.

Adapters for Binance, Bybit, OKX, Deribit, Coinbase International, Kraken and dYdX are disabled by default pending venue terms and redistribution review. The comparison endpoint uses whatever venues the backend enables. A single row means only one comparable contract has been collected; it is not a cross-venue spread. Inverse, linear and quanto contracts and their collateral currencies remain distinct. Stablecoin quote currencies are not silently converted into fiat prices.

Funding rates are fractions in REST/JSON and percentages in the pane. Raw funding always carries its interval and current/last-paid/continuous basis. Eight-hour funding is `raw × 8 / intervalHours`. Simple APR is `raw × 24 × 365 / intervalHours`; neither measure compounds nor predicts future realized yield. Predicted funding remains separate and unavailable when not reported. History explicitly distinguishes source-paid funding from collected current-rate snapshots and normalizes each observation using its own interval.

Open interest is shown in base units and USD. The board's 1h/24h percentage changes compare **base open interest from Gloom's own snapshots**, so mark-price moves cannot manufacture an OI surge. A rolling five-minute OI baseline cache supports those 1h/24h comparisons independently of the retained history sampling tier. USD notional changes are separate JSON fields. A missing sufficient-age baseline remains null. Funding and candles backfill only history the API actually exposes; source hourly funding and candle records are retained separately at their actual timestamps. No historical OI is inferred from candles or fabricated before collection began.

Oracle premium is `mark / oracle - 1`. Underlying premiums use the mapped equity's separately dated last price, the contract price multiplier and compatible currencies. Closed-market premium appears only with a known closed or extended underlying session. A stale, missing or mismatched reference yields null. A perpetual mark can move while the underlying exchange is closed; its premium is not a forecast of the next opening price. The Evidence view states the underlying session and reference date.

Discovery and latest values refresh roughly once a minute. Retained history is sampled by USD open-interest rank within each venue, across its dexes: the top 10 markets every five minutes, the next 40 every 15 minutes, and the remainder hourly. Newly discovered markets are recorded immediately. Sampled detail is retained for 30 days, hourly buckets through 400 days, and daily buckets thereafter. Buckets retain their sample count and first/last observation times; chart values are last observations in each bucket, not averages. Source corrections supersede earlier records, preserving evidence. CSV headers name the series units: funding and premium values are percent, their changes are percentage points, open interest is USD, and prices retain the quote currency. JSON remains in fractions. Refreshes advance the lookback window; a result capped at 5,000 observations is marked incomplete, and a smaller range can be requested. Timestamps are UTC. Empty history means collection has not yet supplied that series; gaps are not zero values.

## CLI and REST

```sh
gloomberb fn PERP --json   # shows BTC and says so in data.metadata.notices
gloomberb fn PERP BTC --tab history --days 30 --json
gloomberb fn PERP TSLA --tab evidence --json
gloomberb shot PERP BTC --tab history --width 1280 --height 540 --output perps.png
```

The pane-function REST interface exposes the same headless bundle and options. Cloud dataset routes are `/cloud/perps/board`, `/history`, `/rankings`, `/compare?baseAsset=BTC`, `/market?marketId=...`, and `/equity/:symbol`. History takes `marketId`, ISO `from`/`to`, `resolution=auto|minute|hour|day`, and `limit`. The `minute` resolution returns retained sampled detail; it does not promise an observation every minute. JSON preserves canonical market identity, confidence, flags, source links, observation timestamps, raw rates and intervals, currencies, preview locks and correction provenance.
