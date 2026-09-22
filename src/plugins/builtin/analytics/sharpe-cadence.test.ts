import { expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { computeDatedReturns } from "./metrics";
import { qualifySharpeCadence, qualifyReturnTimestamps } from "./sharpe-cadence";
import { buildBenchmarkReturnSeries, buildPortfolioBetaResult, buildPortfolioChartTargets, buildPortfolioReturnSeries, PORTFOLIO_BENCHMARK } from "./pane-model";
import { buildChartKey } from "../../../market-data/selectors";
import type { TickerRecord } from "../../../types/ticker";

function qualify(dates: string[], exchange = "NYSE") {
  const history = dates.map((date, index): PricePoint => ({ date: new Date(date), close: 100 + index }));
  const returns = computeDatedReturns(history);
  const snapshot = JSON.stringify({ history, returns });
  const result = qualifySharpeCadence(returns, [{ symbol: "CONTROL", exchange, history }]);
  expect(JSON.stringify({ history, returns })).toBe(snapshot);
  return result;
}

test("whole daily sample keeps weekend, holiday-reopening and early-close returns", () => {
  expect(qualify(["2026-06-18", "2026-06-22", "2026-06-23"]).supported).toBe(true);
  expect(qualify(["2026-07-02", "2026-07-06", "2026-07-07"], "NYQ").supported).toBe(true);
  expect(qualify(["2026-11-25", "2026-11-27", "2026-11-30"], "NASDAQ").supported).toBe(true);
});

test("an omitted trading session rejects the whole sample even when all sources could share endpoints", () => {
  const result = qualify(["2026-06-01", "2026-06-02", "2026-06-04", "2026-06-05"]);
  expect(result).toMatchObject({ supported: false, reason: "Non-daily return sample", issue: { kind: "missing-session", startDate: "2026-06-02", date: "2026-06-04" } });
  expect(qualify(["2026-06-01", "2026-06-03", "2026-06-05"]).supported).toBe(false);
});

test("unknown venue and year cannot borrow a supported calendar", () => {
  expect(qualify(["2026-06-01", "2026-06-02"], "SMART").issue?.kind).toBe("unsupported-venue");
  expect(qualify(["2026-06-01", "2026-06-02"], "LSE").issue?.kind).toBe("unsupported-venue");
  expect(qualify(["2024-12-30", "2024-12-31"]).issue?.kind).toBe("unsupported-year");
  expect(qualify(["2029-06-01", "2029-06-04"], "NASDAQ").issue?.kind).toBe("unsupported-year");
  expect(qualify(["2027-06-01", "2027-06-02"], "NASDAQ").supported).toBe(true);
});

test("Carter closure is included and Saturday New Year's Day does not invent a Friday closure", () => {
  expect(qualify(["2025-01-08", "2025-01-10"], "NASDAQ").supported).toBe(true);
  expect(qualify(["2025-01-08", "2025-01-09", "2025-01-10"]).issue?.kind).toBe("closed-session");
  expect(qualify(["2027-12-30", "2027-12-31", "2028-01-03"]).supported).toBe(true);
  expect(qualify(["2027-12-30", "2028-01-03"]).issue?.kind).toBe("missing-session");
  expect(qualify(["2026-06-19", "2026-06-22"]).issue?.kind).toBe("closed-session");
});

test("intraday endpoint observations do not establish daily closes; exact timestamp corrections do", () => {
  const history = [
    { date: new Date("2026-06-01T12:00:00Z"), close: 99 },
    { date: new Date("2026-06-01T20:00:00Z"), close: 100 },
    { date: new Date("2026-06-02T20:00:00Z"), close: 101 },
  ];
  expect(qualifySharpeCadence(computeDatedReturns(history), [{ symbol: "CONTROL", exchange: "NYSE", history }]).issue?.kind).toBe("non-daily-observations");
  const corrected = [...history.slice(1), { ...history[1]!, close: 100.5 }];
  const result = qualifySharpeCadence(computeDatedReturns(corrected), [{ symbol: "CONTROL", exchange: "NYSE", history: corrected }]);
  expect(result.supported).toBe(true);
  expect(result.basis.checkedAt).toBe("2026-09-12");
  expect(result.basis.nasdaq.years).not.toContain(2029);
});

test("daily source timestamps preserve date labels and exchange-open DST while rejecting cross-midnight and mixed conventions", () => {
  expect(qualify(["2026-06-01T23:59:00Z", "2026-06-02T00:01:00Z"]).issue?.kind).toBe("timestamp-convention");
  expect(qualify(["2026-03-06T14:30:00Z", "2026-03-09T13:30:00Z", "2026-03-10T13:30:00Z"]).supported).toBe(true);
  expect(qualify(["2026-03-06T00:00:00Z", "2026-03-09T00:00:00Z"]).supported).toBe(true);
  expect(qualify(["2026-03-06T00:00:00Z", "2026-03-09T13:30:00Z"]).issue?.kind).toBe("timestamp-convention");
  expect(qualify(["2026-11-25T14:30:00Z", "2026-11-27T14:30:00Z", "2026-11-30T14:30:00Z"]).supported).toBe(true);
});

test("verified actual session closes retain early-close returns", () => {
  const dates = ["2026-11-25T21:00:00Z", "2026-11-27T18:00:00Z", "2026-11-30T21:00:00Z"];
  expect(qualify(dates, "NYSE").sourceConventions?.[0]?.convention).toBe("published-session-close");
  expect(qualify(dates, "NASDAQ").supported).toBe(true);
  expect(qualify(["2025-11-26T21:00:00Z", "2025-11-28T18:00:00Z", "2025-12-01T21:00:00Z"], "NYSE").supported).toBe(true);
  expect(qualify(["2025-11-26T21:00:00Z", "2025-11-28T18:00:00Z", "2025-12-01T21:00:00Z"], "NASDAQ").supported).toBe(true);
});

test("beta timestamp eligibility does not borrow a calendar or a missing benchmark venue", () => {
  const history = ["2029-01-02", "2029-01-04"].map((date, index) => ({ date: new Date(date), close: 100 + index }));
  const source = { symbol: "SPY", exchange: "", history };
  const returns = computeDatedReturns(history);
  expect(qualifyReturnTimestamps(returns, [source]).supported).toBe(true);
  expect(qualifySharpeCadence(returns, [source]).supported).toBe(false);
  const nonmidnight = history.map((point) => ({ ...point, date: new Date(point.date.getTime() + 14.5 * 3_600_000) }));
  expect(qualifyReturnTimestamps(computeDatedReturns(nonmidnight), [{ ...source, history: nonmidnight }]).supported).toBe(false);
  expect(qualifyReturnTimestamps(computeDatedReturns(nonmidnight), [{ ...source, exchange: "NYSE", history: nonmidnight }]).supported).toBe(true);
});

test("beta validates both sources on its actual overlap, preserving valid comparison beyond unrelated old observations", () => {
  const ticker: TickerRecord = { metadata: {
    ticker: "CONTROL", exchange: "NYSE", currency: "USD", name: "Controlled", portfolios: ["main"], watchlists: [], custom: {}, tags: [],
    positions: [{ portfolio: "main", shares: 1, avgCost: 100, markPrice: 100, currency: "USD", broker: "manual" }],
  } };
  const dates = ["03", "04", "05", "06", "09", "10", "11", "12", "13", "16", "17", "18", "19", "20"];
  const prices = (factor: number) => {
    let close = 100;
    return dates.map((day, index) => ({ date: new Date(`2026-11-${day}`), close: index ? (close *= 1 + factor * [.01, -.02, .005][index % 3]!) : close }));
  };
  const target = buildPortfolioChartTargets([ticker])[0]!;
  const request = { instrument: { symbol: PORTFOLIO_BENCHMARK.symbol, exchange: PORTFOLIO_BENCHMARK.exchange }, bufferRange: "1Y" as const, granularity: "range" as const };
  const old = [{ date: new Date("2026-10-30T12:00Z"), close: 98 }, { date: new Date("2026-10-30T13:00Z"), close: 99 }];
  const beta = (holding: PricePoint[], benchmark: PricePoint[]) => buildPortfolioBetaResult(
    buildPortfolioReturnSeries({ chartTargets: [target], chartEntries: new Map([[buildChartKey(target.request!), { data: holding }]]), financials: new Map(), columnContext: { activeTab: "main", baseCurrency: "USD", exchangeRates: new Map(), now: 0 } }),
    buildBenchmarkReturnSeries(request, new Map([[buildChartKey(request), { data: benchmark }]])),
  );
  const clean = beta(prices(2), prices(1));
  expect(clean.value).toBeCloseTo(2, 8);
  expect(beta(prices(2), [...old, ...prices(1)]).value).toBeCloseTo(clean.value!, 8);
  expect(beta([...old, ...prices(2)], prices(1)).value).toBeCloseTo(clean.value!, 8);
  const intraday = [{ date: new Date("2026-11-05T12:00Z"), close: 98 }, { date: new Date("2026-11-05T13:00Z"), close: 99 }];
  expect(beta(prices(2), [...prices(1), ...intraday]).value).toBeNull();
  expect(beta([...prices(2), ...intraday], prices(1)).value).toBeNull();
});
