import { expect, test } from "bun:test";
import type { TickerRecord } from "../../../types/ticker";
import { DEFAULT_LIVE_SCAN, readLiveScan, toWireScan } from "./live-model";

const record = (ticker: string, exchange: string, watchlists: string[], assetCategory?: string) => ({
  metadata: { ticker, exchange, currency: "USD", name: ticker, portfolios: [], watchlists, positions: [], custom: {}, tags: [], ...(assetCategory ? { assetCategory } : {}) },
}) as unknown as TickerRecord;

test("a watchlist scans its US stocks as Gloom Cloud names them and says which rows it left out", () => {
  const tickers = [
    record("NVDA", "NASDAQ", ["tech"]),
    record("BRK-B", "NYSE", ["tech"]),
    record("SPY", "ARCA", ["tech"], "ETF"),
    record("RIO", "LSE", ["tech"]),
    record("BTC-USD", "", ["tech"], "CRYPTO"),
    record("ES=F", "", ["tech"]),
    record("AAPL", "NASDAQ", ["other"]),
  ];
  const wire = toWireScan({ ...DEFAULT_LIVE_SCAN, universe: { kind: "watchlist", id: "tech" } }, tickers);
  expect(wire.definition.universe).toEqual({ kind: "symbols", symbols: ["BRK.B", "NVDA", "SPY"] });
  expect(wire.skipped).toEqual(["RIO", "BTC-USD", "ES=F"]);
  expect(wire.problem).toBeNull();

  expect(toWireScan({ ...DEFAULT_LIVE_SCAN, universe: { kind: "watchlist", id: "gone" } }, tickers).problem).toBe("This watchlist is empty.");
  const abroad = toWireScan({ ...DEFAULT_LIVE_SCAN, universe: { kind: "watchlist", id: "uk" } }, [record("VOD", "LSE", ["uk"])]);
  expect(abroad.problem).toBe("This watchlist has no US stocks to scan.");
  expect(abroad.definition.universe).toEqual({ kind: "symbols", symbols: [] });
});

test("a scan read back from a layout keeps what reads and drops the rest instead of failing the pane", () => {
  expect(readLiveScan({
    universe: { kind: "index", index: "dow" },
    conditions: [
      { kind: "move", window: 7, direction: "up", percent: 2 },
      { kind: "new_high", within: 15 },
      { kind: "volume_spike", window: "day", ratio: 3 },
      "junk",
    ],
    minPrice: 0,
    minMarketCap: 2e9,
  })).toEqual({
    universe: { kind: "all" },
    conditions: [{ kind: "new_high", within: 15 }, { kind: "volume_spike", window: "day", ratio: 3 }],
    minPrice: null,
    minMarketCap: 2e9,
    minVolume: null,
  });
  expect(readLiveScan(null)).toBe(DEFAULT_LIVE_SCAN);
});
