import { expect, test } from "bun:test";
import { getPublishedUsEquityCalendarDay, getPublishedUsEquitySession } from "./published-us-sessions";

function session(date: string, open: string, close: string) {
  return { kind: "session", open: Date.parse(`${date}T${open}:00Z`), close: Date.parse(`${date}T${close}:00Z`) };
}

test("regular equity sessions follow New York daylight saving across both transition weekends", () => {
  for (const exchange of ["NYSE", "NASDAQ"]) {
    for (const [date, open, close] of [
      ["2026-03-06", "14:30", "21:00"], ["2026-03-09", "13:30", "20:00"],
      ["2026-10-30", "13:30", "20:00"], ["2026-11-02", "14:30", "21:00"],
      ["2026-09-21", "13:30", "20:00"], ["2026-09-22", "13:30", "20:00"],
    ] as const) expect(getPublishedUsEquitySession(exchange, date)).toEqual(session(date, open, close));
    expect(getPublishedUsEquitySession(exchange, "2026-03-08")).toEqual({ kind: "closed" });
    expect(getPublishedUsEquitySession(exchange, "2026-11-01")).toEqual({ kind: "closed" });
  }
});

test("published early closes remain sessions and do not change adjacent holiday or regular-session hours", () => {
  for (const exchange of ["NYSE", "NASDAQ"]) {
    expect(getPublishedUsEquitySession(exchange, "2026-11-25")).toEqual(session("2026-11-25", "14:30", "21:00"));
    expect(getPublishedUsEquitySession(exchange, "2026-11-26")).toEqual({ kind: "closed" });
    expect(getPublishedUsEquitySession(exchange, "2026-11-27")).toEqual(session("2026-11-27", "14:30", "18:00"));
    expect(getPublishedUsEquitySession(exchange, "2026-11-30")).toEqual(session("2026-11-30", "14:30", "21:00"));
    expect(getPublishedUsEquitySession(exchange, "2026-12-24")).toEqual(session("2026-12-24", "14:30", "18:00"));
    expect(getPublishedUsEquitySession(exchange, "2026-12-25")).toEqual({ kind: "closed" });
    expect(getPublishedUsEquitySession(exchange, "2026-07-02")).toEqual(session("2026-07-02", "13:30", "20:00"));
    expect(getPublishedUsEquitySession(exchange, "2026-07-03")).toEqual({ kind: "closed" });
  }
  expect(getPublishedUsEquitySession("NYSE", "2025-07-03")).toEqual(session("2025-07-03", "13:30", "17:00"));
  expect(getPublishedUsEquitySession("NYSE", "2027-11-26")).toEqual(session("2027-11-26", "14:30", "18:00"));
  expect(getPublishedUsEquitySession("NYSE", "2028-07-03")).toEqual(session("2028-07-03", "13:30", "17:00"));
});

test("coverage distinguishes published closures from unknown dates, years and Nasdaq actual-close coverage", () => {
  expect(getPublishedUsEquitySession("NYSE", "2025-01-08")).toEqual(session("2025-01-08", "14:30", "21:00"));
  expect(getPublishedUsEquitySession("NYSE", "2025-01-09")).toEqual({ kind: "closed" });
  expect(getPublishedUsEquitySession("NYSE", "2025-01-10")).toEqual(session("2025-01-10", "14:30", "21:00"));
  expect(getPublishedUsEquitySession("NYSE", "2027-12-31")).toEqual(session("2027-12-31", "14:30", "21:00"));
  expect(getPublishedUsEquitySession("NYSE", "2028-01-01")).toEqual({ kind: "closed" });
  expect(getPublishedUsEquitySession("NYSE", "2028-01-03")).toEqual(session("2028-01-03", "14:30", "21:00"));
  for (const date of ["2024-12-31", "2029-01-01", "2026-02-29", "2026-11-31", "2026-9-22", "2026-09-22T00:00:00Z", ""]) {
    expect(getPublishedUsEquitySession("NYSE", date)).toBeNull();
  }
  expect(getPublishedUsEquitySession("NYSE", "2028-02-29")).toEqual(session("2028-02-29", "14:30", "21:00"));
  // Nasdaq publishes the same closures and early closes as NYSE.
  for (const date of ["2025-01-09", "2025-11-28", "2025-12-01", "2027-11-26", "2028-12-29"]) {
    expect(getPublishedUsEquitySession("NASDAQ", date)).toEqual(getPublishedUsEquitySession("NYSE", date));
  }
  expect(getPublishedUsEquitySession("NASDAQ", "2029-01-02")).toBeNull();
  expect(getPublishedUsEquityCalendarDay("NASDAQ", "2025-01-09")).toBe("closed");
  expect(getPublishedUsEquityCalendarDay("NASDAQ", "2025-11-28")).toBe("session");
});

test("declared listing aliases retain coverage while routing and other asset venues cannot borrow it", () => {
  const expected = session("2026-11-27", "14:30", "18:00");
  for (const exchange of ["NYSE", "NYQ", "XNYS", "NYSEARCA", "NYSE Arca", "AMEX", "ASE", "NYSE NATIONAL", "NYSE CHICAGO", "NYSE TEXAS", "NASDAQGS", "NASDAQGM", "NMS", "XNAS", " nasdaq "]) {
    expect(getPublishedUsEquitySession(exchange, "2026-11-27")).toEqual(expected);
  }
  for (const exchange of ["", "SMART", "LSE", "TSX", "HKEX", "FX", "CCY", "CCC", "CME", "NYMEX", "GLOBEX", "UNKNOWN"]) {
    expect(getPublishedUsEquitySession(exchange, "2026-11-27")).toBeNull();
    expect(getPublishedUsEquitySession(exchange, "2026-11-28")).toBeNull();
  }
});
