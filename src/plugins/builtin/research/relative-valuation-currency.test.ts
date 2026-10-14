import { expect, test } from "bun:test";
import { conversionNote, conversionPairText, convertMarketCaps } from "./relative-valuation-currency";

const rates = new Map([
  ["EUR", { rate: 1.12, asOf: "2026-10-14T06:30:00.000Z" }],
  ["GBP", { rate: 1.3, asOf: "2026-10-14T06:00:00.000Z" }],
]);

test("market caps convert through each currency's dollar rate, pence as pounds, and a missing rate leaves the cap as served", () => {
  const { rows, conversions, unconverted } = convertMarketCaps([
    { symbol: "DAL", marketCap: 50e9, marketCapCurrency: "USD" },
    { symbol: "LHA:XETRA", marketCap: 10e9, marketCapCurrency: "EUR" },
    { symbol: "IAG:LSE", marketCap: 1_000e9, marketCapCurrency: "GBX" },
    { symbol: "SAS:STO", marketCap: 5e9, marketCapCurrency: "SEK" },
    { symbol: "NONE", marketCap: null, marketCapCurrency: null },
  ], "USD", rates);
  expect(rows.map((row) => [row.symbol, row.marketCap == null ? null : Math.round(row.marketCap), row.marketCapCurrency])).toEqual([
    ["DAL", 50e9, "USD"],
    ["LHA:XETRA", 11.2e9, "USD"],
    ["IAG:LSE", 13e9, "USD"],
    ["SAS:STO", 5e9, "SEK"],
    ["NONE", null, null],
  ]);
  expect(rows[1]).toMatchObject({ marketCapNative: 10e9, marketCapNativeCurrency: "EUR" });
  expect(unconverted).toEqual([{ currency: "SEK", symbols: ["SAS:STO"] }]);
  expect(conversions.map(({ from, rate }) => [from, rate])).toEqual([["EUR", 1.12], ["GBP", 1.3]]);
});

test("a cross out of dollars goes through both legs and is dated by the older one", () => {
  const { rows, conversions } = convertMarketCaps([{ symbol: "DAL", marketCap: 1.3e9, marketCapCurrency: "USD" },
    { symbol: "LHA:XETRA", marketCap: 1.12e9, marketCapCurrency: "EUR" }], "GBP", rates);
  expect(rows.map((row) => Math.round(row.marketCap!))).toEqual([1e9, Math.round(1.12e9 * 1.12 / 1.3)]);
  expect(conversions[0]).toMatchObject({ from: "USD", to: "GBP", asOf: "2026-10-14T06:00:00.000Z" });
});

test("the note quotes each rate as a dealer does, with its time", () => {
  expect(conversionPairText({ from: "EUR", to: "USD", rate: 1.12 })).toBe("EUR/USD 1.1200");
  expect(conversionPairText({ from: "JPY", to: "USD", rate: 1 / 150 })).toBe("USD/JPY 150.00");
  expect(conversionPairText({ from: "USD", to: "EUR", rate: 1 / 1.12 })).toBe("EUR/USD 1.1200");
  expect(conversionNote("USD", [{ from: "EUR", to: "USD", rate: 1.12, asOf: "2026-10-14T06:30:00.000Z", retrievedAt: null },
    { from: "SEK", to: "USD", rate: 0.1, asOf: null, retrievedAt: "2026-10-14T07:00:00.000Z" }]))
    .toBe("market caps in USD at EUR/USD 1.1200 (2026-10-14 06:30 UTC), USD/SEK 10.000 (retrieved 2026-10-14 07:00 UTC)");
  expect(conversionNote("USD", [])).toBeNull();
});
