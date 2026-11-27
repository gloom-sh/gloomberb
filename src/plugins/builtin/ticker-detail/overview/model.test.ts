import { describe, expect, test } from "bun:test";
import type { Fundamentals, NextEarnings, Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerPosition, TickerRecord } from "../../../../types/ticker";
import { buildOverviewBeta, buildOverviewStats, buildPositionRows, buildProfileFields } from "./model";
import { buildRelationshipStatItems } from "../../correlation/relationship/view-model";
import { cashRunway } from "../../../../utils/cash-runway";
import type { FundBondFacts } from "../../../../api-client/fund-facts";
import { createTestTicker } from "../../../../test-support/ticker";
import { servedRatesNotMeaningful } from "../../../../utils/served-rates";
import { notMeaningfulColor } from "../../../../components/ui/not-meaningful";
import { createTestQuote } from "../../../../test-support/data-provider";
import { cryptoFixture } from "../../crypto-board/test-fixture";
import { regularSessionMarketCapitalization } from "../../../../market-data/quotes/regular-session-valuation";
import { marketCapBasisNote } from "../../../../utils/market-capitalization";
import { selectFinancialStatements } from "../financials/model";

const fiscalIncome = (date: string, revenue: number, netIncome: number) => ({ date, currency: "USD", totalRevenue: revenue * 1e6,
  operatingIncome: (netIncome + 1_000) * 1e6, netIncome: netIncome * 1e6, netIncomeCommonStockholders: (netIncome - 10) * 1e6,
  netIncomeIncludingNoncontrollingInterests: (netIncome + 150) * 1e6 });
const incomeStatements = {
  financialCurrency: "USD",
  annualStatements: [fiscalIncome("2025-12-31", 122_687, 2_348)],
  quarterlyStatements: [fiscalIncome("2025-12-31", 30_372, 1_197), fiscalIncome("2026-03-31", 36_000, 2_000),
    fiscalIncome("2026-06-30", 40_857, 2_925), fiscalIncome("2026-09-30", 46_098, 6_828)],
};
const incomeSummary = { financialCurrency: "USD", revenue: 146.529e9, netIncome: 12.91e9, profitMargin: 0.08834, freeCashFlow: 15.08e9 };
function overviewIncome(statements: typeof incomeStatements & Pick<TickerFinancials, "statementScope"> = incomeStatements,
  summary: TickerFinancials["fundamentals"] = incomeSummary) {
  return Object.fromEntries(buildOverviewStats({ quote: undefined, fundamentals: summary, financialCurrency: statements.financialCurrency,
    statementFinancials: statements, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value }).map((field) => [field.label, field]));
}

test("Overview prefers the complete income TTM shown by Financials, without using income to common or including NCI", () => {
  const [ttm] = selectFinancialStatements("annual", "income", incomeStatements.annualStatements, incomeStatements.quarterlyStatements).statements;
  expect(ttm).toMatchObject({ totalRevenue: 153_327e6, netIncome: 12_950e6, netIncomeCommonStockholders: 12_910e6 });
  for (const trailingPeriodEnd of [undefined, "2026-09-30"]) {
    const stats = overviewIncome(incomeStatements, { ...incomeSummary, trailingPeriodEnd });
    expect(stats.Revenue).toMatchObject({ value: "153.33B USD", detail: expect.arrayContaining(["TTM to 30 Sep 2026"]) });
    expect(stats["Net Income"]?.value).toBe("12.95B USD");
    expect(stats["Profit Marg"]?.value).toBe("8.45%");
    expect(stats.FCF?.value).toBe("15.08B USD");
  }
});

