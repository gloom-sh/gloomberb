import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import { buildTickerReport, fundamentalsReportTables, loadReportBondFacts, renderFundamentalsReport } from "./ticker";
import { createBaseConverter } from "../base-converter";
import type { FundBondFacts } from "../../api-client/fund-facts";
import { analyzeTaxEquivalent } from "../../market-data/tax-equivalent";
import { createTestTicker } from "../../test-support/ticker";

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

test("enterprise value is shown in the market cap's currency, with the base currency's figure after both", async () => {
  const financials: TickerFinancials = { quote: { ...quote, currency: "CHF", marketCap: 200e9 }, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { marketCap: 200e9, marketCapCurrency: "CHF", enterpriseValue: 255e9 },
  };
  const render = async (toBase: (value: number, currency: string) => Promise<number>) => (
    await buildTickerReport({ symbol: "UNITTEST", tickerFile: null, financials, config, toBase })
  ).replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  const converted = await render(async (value, currency) => currency === "CHF" ? value * 1.2 : value);
  expect(converted).toContain("Market Cap 200B CHF (240B USD)");
  expect(converted).toContain("Enterprise Value 255B CHF (306B USD)");
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

test("a zero enterprise value is a gap, not a value, while a negative one is N/M with why", async () => {
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
  // A source's negative EV that no check judged: its cash and investments exceed the rest.
  for (const text of [await report(withEnterpriseValue(-5e9)), valuation(withEnterpriseValue(-5e9))]) {
    expect(text).toContain("Enterprise Value N/M");
    expect(text).toContain("EV N/M: cash and investments exceed market cap + debt in the source's EV.");
  }
});

test("an insurer's EV keeps its investments and says so, and one at or below zero is N/M with Gloom Cloud's reason", () => {
  const valuation = (fundamentals: TickerFinancials["fundamentals"]) => renderFundamentalsReport(
    { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals, symbol: "UNITTEST" }, "valuation",
  ).replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  // BRK-B on 2026-10-23: the provider's -233.89B netted its investments; 1,138.9B + 128.6B - 40.61B of cash.
  const brk = valuation({
    marketCap: 100e9, marketCapCurrency: "USD", enterpriseValue: 107.8e9, enterpriseToRevenue: 2.8, revenue: 38.5e9, financialCurrency: "USD",
    enterpriseValueCheck: { status: "computed", source: -20.5e9, currency: "USD", marketCap: 100e9, totalDebt: 11.3e9, cash: 3.5e9,
      balanceSheetDate: "2026-06-30", computed: 107.8e9, investmentsKept: true },
  });
  expect(brk).toMatch(/^Enterprise Value 107.8B USD$/m);
  expect(brk).toContain("EV 107.8B USD is market cap + total debt - 3.5B of cash and equivalents (balance sheet 2026-06-30); investments stay in.");
  // ARVN on 2026-10-23: more cash and short-term investments than market cap and debt.
  const reason = "Cash and short-term investments exceed market cap + total debt (balance sheet 2026-06-30)";
  const arvn = valuation({
    marketCap: 100e9, marketCapCurrency: "USD", unavailableFields: ["enterpriseValue", "enterpriseToRevenue"],
    enterpriseValueCheck: { status: "not-meaningful", source: -18e9, currency: "USD", marketCap: 100e9, totalDebt: 0.1e9, cash: 121e9,
      balanceSheetDate: "2026-06-30", computed: -20.9e9, reason },
  });
  expect(arvn).toMatch(/^Enterprise Value N\/M$/m);
  expect(arvn).toContain("EV N/M: cash and short-term investments exceed market cap + total debt (balance sheet 2026-06-30).");
  expect(arvn).not.toContain("unavailable");
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

test("a US fund's report points to its fund facts; a fund listed elsewhere says it has none; a stock's says nothing", async () => {
  const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  const note = "Fund facts (fee, NAV, premium, net assets): fn ETF IBIT.";
  const ibit: TickerFinancials = { quote: { ...quote, symbol: "IBIT", instrumentType: "ETF", exchangeName: "NASDAQ" },
    annualStatements: [], quarterlyStatements: [], priceHistory: [] };
  expect(plain(renderFundamentalsReport({ ...ibit, symbol: "IBIT", exchange: "NASDAQ" }, "fundamentals")))
    .toContain(`No fundamentals reported for IBIT. ${note}`);
  expect(plain(await buildTickerReport({ symbol: "IBIT", tickerFile: null, financials: ibit, config, toBase: async value => value })))
    .toContain(note);
  const london: TickerFinancials = { ...ibit, quote: { ...ibit.quote!, symbol: "VUSA", exchangeName: "LSE" } };
  expect(plain(renderFundamentalsReport({ ...london, symbol: "VUSA", exchange: "LSE" }, "fundamentals")))
    .toContain("No fundamentals reported for VUSA. Fund facts (fee, NAV, premium) cover US-listed funds only.");
  expect(await report({ quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] })).not.toContain("Fund facts");
});

test("a bond fund's yield is its distribution yield, not its SEC yield, which follows it dated; --tax-rate adds the tax-equivalent section", async () => {
  const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
  const source = { source: "iShares" };
  const bondFund: FundBondFacts = {
    kind: "municipal", state: null,
    secYield: { value: 4.0418, asOf: "2026-10-15", ...source },
    yieldToWorst: { value: 4.16, asOf: "2026-10-15", ...source },
    duration: { value: 7.12591, asOf: "2026-10-15", measure: "effective", ...source },
  };
  const mub: TickerFinancials = { quote: { ...quote, symbol: "MUB", instrumentType: "ETF", exchangeName: "NYSEArca" },
    annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals: { dividendYield: 0.0327, dividendYieldBasis: "forward" } };
  const lines = [
    "Distribution Yield (forward, not SEC yield)  3.27%",
    "30-Day SEC Yield                             4.04% (as of 2026-10-15)",
    "Yield to Worst                               4.16% (as of 2026-10-15)",
    "Effective Duration                           7.13 yrs (as of 2026-10-15)",
  ];
  const fundamentals = plain(renderFundamentalsReport({ ...mub, symbol: "MUB", exchange: "NYSEArca", bondFund }, "fundamentals"));
  for (const line of lines) expect(fundamentals).toContain(line);
  expect(fundamentals).not.toContain("Tax-Equivalent Yield");
  const ticker = plain(await buildTickerReport({ symbol: "MUB", tickerFile: null, financials: mub, config, toBase: async value => value, bondFund }));
  for (const line of lines) expect(ticker).toContain(line);
  // valuation keeps the yield lines beside the multiples.
  expect(plain(renderFundamentalsReport({ ...mub, symbol: "MUB", bondFund }, "valuation"))).toContain("30-Day SEC Yield");

  const taxEquivalent = analyzeTaxEquivalent({ symbol: "MUB", bond: bondFund, rates: { federal: 40.8, state: null },
    treasury: [{ tenor: "7Y", years: 7, yield: 4.98, asOf: "2026-10-16" }] });
  const withTax = plain(renderFundamentalsReport({ ...mub, symbol: "MUB", bondFund, taxEquivalent }, "fundamentals"));
  expect(withTax).toContain([
    "Tax-Equivalent Yield",
    "Tax rate              40.8% (federal; no state rate given)",
    "Tax-equivalent yield  6.83% (30-day SEC yield 4.04% as of 2026-10-15 / (1 - 40.8%))",
    "Muni/Treasury ratio   81.2% (SEC yield 4.04% / 7Y Treasury 4.98% on 2026-10-16, the tenor nearest its 7.13-year duration)",
  ].join("\n"));
  const tables = fundamentalsReportTables({ ...mub, symbol: "MUB", bondFund, taxEquivalent }, "fundamentals",
    { source: "Gloom Cloud", asOf: null, status: "unreported" });
  expect(tables.tables.map((table) => table.title)).toContain("Tax-Equivalent Yield");

  // A stock, and a fund with no bond facts, keep the dividend yield line as it was.
  for (const financials of [{ ...mub, quote: { ...mub.quote!, instrumentType: "EQUITY" } }, mub]) {
    const text = plain(renderFundamentalsReport({ ...financials, symbol: "MUB" }, "fundamentals"));
    expect(text).toContain("Dividend Yield (forward)  3.27%");
    expect(text).not.toMatch(/SEC|Distribution Yield/);
  }
});

test("bond facts are read for a US-listed fund only, and a failed read leaves the yield as it was", async () => {
  const facts = { bond: { kind: "taxable" as const, state: null, secYield: null, yieldToWorst: null, duration: null } };
  const reads: string[] = [];
  const load = async (symbol: string) => { reads.push(symbol); return facts.bond; };
  const fund = { quote: { ...quote, instrumentType: "ETF" } };
  expect(await loadReportBondFacts("AGG", "NYSEArca", fund, null, load)).toEqual(facts.bond);
  expect(await loadReportBondFacts("NVDA", "NASDAQ", { quote: { ...quote, instrumentType: "EQUITY" } }, null, load)).toBeNull();
  expect(await loadReportBondFacts("VUSA", "LSE", fund, null, load)).toBeNull();
  expect(reads).toEqual(["AGG"]);
  expect(await loadReportBondFacts("AGG", "NYSEArca", fund, null, async () => { throw new Error("offline"); })).toBeNull();
});

// GLO-1106: with CAD as the base, ticker JNJ printed Market Cap "877.79B CAD" beside Revenue "99.33B USD" and Last "$259.43".
test("a CAD base writes every amount with its code and dates the rate a converted figure used", async () => {
  const cad = { ...createDefaultConfig("/tmp/gloom-ticker-units-unused"), baseCurrency: "CAD" };
  const asOf = Date.parse("2026-10-20T20:59:00Z");
  // USD per unit, as the cached FX query serves it.
  const usdPer: Record<string, number> = { USD: 1, CAD: 1 / 1.3854 };
  const toBase = createBaseConverter({
    getExchangeRate: async (code) => usdPer[code]!,
    getCachedQuery: ((_method: string, [code]: [string]) => ({
      load: async () => ({ value: usdPer[code]!, asOf, fetchedAt: asOf, staleAt: Infinity, expiresAt: Infinity, source: "fx" }),
    })) as never,
  }, "CAD");
  const jnj: TickerFinancials = {
    quote: { ...quote, symbol: "JNJ", price: 259.43, change: 5.57, changePercent: 2.19, open: 257.48, low: 256.42, high: 260.77, marketCap: 624.6e9 },
    annualStatements: [{ date: "2025-12-28", totalRevenue: 94.19e9, eps: 11.03, currency: "USD" }], quarterlyStatements: [], priceHistory: [],
    fundamentals: { marketCap: 624.6e9, marketCapCurrency: "USD", revenue: 99.33e9, eps: 6.54, financialCurrency: "USD" },
  };
  const text = (await buildTickerReport({ symbol: "JNJ", tickerFile: null, financials: jnj, config: cad, toBase }))
    .replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  expect(text).toContain("Last 259.43 USD");
  expect(text).toContain("Change +5.57 USD (+2.19%)");
  expect(text).toContain("Day Range 256.42 USD - 260.77 USD");
  expect(text).toContain("Market Cap 624.6B USD (865.32B CAD)");
  expect(text).toContain("EPS (TTM) 6.54 USD");
  expect(text).toContain("Revenue (TTM) 99.33B USD");
  expect(text).toContain("Diluted EPS 11.03 USD");
  expect(text).toContain("CAD figures at USD/CAD 1.3854, as of 2026-10-20 20:59 UTC.");
  // No amount is left with a bare dollar sign, which a Canadian reads as their own.
  expect(text).not.toMatch(/\$\d/);
  // A USD base keeps its signs and converts nothing.
  const usd = (await buildTickerReport({ symbol: "JNJ", tickerFile: null, financials: jnj, config, toBase: createBaseConverter({ getExchangeRate: async () => 1 }, "USD") }))
    .replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  expect(usd).toContain("Last $259.43");
  expect(usd).toContain("Market Cap 624.6B USD\n");
  expect(usd).not.toContain("figures at");
});

/** A converter on fixed USD rates, dated as the cached FX query dates them. */
function datedConverter(baseCurrency: string, usdPer: Record<string, number>, asOf: number) {
  return createBaseConverter({
    getExchangeRate: async (code) => usdPer[code]!,
    getCachedQuery: ((_method: string, [code]: [string]) => ({
      load: async () => ({ value: usdPer[code]!, asOf, fetchedAt: asOf, staleAt: Infinity, expiresAt: Infinity, source: "fx" }),
    })) as never,
  }, baseCurrency);
}

const plainReport = async (args: Parameters<typeof buildTickerReport>[0]) => (await buildTickerReport(args))
  .replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");

// GLO-1106 review: a market cap in pence went to the converter as pounds, 100 times too large.
test("a capitalization in a minor unit converts as that hundredth of its currency, and the rate names the currency", async () => {
  const asOf = Date.parse("2026-10-20T16:35:00Z");
  const vod: TickerFinancials = {
    // GBX, pence as the code is written in capitals: a capitalization in it is 100 times its figure in GBP.
    quote: { ...quote, symbol: "VOD", currency: "GBX", price: 118.7, marketCap: 2.75e12, exchangeName: "LSE" },
    annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals: { enterpriseValue: 5.1e12 },
  };
  const usd = await plainReport({ symbol: "VOD:LSE", tickerFile: null, financials: vod, config, toBase: datedConverter("USD", { USD: 1, GBP: 1.34 }, asOf) });
  expect(usd).toContain("Market Cap 2.75T GBX (36.85B USD)");
  expect(usd).toContain("Enterprise Value 5.1T GBX (68.34B USD)");
  expect(usd).toContain("USD figures at GBP/USD 1.34, as of 2026-10-20 16:35 UTC.");
  // In its own currency's base a figure in pence still reads in pounds, with no rate to state.
  const gbp = await plainReport({ symbol: "VOD:LSE", tickerFile: null, financials: vod, config: { ...config, baseCurrency: "GBP" },
    toBase: datedConverter("GBP", { USD: 1, GBP: 1.34 }, asOf) });
  expect(gbp).toContain("Market Cap 2.75T GBX (27.5B GBP)");
  expect(gbp).not.toContain("figures at");
});

// GLO-1106 review: a USD base read Toyota's rate as JPY/USD 0.0067; a lot bought at its own rate fell under the rate
// line, which the Positions section printed a second time.
test("the rate line reads as markets quote the pair, is printed once, and excepts a cost basis at the rate it was bought at", async () => {
  const asOf = Date.parse("2026-10-20T06:00:00Z");
  const toyota: TickerFinancials = {
    quote: { ...quote, symbol: "7203", currency: "JPY", price: 2850, marketCap: 4.2e13, exchangeName: "JPX" },
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
  };
  const jpy = await plainReport({ symbol: "7203:JPX", tickerFile: null, financials: toyota, config, toBase: datedConverter("USD", { USD: 1, JPY: 1 / 149.25 }, asOf) });
  expect(jpy).toContain("Market Cap 42T JPY (281.41B USD)");
  expect(jpy).toContain("USD figures at USD/JPY 149.25, as of 2026-10-20 06:00 UTC.");

  const cad = { ...config, baseCurrency: "CAD", portfolios: [{ id: "main", name: "Main Portfolio", currency: "CAD" }] };
  const lot = { portfolio: "main", shares: 10, avgCost: 200, currency: "USD", broker: "manual" };
  const jnj: TickerFinancials = { quote: { ...quote, symbol: "JNJ", price: 259.43, marketCap: 624.6e9 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
  const report = (positions: object[]) => plainReport({ symbol: "JNJ", financials: jnj, config: cad,
    tickerFile: createTestTicker("JNJ", "Johnson & Johnson", { exchange: "NYSE", portfolios: ["main"], positions: positions as never }),
    toBase: datedConverter("CAD", { USD: 1, CAD: 1 / 1.4 }, asOf) });
  const bought = await report([{ ...lot, costFxRate: 1.35, costFxCurrency: "CAD" }]);
  expect(bought).toContain("Cost Basis 2,700.00 CAD (1.35 CAD per USD when bought)");
  expect(bought).toContain("Market Value 3,632.02 CAD");
  expect(bought.match(/figures at/g)).toHaveLength(1);
  expect(bought).toContain("CAD figures at USD/CAD 1.4, as of 2026-10-20 06:00 UTC, except a cost basis at the rate it was bought at.");
  // Without a rate of its own the cost converts at the line's, which then covers every figure.
  const today = await report([lot]);
  expect(today).toContain("Cost Basis 2,800.00 CAD\n");
  expect(today.match(/figures at/g)).toHaveLength(1);
  expect(today).toContain("CAD figures at USD/CAD 1.4, as of 2026-10-20 06:00 UTC.");
});
