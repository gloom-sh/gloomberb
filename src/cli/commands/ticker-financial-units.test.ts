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

test("an EV off market cap + debt - cash is labelled as the provider's with the reconciliation, a withdrawn one is unavailable", async () => {
  // Synthetic, shaped like WPM (differs) and GFI (withdrawn).
  const check = { currency: "USD", marketCap: 62e9, totalDebt: 2e9, cash: 0.1e9, balanceSheetDate: "2026-06-30", computed: 63.9e9 };
  const withCheck = (fundamentals: TickerFinancials["fundamentals"]): TickerFinancials => ({
    quote, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { marketCap: 62e9, marketCapCurrency: "USD", ...fundamentals },
  });
  const valuation = (financials: TickerFinancials) => renderFundamentalsReport({ ...financials, symbol: "UNITTEST" }, "valuation")
    .replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  const differs = withCheck({ enterpriseValue: 61.8e9, enterpriseValueCheck: { ...check, status: "differs", source: 61.8e9 } });
  expect(valuation(differs)).toContain("Enterprise Value 61.8B USD (provider)");
  expect(valuation(differs)).toContain(
    "EV 61.8B USD (provider) vs 63.9B computed from market cap + total debt - cash (balance sheet 2026-06-30).");
  expect(await report(differs)).toContain("Enterprise Value 61.8B USD (provider)");
  const withdrawn = withCheck({
    unavailableFields: ["enterpriseValue", "enterpriseToRevenue"],
    enterpriseValueCheck: { ...check, status: "withdrawn", source: 128e9 },
  });
  expect(valuation(withdrawn)).toContain("Enterprise Value unavailable");
  expect(valuation(withdrawn)).toContain(
    "EV unavailable: the provider's 128B USD is 2.0x the 63.9B computed from market cap + total debt - cash (balance sheet 2026-06-30).");
  // A matching EV, or a check beside another source's EV, prints as before.
  for (const fundamentals of [
    { enterpriseValue: 63e9, enterpriseValueCheck: { ...check, status: "matches" as const, source: 63e9 } },
    { enterpriseValue: 70e9, enterpriseValueCheck: { ...check, status: "differs" as const, source: 61.8e9 } },
  ]) {
    const text = valuation(withCheck(fundamentals));
    expect(text).toMatch(new RegExp(`^Enterprise Value ${fundamentals.enterpriseValue / 1e9}B USD$`, "m"));
    expect(text).not.toContain("computed");
  }
});

