/**
 * Heavy, realistic inputs for every Ask Gloom tool the app offers (the
 * headless pane functions): the largest 13F filers, long histories, broad
 * screens, many tickers at once, Hong Kong and mainland China listings.
 * `scripts/askg-tool-sweep.ts` runs them. A tool with no case here is listed
 * as unswept, so a new function gets one.
 */

export interface SweepCase {
  tool: string;
  args: Record<string, string | number | boolean | string[]>;
  /** The tool reads the seeded profile (portfolio or watchlist). */
  profile?: boolean;
  /** An answer of "no rows" or an error is right here, not a failure. */
  expect?: "empty" | "error";
}

/** A broad US basket, mega caps first, as a user pastes a list. */
const US_TICKERS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "BRK.B", "JPM",
  "LLY", "V", "XOM", "UNH", "MA", "COST", "HD", "PG", "NFLX", "JNJ",
];

/** Hong Kong, mainland China and other non-US listings, in the forms people type. */
const ASIA_TICKERS = ["0700.HK", "9988.HK", "1810.HK", "3690.HK", "1211.HK", "600519.SS", "BABA", "PDD", "TSM", "7203.T"];

/** The seeded watchlist and portfolio: 61 holdings across the US, Hong Kong, Tokyo, Taiwan and Europe, as a broker reports them. */
export const SWEEP_WATCHLIST_ID = "sweep-watchlist";
export const SWEEP_PORTFOLIO_ID = "sweep-portfolio";

export const SWEEP_POSITIONS: Array<{ symbol: string; exchange: string; currency: string; shares: number; avgCost: number }> = [
  ...[
    "NVDA:NASDAQ", "MSFT:NASDAQ", "AAPL:NASDAQ", "AMZN:NASDAQ", "GOOGL:NASDAQ", "META:NASDAQ", "AVGO:NASDAQ", "TSLA:NASDAQ",
    "LLY:NYSE", "JPM:NYSE", "V:NYSE", "UNH:NYSE", "XOM:NYSE", "MA:NYSE", "COST:NASDAQ", "HD:NYSE", "PG:NYSE", "JNJ:NYSE",
    "NFLX:NASDAQ", "CRM:NYSE", "AMD:NASDAQ", "ORCL:NYSE", "BAC:NYSE", "KO:NYSE", "ADBE:NASDAQ", "CVX:NYSE", "WMT:NASDAQ",
    "CSCO:NASDAQ", "QCOM:NASDAQ", "TXN:NASDAQ", "CAT:NYSE", "IBM:NYSE", "GE:NYSE", "NOW:NYSE", "UBER:NYSE", "PLTR:NASDAQ",
    "SNOW:NYSE", "CRWD:NASDAQ", "MU:NASDAQ", "INTC:NASDAQ", "ARM:NASDAQ", "COIN:NASDAQ", "GS:NYSE", "BLK:NYSE",
  ].map((listing, index) => {
    const [symbol, exchange] = listing.split(":") as [string, string];
    return { symbol, exchange, currency: "USD", shares: 10 + index, avgCost: 100 };
  }),
  ...["SPY:ARCA", "QQQ:NASDAQ", "IWM:ARCA", "TLT:NASDAQ", "GLD:ARCA", "HYG:ARCA", "XLE:ARCA", "ARKK:BATS"].map((listing) => {
    const [symbol, exchange] = listing.split(":") as [string, string];
    return { symbol, exchange, currency: "USD", shares: 25, avgCost: 200 };
  }),
  ...["700", "9988", "1810", "3690", "1211"].map((symbol) => ({ symbol, exchange: "HKEX", currency: "HKD", shares: 1000, avgCost: 100 })),
  { symbol: "7203", exchange: "TSEJ", currency: "JPY", shares: 100, avgCost: 3000 },
  { symbol: "2337", exchange: "TWSE", currency: "TWD", shares: 1000, avgCost: 50 },
  { symbol: "ASML", exchange: "AEB", currency: "EUR", shares: 5, avgCost: 600 },
  { symbol: "SHEL", exchange: "LSE", currency: "GBP", shares: 200, avgCost: 25 },
];

