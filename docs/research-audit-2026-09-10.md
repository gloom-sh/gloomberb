# Investor research audit — 10 September 2026

This sweep used the production APIs, the browser terminal, a local browser build connected to production data, the CLI, and the OpenTUI app in an isolated tmux session. The work covers data correctness and research usability; it does not certify every instrument, entitlement, or broker workflow.

## Workflows exercised

| Researcher | Instruments and horizon | Checks |
| --- | --- | --- |
| Fundamental equity analyst | AAPL, TSM ADR, SHEL.L, VOD.L, SAP.DE, 7203.T; quarterly, annual, TTM | Statements, reporting currencies, period labels, margins, cash reconciliation, market cap, relative valuation, earnings |
| Global equity investor | US, UK, continental Europe, Japan, Hong Kong, Canada; daily through multi-year | Exact listing selection, saved symbol collisions, exchange aliases, currency units, world indices, price history |
| Tactical and derivatives researcher | AAPL options, VOD options, ES=F, 6J=F, JPY=X; intraday through one month | Contract identity, exchange-specific options availability, quote sessions, daily range/volume, futures/FX chart commands |
| Multi-asset allocator | SPY, BTC-USD, TLT, GLD; one month, one year, five years | Common trading dates, correlations, rolling windows, missing observations, crypto weekends |
| Macro researcher | Treasury curve, credit conditions, economic calendar/statistics; current releases through 20 years | Spread signs, release units, source actuals, holidays, frequency-aware transforms |
| Portfolio manager | Test portfolios in different display currencies; long, short, leveraged and derivative positions | FX failures, leverage, missing valuations, synthetic risk metrics, public-profile performance claims |

Browser interactions included search/command submission, equity overview and financial tabs, chart ranges, options chains and expiry controls. The native terminal was exercised with actual market data, including equity financials and the FX matrix. Portfolio edge cases and live-stream provider boundaries were tested with controlled fixtures; no orders or real account changes were made.

## Corrected findings

### Instrument identity and commands

- An explicit `VOD.L` query could select the punctuation-stripped `VODL` stock. Qualified queries now match the requested listing and retain exchange suffixes through provider routing.
- Opening a second exchange listing of a saved symbol could change the original holding's exchange/currency. The second listing now gets a distinct, stable identifier. Public/canonical ticker keys remain idempotent through persistence and lookup.
- The browser collision check also verifies cloud requests: saved `VOD:XLON` must request provider symbol `VOD` on `LSE`, while retaining the distinct saved key when results return.
- Futures and FX punctuation was rejected by chart composition. The chart parser now accepts `ES=F`, `6J=F`, `JPY=X`, `EURUSD=X` and slash-form FX pairs.
- The browser command resolver independently changed `GP ES=F` into an `ESF` equity. Market punctuation is now identity-sensitive throughout search; when a catalogue omits an explicit market symbol, only a matching, valid quote can establish the target. FX metadata retains the quote leg's currency.
- Space-separated comparison lists and inline CLI options could lose symbols. Both comma and whitespace lists work; `--range=1M` no longer consumes the following ticker.
- Options auto-centering was mistaken for manual scrolling. The shared table now distinguishes application-driven scrolling while preserving manual control, visible-quote updates and pagination.

### Quotes, history and currencies

- Delayed Yahoo quotes used a single minute's candle for the day's OHLCV. The backend now aggregates the regular session through the delayed cutoff and retains the correct prior close.
- A subsequent production check found that the final minute could omit a closing auction. The official previous-close snapshot now takes precedence for the matching session.
- Stale extended-session prices could override a newer regular session. Session selection now follows valid timestamps; premarket changes use the previous regular close.
- Provider changes could shift UK and South African prices by 100×. Quote/history normalization and Twelve streaming ticks resolve units from the appropriate source; uncertain streaming units do not overwrite a valid quote.
- Live NVDA trades could move below a lagging daily bar's low. Quote handling reconciles observed extrema within a regular session and guards against carrying them across dates, units or extended-hours sessions.
- History presets previously used observation counts as calendar periods. Bounds now represent calendar weeks/months/years, with exchange-local daily labels and inclusive explicit end dates.
- Missing FX silently became parity. Invalid conversions now remain unavailable, affected totals/risk sizing are guarded, and formatters show an em dash instead of a fabricated amount or `NaN`.
- Cloud history no longer infers a second subunit conversion from the exchange. The captured London chart used normalized GBP values but displayed them 100× too small; explicit subunit metadata is still honored.
- World index levels now use index points, including structured output. Inverse-yen FX pairs retain enough precision to be useful.