test("Overview retains its income figures across currency, scope, period, and missing-quarter mismatches", () => {
  const currency = overviewIncome(incomeStatements, { ...incomeSummary, financialCurrency: "CAD" });
  expect(currency.Revenue?.value).toBe("146.53B CAD");
  expect(currency["Net Income"]?.detail).toContain("Currency basis differs");
  expect(currency["Profit Marg"]?.value).toBe("8.83%");
  const unmatched = overviewIncome(incomeStatements, { ...incomeSummary, trailingPeriodEnd: "2026-06-30" });
  expect(unmatched.Revenue?.detail).toContain("TTM to 30 Jun 2026");
  expect(unmatched["Net Income"]?.detail).toContain("Different period");
  const predecessor = overviewIncome({ ...incomeStatements, statementScope: { registrant: "Previous issuer", basis: "predecessor", label: "Predecessor" } });
  expect(predecessor.Revenue?.value).toBe("146.53B USD");
  expect(predecessor["Net Income"]?.detail).toContain("Different scope");
  const incomplete = overviewIncome({ ...incomeStatements, quarterlyStatements: incomeStatements.quarterlyStatements.slice(1) });
  expect(incomplete.Revenue?.value).toBe("146.53B USD");
  expect(incomplete["Profit Marg"]?.value).toBe("8.83%");
});

test("GGAL's overview uses valuation's receipt-equivalent cap only on a matching basis", () => {
  const quote = createTestQuote({ symbol: "GGAL", marketState: "REGULAR", price: 25.08, marketCap: 4.35e9,
    currency: "USD", lastUpdated: Date.parse("2026-11-25T15:18:00Z") });
  const cap = (sharesOutstanding: number) => {
    const fundamentals = { sharesOutstanding };
    return { stats: buildOverviewStats({ quote, fundamentals, quoteCurrency: "USD", baseCurrency: "EUR", toBase: (value) => value,
      marketCapExchangeRates: new Map([["EUR", 1.25]]), depositaryReceipt: true }), cap: regularSessionMarketCapitalization({ quote, fundamentals }) };
  };
  const matched = cap(160.63e6);
  expect(matched.stats.find((stat) => stat.label === "Market Cap")).toMatchObject({ value: "4.03B USD", detail: "3.22B EUR" });
  expect(marketCapBasisNote(matched.cap)).toContain("4.35B USD");
  const other = cap(1.6063e9);
  expect(other.stats.find((stat) => stat.label === "Market Cap")).toMatchObject({ value: "4.35B USD" });
  expect(marketCapBasisNote(other.cap)).toContain("does not rest on the");
});

function overview(fundamentals: Fundamentals, financialCurrency?: string) {
  return Object.fromEntries(overviewFields(fundamentals, financialCurrency).map(({ label, value }) => [label, value]));
}

function overviewFields(fundamentals: Fundamentals, financialCurrency?: string) {
  return buildOverviewStats({
    quote: undefined, fundamentals, financialCurrency, quoteCurrency: "HKD", baseCurrency: "USD", toBase: (value) => value,
  });
}

test("coin board values fill the usual rows in the quote's format without duplicating them", () => {
  const coin = cryptoFixture().assets[0]!;
  const stats = (quote: Quote | undefined) => buildOverviewStats({
    quote, coin, fundamentals: { trailingPE: 25 }, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value,
  });
  const fallback = stats(undefined);
  expect(fallback.map(({ label }) => label)).toEqual(["Volume", "Market Cap", "Circ Supply", "Rank", "P/E (TTM)"]);
  expect(fallback[0]).toMatchObject({ value: "$5B", detail: "24h" });
  expect(fallback[1]!.value).toBe("1.00T USD");
  const quoted = stats(createTestQuote({ symbol: "BTC-USD", exchangeName: "CCC", volume: 6e9, marketCap: 2e12, statsBasis: "composite" }));
  expect(quoted.map(({ label }) => label)).toEqual(fallback.map(({ label }) => label));
  expect(quoted[0]).toMatchObject({ value: "$6B", detail: "composite" });
  expect(quoted[1]!.value).toBe("2.00T USD");
});

