# Research data conventions

[User guide](usage.md) · [Price comparisons](price-comparisons.md) · [Economic statistics](economics-reference.md) · [Market valuation](valuation-reference.md)

This reference describes how the terminal calculates and labels research data. Pane bodies show the data and current failures; recurring methodology belongs here. Headless reports and shared chart metadata retain source details and limitations.

## Charts, comparisons, and correlations

Normalized price charts show closing-price returns in each listing's currency. They exclude cash distributions, reinvestment, and FX conversion. They are not total-return or investor-currency performance charts.

Daily, weekly, and monthly comparisons use shared calendar dates, with each market retaining its source timestamps. Intraday comparisons require exact shared timestamps. Exchange closing times may differ; weekly and monthly bars can cover a partial period. See [comparison alignment and baselines](price-comparisons.md).

Correlation and relationship views calculate close-to-close returns between shared observations. Missing dates are not filled to manufacture a sample. Returns use local prices without currency conversion; different exchanges can close at different times. Correlation requires enough shared returns and nonzero variance.

Relationship graph controls stay in the footer: `t` cycles the time range, `p` cycles the rolling observation window, `c` toggles correlation, and `f` toggles the fit line. Each action is clickable and shows its current state. In narrow panes, `+` means enabled and `−` means disabled.

Contradictory OHLC bars are unavailable rather than silently repaired. Charts leave gaps and dependent risk calculations can be unavailable. These are current data problems and remain visible in the terminal.

Chart controls: select ranges and intervals above the plot; click a legend entry to hide or restore a series; use **+ add series** to add one. In a narrow legend, scroll over the row or use `[` / `]` to reveal each series; Space toggles the selected series. The existing footer offers **Series**, **Indicators**, **Formulas**, and **Share**, also available with `s`, `i`, `f`, and `y`. `t` opens the interval picker. Sharing publishes a chart snapshot; pane sharing is available from the pane menu.

## Financial statements and valuation

Statements are the latest available source snapshots and may include restatements. Historical as-of values are not reconstructed. A period end identifies the reporting period, not necessarily when every metric became public.

Financial table headers retain reporting currencies and date-source markers: **P** means a provider period date, which may be approximate; **S** means a SEC-corroborated fiscal date. Filing evidence identifies the period without establishing a publication date for every metric. Mixed or missing reporting currencies are not silently converted.

Overview monetary fundamentals show **(ccy?)** when their aggregate currency is missing. The reported amounts remain unchanged; neither the listing currency nor statement currency establishes their units. Explicit minor units such as GBp remain attached to the original amounts, including EPS.

Chart-derived P/E, price/sales, EV/sales, EV/EBITDA and price/free-cash-flow require compatible price and statement currencies. A statement's own currency takes precedence; aggregate reporting currency fills missing row metadata only when the other statements do not contradict it. Explicit minor units such as GBp/GBX convert to GBP without an FX assumption. Foreign or unknown currency pairs remain unavailable with a chart and export warning. Separately converted summary fundamentals do not establish historical statement units, and this conversion does not change provider share or depositary-receipt bases.

These derived multiples omit the Current observation when its quote is explicitly stale or has an invalid price or timestamp; valid historical ratios remain available. Historical calculations select the latest source price at or before the statement's availability date, then validate it. An invalid selected price leaves a gap instead of borrowing an older close. Contradictory OHLC values and rejected quote inputs remain in export diagnostics, and affected exports are marked incomplete. A quote's regular-session high/low does not constrain a valid after-hours price.

Current multiples use the latest available reporting period before evaluating the ratio. A loss, missing denominator, or incompatible currency cannot substitute an older profitable period. Automatic period selection uses TTM input coverage rather than whether the resulting ratio is meaningful; known nonpositive TTM earnings do not trigger an annual fallback. Valid historical ratios retain their original reporting dates.

SEC EPS uses corroborated split-adjusted share bases. Unverified bases are unavailable. Nonpositive P/E values display as **N/M** and are excluded from meaningful P/E rankings.

Market capitalization can come from a financial snapshot when a current quote does not supply it. Its retrieval time is not its valuation date. Source and freshness details remain attached to the affected value; market-cap comparisons require a valid currency conversion.

Relative Valuation excludes explicitly stale quote prices, changes, and quote market caps from comparisons. Its exports retain the original quote, source timestamp and stale status, and identify incomplete output. Separately reported fundamentals and fallback market caps retain their own source and retrieval time; these are not dated by the rejected quote.

Bank capital metrics and REIT FFO/AFFO depend on source coverage. Operating cash flow is not a substitute for FFO/AFFO. Missing measures are identified in the financial view.

## Treasury curve

GC plots constant-maturity Treasury yields against elapsed maturity, with month/year axis and cursor labels. The table retains each tenor's published observation date. The 10Y−2Y spread is measured in basis points; a negative value indicates inversion. Missing tenors remain unavailable, and a curve requires matching dates.

Use the existing Date footer action (`d`) to enter an as-of date, then Enter or View to submit. Latest (`l`) returns to the latest published curve. A holiday or weekend request uses the latest preceding published session within the lookup window; the requested date and observation date remain distinct. Refresh time is not the observation date.

## Portfolio analytics

P&L for manual portfolios covers current holdings. Manual portfolios have no cash-flow performance history; reconcile corporate actions through **PF → Set position**. Distributions are not automatically credited.

Sector weights use gross position values and exclude cash. Fund constituents and ETF overlap are not available; funds are grouped separately. Missing position prices or FX prevent complete weights.

