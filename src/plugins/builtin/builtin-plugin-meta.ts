// Identity of the built-in composite plugins, shared by the native catalog and
// the browser catalog (catalog-browser.ts). Keep this file import-free so the
// browser catalog can read it without pulling in native-only modules.
//
// Market Overview and Macro ship fewer panes on the web, so each catalog gives
// them its own description rather than advertising panes it lacks.

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

export const macroPluginMeta = {
  id: "macro",
  name: "Macro",
  version: "1.0.0",
  toggleable: true,
};