test("summary money with no sourced currency is bare, says so once, and never borrows the listing's", () => {
  const fundamentals: Fundamentals = {
    eps: 4.22, revenue: 1.22e12, netIncome: 85.7e9, freeCashFlow: -96.6e9,
    sharesOutstanding: 19.19e9, profitMargin: 0.0704, trailingPE: 25.3,
  };
  const original = structuredClone(fundamentals);
  expect(overview(fundamentals)).toMatchObject({
    EPS: "4.22", Revenue: "1.22T", "Net Income": "85.7B", FCF: "-96.6B",
    "Shares Out": "19.19B", "Profit Marg": "7.04%", "P/E (TTM)": "25.3",
  });
  expect(fundamentals).toEqual(original);
  // FCF has its own provenance, independent of the other amounts.
  expect(overviewFields(fundamentals).filter((field) => field.detail).map(({ label, detail }) => [label, detail]))
    .toEqual([["EPS", ["reporting currency not sourced", "currency not sourced"]], ["FCF", ["currency unknown"]]]);
  expect(overview({ ...fundamentals, financialCurrency: "CNY" })).toMatchObject({
    EPS: "CN¥4.22", Revenue: "1.22T CNY", "Net Income": "85.7B CNY", FCF: "-96.6B CNY",
  });
  expect(overview({ financialCurrency: " ", eps: 0, revenue: 0, netIncome: NaN, freeCashFlow: Infinity }))
    .toEqual({ "P/E (TTM)": "N/M", EPS: "0.00", Revenue: "0", "Net Income": "—", FCF: "—" });
  expect(overview({})).toEqual({});
});

test("summary money falls back to the statements' reporting currency, and a zero enterprise value is left out", () => {
  const figures = { eps: 31.43, revenue: 202.08e9, netIncome: 46.98e9, freeCashFlow: 36.96e9, enterpriseValue: 0 };
  // The quote's HKD never stands in: the statements' currency is the only fallback.
  expect(overview(figures, "ZAR")).toEqual({ EPS: "ZAR\u00a031.43", Revenue: "202.08B ZAR", "Net Income": "46.98B ZAR", FCF: "36.96B" });
  expect(overview({ ...figures, financialCurrency: "USD" }, "ZAR")).toMatchObject({ Revenue: "202.08B USD" });
  expect(overview(figures, " ")).toMatchObject({ EPS: "31.43", Revenue: "202.08B" });
  expect(overview({ ...figures, enterpriseValue: 5e9, marketCapCurrency: "HKD" }, "ZAR")).toMatchObject({ EV: "5B HKD" });
  // A listing quoted in another currency than the statements: an unlabelled block's currency is unknown.
  const listed = (currency: string, fundamentals: Fundamentals) => Object.fromEntries(buildOverviewStats({
    quote: { symbol: "YPFD", price: 8350, currency, change: 0, changePercent: 0, lastUpdated: 0 }, fundamentals, financialCurrency: "USD",
    quoteCurrency: currency, baseCurrency: "USD", toBase: (value) => value,
  }).map(({ label, value }) => [label, value]));
  expect(listed("ARS", figures)).toMatchObject({ EPS: "31.43", Revenue: "202.08B" });
  expect(listed("ARS", { ...figures, financialCurrency: "ARS" })).toMatchObject({ EPS: "ARS\u00a031.43", Revenue: "202.08B ARS" });
  expect(listed("USD", figures)).toMatchObject({ EPS: "$31.43", Revenue: "202.08B USD" });
  expect(listed("CAD", { ...figures, freeCashFlowCurrency: "USD", marketCapCurrency: "CAD" })).toMatchObject({ FCF: "36.96B USD" });
  expect(listed("USD", { ...figures, marketCapCurrency: "USD" })).toMatchObject({ FCF: "36.96B" });
});

test("an EV at or below zero reads N/M with why, and an insurer's says its investments stay in", () => {
  const ev = (fundamentals: Fundamentals) => buildOverviewStats({
    quote: undefined, fundamentals, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value,
  }).find((stat) => stat.label === "EV");
  const check = { currency: "USD", marketCap: 100e9, totalDebt: 1e9, balanceSheetDate: "2026-06-30" };
  // ARVN on 2026-10-23, and a source's negative EV no check judged.
  expect(ev({ marketCap: 100e9, unavailableFields: ["enterpriseValue"], enterpriseValueCheck: { ...check, status: "not-meaningful",
    cash: 121e9, computed: -20e9, reason: "Cash and short-term investments exceed market cap + total debt (balance sheet 2026-06-30)" } }))
    .toEqual({ label: "EV", value: "N/M", detail: ["cash > cap + debt", "cash > cap"] });
  expect(ev({ marketCap: 100e9, enterpriseValue: -5e9 })?.value).toBe("N/M");
  // BRK-B's: market cap + debt - cash and equivalents.
  expect(ev({ marketCap: 100e9, enterpriseValue: 107.8e9, enterpriseValueCheck: { ...check, status: "computed", source: -20e9,
    cash: 3.5e9, computed: 107.8e9, investmentsKept: true } }))
    .toEqual({ label: "EV", value: "107.8B USD", detail: ["investments in", "inv. in"] });
});

