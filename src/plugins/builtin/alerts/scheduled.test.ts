import { expect, test } from "bun:test";
import { getVisibleWorkflowFields, normalizeWizardFields } from "../../../components/command-bar/workflow/fields";
import { parseAlertAddArgs, thousandsDotMessage } from "./cli";
import { EVENT_ALERTS_KEY, readEventAlerts } from "./events";
import { createResearchAlert, earningsResultsAlertValues, researchAlertDescription, researchWizardFields } from "./research-builder";
import { checkScheduledEventAlertsNow, startScheduledEventAlerts } from "./scheduled-check";
import {
  createScheduledAlert,
  lookupScheduledDates,
  nextCpiReleaseDate,
  nextEarningsDate,
  parseLeadDays,
  readEarningsResults,
  readScheduledRule,
  rearmScheduledAlert,
  reportedResult,
  scheduledAlertMessage,
  scheduledPhase,
  scheduledResultsMessage,
  type EarningsResultRow,
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
  expect(readScheduledRule(rules[0]!)).toEqual({ target: { kind: "earnings", symbol: "CRWV", exchange: "NASDAQ" }, leadDays: 3, trigger: "date" });
  // A date that does not read is dropped; the rule stays.
  expect(rules[1]!.eventDate).toBeUndefined();
  expect(readScheduledRule(rules[1]!)).toEqual({ target: { kind: "macro", event: "cpi" }, leadDays: 1, trigger: "date" });
  expect(rearmScheduledAlert(rules[0]!).firedFor).toBeUndefined();
  expect(() => createScheduledAlert({ kind: "earnings", symbol: "SAN", exchange: "EPA" }, 1, null)).toThrow("US listings");
  expect(readEventAlerts(JSON.stringify([{ ...macro, value: JSON.stringify({ version: 1, event: "cpi", leadDays: 15 }) }])).error).not.toBeNull();
  expect([parseLeadDays(undefined), parseLeadDays("14"), parseLeadDays("0"), parseLeadDays("15"), parseLeadDays("2.5")]).toEqual([1, 14, null, null, null]);
});

