import { expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import {
  buildPortfolioHeatmapAssets,
  DAY_MOVE_FLOOR_PERCENT,
  dayMoveWeight,
  heatmapSizeBy,
  heatmapSizeWeight,
  type HeatmapSizeBy,
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

test("watchlist names default to the square root of market cap; a saved market-cap choice is honored", () => {
  const board = (sizeBy?: HeatmapSizeBy) => buildPortfolioHeatmapAssets({
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
  // The caption keeps the real cap; only the area takes the square root.
  const sqrt = [["7203", 900, 30, true], ["SPY", 400, 20, true], ["IWM", null, 20, false]];
  expect(board()).toEqual(sqrt);
  expect(board("sqrt-market-cap")).toEqual(sqrt);
  expect(board("market-cap")).toEqual([["7203", 900, 900, true], ["SPY", 400, 400, true], ["IWM", null, 400, false]]);
});

test("the day's move sizes a name by how far it moved, either way, and keeps a flat or missing move on the map", () => {
  expect(dayMoveWeight(4)).toBe(dayMoveWeight(-4));
  expect(dayMoveWeight(4)).toBe(2);
  // The square root keeps a big mover from taking the board: ten times the move, about three times the area.
  expect(dayMoveWeight(10) / dayMoveWeight(1)).toBeCloseTo(Math.sqrt(10), 10);
  expect(dayMoveWeight(20)).toBeGreaterThan(dayMoveWeight(2));
  // Flat, barely moved and no move at all share the smallest tile, never a zero-area one.
  const floor = Math.sqrt(DAY_MOVE_FLOOR_PERCENT);
  for (const move of [0, -0, DAY_MOVE_FLOOR_PERCENT / 10, -DAY_MOVE_FLOOR_PERCENT / 2, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(dayMoveWeight(move)).toBe(floor);
  }
  expect(dayMoveWeight(DAY_MOVE_FLOOR_PERCENT * 4)).toBeGreaterThan(floor);
  expect(dayMoveWeight(-DAY_MOVE_FLOOR_PERCENT * 4)).toBeGreaterThan(floor);
});

test("each Size by turns a name's cap and move into the weight it names", () => {
  const name = { marketCap: 400, move: -2.5 };
  expect(heatmapSizeWeight("market-cap", name)).toBe(400);
  expect(heatmapSizeWeight("sqrt-market-cap", name)).toBe(20);
  expect(heatmapSizeWeight("day-move", name)).toBe(dayMoveWeight(2.5));
  // The move sizes the tile on its own: no cap needed, and a cap says nothing about it.
  expect(heatmapSizeWeight("day-move", { marketCap: 0, move: -2.5 })).toBe(dayMoveWeight(2.5));
  expect(heatmapSizeWeight("day-move", { marketCap: 1e12, move: null })).toBe(dayMoveWeight(null));
});

test("a pane that never chose sizes the market boards by the day's move and a watchlist as it did, and a saved choice is kept", () => {
  for (const universe of [undefined, "us-equity", "us-etf", "nonsense"]) {
    expect(heatmapSizeBy(undefined, universe)).toBe("day-move");
    expect(heatmapSizeBy(null, universe)).toBe("day-move");
    expect(heatmapSizeBy("expensive", universe)).toBe("day-move");
  }
  expect(heatmapSizeBy(undefined)).toBe("day-move");
  expect(heatmapSizeBy(undefined, "portfolio")).toBe("sqrt-market-cap");
  for (const universe of [undefined, "us-equity", "us-etf", "portfolio"]) {
    expect(heatmapSizeBy("market-cap", universe)).toBe("market-cap");
    expect(heatmapSizeBy("sqrt-market-cap", universe)).toBe("sqrt-market-cap");
    expect(heatmapSizeBy("day-move", universe)).toBe("day-move");
  }
});

test("a watchlist sized by the day's move sizes every name by its move, with or without a cap", () => {
  const board = (changes: Record<string, number | null>) => buildPortfolioHeatmapAssets({
    tickers: Object.keys(changes).map((symbol) => ticker(symbol)),
    financials: new Map<string, TickerFinancials>(Object.entries(changes).map(([symbol, changePercent]) => [
      symbol,
      { ...quote(symbol, { changePercent: changePercent ?? undefined, change: changePercent == null ? undefined : 1 }), ...(symbol === "BIG" ? { fundamentals: { marketCap: 5e12, marketCapCurrency: "USD" } } : {}) },
    ])),
    collectionId: "watchlist",
    kind: "watchlist",
    currency: "USD",
    exchangeRates: new Map(),
    sizeBy: "day-move",
  });
  const { assets } = board({ BIG: 0.2, MOVR: -8, GAIN: 8, NODATA: null, FLAT: 0 });
  const byName = Object.fromEntries(assets.map((asset) => [asset.symbol, asset]));
  // Up and down alike, however small the company, largest tile first.
  expect(byName.MOVR!.weight).toBe(byName.GAIN!.weight!);
  expect(byName.MOVR!.weight).toBe(dayMoveWeight(8));
  expect(assets.slice(0, 2).map((asset) => asset.symbol).sort()).toEqual(["GAIN", "MOVR"]);
  // A $5T name that barely moved is a small tile, and its caption still carries the real cap.
  expect(byName.BIG!.weight).toBeLessThan(byName.MOVR!.weight!);
  expect(byName.BIG).toMatchObject({ size: 5e12, showSize: true });
  // A flat session and no change data both keep the smallest tile; the colour tells them apart.
  expect(byName.FLAT).toMatchObject({ weight: dayMoveWeight(0), hasChange: true });
  expect(byName.NODATA).toMatchObject({ weight: dayMoveWeight(null), hasChange: false, showSize: false });
});

test("a portfolio is sized by position value whatever the size setting says", () => {
  const holdings = (sizeBy: HeatmapSizeBy) => buildPortfolioHeatmapAssets({
    tickers: [
      ticker("AAPL", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 9, broker: "manual" }] }),
      ticker("MSFT", { portfolios: ["main"], positions: [{ portfolio: "main", shares: 1, broker: "manual" }] }),
    ],
    financials: new Map<string, TickerFinancials>([
      ["AAPL", quote("AAPL", { price: 100 })],
      ["MSFT", quote("MSFT", { price: 100 })],
    ]),
    collectionId: "main",
    kind: "portfolio",
    currency: "USD",
    exchangeRates: new Map(),
    sizeBy,
  }).assets.map((asset) => [asset.symbol, Math.round(asset.weight ?? 0)]);
  expect(holdings("sqrt-market-cap")).toEqual([["AAPL", 900], ["MSFT", 100]]);
  expect(holdings("market-cap")).toEqual(holdings("sqrt-market-cap"));
  expect(holdings("day-move")).toEqual(holdings("sqrt-market-cap"));
});