test("holdings and short interest read as fractions; blank, zero and past figures are left out", () => {
  const figures = (fundamentals: Fundamentals, nextEarnings?: NextEarnings) => Object.fromEntries(buildOverviewStats({
    quote: undefined, fundamentals, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value,
    nextEarnings, today: "2026-09-30",
  }).map(({ label, value, detail }) => [label, detail ? `${value} ${[detail].flat()[0]}` : value]));
  expect(figures({
    floatShares: 23.13e9, beta: 2.217, shortPercentOfFloat: 0.012719, shortRatio: 2.29,
    institutionPercentHeld: 0.71417, insiderPercentHeld: 0.04007, exDividendDate: "2026-09-10",
  }, { date: "2026-11-18", timing: "amc", timingSource: "history" })).toEqual({
    Float: "23.13B", "Short Float": "1.27% 2.3d to cover",
    "Inst Own": "71.42%", "Insider Own": "4.01%", "Ex-Dividend": "10 Sep", Earnings: "18 Nov AMC in 49d",
  });
  expect(figures({ floatShares: 0, beta: Number.NaN, exDividendDate: "" },
    { date: "2026-09-29", timing: null, timingSource: null })).toEqual({});
  expect(buildProfileFields({ profile: { employees: 0, website: "javascript:alert(1)", fiscalYearEnd: "13-31", sic: "" } }))
    .toEqual([]);
});

test("the DES and default GR betas show the same basis without falling back to the unqualified number", () => {
  const stats = { beta: 0.5962, alpha: 0, r: 0.34, rSquared: 0.116, stdError: 0, sampleSize: 250 };
  const overview = buildOverviewBeta(stats);
  const [regression] = buildRelationshipStatItems(stats, "1Y", "SPY");
  expect(overview).toMatchObject({ value: "0.596", detail: "1Y daily vs SPY" });
  expect(regression).toMatchObject({ value: overview!.value, detail: overview!.detail });
  expect(buildOverviewBeta(null)).toBeNull();
});

test("DES hides measurable beta until it has 200 paired daily returns", () => {
  expect(buildOverviewBeta({ beta: 0.5962, sampleSize: 5 })).toBeNull();
  expect(buildOverviewBeta({ beta: 0.5962, sampleSize: 199 })).toBeNull();
  expect(buildOverviewBeta({ beta: 0.5962, sampleSize: 200 })).toMatchObject({ value: "0.596", detail: "1Y daily vs SPY" });
});

test("declaring minor currency units preserves the reported amount and case-sensitive unit", () => {
  for (const financialCurrency of ["GBp", "GBX", "ILA", "ZAc"]) {
    expect(overview({ financialCurrency, eps: 100, revenue: 100, freeCashFlow: -100 }))
      .toEqual({ EPS: `100.00 ${financialCurrency}`, Revenue: `100 ${financialCurrency}`, FCF: `-100 ${financialCurrency}` });
  }
  expect(overview({ financialCurrency: "GBP", eps: 100, revenue: 100 }))
    .toEqual({ EPS: "£100.00", Revenue: "100 GBP" });
});

function row(position: Partial<TickerPosition>, options: {
  quotePrice?: number | null;
  quoteCurrency?: string;
  toBase?: (value: number, currency: string) => number;
} = {}) {
  const ticker: TickerRecord = createTestTicker("TEST", "Controlled position", {
    portfolios: ["test"],
    assetCategory: "STK",
    positions: [{ portfolio: "test", broker: "manual", shares: 10, avgCost: 100, ...position }],
  });
  const quotePrice = options.quotePrice === undefined ? 120 : options.quotePrice;
  return buildPositionRows({ ticker, quote: quotePrice == null ? undefined : { price: quotePrice } as Quote,
    quoteCurrency: options.quoteCurrency ?? "USD", baseCurrency: "USD",
    toBase: options.toBase ?? ((value) => value),
  })[0]!;
}

