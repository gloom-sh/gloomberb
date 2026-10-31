/**
 * Every chart a built-in pane draws, and whether its series is in the data
 * catalog. `series-inventory.test.ts` fails when a module starts drawing a
 * chart without an entry here, when an entry names a series nobody
 * registers, or when a built-in registers a series this list does not name,
 * so the audit cannot drift from the code.
 *
 * `series` lists catalog ids, with a trailing `*` for a prefix. A chart that
 * is not in the catalog says why:
 * - `not-a-time-series`: plotted against something other than dates (a
 *   curve by maturity, a surface, a treemap, strikes, a distribution).
 * - `derived`: a chart composer study draws it from catalog series
 *   (correlation, realized volatility, a spread between two tickers).
 * - `per-item`: one deal, trial, filing or model run, with no stable id to list.
 * - `account`: built from the user's own portfolio or inputs.
 * - `not-yet`: a dated series that could be registered and is not yet.
 */
type SeriesInventoryStatus =
  /** `runtime`: registered while the app runs (files, accounts), so none exist in a test. */
  | { series: readonly string[]; runtime?: true }
  | { notInCatalog: "not-a-time-series" | "derived" | "per-item" | "account" | "not-yet"; reason: string };

export type SeriesInventoryEntry = SeriesInventoryStatus & {
  /** The module's folder under `src/plugins/builtin`. */
  module: string;
  /** What the pane draws. */
  chart: string;
};

