# Perpetual markets

`PERP` opens perpetual analytics. An optional market or underlying selects contracts: `PERP BTC`, `PERP TSLA`, or `PERP hyperliquid:xyz:TSLA`. The same surface is the Perps tab in `CRYP`. Stock descriptions (`DES`) and quote cards (`QQ`, when tall enough) link their matching stock perpetuals, showing mark, premium versus the underlying last price and interval-labelled funding.

This is a **Pro dataset**. Free accounts receive a fixed preview of three markets per asset class and a latest-value stock/market preview. Full history, rankings and the complete universe require Pro. Trading and order routing belong to a separate plugin.

Board filters All, Stocks, Indices, Energy, Metals, FX and Crypto. Column headers sort; narrow panes prioritize eight-hour funding, USD open interest and oracle premium beside the market and mark. Wider panes add raw funding with its interval, APR, OI change, closed-market premium and volume; Evidence and JSON retain every field. Enter opens the selected contract's History. History offers paid funding, collected open interest, mark/oracle premium and hourly candles with 1D, 7D, 30D, 90D and 365D windows. Ranking screens cover both funding extremes, open-interest surges, oracle dislocations and closed-market dislocations. Compare groups the same base asset across contracts and venues, retaining quote and margin currencies and contract type. Evidence keeps observation time, source time, units, confidence, contract constraints and correction records. `o` opens the primary source; `d`, `f`, `g` open the underlying description, financials and chart where mapped.

`a` opens the existing event-alert form with the market prefilled. Choose funding per eight hours, 24h open-interest change, premium versus oracle, or closed-market premium, then an above/below threshold in percent. The alert uses the existing cloud rule synchronization, crossing, cooldown and delivery history. Delivery requires Pro. Delisted or stale contracts are excluded from rankings and alerts.

## Coverage and interpretation

The initial enabled venue is Hyperliquid: the default crypto perpetual universe plus every public HIP-3 dex returned by discovery, including stock, index, energy, metal and FX contracts. Classification is conservative; unclassified contracts remain available in All. Availability of a perpetual does not establish eligibility to trade it or ownership of its referenced asset. The venue name in Compare and Evidence identifies the contract's trading venue, not a routing data provider.

Adapters for Binance, Bybit, OKX, Deribit, Coinbase International, Kraken and dYdX are disabled by default pending venue terms and redistribution review. The comparison screen uses whatever venues the backend enables. A single row means only one comparable contract has been collected; it is not a cross-venue spread. Inverse, linear and quanto contracts and their collateral currencies remain distinct. Stablecoin quote currencies are not silently converted into fiat prices.

Funding rates are fractions in REST/JSON and percentages in the pane. Raw funding always carries its interval and current/last-paid/continuous basis. Eight-hour funding is `raw × 8 / intervalHours`. Simple APR is `raw × 24 × 365 / intervalHours`; neither measure compounds nor predicts future realized yield. Predicted funding remains separate and unavailable when not reported. History explicitly distinguishes source-paid funding from collected current-rate snapshots and normalizes each observation using its own interval.

Open interest is shown in base units and USD. The board's 1h/24h percentage changes compare **base open interest from Gloom's own snapshots**, so mark-price moves cannot manufacture an OI surge. USD notional changes are separate JSON fields. A missing sufficient-age baseline remains null. Funding and candles backfill only history the API actually exposes. No historical OI is inferred from candles or fabricated before collection began.

Oracle premium is `mark / oracle - 1`. Underlying premiums use the mapped equity's separately dated last price, the contract price multiplier and compatible currencies. Closed-market premium appears only with a known closed or extended underlying session. A stale, missing or mismatched reference yields null. A perpetual mark can move while the underlying exchange is closed; its premium is not a forecast of the next opening price. The Evidence view states the underlying session and reference date.

Own minute observations are compacted into hourly buckets after 30 days and daily buckets after 400 days. Buckets retain their sample count and first/last observation times; chart values are last observations in each bucket, not averages. Source corrections supersede earlier records, preserving evidence. Timestamps are UTC. Empty history means collection has not yet supplied that series; gaps are not zero values.

## CLI and REST

```sh
gloomberb fn PERP --json
gloomberb fn PERP TSLA --asset stocks --json
gloomberb fn PERP BTC --tab history --days 30 --json
gloomberb fn PERP --tab rankings --json
gloomberb fn PERP BTC --tab compare --json
gloomberb fn PERP TSLA --tab evidence --json
gloomberb fn CRYP --list perps --json
gloomberb shot PERP --tab board --width 1280 --height 540 --output perps.png
```

The pane-function REST interface exposes the same headless bundle and options. Cloud dataset routes are `/cloud/perps/board`, `/history`, `/rankings`, `/compare?baseAsset=BTC`, `/market?marketId=...`, and `/equity/:symbol`. History takes `marketId`, ISO `from`/`to`, `resolution=auto|minute|hour|day`, and `limit`. JSON preserves canonical market identity, confidence, flags, source links, observation timestamps, raw rates and intervals, currencies, preview locks and correction provenance.
