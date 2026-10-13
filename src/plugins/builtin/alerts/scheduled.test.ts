import { expect, test } from "bun:test";
import { parseAlertAddArgs } from "./cli";
import { EVENT_ALERTS_KEY, readEventAlerts } from "./events";
import { checkScheduledEventAlertsNow, startScheduledEventAlerts } from "./scheduled-check";
import {
  createScheduledAlert,
  lookupScheduledDates,
  nextCpiReleaseDate,
  nextEarningsDate,
  parseLeadDays,
  readScheduledRule,
  rearmScheduledAlert,
  scheduledAlertMessage,
  scheduledPhase,
  type ScheduledEventSources,
} from "./scheduled";

test("an alert is armed until its lead day, due through the event day, and done once it has gone off", () => {
  // Three days before Mon Nov 2 is Fri Oct 30, across the month end.
  expect(scheduledPhase("2026-11-02", 3, undefined, "2026-10-29")).toBe("armed");
  expect(scheduledPhase("2026-11-02", 3, undefined, "2026-10-30")).toBe("due");
  expect(scheduledPhase("2026-11-02", 3, undefined, "2026-11-02")).toBe("due");
  expect(scheduledPhase("2026-11-02", 3, "2026-11-02", "2026-11-01")).toBe("fired");
  expect(scheduledPhase("2026-11-02", 3, "2026-11-02", "2026-11-03")).toBe("passed");
  // Fired for the last report, armed again for the next one.
  expect(scheduledPhase("2027-02-01", 3, "2026-11-02", "2026-11-03")).toBe("armed");
  expect(scheduledPhase(undefined, 3, undefined, "2026-11-03")).toBe("unscheduled");
  expect(scheduledAlertMessage({ kind: "earnings", symbol: "CRWV", exchange: "" }, "2026-11-09", "2026-11-06"))
    .toBe("CRWV earnings in 3 days, Mon, Nov 9");
  expect(scheduledAlertMessage({ kind: "macro", event: "cpi" }, "2026-10-14", "2026-10-13")).toBe("CPI release tomorrow, Wed, Oct 14");
});

test("the next event date comes from the day the app shows it on", () => {
  const events = [
    { symbol: "CRWV", earningsDate: new Date("2026-08-12T20:00:00Z") },
    { symbol: "CRWV", earningsDate: new Date("2026-11-09T00:00:00Z") },
    { symbol: "AAPL", earningsDate: new Date("2026-10-30T20:00:00Z") },
  ];
  expect(nextEarningsDate(events, "crwv", "2026-10-10")).toBe("2026-11-09");
  expect(nextEarningsDate(events, "CRWV", "2026-11-10")).toBeNull();
  // 08:30 New York is the release day; the calendar's own days count too.
  expect(nextCpiReleaseDate({ release: { nextReleaseAt: "2026-10-14T12:30:00.000Z" } }, "2026-10-10")).toBe("2026-10-14");
  expect(nextCpiReleaseDate({
    release: { nextReleaseAt: "2026-10-14T12:30:00.000Z" },
    schedule: [{ date: "2026-10-14" }, { date: "2026-11-10" }, { date: "bad" }],
  }, "2026-10-15")).toBe("2026-11-10");
});

test("a failing source leaves the other events' dates alone", async () => {
  const sources: ScheduledEventSources = {
    earnings: async () => { throw new Error("UPSTREAM_ERROR"); },
    cpi: async () => ({ release: { nextReleaseAt: "2026-10-14T12:30:00.000Z" } }),
    fomc: async () => [{ date: "2026-09-16" }, { date: "2026-10-28" }],
  };
  const dates = await lookupScheduledDates([
    { kind: "earnings", symbol: "CRWV", exchange: "" },
    { kind: "macro", event: "cpi" },
    { kind: "macro", event: "fomc" },
  ], sources, "2026-10-10");
  expect(Object.fromEntries(dates)).toEqual({
    "earnings:CRWV": { error: "UPSTREAM_ERROR" },
    "macro:cpi": { date: "2026-10-14" },
    "macro:fomc": { date: "2026-10-28" },
  });
});

