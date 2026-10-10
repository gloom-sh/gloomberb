// Identity of the built-in composite plugins, shared by the native catalog and
// the browser catalog (catalog-browser.ts). Keep this file import-free so the
// browser catalog can read it without pulling in native-only modules.
//
// Screeners & Movers ships without top movers on the web, so each catalog
// gives it its own description rather than advertising a pane it lacks.

export const applicationPluginMeta = {
  id: "application",
  name: "Application",
  version: "1.0.0",
  description: "Core layout, help, and release information.",
};

export const portfolioPluginMeta = {
  id: "portfolio",
  name: "Portfolio",
  version: "1.0.0",
  description: "Portfolio and watchlist management, analytics, and position sizing.",
  toggleable: true,
};

export const tickerResearchPluginMeta = {
  id: "ticker-research",
  name: "Ticker Research",
  version: "1.0.0",
  description: "Company research workspace: overview, charts, financials, filings, ownership, options, analyst research, and events.",
  toggleable: true,
};

export const newsPluginMeta = {
  id: "news",
  name: "News",
  version: "1.0.0",
  description: "Market news wire and company news for each ticker.",
  toggleable: true,
};

// Market Overview's successors. Its modules keep the `market-overview` state
// namespace; Alt Data and Quant default to `ticker-research`, where the
// Ticker Research modules they will hold keep theirs, and compose their Market
// Overview modules with a `market-overview` override. `market-overview` itself
// now stands for all six in disabledPlugins (see ownership.ts).

export const globalMarketsPluginMeta = {
  id: "global-markets",
  stateId: "market-overview",
  name: "Global Markets",
  version: "1.0.0",
  description: "World indices, the world map with chokepoint transits, sector and thematic performance, the FX matrix, and relative rotation.",
  toggleable: true,
};

export const screenersPluginMeta = {
  id: "screeners",
  stateId: "market-overview",
  name: "Screeners & Movers",
  version: "1.0.0",
  toggleable: true,
};

export const futuresCommoditiesPluginMeta = {
  id: "futures-commodities",
  stateId: "market-overview",
  name: "Futures & Commodities",
  version: "1.0.0",
  description: "Futures board and curves, CFTC positioning, and EIA petroleum and gas storage.",
  toggleable: true,
};

export const cryptoPluginMeta = {
  id: "crypto",
  stateId: "market-overview",
  name: "Crypto & Perps",
  version: "1.0.0",
  description: "Top crypto assets by market cap, and perpetual funding, open interest and premiums.",
  toggleable: true,
};

export const altDataPluginMeta = {
  id: "alt-data",
  stateId: "ticker-research",
  name: "Alt Data",
  version: "1.0.0",
  description: "Research attention, GPU rental prices, and power interconnection queues and capacity.",
  toggleable: true,
};

export const quantPluginMeta = {
  id: "quant",
  stateId: "ticker-research",
  name: "Quant",
  version: "1.0.0",
  description: "Correlation matrix and relationship graphs with beta and hedge ratios.",
  toggleable: true,
};

// Macro's successors keep its state namespace, so the pane state, settings and
// caches saved while they were one plugin stay theirs. `macro` itself now
// stands for all three in disabledPlugins (see ownership.ts).

export const ratesMacroPluginMeta = {
  id: "rates-macro",
  stateId: "macro",
  name: "Rates & Macro",
  version: "1.0.0",
  description: "Economic calendar and statistics, consumer prices, yield curve, rate path, money markets, central bank rates, volatility, and market valuation.",
  toggleable: true,
};

export const creditPluginMeta = {
  id: "credit",
  stateId: "macro",
  name: "Credit & Bonds",
  version: "1.0.0",
  description: "Single-name, index and sovereign CDS, credit spreads, Treasury auctions, and a bond calculator.",
  toggleable: true,
};

export const earningsPluginMeta = {
  id: "earnings",
  stateId: "macro",
  name: "Earnings",
  version: "1.0.0",
  description: "Earnings calendar with surprises and implied moves, and earnings call transcripts.",
  toggleable: true,
};
