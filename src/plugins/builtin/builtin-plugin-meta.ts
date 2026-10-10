// Identity of the built-in composite plugins, shared by the native catalog and
// the browser catalog (catalog-browser.ts). Keep this file import-free so the
// browser catalog can read it without pulling in native-only modules.
//
// Screeners & Movers, Ownership & Insiders and Earnings ship fewer panes on
// the web, so each catalog gives them their own description rather than
// advertising panes they lack.

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

// Ticker Research's successors. Every module keeps the `ticker-research`
// state namespace: these four declare it, Alt Data and Quant default to it,
// and Credit & Bonds and Earnings compose theirs with an override.
// `ticker-research` itself now stands for all eight in disabledPlugins (see
// ownership.ts). The core keeps the name people know.

export const tickerCorePluginMeta = {
  id: "ticker-core",
  stateId: "ticker-research",
  name: "Ticker Research",
  version: "1.0.0",
  description: "Company overview, charts, financials, quotes and returns, analyst research and estimates, KPIs and segments, valuation, dividends, executives, and time and sales.",
  toggleable: true,
};

export const optionsVolatilityPluginMeta = {
  id: "options-volatility",
  stateId: "ticker-research",
  name: "Options & Volatility",
  version: "1.0.0",
  description: "Option chains and positioning, a pricing calculator, scenarios, the volatility surface, and realized and implied volatility history.",
  toggleable: true,
};

export const ownershipPluginMeta = {
  id: "ownership",
  stateId: "ticker-research",
  name: "Ownership & Insiders",
  version: "1.0.0",
  toggleable: true,
};

export const filingsPluginMeta = {
  id: "filings",
  stateId: "ticker-research",
  name: "Filings & Events",
  version: "1.0.0",
  description: "SEC filings, risk factors, 8-K events, catalysts and litigation, and M&A and distress.",
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
// namespace; Alt Data and Quant default to `ticker-research`, where their
// Ticker Research modules keep theirs, and compose their Market Overview
// modules with a `market-overview` override. `market-overview` itself
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
  name: "Supply Chain & Alt Data",
  version: "1.0.0",
  description: "Supply chains and exposure, government awards, hiring, apps and job postings, social mentions, research attention, GPU prices, and power queues.",
  toggleable: true,
};

export const quantPluginMeta = {
  id: "quant",
  stateId: "ticker-research",
  name: "Quant",
  version: "1.0.0",
  description: "Correlation matrix and relationship graphs, backtests, seasonality, and moves on macro release days.",
  toggleable: true,
};

// Macro's successors keep its state namespace, so the pane state, settings and
// caches saved while they were one plugin stay theirs; the Ticker Research
// modules Credit & Bonds and Earnings hold keep `ticker-research`. `macro` itself now
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
  description: "Single-name, index and sovereign CDS, credit spreads, Treasury auctions, a bond calculator, credit documents and covenants, and debt maturities.",
  toggleable: true,
};

export const earningsPluginMeta = {
  id: "earnings",
  stateId: "macro",
  name: "Earnings",
  version: "1.0.0",
  toggleable: true,
};
