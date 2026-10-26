import { expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import type { EarningsEvent } from "../../../types/data-provider";
import type { EarningsAction } from "../../../types/financials";
import { historyRows } from "../earnings/history-model";
import { resolveCalendarEvent, resolveEarningsActions, resolveListingEvents, upcomingReportDate, withResolvedEarnings } from "./earnings-calendar";

// The four companies as Gloom Cloud served them on 2026-10-21 and 22.
const TODAY = "2026-10-22";
const CONSENSUS = { source: "calendarEvents", sourceValue: 0, period: null, periodEndDate: null } as const;

function event(symbol: string, earningsDate: string, fields: Partial<EarningsEvent> = {}): EarningsEvent {
  return {
    symbol, name: symbol, earningsDate: new Date(earningsDate), isDateEstimate: false, timing: "BMO",
    epsEstimate: null, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, ...fields,
  };
}

type HistoryReport = EarningsHistoryPayload["reports"][number];
const historyReport = (fields: Partial<HistoryReport> & Pick<HistoryReport, "date">): HistoryReport => ({
  symbol: "X", name: null, timing: "bmo", timingSource: "calendar", reportedAt: null, fiscalPeriod: null, marketCap: null,
  epsEstimate: null, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null, implied: null, realized: null,
  revenueActual: null, ...fields,
});
const history = (...reports: HistoryReport[]): EarningsHistoryPayload => ({ asOf: `${TODAY}T15:00:00Z`, symbol: "X", name: null, reports });

test("a confirmed date beats an estimated one, whichever source has it", async () => {
  // JPM: corporate actions carry the feed's 2027-01-13 with no status and no estimate; the calendar has 2027-01-14 confirmed.
  const jpm = event("JPM", "2027-01-14T12:30:00Z", { epsEstimate: 5.9, epsAnalysts: 12, estimateBasis: { epsEstimate: CONSENSUS, epsAnalysts: CONSENSUS } });
  const actions = resolveEarningsActions([
    { date: "2027-01-13", time: "Pre Market", fiscalPeriod: "2026-12" },
    { date: "2026-10-13", epsEstimate: 5.94, epsActual: 5.75, dateStatus: "reported" },
  ], jpm, TODAY);
  expect(actions.map((row) => row.date)).toEqual(["2027-01-14", "2026-10-13"]);
  expect(actions[0]).toMatchObject({ dateStatus: "confirmed", time: "Pre Market", epsEstimate: 5.9, epsAnalysts: 12, fiscalPeriod: "2026-12" });
  // ERN's history takes it over a projected date the same way, keeping what the history knows of the report.
  const ern = historyRows(history(historyReport({ date: "2027-01-13", dateStatus: "projected", timingSource: "history", fiscalPeriod: "2026-12" })), TODAY, jpm);
  expect(ern[0]).toMatchObject({ date: "2027-01-14", dateStatus: "confirmed", epsEstimate: 5.9, fiscalPeriod: "2026-12", upcoming: true });

  // A date confirmed on record stands over the calendar's estimate.
  const confirmed: EarningsAction = { date: "2027-01-13", dateStatus: "confirmed" };
  const estimated = event("JPM", "2027-01-20T12:30:00Z", { isDateEstimate: true });
  expect(resolveEarningsActions([confirmed], estimated, TODAY)).toEqual([confirmed]);
  expect(upcomingReportDate(resolveCalendarEvent(estimated, [confirmed], TODAY))).toBe("2027-01-13");
  // `earnings`, OSA and the LEAPS column read the record for a date the calendar has not confirmed, and only then.
  const read: string[] = [];
  const provider = {
    getCorporateActions: async (symbol: string) => {
      read.push(symbol);
      return { symbol, dividends: [], splits: [], earnings: [confirmed] };
    },
  };
  const listing = (key: string) => ({ key, symbol: key, exchange: "" });
  const listed = await resolveListingEvents(provider, [listing("JPM"), listing("GS")], [estimated, event("GS", "2027-01-19T12:30:00Z")], TODAY);
  expect(listed.get("JPM")).toMatchObject({ dateStatus: "confirmed", isDateEstimate: false });
  expect(upcomingReportDate(listed.get("JPM"))).toBe("2027-01-13");
  expect(read).toEqual(["JPM"]);
  // On the same date, the record's confirmed status stands and the calendar's figures stay.
  const sameDay = event("JPM", "2027-01-13T12:30:00Z", { isDateEstimate: true, epsEstimate: 5.9, revenueEstimate: 51e9 });
  expect(resolveCalendarEvent(sameDay, [confirmed], TODAY))
    .toMatchObject({ dateStatus: "confirmed", isDateEstimate: false, epsEstimate: 5.9, revenueEstimate: 51e9 });

  // GS: a next date only the calendar has is added.
  expect(resolveEarningsActions([{ date: "2026-10-13", epsActual: 17.01, dateStatus: "reported" }], event("GS", "2027-01-19T12:30:00Z"), TODAY)[0])
    .toMatchObject({ date: "2027-01-19", dateStatus: "confirmed" });
});

test("a date gone by is reported, with the actual and the estimate it was measured against", () => {
  // PEP: the calendar still names 2026-10-08, beside the December quarter's consensus.
  const pep = event("PEP", "2026-10-08T12:30:00Z", {
    epsEstimate: 2.24,
    estimateBasis: { epsEstimate: { source: "earningsTrend", sourceValue: 2.24, period: "0q", periodEndDate: "2026-12-31", currency: "USD" } },
  });
  const record: EarningsAction[] = [{ date: "2026-10-08", epsEstimate: 2.29, epsActual: 2.34, epsAnalysts: 7, dateStatus: "reported" }];
  const resolved = resolveCalendarEvent(pep, record, TODAY);
  expect(resolved).toMatchObject({ dateStatus: "reported", epsEstimate: 2.29, epsActual: 2.34, epsAnalysts: 7, timing: "BMO" });
  expect(upcomingReportDate(resolved)).toBeNull();
  // Without the record it still reads reported, and never with another quarter's estimate.
  expect(resolveCalendarEvent(pep, null, TODAY)).toMatchObject({ dateStatus: "reported", epsEstimate: null, epsActual: null });
  // A next date on record stands in for the calendar's past one.
  expect(upcomingReportDate(resolveCalendarEvent(pep, [...record, { date: "2027-02-04", dateStatus: "projected" }], TODAY))).toBe("2027-02-04");
  // A consensus nothing ties to the report is left out too: a past date with no forecast quarter and no actual.
  const untied = event("PEP", "2026-10-08T12:30:00Z", { epsEstimate: 2.24, epsLow: 2.1, revenueEstimate: 30e9, estimateBasis: { epsEstimate: CONSENSUS } });
  expect(resolveCalendarEvent(untied, null, TODAY)).toMatchObject({ dateStatus: "reported", epsEstimate: null, epsLow: null, revenueEstimate: null });
  // A date on record that passed with no figure is reported too, in events and EE with or without a calendar event.
  const actions = { symbol: "PEP", dividends: [], splits: [], earnings: [{ date: "2026-07-09", dateStatus: "confirmed" as const }] };
  expect(withResolvedEarnings(actions, null, TODAY).earnings[0]!.dateStatus).toBe("reported");
});

test("a reported calendar event keeps the revenue, range and basis it carries for its report", () => {
  const out = event("AAA", "2026-10-15T12:30:00Z", {
    epsEstimate: 1, epsActual: 1.1, epsLow: 0.9, epsHigh: 1.2, revenueEstimate: 500, revenueActual: 520, surprise: 10,
    estimateBasis: { epsEstimate: CONSENSUS, epsLow: CONSENSUS, epsHigh: CONSENSUS, revenueEstimate: CONSENSUS },
  });
  const kept = { dateStatus: "reported", epsEstimate: 1, epsActual: 1.1, epsLow: 0.9, epsHigh: 1.2,
    revenueEstimate: 500, revenueActual: 520, estimateBasis: out.estimateBasis, timing: "BMO" };
  expect(resolveCalendarEvent(out, null, TODAY)).toMatchObject(kept);
  expect(resolveCalendarEvent(out, [{ date: "2026-10-15", epsEstimate: 1, epsActual: 1.1, dateStatus: "reported" }], TODAY)).toMatchObject(kept);
});

test("a report out today is reported in every source once Gloom Cloud has it out, its actual once known", () => {
  // META after the close: the calendar has the report out before its figure, corporate actions have no row for it yet.
  const meta = event("META", `${TODAY}T20:00:00Z`, { timing: "AMC", dateStatus: "reported", epsEstimate: 6.52 });
  const added = resolveEarningsActions([], meta, TODAY);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ date: TODAY, time: "After Hours", epsEstimate: 6.52, dateStatus: "reported" });
  expect(resolveCalendarEvent(meta, [], TODAY)).toMatchObject({ dateStatus: "reported", epsActual: null });
  expect(resolveCalendarEvent(meta, [{ date: TODAY, epsEstimate: 6.52, epsActual: 7.4, dateStatus: "reported" }], TODAY))
    .toMatchObject({ dateStatus: "reported", epsActual: 7.4 });
  // ERN's row stays the upcoming one until its move settles, now reported.
  expect(historyRows(history(historyReport({ date: TODAY, timing: "amc", dateStatus: "confirmed" })), TODAY, meta)[0])
    .toMatchObject({ date: TODAY, dateStatus: "reported", upcoming: true });
  // Before it is out, today's report is still confirmed.
  expect(resolveCalendarEvent({ ...meta, dateStatus: undefined }, null, TODAY).dateStatus).toBe("confirmed");
});