describe("position account names", () => {
  const aries = { portfolio: "broker:aries-1:5UA1234567", broker: "aries", brokerInstanceId: "aries-1", brokerAccountId: "5UA1234567" };
  const account = (position: Partial<TickerPosition>, accountNames: Parameters<typeof buildPositionRows>[0]["accountNames"]) => buildPositionRows({
    ticker: createTestTicker("TEST", "Controlled position", {
      portfolios: [position.portfolio ?? "test"],
      positions: [{ portfolio: "test", broker: "manual", shares: 10, avgCost: 100, ...position }],
    }),
    quote: undefined, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value, accountNames,
  })[0]!.account;

  test("a broker position reads as its portfolio's name, never the raw account id", () => {
    const portfolio = { id: aries.portfolio, name: "Aries individual (simulation)", brokerInstanceId: "aries-1", brokerAccountId: "5UA1234567" };
    expect(account(aries, { portfolios: [portfolio] })).toBe("Aries individual (simulation)");
    expect(account({ ...aries, side: "short" }, { portfolios: [portfolio] })).toBe("Aries individual (simulation) SHORT");
    // A portfolio restored from positions alone is named by its account id: the broker's own name for the account wins.
    const restored = { ...portfolio, name: "5UA1234567" };
    expect(account(aries, {
      portfolios: [restored],
      brokerAccounts: { "aries-1": [{ accountId: "5UA1234567", name: "Aries individual (simulation)" }] },
    })).toBe("Aries individual (simulation)");
    expect(account(aries, { portfolios: [restored], brokerInstances: [{ id: "aries-1", label: "Aries" }] })).toBe("Aries");
    expect(account(aries, { portfolios: [] })).toBe("aries");
  });

  test("a portfolio entered by hand keeps its own name", () => {
    expect(account({}, { portfolios: [{ id: "test", name: "Long term" }] })).toBe("Long term");
    expect(account({}, { portfolios: [] })).toBe("test");
  });
});

