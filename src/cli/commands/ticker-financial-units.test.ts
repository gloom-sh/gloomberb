import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import { buildTickerReport, renderFundamentalsReport } from "./ticker";

const config = createDefaultConfig("/tmp/gloom-ticker-units-unused");
const quote = { symbol: "UNITTEST", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") };
async function report(financials: TickerFinancials): Promise<string> {
  return (await buildTickerReport({ symbol: "UNITTEST", tickerFile: null, financials, config, toBase: async value => value }))
    .replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
}

test("ticker monetary fundamentals keep reported units across foreign, minor and unknown currencies", async () => {
  for (const [currency, eps] of [["CNY", "CN¥2.50"], ["GBp", "2.50 GBp"], ["GBX", "2.50 GBX"], ["ILA", "2.50 ILA"], ["ZAc", "2.50 ZAc"], [" ", "2.50 (ccy?)"]] as const) {
    const financials: TickerFinancials = { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [],
      fundamentals: { eps: 2.5, revenue: 1_000_000, netIncome: 0, freeCashFlow: -25_000, financialCurrency: currency },
    };
    const text = await report(financials);
    expect(text).toContain(`EPS (TTM) ${eps}`);
    expect(text).toContain(`Revenue (TTM) 1M ${currency.trim() || "(ccy?)"}`);
    expect(text).toContain(`Net Income (TTM) 0 ${currency.trim() || "(ccy?)"}`);
    expect(text).toContain(`Free Cash Flow (TTM) -25k ${currency.trim() || "(ccy?)"}`);
    expect(financials.fundamentals?.eps).toBe(2.5);
  }
});

test("statement units use compatible history, keep explicit overrides and exclude share counts", async () => {
  const financials: TickerFinancials = { quote, priceHistory: [], financialCurrency: "CNY",
    annualStatements: [{ date: "2025-12-31", eps: 0, totalRevenue: 1_000_000, dilutedShares: 400_000 }], quarterlyStatements: [],
  };
  expect(await report(financials)).toContain("Diluted EPS CN¥0.00");
  financials.quarterlyStatements.push({ date: "2026-06-30", currency: "EUR", eps: -1.25, totalRevenue: 200_000 });
  const mixed = await report(financials);
  expect(mixed).toContain("Diluted EPS 0.00 (ccy?)");
  expect(mixed).toContain("Diluted EPS -€1.25");
  expect(mixed).toContain("Revenue 200k EUR");
  expect(mixed).toContain("Diluted Shares 400k");
  expect(mixed).not.toContain("Diluted Shares 400k CNY");
  financials.annualStatements[0]!.currency = "GBp";
  expect(await report(financials)).toContain("Diluted EPS 0.00 GBp");
  financials.annualStatements[0]!.eps = Number.NaN;
  expect(await report(financials)).not.toContain("NaN");
});

test("enterprise value is shown in the market cap's currency, converted or labelled", async () => {
  const financials: TickerFinancials = { quote: { ...quote, currency: "CHF", marketCap: 200e9 }, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { marketCap: 200e9, marketCapCurrency: "CHF", enterpriseValue: 255e9 },
  };
  const render = async (toBase: (value: number, currency: string) => Promise<number>) => (
    await buildTickerReport({ symbol: "UNITTEST", tickerFile: null, financials, config, toBase })
  ).replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  const converted = await render(async (value, currency) => currency === "CHF" ? value * 1.2 : value);
  expect(converted).toContain("Market Cap 240B USD");
  expect(converted).toContain("Enterprise Value 306B USD");
  const unconverted = await render(async () => Number.NaN);
  expect(unconverted).toContain("Market Cap 200B CHF");
  expect(unconverted).toContain("Enterprise Value 255B CHF");
  // Fallback fundamentals declare no capitalization unit: the listing's quote currency applies.
  const undeclared: TickerFinancials = { quote: { ...quote, marketCap: 3.8e12 }, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { enterpriseValue: 3.85e12 },
  };
  const plain = await report(undeclared);
  expect(plain).toContain("Market Cap 3.8T USD");
  expect(plain).toContain("Enterprise Value 3.85T USD");
  expect(renderFundamentalsReport({ ...undeclared, symbol: "UNITTEST" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " "))
    .toContain("Enterprise Value 3.85T USD");
});

test("a zero enterprise value is a gap, not a value, while a negative one is kept", async () => {
  const withEnterpriseValue = (enterpriseValue: number): TickerFinancials => ({ quote, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { marketCap: 100e9, marketCapCurrency: "USD", enterpriseValue, revenue: 50e9, financialCurrency: "USD" },
  });
  const valuation = (financials: TickerFinancials) => renderFundamentalsReport({ ...financials, symbol: "UNITTEST" }, "valuation")
    .replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  for (const enterpriseValue of [0, Number.NaN]) {
    const financials = withEnterpriseValue(enterpriseValue);
    expect(await report(financials)).not.toContain("Enterprise Value");
    expect(valuation(financials)).not.toContain("Enterprise Value");
    expect(valuation(financials)).toContain("Market Cap 100B USD");
  }
  expect(await report(withEnterpriseValue(-5e9))).toContain("Enterprise Value -5B USD");
  expect(valuation(withEnterpriseValue(-5e9))).toContain("Enterprise Value -5B USD");
});

test("trailing figures use the fundamentals' currency, then the statements' reporting currency, never the quote's", async () => {
  const fundamentals = { eps: 31.43, revenue: 202.08e9, netIncome: 46.98e9, operatingCashFlow: 42.43e9, freeCashFlow: 36.96e9 };
  const reportedIn = (financialCurrency: string | undefined, fundamentalsCurrency?: string): TickerFinancials => ({
    quote: { ...quote, currency: "GBP" }, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { ...fundamentals, financialCurrency: fundamentalsCurrency }, financialCurrency,
  });
  // Intl joins a currency code to its amount with a no-break space.
  const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u00a0/g, " ").replace(/ {2,}/g, " ");
  const fromStatements = plain(await report(reportedIn("ZAR")));
  expect(fromStatements).toContain("EPS (TTM) ZAR 31.43");
  expect(fromStatements).toContain("Revenue (TTM) 202.08B ZAR");
  expect(fromStatements).toContain("Net Income (TTM) 46.98B ZAR");
  expect(fromStatements).toContain("Operating Cash Flow (TTM) 42.43B ZAR");
  expect(fromStatements).toContain("Free Cash Flow (TTM) 36.96B ZAR");
  expect(fromStatements).not.toContain("(ccy?)");
  expect(plain(renderFundamentalsReport({ ...reportedIn("ZAR"), symbol: "UNITTEST" }, "valuation"))).toContain("EPS (TTM) ZAR 31.43");
  expect(plain(await report(reportedIn("ZAR", "USD")))).toContain("Revenue (TTM) 202.08B USD");
  // Nothing declares a currency: the GBP quote must not stand in for it.
  expect(plain(await report(reportedIn(undefined)))).toContain("Revenue (TTM) 202.08B (ccy?)");
});

test("a pence-quoted range shares one decimal count, other ranges are unchanged", async () => {
  const pence = { ...quote, currency: "GBP", instrumentType: "EQUITY", providerPriceDivisor: 100, price: 35.32, low: 35.1, high: 35.4871, low52w: 25.5377, high52w: 37.585 };
  const london = await report({ quote: pence, annualStatements: [], quarterlyStatements: [], priceHistory: [] });
  expect(london).toContain("Day Range £35.1000 - £35.4871");
  expect(london).toContain("52W Range £25.5377 - £37.5850");
  const yen = await report({ quote: { ...quote, currency: "JPY", instrumentType: "EQUITY", price: 3000, low: 2950, high: 3012 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] });
  expect(yen).toContain("Day Range ¥2,950 - ¥3,012");
  const dollars = await report({ quote: { ...quote, instrumentType: "EQUITY", low: 99.5, high: 101.25 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] });
  expect(dollars).toContain("Day Range $99.50 - $101.25");
});

test("share counts say ADR equivalent where the service puts them on the receipts, and the profile decides only without it", async () => {
  const profile = { description: "BHP Group Ltd. Sponsored ADR is an American depositary receipt representing two ordinary shares of BHP Group Limited." };
  const statements = (shareBasis: "depositary_receipt" | "ordinary" | undefined, dilutedShares: number) => ({
    annualStatements: [{ date: "2026-06-30", currency: "USD", ...(shareBasis ? { shareBasis } : {}), dilutedShares }], quarterlyStatements: [], priceHistory: [],
  });
  const nyse = await report({ quote: { ...quote, isDepositaryReceipt: true, adrRatio: 2 }, profile, ...statements("depositary_receipt", 2_544_500_000),
    fundamentals: { sharesOutstanding: 2_540_081_549, isDepositaryReceipt: true, adrRatio: 2, shareBasis: "depositary_receipt", underlyingOrdinaryShares: 5_080_163_098 },
  });
  expect(nyse).toContain("Shares Outstanding 2.54B (ADR equivalent = 5.08B ordinary shares)");
  expect(nyse).toContain("Diluted Shares 2.54B (ADR equivalent)");
  // The London line shares the profile but is the ordinary line.
  const london = await report({ quote: { ...quote, currency: "GBP", isDepositaryReceipt: false }, profile, ...statements("ordinary", 5_089_000_000),
    fundamentals: { sharesOutstanding: 5_080_163_098, isDepositaryReceipt: false, shareBasis: "ordinary" },
  });
  expect(london).toContain("Shares Outstanding 5.08B\n");
  expect(london).toContain("Diluted Shares 5.09B");
  expect(london).not.toContain("ADR equivalent");
  // An older service: the profile marks the count, and a statement row with no basis is not relabelled.
  const older = await report({ quote, profile, ...statements(undefined, 2_544_500_000), fundamentals: { sharesOutstanding: 5_080_163_098 } });
  expect(older).toContain("Shares Outstanding 5.08B (ADR equivalent)\n");
  expect(older).toContain("Diluted Shares 2.54B\n");
});
