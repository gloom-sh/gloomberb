import { expect, test } from "bun:test";
import type { QueryEntry } from "../../../market-data/result-types";
import type { Quote } from "../../../types/financials";
import {
  buildCryptoColumns,
  buildCryptoRows,
  cryptoQuoteKey,
  DEFAULT_CRYPTO_SORT,
  formatCryptoPercent,
  formatCryptoPrice,
  nextCryptoSort,
  sortCryptoRows,
} from "./model";
import { CRYPTO_FIXTURE_NOW, cryptoFixture } from "./test-fixture";

function entry(quote: Partial<Quote> & Pick<Quote, "price" | "lastUpdated">): QueryEntry<Quote> {
  const data = { symbol: "BTC-USD", currency: "USD", change: 0, changePercent: 0, ...quote } as Quote;
  return { phase: "ready", data, lastGoodData: data, source: "test", fetchedAt: null, staleAt: null, error: null, attempts: [] };
}

test("returns compare the price with the close N UTC days back, like the day change", () => {
  const [btc, hype] = buildCryptoRows(cryptoFixture().assets, "coin", new Map(), CRYPTO_FIXTURE_NOW);
  expect(btc!.changePercent).toBeCloseTo(2.0408, 4);
  expect(btc!.return7d).toBeCloseTo((100 / 93 - 1) * 100, 6);
  expect(btc!.return30d).toBeCloseTo((100 / 70 - 1) * 100, 6);
  expect(btc!.return1y).toBeCloseTo(25, 6);
  // 30 closes plus the live price.
  expect(btc!.history).toHaveLength(31);
  expect(btc!.history.at(-1)!.close).toBe(100);
  // No history is unknown, not zero.
  expect(hype).toMatchObject({ code: "HYPE", return7d: null, return30d: null, return1y: null, history: [] });
});

test("a newer live quote moves price, day change, returns and market cap", () => {
  const data = cryptoFixture();
  const btc = data.assets[0]!;
  const quote = entry({ price: 105, changePercent: 7.1, lastUpdated: CRYPTO_FIXTURE_NOW, delivery: "stream", stale: false });
  const [row] = buildCryptoRows(data.assets, "coin", new Map([[cryptoQuoteKey(btc), quote]]), CRYPTO_FIXTURE_NOW);
  expect(row).toMatchObject({ price: 105, changePercent: 7.1, marketCap: 1_050_000_000_000, live: true });
  expect(row!.return7d).toBeCloseTo((105 / 93 - 1) * 100, 6);
  expect(row!.history.at(-1)!.close).toBe(105);
  const older = entry({ price: 90, lastUpdated: Date.parse(btc.quoteTime!) - 1 });
  const [kept] = buildCryptoRows(data.assets, "coin", new Map([[cryptoQuoteKey(btc), older]]), CRYPTO_FIXTURE_NOW);
  expect(kept).toMatchObject({ price: 100, live: false });
});

test("a live quote without a change percent is restated from the previous close", () => {
  const data = cryptoFixture();
  const btc = data.assets[0]!;
  const quote = entry({ price: 107.8, changePercent: Number.NaN, lastUpdated: CRYPTO_FIXTURE_NOW });
  const [row] = buildCryptoRows(data.assets, "coin", new Map([[cryptoQuoteKey(btc), quote]]), CRYPTO_FIXTURE_NOW);
  expect(row!.changePercent).toBeCloseTo(10, 6);
});

test("tabs split coins from stablecoins and keep market-cap rank order", () => {
  const assets = cryptoFixture().assets;
  expect(buildCryptoRows(assets, "coin", new Map()).map((row) => row.code)).toEqual(["BTC", "HYPE"]);
  expect(buildCryptoRows(assets, "stablecoin", new Map()).map((row) => row.code)).toEqual(["USDT"]);
});

test("numeric columns sort largest first, then smallest, then back to rank", () => {
  const rows = buildCryptoRows(cryptoFixture().assets, "coin", new Map(), CRYPTO_FIXTURE_NOW);
  let sort = nextCryptoSort(DEFAULT_CRYPTO_SORT, "changePercent");
  expect(sort).toEqual({ columnId: "changePercent", direction: "desc" });
  expect(sortCryptoRows(rows, sort).map((row) => row.code)).toEqual(["BTC", "HYPE"]);
  sort = nextCryptoSort(sort, "changePercent");
  expect(sortCryptoRows(rows, sort).map((row) => row.code)).toEqual(["HYPE", "BTC"]);
  expect(nextCryptoSort(sort, "changePercent")).toEqual(DEFAULT_CRYPTO_SORT);
  expect(nextCryptoSort(DEFAULT_CRYPTO_SORT, "code").direction).toBe("asc");
  // Unknown returns sort last in both directions.
  const byWeek = sortCryptoRows(rows, { columnId: "return7d", direction: "asc" });
  expect(byWeek.at(-1)!.code).toBe("HYPE");
});

test("narrow panes drop 1Y, the sparkline, 30D, volume and name in that order", () => {
  const ids = (width: number) => buildCryptoColumns(width).map((column) => column.id);
  expect(ids(140)).toEqual([
    "rank", "code", "name", "price", "changePercent", "return7d", "return30d", "return1y", "trend", "volume24h", "marketCap",
  ]);
  expect(ids(100)).not.toContain("return1y");
  expect(ids(90)).not.toContain("trend");
  expect(ids(60)).toEqual(["rank", "code", "price", "changePercent", "return7d", "marketCap"]);
  const wide = buildCryptoColumns(200).find((column) => column.id === "name")!;
  expect(wide.width).toBe(24);
});

test("a move that rounds to zero is unsigned", () => {
  expect(formatCryptoPercent(-0.004)).toBe("0.00%");
  expect(formatCryptoPercent(0.005)).toBe("+0.01%");
  expect(formatCryptoPercent(-1.5)).toBe("-1.50%");
});

test("prices show four significant digits and at least two decimals", () => {
  expect(formatCryptoPrice(84_352.31)).toBe("84,352.31");
  expect(formatCryptoPrice(114.7)).toBe("114.70");
  expect(formatCryptoPrice(1.5142)).toBe("1.514");
  expect(formatCryptoPrice(0.33978266)).toBe("0.3398");
  expect(formatCryptoPrice(0.0936)).toBe("0.09360");
  expect(formatCryptoPrice(0.00000566)).toBe("0.000005660");
  expect(formatCryptoPrice(1.0001, 4)).toBe("1.0001");
  expect(formatCryptoPrice(null)).toBe("—");
});
