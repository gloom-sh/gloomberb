import { expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import {
  buildPortfolioHeatmapAssets,
  fallbackHeatmapCollectionId,
  heatmapFollowsCollection,
  heatmapPortfolioPanes,
  heatmapPortfolioSignature,
  parseHeatmapPortfolioSignature,
  resolveHeatmapPortfolioSource,
} from "./portfolio";

function ticker(symbol: string, overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

function quote(symbol: string, patch: Partial<Quote> = {}): TickerFinancials {
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    quote: {
      symbol,
      price: 10,
      currency: "USD",
      change: 1,
      changePercent: 10,
      lastUpdated: 1,
      ...patch,
    },
  };
}

test("a focused portfolio pane wins, and the last one wins after focus leaves", () => {
  const panes = [
    { instanceId: "portfolio-list:main", collectionId: "main" },
    { instanceId: "portfolio-list:extra", collectionId: "growth" },
  ];
  expect(resolveHeatmapPortfolioSource(panes, "portfolio-list:extra", "portfolio-list:main")?.collectionId).toBe("growth");
  expect(resolveHeatmapPortfolioSource(panes, "market-heatmap:1", "portfolio-list:extra")?.collectionId).toBe("growth");
  expect(resolveHeatmapPortfolioSource(panes, null, null)?.instanceId).toBe("portfolio-list:main");
  expect(resolveHeatmapPortfolioSource([], "portfolio-list:main", null)).toBeNull();
});

test("portfolio pane state overrides the instance param", () => {
  const panes = heatmapPortfolioPanes(
    [{ instanceId: "portfolio-list:main", paneId: "portfolio-list", params: { collectionId: "main" } }],
    { "portfolio-list:main": { collectionId: "watchlist" } },
  );
  expect(panes).toEqual([{ instanceId: "portfolio-list:main", collectionId: "watchlist" }]);
  const signature = heatmapPortfolioSignature({
    focusedPaneId: "market-heatmap:1",
    config: { layout: { instances: [
      { instanceId: "portfolio-list:main", paneId: "portfolio-list", params: { collectionId: "main" } },
      { instanceId: "market-heatmap:1", paneId: "market-heatmap" },
    ] } },
    paneState: { "portfolio-list:main": { collectionId: "watchlist" } },
  });
  expect(parseHeatmapPortfolioSignature(signature)).toEqual({
    focusedPaneId: "market-heatmap:1",
    panes: [{ instanceId: "portfolio-list:main", collectionId: "watchlist" }],
  });
});

test("linking follows a later list and ignores the list already on screen", () => {
  expect(heatmapFollowsCollection(true, null, "main")).toBe(false);
  expect(heatmapFollowsCollection(true, "main", "main")).toBe(false);
  expect(heatmapFollowsCollection(false, "main", "growth")).toBe(false);
  expect(heatmapFollowsCollection(true, "main", "growth")).toBe(true);
  expect(fallbackHeatmapCollectionId({ portfolios: [], watchlists: [{ id: "watchlist" }] })).toBe("watchlist");
});

test("holdings are sized by market value in the portfolio's currency, and a name without one gets the smallest tile", () => {
  const rates = new Map([["JPY", 0.0067]]);
  const { assets, omitted } = buildPortfolioHeatmapAssets({
    tickers: [
      ticker("AAPL", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 10, avgCost: 150, currency: "USD", broker: "manual" }] }),
      ticker("7203", {
        exchange: "TSE",
        currency: "JPY",
        portfolios: ["main"],
        positions: [{ portfolio: "main", shares: 100, avgCost: 2500, currency: "JPY", broker: "manual" }],
      }),
      ticker("AAPL 270115C00200000", {
        assetCategory: "OPT",
        portfolios: ["main"],
        positions: [{ portfolio: "main", shares: 2, avgCost: 4, currency: "USD", broker: "manual", multiplier: 100 }],
      }),
      ticker("GOOGL", { portfolios: ["main"] }),
    ],
    financials: new Map<string, TickerFinancials>([
      ["AAPL", quote("AAPL", { price: 200, changePercent: -2, change: -4 })],
      ["7203", quote("7203", { price: 3000, currency: "JPY" })],
      ["AAPL 270115C00200000", quote("AAPL 270115C00200000", { price: 5 })],
      ["GOOGL", { ...quote("GOOGL", { price: 340 }), fundamentals: { marketCap: 4e12, marketCapCurrency: "USD" } }],
    ]),
    collectionId: "main",
    kind: "portfolio",
    currency: "USD",
    exchangeRates: rates,
  });
  expect(omitted).toBe(0);
  expect(assets.map((asset) => [asset.symbol, Math.round(asset.weight ?? 0), asset.showSize, asset.sizeCurrency])).toEqual([
    ["7203", 2010, true, "USD"],
    ["AAPL", 2000, true, "USD"],
    ["AAPL 270115C00200000", 1000, true, "USD"],
    ["GOOGL", 1000, false, "USD"],
  ]);
  expect(assets[1]).toMatchObject({ sizeCaption: "Value", changePercent: -2, hasChange: true });
});

test("watchlist names are sized by market cap in the base currency, or its square root", () => {
  const board = (sizeBy?: "sqrt-market-cap") => buildPortfolioHeatmapAssets({
    tickers: [ticker("IWM"), ticker("SPY"), ticker("7203", { currency: "JPY" })],
    financials: new Map<string, TickerFinancials>([
      ["SPY", { ...quote("SPY"), fundamentals: { marketCap: 400, marketCapCurrency: "USD" } }],
      ["7203", { ...quote("7203", { currency: "JPY" }), fundamentals: { marketCap: 90_000, marketCapCurrency: "JPY" } }],
    ]),
    collectionId: "watchlist",
    kind: "watchlist",
    currency: "USD",
    exchangeRates: new Map([["JPY", 0.01]]),
    sizeBy,
  }).assets.map((asset) => [asset.symbol, asset.size, asset.weight, asset.showSize]);
  expect(board()).toEqual([
    ["7203", 900, 900, true],
    ["SPY", 400, 400, true],
    ["IWM", null, 400, false],
  ]);
  // The caption keeps the real cap; only the area takes the square root.
  expect(board("sqrt-market-cap")).toEqual([
    ["7203", 900, 30, true],
    ["SPY", 400, 20, true],
    ["IWM", null, 20, false],
  ]);
});
