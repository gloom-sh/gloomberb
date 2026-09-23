import { afterEach, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { loadYahooCorporateActions } from "../../../sources/yahoo-finance/quote-summary";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { HeadlessBundleResult, HeadlessPaneContext } from "../../../types/plugin";
import type { ChartResult } from "../../../sources/yahoo-finance/types";
import { createDividendYieldHeadless } from "./headless";
import { fetchDividendData, INCOMPLETE_DIVIDEND_HISTORY, MISSING_DIVIDEND_CURRENCY, INVALID_DIVIDEND_SUMMARY_DATE, UNAVAILABLE_DIVIDEND_SUMMARY } from "./client";
import { fetchProviderDividendData } from "./provider-client";
import { renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";

const day = new Date(new Date().toISOString().slice(0, 10)).getTime() / 1000;
const recent = day - 10 * 86400 + 14 * 3600;
const cash = { date: recent, amount: 4 };
const request = { argument: "CASHFUND", symbols: ["CASHFUND"], options: {} };
const context = { marketData: { getQuote: async () => ({ symbol: "CASHFUND", price: 100, currency: "USD", lastUpdated: day * 1000 }) } } as HeadlessPaneContext;

afterEach(() => setHttpFetchTransport(null));

function nativeSource(currency: string | undefined, dividends: Record<string, unknown>, summaryDetail: Record<string, unknown> = {}, chartFails = false) {
  setHttpFetchTransport(async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    if (url.includes("/chart/")) {
      if (chartFails) throw new Error("Controlled history unavailable");
      return Response.json({ chart: { result: [{
        meta: { currency, exchangeTimezoneName: "America/New_York", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo" },
        timestamp: [day], indicators: { quote: [{ close: [100] }] }, events: { dividends },
      }] } });
    }
    if (url.includes("/quoteSummary/")) return Response.json({ quoteSummary: { result: [{ summaryDetail }] } });
    throw new Error(`Unexpected controlled request: ${url}`);
  });
}

function metric(result: HeadlessBundleResult, label: string) {
  const section = result.sections[0]!;
  return "entries" in section ? section.entries.find((entry) => entry.label === label)?.value : undefined;
}

test("invalid summary dates cannot break reports or invalidate independent cash and forward rates", async () => {
  const definition = createDividendYieldHeadless();
  for (const field of ["exDividendDate", "dividendDate"] as const) {
    for (const invalid of [1e20, -1e20, 8.64e12]) {
      const validDate = day + 20 * 86400;
      nativeSource("USD", { cash }, { currency: "USD", dividendRate: { raw: 20 },
        exDividendDate: { raw: validDate }, dividendDate: { raw: validDate }, [field]: { raw: invalid } });
      const result = await definition.load(request, context);
      expect(result).toMatchObject({ complete: false, errors: [INVALID_DIVIDEND_SUMMARY_DATE],
        metadata: { historyAvailable: true, historyError: null, summaryError: INVALID_DIVIDEND_SUMMARY_DATE } });
      expect(metric(result, field === "exDividendDate" ? "Next ex-dividend" : "Next pay")).toBeNull();
      expect(metric(result, field === "exDividendDate" ? "Next pay" : "Next ex-dividend")).toEqual(new Date(validDate * 1000));
      expect(metric(result, "Trailing rate")).toBe(4);
      expect(metric(result, "Forward rate")).toBe(20);
      expect(renderHeadlessPaneText(definition, result, request, "DVD")).toContain(INVALID_DIVIDEND_SUMMARY_DATE);
      expect(JSON.parse(JSON.stringify(serializeHeadlessPaneResult(definition, result)))).toMatchObject({
        errors: [INVALID_DIVIDEND_SUMMARY_DATE], metadata: { summaryError: INVALID_DIVIDEND_SUMMARY_DATE },
      });
    }
  }
  nativeSource("USD", { cash }, { currency: "USD", exDividendDate: { raw: 0 } });
  const epoch = await definition.load(request, context);
  expect(metric(epoch, "Next ex-dividend")).toBeNull();
  expect(epoch.metadata?.summaryError).toBeNull();
});

test("independent summary transport and provider-body failures keep known cash and mark the report incomplete", async () => {
  let failure: "transport" | "provider-body" = "transport";
  setHttpFetchTransport(async (url) => {
    if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
    if (url.includes("getcrumb")) return new Response("fixture");
    if (url.includes("/chart/")) return Response.json({ chart: { result: [{
      meta: { currency: "USD", regularMarketPrice: 100, regularMarketTime: day, dataGranularity: "1mo" },
      timestamp: [day], indicators: { quote: [{ close: [100] }] }, events: { dividends: { cash } },
    }] } });
    if (url.includes("/quoteSummary/")) {
      if (failure === "transport") throw new Error("Controlled summary unavailable");
      return Response.json({ quoteSummary: { result: null, error: { description: "Controlled provider failure" } } });
    }
    throw new Error(`Unexpected controlled request: ${url}`);
  });
  const definition = createDividendYieldHeadless();
  for (const mode of ["transport", "provider-body"] as const) {
    failure = mode;
    const result = await definition.load(request, context);
    expect(result).toMatchObject({ complete: false, errors: [UNAVAILABLE_DIVIDEND_SUMMARY],
      metadata: { historyAvailable: true, summaryError: UNAVAILABLE_DIVIDEND_SUMMARY } });
    expect(metric(result, "Trailing rate")).toBe(4);
    expect(metric(result, "Next pay")).toBeNull();
    expect(metric(result, "Forward rate")).toBeNull();
    expect(renderHeadlessPaneText(definition, result, request, "DVD").split(UNAVAILABLE_DIVIDEND_SUMMARY)).toHaveLength(2);
  }
});

test("native cash requires its own denomination, and summary rates retain independent currency coverage", async () => {
  const definition = createDividendYieldHeadless();
  for (const currency of [undefined, "", "  "]) {
    nativeSource(currency, { cash }, { currency: "GBP" });
    expect(await definition.load(request, context)).toMatchObject({ complete: false, errors: [MISSING_DIVIDEND_CURRENCY], metadata: { historyAvailable: false } });
  }
  nativeSource(undefined, { cash });
  expect(await definition.load(request, context)).toMatchObject({ complete: false, errors: [MISSING_DIVIDEND_CURRENCY], metadata: { historyAvailable: false } });
  nativeSource("USD", { cash }, { dividendRate: { raw: 20 } });
  const cashOnly = await definition.load(request, context);
  expect(metric(cashOnly, "Trailing rate")).toBe(4);
  expect(metric(cashOnly, "Forward rate")).toBeNull();
  nativeSource(undefined, {}, { trailingAnnualDividendRate: { raw: 4 } }, true);
  expect(await definition.load(request, context)).toMatchObject({ complete: false, errors: [MISSING_DIVIDEND_CURRENCY], metadata: { historyAvailable: false } });
  nativeSource(undefined, {}, { currency: "USD", trailingAnnualDividendRate: { raw: 4 }, dividendRate: { raw: 20 } }, true);
  const summaryOnly = await definition.load(request, context);
  expect(summaryOnly.metadata).toMatchObject({ currency: "USD", historyAvailable: false });
  expect(metric(summaryOnly, "Trailing rate")).toBe(4);
  expect(metric(summaryOnly, "Forward rate")).toBe(20);
  nativeSource("GBp", { cash: { ...cash, amount: 203 } });
  const pence = await fetchDividendData("CASHFUND", 10, "", "GBP");
  expect(pence.payments[0]).toMatchObject({ amount: 2.03, currency: "GBP" });
  expect(pence.metrics.trailingYield).toBeCloseTo(0.203, 12);
});

test("native partial history retains valid rows and indicated forward cash without presenting an incomplete total", async () => {
  const definition = createDividendYieldHeadless();
  for (const invalid of [{ date: recent }, { date: 1e20, amount: 9 }]) {
    nativeSource("USD", { cash, old: { date: recent - 3 * 365 * 86400, amount: 1 }, invalid }, {
      currency: "USD", trailingAnnualDividendRate: { raw: 0 }, dividendRate: { raw: 20 },
    });
    const result = await definition.load(request, context);
    expect(result.metadata).toMatchObject({ historyAvailable: false, historyError: INCOMPLETE_DIVIDEND_HISTORY });
    const history = result.sections[1]!;
    expect("rows" in history ? history.rows.map((row) => row.amount) : []).toEqual([4, 1]);
    expect(["Trailing rate", "Trailing yield", "1Y Cash Growth", "3Y Cash CAGR", "Frequency"].map((label) => metric(result, label))).toEqual([null, null, null, null, null]);
    expect(metric(result, "Forward rate")).toBe(20);
    expect(metric(result, "Forward yield")).toBe(0.2);
    const serialized = JSON.parse(JSON.stringify(serializeHeadlessPaneResult(definition, result)));
    expect(serialized.metadata.historyAvailable).toBe(false);
    expect(serialized.sections[1].rows).toHaveLength(2);
    const text = renderHeadlessPaneText(definition, result, request, "DVD");
    expect(text).toContain(INCOMPLETE_DIVIDEND_HISTORY);
    expect(text).not.toContain("4.00%");
    nativeSource("USD", { invalid });
    expect(await definition.load(request, context)).toMatchObject({ complete: false, errors: [INCOMPLETE_DIVIDEND_HISTORY], metadata: { historyAvailable: false } });
  }
  nativeSource("USD", {});
  const empty = await definition.load(request, context);
  expect(empty.metadata.historyAvailable).toBe(true);
  expect(metric(empty, "Trailing rate")).toBe(0);
  expect(metric(empty, "Trailing yield")).toBe(0);
});

test("Yahoo corporate-action coverage survives the actual provider dividend projection without losing valid cash rows", async () => {
  for (const events of [{ cash, invalid: { date: recent } }, { invalid: { date: recent } }, {}]) {
    const actions = await loadYahooCorporateActions({ ticker: "CASHFUND", providerId: "yahoo-fixture",
      fetchChart: async () => ({ meta: { currency: "USD", exchangeTimezoneName: "America/New_York" }, events: { dividends: events as NonNullable<ChartResult["events"]>["dividends"] } }),
      fetchJsonWithCrumb: async () => { throw new Error("Independent earnings unavailable"); },
    });
    const hasInvalid = "invalid" in events;
    expect(actions.coverage?.dividends).toBe(hasInvalid ? "unavailable" : "available");
    const definition = createDividendYieldHeadless({ loadData: () => fetchProviderDividendData(createTestDataProvider({
      getCorporateActions: async () => actions,
      getQuote: context.marketData.getQuote,
    }), "CASHFUND", null) });
    if (hasInvalid && !("cash" in events)) {
      expect(await definition.load(request, context)).toMatchObject({ complete: false, errors: [expect.stringContaining("Dividend history is unavailable")], metadata: { historyAvailable: false } });
    } else {
      const result = await definition.load(request, context);
      expect(result.metadata.historyAvailable).toBe(!hasInvalid);
      expect(metric(result, "Trailing rate")).toBe(hasInvalid ? null : 0);
      const section = result.sections[1]!;
      expect("rows" in section ? section.rows : []).toHaveLength(hasInvalid ? 1 : 0);
    }
  }
});

test("provider partial rows do not acquire complete totals or a missing cash currency from the quote", async () => {
  const actions = { symbol: "CASHFUND", currency: "USD", coverage: { dividends: "available" as const }, dividends: [
    { exDate: new Date(recent * 1000).toISOString().slice(0, 10), amount: 4 },
    { exDate: "2026-02-30", amount: 9 },
  ], splits: [], earnings: [] };
  const provider = createTestDataProvider({ getCorporateActions: async () => actions, getQuote: context.marketData.getQuote });
  const data = await fetchProviderDividendData(provider, "CASHFUND", null);
  expect(data).toMatchObject({ historyAvailable: false, historyError: INCOMPLETE_DIVIDEND_HISTORY, metrics: { trailingRate: null, trailingYield: null, paymentFrequency: null } });
  expect(data.payments).toHaveLength(1);
  for (const currency of [undefined, "  "]) {
    expect(await fetchProviderDividendData(createTestDataProvider({
      getCorporateActions: async () => ({ ...actions, currency }), getQuote: context.marketData.getQuote,
    }), "CASHFUND", null)).toMatchObject({ historyAvailable: false, historyError: MISSING_DIVIDEND_CURRENCY, payments: [], metrics: { trailingRate: null, trailingYield: null } });
  }
});

test("reported future ex-dates and payment dates stay distinct and cannot become trailing cash or a projected per-payment amount", async () => {
  const futureEx = day + 20 * 86400;
  const futurePay = day + 35 * 86400;
  nativeSource("USD", { cash, announced: { date: futureEx + 14 * 3600, amount: 5 } }, {
    currency: "USD", exDividendDate: { raw: futureEx }, dividendDate: { raw: futurePay }, dividendRate: { raw: 20 },
  });
  const definition = createDividendYieldHeadless();
  const result = await definition.load(request, context);
  expect(metric(result, "Trailing rate")).toBe(4);
  expect(metric(result, "Forward rate")).toBe(20);
  expect(metric(result, "Next ex-dividend")).toEqual(new Date(futureEx * 1000));
  expect(metric(result, "Last ex-dividend")).toEqual(new Date((day - 10 * 86400) * 1000));
  expect(metric(result, "Next pay")).toEqual(new Date(futurePay * 1000));
  const history = result.sections[1]!;
  expect("rows" in history ? history.rows : []).toMatchObject([
    { exDate: new Date(futureEx * 1000).toISOString().slice(0, 10), amount: 5, paymentDate: null, declarationDate: null },
    { amount: 4, paymentDate: null, declarationDate: null },
  ]);
  nativeSource("USD", { cash }, { currency: "USD", dividendDate: { raw: day - 86400 } });
  const noSchedule = await definition.load(request, context);
  expect(metric(noSchedule, "Next pay")).toBeNull();
  expect(metric(noSchedule, "Forward rate")).toBeNull();
});

test("an independently qualified forward rate survives unusable chart history without borrowing chart units or filling cash totals", async () => {
  const definition = createDividendYieldHeadless();
  for (const kind of ["history-fails", "all-invalid", "unknown-currency"] as const) {
    nativeSource(kind === "unknown-currency" ? undefined : "USD", kind === "all-invalid" ? { invalid: { date: recent } } : { cash },
      { currency: "USD", dividendRate: { raw: 20 } }, kind === "history-fails");
    const result = await definition.load(request, context);
    expect(metric(result, "Forward rate")).toBe(20);
    expect(metric(result, "Forward yield")).toBe(0.2);
    expect(metric(result, "Trailing rate")).toBeNull();
    expect(result.metadata).toMatchObject({ historyAvailable: false, currency: "USD" });
    expect(result.sections[1]?.rows).toEqual([]);
    if (kind !== "history-fails") expect(result.complete).toBe(false);
  }
  // The same raw chart price cannot establish a denominator without chart units.
  nativeSource(undefined, { cash }, { currency: "USD", dividendRate: { raw: 20 } });
  const noIndependentQuote = await definition.load(request, { marketData: { getQuote: async () => { throw new Error("No quote"); } } } as unknown as HeadlessPaneContext);
  expect(metric(noIndependentQuote, "Forward rate")).toBe(20);
  expect(metric(noIndependentQuote, "Forward yield")).toBeNull();
  expect(metric(noIndependentQuote, "Price")).toBeNull();
  expect(noIndependentQuote.metadata.priceAsOf).toBeNull();
});