test("alerts add reads price, earnings and macro forms and names what it takes", () => {
  expect(parseAlertAddArgs(["AAPL", "above", "250"], undefined)).toEqual({ kind: "price", symbol: "AAPL", condition: "above", price: 250 });
  expect(parseAlertAddArgs(["CRWV", "earnings"], "3")).toEqual({ kind: "earnings", symbol: "CRWV", leadDays: 3 });
  expect(parseAlertAddArgs(["CRWV", "earnings", "results"], undefined)).toEqual({ kind: "earnings", symbol: "CRWV", leadDays: 0, results: true });
  expect(() => parseAlertAddArgs(["CRWV", "earnings", "results"], "2")).toThrow("takes no --days");
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

test("alerts add asks about 81.000 near a price of 81,600, an unquoted 81 000, and refuses a word after the price", () => {
  const add = (...args: string[]) => parseAlertAddArgs(["BTC-USD", "below", ...args], undefined) as Extract<ReturnType<typeof parseAlertAddArgs>, { kind: "price" }>;
  expect(thousandsDotMessage(add("81.000"), "BTC-USD", 81_634.52))
    .toBe("81.000 could be 81000 (thousands) or 81 (decimal point), and BTC-USD last traded at 81634.52; type gloomberb alerts add BTC-USD below 81000 or gloomberb alerts add BTC-USD below 81");
  expect(thousandsDotMessage(add("81.250"), "BTC-USD", 81_634.52, "CCC")).toContain("type gloomberb alerts add BTC-USD below 81250 --exchange CCC or");
  // Near the number as written, without a last price, or with fewer decimals, the price reads as typed.
  expect(thousandsDotMessage(add("81.000"), "BTC-USD", 80.5)).toBeNull();
  expect(thousandsDotMessage(add("81.000"), "BTC-USD", null)).toBeNull();
  expect(add("81.000").price).toBe(81);
  expect([add("81.5"), add("81.25")].map((request) => [request.price, thousandsDotMessage(request, "BTC-USD", 81_634.52)])).toEqual([[81.5, null], [81.25, null]]);

  expect(() => add("81", "000")).toThrow("81 000 could be 81000 (thousands) or 81 and a stray 000; type gloomberb alerts add BTC-USD below 81000 or gloomberb alerts add BTC-USD below 81");
  expect(() => add("1", "234", "567,5")).toThrow("could be 1234567.5 (thousands)");
  expect(() => add("81000", "foo")).toThrow('A price alert takes one price, not "foo" after 81000; type gloomberb alerts add BTC-USD below 81000');
  expect(() => add("81", "00")).toThrow('not "00" after 81');
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

test("ERN's alert is ALRT's earnings alert set to wait for results, and the form drops the lead time for it", () => {
  const rule = createResearchAlert("earnings_date", { ...earningsResultsAlertValues("CRWV"), "earnings_date:exchange": "US", "earnings_date:leadDays": "1" });
  expect(readScheduledRule(rule)).toEqual({ target: { kind: "earnings", symbol: "CRWV", exchange: "US" }, leadDays: 0, trigger: "results" });
  expect(researchAlertDescription(rule)).toBe("CRWV · results");
  // A rule saved before keeps its value and goes off before the date.
  const before = createScheduledAlert({ kind: "earnings", symbol: "CRWV", exchange: "" }, 3, null);
  expect(JSON.parse(before.value)).toEqual({ version: 1, symbol: "CRWV", exchange: "", leadDays: 3 });
  expect(readScheduledRule(before)?.trigger).toBe("date");
  expect(JSON.parse(createScheduledAlert({ kind: "earnings", symbol: "CRWV", exchange: "" }, "results", null).value))
    .toEqual({ version: 1, symbol: "CRWV", exchange: "", leadDays: 0, when: "results" });
  expect(() => createScheduledAlert({ kind: "macro", event: "cpi" }, "results", null)).toThrow("Only earnings");

  const { fields, initialValues } = normalizeWizardFields(researchWizardFields);
  const shown = (when: string) => getVisibleWorkflowFields(fields, { ...initialValues, event: "earnings_date", "earnings_date:when": when })
    .map((field) => field.id);
  expect(shown("before")).toContain("earnings_date:leadDays");
  expect(shown("results")).not.toContain("earnings_date:leadDays");
  expect(shown("results")).toContain("earnings_date:when");
});

test("an alert for results is due from the report day until the actual EPS is in, or for three days after", () => {
  expect(scheduledPhase("2026-10-20", 0, undefined, "2026-10-19", "results")).toBe("armed");
  expect(scheduledPhase("2026-10-20", 0, undefined, "2026-10-20", "results")).toBe("due");
  // An after-close report is filled in overnight; a late one a day or two later.
  expect(scheduledPhase("2026-10-20", 0, undefined, "2026-10-23", "results")).toBe("due");
  expect(scheduledPhase("2026-10-20", 0, undefined, "2026-10-24", "results")).toBe("passed");
  expect(scheduledPhase("2026-10-20", 0, "2026-10-20", "2026-10-21", "results")).toBe("fired");

  const rows: EarningsResultRow[] = [
    { symbol: "CRWV", date: "2026-07-20", epsActual: 0.05, epsEstimate: 0.04 },
    { symbol: "CRWV", date: "2026-10-21", epsActual: null, epsEstimate: 0.1 },
    { symbol: "NFLX", date: "2026-10-20", epsActual: 6.1, epsEstimate: 5.9 },
  ];
  expect(reportedResult(rows, "CRWV", "2026-10-20")).toBeNull();
  const out = [...rows, { symbol: "CRWV", date: "2026-10-21", epsActual: 0.12, epsEstimate: 0.1 }];
  // Reported a day later than the date followed.
  expect(reportedResult(out, "crwv", "2026-10-20")).toEqual({ symbol: "CRWV", date: "2026-10-21", epsActual: 0.12, epsEstimate: 0.1 });
  expect(scheduledResultsMessage("CRWV", { epsActual: 0.12, epsEstimate: 0.1 })).toBe("CRWV reported EPS 0.12 vs 0.10 expected (+20.0%)");
  expect(scheduledResultsMessage("CRWV", { epsActual: -0.3, epsEstimate: null })).toBe("CRWV reported EPS -0.30");
});

test("the app alerts for results once the actual EPS lands, keeping the report day until then, and then follows the next report", async () => {
  const rule = { ...createScheduledAlert({ kind: "earnings", symbol: "CRWV", exchange: "" }, "results", "2026-10-20", 1_000) };
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
  let reported: number | null = null;
  const reads: string[] = [];
  const sources: ScheduledEventSources = {
    // Once the day has passed, the calendar's next report is next quarter's.
    earnings: async () => [{ symbol: "CRWV", earningsDate: new Date("2026-10-20T20:00:00Z") }, { symbol: "CRWV", earningsDate: new Date("2027-01-26T20:00:00Z") }],
    cpi: async () => ({ release: { nextReleaseAt: null } }),
    fomc: async () => [],
    results: async (symbols, from, to) => {
      reads.push(`${symbols.join(",")} ${from} ${to}`);
      return [{ symbol: "CRWV", date: "2026-10-20", epsActual: reported, epsEstimate: 0.1 }];
    },
  };
  let now = Date.parse("2026-10-20T18:00:00Z");
  const stop = startScheduledEventAlerts(ctx as never, sources, () => now);
  const check = async () => {
    checkScheduledEventAlertsNow();
    await Bun.sleep(20);
  };
  try {
    // The morning before an after-close report: nothing yet, and no write.
    await check();
    expect(notifications).toEqual([]);
    expect(reads).toEqual(["CRWV 2026-10-17 2026-10-23"]);

    // The next morning the calendar has moved on, but the rule still waits on the 20th; the actual is in.
    now = Date.parse("2026-10-21T13:00:00Z");
    reported = 0.12;
    await check();
    await saved.promise;
    expect(notifications).toEqual(["CRWV reported EPS 0.12 vs 0.10 expected (+20.0%)"]);
    expect(readEventAlerts(store.get(EVENT_ALERTS_KEY)!).rules[0]).toMatchObject({ eventDate: "2026-10-20", firedFor: "2026-10-20" });

    // Once only; then it follows January's report.
    saved = Promise.withResolvers<void>();
    await check();
    await saved.promise;
    expect(notifications).toHaveLength(1);
    expect(readEventAlerts(store.get(EVENT_ALERTS_KEY)!).rules[0]).toMatchObject({ eventDate: "2027-01-26", firedFor: "2026-10-20" });
  } finally {
    stop();
  }
});

test("results come from ERN's board, and from the per-ticker calendar for a company the board has no actual for", async () => {
  const asked: string[][] = [];
  const row = (symbol: string, epsActual: number | null): EarningsResultRow => ({ symbol, date: "2026-10-20", epsActual, epsEstimate: 0.1 });
  const calendar = async (symbols: string[]) => {
    asked.push(symbols);
    return symbols.map((symbol) => row(symbol, 0.12));
  };
  // CRWV's actual is in the board; NBIS is on the board without one, and SHOP not at all.
  const board = async () => [row("CRWV", 0.2), row("NBIS", null)];
  expect(await readEarningsResults(["CRWV", "NBIS", "SHOP"], board, calendar)).toEqual([
    row("CRWV", 0.2), row("NBIS", null), row("NBIS", 0.12), row("SHOP", 0.12),
  ]);
  expect(asked).toEqual([["NBIS", "SHOP"]]);
  // Nothing missing, nothing more to read.
  await readEarningsResults(["CRWV"], board, calendar);
  expect(asked).toHaveLength(1);

  // Either failing leaves the other's rows; both failing, or the board with nothing else to read, is the error.
  const down = async (): Promise<EarningsResultRow[]> => { throw new Error("UPSTREAM_ERROR"); };
  expect(await readEarningsResults(["NBIS"], down, calendar)).toEqual([row("NBIS", 0.12)]);
  expect(await readEarningsResults(["NBIS"], board, down)).toEqual([row("CRWV", 0.2), row("NBIS", null)]);
  await expect(readEarningsResults(["NBIS"], down, down)).rejects.toThrow("UPSTREAM_ERROR");
  await expect(readEarningsResults(["NBIS"], down, null)).rejects.toThrow("UPSTREAM_ERROR");
});

test("a results alert follows a report moved before its day, and keeps waiting through failed lookups until the actual is in", async () => {
  const rule = createScheduledAlert({ kind: "earnings", symbol: "CRWV", exchange: "" }, "results", "2026-10-20", 1_000);
  const store = new Map<string, string>([[EVENT_ALERTS_KEY, JSON.stringify([rule])]]);
  const notifications: string[] = [];
  const warnings: string[] = [];
  const ctx = {
    configState: {
      get: (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => { store.set(key, String(value)); },
    },
    notify: (notification: { body?: string }) => { notifications.push(notification.body ?? ""); },
    showPane() {},
    log: { info() {}, warn: (message: string) => { warnings.push(message); }, error() {}, debug() {} },
  };
  let dates: "moved" | "down" = "moved";
  let results: "down" | number | null = null;
  const reads: string[] = [];
  const sources: ScheduledEventSources = {
    earnings: async () => {
      if (dates === "down") throw new Error("UPSTREAM_ERROR");
      return [{ symbol: "CRWV", earningsDate: new Date("2026-10-22T20:00:00Z") }];
    },
    cpi: async () => ({ release: { nextReleaseAt: null } }),
    fomc: async () => [],
    results: async (symbols, from, to) => {
      reads.push(`${symbols.join(",")} ${from} ${to}`);
      if (results === "down") throw new Error("UPSTREAM_ERROR");
      return [{ symbol: "CRWV", date: "2026-10-22", epsActual: results, epsEstimate: 0.1 }];
    },
  };
  let now = Date.parse("2026-10-19T14:00:00Z");
  const stop = startScheduledEventAlerts(ctx as never, sources, () => now);
  const check = async () => {
    checkScheduledEventAlertsNow();
    await Bun.sleep(20);
  };
  const saved = () => readEventAlerts(store.get(EVENT_ALERTS_KEY)!).rules[0];
  try {
    // Moved from the 20th to the 22nd the day before: the rule follows it, and reads no results before it.
    await check();
    expect(saved()).toMatchObject({ eventDate: "2026-10-22" });
    expect(reads).toEqual([]);

    // The 20th, the old day, passes quietly.
    now = Date.parse("2026-10-20T22:00:00Z");
    await check();
    expect(notifications).toEqual([]);
    expect(reads).toEqual([]);

    // On the day both reads fail: the rule keeps its day and waits.
    now = Date.parse("2026-10-22T22:00:00Z");
    dates = "down";
    results = "down";
    await check();
    expect(notifications).toEqual([]);
    expect(saved()).toMatchObject({ eventDate: "2026-10-22" });
    expect(saved()?.firedFor).toBeUndefined();
    expect(warnings).toEqual(["Event dates unavailable", "Earnings results unavailable"]);

    // The next morning the dates are still down, and the actual is in: one alert.
    now = Date.parse("2026-10-23T13:00:00Z");
    results = 0.12;
    await check();
    await check();
    expect(notifications).toEqual(["CRWV reported EPS 0.12 vs 0.10 expected (+20.0%)"]);
    expect(saved()).toMatchObject({ eventDate: "2026-10-22", firedFor: "2026-10-22" });
    expect(reads).toEqual(["CRWV 2026-10-19 2026-10-25", "CRWV 2026-10-19 2026-10-25"]);
  } finally {
    stop();
  }
});