export const SERIES_INVENTORY: readonly SeriesInventoryEntry[] = [
  { module: "members", chart: "Index member A/D line and percentages above moving averages", notInCatalog: "not-yet", reason: "Daily fund breadth comes from the members endpoint; its series are not registered for the composer yet." },
  { module: "chart-composer", chart: "Any ticker field: price, volume, fundamentals, valuation multiples", series: ["field:*", "option:*"] },
  { module: "chart-composer", chart: "CSV files in the profile's series folder", series: ["user:*"], runtime: true },
  { module: "ticker-detail", chart: "Price history and the overview's sparklines", series: ["field:market.*"] },
  { module: "fear-greed", chart: "Fear & Greed index and its seven indicator charts, with their moving averages", series: ["fear-greed:*"] },
  { module: "volatility", chart: "VIX curve history, the 3M/30D ratio and the cross-asset volatility board", series: ["volatility:*", "fred:VIXCLS", "fred:VXVCLS"] },
  { module: "iv-history", chart: "A ticker's implied volatility by tenor", series: ["implied-vol:*"] },
  { module: "realized-vol", chart: "Realized volatility cone and rolling windows", notInCatalog: "derived", reason: "The composer's realized volatility study draws it from any price series." },
  { module: "vol-surface", chart: "Implied volatility surface by strike and expiry", notInCatalog: "not-a-time-series", reason: "A surface over strike and tenor." },
  { module: "options-positioning", chart: "Open interest and gamma by strike and expiry", notInCatalog: "not-a-time-series", reason: "Plotted by strike and expiry, not by date." },
  { module: "options-calculator", chart: "A linked option contract's daily premium", series: ["option:*"] },
  { module: "options-scenario", chart: "Option payoff by underlying price", notInCatalog: "not-a-time-series", reason: "A payoff curve over prices." },
  { module: "kelly-sizer", chart: "Position size against win rate", notInCatalog: "account", reason: "Drawn from the inputs typed into the sizer." },
  { module: "yield-curve", chart: "Treasury curve and each maturity's history", series: ["ust:*", "fred:T10Y2Y", "fred:T10Y3M", "fred:DFII*"] },
  { module: "yield-curve", chart: "Government curves for Germany, the UK, Japan, Canada and euro AAA", series: ["bond-yield:*"] },
  { module: "rate-path", chart: "Implied policy path by meeting", notInCatalog: "not-a-time-series", reason: "A path over future meetings; the rates it starts from are FRED series in the catalog." },
  { module: "money-markets", chart: "Money market rates, bill yields, liquidity and net liquidity", series: ["money-markets:*", "fred:SOFR", "fred:EFFR", "fred:IORB", "fred:OBFR", "fred:DTB*", "fred:RRPONTSYD", "fred:WDTGAL", "fred:WRESBAL", "fred:WALCL"] },
  { module: "central-bank-rates", chart: "Policy rate history for each central bank", series: ["policy-rate:*"] },
  { module: "econ", chart: "Release history of each economic calendar event", series: ["fred:*"] },
  { module: "econ-statistics", chart: "Inflation, labor and growth statistics with their ranges", series: ["fred:CPIAUCNS", "fred:CPILFENS", "fred:PCEPI", "fred:PCEPILFE", "fred:PPIFID", "fred:UNRATE", "fred:PAYEMS", "fred:ICSA", "fred:JTSJOL", "fred:GDPC1", "fred:INDPRO"] },
  { module: "cpi", chart: "CPI components, month on month and year on year", series: ["fred:CPI*", "fred:CUSR*"] },
  { module: "market-valuation", chart: "Whole-market valuation ratios against their history", series: ["market-valuation:*"] },
  { module: "credit-conditions", chart: "Corporate bond spreads by rating", series: ["fred:BAML*"] },
  { module: "credit-boards", chart: "Index CDS (CDX, iTraxx) and sovereign 5Y CDS", series: ["cdx:*", "sovereign-cds:*"] },
  { module: "cds", chart: "A company's 5Y CDS spread", series: ["cds:*"] },
  { module: "credit-documents", chart: "Principal due by year", notInCatalog: "not-a-time-series", reason: "A maturity schedule, not a history." },
  { module: "debt-maturities", chart: "A company's principal and the share due soon, across annual filings", series: ["debt-maturities:*"] },
  { module: "debt-maturities", chart: "A company's maturity wall", notInCatalog: "not-a-time-series", reason: "A schedule by maturity year from one filing; its total and near-term shares across filings are in the catalog." },
  { module: "doe", chart: "Weekly oil and gas inventories against their five-year range, and US retail gasoline and diesel prices", series: ["doe:*"] },
  { module: "cot", chart: "Net positioning by trader class, over the front-month price", series: ["cot:*"] },
  { module: "futures", chart: "Front-month futures board, charted from the board", series: ["fut:*"] },
  { module: "futures-curve", chart: "Futures curve by contract month", notInCatalog: "not-a-time-series", reason: "Plotted by delivery month; each front month is in the catalog as FUT:code." },
  { module: "crypto-board", chart: "Price sparklines for the large coins", series: ["crypto:*"] },
  { module: "crypto-board", chart: "Bitcoin network hash rate, difficulty, next retarget estimate and hashprice", series: ["bitcoin:*"] },
  { module: "perps", chart: "Perpetual funding, open interest, premium and long/short account share", series: ["perps:*"] },
  { module: "crypto-etf-flows", chart: "The running net flow of the US spot bitcoin or ether ETFs since launch", notInCatalog: "not-yet", reason: "Daily and dated: the running total and each fund's daily flow could be crypto ETF series, and none is registered for the composer yet." },
  { module: "perps", chart: "Perpetual mark price", notInCatalog: "not-yet", reason: "The pair's price is in the catalog; the perpetual's own mark price could be a crypto series." },
  { module: "treasury-daily", chart: "The Treasury General Account's daily closing balance", notInCatalog: "not-yet", reason: "Daily and dated, from the Daily Treasury Statement's operating cash balance table; the pane reads it with the day's cash lines, and none is registered for the composer yet." },
  { module: "primary-dealers", chart: "A primary dealer position's weekly net level, the sum of the release's series behind the row", notInCatalog: "not-yet", reason: "Weekly and dated, one series per row of the board; the pane reads each only when its row is selected, and none is registered for the composer yet." },
  { module: "short-interest", chart: "A ticker's short interest and days to cover", series: ["short-interest:*"] },
  { module: "short-volume", chart: "A ticker's daily short volume ratio", series: ["short-volume:*"] },
  { module: "scanner", chart: "Net options premium through the session, for the market or one ticker (FLOW's Tide)", notInCatalog: "per-item", reason: "One per ticker, filter set and session, summed on request from the recorded option prints." },
  { module: "social-mentions", chart: "A ticker's daily posts", series: ["social-mentions:*"] },
  { module: "jobs", chart: "A company's open job postings", series: ["jobs:*"] },
  { module: "attention", chart: "Research hours on a ticker, hour by hour", series: ["attention:*"] },
  { module: "company-attention", chart: "A company's weekly open roles and daily app attention score", series: ["hiring:*", "app-attention:*"] },
  { module: "gpu", chart: "GPU rental list index per model", series: ["gpu:*"] },
  { module: "gpu", chart: "GPU rental prices per provider listing", notInCatalog: "per-item", reason: "One provider listing each, listed by the server and changing without a release." },
  { module: "power", chart: "Interconnection queue capacity and project generation", notInCatalog: "per-item", reason: "Per project and per queue filter." },
  { module: "power", chart: "European day-ahead power price by country", series: ["day-ahead:*"] },
  { module: "power", chart: "EU carbon allowance (EUA) auction price", series: ["carbon:*"] },
  { module: "power", chart: "European gas storage by area: % full, TWh and net injection", series: ["gas-storage:*", "gas-storage-twh:*", "gas-injection:*"] },
  { module: "awards", chart: "A company's government award totals by period", series: ["awards:*"] },
  { module: "company-kpis", chart: "A company's reported operating metrics", notInCatalog: "per-item", reason: "Each company reports its own metrics, with no shared list to register." },
  { module: "supply-chain", chart: "The largest customer's share of a company's receivables at each period end", notInCatalog: "not-yet", reason: "A dated per-company series from filings that could be registered; it needs three disclosed period ends, so most tickers have none." },
  { module: "estimate-revisions", chart: "Consensus estimate for one fiscal period over time", notInCatalog: "per-item", reason: "One fiscal period of one company." },
  { module: "earnings", chart: "Implied and actual moves around past earnings", notInCatalog: "per-item", reason: "One bar per earnings event." },
  { module: "dividend-yield", chart: "A ticker's trailing 12-month cash dividends", series: ["dividends:*"] },
  { module: "pe-band", chart: "Price against P/E multiples", notInCatalog: "derived", reason: "The composer charts price and the P/E fields for any ticker." },
  { module: "research", chart: "Analyst price targets over price", notInCatalog: "per-item", reason: "Targets are dated events on one ticker." },
  { module: "catalysts", chart: "Clinical trial enrollment", notInCatalog: "per-item", reason: "One trial." },
  { module: "mna", chart: "Deal spread for one merger", notInCatalog: "per-item", reason: "One deal." },
  { module: "correlation", chart: "Rolling correlation of two tickers and the matrix", notInCatalog: "derived", reason: "The composer's correlation study draws it for any two series." },
  { module: "relative-rotation", chart: "Relative strength and momentum against a benchmark", notInCatalog: "derived", reason: "Built from two price series; the rotation plot is not dated." },
  { module: "seasonality", chart: "Average returns by month and weekday", notInCatalog: "not-a-time-series", reason: "Plotted by calendar month, not by date." },
  { module: "backtest", chart: "A strategy's equity curve", notInCatalog: "account", reason: "One run of the user's own strategy settings." },
  { module: "analytics", chart: "Portfolio value, drawdown and factor exposure", notInCatalog: "account", reason: "Built from the user's own portfolio; the factor legs are tickers in the catalog." },
  { module: "holders", chart: "Holders treemap", notInCatalog: "not-a-time-series", reason: "A treemap of one filing date." },
  { module: "market-heatmap", chart: "Market heat map", notInCatalog: "not-a-time-series", reason: "A treemap of today's moves." },
  { module: "buildout", chart: "TheBuildout's theme board", notInCatalog: "not-a-time-series", reason: "A treemap of the themes' market caps, coloured by their median 1Y return today." },
  { module: "portfolio-list", chart: "Portfolio treemap", notInCatalog: "not-a-time-series", reason: "A treemap of current positions." },
  { module: "world-venue-map", chart: "Chokepoint transits and the map's place series", series: ["geo:*"] },
];