Sharpe and beta are estimates for a basket of current holdings and weights, rather than a reconstruction of historical account performance. They use price returns and exclude cash, fees, distributions and historical trades. Sharpe assumes a fixed 5% annual risk-free rate and 252 trading sessions per year; beta uses SPY as the benchmark. They require usable price histories; a contradictory holding history suppresses the basket estimates. An invalid benchmark history suppresses beta independently of Sharpe.

Broker account-value history includes deposits and withdrawals. Investment returns require cash-flow adjustments. Broker-reported return series may not specify their calculation method. Currency values and percentage returns retain distinct axis labels; missing observations and cached data remain identified in the UI.

## Dividends and sectors

Dividend cash yield excludes taxes and reinvestment. SEC yield, tax components, and future payments are not modeled. Forward yield is an estimate rather than a guaranteed distribution. Dividend amounts and reference prices must use compatible listing currencies and units.

TTM cash/share sums reported cash with ex-dates within the trailing calendar year. The chart changes on ex-dates and when earlier payments leave that window, holding each level between changes. Cash growth compares complete trailing-year windows; a positive baseline followed by no cash gives −100%, while a zero or incomplete baseline has no defined growth rate. Special distributions remain part of reported cash.

Sector and industry ETF returns are price returns in the listing currency, without reinvested distributions. Rankings use a shared ending session and calendar-month/year boundaries, using a prior close for holidays. Missing or inconsistent endpoints remain unavailable. A successful refresh does not make an old quote current.

## FX matrix

One unit of the row currency buys the amount in the column currency. Indicative cross rates are calculated through USD legs, whose observation times can differ. Missing, stale, or unknown observation times appear as current status.

## Credit spreads

CRD shows daily closing option-adjusted spreads for the ICE BofA US Corporate (US IG), US High Yield (US HY), and AAA, AA, A, and BBB US Corporate indices from FRED. Source percentages are converted to basis points; 1D is the change from the previous available observation. These are spreads, not bond yields.

Each series keeps its own observation date. A shared date appears in the footer when all displayed observations agree; otherwise an AS OF column identifies each row's date. Refresh time does not change an observation date. Headless reports retain each FRED series identifier, title, units, frequency, and date.

## Options

OVME uses a European-exercise Black–Scholes model. It does not model early exercise or discrete dividends. Theta is per day; vega is per volatility percentage point; rho is per rate percentage point. The UI keeps these units beside their values.

OMON HV30 is the annualized sample standard deviation of 30 daily log returns from 31 distinct reported observations, using 252 trading days per year. A later correction replaces the same timestamp. Missing or nonpositive closes and contradictory OHLC inside that window make HV30 and IV/HV unavailable; they are not skipped to bridge a return. A quote explicitly marked stale cannot seed underlying-dependent Greeks, ATM selection, or the calculator. Contract quotes remain visible with their own timestamps.

OVME values are per underlying unit, not a position or contract total. Rates and continuous dividend yield are entered in percent; time uses calendar days, retaining fractional days. A chain expiry date is seeded at 16:00 New York with historical daylight-saving offsets. Verify and edit the time for other settlement schedules or early closes, especially index options. The calculator does not resolve adjusted deliverables or contract multipliers, model multi-leg payoffs, or compute assignment outcomes.

A calculator opened from a chain uses a saved contract observation. Its quote and last-trade timestamps are separate; neither makes a saved quote executable. The market reference identifies midpoint, last, or manual input. Crossed or one-sided quotes do not supply a valid midpoint.

## Earnings and corporate actions

Event EPS and consensus can use an unspecified accounting basis, while TTM values come from statements. Fiscal period ends are not announcement dates. Open an event row for its source inputs and dates.

Consensus estimates are forecasts for the stated fiscal period. The provider's prior-year input can itself be an estimate; it does not establish a reported result. Fetched timestamps identify retrieval, not when consensus was revised. Filing evidence corroborates a fiscal period without verifying every reported metric.

Split-feed factors may include spinoff price adjustments. Merger terms, spinoff distributions, and security conversions are not covered. Source failures and unavailable event data remain visible rather than appearing as an empty event calendar.

## Earnings estimate comparisons

ERN groups and displays announcement dates on the same UTC calendar day. Exact call times, when supplied without a market-session label, use your local time. EPS 30D is the current estimate minus the estimate from thirty days earlier; a seven-day observation cannot fill a missing thirty-day value. REV 30D shows upward/downward revision counts over that same thirty-day window. An unknown count remains unavailable rather than becoming zero, and a directional color requires both counts. The CLI retains separately named seven-day and thirty-day source fields.

EPS and revenue retain their own explicit forecast currencies; neither inherits the listing currency or the other's currency. A `?` currency is unknown. Explicit minor-unit codes such as GBp/GBX normalize once to GBP; no exchange-rate or ADR conversion is inferred. EPS 30D requires both values to have the same known currency and forecast period. EST END is the provider's fiscal-period end when the available estimates agree, distinct from the announcement date; an unspecified or mixed period remains unavailable. Scroll horizontally to reach the remaining estimate columns in a narrow pane.

Calendar fallback values keep their own unknown currency and fiscal period. Trend-only ranges, growth, counts, and revisions are withheld from the displayed fallback's context; range endpoints from incompatible sources are not combined. The CLI's `estimateBasis` records each selected field's source, period, explicit currency code, and original `sourceValue`. `sourceEstimates` preserves all source-selected values after minor-unit normalization, including values withheld from the comparable top-level fields.
