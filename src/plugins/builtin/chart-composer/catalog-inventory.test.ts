import { describe, expect, test } from "bun:test";
import {
  catalogEmptyCopy,
  catalogExpressionForRow,
  catalogRowsForResolvedInstruments,
  filterCatalogRows,
  listStaticCatalogInventory,
  looksLikeCatalogTickerQuery,
} from "./catalog-inventory";

const AAPL = { symbol: "AAPL", exchange: "NASDAQ", name: "Apple Inc." };
const MSFT = { symbol: "MSFT", exchange: "NASDAQ", name: "Microsoft Corp." };

describe("data catalog inventory", () => {
  test("lists equity fields once and asks for a ticker when graphing", () => {
    const rows = listStaticCatalogInventory([AAPL, MSFT]);
    const securities = filterCatalogRows(rows, "securities", "");
    expect(securities.some((row) => row.label === "Close")).toBe(true);
    expect(securities.every((row) => row.needsTicker && row.expression.startsWith("TICKER:"))).toBe(true);
    expect(securities.every((row) => !row.label.includes("AAPL") && !row.label.includes("MSFT"))).toBe(true);
    expect(securities.filter((row) => row.label === "Close")).toHaveLength(1);

    const close = securities.find((row) => row.label === "Close");
    expect(catalogExpressionForRow(close!, "aapl")).toBe("AAPL:close");
    expect(catalogExpressionForRow(close!, "")).toBeNull();
    expect(securities.find((row) => row.id === "field:market.ohlcv")?.expression).toBe("TICKER:price");
  });

  test("options tab lists contract market fields and asks for an option symbol", () => {
    const rows = listStaticCatalogInventory([AAPL]);
    const options = filterCatalogRows(rows, "options", "");
    expect(options.some((row) => row.label === "Close")).toBe(true);
    expect(options.some((row) => row.label === "Volume")).toBe(true);
    expect(options.every((row) => row.needsTicker && row.expression.startsWith("TICKER:"))).toBe(true);
    expect(options.every((row) => row.kind === "Options" && row.sourceId === "option")).toBe(true);
    expect(options.some((row) => row.label === "PEG Ratio")).toBe(false);

    const close = options.find((row) => row.label === "Close");
    expect(catalogExpressionForRow(close!, "AAPL 260618C00200000")).toBe("AAPL260618C00200000:close");
    expect(catalogExpressionForRow(close!, "aapl260618c00200000")).toBe("AAPL260618C00200000:close");
    expect(catalogExpressionForRow(close!, "")).toBeNull();
  });

  test("crypto tab lists pairs, not equity fields", () => {
    const rows = listStaticCatalogInventory([
      AAPL,
      { symbol: "ETH-USD", exchange: "CCC", name: "Ethereum USD" },
    ]);
    const crypto = filterCatalogRows(rows, "crypto", "");
    expect(crypto.length).toBeGreaterThan(0);
    expect(crypto.every((row) => row.sourceId === "crypto" && row.kind === "Crypto")).toBe(true);
    expect(crypto.some((row) => row.expression === "ETH-USD:price")).toBe(true);
    expect(crypto.some((row) => row.expression === "BTC-USD:price")).toBe(true);
    expect(crypto.every((row) => !row.needsTicker)).toBe(true);
    expect(filterCatalogRows(rows, "securities", "").some((row) => row.sourceId === "crypto")).toBe(false);
  });

  test("FRED tab includes mapped series and treasuries; futures stay on their own tab", () => {
    const rows = listStaticCatalogInventory([]);
    const fred = filterCatalogRows(rows, "fred", "");
    const seriesIds = fred.filter((row) => row.sourceId === "fred").map((row) => row.expression);
    expect(new Set(seriesIds).size).toBe(seriesIds.length);
    expect(fred.some((row) => row.expression === "FRED:CPIAUCSL")).toBe(true);
    expect(fred.some((row) => row.expression === "UST:10Y" && row.kind === "Treasury")).toBe(true);
    expect(fred.every((row) => row.sourceId === "fred" || row.sourceId === "treasury")).toBe(true);

    const futures = filterCatalogRows(rows, "futures", "");
    expect(futures.some((row) => row.expression === "FUT:ES")).toBe(true);
    expect(futures.every((row) => row.sourceId === "futures")).toBe(true);
    expect(futures.some((row) => row.sourceId === "treasury")).toBe(false);
  });

  test("resolves a ticker query onto chartable rows without treating field names as tickers", () => {
    expect(looksLikeCatalogTickerQuery("AAPL")).toBe(true);
    expect(looksLikeCatalogTickerQuery("btc-usd")).toBe(true);
    expect(looksLikeCatalogTickerQuery("close")).toBe(false);
    expect(looksLikeCatalogTickerQuery("price")).toBe(false);

    const resolved = catalogRowsForResolvedInstruments([AAPL]);
    expect(resolved.some((row) => row.expression === "AAPL:close")).toBe(true);
    expect(resolved.some((row) => row.expression === "AAPL:price")).toBe(true);
    expect(resolved.every((row) => !row.needsTicker && row.label.startsWith("AAPL"))).toBe(true);
    expect(filterCatalogRows(resolved, "securities", "AAPL").some((row) => row.expression === "AAPL:close")).toBe(true);
  });

  test("empty copy covers loading and query misses without a retry hint", () => {
    expect(catalogEmptyCopy(true, "AAPL")).toEqual({ title: "Loading catalog…" });
    expect(catalogEmptyCopy(false, "AAPL")).toEqual({
      title: 'No series matching "AAPL"',
      hint: "Press / to search.",
    });
    expect(catalogEmptyCopy(false, "")).toEqual({
      title: "No series",
      hint: "Press / to search.",
    });
  });

  test("names only official publishers, never the market-data vendor", () => {
    const rows = [...listStaticCatalogInventory([AAPL]), ...catalogRowsForResolvedInstruments([AAPL])];
    expect(filterCatalogRows(rows, "fred", "").every((row) => row.publisher === "FRED")).toBe(true);
    const market = rows.filter((row) => row.sourceId !== "fred" && row.sourceId !== "treasury");
    expect(market.length).toBeGreaterThan(0);
    expect(market.every((row) => row.publisher === "")).toBe(true);
  });
});