test("event rules keep their dates through storage and take only US listings and 1 to 14 days", () => {
  const rule = { ...createScheduledAlert({ kind: "earnings", symbol: "CRWV", exchange: "NASDAQ" }, 3, "2026-11-09", 1_000), firedFor: "2026-08-12" };
  const macro = createScheduledAlert({ kind: "macro", event: "cpi" }, 1, null, 1_000);
  const { rules, error } = readEventAlerts(JSON.stringify([rule, { ...macro, eventDate: "soon" }]));
  expect(error).toBeNull();
  expect(rules[0]).toMatchObject({ kind: "earnings_date", eventDate: "2026-11-09", firedFor: "2026-08-12" });
  expect(readScheduledRule(rules[0]!)).toEqual({ target: { kind: "earnings", symbol: "CRWV", exchange: "NASDAQ" }, leadDays: 3 });
  // A date that does not read is dropped; the rule stays.
  expect(rules[1]!.eventDate).toBeUndefined();
  expect(readScheduledRule(rules[1]!)).toEqual({ target: { kind: "macro", event: "cpi" }, leadDays: 1 });
  expect(rearmScheduledAlert(rules[0]!).firedFor).toBeUndefined();
  expect(() => createScheduledAlert({ kind: "earnings", symbol: "SAN", exchange: "EPA" }, 1, null)).toThrow("US listings");
  expect(readEventAlerts(JSON.stringify([{ ...macro, value: JSON.stringify({ version: 1, event: "cpi", leadDays: 15 }) }])).error).not.toBeNull();
  expect([parseLeadDays(undefined), parseLeadDays("14"), parseLeadDays("0"), parseLeadDays("15"), parseLeadDays("2.5")]).toEqual([1, 14, null, null, null]);
});

test("alerts add reads price, earnings and macro forms and names what it takes", () => {
  expect(parseAlertAddArgs(["AAPL", "above", "250"], undefined)).toEqual({ kind: "price", symbol: "AAPL", condition: "above", price: 250 });
  expect(parseAlertAddArgs(["CRWV", "earnings"], "3")).toEqual({ kind: "earnings", symbol: "CRWV", leadDays: 3 });
  expect(parseAlertAddArgs(["cpi"], undefined)).toEqual({ kind: "macro", event: "cpi", leadDays: 1 });
  // A ticker named like an event still takes a price alert.
  expect(parseAlertAddArgs(["CPI", "below", "3"], undefined)).toMatchObject({ kind: "price", symbol: "CPI" });
  expect(() => parseAlertAddArgs(["NFP"], undefined)).toThrow("CPI or FOMC");
  expect(() => parseAlertAddArgs(["CRWV", "earnings"], "0")).toThrow("1 to 14");
  expect(() => parseAlertAddArgs(["CPI"], null)).toThrow("1 to 14");
  expect(() => parseAlertAddArgs(["AAPL", "above", "250"], "2")).toThrow("not price alerts");
  expect(() => parseAlertAddArgs(["CRWV", "dividends"], undefined)).toThrow("earnings");
});

test("alerts add reads a price pasted from a sheet, and asks when a comma and three digits could be either reading", () => {
  const price = (text: string) => (parseAlertAddArgs(["USDNGN=X", "above", text], undefined) as { price: number }).price;
  expect(["1.350,5", "1,350.5", "1 350,5", "1\u00a0350,5", "1350,5", "1350.5"].map(price)).toEqual([1350.5, 1350.5, 1350.5, 1350.5, 1350.5, 1350.5]);
  expect(["1,350,000", "1.350.000"].map(price)).toEqual([1350000, 1350000]);
  // A plain dotted number keeps its meaning.
  expect(price("1.350")).toBe(1.35);
  expect(() => price("1,350")).toThrow("1,350 could be 1350 (thousands) or 1.35 (decimal comma); type 1350 or 1.35");
  expect(() => price("abc")).toThrow("Alert price must be a finite number.");
  expect(() => price("1,23,456")).toThrow("Alert price must be a finite number.");
});

test("the app alerts once when the lead time is reached and saves the event it alerted for", async () => {
  const rule = createScheduledAlert({ kind: "macro", event: "cpi" }, 1, null, 1_000);
  const store = new Map<string, string>([[EVENT_ALERTS_KEY, JSON.stringify([rule])]]);
  const notifications: string[] = [];
  let saved = Promise.withResolvers<void>();
  const ctx = {
    configState: {
      get: (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => { store.set(key, String(value)); saved.resolve(); },
    },
    notify: (notification: { body?: string }) => { notifications.push(notification.body ?? ""); },
    showPane() {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const sources: ScheduledEventSources = {
    earnings: async () => [],
    cpi: async () => ({ release: { nextReleaseAt: "2026-10-14T12:30:00.000Z" } }),
    fomc: async () => [],
  };
  // Tue Oct 13, 10:00 in New York: one day before the release.
  const stop = startScheduledEventAlerts(ctx as never, sources, () => Date.parse("2026-10-13T14:00:00Z"));
  try {
    checkScheduledEventAlertsNow();
    await saved.promise;
    expect(notifications).toEqual(["CPI release tomorrow, Wed, Oct 14"]);
    expect(readEventAlerts(store.get(EVENT_ALERTS_KEY)!).rules[0]).toMatchObject({ eventDate: "2026-10-14", firedFor: "2026-10-14" });

    saved = Promise.withResolvers<void>();
    checkScheduledEventAlertsNow();
    await Bun.sleep(10);
    expect(notifications).toHaveLength(1);
  } finally {
    stop();
  }
});
