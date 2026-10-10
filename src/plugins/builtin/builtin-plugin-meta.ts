// Identity of the built-in composite plugins, shared by the native catalog and
// the browser catalog (catalog-browser.ts). Keep this file import-free so the
// browser catalog can read it without pulling in native-only modules.
//
// Market Overview ships fewer panes on the web, so each catalog gives it its
// own description rather than advertising panes it lacks.

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

export const marketOverviewPluginMeta = {
  id: "market-overview",
  name: "Market Overview",
  version: "1.0.0",
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
