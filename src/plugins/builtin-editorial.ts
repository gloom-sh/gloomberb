// Editorial copy for the built-in plugins: what the Plugins pane and the
// plugin directory at gloom.sh say about each one beyond its catalog entry.
// Import-free, so the pane can read it without pulling in the catalog.

export interface BuiltinEditorial {
  /** Curated, since the catalog has no notion of categories. */
  categories: string[];
  featured?: true;
  /** Path to artwork in this repo, resolved by the directory against HEAD. */
  icon?: string;
  /** Ten words and 45 characters at most, for a row or a card; the description says the rest. */
  tagline?: string;
  /** The codes a row or card shows, at most three; the first three otherwise. */
  highlights?: readonly string[];
  /**
   * Codes whose capture the directory shows, at most three, best first. Each
   * names a reviewed image at gloom.sh/screenshots/fn/<CODE>.png.
   */
  screenshots?: readonly string[];
}

/**
 * Anything missing here is reported by `generate-plugin-manifest.ts` rather
 * than silently defaulted, so a new built-in cannot slip into the directory
 * uncategorised.
 */
export const BUILTIN_EDITORIAL: Readonly<Record<string, BuiltinEditorial>> = {
  "gloomberb-cloud": {
    categories: ["data", "cloud"],
    featured: true,
    tagline: "Account, chat, Ask Gloom and Cloud data.",
    icon: "plugin-icons/gloomberb-cloud.webp",
  },
  alerts: { categories: ["alerts"], tagline: "Price, market and filing alerts." },
  "alt-data": {
    categories: ["research", "data"],
    tagline: "Supply chains, hiring, apps, GPUs and power.",
    highlights: ["SPLC", "GPU", "JOBS"],
    screenshots: ["SPLC", "GPU", "JOBS"],
  },
  application: { categories: ["core"] },
  broker: { categories: ["broker"], tagline: "Broker accounts, sync and connections." },
  "clinical-trials": { categories: ["research"], tagline: "Clinical trials by drug, condition, sponsor." },
  "comment-letters": { categories: ["research"], tagline: "SEC comment letters and company replies." },
  credit: {
    categories: ["macro", "markets"],
    tagline: "CDS, credit spreads, auctions and bonds.",
    highlights: ["CDS", "CRD", "YAS"],
    screenshots: ["CDX", "SOVR", "YAS"],
  },
  crypto: {
    categories: ["markets", "crypto"],
    tagline: "Crypto prices, funding and open interest.",
    screenshots: ["CRYP"],
  },
  "custom-view": { categories: ["data", "productivity"] },
  debug: { categories: ["developer"], tagline: "Debug logs to read and export." },
  earnings: {
    categories: ["research", "markets"],
    tagline: "Earnings calendar, calls and the ripple.",
    screenshots: ["ERN"],
  },
  "fear-greed": { categories: ["markets", "sentiment"], icon: "plugin-icons/fear-greed.webp", tagline: "The Fear & Greed index and its inputs." },
  filings: {
    categories: ["research"],
    tagline: "SEC filings, 8-Ks, risk factors, litigation.",
    highlights: ["SEC", "EK", "RISK"],
    screenshots: ["EK", "RISK"],
  },
  "futures-commodities": {
    categories: ["markets", "macro"],
    tagline: "Futures, curves, positioning, energy data.",
    screenshots: ["CTM", "COT", "FUT"],
  },
  "global-markets": {
    categories: ["markets"],
    tagline: "World indices, map, sectors, FX, rotation.",
    highlights: ["WEI", "MAP", "RRG"],
    screenshots: ["MAP", "RRG", "WEI"],
  },
  "ipo-calendar": { categories: ["macro", "markets"], icon: "plugin-icons/ipo-calendar.webp", tagline: "Upcoming and recent IPOs worldwide." },
  "market-halts": { categories: ["markets"], icon: "plugin-icons/market-halts.webp", tagline: "US trading halts, current and recent." },
  "market-heatmap": { categories: ["markets"], icon: "plugin-icons/market-heatmap.webp", tagline: "The largest US stocks and ETFs as a heatmap." },
  members: { categories: ["markets", "research"], tagline: "ETF holdings and index changes." },
  news: { categories: ["news"], tagline: "Market news wire and company news." },
  notes: { categories: ["productivity"], tagline: "Notes on tickers, personal or shared." },
  openfda: { categories: ["research"], tagline: "FDA adverse events and drug recalls." },
  "options-volatility": {
    categories: ["research", "markets"],
    tagline: "Option chains, positioning and volatility.",
    highlights: ["OMON", "OPX", "OVDV"],
    screenshots: ["OPX", "HIVG", "HVG"],
  },
  ownership: {
    categories: ["research"],
    tagline: "Holders, 13F funds, insiders, short interest.",
    highlights: ["HDS", "INS", "SI"],
    screenshots: ["INS", "SI"],
  },
  portfolio: { categories: ["portfolio"], tagline: "Portfolios, watchlists and position sizing." },
  quant: {
    categories: ["markets", "research"],
    tagline: "Correlations, backtests and seasonality.",
    highlights: ["CORR", "BT", "SEAS"],
    screenshots: ["BT", "CORR", "SEAS"],
  },
  "rates-macro": {
    categories: ["macro"],
    tagline: "Economic data, yield curves, the rate path.",
    highlights: ["ECO", "GC", "WIRP"],
    screenshots: ["WIRP", "CPI", "GC"],
  },
  "research-search": { categories: ["research", "news"], tagline: "Search calls, wires and filings." },
  screeners: {
    categories: ["markets"],
    tagline: "Screener, movers, highs and lows, flow.",
    highlights: ["EQS", "MOST", "FLOW"],
    screenshots: ["EQS", "MOST"],
  },
  "ticker-core": {
    categories: ["research"],
    tagline: "Quotes, charts, financials and estimates.",
    highlights: ["DES", "G", "FA"],
    screenshots: ["DES", "G", "FA"],
  },
};
