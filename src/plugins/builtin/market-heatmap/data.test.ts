import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchMarketHeatmap,
  parseNasdaqMarketHeatmapResponse,
  parseYahooMarketHeatmapResponse,
  resetMarketHeatmapCache,
} from "./data";

afterEach(() => {
  resetMarketHeatmapCache();
});

describe("market heatmap data", () => {
  test("parses Yahoo equity screener rows by market cap", () => {
    const rows = parseYahooMarketHeatmapResponse({
      finance: {
        result: [{
          quotes: [{
            symbol: "NVDA",
            shortName: "NVIDIA",
            regularMarketPrice: 143,
            regularMarketChange: 2.5,
            regularMarketChangePercent: 1.78,
            marketCap: 3_500_000_000_000,
            regularMarketVolume: 45_000_000,
            currency: "USD",
            fullExchangeName: "NasdaqGS",
            sector: "Technology",
            industry: "Semiconductors",
            marketState: "REGULAR",
          }],
        }],
      },
    }, "us-equity");

    expect(rows).toEqual([{
      symbol: "NVDA",
      name: "NVIDIA",
      price: 143,
      change: 2.5,
      changePercent: 1.78,
      hasChange: true,
      size: 3_500_000_000_000,
      sizeKind: "market-cap",
      volume: 45_000_000,
      currency: "USD",
      exchange: "NasdaqGS",
      sector: "Technology",
      industry: "Semiconductors",
      marketState: "REGULAR",
      source: "yahoo",
    }]);
  });

  test("parses Yahoo ETF screener rows by net assets", () => {
    const rows = parseYahooMarketHeatmapResponse({
      finance: {
        result: [{
          quotes: [{
            symbol: "VOO",
            longName: "Vanguard S&P 500 ETF",
            regularMarketPrice: 686.1,
            regularMarketChangePercent: -0.21,
            netAssets: 1_700_000_000_000,
            regularMarketVolume: 5_500_000,
            currency: "USD",
          }],
        }],
      },
    }, "us-etf");

    expect(rows[0]).toMatchObject({
      symbol: "VOO",
      name: "Vanguard S&P 500 ETF",
      size: 1_700_000_000_000,
      sizeKind: "net-assets",
      changePercent: -0.21,
      source: "yahoo",
    });
  });

  test("parses and sorts Nasdaq fallback rows by market cap", () => {
    const rows = parseNasdaqMarketHeatmapResponse({
      data: {
        rows: [
          { symbol: "SMALL", name: "Small Co", lastsale: "$10.00", netchange: "0.10", pctchange: "1.00%", marketCap: "1000000", volume: "1000" },
          { symbol: "BIG", name: "Big Co", lastsale: "$250.00", netchange: "-5.00", pctchange: "-2.00%", marketCap: "3000000000", volume: "100000" },
        ],
      },
    });

    expect(rows.map((row) => row.symbol)).toEqual(["BIG", "SMALL"]);
    expect(rows[0]).toMatchObject({
      symbol: "BIG",
      price: 250,
      change: -5,
      changePercent: -2,
      size: 3_000_000_000,
      source: "nasdaq",
    });
  });

  test("falls back to Nasdaq for US equities when Yahoo returns no assets", async () => {
    const result = await fetchMarketHeatmap("us-equity", { count: 1, cache: false }, {
      yahooClient: {
        async postJsonWithCrumb<T>() {
          return { finance: { result: [{ quotes: [] }] } } as T;
        },
      },
      nasdaqFetch: async () => new Response(JSON.stringify({
        data: {
          rows: [
            { symbol: "AAPL", name: "Apple", lastsale: "$200.00", netchange: "1.00", pctchange: "0.50%", marketCap: "3000000000000", volume: "50000000" },
          ],
        },
      })),
    });

    expect(result.source).toBe("nasdaq");
    expect(result.assets.map((asset) => asset.symbol)).toEqual(["AAPL"]);
  });
});
