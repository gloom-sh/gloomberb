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
  formatOffPeg,
  formatPegTarget,
  nextCryptoSort,
  offPegBasisPoints,
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

test("a live price crossing a power of ten keeps the decimals of its previous close", () => {
  const coin = { ...cryptoFixture().assets[0]!, price: 9.95, previousClose: 9.9 };
  const rowAt = (price: number) => buildCryptoRows(
    [coin], "coin", new Map([[cryptoQuoteKey(coin), entry({ price, lastUpdated: CRYPTO_FIXTURE_NOW })]]), CRYPTO_FIXTURE_NOW,
  )[0]!.priceText;
  expect(rowAt(9.998)).toBe("9.998");
  expect(rowAt(10.02)).toBe("10.020");
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
  // Stablecoins keep the peg and the low: the price's returns go first, then supply's dollar changes, and supply itself last.
  const stable = (width: number) => buildCryptoColumns(width, "stablecoin").map((column) => column.id);
  expect(stable(166)).toEqual([
    "rank", "code", "name", "price", "pegText", "offPegBp", "low24h", "low24hAt", "high24h", "high24hAt",
    "volume24h", "marketCap", "supply", "supply7dPercent", "supply30dPercent", "supplyShare",
  ]);
  expect(stable(94)).toEqual(["rank", "code", "price", "pegText", "offPegBp", "low24h", "low24hAt", "marketCap", "supply"]);
  expect(stable(84)).toEqual(["rank", "code", "price", "pegText", "offPegBp", "low24h", "low24hAt", "supply"]);
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

test("a stablecoin is off its own target: a dollar, a euro at EUR/USD, and never a coin that accrues yield", () => {
  const usd = { currency: "USD", accrues: false, price: 1, asOf: null };
  expect(offPegBasisPoints(0.99871, usd)).toBe(-12.9);
  expect(formatOffPeg(offPegBasisPoints(1.0003, usd))).toBe("+3.0bp");
  expect(formatOffPeg(offPegBasisPoints(1, usd))).toBe("0.0bp");
  // EURC at 1.1234 is not a 12% premium: it is 7bp under EUR/USD.
  const eur = { currency: "EUR", accrues: false, price: 1.124227, asOf: "2026-10-17T12:20:52.000Z" };
  expect(offPegBasisPoints(1.1233596, eur)).toBe(-7.7);
  expect(formatPegTarget(eur)).toBe("EUR 1.1242");
  // USDY's price carries its yield: no par to be off, so no basis points at all.
  const yieldCoin = { currency: "USD", accrues: true, price: null, asOf: null };
  expect(offPegBasisPoints(1.1497, yieldCoin)).toBeNull();
  expect(formatOffPeg(null)).toBe("");
  expect(formatPegTarget(yieldCoin)).toBe("USD yield");
  // A euro coin whose rate could not be read keeps its currency and reads no deviation.
  expect(offPegBasisPoints(1.12, { ...eur, price: null })).toBeNull();
  expect(formatPegTarget({ ...eur, price: null })).toBe("EUR");
});

test("the 24h low and high take a newer live price, and off peg sorts by size either side", () => {
  const data = cryptoFixture();
  const usdt = data.assets.find((asset) => asset.code === "USDT")!;
  const [board] = buildCryptoRows(data.assets, "stablecoin", new Map(), CRYPTO_FIXTURE_NOW);
  expect(board).toMatchObject({ low24h: 0.9983, high24h: 1.0004, low24hText: "0.9983", offPegBp: -2, pegText: "USD" });
  expect(board!.low24hAt).toBe(Date.parse("2026-09-22T23:30:00.000Z"));
  const tick = CRYPTO_FIXTURE_NOW + 1;
  const quote = entry({ symbol: "USDT-USD", price: 0.9971, lastUpdated: tick });
  const [live] = buildCryptoRows(data.assets, "stablecoin", new Map([[cryptoQuoteKey(usdt), quote]]), CRYPTO_FIXTURE_NOW);
  expect(live).toMatchObject({ low24h: 0.9971, low24hAt: tick, high24h: 1.0004, offPegBp: -29 });
  // Coins carry no peg columns.
  expect(buildCryptoRows(data.assets, "coin", new Map(), CRYPTO_FIXTURE_NOW)[0]).toMatchObject({ peg: null, offPegBp: null, low24h: null });
  const rows = [{ ...board!, code: "UP", offPegBp: 12 }, { ...board!, code: "DOWN", offPegBp: -30 }, { ...board!, code: "YIELD", offPegBp: null }];
  expect(sortCryptoRows(rows, { columnId: "offPegBp", direction: "desc" }).map((row) => row.code)).toEqual(["DOWN", "UP", "YIELD"]);
});
