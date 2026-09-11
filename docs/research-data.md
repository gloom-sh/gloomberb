# Research data conventions

[User guide](usage.md) · [Price comparisons](price-comparisons.md)

This reference describes how the terminal calculates and labels research data. Pane bodies show the data and current failures; recurring methodology belongs here. Headless reports and shared chart metadata retain source details and limitations.

## Charts, comparisons, and correlations

Normalized price charts show closing-price returns in each listing's currency. They exclude cash distributions, reinvestment, and FX conversion. They are not total-return or investor-currency performance charts.

Daily, weekly, and monthly comparisons use shared calendar dates, with each market retaining its source timestamps. Intraday comparisons require exact shared timestamps. Exchange closing times may differ; weekly and monthly bars can cover a partial period. See [comparison alignment and baselines](price-comparisons.md).

Correlation and relationship views calculate close-to-close returns between shared observations. Missing dates are not filled to manufacture a sample. Returns use local prices without currency conversion; different exchanges can close at different times. Correlation requires enough shared returns and nonzero variance.

Contradictory OHLC bars are unavailable rather than silently repaired. Charts leave gaps and dependent risk calculations can be unavailable. These are current data problems and remain visible in the terminal.

Chart controls: select ranges and intervals above the plot; click a legend entry to hide or restore a series; use **+ add series** to add one. The existing footer offers **Series**, **Indicators**, **Formulas**, and **Share**, also available with `s`, `i`, `f`, and `y`. `t` opens the interval picker. Sharing publishes a chart snapshot; pane sharing is available from the pane menu.

## Financial statements and valuation

Statements are the latest available source snapshots and may include restatements. Historical as-of values are not reconstructed. A period end identifies the reporting period, not necessarily when every metric became public.

Financial table headers retain reporting currencies and date-source markers: **P** means a provider period date, which may be approximate; **S** means a SEC-corroborated fiscal date. Filing evidence identifies the period without establishing a publication date for every metric. Mixed or missing reporting currencies are not silently converted.

SEC EPS uses corroborated split-adjusted share bases. Unverified bases are unavailable. Nonpositive P/E values display as **N/M** and are excluded from meaningful P/E rankings.

Market capitalization can come from a financial snapshot when a current quote does not supply it. Its retrieval time is not its valuation date. Source and freshness details remain attached to the affected value; market-cap comparisons require a valid currency conversion.

Bank capital metrics and REIT FFO/AFFO depend on source coverage. Operating cash flow is not a substitute for FFO/AFFO. Missing measures are identified in the financial view.

## Portfolio analytics

P&L for manual portfolios covers current holdings. Manual portfolios have no cash-flow performance history; reconcile corporate actions through **PF → Set position**. Distributions are not automatically credited.

Sector weights use gross position values and exclude cash. Fund constituents and ETF overlap are not available; funds are grouped separately. Missing position prices or FX prevent complete weights.

Sharpe and beta are estimates for a basket of current holdings and weights, rather than a reconstruction of historical account performance. They require usable price histories; a contradictory holding history suppresses the basket estimates. An invalid benchmark history suppresses beta independently of Sharpe.

Broker account-value history includes deposits and withdrawals. Investment returns require cash-flow adjustments. Broker-reported return series may not specify their calculation method. Currency values and percentage returns retain distinct axis labels; missing observations and cached data remain identified in the UI.

## Dividends and sectors

Dividend cash yield excludes taxes and reinvestment. SEC yield, tax components, and future payments are not modeled. Forward yield is an estimate rather than a guaranteed distribution. Dividend amounts and reference prices must use compatible listing currencies and units.

TTM cash/share sums reported cash with ex-dates within the trailing calendar year. The chart changes on ex-dates and when earlier payments leave that window, holding each level between changes. Cash growth compares complete trailing-year windows; a positive baseline followed by no cash gives −100%, while a zero or incomplete baseline has no defined growth rate. Special distributions remain part of reported cash.

Sector and industry ETF returns are price returns in the listing currency, without reinvested distributions. Rankings use a shared ending session and calendar-month/year boundaries, using a prior close for holidays. Missing or inconsistent endpoints remain unavailable. A successful refresh does not make an old quote current.

## FX matrix

One unit of the row currency buys the amount in the column currency. Indicative cross rates are calculated through USD legs, whose observation times can differ. Missing, stale, or unknown observation times appear as current status.

## Options

OVME uses a European-exercise Black–Scholes model. It does not model early exercise or discrete dividends. Theta is per day; vega is per volatility percentage point; rho is per rate percentage point. The UI keeps these units beside their values.

A calculator opened from a chain uses a saved contract observation. Its quote and last-trade timestamps are separate; neither makes a saved quote executable. The market reference identifies midpoint, last, or manual input. Crossed or one-sided quotes do not supply a valid midpoint.

## Earnings and corporate actions

Event EPS and consensus can use an unspecified accounting basis, while TTM values come from statements. Fiscal period ends are not announcement dates. Open an event row for its source inputs and dates.

Split-feed factors may include spinoff price adjustments. Merger terms, spinoff distributions, and security conversions are not covered. Source failures and unavailable event data remain visible rather than appearing as an empty event calendar.
