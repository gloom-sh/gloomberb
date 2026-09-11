/**
 * Market-data request shapes and price formatting (`gloomberb/market-data`).
 *
 * A plugin that provides quotes or history has to build the same request
 * objects the host does, and format prices the same way, or its output looks
 * foreign next to first-party panes.
 */
export * from "../market-data/request-types";
export * from "../market-data/market/format";

// Yahoo Finance's JSON endpoints need a crumb and cookie pair, retries on the
// 4xx/5xx it throws under load, and browser-like headers. A plugin scraping a
// Yahoo screener or quote endpoint gets that dance here rather than
// reimplementing it, and goes through `httpFetch` so the desktop and web
// renderers can route it.
export { YahooHttpClient } from "../sources/yahoo-finance/http";