export const SWEEP_CASES: SweepCase[] = [
  // 13F: the largest filers, names as people say them, two big books overlapped.
  { tool: "13f", args: { text: "Millennium Management", view: "holdings" } },
  { tool: "13f", args: { text: "0001273087", view: "holdings", limit: 200 } },
  { tool: "13f", args: { text: "Citadel Advisors", view: "holdings" } },
  { tool: "13f", args: { text: "BlackRock Inc", view: "holdings", limit: 25 } },
  { tool: "13f", args: { text: "Vanguard Group", view: "holdings", limit: 25 } },
  { tool: "13f", args: { text: "Bridgewater Associates", view: "holdings" } },
  { tool: "13f", args: { text: "ARK Investment Management", view: "holdings", limit: 15 } },
  { tool: "13f", args: { text: "Millennium Management", view: "filings" } },
  { tool: "13f", args: { text: "Millennium Management", compare: "Citadel Advisors" } },
  { tool: "13f", args: { text: "Berkshire Hathaway", compare: "SPY" } },
  { tool: "13f", args: { text: "Renaissance Technologies", view: "performance" } },
  { tool: "13f", args: { text: "NVDA", view: "ticker-holdings", limit: 100 } },
  { tool: "13f", args: { view: "crowding", limit: 100 } },
  { tool: "13f", args: { text: "Two Sigma" } },
  { tool: "adr", args: { symbol: "BABA" } },
  { tool: "alrt", args: {}, expect: "empty" },
  { tool: "anr", args: { symbol: "NVDA", limit: 100 } },
  { tool: "apps", args: { symbol: "META", days: "365" } },
  { tool: "ats", args: { symbol: "TSLA" } },
  { tool: "auct", args: { historyDays: "all" } },
  { tool: "awards", args: { tab: "all" } },
  { tool: "bi", args: { collection: "industries" } },
  { tool: "bt", args: { symbol: "SPY", preset: "trend-200" } },
  { tool: "btmm", args: {} },
  { tool: "btst", args: { symbol: "QQQ", preset: "rsi-reversion" } },
  { tool: "buzz", args: { range: "max" } },
  { tool: "calls", args: { symbol: "NVDA", view: "transcripts", section: "transcript" } },
  { tool: "catl", args: {} },
  { tool: "cbr", args: { history: true } },
  { tool: "cds", args: { days: 730 } },
  { tool: "cdx", args: { days: 1100 } },
  { tool: "cg", args: { limit: 200 } },
  { tool: "cg", args: { symbol: "NVDA", chamber: "all" } },
  { tool: "choke", args: { rangePreset: "ALL" } },
  { tool: "cmp", args: { symbols: [...US_TICKERS], rangePreset: "ALL" } },
  { tool: "cmp", args: { symbols: ASIA_TICKERS.slice(0, 6), rangePreset: "5Y" } },
  { tool: "cn", args: { symbol: "0700.HK", limit: 200 } },
  { tool: "corr", args: { symbols: [...US_TICKERS], rangePreset: "5Y" } },
  { tool: "cot", args: {} },
  { tool: "covn", args: { symbol: "CHTR" } },
  { tool: "cpi", args: {} },
  { tool: "crd", args: {} },
  { tool: "crdoc", args: { symbol: "CHTR" } },
  { tool: "cryp", args: { list: "defi" } },
  { tool: "csp", args: { symbols: US_TICKERS.slice(0, 10) } },
  { tool: "ctm", args: { text: "CL" } },
  { tool: "ctm", args: { text: "gold" } },
  { tool: "ddis", args: { symbol: "T" } },
  { tool: "dist", args: {} },
  { tool: "doe", args: {} },
  { tool: "dts", args: {} },
  { tool: "dvd", args: { symbols: [...US_TICKERS] } },
  { tool: "ecst", args: { text: "payrolls", range: "ALL" } },
  { tool: "ee", args: { symbol: "AAPL", limit: 200 } },
  { tool: "em", args: { symbol: "NVDA" } },
  { tool: "epwr", args: {} },
  { tool: "eqs", args: {} },
  { tool: "eqs", args: { preset: "value" } },
  { tool: "ern", args: { symbols: [...US_TICKERS], week: "next" } },
  { tool: "etf", args: { symbol: "VTI", limit: 200 } },
  { tool: "etff", args: { asset: "btc", limit: 500 } },
  { tool: "evt", args: { symbol: "AAPL" } },
  { tool: "evts", args: { symbol: "AAPL" } },
  { tool: "expo", args: { text: "AAPL=20% NVDA=20% TSM=20% 0700.HK=20% ASML=20%" } },
  { tool: "fa", args: { symbol: "BRK.B", period: "quarterly", statement: "balance" } },
  { tool: "flow", args: {} },
  { tool: "fng", args: {} },
  { tool: "ftd", args: { symbol: "GME" } },
  { tool: "fxc", args: {} },
  { tool: "g", args: { text: "SPY,QQQ,IWM,TLT,GLD,FRED:DGS10", rangePreset: "ALL" } },
  { tool: "gc", args: { date: "latest" } },
  { tool: "gc", args: { tab: "world" } },
  { tool: "ge", args: { symbols: US_TICKERS.slice(0, 10), rangePreset: "5Y" } },
  { tool: "gex", args: { symbol: "SPY" } },
  { tool: "gf", args: { symbols: US_TICKERS.slice(0, 10), metric: "freeCashFlow" } },
  { tool: "gip", args: { symbol: "SPY", rangePreset: "1W", chartResolution: "1m" } },
  { tool: "gp", args: { symbol: "0700.HK", rangePreset: "ALL" } },
  { tool: "gp", args: { symbol: "600519.SS", rangePreset: "ALL" } },
  { tool: "gpu", args: { tab: "history" } },
  { tool: "gr", args: { symbols: ["NVDA", "AMD"], range: "ALL" } },
  { tool: "guid", args: { symbol: "NVDA" } },
  { tool: "guide", args: { symbol: "AAPL", tab: "history" } },
  { tool: "hds", args: { symbol: "AAPL", limit: 200 } },
  // Between sessions the scanner holds no list, and says so.
  { tool: "hilo", args: {}, expect: "empty" },
  { tool: "hire", args: { symbol: "NVDA" } },
  { tool: "hivg", args: { symbol: "SPY", lookback: "ALL" } },
  { tool: "hm", args: { group: "industry" } },
  { tool: "hp", args: { symbol: "SPY", range: "ALL" } },
  { tool: "hp", args: { symbol: "9988.HK", range: "5Y" } },
  { tool: "hvg", args: { symbol: "SPY", lookbackYears: 2 } },
  { tool: "hvt", args: { symbol: "TSLA", lookbackYears: 2 } },
  { tool: "ins", args: {} },
  { tool: "ins", args: { symbol: "NVDA", type: "all", window: 90 } },
  { tool: "ipo", args: {} },
  { tool: "jobs", args: { symbol: "AMZN" } },
  { tool: "jodi", args: {} },
  { tool: "kelly", args: { symbol: "NVDA", years: 5 } },
  { tool: "kpis", args: { symbol: "AAPL" } },
  { tool: "liti", args: { symbol: "GOOGL" } },
  { tool: "ma", args: { status: "all" } },
  { tool: "map", args: {} },
  { tool: "mars", args: { text: SWEEP_PORTFOLIO_ID }, profile: true },
  { tool: "mday", args: { symbol: "SPY", lookbackYears: 5 } },
  { tool: "memb", args: { text: "IWM" } },
  { tool: "memb", args: { text: "SPY", tab: "movers" } },
  { tool: "most", args: {} },
  { tool: "n", args: { limit: 200 } },
  { tool: "ngs", args: {} },
  { tool: "opx", args: { symbol: "SPY" } },
  { tool: "ord", args: {}, expect: "error" },
  { tool: "osa", args: { symbol: "AAPL", strategy: "straddle" } },
  { tool: "ovdv", args: { symbol: "SPY" } },
  { tool: "ovme", args: {} },
  { tool: "pdlr", args: {} },
  { tool: "peb", args: { symbol: "AAPL", lookbackYears: 30 } },
  { tool: "perp", args: {} },
  { tool: "pf", args: { text: SWEEP_WATCHLIST_ID, limit: 200 }, profile: true },
  { tool: "pf", args: { text: SWEEP_PORTFOLIO_ID, limit: 200 }, profile: true },
  { tool: "port", args: { text: SWEEP_PORTFOLIO_ID }, profile: true },
  { tool: "power", args: {} },
  { tool: "psd", args: {} },
  { tool: "qq", args: { symbols: [...US_TICKERS.slice(0, 10), ...ASIA_TICKERS] } },
  { tool: "qr", args: { symbol: "SPY", limit: 500 } },
  { tool: "rdcf", args: { symbol: "NVDA" } },
  { tool: "return", args: { symbol: "SPY", range: "ALL", interval: "1d" } },
  { tool: "ripl", args: { symbols: ["NVDA"], tab: "two-hop" } },
  { tool: "risk", args: { symbol: "AAPL" } },
  { tool: "rrg", args: {} },
  { tool: "rv", args: { symbols: US_TICKERS.slice(0, 15) } },
  { tool: "scan", args: {} },
  { tool: "seas", args: { symbol: "SPY", lookbackYears: 30 } },
  { tool: "sec", args: { symbol: "JPM", all: true, limit: 200 } },
  { tool: "seg", args: { symbol: "AAPL", view: "region" } },
  { tool: "si", args: { symbol: "GME", limit: 100 } },
  { tool: "siv", args: { symbol: "TSLA" } },
  { tool: "siw", args: { symbols: US_TICKERS.slice(0, 10) } },
  { tool: "sovr", args: {} },
  { tool: "splc", args: { symbol: "AAPL", depth: 3 } },
  { tool: "tas", args: { symbol: "SPY", limit: 1000 } },
  { tool: "them", args: {} },
  { tool: "trace", args: { range: "3Y" } },
  { tool: "val", args: { range: "ALL" } },
  { tool: "vca", args: { preset: "megacaps" } },
  { tool: "vix", args: {} },
  { tool: "vols", args: {} },
  { tool: "wei", args: {} },
  { tool: "wirp", args: {} },
  { tool: "yas", args: {} },
];
