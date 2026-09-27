import { expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { resolveDatedReturns } from "./metrics";
import { qualifySharpeCadence, qualifyReturnTimestamps } from "./sharpe-cadence";

const datedReturns = (history: PricePoint[]) => resolveDatedReturns(history).returns;

function qualify(dates: string[], exchange = "NYSE") {
  const history = dates.map((date, index): PricePoint => ({ date: new Date(date), close: 100 + index }));
  const returns = datedReturns(history);
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
  expect(qualifySharpeCadence(datedReturns(history), [{ symbol: "CONTROL", exchange: "NYSE", history }]).issue?.kind).toBe("non-daily-observations");
  const corrected = [...history.slice(1), { ...history[1]!, close: 100.5 }];
  const result = qualifySharpeCadence(datedReturns(corrected), [{ symbol: "CONTROL", exchange: "NYSE", history: corrected }]);
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
  const returns = datedReturns(history);
  expect(qualifyReturnTimestamps(returns, [source]).supported).toBe(true);
  expect(qualifySharpeCadence(returns, [source]).supported).toBe(false);
  const nonmidnight = history.map((point) => ({ ...point, date: new Date(point.date.getTime() + 14.5 * 3_600_000) }));
  expect(qualifyReturnTimestamps(datedReturns(nonmidnight), [{ ...source, history: nonmidnight }]).supported).toBe(false);
  expect(qualifyReturnTimestamps(datedReturns(nonmidnight), [{ ...source, exchange: "NYSE", history: nonmidnight }]).supported).toBe(true);
});