describe("research position valuation", () => {
  test("equivalent short conventions retain gross exposure but reverse price P&L", () => {
    const positive = row({ side: "short" });
    const negative = row({ shares: -10 });
    expect(positive).toEqual(negative);
    expect(positive).toMatchObject({ account: "test SHORT", qty: "-10 sh", cost: "$1,000.00", value: "$1,200.00", pnl: "-$200.00", ret: "-20.00%", pnlValue: -200 });
    expect(row({ side: "short" }, { quotePrice: 80 })).toMatchObject({ pnlValue: 200, ret: "+20.00%" });
    expect(row({})).toMatchObject({ qty: "10 sh", pnlValue: 200 });
  });

  test("without a current quote, broker signed and magnitude values agree and reported P&L wins", () => {
    const noQuote = { quotePrice: null };
    expect(row({ shares: -10, marketValue: -1200 }, noQuote)).toEqual(row({ shares: -10, marketValue: 1200 }, noQuote));
    expect(row({ shares: -10, marketValue: -1200 }, noQuote)).toMatchObject({ value: "$1,200.00", pnlValue: -200 });
    expect(row({ shares: -10, marketValue: -1200, unrealizedPnl: -175 }, noQuote)).toMatchObject({ pnlValue: -175, ret: "-17.50%", pnlBasis: "broker-snapshot" });
    expect(row({ shares: -10, markPrice: 80 }, noQuote)).toMatchObject({ mark: "$80.00", value: "$800.00", pnlValue: 200 });
  });

  test("current quote and known cost supersede broker snapshots, while unusable quotes preserve the snapshot", () => {
    const snapshot = { shares: -10, avgCost: 100, marketValue: -1100, markPrice: 110, unrealizedPnl: -75 };
    expect(row(snapshot)).toMatchObject({ mark: "$120.00", value: "$1,200.00", pnlValue: -200, ret: "-20.00%", pnlBasis: "quote-and-cost" });
    for (const quotePrice of [null, Number.NaN, Infinity]) {
      expect(row(snapshot, { quotePrice })).toMatchObject({ mark: "$110.00", value: "$1,100.00", pnlValue: -75, pnlBasis: "broker-snapshot" });
      expect(row({ ...snapshot, avgCost: undefined }, { quotePrice })).toMatchObject({ cost: "—", ret: "—", pnlValue: -75, pnlBasis: "broker-snapshot" });
    }
    expect(row({ ...snapshot, avgCost: undefined })).toMatchObject({ mark: "$120.00", value: "$1,200.00", pnlValue: -75, pnlBasis: "broker-snapshot" });
  });

  test("derivative marks use contract multipliers while broker costs may already be scaled", () => {
    expect(row({ shares: 2, side: "short", avgCost: 5, multiplier: 100 }, { quotePrice: 6 }))
      .toMatchObject({ qty: "-2 ct", cost: "$1,000.00", value: "$1,200.00", pnlValue: -200, ret: "-20.00%" });
    expect(row({ shares: -10, avgCost: 500, multiplier: 100, marketValue: -4000, unrealizedPnl: 1000 }, { quotePrice: null }))
      .toMatchObject({ cost: "$5,000.00", value: "$4,000.00", pnlValue: 1000, ret: "+20.00%" });
  });

  test("negative entry prices keep the P&L direction in the return denominator", () => {
    expect(row({ shares: 1, avgCost: -10, multiplier: 100 }, { quotePrice: -20 }))
      .toMatchObject({ cost: "-$1,000.00", value: "-$2,000.00", pnlValue: -1000, ret: "-100.00%" });
    expect(row({ shares: 1, side: "short", avgCost: -10, multiplier: 100 }, { quotePrice: -20 }))
      .toMatchObject({ pnlValue: 1000, ret: "+100.00%" });
  });

  test("position cost and quote marks use their own currencies before signed P&L", () => {
    const toBase = (value: number, currency: string) => currency === "EUR" ? value * 1.2 : value;
    expect(row({ side: "short", currency: "EUR" }, { quotePrice: 130, toBase }))
      .toMatchObject({ cost: "$1,200.00", value: "$1,300.00", pnlValue: -100, ret: "-8.33%" });
    expect(row({ side: "short", currency: "EUR", markPrice: 110 }, { quotePrice: null, toBase }))
      .toMatchObject({ cost: "$1,200.00", value: "$1,320.00", pnlValue: -120, ret: "-10.00%" });
  });

  test("missing FX or marks never produce a valid-looking P&L", () => {
    const toBase = (value: number, currency: string) => currency === "USD" ? value : Number.NaN;
    expect(row({ side: "short", currency: "EUR" }, { toBase }))
      .toMatchObject({ cost: "—", value: "$1,200.00", pnl: "—", ret: "—", pnlValue: null });
    expect(row({ side: "short", currency: "EUR", markPrice: 110 }, { toBase }))
      .toMatchObject({ cost: "—", value: "$1,200.00", pnl: "—", ret: "—", pnlValue: null });
    expect(row({ side: "short", currency: "EUR", markPrice: 110 }, { toBase, quotePrice: null }))
      .toMatchObject({ cost: "—", value: "—", pnl: "—", ret: "—", pnlValue: null });
    expect(row({ side: "short" }, { quotePrice: null }))
      .toMatchObject({ cost: "$1,000.00", mark: "—", value: "—", pnlValue: null });
  });
});

test("a bond fund's yield is its distribution yield, not its SEC yield, which follows it dated with its yield to worst and duration", () => {
  const source = { source: "iShares", url: "https://www.ishares.com/us/products/239766/ishares-national-muni-bond-etf" };
  const stats = (bond: FundBondFacts | null) => buildOverviewStats({
    quote: undefined, fundamentals: { dividendYield: 0.0327, dividendYieldBasis: "forward" }, quoteCurrency: "USD", baseCurrency: "USD",
    toBase: (value) => value, bond,
  }).map(({ label, value, detail, link }) => ({ label, value, detail, link: link?.templateId }));
  expect(stats({
    kind: "municipal", state: null,
    secYield: { value: 4.0418, asOf: "2026-10-15", ...source },
    yieldToWorst: { value: 4.16, asOf: "2026-10-15", ...source },
    duration: { value: 7.12591, asOf: "2026-10-15", measure: "effective", ...source },
  })).toEqual([
    { label: "Fwd Dist Yld", value: "3.27%", detail: ["not SEC yield", "not SEC"], link: undefined },
    { label: "SEC Yield", value: "4.04%", detail: ["2026-10-15", "10-15"], link: "sec-etf-pane" },
    { label: "Yld to Worst", value: "4.16%", detail: ["2026-10-15", "10-15"], link: "sec-etf-pane" },
    { label: "Eff Duration", value: "7.13 yrs", detail: ["2026-10-15", "10-15"], link: "sec-etf-pane" },
  ]);
  // Vanguard's month-end average duration, and no yield to worst.
  expect(stats({
    kind: "municipal", state: null, yieldToWorst: null,
    secYield: { value: 4.36, asOf: "2026-10-15", source: "Vanguard" },
    duration: { value: 7.3, asOf: "2026-09-30", measure: "average", source: "Vanguard" },
  }).slice(1)).toEqual([
    { label: "SEC Yield", value: "4.36%", detail: ["2026-10-15", "10-15"], link: "sec-etf-pane" },
    { label: "Avg Duration", value: "7.30 yrs", detail: ["2026-09-30 month-end", "09-30 month-end"], link: "sec-etf-pane" },
  ]);
  // Anything else reads as before.
  expect(stats(null)).toEqual([{ label: "Fwd Div Yld", value: "3.27%", detail: undefined, link: undefined }]);
});


