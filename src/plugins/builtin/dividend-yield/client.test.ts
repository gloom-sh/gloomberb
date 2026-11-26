import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { buildDividendMetrics, fetchDividendData, repriceDividendMetrics, toDividendPayment } from "./client";
import { combinedPaymentTimes, dividendReferencePrice } from "../../../utils/trailing-dividend";
import type { DividendPayment } from "./types";
import type { DividendSummary } from "../../../api-client/market-discovery";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { createDividendYieldHeadless, projectDividendYieldHeadless } from "./headless";
import { chartResponse, hsbcIssuerDividendRead, marketTransport, summaryFields } from "./test-fixture";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { formatDay } from "../../../utils/day-format";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";

afterEach(() => { setHttpFetchTransport(null); setSystemTime(); });

const now = new Date("2026-09-10T12:00:00Z");
function payment(date: string, amount = 0.5, currency = "USD"): DividendPayment {
  return toDividendPayment(date, amount, currency)!;
}

describe("cash distribution calculations", () => {
  test.each(["GBP", "GBp"])("%s HSBC ex-dated unfixed cash supersedes last November and dates both estimated rates", async (currency) => {
    setSystemTime(new Date("2026-11-17T06:00:00Z"));
    let fixedCash: number | undefined;
    setHttpFetchTransport(async () => Response.json({ status: "success", data: hsbcIssuerDividendRead(currency, fixedCash) }));
    const data = await fetchDividendData("HSBA", 13.38, "LSE", "GBP");
    expect(data.payments).toHaveLength(8);
    expect(data.payments[0]).toMatchObject({ exDate: new Date("2026-11-05"), amount: 0.075835,
      paymentDate: new Date("2026-12-17"), declared: { amount: 0.1, currency: "USD" },
      cashEstimate: { declaredCurrency: "USD", declaredAmount: 0.1, fixingDate: "2026-12-07" } });
    const expected = 0.075835 + 0.074134 + 0.074489 + 0.333016;
    expect(data.metrics.trailingRate).toBeCloseTo(expected, 10);
    expect(data.metrics.forwardRate).toBeCloseTo(expected, 10);
    expect(data.metrics.trailingYield).toBeCloseTo(expected / 13.38, 10);
    expect(data.metrics.forwardYield).toBeCloseTo(expected / 13.38, 10);
    expect(data.metrics).toMatchObject({ forwardBasis: "uneven", forwardRateAsOf: "2026-11-05",
      forwardEstimate: { declaredAmount: 0.1, fixingDate: "2026-12-07" },
      trailingEstimates: [{ declaredAmount: 0.1, fixingDate: "2026-12-07" }] });
    const request = { rawArgument: "HSBA:LSE", argument: "HSBA:LSE", symbols: ["HSBA:LSE"], options: { limit: "3" } };
    const result = projectDividendYieldHeadless(data, request);
    expect(result.metadata).toMatchObject({ forwardRateAsOf: "2026-11-05", declaredDividends: [{ exDate: "2026-11-05" }],
      trailingRateEstimates: [{ fixingDate: "2026-12-07" }] });
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), result, request, "DVD");
    expect(text).toContain(currency === "GBp" ? "estimated 7.5835p" : "estimated £0.075835");
    expect(text).toContain("$0.10");
    // The four figures the estimate reaches say estimated, with their own context; the estimate is named once.
    const line = (label: string) => text.split("\n").find((entry) => entry.startsWith(`${label} `))!;
    expect(line("Trailing yield")).toContain("4.17% estimated (last 12 months of distributions)");
    expect(line("Forward yield")).toContain("4.17% estimated (trailing regular payments: uneven interims)");
    expect(line("Trailing rate")).toMatch(/ estimated \(converted from USD\)$/);
    expect(line("Forward rate")).toContain(" estimated (converted from USD) (trailing regular payments: uneven interims)");
    expect(line("Frequency")).not.toContain("estimated");
    expect(line("Estimated")).toMatch(/^Estimated\s+\$0\.10 declared, FX fixing 07 Dec 2026$/);
    expect(text.match(/FX fixing/g)).toHaveLength(1);
    expect(text).not.toContain("estimated from");
    // JSON keeps its numbers and its structured provenance, and none of the text's marks.
    const entries = (result.sections[0] as { entries: { label: string; value: unknown; formatted?: string }[] }).entries;
    expect(entries.find((entry) => entry.label === "Trailing rate")!.value).toBeCloseTo(expected, 10);
    expect(entries.find((entry) => entry.label.startsWith("Forward rate"))!.value).toBeCloseTo(expected, 10);
    expect(JSON.stringify(entries)).not.toMatch(/estimated/i);
    expect(result.metadata).toMatchObject({ forwardRateEstimate: { declaredCurrency: "USD", declaredAmount: 0.1, fixingDate: "2026-12-07", basis: expect.any(String) } });
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { ...hsbcIssuerDividendRead(currency), summary: null } }));
    const noSummary = await fetchDividendData("HSBA", 13.38, "LSE", "GBP");
    expect(noSummary.metrics.forwardRate).toBeCloseTo(expected, 10);
    expect(noSummary.metrics.forwardEstimate?.fixingDate).toBe("2026-12-07");
    expect(noSummary.summaryError).not.toContain("no forward rate");
    setHttpFetchTransport(async () => Response.json({ status: "success", data: hsbcIssuerDividendRead(currency, fixedCash) }));
    setSystemTime(new Date("2026-11-04T06:00:00Z"));
    const beforeEx = await fetchDividendData("HSBA", 13.38, "LSE", "GBP");
    expect(beforeEx.payments).toHaveLength(7);
    expect(beforeEx.metrics.trailingEstimates).toBeUndefined();
    setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const justEx = await fetchDividendData("HSBA", 13.38, "LSE", "GBP");
    expect(justEx.metrics.trailingRate).toBeCloseTo(expected, 10);
    setSystemTime(new Date("2026-12-07T12:00:00Z"));
    fixedCash = 0.076;
    const fixed = await fetchDividendData("HSBA", 13.38, "LSE", "GBP");
    expect(fixed.payments).toHaveLength(8);
    expect(fixed.payments[0]?.cashEstimate).toBeUndefined();
    expect(fixed.metrics.forwardEstimate).toBeUndefined();
    expect(fixed.metrics.trailingEstimates).toBeUndefined();
    expect(fixed.metrics.trailingRate).toBeCloseTo(expected - 0.075835 + 0.076, 10);
    const fixedRequest = { rawArgument: "HSBA:LSE", argument: "HSBA:LSE", symbols: ["HSBA:LSE"], options: { limit: "3" } };
    const fixedText = renderHeadlessPaneText(createDividendYieldHeadless(), projectDividendYieldHeadless(fixed, fixedRequest), fixedRequest, "DVD");
    expect(fixedText).not.toMatch(/estimated|FX fixing/i);
  });
  test.each(["GBP", "GBp"])("%s history and an unfixed declaration retain units, dates and forward provenance", async (currency) => {
    const divisor = currency === "GBp" ? 100 : 1;
    setSystemTime(new Date("2026-11-17T06:00:00Z"));
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: {
      currency: "GBP", trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      forwardAnnualDividendRate: 0.03941926, forwardRateAsOf: "2026-11-19", exDividendDate: null, dividendDate: null,
    }, actions: {
      symbol: "VOD", currency, coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-06-04", amount: 0.0201294 * divisor, payDate: "2026-07-30" }, { exDate: "2025-11-20", amount: 0.0195116 * divisor }],
      declaredCash: { currency: "EUR", rows: [{ exDate: "2026-06-04", amount: 0.023625 }],
        announced: { exDate: "2026-11-19", payDate: "2027-02-03", amount: 0.02306, fixingDate: "2027-01-27" } },
    } } }));
    const data = await fetchDividendData("VOD", 1.177, "LSE", "GBP");
    expect(data.payments[0]).toMatchObject({ amount: 0.0201294, paymentDate: new Date("2026-07-30"), declared: { amount: 0.023625, currency: "EUR" } });
    expect(data.metrics).toMatchObject({ nextExDividendDate: new Date("2026-11-19"), nextPayDate: new Date("2027-02-03"),
      forwardEstimate: { declaredAmount: 0.02306, declaredCurrency: "EUR", fixingDate: "2027-01-27" } });
    expect(data.metrics.forwardRate).toBeCloseTo(0.03941926, 10);
    expect(data.metrics.forwardYield).toBeCloseTo(0.03941926 / 1.177, 10);
    const request = { rawArgument: "VOD:LSE", argument: "VOD:LSE", symbols: ["VOD:LSE"], options: {} };
    const result = projectDividendYieldHeadless(data, request);
    expect(result.metadata).toMatchObject({ forwardRateEstimate: { declaredCurrency: "EUR" }, nextPayDateStatus: "announced" });
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), result, request, "DVD");
    // A ten-thousandth of a penny in either unit: 2.0129p is £0.020129.
    expect(text).toContain(currency === "GBp" ? "2.0129p" : "£0.020129");
    // Only the forward figures rest on the unfixed declaration: the history's yield is not marked.
    const line = (label: string) => text.split("\n").find((entry) => entry.startsWith(`${label} `))!;
    expect(line("Forward yield")).toContain(" estimated");
    expect(line("Forward rate")).toContain(" estimated (converted from EUR)");
    expect(line("Trailing rate")).not.toContain("estimated");
    expect(line("Estimated")).toMatch(/^Estimated\s+€0\.02306 declared, FX fixing 27 Jan 2027$/);
    expect(text.match(/FX fixing/g)).toHaveLength(1);
    expect(text).toContain("03 Feb 2027");
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: null, actions: {
      symbol: "VOD", currency: "GBP", coverage: { dividends: "available" }, splits: [], earnings: [], dividends: [],
      declaredCash: { currency: "EUR", rows: [], announced: { exDate: "2026-11-19", payDate: "2027-02-03", amount: 0.02306 } },
    } } }));
    const withoutSummary = await fetchDividendData("VOD", 1.177, "LSE", "GBP");
    expect(withoutSummary.metrics.nextPayDate).toEqual(new Date("2027-02-03"));
    expect(withoutSummary.summaryError).not.toContain("pay date");
  });
  test("a forward rate converted from a currency with no declared amount or fixing says its FX is unknown, once", async () => {
    setSystemTime(new Date("2026-11-17T06:00:00Z"));
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: {
      currency: "GBP", trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      forwardAnnualDividendRate: 0.03941926, forwardRateAsOf: "2026-06-04", exDividendDate: null, dividendDate: null,
    }, actions: {
      symbol: "VOD", currency: "GBP", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-06-04", amount: 0.0201294 }, { exDate: "2025-11-20", amount: 0.0195116 }],
      declaredCash: { currency: "EUR", rows: [{ exDate: "2026-06-04", amount: 0.023625 }] },
    } } }));
    const data = await fetchDividendData("VOD", 1.177, "LSE", "GBP");
    expect(data.metrics.forwardEstimate).toMatchObject({ declaredCurrency: "EUR" });
    expect(data.metrics.forwardEstimate?.declaredAmount).toBeUndefined();
    const request = { rawArgument: "VOD:LSE", argument: "VOD:LSE", symbols: ["VOD:LSE"], options: {} };
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), projectDividendYieldHeadless(data, request), request, "DVD");
    expect(text.split("\n").find((entry) => entry.startsWith("Estimated "))).toMatch(/^Estimated\s+declared in EUR, FX fixing unavailable$/);
    expect(text.match(/FX fixing/g)).toHaveLength(1);
  });
  test("a fixed announced paid amount in pence converts exactly once, while declaration amounts stay in major euros", async () => {
    setSystemTime(new Date("2026-11-17T06:00:00Z"));
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: {
      currency: "GBP", trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      forwardAnnualDividendRate: 0.03941926, forwardRateAsOf: "2026-11-19", exDividendDate: null, dividendDate: null,
    }, actions: {
      symbol: "VOD", currency: "GBp", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-06-04", amount: 2.01294 }, { exDate: "2025-11-20", amount: 1.95116 }],
      declaredDividends: [{ exDate: "2026-11-19", amount: 2.1, payDate: "2027-02-03" }],
      declaredCash: { currency: "EUR", rows: [{ exDate: "2026-06-04", amount: 0.023625 }],
        announced: { exDate: "2026-11-19", payDate: "2027-02-03", amount: 0.02306, paidAmount: 2.1 } },
    } } }));
    const data = await fetchDividendData("VOD", 117.7, "LSE", "GBp");
    expect(data.payments[0]!.declared).toEqual({ amount: 0.023625, currency: "EUR" });
    expect(data.declared?.[0]?.amount).toBeCloseTo(0.021, 10);
    expect(data.metrics.forwardRate).toBeCloseTo(0.042, 10);
    expect(data.metrics.forwardYield).toBeCloseTo(0.042 / 1.177, 10);
    expect(data.metrics.forwardEstimate).toBeUndefined();
    const request = { rawArgument: "VOD:LSE", argument: "VOD:LSE", symbols: ["VOD:LSE"], options: {} };
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), projectDividendYieldHeadless(data, request), request, "DVD");
    expect(text).not.toContain("estimated from");
  });
  test("unverified upstream cash remains usable and exposes its warning in text and JSON", async () => {
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: null, actions: {
      symbol: "VOD", currency: "GBp", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-06-04", amount: 1.97101 }],
      declaredCash: { currency: "EUR", rows: [], verification: "unavailable" },
    } } }));
    const data = await fetchDividendData("VOD", 117.7, "LSE", "GBp");
    expect(data.payments[0]!.amount).toBeCloseTo(0.0197101, 10);
    expect(data.historyAvailable).toBe(true);
    const request = { rawArgument: "VOD:LSE", argument: "VOD:LSE", symbols: ["VOD:LSE"], options: {} };
    const result = projectDividendYieldHeadless(data, request);
    expect(result.metadata?.cashVerificationWarning).toContain("not issuer-verified");
    expect(renderHeadlessPaneText(createDividendYieldHeadless(), result, request, "DVD")).toContain("not issuer-verified");
  });
  test("native income keeps the listing's ex-date when its session starts on the previous UTC date", async () => {
    const timestamp = Date.parse("2026-01-01T23:00:00Z") / 1000;
    setHttpFetchTransport(marketTransport(async (url) => {
      if (url.includes("/chart/")) return chartResponse({
        meta: { currency: "AUD", exchangeTimezoneName: "Australia/Sydney", regularMarketPrice: 100, dataGranularity: "1mo" },
        time: timestamp, dividends: { one: { date: timestamp, amount: 0.25 } },
      });
      return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "AUD" } }] } });
    }));
    const data = await fetchDividendData("FIXTURE.AX", null);
    expect(data.payments[0]).toMatchObject({ exDate: new Date("2026-01-02"), amount: 0.25, currency: "AUD" });
  });

  test("a complete cash suspension is a full decline from a positive baseline", () => {
    const history = [payment("2020-08-01", 1), payment("2021-08-01", 1), payment("2022-08-01", 1), payment("2023-08-01", 1)];
    const afterSuspension = new Date("2024-09-10T12:00:00Z");
    expect(buildDividendMetrics(history, null, 100, { now: afterSuspension })).toMatchObject({
      trailingRate: 0, growth1Y: -1, growth3Y: -1,
    });
    // With no cash in either annual window, percentage growth is undefined.
    expect(buildDividendMetrics(history, null, 100, { now }).growth1Y).toBeNull();
    expect(buildDividendMetrics(history, null, 100, { now: afterSuspension, historyAvailable: false })).toMatchObject({
      trailingRate: null, growth1Y: null, growth3Y: null,
    });
    // An incomplete initial year must not turn missing observations into a cut.
    expect(buildDividendMetrics([payment("2023-08-01")], null, 100, { now: afterSuspension }).growth1Y).toBeNull();
  });

  test("cash paid again after a year of none is growth off zero: N/M, never a number", () => {
    const history = [payment("2020-08-01", 1), payment("2021-08-01", 1), payment("2024-08-01", 1)];
    const resumed = buildDividendMetrics(history, null, 100, { now: new Date("2024-09-10T12:00:00Z") });
    expect(resumed).toMatchObject({ growth1Y: null, growth1YNotMeaningful: true, growth3Y: 0 });
    expect(resumed.growth3YNotMeaningful).toBeUndefined();
    // No cash in either year stays without growth, and is not called N/M.
    const stopped = buildDividendMetrics(history.slice(0, 2), null, 100, { now: new Date("2024-09-10T12:00:00Z") });
    expect(stopped.growth1Y).toBeNull();
    expect(stopped.growth1YNotMeaningful).toBeUndefined();
  });

  test("a monthly fund whose history ends early says so, and its forward rate, trailing yield and last ex-date all stop there", () => {
    // IEF on 2026-11-06: the history ends at 2026-09-01 while the summary states a rate as of 2026-11-02.
    const months = ["2025-11-03", "2025-12-01", "2026-01-02", "2026-02-02", "2026-03-02", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-03", "2026-09-01"];
    const history = months.map((day) => payment(day, 0.3));
    const summary: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, forwardAnnualDividendRate: 3.6,
      forwardRateAsOf: "2026-11-02", exDividendDate: Date.parse("2026-11-02T00:00:00Z") / 1000, dividendDate: null, currency: "USD", payoutRatio: null };
    const at = new Date("2026-11-06T15:00:00Z");
    const metrics = buildDividendMetrics(history, summary, 100, { now: at });
    expect(metrics).toMatchObject({ forwardRate: null, forwardYield: null, lapse: { lastPaid: "2026-09-01", historyEnds: true },
      lastExDividendDate: new Date("2026-09-01") });
    const entries = projectDividendYieldHeadless({ payments: history, metrics, price: 100, currency: "USD" },
      { rawArgument: "IEF", argument: "IEF", symbols: ["IEF"], options: {} }).sections[0]!.textEntries!;
    expect(entries.find((entry) => entry.label === "Forward yield")?.formatted).toBe("distribution history ends 01 Sep 2026");
    expect(entries.find((entry) => entry.label === "Trailing yield")?.formatted).toContain("distribution history ends 01 Sep 2026");
    expect(entries.find((entry) => entry.label === "Last ex-dividend")?.formatted).toBe("01 Sep 2026");
    // JSON and CSV keep the days in ISO, as they always wrote them.
    const exported = projectDividendYieldHeadless({ payments: history, metrics, price: 100, currency: "USD" },
      { rawArgument: "IEF", argument: "IEF", symbols: ["IEF"], options: {} }).sections[0]!.entries!;
    expect(exported.find((entry) => entry.label === "Forward yield")?.formatted).toBe("distribution history ends 2026-09-01");
    expect(exported.find((entry) => entry.label === "Last ex-dividend")?.formatted).toBe("2026-09-01");
    // Once the missing months are filled the fund is current, and its stated rate stands.
    const filled = buildDividendMetrics([...history, payment("2026-10-01", 0.3), payment("2026-11-02", 0.3)], summary, 100, { now: at });
    expect(filled).toMatchObject({ forwardRate: 3.6, forwardRateAsOf: "2026-11-02", lapse: null, lastExDividendDate: new Date("2026-11-02") });
    // Silent more than 183 days, a monthly fund stopped paying (FXF, last paid 2024-04-01): no current dividend.
    const fxf = buildDividendMetrics(["2024-01-02", "2024-02-01", "2024-03-01", "2024-04-01"].map((day) => payment(day, 0.3)),
      { ...summary, forwardRateAsOf: "2024-04-01", exDividendDate: Date.parse("2024-04-01T00:00:00Z") / 1000 }, 100, { now: at });
    expect(fxf).toMatchObject({ forwardRate: null, lapse: { lastPaid: "2024-04-01" } });
    expect(fxf.lapse?.historyEnds).toBeUndefined();
  });

  test("a payout over zero or negative earnings is not meaningful, whatever the source states", () => {
    const summary = (trailingEps: number | undefined, payoutRatio: number | null = 20): DividendSummary => ({
      trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, forwardAnnualDividendRate: null,
      exDividendDate: null, dividendDate: null, currency: "USD", payoutRatio, ...(trailingEps === undefined ? {} : { trailingEps }),
    });
    const history = [payment("2026-08-01", 1)];
    expect(buildDividendMetrics(history, summary(-1.3), 10, { now })).toMatchObject({ payoutRatio: null, payoutNotMeaningful: true });
    expect(buildDividendMetrics(history, summary(0), 10, { now })).toMatchObject({ payoutRatio: null, payoutNotMeaningful: true });
    // A loss makes it N/M even where the source states none; unknown earnings leave the figure as served.
    expect(buildDividendMetrics(history, summary(-1.3, null), 10, { now }).payoutNotMeaningful).toBe(true);
    expect(buildDividendMetrics(history, summary(2.5, 0.4), 10, { now })).toMatchObject({ payoutRatio: 0.4, payoutNotMeaningful: false });
    expect(buildDividendMetrics(history, summary(undefined, 0.4), 10, { now })).toMatchObject({ payoutRatio: 0.4, payoutNotMeaningful: false });
  });

  test("a regular payer's yield says how many payments it counts when its history has a hole", () => {
    const late = new Date("2026-10-26T12:00:00Z");
    // Monthly ex-dates from November 2024 to October 2026, less the given months of 2026.
    const monthly = (missing: number[] = []) => Array.from({ length: 24 }, (_, index) => ({ year: 2024 + Math.floor((index + 10) / 12), month: (index + 10) % 12 + 1 }))
      .filter(({ year, month }) => !(year === 2026 && missing.includes(month)))
      .map(({ year, month }) => payment(`${year}-${String(month).padStart(2, "0")}-10`, 0.1));
    // ECC: monthly, with no July, August or September 2026 ex-dates in the source, so nine in the year.
    expect(buildDividendMetrics(monthly([7, 8, 9]), null, 10, { now: late }).trailingPayments).toEqual({ counted: 9, expected: 12, cadence: "monthly" });
    expect(buildDividendMetrics(monthly(), null, 10, { now: late }).trailingPayments).toBeNull();
    // A quarterly payer is read against four; an irregular one, a stopped dividend and a history that failed have nothing to say.
    const quarterly = ["2024-11-10", "2025-02-10", "2025-05-10", "2025-08-10", "2025-11-10", "2026-02-10", "2026-05-10", "2026-08-10"].map((date) => payment(date));
    expect(buildDividendMetrics(quarterly, null, 10, { now: late }).trailingPayments).toBeNull();
    expect(buildDividendMetrics(quarterly.filter((entry) => entry.exDate.toISOString() !== "2026-05-10T00:00:00.000Z"), null, 10, { now: late }).trailingPayments)
      .toEqual({ counted: 3, expected: 4, cadence: "quarterly" });
    expect(buildDividendMetrics([payment("2024-03-01"), payment("2026-09-01")], null, 10, { now: late }).trailingPayments).toBeNull();
    expect(buildDividendMetrics(monthly([7, 8, 9]), null, 10, { now: late, historyAvailable: false }).trailingPayments).toBeNull();
  });

  test("sends the selected listing unchanged to the backend", async () => {
    const requested: string[] = [];
    setHttpFetchTransport(async (url) => {
      requested.push(url);
      return Response.json({ status: "unavailable", data: null });
    });
    await expect(fetchDividendData("SAP:XFRA", null, "NASDAQ")).rejects.toThrow("No dividend data found");
    const url = new URL(requested[0]!);
    expect(url.pathname).toBe("/market/dividends");
    expect(url.searchParams.get("symbol")).toBe("SAP:XFRA");
    expect(url.searchParams.get("exchange")).toBe("NASDAQ");
  });

  test("an exchange-qualified listing reads that listing's history, as quote and events read it", async () => {
    const requested: URL[] = [];
    setHttpFetchTransport(async (url) => {
      const request = new URL(url);
      requested.push(request);
      return Response.json({ status: "success", data: { quote: null, summary: null, actions: {
        symbol: request.searchParams.get("symbol"), currency: request.searchParams.get("exchange") === "LSE" ? "GBp" : "USD",
        coverage: { dividends: "available" }, dividends: [{ exDate: "2026-08-06", amount: 39.82 }], splits: [], earnings: [],
      } } });
    });
    const quotes: string[] = [];
    const context = {
      // As `fn` resolves a typed key: `ULVR:LSE` is ULVR on LSE.
      resolveInstrument: async (key: string) => parsePublicTickerKey(key),
      marketData: { getQuote: async (symbol: string, exchange: string) => {
        quotes.push(`${symbol}|${exchange}`);
        throw new Error("Fixture quote unavailable");
      } },
    } as unknown as HeadlessPaneContext;
    const definition = createDividendYieldHeadless();
    const london = await definition.load({ rawArgument: "ULVR:LSE", argument: "ULVR:LSE", symbols: ["ULVR:LSE"], options: {} }, context);
    await definition.load({ rawArgument: "AAPL:NASDAQ", argument: "AAPL:NASDAQ", symbols: ["AAPL:NASDAQ"], options: {} }, context);
    expect(requested.map((url) => [url.searchParams.get("symbol"), url.searchParams.get("exchange")]))
      .toEqual([["ULVR", "LSE"], ["AAPL", "NASDAQ"]]);
    // The reference quote and the bond-fund check both read the listing.
    expect(new Set(quotes)).toEqual(new Set(["ULVR|LSE", "AAPL|NASDAQ"]));
    // The pence history is read in pounds.
    expect(london.sections.find((section) => section.title === "Dividend history")?.rows)
      .toMatchObject([{ exDate: "2026-08-06", amount: 0.3982, currency: "GBP" }]);
  });

  test("growth compares only years that hold every payment the cadence pays", () => {
    const late = new Date("2026-10-26T12:00:00Z");
    // AZN: semi-annual, a larger second interim in February, and no August 2026 interim in the source.
    const azn = ["2022-02-24", "2022-08-11", "2023-02-23", "2023-08-10", "2024-02-22", "2024-08-09", "2025-02-21", "2025-08-08", "2026-02-19"]
      .map((date) => payment(date, date.slice(5, 7) === "02" ? 2 : 1));
    const missingInterim = buildDividendMetrics(azn, null, 100, { now: late });
    expect(missingInterim).toMatchObject({
      growth1Y: null, growth1YPayments: { counted: 1, expected: 2, cadence: "semi-annual" },
      growth3Y: null, growth3YPayments: { counted: 1, expected: 2, cadence: "semi-annual" },
    });
    const result = projectDividendYieldHeadless({ payments: azn, metrics: missingInterim, price: 100, currency: "USD" },
      { rawArgument: "AZN", argument: "AZN", symbols: ["AZN"], options: {} });
    expect(result.sections[0]?.entries?.find((entry) => entry.label === "1Y Cash Growth"))
      .toMatchObject({ value: null, formatted: "n/a: 1 of 2 payments" });

    // With the interim, both years are whole and the growth is measured.
    const whole = buildDividendMetrics([...azn, payment("2026-08-07", 1)], null, 100, { now: late });
    expect(whole.growth1Y).toBeCloseTo(0, 12);
    expect(whole.growth1YPayments).toBeUndefined();
    // A hole a year earlier is named by the year it ends.
    const earlierHole = buildDividendMetrics([...azn.filter((entry) => entry.exDate.toISOString().slice(0, 10) !== "2025-08-08"), payment("2026-08-07", 1)],
      null, 100, { now: late });
    expect(earlierHole).toMatchObject({ growth1Y: null, growth1YPayments: { counted: 1, expected: 2, yearTo: "2025-10-26" } });
  });

  test("a year of widely uneven regular payments forwards their total, not the latest annualized", () => {
    const late = new Date("2026-10-27T12:00:00Z");
    // HSBA in pounds: three interims and a final four and a half times their size; the source annualizes the latest interim.
    const hsba = [["2025-03-06", 0.278597], ["2025-05-08", 0.074512], ["2025-08-14", 0.073562], ["2025-11-06", 0.075079], ["2026-03-12", 0.333016],
      ["2026-05-14", 0.074489], ["2026-08-13", 0.074134]]
      .map(([date, amount]) => payment(date as string, amount as number, "GBP"));
    const stated: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "GBP", forwardAnnualDividendRate: 0.296536, forwardRateAsOf: "2026-08-13" };
    const metrics = buildDividendMetrics(hsba, stated, 13.654, { now: late });
    expect(metrics).toMatchObject({ forwardRate: 0.556718, forwardRateAsOf: "2026-08-13", forwardBasis: "uneven", trailingRate: 0.556718 });
    expect(metrics.forwardYield).toBeCloseTo(0.0408, 4);
    const entries = projectDividendYieldHeadless({ payments: hsba, metrics, price: 13.654, currency: "GBP" },
      { rawArgument: "HSBA:LSE", argument: "HSBA:LSE", symbols: ["HSBA:LSE"], options: {} }).sections[0]!.textEntries!;
    expect(entries.find((entry) => entry.label === "Forward yield")?.formatted).toBe("4.08% (trailing regular payments: uneven interims)");

    // Exports and the forward rate say the figure is the trailing year's, not a forward one.
    const report = projectDividendYieldHeadless({ payments: hsba, metrics, price: 13.654, currency: "GBP" },
      { rawArgument: "HSBA:LSE", argument: "HSBA:LSE", symbols: ["HSBA:LSE"], options: {} }).sections[0]!;
    expect(report.entries!.map((entry) => entry.label)).toContain("Forward yield (trailing regular payments)");
    expect(report.entries!.map((entry) => entry.label)).toContain("Forward rate (trailing regular payments)");
    expect(report.textEntries!.find((entry) => entry.label === "Forward rate")?.formatted).toBe("£0.556718 (trailing regular payments: uneven interims)");
    // A declared interim the size of the others is no new level: the final stands beside them.
    expect(buildDividendMetrics(hsba, { ...stated, forwardRateAsOf: "2026-11-05" }, 13.654, { now: late }).forwardBasis).toBe("uneven");

    // Even quarters, and a year with a hole in it, keep the stated rate.
    const even = hsba.map((entry) => ({ ...entry, amount: 0.075 }));
    expect(buildDividendMetrics(even, stated, 13.654, { now: late })).toMatchObject({ forwardRate: 0.296536, forwardRateAsOf: "2026-08-13" });
    expect(buildDividendMetrics(even, stated, 13.654, { now: late }).forwardBasis).toBeUndefined();
    expect(buildDividendMetrics(hsba.filter((entry) => entry.amount !== 0.075079), stated, 13.654, { now: late }).forwardRate).toBe(0.296536);
  });

  test("a semiannual interim beside a final twice its size forwards the year; a one-off special beside an annual dividend does not", () => {
    // AZN:LSE in pounds: 79.50p interims, 159.50p and 168p finals; the stated rate annualizes the August interim.
    const azn = [["2025-02-20", 1.68], ["2025-08-07", 0.767], ["2026-02-19", 1.595], ["2026-08-06", 0.795]]
      .map(([date, amount]) => payment(date as string, amount as number, "GBP"));
    const stated: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "GBP", forwardAnnualDividendRate: 1.59, forwardRateAsOf: "2026-08-06" };
    const asOf = new Date("2026-11-21T12:00:00Z");
    expect(buildDividendMetrics(azn, stated, 134.12, { now: asOf })).toMatchObject({ forwardRate: 2.39, forwardBasis: "uneven" });
    // A 4.00 special six months after a 1.05 annual dividend is no second payment of the year, as Gloom Cloud reads it too.
    const annual = [["2024-05-10", 1], ["2025-05-09", 1.05], ["2025-11-14", 4], ["2026-05-08", 1.1]]
      .map(([date, amount]) => payment(date as string, amount as number));
    const metrics = buildDividendMetrics(annual, { ...stated, currency: "USD", forwardAnnualDividendRate: 1.1, forwardRateAsOf: "2026-05-08" }, 40, { now: asOf });
    expect(metrics).toMatchObject({ forwardRate: 1.1, forwardRateAsOf: "2026-05-08" });
    expect(metrics.forwardBasis).toBeUndefined();
  });

  test("an extra that recurred in no slot of the payer's year never sets its frequency", () => {
    const asOf = new Date("2026-11-23T20:00:00Z");
    // WH Group (0288): finals in May or June, interims in August or September, and three payments in no slot of its
    // year (February and March 2025, and a HK$0.30 special in October 2025). The source annualized the HK$0.20 interim
    // four times; the year's final and interim differ widely, so their total is the forward rate.
    const wh = [["2022-06-07", 0.14], ["2022-08-29", 0.05], ["2023-06-09", 0.25], ["2023-08-28", 0.05], ["2024-05-14", 0.25],
      ["2024-08-26", 0.1], ["2025-02-18", 0.01673], ["2025-03-13", 0.18], ["2025-05-14", 0.4], ["2025-08-25", 0.2], ["2025-10-06", 0.3],
      ["2026-05-13", 0.41], ["2026-09-11", 0.2]].map(([date, amount]) => payment(date as string, amount as number, "HKD"));
    const stated: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "HKD", forwardAnnualDividendRate: 0.8, forwardRateAsOf: "2026-09-11" };
    const metrics = buildDividendMetrics(wh, stated, 6.815, { now: asOf });
    expect(metrics).toMatchObject({ paymentFrequency: "semi-annual", forwardRate: 0.61, forwardBasis: "uneven", trailingRate: 0.61,
      trailingPayments: null });
    // Until a year and a slot after the October special have passed it cannot be told from a new period: it counts.
    expect(buildDividendMetrics(wh, stated, 6.815, { now: new Date("2026-11-10T12:00:00Z") }).paymentFrequency).toBe("quarterly");
    // A monthly payer missing three months still reads monthly; Ambev's December, June and September are no two a year.
    const months = Array.from({ length: 25 }, (_, index) => new Date(Date.UTC(2024, 10 + index, 15)).toISOString().slice(0, 10))
      .filter((date) => !["2026-07-15", "2026-08-15", "2026-09-15"].includes(date)).map((date) => payment(date, 0.1));
    expect(buildDividendMetrics(months, null, 10, { now: new Date("2026-11-20T12:00:00Z") }).paymentFrequency).toBe("monthly");
    const ambev = [["2023-12-20", 0.7302], ["2024-12-20", 0.6676], ["2025-03-17", 0.1276], ["2025-05-16", 0.128], ["2025-12-19", 0.7302],
      ["2026-06-23", 0.0449], ["2026-09-22", 0.0713]].map(([date, amount]) => payment(date as string, amount as number, "BRL"));
    expect(buildDividendMetrics(ambev, null, 15.86, { now: asOf })).toMatchObject({ paymentFrequency: "irregular", trailingRate: 0.8464 });
  });

  test("an interim and a final sized apart the same way each year forward the year; a run of raises does not", () => {
    const asOf = new Date("2026-11-23T20:00:00Z");
    // Far East Horizon (3360): HK$0.30 and HK$0.25 in 2025, HK$0.31 and HK$0.25 in 2026, 1.2 and 1.24 times apart.
    const feh = [["2024-06-07", 0.5], ["2024-09-25", 0.25], ["2025-04-16", 0.3], ["2025-09-09", 0.25], ["2026-06-12", 0.31],
      ["2026-09-14", 0.25]].map(([date, amount]) => payment(date as string, amount as number, "HKD"));
    const stated: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "HKD", forwardAnnualDividendRate: 0.5, forwardRateAsOf: "2026-09-14" };
    expect(buildDividendMetrics(feh, stated, 4.995, { now: asOf })).toMatchObject({ forwardRate: 0.56, forwardBasis: "uneven" });
    // Within 1.15 times each other, or the other one larger a year before, the latest annualized stands.
    const near = [...feh.slice(0, 4), payment("2026-06-12", 0.28, "HKD"), payment("2026-09-14", 0.25, "HKD")];
    expect(buildDividendMetrics(near, stated, 4.995, { now: asOf }).forwardBasis).toBeUndefined();
    const flipped = [...feh.slice(0, 2), payment("2025-04-16", 0.25, "HKD"), payment("2025-09-09", 0.3, "HKD"), ...feh.slice(4)];
    expect(buildDividendMetrics(flipped, stated, 4.995, { now: asOf }).forwardBasis).toBeUndefined();
    // Ibiden's 5, 7.5, 7.5 and 10 yen only rise: raises, whose latest annualized stands.
    const ibiden = [["2025-03-28", 5], ["2025-09-29", 7.5], ["2026-03-30", 7.5], ["2026-09-29", 10]]
      .map(([date, amount]) => payment(date as string, amount as number, "JPY"));
    const raised = buildDividendMetrics(ibiden, { ...stated, currency: "JPY", forwardAnnualDividendRate: 20, forwardRateAsOf: "2026-09-29" }, 4672, { now: asOf });
    expect(raised).toMatchObject({ forwardRate: 20 });
    expect(raised.forwardBasis).toBeUndefined();
  });

  test("a young history's two ex-dates take the cadence its stated rate reads, not their gap's", () => {
    const asOf = new Date("2026-11-23T20:00:00Z");
    // CNGR's H line (2579): its 2025 final and 2026 interim, 107 days apart, served at twice the interim.
    const cngr = [payment("2026-06-09", 0.435138, "HKD"), payment("2026-09-24", 0.440008, "HKD")];
    const stated: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "HKD", forwardAnnualDividendRate: 0.880016, forwardRateAsOf: "2026-09-24" };
    expect(buildDividendMetrics(cngr, stated, 15.42, { now: asOf })).toMatchObject({ paymentFrequency: "semi-annual",
      forwardRate: 0.880016, trailingPayments: null });
    // Montage's H line (6809): a final and an interim served as their sum, two a year.
    const montage = [payment("2026-07-07", 0.441, "HKD"), payment("2026-09-25", 0.231, "HKD")];
    expect(buildDividendMetrics(montage, { ...stated, forwardAnnualDividendRate: 0.672, forwardRateAsOf: "2026-09-25" }, 141.3,
      { now: asOf }).paymentFrequency).toBe("semi-annual");
    // A rate four times the interim reads four a year, as the gap does, two of four payments counted; one that reads no
    // cadence leaves the gap's.
    expect(buildDividendMetrics(cngr, { ...stated, forwardAnnualDividendRate: 1.760032 }, 15.42, { now: asOf }))
      .toMatchObject({ paymentFrequency: "quarterly", trailingPayments: { counted: 2, expected: 4, cadence: "quarterly" } });
    expect(buildDividendMetrics(cngr, { ...stated, forwardAnnualDividendRate: 1.3 }, 15.42, { now: asOf }).paymentFrequency).toBe("quarterly");
    // An older payer's two ex-dates in two years keep their gap's cadence, whatever the rate reads.
    const annual = [payment("2023-06-01", 1, "HKD"), payment("2025-06-02", 1, "HKD"), payment("2026-06-01", 1, "HKD")];
    expect(buildDividendMetrics(annual, { ...stated, forwardAnnualDividendRate: 2, forwardRateAsOf: "2026-06-01" }, 20, { now: asOf })
      .paymentFrequency).toBe("annual");
  });

  test("a cut that held is the new rate, which the declared distribution annualizes, not the trailing year's total", () => {
    const late = new Date("2026-11-20T12:00:00Z");
    // ECC: $0.14 a month to March 2026, $0.06 from April; the next $0.06 is declared, ex 11 Dec.
    const months = ["2025-12-11", "2026-01-12", "2026-02-09", "2026-03-11", "2026-04-10", "2026-05-11", "2026-06-10", "2026-07-13",
      "2026-08-11", "2026-09-10", "2026-10-13", "2026-11-10"];
    const ecc = months.map((date, index) => payment(date, index < 4 ? 0.14 : 0.06));
    const stated: DividendSummary = { trailingAnnualDividendRate: 1.68, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "USD", forwardAnnualDividendRate: 0.72, forwardRateAsOf: "2026-12-11" };
    const metrics = buildDividendMetrics(ecc, stated, 2.47, { now: late });
    expect(metrics).toMatchObject({ forwardRate: 0.72, forwardRateAsOf: "2026-12-11", trailingRate: 1.04 });
    expect(metrics.forwardBasis).toBeUndefined();
    // A quarterly cut paid once so far is a new level only once the next one is declared at it.
    const quarters = ["2025-12-01", "2026-03-02", "2026-06-01", "2026-09-01"].map((date, index) => payment(date, index < 3 ? 1 : 0.5));
    const quarterly = (asOf: string) => buildDividendMetrics(quarters, { ...stated, forwardAnnualDividendRate: 2, forwardRateAsOf: asOf }, 50, { now: late });
    expect(quarterly("2026-12-01")).toMatchObject({ forwardRate: 2 });
    expect(quarterly("2026-09-01")).toMatchObject({ forwardRate: 3.5, forwardBasis: "uneven" });
  });

  test("a stated rate dated by a declared regular distribution is that amount at the payer's cadence", async () => {
    setSystemTime(new Date("2026-11-20T12:00:00Z"));
    // OXLC: $0.40 a month to March 2026, $0.20 from April, the next $0.20 declared; the stated rate read $1.20.
    const months = ["2025-12-17", "2026-01-16", "2026-02-13", "2026-03-17", "2026-04-16", "2026-05-15", "2026-06-16", "2026-07-17",
      "2026-08-17", "2026-09-16", "2026-10-16", "2026-11-16"];
    const read = (declaredDividends: readonly Record<string, unknown>[]) => Response.json({ status: "success", data: { quote: null,
      summary: { currency: "USD", trailingAnnualDividendRate: 3.2, trailingAnnualDividendYield: null, payoutRatio: null,
        forwardAnnualDividendRate: 1.2, forwardRateAsOf: "2026-12-17", exDividendDate: null, dividendDate: null },
      actions: { symbol: "OXLC", currency: "USD", coverage: { dividends: "available" }, splits: [], earnings: [],
        dividends: months.map((exDate, index) => ({ exDate, amount: index < 4 ? 0.4 : 0.2 })), declaredDividends } } });
    setHttpFetchTransport(async () => read([{ exDate: "2026-12-17", payDate: "2026-12-31", amount: 0.2 }]));
    const data = await fetchDividendData("OXLC", 4.91, "NASDAQ", "USD");
    expect(data.metrics).toMatchObject({ forwardRate: 2.4, forwardRateAsOf: "2026-12-17", paymentFrequency: "monthly" });
    expect(data.metrics.forwardYield).toBeCloseTo(2.4 / 4.91, 10);
    // A one-off declared on that date, or none at all, leaves the stated rate.
    setHttpFetchTransport(async () => read([{ exDate: "2026-12-17", payDate: "2026-12-31", amount: 0.2, special: true }]));
    expect((await fetchDividendData("OXLC", 4.91, "NASDAQ", "USD")).metrics.forwardRate).toBe(1.2);
    setHttpFetchTransport(async () => read([]));
    expect((await fetchDividendData("OXLC", 4.91, "NASDAQ", "USD")).metrics.forwardRate).toBe(1.2);
  });

  test("a regular payment and an extra one on one ex-date are labelled as one row of both", () => {
    // ECC's $0.39 of 7 Oct 2022 is October's $0.14 and an extra $0.25; the $0.50 of 22 Dec has its own ex-date.
    const history = [["2021-09-09", 0.1], ["2021-10-08", 0.12], ["2021-11-09", 0.12], ["2021-12-10", 0.12], ["2021-12-22", 0.5],
      ["2022-01-10", 0.12], ["2022-02-07", 0.12], ["2022-03-10", 0.12], ["2022-04-08", 0.14], ["2022-05-10", 0.14], ["2022-06-09", 0.14],
      ["2022-07-08", 0.14], ["2022-08-10", 0.14], ["2022-09-09", 0.14], ["2022-10-07", 0.39], ["2022-11-09", 0.14], ["2022-12-09", 0.14],
      ["2022-12-22", 0.5], ["2023-01-10", 0.14], ["2023-02-07", 0.14], ["2023-03-10", 0.14], ["2023-04-06", 0.16], ["2023-05-10", 0.16],
      ["2023-06-09", 0.16], ["2023-07-10", 0.16], ["2023-08-10", 0.16], ["2023-09-08", 0.16], ["2023-10-10", 0.16], ["2023-11-10", 0.16]] as const;
    const payments = history.map(([date, amount]) => payment(date, amount));
    expect([...combinedPaymentTimes(payments)].map((time) => new Date(time).toISOString().slice(0, 10))).toEqual(["2022-10-07"]);
    // A final that is large every year (HSBC's) is no extra payment.
    const finals = [["2024-08-15", 0.07], ["2024-11-07", 0.07], ["2025-03-13", 0.3], ["2025-05-15", 0.07], ["2025-08-14", 0.07],
      ["2025-11-06", 0.075], ["2026-03-12", 0.33], ["2026-05-14", 0.074], ["2026-08-13", 0.074]] as const;
    expect(combinedPaymentTimes(finals.map(([date, amount]) => payment(date, amount, "GBP"))).size).toBe(0);
    const marked = payments.map((entry) => entry.exDate.toISOString().startsWith("2022-10-07") ? { ...entry, combined: true as const } : entry)
      .sort((left, right) => right.exDate.getTime() - left.exDate.getTime());
    const metrics = buildDividendMetrics(marked, null, 2.47, { now: new Date("2023-11-20T12:00:00Z") });
    const table = projectDividendYieldHeadless({ payments: marked, metrics, price: 2.47, currency: "USD" },
      { rawArgument: "ECC", argument: "ECC", symbols: ["ECC"], options: {} }).sections.find((section) => section.title === "Dividend history")!;
    expect(table.rows?.find((row) => row.exDate === "2022-10-07")).toMatchObject({ amount: 0.39, combined: true });
    const typeColumn = table.columns?.find((column) => column.key === "type");
    expect(typeColumn?.format?.("cash", { combined: true })).toBe("cash, combined: regular + extra");
  });

  test("a final and a special the issuer's forms split from one row: the forward never counts the special, the trailing year does", async () => {
    // Stella International (1836): HK$0.56 specials ex with its 2025 and 2026 finals, one row each in its history; its
    // forms split them. The stated HK$0.84 is its interim twice. Read as one regular payment the row made the year uneven
    // and the forward rate HK$1.35, 10.7% at HK$12.57.
    const form = { url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0319/2026031900747.pdf", publishedOn: "2026-03-19" };
    const part = (amount: number, special: boolean, type: string) => ({ amount, special, type, form });
    const rows = [
      { exDate: "2024-05-16", amount: 0.61 }, { exDate: "2024-09-04", amount: 0.65 },
      { exDate: "2025-05-20", amount: 1.06, parts: [part(0.56, true, "Other Special Dividend"), part(0.5, false, "Final")] },
      { exDate: "2025-09-03", amount: 0.52 },
      { exDate: "2026-05-19", amount: 0.93, parts: [part(0.56, true, "Other Special Dividend"), part(0.37, false, "Final")] },
      { exDate: "2026-09-02", amount: 0.42, parts: [part(0.42, false, "Interim (Semi-annual)")] },
    ];
    const read = (dividends: unknown[]) => async () => Response.json({ status: "success", data: { quote: null, summary: null, actions: {
      symbol: "1836", currency: "HKD", coverage: { dividends: "available" }, splits: [], earnings: [], dividends } } });
    setHttpFetchTransport(read(rows));
    const data = await fetchDividendData("1836", null, "HKEX");
    expect(data.historyError ?? null).toBeNull();
    expect(data.payments.filter((row) => row.exDate.toISOString().startsWith("2026-05-19"))
      .map((row) => [row.amount, row.type, row.special ?? false, row.formType])).toEqual([
      [0.56, "special", true, "Other Special Dividend"],
      [0.37, "cash", false, "Final"],
    ]);
    const asOf = new Date("2026-11-23T20:00:00Z");
    const stated: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "HKD", forwardAnnualDividendRate: 0.84, forwardRateAsOf: "2026-09-02" };
    const metrics = buildDividendMetrics(data.payments, stated, 12.57, { now: asOf });
    expect(metrics).toMatchObject({ paymentFrequency: "semi-annual", forwardRate: 0.84, trailingRate: 1.35, trailingSpecial: 0.56,
      trailingPayments: null });
    expect(metrics.forwardBasis).toBeUndefined();
    // The history labels each special, and the trailing yield says it counts the year's.
    const request = { rawArgument: "1836:HKEX", argument: "1836:HKEX", symbols: ["1836:HKEX"], options: {} };
    const result = projectDividendYieldHeadless({ ...data, metrics, price: 12.57, currency: "HKD" }, request);
    expect(result.sections.find((section) => section.title === "Dividend history")?.rows?.slice(0, 4)
      .map((row) => [row.exDate, row.amount, row.type])).toEqual([
      ["2026-09-02", 0.42, "cash"], ["2026-05-19", 0.56, "special"], ["2026-05-19", 0.37, "cash"], ["2025-09-03", 0.52, "cash"],
    ]);
    expect(result.sections.find((section) => section.title === "Dividend history")?.rows?.[1])
      .toMatchObject({ special: true, formType: "Other Special Dividend" });
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), result, request, "DVD");
    expect(text).toContain("incl. HK$0.56 special");
    expect(text).not.toContain("combined");

    // The same history with no parts, or parts that do not sum to the row or say nothing of its nature, is read as before.
    for (const dividends of [rows.map(({ exDate, amount }) => ({ exDate, amount })),
      rows.map((row) => row.parts ? { ...row, parts: [{ ...row.parts[0], amount: 0.5 }, row.parts[1]] } : row),
      rows.map((row) => row.parts ? { ...row, parts: row.parts.map(({ special: _, ...rest }) => rest) } : row)]) {
      setHttpFetchTransport(read(dividends));
      const plain = await fetchDividendData("1836", null, "HKEX");
      expect(plain.payments.map((row) => [row.amount, row.special ?? false])).toEqual(
        [[0.42, false], [0.93, false], [0.52, false], [1.06, false], [0.65, false], [0.61, false]]);
      const before = buildDividendMetrics(plain.payments, stated, 12.57, { now: asOf });
      expect(before).toMatchObject({ forwardRate: 1.35, forwardBasis: "uneven", trailingRate: 1.35 });
      expect(before.trailingSpecial).toBeUndefined();
    }
  });

  test("a special the issuer's form types on its own ex-date is no period of the year and never forwarded", () => {
    // China Feihe (6186): an "Other Special Dividend" of HK$0.2905 on 13 Oct 2026, five weeks after its interim. The source
    // annualized it twice, 20.9% at HK$2.78; its regular year is the HK$0.129 final and the HK$0.0828 interim.
    const asOf = new Date("2026-11-23T20:00:00Z");
    const typed = (date: string, amount: number, special = false) => ({ ...payment(date, amount, "HKD"), formTyped: true as const,
      ...(special ? { special: true as const, type: "special" as const } : {}) });
    const feihe = [typed("2024-05-24", 0.1484), typed("2024-09-10", 0.1632), typed("2025-06-02", 0.1632), typed("2025-09-10", 0.1209),
      typed("2026-06-09", 0.129), typed("2026-09-08", 0.0828), typed("2026-10-13", 0.2905, true)];
    const stated: DividendSummary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null,
      exDividendDate: null, dividendDate: null, currency: "HKD", forwardAnnualDividendRate: 0.581, forwardRateAsOf: "2026-10-13" };
    const metrics = buildDividendMetrics(feihe, stated, 2.78, { now: asOf });
    expect(metrics).toMatchObject({ paymentFrequency: "semi-annual", forwardRate: 0.2118, forwardBasis: "uneven", trailingRate: 0.5023,
      trailingSpecial: 0.2905 });
  });

  test("a London line of a dollar payer retains paid pence precision beside each declared amount, and a kept history is dated", async () => {
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: null, actions: {
      symbol: "BP", currency: "GBp", stale: true, fetchedAt: "2026-10-27T03:00:00.000Z", dividendsAsOf: "2026-10-20T02:31:00.000Z",
      coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-05-14", amount: 6.1844 }, { exDate: "2026-08-13", amount: 6.4059 }],
      declaredCash: { currency: "USD", rows: [{ exDate: "2026-08-13", amount: 0.0867 }] },
    } } }));
    const data = await fetchDividendData("BP", null, "LSE");
    expect(data.payments.map((row) => [row.amount, row.currency, row.declared])).toEqual([
      [0.064059, "GBP", { amount: 0.0867, currency: "USD" }],
      [0.061844, "GBP", undefined],
    ]);
    expect(data.fetchedAt).toBe("2026-10-20T02:31:00.000Z");
    const result = projectDividendYieldHeadless(data, { rawArgument: "BP:LSE", argument: "BP:LSE", symbols: ["BP:LSE"], options: {} });
    expect(result.sections[0]?.entries?.find((entry) => entry.label === "History status")?.value)
      .toBe("Stale cash history as of 2026-10-20; recent distributions may be missing.");
    // The pence are a conversion of the dollars declared: the history says so, and JSON keeps every decimal.
    const history = result.sections.find((section) => section.title === "Dividend history (amounts converted from USD)")!;
    expect(history.columns?.map((column) => column.key)).toEqual(["exDate", "amount", "declared", "currency", "type"]);
    expect(history.rows?.[0]).toMatchObject({ amount: 0.064059, declared: 0.0867, declaredCurrency: "USD" });
    expect(result.metadata).toMatchObject({ convertedFrom: "USD" });
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), result, { rawArgument: "BP:LSE", argument: "BP:LSE", symbols: ["BP:LSE"], options: {} }, "DVD");
    expect(text).toMatch(/13 Aug 2026 +6\.4059p +\$0\.0867\n/);
    expect(text).toMatch(/Trailing rate +12\.5903p \(converted from USD\)/);
    expect(text).not.toContain("£0.06");
  });

  test("a London line's converted amount is an estimate until it is paid, written to a ten-thousandth of a penny, and a pay date its New York line states names it", async () => {
    // SHEL:LSE on Sun 22 Nov 2026: its 12 Nov $0.3906 is the source's 29.858244p, paid on 21 Dec (SHEL:NYSE's date) at a sterling rate not yet fixed.
    setSystemTime(new Date("2026-11-22T12:00:00Z"));
    const summary = { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, forwardAnnualDividendRate: 1.1936892, payoutRatio: 0.2627,
      exDividendDate: Date.parse("2026-11-12T00:00:00Z") / 1000, dividendDate: Date.parse("2026-12-21T00:00:00Z") / 1000, dividendDateListing: "SHEL:NYSE", currency: "GBP" };
    const read = (stated: Partial<DividendSummary>) => Response.json({ status: "success", data: { quote: null, summary: { ...summary, ...stated }, actions: {
      symbol: "SHEL", currency: "GBp", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-02-19", amount: 27.869999 }, { exDate: "2026-05-21", amount: 29.179998 }, { exDate: "2026-08-13", amount: 28.92 },
        { exDate: "2026-11-12", amount: 29.858244 }],
      declaredCash: { currency: "USD", rows: [{ exDate: "2026-02-19", amount: 0.372 }, { exDate: "2026-05-21", amount: 0.3906 },
        { exDate: "2026-08-13", amount: 0.3906 }, { exDate: "2026-11-12", amount: 0.3906 }] },
    } } });
    setHttpFetchTransport(async () => read({}));
    const data = await fetchDividendData("SHEL", 35.745, "LSE", "GBP");
    expect(data.payments.map((row) => row.cashEstimate?.declaredAmount ?? null)).toEqual([0.3906, null, null, null]);
    expect(data.metrics).toMatchObject({ nextPayDate: new Date("2026-12-21"), nextPayDateListing: "SHEL:NYSE",
      forwardEstimate: { declaredCurrency: "USD", declaredAmount: 0.3906 }, trailingEstimates: [{ declaredAmount: 0.3906 }] });
    const request = { rawArgument: "SHEL:LSE", argument: "SHEL:LSE", symbols: ["SHEL:LSE"], options: {} };
    const result = projectDividendYieldHeadless({ ...data, priceQuotedUnitDivisor: 100 }, request);
    expect(result.metadata).toMatchObject({ nextPayDateListing: "SHEL:NYSE" });
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), result, request, "DVD");
    const line = (label: string) => text.split("\n").find((entry) => entry.startsWith(`${label} `))!;
    // The pence it trades in, as quote prints the price.
    expect(line("Price")).toMatch(/£35\.745$/);
    expect(text).toMatch(/12 Nov 2026 +estimated 29\.8582p +\$0\.3906\n/);
    // The column shares the estimate's precision, as the declared column shares its finest.
    expect(text).toMatch(/21 May 2026 +29\.1800p +\$0\.3906/);
    expect(text).toMatch(/19 Feb 2026 +27\.8700p +\$0\.3720/);
    expect(line("Trailing rate")).toMatch(/115\.8282p estimated \(converted from USD\)$/);
    expect(line("Trailing yield")).toContain(" estimated ");
    expect(line("Estimated")).toMatch(/^Estimated\s+\$0\.3906 declared, FX fixing unavailable$/);
    expect(text.match(/^Estimated/gm)).toHaveLength(1);
    expect(line("Next pay")).toMatch(/21 Dec 2026 \(from SHEL:NYSE\)$/);
    // Once the pay date has passed, the amount is what was paid.
    setSystemTime(new Date("2026-12-22T12:00:00Z"));
    const paid = await fetchDividendData("SHEL", 35.745, "LSE", "GBP");
    expect(paid.payments[0]?.cashEstimate).toBeUndefined();
    // Without a pay date for that distribution, nothing says it is unpaid: it stays as the source has it.
    setSystemTime(new Date("2026-11-22T12:00:00Z"));
    setHttpFetchTransport(async () => read({ dividendDate: null, dividendDateListing: undefined }));
    const undated = await fetchDividendData("SHEL", 35.745, "LSE", "GBP");
    expect(undated.payments[0]?.cashEstimate).toBeUndefined();
    expect(undated.metrics.nextPayDateListing).toBeUndefined();
  });

  test("a distribution a fund's sponsor gave its history names the sponsor in the history, and JSON keeps its page", async () => {
    const iShares = { publisher: "iShares", url: "https://www.ishares.com/us/products/239766/ishares-national-muni-bond-etf" };
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: null, actions: {
      symbol: "MUB", currency: "USD", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-09-01", amount: 0.29 }, { exDate: "2026-10-01", amount: 0.279282, source: iShares },
        { exDate: "2026-11-02", amount: 0.284092, source: iShares }, { exDate: "2026-08-03", amount: 0.286, source: { publisher: 7 } }],
    } } }));
    const data = await fetchDividendData("MUB", null);
    expect(data.payments.map((row) => row.source?.publisher ?? null)).toEqual(["iShares", "iShares", null, null]);
    const request = { rawArgument: "MUB", argument: "MUB", symbols: ["MUB"], options: {} };
    const result = projectDividendYieldHeadless(data, request);
    const history = result.sections.find((section) => section.title === "Dividend history")!;
    expect(history.columns?.map((column) => column.key)).toEqual(["exDate", "amount", "currency", "type", "source"]);
    expect(history.rows?.[0]).toMatchObject({ exDate: "2026-11-02", source: "iShares", sourceUrl: iShares.url });
    expect(history.rows?.[2]).not.toHaveProperty("source");
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), result, request, "DVD");
    expect(text).toMatch(/02 Nov 2026 +\$0\.284092 +iShares/);
    // A history its sponsor gave nothing to keeps its columns.
    const own = projectDividendYieldHeadless({ ...data, payments: data.payments.map(({ source: _, ...row }) => row) }, request);
    expect(own.sections.find((section) => section.title === "Dividend history")?.columns?.map((column) => column.key))
      .toEqual(["exDate", "amount", "currency", "type"]);
  });

  test("a rand line of a dollar payer retains cash precision and says it is converted from USD, even with no declared row beside it", async () => {
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: null, actions: {
      symbol: "S32", currency: "ZAc", fetchedAt: "2026-10-29T18:39:54.600Z", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-03-04", amount: 62.2114 }, { exDate: "2026-09-16", amount: 86.6087 }],
      declaredCash: { currency: "USD", rows: [] },
    } } }));
    const data = await fetchDividendData("S32", 50.6, "JSE", "ZAR");
    expect(data.convertedFrom).toBe("USD");
    const request = { rawArgument: "S32:JSE", argument: "S32:JSE", symbols: ["S32:JSE"], options: {} };
    const result = projectDividendYieldHeadless(data, request);
    const text = renderHeadlessPaneText(createDividendYieldHeadless(), result, request, "DVD");
    expect(text).toMatch(/Trailing rate +148\.8201c \(converted from USD\)/);
    expect(text).toContain("Dividend history (amounts converted from USD)");
    expect(text).toMatch(/16 Sep 2026 +86\.6087c\n/);
    expect(text).not.toContain("0.866087");
    // The exports keep the amount as read.
    expect(result.sections[1]!.rows![0]).toMatchObject({ amount: 0.866087, currency: "ZAR" });
    // A listing paid in what its company declares is as before.
    setHttpFetchTransport(async () => Response.json({ status: "success", data: { quote: null, summary: null, actions: {
      symbol: "SBK", currency: "ZAc", fetchedAt: "2026-10-29T18:39:54.600Z", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: [{ exDate: "2026-09-16", amount: 86.6087 }],
    } } }));
    const plain = await fetchDividendData("SBK", 300, "JSE", "ZAR");
    expect(plain.convertedFrom).toBeUndefined();
    expect(renderHeadlessPaneText(createDividendYieldHeadless(), projectDividendYieldHeadless(plain, request), request, "DVD")).toMatch(/ZAR\s0\.866087/);
  });

  test("a read without its summary takes the forward rate fundamentals state, and each error says what is missing and when it was tried", async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const triedAt = "2026-10-27T15:38:12.000Z";
    const paid = (coverage: string, exDates: string[]) => ({ symbol: "DUK", currency: "USD", fetchedAt: triedAt, coverage: { dividends: coverage },
      splits: [], earnings: [], dividends: exDates.map((exDate) => ({ exDate, amount: 1.085 })) });
    let actions = paid("available", [day(-350), day(-260), day(-170), day(-75)]);
    setHttpFetchTransport(async () => Response.json({ status: "success", data: {
      quote: null, summary: null, actions, triedAt, summaryError: "Dividend summary unavailable" } }));
    // DUK: fundamentals state 4.34 a year, declared, going ex in sixteen days.
    const stated = { rate: 4.34, exDate: day(16), currency: "USD" };
    const data = await fetchDividendData("DUK", 124, "", "USD", { loadStatedForwardRate: async () => stated });
    expect(data.metrics).toMatchObject({ forwardRate: 4.34, forwardRateAsOf: day(16), nextExDividendDate: new Date(day(16)) });
    expect(data.forwardFromFundamentals).toBe(true);
    expect(data.summaryError).toBe("Dividend summary unavailable (last tried 2026-10-27 15:38 UTC); no payout ratio or pay date.");
    const request = { rawArgument: "DUK", argument: "DUK", symbols: ["DUK"], options: {} };
    expect(projectDividendYieldHeadless(data, request).sections[0]?.textEntries?.find((entry) => entry.label === "Forward yield")?.formatted)
      .toBe(`3.50% (annualized from the declared distribution, ex ${formatDay(day(16))})`);
    // A rate stated in another currency than the cash is not taken.
    const pounds = await fetchDividendData("DUK", 124, "", "USD", { loadStatedForwardRate: async () => ({ ...stated, currency: "GBP" }) });
    expect(pounds.metrics.forwardRate).toBeNull();
    expect(pounds.summaryError).toBe("Dividend summary unavailable (last tried 2026-10-27 15:38 UTC); no forward rate, payout ratio or pay date.");

    // SO: no rows at all is a missing history, not an incomplete one; some rows short of their coverage are incomplete.
    actions = paid("unavailable", []);
    expect((await fetchDividendData("SO", 93, "", "USD")).historyError)
      .toBe("Cash history unavailable (last tried 2026-10-27 15:38 UTC); no payments, totals or growth.");
    actions = paid("unavailable", [day(-75)]);
    expect((await fetchDividendData("SO", 93, "", "USD")).historyError)
      .toBe("Incomplete cash history (last tried 2026-10-27 15:38 UTC); totals unavailable.");
  });

  test("uses recent payment cadence and does not imply suspended dividends still pay quarterly", () => {
    const quarterly = Array.from({ length: 8 }, (_, quarter) => payment(
      new Date(Date.UTC(2024, 8 + quarter * 3, 25)).toISOString().slice(0, 10),
    ));
    // TQQQ's long earlier gaps formerly changed its current quarterly cadence to semi-annual.
    const resumed = buildDividendMetrics([payment("2016-09-25"), ...quarterly], null, 100, { now });
    expect(resumed.paymentFrequency).toBe("quarterly");
    const suspended = buildDividendMetrics([
      payment("2023-11-06"), payment("2024-02-06"), payment("2024-05-06"), payment("2024-08-07"),
    ], null, 100, { now });
    expect(suspended.trailingRate).toBe(0);
    expect(suspended.paymentFrequency).toBeNull();
    const annual = buildDividendMetrics([payment("2025-05-01"), payment("2026-05-01")], null, 100, { now });
    expect(annual.paymentFrequency).toBe("annual");
  });

  test("initial loading and headless yields only use external prices with matching explicit currency", async () => {
    const timestamp = Math.floor((Date.now() - 86_400_000) / 1000);
    setHttpFetchTransport(marketTransport(async (url) => {
      if (url.includes("/chart/")) return chartResponse({
        meta: { currency: "EUR", regularMarketPrice: 80, dataGranularity: "1mo" },
        time: timestamp, close: 80, dividends: { [timestamp]: { date: timestamp, amount: 4 } },
      });
      if (url.includes("/quoteSummary/")) return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "EUR" } }] } });
      throw new Error(`Unexpected fixture URL: ${url}`);
    }));

    for (const [quoteCurrency, expectedPrice] of [["USD", 80], [undefined, 80], ["EUR", 100]] as const) {
      const data = await fetchDividendData("ASML.AS", 100, "AMS", quoteCurrency);
      expect(data.price).toBe(expectedPrice);
      expect(data.metrics.trailingYield).toBeCloseTo(4 / expectedPrice, 12);
      const result = await createDividendYieldHeadless().load({
        rawArgument: "ASML.AS", argument: "ASML.AS", symbols: ["ASML.AS"], options: {},
      }, {
        resolveInstrument: async () => ({ symbol: "ASML", exchange: "AMS" }),
        marketData: { getQuote: async () => ({ price: 100, currency: quoteCurrency }) },
      } as unknown as HeadlessPaneContext);
      expect(result.sections[0]?.entries?.find((entry) => entry.label === "Trailing yield")?.value).toBeCloseTo(4 / expectedPrice, 12);
    }
    expect(dividendReferencePrice(200, "GBp", "GBP")).toBe(2);
    expect(dividendReferencePrice(2, "GBP", "GBP")).toBe(2);
    expect(dividendReferencePrice(200, "USD", "GBP")).toBeNull();
  });

  test("leap-day trailing cash and growth retain March 1 payments inside the prior calendar year", () => {
    const metrics = buildDividendMetrics([
      payment("2019-02-01", 1), payment("2020-03-01", 1), payment("2021-03-01", 2),
      payment("2022-03-01", 3), payment("2023-03-01", 4),
    ], null, 100, { now: new Date("2024-02-29T12:00:00Z") });
    expect(metrics.trailingRate).toBe(4);
    expect(metrics.trailingYield).toBe(0.04);
    expect(metrics.growth1Y).toBeCloseTo(4 / 3 - 1, 12);
    expect(metrics.growth3Y).toBeCloseTo(Math.pow(4, 1 / 3) - 1, 12);
  });

  test("uses reported cash history over zero ETF summary fields, with calendar cutoffs and no future cash", () => {
    const payments = Array.from({ length: 12 }, (_, month) => payment(new Date(Date.UTC(2025, 9 + month, 1)).toISOString().slice(0, 10)));
    payments.push(payment("2026-10-01", 10), payment("2025-09-10", 20));
    const fields = summaryFields({ summaryDetail: {
      trailingAnnualDividendRate: { raw: 0 }, trailingAnnualDividendYield: { raw: 0 },
    } });
    const metrics = buildDividendMetrics(payments, fields, 60, { now });
    expect(metrics.trailingRate).toBe(6);
    expect(metrics.trailingYield).toBeCloseTo(0.1, 12);
    expect(repriceDividendMetrics(metrics, 120).trailingYield).toBeCloseTo(0.05, 12);
    expect(repriceDividendMetrics(metrics, NaN).trailingYield).toBeNull();
  });

  test("a sub-unit history is read in the major unit, and its forward rate annualizes the latest distribution", async () => {
    // SBK as Gloom Cloud serves it: cash in ZAc with single-precision noise, the summary in rand.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const cash = (latest: number) => [
      { exDate: day(latest - 147), amount: 878 }, { exDate: day(latest), amount: 902.00006 },
    ];
    const serve = (dividends: unknown[], summary: Record<string, unknown>, declaredDividends: unknown[] = []) => setHttpFetchTransport(async () => Response.json({
      status: "success", data: {
        actions: { symbol: "SBK", currency: "ZAc", coverage: { dividends: "available" }, dividends, declaredDividends, splits: [], earnings: [] },
        quote: { symbol: "SBK", currency: "ZAR", price: 307.87, lastUpdated: Date.now() },
        summary: { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null, exDividendDate: null,
          dividendDate: null, ...summary },
      },
    }));
    serve(cash(-37), { currency: "ZAR", forwardAnnualDividendRate: 18.04, forwardRateAsOf: day(-37) }, [{ exDate: day(30), amount: 950.00006 }]);
    const data = await fetchDividendData("SBK.JO", null, "JSE");
    expect(data.currency).toBe("ZAR");
    expect(data.payments.map((row) => [row.amount, row.currency])).toEqual([[9.02, "ZAR"], [8.78, "ZAR"]]);
    expect(data.declared).toMatchObject([{ amount: 9.5 }]);
    expect(data.metrics).toMatchObject({ trailingRate: 17.8, forwardRate: 18.04, forwardRateAsOf: day(-37) });
    expect(data.metrics.forwardYield).toBeCloseTo(18.04 / 307.87, 12);
    const entries = projectDividendYieldHeadless(data, { rawArgument: "SBK.JO", argument: "SBK.JO", symbols: ["SBK.JO"], options: {} })
      .sections[0]!.textEntries!;
    expect(entries.filter((entry) => entry.label.endsWith("rate")).map((entry) => entry.formatted?.replace(/\s/g, " "))).toEqual(["ZAR 17.80", "ZAR 18.04"]);
    // An older server stated the summary in ZAc, beside rates in an unstated unit (17.8 was rand): none is read.
    serve(cash(-37), { currency: "ZAc", trailingAnnualDividendRate: 17.8, forwardAnnualDividendRate: 1804 });
    expect((await fetchDividendData("SBK.JO", null, "JSE")).metrics).toMatchObject({ trailingRate: 17.8, forwardRate: null });
    // A semiannual dividend last paid two years ago has stopped, whatever rate is still stated for it.
    serve(cash(-730), { currency: "ZAR", forwardAnnualDividendRate: 18.04, forwardRateAsOf: day(-730) });
    expect((await fetchDividendData("SBK.JO", null, "JSE")).metrics).toMatchObject({
      forwardRate: null, forwardYield: null, lapse: { lastPaid: day(-730) },
    });
  });

  test("distinguishes no reported cash from unavailable history and does not advertise past payment dates", () => {
    const fields = summaryFields({ summaryDetail: {
      dividendDate: { raw: Date.parse("2026-08-31") / 1000 },
    } });
    expect(buildDividendMetrics([], fields, 100, { now }).trailingYield).toBe(0);
    const unavailable = buildDividendMetrics([], fields, 100, { now, historyAvailable: false });
    expect(unavailable.trailingYield).toBeNull();
    expect(unavailable.nextPayDate).toBeNull();
  });

  test("does not compare a new fund's partial first year with a full recent year", () => {
    const payments = Array.from({ length: 14 }, (_, month) => payment(new Date(Date.UTC(2025, 7 + month, 1)).toISOString().slice(0, 10)));
    const metrics = buildDividendMetrics(payments, null, 60, { now });
    expect(metrics.growth1Y).toBeNull();
    expect(metrics.growth3Y).toBeNull();
    const mature = buildDividendMetrics([
      payment("2022-08-01", 1), payment("2023-08-01", 1), payment("2024-08-01", 1.1),
      payment("2025-08-01", 1.21), payment("2026-08-01", 1.331),
    ], null, 60, { now });
    expect(mature.growth1Y).toBeCloseTo(0.1, 12);
    expect(mature.growth3Y).toBeCloseTo(0.1, 12);
  });
});

// USDY's yield accrues in its price and it pays nothing: its empty distribution history read as a 0.00% trailing yield.
test("a token has no cash yield to show, never 0.00%, and says why", async () => {
  const history = Promise.resolve({
    status: "success",
    data: {
      actions: { dividends: [], currency: "USD", providerId: "gloom", fetchedAt: "2026-11-13T14:00:00Z" },
      quote: { symbol: "USDY-USD", price: 1.1527, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-11-13T14:00:00Z"),
        instrumentType: "CRYPTOCURRENCY", exchangeName: "CCC", providerId: "gloomberb-cloud" },
      summary: null,
    },
  } as never);
  const data = await fetchDividendData("USDY-USD", 1.1527, "", "USD", { history });
  expect(data.token).toBe(true);
  expect([data.metrics.trailingYield, data.metrics.forwardYield]).toEqual([null, null]);
  const entries = projectDividendYieldHeadless(data, { rawArgument: "USDY-USD", argument: "USDY-USD", symbols: ["USDY-USD"], options: {} })
    .sections[0]!.textEntries!;
  expect(entries.find((entry) => entry.label === "Trailing yield")?.formatted).toBe("— (token: no payouts, any yield accrues in its price)");
});