### Fundamentals and valuation

- Market cap was synthesized from the traded ADR price and ordinary shares. A live TSM comparison consequently showed roughly $11 trillion. Market cap now requires a provider-reported value; ADR ratios are not guessed.
- Statement reporting currencies now travel independently of trading currencies. Unknown or incompatible sources cannot silently relabel or merge monetary values. Cross-currency EV/revenue and FCF-yield calculations require compatible data; vendor-reported ratios also require verified compatible currency metadata. The recovered TSM provider summary contained an enterprise valuation far below its own market cap; its unverified EV/revenue is withheld rather than adjusted by guesswork.
- TTM cash balances were summed as if they were flows. In the captured AAPL example, opening cash changed from $163.092B to $36.269B and ending cash from $166.367B to $39.544B, reconciling the $3.275B net flow.
- TTM statements require consecutive compatible quarters. Balance-sheet snapshots use the latest period, average shares remain averages, and Q4 share derivation respects annual weighted averages.
- Statement and chart-derived fundamentals share these safeguards. Fiscal period headers include month and currency, quarterly growth is labeled QoQ, and EPS/revenue earnings currencies are separate.
- Zero-valued fundamentals render visibly, operating margin uses operating income, and long issuer names no longer overlap bid/ask data.
- A cold deployment exposed a provider-budget gate that skipped even cached statistics. Financials now consult the statistics cache/governor under a reduced budget; fresh AAPL and TSM values were verified after recovery.

### Cross-asset and portfolio analytics

- Stock/crypto returns were computed on different calendars before matching dates. Correlation now uses close-to-close returns between shared dates. In a frozen SPY/BTC sample the correction changed correlation from 0.453969 to 0.475871 across 249 intervals.
- Rolling correlations require the requested number of observations and disclose insufficient history. Numerical correlation stays within its valid bounds.
- Portfolio leverage now means gross market value divided by net liquidation; account fields share the display currency.
- Missing holdings valuations cannot silently publish subset-weighted portfolio risk. Unsupported shorts, derivatives, foreign-currency histories and leverage suppress the synthetic basket estimates.
- Sharpe/beta estimates disclose current weights, price returns and model assumptions. The public profile no longer presents the history of today's holdings as the investor's actual one-year account return.

### Macro data

- Economic calendar actuals are no longer filled with unrelated/latest FRED observations. Missing source actuals stay unavailable, including future releases.
- Treasury observations use the latest published value through holidays. The curve spread is labeled 10Y minus 2Y; the captured 4.80%/4.39% curve correctly shows +41 bp.
- Economic transforms match calendar periods rather than row offsets across gaps, and quarterly annualization uses four periods.

Provider semantics were checked against [Twelve statistics documentation](https://twelvedata.com/docs/fundamentals/statistics), [income statement documentation](https://twelvedata.com/docs/fundamentals/income-statement), [BLS CPI release conventions](https://www.bls.gov/news.release/cpi.htm), and [FRED's 10Y minus 2Y series](https://fred.stlouisfed.org/series/T10Y2Y).

## Validation and remaining coverage limits

The backend changes have 152 passing focused tests with 504 assertions, plus a server TypeScript check. The app passed 2,731 tests across 477 files in PR CI, all six runtime typechecks, the browser bundle audit, desktop view build, Cloudflare dry-run, core binary smoke test and global-upgrade smoke test. The final history-unit correction also passed all 23 cloud adapter tests. Browser and tmux checks supplement the automated tests.

The browser session used anonymous/delayed data. Live Pro entitlements and authenticated broker execution were not exercised. Provider coverage remains uneven: some foreign fundamentals and option chains are unavailable, and calendar sources can omit actuals. These gaps should be shown explicitly. All 19 world indices loaded in final CLI probes, and the three intermittently missing browser indices also succeeded through direct cloud cache/refresh probes.

Correlation aligns shared dates, not simultaneous exchange closing times. Basket risk estimates are not cash-flow-adjusted account performance. Actual account return calculation and broker performance feeds require separate validation with an authenticated test account.

Backend changes are tracked in [platform PR #220](https://github.com/vincelwt/gloomberb-platform/pull/220) [production follow-up #221](https://github.com/vincelwt/gloomberb-platform/pull/221), and [quote-range follow-up #222](https://github.com/vincelwt/gloomberb-platform/pull/222). The web terminal receives the merged frontend automatically. Installed CLI/desktop builds need the corresponding release to receive these client fixes, including normalized history handling. No GitHub release is created as part of this audit.