test("DES omits runway for a cash-generating TTM and shows quarter-only burn without inventing a TTM", () => {
  const quarters = ["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"].map((date, index) => ({
    date, currency: "USD", cashAndCashEquivalents: 1_000, capitalExpenditure: 0, operatingCashFlow: index === 3 ? -30 : 20,
  }));
  const stats = (quarterlyStatements: typeof quarters) => buildOverviewStats({
    quote: undefined, fundamentals: {}, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value,
    runway: cashRunway({ quarterlyStatements, annualStatements: [] }),
  });
  expect(stats(quarters).find((row) => row.label === "Runway")).toBeUndefined();
  expect(stats(quarters.slice(1)).find((row) => row.label === "Runway")).toMatchObject({ value: "100.0 mo", detail: expect.arrayContaining(["qtr"]) });
  expect(stats(quarters.slice(0, 3)).find((row) => row.label === "Runway")).toBeUndefined();
  const burning = quarters.map((row) => ({ ...row, operatingCashFlow: -20 }));
  expect(stats(burning).find((row) => row.label === "Runway")).toMatchObject({
    value: "> 120 mo", detail: expect.arrayContaining(["qtr to 30 Jun · TTM > 120 mo"]),
  });
});

test("DES reads a margin over revenue at or below zero, and growth off it, N/M in N/M's colour, as RV and ticker do", () => {
  const fundamentals: Fundamentals = { marketCap: 1e9, revenue: -2e6, operatingMargin: 41.5, profitMargin: 38.2, revenueGrowth: 4 };
  const quarterlyStatements = [{ date: "2025-06-30", totalRevenue: -4e6 }, { date: "2026-06-30", totalRevenue: 12e6 }];
  const notMeaningful = servedRatesNotMeaningful(fundamentals, { quarterlyStatements });
  expect(Object.keys(notMeaningful).sort()).toEqual(["lastQuarterGrowth", "operatingMargin", "profitMargin", "revenueGrowth"]);
  const stats = buildOverviewStats({ quote: undefined, fundamentals, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value, notMeaningful });
  for (const label of ["Op Margin", "Profit Marg", "Rev Growth"]) {
    expect(stats.find((stat) => stat.label === label)).toEqual({ label, value: "N/M", valueColor: notMeaningfulColor() });
  }
  // Revenue above zero, now and a year earlier: the figures stand.
  const healthy = { ...fundamentals, revenue: 40e6, operatingMargin: 0.12, profitMargin: 0.08, revenueGrowth: 0.5 };
  expect(servedRatesNotMeaningful(healthy, { quarterlyStatements: [{ date: "2025-06-30", totalRevenue: 8e6 }, ...quarterlyStatements.slice(1)] })).toEqual({});
  const shown = buildOverviewStats({ quote: undefined, fundamentals: healthy, quoteCurrency: "USD", baseCurrency: "USD", toBase: (value) => value });
  expect(shown.find((stat) => stat.label === "Op Margin")?.value).toBe("12.00%");
  expect(shown.find((stat) => stat.label === "Rev Growth")?.value).toBe("+50.00%");
});