test("after the close the EV row and its note read one close, the cap rests on the shares shown, and a withdrawn EV says why", () => {
  // GLO-754, CHGG on 2026-10-13: the after-hours 0.74 quote beside the 0.7133 close. The row moved the provider's
  // 63.02M EV to the close (60.06M) while its note still read 63.02M against 43.61M computed at 0.74.
  const afterHours = {
    ...quote, price: 0.74, change: 0.0289, changePercent: 4.06, previousClose: 0.7111, marketState: "POSTPOST" as const,
    regularClose: 0.7133, regularCloseSessionDate: "2026-10-13", regularChange: 0.0022, regularChangePercent: 0.31,
    changeSessionDate: "2026-10-13", marketCap: 82_076_032,
  };
  const valuation = (fundamentals: TickerFinancials["fundamentals"]) => renderFundamentalsReport(
    { quote: afterHours, annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals, symbol: "UNITTEST" }, "valuation",
  ).replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  const chegg = valuation({
    marketCap: 82_076_032, marketCapCurrency: "USD", sharesOutstanding: 110_913_557, enterpriseValue: 63_023_563,
    enterpriseValueCheck: { status: "differs", source: 63_023_563, currency: "USD", marketCap: 82_076_032, totalDebt: 33_845_000,
      cash: 72_314_000, balanceSheetDate: "2026-06-30", computed: 43_607_032 },
  });
  expect(chegg).toContain("Market Cap 79.11M USD\nShares Outstanding 110.91M\n");
  expect(chegg).toContain("Enterprise Value 60.06M USD (provider)");
  expect(chegg).toContain("EV 60.06M USD (provider) vs 40.65M computed from market cap + total debt - cash (balance sheet 2026-06-30).");
  expect(chegg).not.toContain("does not rest on");
  // A cap on another count than the one shown (one class's) says so; NRDY's EV, withdrawn by Gloom Cloud's
  // validation with no check, is unavailable with the reason rather than a dropped row.
  const nerdy = valuation({
    marketCap: 82_076_032, marketCapCurrency: "USD", sharesOutstanding: 72_230_417,
    unavailableFields: ["enterpriseValue", "enterpriseToRevenue"],
  });
  expect(nerdy).toContain("Market cap 79.11M USD is the provider's and does not rest on the 72.23M shares shown (x 0.7133 USD = 51.52M).");
  expect(nerdy).toContain("Enterprise Value unavailable");
  expect(nerdy).toContain("EV unavailable: the provider's figure failed validation.");
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

test("a converted TTM block prints in its own currency with what it was converted from, beside statements in theirs", async () => {
  // SAN on NYSE: EUR statements, a TTM block converted to USD.
  const santander = (fundamentals: NonNullable<TickerFinancials["fundamentals"]>): TickerFinancials => ({
    quote: { ...quote, price: 13.49 }, financialCurrency: "EUR", priceHistory: [], quarterlyStatements: [],
    annualStatements: [{ date: "2025-12-31", currency: "EUR", totalRevenue: 60.02e9, netIncome: 14.1e9 }],
    fundamentals: { trailingPE: 13.097, eps: 1.03, revenue: 54.63e9, netIncome: 14.52e9, operatingCashFlow: -41.31e9, ...fundamentals },
  });
  const converted = { financialCurrency: "USD", ttmConversion: { from: "EUR", rate: 1.12571, asOf: "2026-10-09", eps: "report_date" as const } };
  const conversionNote = "TTM converted from EUR (1 EUR = 1.1257 USD, 2026-10-09); EPS at report-date rates.";
  const priceEarningsNote = "P/E (TTM): spot price over EPS at report-date rates.";
  const text = await report(santander(converted));
  for (const line of ["EPS (TTM) $1.03", "Revenue (TTM) 54.63B USD", "Net Income (TTM) 14.52B USD", "Operating Cash Flow (TTM) -41.31B USD",
    conversionNote, priceEarningsNote, "Revenue 60.02B EUR", "Net Income 14.1B EUR"]) expect(text).toContain(line);
  const valuation = renderFundamentalsReport({ ...santander(converted), symbol: "SAN" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "");
  expect(valuation).toContain(conversionNote);
  expect(valuation).toContain(priceEarningsNote);
  // A loss leaves no P/E to explain; a block in the reporting currency has nothing to say.
  const loss = await report(santander({ ...converted, eps: -0.5 }));
  expect(loss).toContain(conversionNote);
  expect(loss).not.toContain(priceEarningsNote);
  const madrid = await report(santander({ financialCurrency: "EUR", eps: 0.88 }));
  expect(madrid).toContain("EPS (TTM) €0.88");
  expect(madrid).not.toContain("converted");
});

test("an EPS in another currency than the TTM amounts, and a P/E converting its EPS, say so", async () => {
  // CCU on NYSE as served on 2026-10-11: CLP amounts, EPS in USD at report-date rates.
  const ccu: TickerFinancials = { quote: { ...quote, price: 10.91 }, financialCurrency: "CLP", priceHistory: [], quarterlyStatements: [],
    annualStatements: [{ date: "2025-12-31", currency: "CLP", totalRevenue: 2.91e12, netIncome: 117.15e9, eps: 634.1 }],
    fundamentals: { trailingPE: 17.885, eps: 0.61, revenue: 2.91e12, netIncome: 117.15e9, financialCurrency: "CLP", epsCurrency: "USD" },
  };
  const text = await report(ccu);
  for (const line of ["EPS (TTM) $0.61", "Revenue (TTM) 2.91T CLP", "Net Income (TTM) 117.15B CLP",
    "EPS (TTM) in USD, converted from CLP at report-date rates.", "P/E (TTM): spot price over EPS at report-date rates."]) expect(text).toContain(line);
  // LIN on XETRA: USD figures, EPS included, and a EUR P/E on that EPS at the current rate.
  const lin: TickerFinancials = { quote: { ...quote, price: 432.4, currency: "EUR" }, financialCurrency: "USD", priceHistory: [],
    annualStatements: [], quarterlyStatements: [],
    fundamentals: { trailingPE: 33.165, eps: 14.61, revenue: 33.99e9, netIncome: 6.9e9, financialCurrency: "USD",
      trailingPEConversion: { from: "USD", rate: 0.8924 } },
  };
  const xetra = await report(lin);
  for (const line of ["P/E (TTM) 33.17", "EPS (TTM) $14.61", "Revenue (TTM) 33.99B USD", "P/E (TTM): price over EPS converted at 1 USD = 0.8924 EUR."]) {
    expect(xetra).toContain(line);
  }
  expect(xetra).not.toContain("report-date");
  const valuation = renderFundamentalsReport({ ...lin, symbol: "LIN" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "");
  expect(valuation).toContain("P/E (TTM): price over EPS converted at 1 USD = 0.8924 EUR.");
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

test("a fund's report says its fund facts are not available yet and where its SEC filings are; a stock's says nothing", async () => {
  const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  const note = "Fund facts (fee, NAV, premium) are not available yet; try fn SEC IBIT.";
  const ibit: TickerFinancials = { quote: { ...quote, symbol: "IBIT", instrumentType: "ETF", exchangeName: "NASDAQ" },
    annualStatements: [], quarterlyStatements: [], priceHistory: [] };
  expect(plain(renderFundamentalsReport({ ...ibit, symbol: "IBIT", exchange: "NASDAQ" }, "fundamentals")))
    .toContain(`No fundamentals reported for IBIT. ${note}`);
  expect(plain(await buildTickerReport({ symbol: "IBIT", tickerFile: null, financials: ibit, config, toBase: async value => value })))
    .toContain(note);
  // A fund listed outside the US has no SEC filings to point at.
  const london: TickerFinancials = { ...ibit, quote: { ...ibit.quote!, symbol: "VUSA", exchangeName: "LSE" } };
  expect(plain(renderFundamentalsReport({ ...london, symbol: "VUSA", exchange: "LSE" }, "fundamentals")))
    .toContain("No fundamentals reported for VUSA. Fund facts (fee, NAV, premium) are not available yet.");
  expect(await report({ quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] })).not.toContain("Fund facts");
});
