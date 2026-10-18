import { afterEach, describe, expect, test } from "bun:test";
import type { HeadlessPaneDefinition, HeadlessPaneResult } from "../../types/plugin";
import { cloudNewsFreshness, quoteObservation } from "../../plugins/builtin/shared/report-freshness";
import { createTestQuote } from "../../test-support/data-provider";
import { quotesFreshness } from "../freshness";
import { formatUtcTime, setDisplayTimeZone } from "../../utils/utc-time";
import { captureStatusLine, delayLength, deriveCaptureReport, deriveHeadlessFreshness, formatFreshnessLine, formatStatusLine, paneStatusLine, periodicityOf, statusLineVariants } from "./freshness";

const NOW = Date.parse("2026-10-09T05:00:00Z"); // Friday, before the US open
const rows = (freshness?: HeadlessPaneDefinition["freshness"]) => ({ shape: "rows" as const, ...(freshness ? { freshness } : {}) });
const line = (definition: Pick<HeadlessPaneDefinition, "shape" | "freshness">, result: HeadlessPaneResult) => (
  formatFreshnessLine(deriveHeadlessFreshness(definition, result, NOW))
);

describe("report freshness", () => {
  test("a monthly, quarterly or annual observation is the period it starts, not a day; a daily one keeps its date", () => {
    const fred = (periodicity: "monthly" | "quarterly" | "annual" | undefined) => rows({
      source: "FRED", status: "not-a-feed", basis: "published statistics", observedKey: "date", oldest: null, ...(periodicity ? { periodicity } : {}),
    });
    const observed = { rows: [{ date: "2026-09-01" }, { date: "2026-08-01" }] };
    expect(line(fred("monthly"), observed)).toBe("Source: FRED · Sep 2026 (monthly) · not a live feed (published statistics)");
    expect(line(fred("quarterly"), { rows: [{ date: "2026-04-01" }] })).toBe("Source: FRED · Q2 2026 (quarterly) · not a live feed (published statistics)");
    expect(line(fred("annual"), { rows: [{ date: "2025-01-01" }] })).toBe("Source: FRED · 2025 (annual) · not a live feed (published statistics)");
    expect(line(fred(undefined), observed)).toBe("Source: FRED · Tue 1 Sep 2026 · not a live feed (published statistics)");
    expect(deriveHeadlessFreshness(fred("monthly"), observed, NOW)).toMatchObject({ asOf: "2026-09-01", periodicity: "monthly" });
    // A report that is not a history names the oldest observation as a period too.
    const board = deriveHeadlessFreshness(rows({ source: "FRED", status: "not-a-feed", periodicity: "monthly" }), { rows: [{ asOf: "2026-09-01" }, { asOf: "2026-06-01" }] }, NOW);
    expect(formatFreshnessLine(board)).toBe("Source: FRED · Sep 2026 (monthly) (oldest Jun 2026) · not a live feed");
    // Without a dated observation there is no period to name.
    expect(deriveHeadlessFreshness(fred("monthly"), { rows: [] }, NOW).periodicity).toBeUndefined();
    expect(["Monthly", "Quarterly", "Annual", "Daily", "Weekly, Ending Friday", undefined].map(periodicityOf))
      .toEqual(["monthly", "quarterly", "annual", null, null, null]);
  });

  test("says how long a delay is in minutes or hours, as a range when rows differ", () => {
    expect([15, 20, 60, 90, 720, 3 * 24 * 60].map(delayLength)).toEqual(["15 min", "20 min", "1 h", "90 min", "12 h", "3 days"]);
    const delayed = (delayMinutes: number) => ({ dataSource: "delayed", delayMinutes, lastUpdated: NOW - 20 * 60_000 });
    expect(line(rows(), { rows: [delayed(15), delayed(20)] })).toBe("Source: Gloom Cloud · Fri 9 Oct 2026 04:40 UTC · 15-20 min delayed");
    // News held back for an account without real-time access says how far; with it, the wire is live. The time is the
    // newest story's and says so, so it is not read as the time now.
    const stories = { rows: [{ publishedAt: "2026-10-08T16:30:00Z" }, { publishedAt: "2026-10-08T15:00:00Z" }] };
    expect(line(rows(cloudNewsFreshness(false)), stories)).toBe("Source: Gloom Cloud · newest story Thu 8 Oct 2026 16:30 UTC · 12 h delayed");
    expect(line(rows(cloudNewsFreshness(true)), stories)).toBe("Source: Gloom Cloud · newest story Thu 8 Oct 2026 16:30 UTC · live");
    expect(line(rows(), { rows: [{ dataSource: "delayed", lastUpdated: NOW - 60_000 }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 2026 04:59 UTC · delayed");
  });

  test("a narrow capture keeps the date and the delay, shortening the rest first", () => {
    const freshness = deriveHeadlessFreshness(rows(), { rows: [
      { dataSource: "delayed", delayMinutes: 15, stale: false, sessionExchange: "NASDAQ", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:59:00Z") },
      { dataSource: "delayed", delayMinutes: 20, stale: true, sessionExchange: "ASX", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-07T05:10:00Z") },
    ] }, Date.parse("2026-10-10T13:00:00Z"));
    expect(formatStatusLine(freshness))
      .toBe("US trading day Fri 9 Oct 2026 close (oldest Wed 7 Oct 2026) · 15-20 min delayed, 1 of 2 stale · markets closed until Mon");
    expect(statusLineVariants(freshness)).toEqual([
      "US trading day Fri 9 Oct 2026 close (oldest Wed 7 Oct 2026) · 15-20 min delayed, 1 of 2 stale · markets closed until Mon",
      "US trading day Fri 9 Oct 2026 close (oldest Wed 7 Oct 2026) · 15-20 min delayed, 1 of 2 stale · reopens Mon",
      "US trading day Fri 9 Oct 2026 close · 15-20 min delayed, 1 of 2 stale · reopens Mon",
      "US trading day Fri 9 Oct 2026 close · 15-20 min delayed, 1 stale · reopens Mon",
      "US trading day Fri 9 Oct 2026 close · 15-20 min delayed, 1 stale",
    ]);
  });

  test("a publication schedule reads right after the date it belongs to, and a narrow line gives it up last", () => {
    const schedule = "published Fri 9 Oct, next settlement Thu 15 Oct, published Mon 26 Oct";
    const settlement = rows({
      source: "FINRA", status: "not-a-feed", basis: "twice-monthly settlement", observedKey: "settlementDate", oldest: null, schedule, publishedAt: "2026-10-09",
    });
    const result = { rows: [{ settlementDate: "2026-09-30" }, { settlementDate: "2026-09-15" }] };
    expect(line(settlement, result))
      .toBe(`Source: FINRA · Wed 30 Sep 2026 · ${schedule} · not a live feed (twice-monthly settlement)`);
    const freshness = deriveHeadlessFreshness(settlement, result, NOW);
    expect(freshness).toMatchObject({ asOf: "2026-09-30", schedule, publishedAt: "2026-10-09" });
    const variants = statusLineVariants(freshness, { source: true });
    expect(variants[0]).toContain(schedule);
    expect(variants.at(-1)).toBe("Wed 30 Sep 2026 · not a live feed (twice-monthly settlement)");
  });

  test("venues polled apart are each dated by their own observation, and the oldest says how far behind the view is", () => {
    const now = Date.parse("2026-10-11T02:24:40Z");
    const venues = rows({ source: "Binance, Bybit", status: "delayed", maxAgeMinutes: 60, note: "funding = current estimate, pays 08:00 UTC",
      sources: [{ source: "Binance", asOf: "2026-10-11T02:15:10Z" }, { source: "Bybit", asOf: "2026-10-11T02:24:05Z" }] });
    // A board-wide stamp newer than any row shown is not the view's as-of.
    const result = { rows: [{ observedAt: "2026-10-11T02:15:10Z", stale: false }, { observedAt: "2026-10-11T02:24:05Z", stale: false }], metadata: { asOf: "2026-10-11T02:24:30Z" } };
    const freshness = deriveHeadlessFreshness(venues, result, now);
    expect(freshness).toMatchObject({ source: "Binance, Bybit", asOf: "2026-10-11T02:24:05.000Z", status: "delayed", oldestAgeMinutes: 9,
      sources: [{ source: "Binance", asOf: "2026-10-11T02:15:10.000Z" }, { source: "Bybit", asOf: "2026-10-11T02:24:05.000Z" }] });
    // The venues are the sources, so the line names them once.
    expect(formatFreshnessLine(freshness)).toBe("Sun 11 Oct 2026 · Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed · funding = current estimate, pays 08:00 UTC");
    // A narrow capture gives up the day, then the funding part; a pane footer reads today without the day.
    expect(statusLineVariants(freshness)).toEqual([
      "Sun 11 Oct 2026 · Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed · funding = current estimate, pays 08:00 UTC",
      "Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed · funding = current estimate, pays 08:00 UTC",
      "Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed",
    ]);
    expect(paneStatusLine(freshness)).toBe("Binance 02:15 · Bybit 02:24 UTC · oldest 9 min · delayed · funding = current estimate, pays 08:00 UTC");
    // A venue observed the day before carries its date; one that stopped answering makes the line stale, aged once.
    const lagging = deriveHeadlessFreshness(rows({ status: "delayed", sources: [{ source: "Binance", asOf: "2026-10-10T23:58:00Z" }, { source: "Bybit", asOf: "2026-10-11T00:04:00Z" }] }),
      { rows: [{ observedAt: "2026-10-10T23:58:00Z", stale: true }, { observedAt: "2026-10-11T00:04:00Z", stale: true }] }, Date.parse("2026-10-11T01:30:00Z"));
    expect(paneStatusLine(lagging)).toBe("Binance Sat 10 Oct 23:58 · Bybit 00:04 UTC · oldest 92 min · stale");
    // One source says how old its oldest row is the same way.
    expect(line(rows({ status: "delayed", oldestAge: true }), { rows: [{ quoteTime: "2026-10-09T04:59:00Z" }, { quoteTime: "2026-10-09T04:56:00Z" }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 2026 04:59 UTC · oldest 4 min · delayed");
  });

  test("a dataset cites its source, observation date and lag; quote rows on its pane keep the market line", () => {
    const SAT = Date.parse("2026-10-10T22:47:00Z");
    const transits = { source: "Gloom Cloud", status: "not-a-feed" as const, basis: "reported and published data", dataset: true };
    const dataset = deriveHeadlessFreshness(rows(transits), { rows: [
      { asOf: "2026-10-04T00:00:00Z", stale: false }, { asOf: "2026-09-27T00:00:00Z", stale: true },
    ] }, SAT);
    expect(dataset).toMatchObject({ lagDays: 6, oldest: "2026-09-27T00:00:00.000Z" });
    expect(statusLineVariants(dataset)).toEqual([
      "Source: Gloom Cloud · observed Sun 4 Oct (oldest Sun 27 Sep) · lag 6d · 1 of 2 stale",
      "Source: Gloom Cloud · observed Sun 4 Oct · lag 6d · 1 of 2 stale",
      "Source: Gloom Cloud · observed Sun 4 Oct · lag 6d · 1 stale",
      "Observed Sun 4 Oct · lag 6d · 1 stale",
    ]);
    // The fn footer keeps its wording.
    expect(formatFreshnessLine(dataset)).toBe("Source: Gloom Cloud · Sun 4 Oct 2026 00:00 UTC (oldest Sun 27 Sep 2026) · 1 of 2 stale");
    // GPU's Equities tab: quotes on a dataset's pane read as quotes.
    const quoted = deriveHeadlessFreshness(rows({ dataset: true }), { rows: [
      { dataSource: "delayed", delayMinutes: 15, sessionExchange: "NASDAQ", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:59:00Z") },
    ] }, SAT);
    expect(quoted.lagDays).toBeUndefined();
    expect(formatStatusLine(quoted)).toBe("US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon");
    // Undeclared, dated data is not a dataset.
    expect(deriveHeadlessFreshness(rows({ status: "not-a-feed" }), { rows: [{ asOf: "2026-10-04" }] }, SAT).lagDays).toBeUndefined();
  });

  test("a table across markets that asks for it dates each market's session, not only the newest row's", () => {
    const WED = Date.parse("2026-10-14T03:00:00Z"); // every venue closed
    const quote = (sessionExchange: string, lastUpdated: string) => ({
      dataSource: "delayed", delayMinutes: 15, sessionExchange, marketState: "CLOSED", lastUpdated: Date.parse(lastUpdated),
    });
    const airlines = { rows: [quote("NYSE", "2026-10-13T23:45:00Z"), quote("XETRA", "2026-10-13T15:35:00Z"), quote("EPA", "2026-10-13T15:35:00Z")] };
    expect(formatFreshnessLine(deriveHeadlessFreshness(rows({ datesEachVenue: true }), airlines, WED)))
      .toBe("Source: Gloom Cloud · US, XETRA and EPA Tue 13 Oct 2026 close · 15 min delayed · markets closed · regular session opens 06:00 UTC");
    // A venue whose newest row is a day older says so beside the others.
    const stale = { rows: [quote("NYSE", "2026-10-13T23:45:00Z"), quote("XETRA", "2026-10-12T15:35:00Z")] };
    expect(formatStatusLine(deriveHeadlessFreshness(rows({ datesEachVenue: true }), stale, WED)))
      .toMatch(/^US Tue 13 Oct 2026 close, XETRA Mon 12 Oct 2026 session · /);
    // Undeclared, or one market only, keeps the newest row's line.
    expect(formatFreshnessLine(deriveHeadlessFreshness(rows(), airlines, WED))).toContain("· US trading day Tue 13 Oct 2026 close ·");
    expect(deriveHeadlessFreshness(rows({ datesEachVenue: true }), { rows: [quote("NYSE", "2026-10-13T23:45:00Z")] }, WED).venueSessions)
      .toBeUndefined();
  });

  test("an index quote's own sessions date its last close and name the open its pre-market waits for", () => {
    const WED = Date.parse("2026-10-14T11:08:00Z"); // 07:08 in New York, before the 13:30 UTC open
    const window = (day: string, from: string, to: string) => ({ start: Date.parse(`${day}T${from}:00Z`), end: Date.parse(`${day}T${to}:00Z`) });
    const index = (symbol: string, listingExchangeName: string, marketState: "PRE" | "CLOSED", lastUpdated: string, timeZone: string, current: ReturnType<typeof window>, last: ReturnType<typeof window>) => (
      createTestQuote({
        symbol, instrumentType: "INDEX", listingExchangeName, marketState, lastUpdated: Date.parse(lastUpdated), dataSource: "delayed", providerId: "gloomberb-cloud",
        // As the service sends it, with fields the app does not read.
        indexSession: { source: "gloom", symbol, exchange: listingExchangeName, timeZone, fetchedAt: WED, current, regular: [last] } as never,
      })
    );
    const status = (quote: ReturnType<typeof index>) => formatStatusLine(deriveHeadlessFreshness(rows(), { rows: [quoteObservation(quote, WED)] }, WED));
    const gspc = index("^GSPC", "SNP", "PRE", "2026-10-13T20:33:00Z", "America/New_York", window("2026-10-14", "13:30", "20:00"), window("2026-10-13", "13:30", "20:00"));
    // A prior close under a pre-market chip says whose close it is and when the market opens, as the equity lines do.
    expect(status(gspc)).toBe("US trading day Tue 13 Oct 2026 close \u00b7 15 min delayed \u00b7 pre-market open \u00b7 regular session opens 13:30 UTC");
    // Without the sessions the line is the bare print, as before.
    expect(status({ ...gspc, indexSession: undefined })).toBe("Tue 13 Oct 2026 20:33 UTC \u00b7 15 min delayed \u00b7 pre-market open");
    // A print from before the last session opened is no close of it.
    expect(status({ ...gspc, lastUpdated: Date.parse("2026-10-13T12:00:00Z") })).not.toContain("close");
    // Another market's index keeps its bare date: its publisher's name (OSAKA) is no market, and a closed session has no open to wait for.
    const n225 = index("^N225", "OSAKA", "CLOSED", "2026-10-14T06:45:00Z", "Asia/Tokyo", window("2026-10-14", "00:00", "06:30"), window("2026-10-14", "00:00", "06:30"));
    expect(status(n225)).toBe("Wed 14 Oct 2026 close \u00b7 15 min delayed \u00b7 markets closed");
    // Once the session is open the market says so and the open is behind it.
    const open = Date.parse("2026-10-14T14:05:00Z");
    const trading = { ...gspc, marketState: "REGULAR" as const, lastUpdated: Date.parse("2026-10-14T13:50:00Z") };
    expect(formatStatusLine(deriveHeadlessFreshness(rows(), { rows: [quoteObservation(trading, open)] }, open)))
      .toBe("Wed 14 Oct 2026 13:50 UTC \u00b7 15 min delayed \u00b7 markets open");
  });

  test("an index quote that states no session is placed on the sessions it carries", () => {
    const window = (day: string, from = "13:30", to = "20:00") => ({ start: Date.parse(`${day}T${from}:00Z`), end: Date.parse(`${day}T${to}:00Z`) });
    const days = ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"];
    // As `quote ^GSPC --json` sends it: no marketState, only the sessions. `current` is today's, or the next one while it has not opened.
    const gspc = (current: string, lastUpdated: string) => {
      const regular = days.filter((day) => day < current).slice(-6).map((day) => window(day));
      return createTestQuote({
        symbol: "^GSPC", name: "S&P 500", instrumentType: "INDEX", listingExchangeName: "SNP", exchangeName: "SNP",
        sessionConfidence: "unknown", lastUpdated: Date.parse(lastUpdated), dataSource: "delayed", providerId: "gloomberb-cloud",
        indexSession: {
          source: "gloom", symbol: "^GSPC", exchange: "SNP", currency: "USD", sourceSymbol: "^GSPC",
          timeZone: "America/New_York", fetchedAt: Date.parse(lastUpdated), current: window(current), regular,
        } as never,
      });
    };
    // `quote` and QQ read the same quote through the same report, so they print the same footer.
    const footer = (quote: ReturnType<typeof gspc>, now: number) => {
      const quoted = formatFreshnessLine(quotesFreshness([quote], undefined, now)!);
      expect(formatFreshnessLine(deriveHeadlessFreshness(rows(), { rows: [quoteObservation(quote, now)] }, now))).toBe(quoted);
      return quoted;
    };
    const at = (time: string) => Date.parse(`${time}Z`);
    // Before the open, on the day of it: pre-market, waiting for the open.
    expect(footer(gspc("2026-10-15", "2026-10-14T20:00:00Z"), at("2026-10-15T12:30:00")))
      .toBe("Source: Gloom Cloud \u00b7 US trading day Wed 14 Oct 2026 close \u00b7 15 min delayed \u00b7 pre-market open \u00b7 regular session opens 13:30 UTC");
    // In the session: open, and the open is behind it.
    expect(footer(gspc("2026-10-15", "2026-10-15T13:50:00Z"), at("2026-10-15T14:05:00")))
      .toBe("Source: Gloom Cloud \u00b7 Thu 15 Oct 2026 13:50 UTC \u00b7 15 min delayed \u00b7 markets open");
    // After the close: the session that just ended is the close, and no open is named.
    expect(footer(gspc("2026-10-15", "2026-10-15T20:00:00Z"), at("2026-10-15T21:00:00")))
      .toBe("Source: Gloom Cloud \u00b7 US trading day Thu 15 Oct 2026 close \u00b7 15 min delayed \u00b7 markets closed");
    // A weekend is closed, not pre-market, until the day of the open.
    expect(footer(gspc("2026-10-19", "2026-10-16T20:00:00Z"), at("2026-10-17T12:30:00")))
      .toBe("Source: Gloom Cloud \u00b7 US trading day Fri 16 Oct 2026 close \u00b7 15 min delayed \u00b7 markets closed until Mon");
    // A state the quote does state wins over the calendar.
    expect(footer({ ...gspc("2026-10-15", "2026-10-14T20:00:00Z"), marketState: "CLOSED" }, at("2026-10-15T12:30:00")))
      .toContain("\u00b7 markets closed \u00b7 regular session opens 13:30 UTC");
    // Without sessions there is nothing to place it on.
    expect(footer({ ...gspc("2026-10-15", "2026-10-14T20:00:00Z"), indexSession: undefined }, at("2026-10-15T12:30:00")))
      .toBe("Source: Gloom Cloud \u00b7 Wed 14 Oct 2026 20:00 UTC \u00b7 15 min delayed");
    // Another market's index keeps its bare date.
    const n225 = createTestQuote({
      symbol: "^N225", instrumentType: "INDEX", listingExchangeName: "OSAKA", exchangeName: "OSAKA", sessionConfidence: "unknown",
      lastUpdated: at("2026-10-14T06:45:00"), dataSource: "delayed", providerId: "gloomberb-cloud",
      indexSession: {
        source: "gloom", symbol: "^N225", exchange: "OSAKA", currency: "JPY", sourceSymbol: "^N225",
        timeZone: "Asia/Tokyo", fetchedAt: at("2026-10-14T07:00:00"), current: window("2026-10-14", "00:00", "06:30"), regular: [window("2026-10-13", "00:00", "06:30"), window("2026-10-14", "00:00", "06:30")],
      } as never,
    });
    expect(footer(n225, at("2026-10-14T07:00:00")))
      .toBe("Source: Gloom Cloud \u00b7 Wed 14 Oct 2026 close \u00b7 15 min delayed \u00b7 markets closed");
  });

  test("a dataset that names its observation ends fn, the pane footer and a capture with one line", () => {
    const SUN = Date.parse("2026-10-11T15:14:00Z");
    // DTCC's swap tape: a delayed feed whose single names trade days apart, dated by the last trade.
    const tape = { source: "DTCC", status: "delayed" as const, dataset: true, observation: "last trade", asOf: "2026-10-09T13:21:00Z", oldest: null };
    const freshness = deriveHeadlessFreshness(rows(tape), { rows: [], metadata: { asOf: "2026-10-11T15:14:13Z" } }, SUN);
    expect(freshness).toMatchObject({ status: "delayed", asOf: "2026-10-09T13:21:00.000Z", lagDays: 2, observation: "last trade" });
    const one = "Source: DTCC \u00b7 last trade 2026-10-09 \u00b7 lag 2 days";
    expect(formatFreshnessLine(freshness)).toBe(one);
    expect(paneStatusLine(freshness)).toBe(one);
    expect(statusLineVariants(freshness)).toEqual([one, "Last trade 2026-10-09 \u00b7 lag 2 days"]);
    // The equity session of the ticker on screen does not date it.
    const quoted = deriveHeadlessFreshness(rows(), { rows: [
      { dataSource: "delayed", delayMinutes: 15, sessionExchange: "NYSE", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T20:00:00Z") },
    ] }, SUN);
    expect(captureStatusLine({ report: { freshness, declaresData: true }, quoted, selfDated: false, rendered: () => quoted }).variants[0]).toBe(one);
    // Without a name the dataset keeps its own line, and a delayed feed that is no dataset has no lag.
    expect(formatStatusLine(deriveHeadlessFreshness(rows({ ...tape, observation: undefined }), { rows: [] }, SUN)))
      .toBe("Source: DTCC \u00b7 observed Fri 9 Oct \u00b7 lag 2d");
    expect(deriveHeadlessFreshness(rows({ ...tape, dataset: undefined }), { rows: [] }, SUN).lagDays).toBeUndefined();
  });

  test("a capture ends as its report's fn line when the report says what its data is; quotes date only quotes and prices", () => {
    const SUN = Date.parse("2026-10-11T06:17:00Z");
    const cot = deriveCaptureReport(rows({ source: "CFTC", status: "not-a-feed", basis: "weekly report", maxAgeMinutes: 14 * 24 * 60 }),
      { rows: [{ asOf: "2026-10-06" }, { asOf: "2026-09-29" }] }, SUN);
    const rendered = deriveHeadlessFreshness(rows(), { rows: [] }, SUN);
    const delayedClose = { dataSource: "delayed", delayMinutes: 15, sessionExchange: "NASDAQ", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:59:00Z") };
    const quoted = deriveHeadlessFreshness(rows(), { rows: [delayedClose] }, SUN);
    const marketLine = "US trading day Fri 9 Oct 2026 close \u00b7 15 min delayed \u00b7 markets closed until Mon";
    const pick = (inputs: Partial<Parameters<typeof captureStatusLine>[0]>) => captureStatusLine({ selfDated: false, rendered: () => rendered, ...inputs });
    // The footer ends as `fn` does, then gives up the oldest observation, then its source.
    // It dates the pane's own data, so the pane's own `as of` goes.
    expect(cot.declaresData).toBe(true);
    expect(pick({ report: cot })).toEqual({ freshness: cot.freshness, dates: "data", variants: [
      "Source: CFTC \u00b7 Tue 6 Oct 2026 (oldest Tue 29 Sep 2026) \u00b7 not a live feed (weekly report)",
      "Source: CFTC \u00b7 Tue 6 Oct 2026 \u00b7 not a live feed (weekly report)",
      "Tue 6 Oct 2026 \u00b7 not a live feed (weekly report)",
    ] });
    expect(pick({ report: cot }).variants[0]).toBe(formatFreshnessLine(cot.freshness));
    // The quotes the page loaded beside it (EE's, MDAY's ticker) do not date it, undated or not.
    expect(pick({ report: cot, quoted }).variants[0]).toBe(formatFreshnessLine(cot.freshness));
    const estimates = deriveCaptureReport(rows({ status: "not-a-feed", basis: "estimates and reported earnings", oldest: null }),
      { rows: [{ date: "2026-11-09" }, { date: "2026-08-11" }] }, SUN);
    expect(pick({ report: estimates, quoted }).variants[0])
      .toBe("Source: Gloom Cloud \u00b7 retrieved Sun 11 Oct 2026 06:17 UTC \u00b7 not a live feed (estimates and reported earnings)");
    // A pane that dates its own view keeps its word.
    expect(pick({ report: cot, quoted, selfDated: true }).freshness).toBe(rendered);
    // Quotes keep the market line: a report whose rows are quotes, a price chart's bars, a report that declares nothing.
    const board = deriveCaptureReport(rows({ status: "delayed" }), { rows: [delayedClose] }, SUN);
    const bars = deriveCaptureReport(rows({ status: "not-a-feed", basis: "daily closes", cadence: "daily", prices: true }), { rows: [{ asOf: "2026-10-09" }] }, SUN);
    const silent = deriveCaptureReport(rows(), { rows: [] }, SUN);
    for (const report of [board, bars, silent]) {
      expect(report.declaresData).toBe(false);
      expect(pick({ report, quoted })).toMatchObject({ dates: "quotes", freshness: quoted });
      expect(pick({ report, quoted }).variants[0]).toBe(marketLine);
    }
    expect(pick({ report: bars }).variants[0]).toBe(formatFreshnessLine(bars.freshness));
    // A report that cannot tell falls back to the rendered view.
    expect(pick({ report: silent, quoted: undefined })).toEqual({ freshness: rendered, dates: null, variants: ["Retrieved Sun 11 Oct 2026 06:17 UTC \u00b7 status not reported"] });
    // A dataset's report dates it whatever else the capture shows.
    const dataset = deriveCaptureReport(rows({ status: "not-a-feed", dataset: true }), { rows: [{ asOf: "2026-10-04" }] }, SUN);
    expect(pick({ report: dataset, quoted, selfDated: true }).variants[0]).toBe("Source: Gloom Cloud \u00b7 observed Sun 4 Oct \u00b7 lag 7d");
  });

  test("a dataset's lag counts whole UTC days from the last day its observation covers", () => {
    const lag = (asOf: string, now: string, periodicity?: "monthly" | "quarterly" | "annual") => {
      const freshness = deriveHeadlessFreshness(rows({ status: "not-a-feed", dataset: true, ...(periodicity ? { periodicity } : {}) }), { rows: [{ asOf }] }, Date.parse(now));
      return `${freshness.lagDays} ${formatStatusLine(freshness)}`;
    };
    // Calendar days, not elapsed hours: late Monday to just past midnight Saturday is five.
    expect(lag("2026-10-05T23:59:00Z", "2026-10-10T00:01:00Z")).toBe("5 Source: Gloom Cloud · observed Mon 5 Oct · lag 5d");
    expect(lag("2026-10-10T07:19:00Z", "2026-10-10T22:47:00Z")).toBe("0 Source: Gloom Cloud · observed Sat 10 Oct · lag 0d");
    // A period lags from its last day; the date names its year when that is not the capture's.
    expect(lag("2026-09-01", "2026-10-10T12:00:00Z", "monthly")).toBe("10 Source: Gloom Cloud · observed Sep 2026 (monthly) · lag 10d");
    expect(lag("2026-07-01", "2026-10-10T12:00:00Z", "quarterly")).toBe("10 Source: Gloom Cloud · observed Q3 2026 (quarterly) · lag 10d");
    expect(lag("2025-01-01", "2026-01-31T12:00:00Z", "annual")).toBe("31 Source: Gloom Cloud · observed 2025 (annual) · lag 31d");
    expect(lag("2026-10-01", "2026-10-10T12:00:00Z", "monthly")).toBe("0 Source: Gloom Cloud · observed Oct 2026 (monthly) · lag 0d");
    expect(lag("2025-12-28", "2026-01-02T12:00:00Z")).toBe("5 Source: Gloom Cloud · observed Sun 28 Dec 2025 · lag 5d");
  });

  test("is live only when the data says so, and the worst row decides", () => {
    const live = { dataSource: "live", lastUpdated: NOW - 60_000 };
    expect(line(rows(), { rows: [live, live] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 2026 04:59 UTC · live");
    expect(line(rows(), { rows: [live, { dataSource: "delayed", delayMinutes: 15, lastUpdated: NOW - 20 * 60_000 }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 2026 04:59 UTC · 15 min delayed");
    // A dated row with no feed signal is not called live.
    expect(line(rows(), { rows: [{ price: 1, lastUpdated: NOW - 60_000 }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 2026 04:59 UTC · status not reported");
  });

  test("a partly stale board names the share; a wholly stale one says how old it is", () => {
    const fresh = { delayMinutes: 10, stale: false, asOf: "2026-10-09T04:50:00Z" };
    const old = { delayMinutes: 10, stale: true, asOf: "2026-09-15T16:40:00Z" };
    const partly = deriveHeadlessFreshness(rows(), { rows: [fresh, fresh, old], metadata: { stale: true } }, NOW);
    expect(partly).toMatchObject({ status: "stale", feed: "delayed", delayMinutes: 10, staleCount: 1, observationCount: 3, oldest: "2026-09-15T16:40:00.000Z" });
    expect(formatFreshnessLine(partly))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 2026 04:50 UTC (oldest Tue 15 Sep 2026) · 10 min delayed, 1 of 3 stale");
    expect(line(rows({ status: "delayed", maxAgeMinutes: 60 }), { rows: [{ quoteTime: "2026-10-09T02:00:00Z" }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 2026 02:00 UTC · stale (3 hours old)");
  });

  test("a currency pair is closed from Friday 17:00 New York, and its weekend ticks read as that Friday's close", () => {
    const pair = (lastUpdated: string, marketState = "CLOSED") => ({
      dataSource: "delayed", delayMinutes: 15, stale: false, sessionExchange: "CCY", marketState, lastUpdated: Date.parse(lastUpdated),
    });
    const at = (now: string, ...pairs: ReturnType<typeof pair>[]) => formatFreshnessLine(
      deriveHeadlessFreshness(rows(), { rows: pairs }, Date.parse(now)),
    );
    // Saturday afternoon: a major's last print, then a quiet tick the next morning.
    expect(at("2026-10-10T18:45:00Z", pair("2026-10-09T21:29:00Z")))
      .toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed");
    expect(at("2026-10-10T18:45:00Z", pair("2026-10-09T21:29:00Z"), pair("2026-10-10T14:50:28Z")))
      .toBe("Source: Gloom Cloud · FX trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed");
    // A pair that last printed before the final trading day is no close; the line dates it.
    expect(at("2026-10-10T18:45:00Z", pair("2026-10-07T15:00:00Z")))
      .toBe("Source: Gloom Cloud · Wed 7 Oct 2026 15:00 UTC · 15 min delayed · markets closed");
    // A closed state on a day the FX week trades (a holiday) keeps the day of the print.
    expect(at("2026-10-13T12:00:00Z", pair("2026-10-13T09:30:00Z")))
      .toBe("Source: Gloom Cloud · FX trading day Tue 13 Oct 2026 close · 15 min delayed · markets closed");
    expect(at("2026-10-14T14:00:00Z", pair("2026-10-14T13:59:00Z", "REGULAR")))
      .toBe("Source: Gloom Cloud · Wed 14 Oct 2026 13:59 UTC · 15 min delayed · markets open");
  });

  test("filed data is never stale for its age, only for a release it missed", () => {
    const filings = rows({ source: "SEC EDGAR", status: "not-a-feed", basis: "filed data", observedKey: "filedAt", oldest: null });
    expect(line(filings, { rows: [{ filedAt: "2025-02-01" }, { filedAt: "2019-03-01" }] }))
      .toBe("Source: SEC EDGAR · Sat 1 Feb 2025 · not a live feed (filed data)");
    const release = { source: "BLS", status: "not-a-feed" as const, basis: "monthly release", asOf: "2026-09-11T12:30:00Z" };
    expect(line(rows(), { rows: [], freshness: { ...release, nextExpectedAt: "2026-10-14T12:30:00Z" } }))
      .toBe("Source: BLS · Fri 11 Sep 2026 12:30 UTC · not a live feed (monthly release)");
    expect(line(rows(), { rows: [], freshness: { ...release, nextExpectedAt: "2026-10-07T12:30:00Z" } }))
      .toBe("Source: BLS · Fri 11 Sep 2026 12:30 UTC · stale (27 days old)");
  });

  test("published-data metadata flags apply only without row flags and can be ignored", () => {
    const definition = rows({ status: "not-a-feed", basis: "published data" });
    const old = { observedAt: "2020-01-01" };
    const resolve = (data: HeadlessPaneResult, ignoreStaleFlags = false) => deriveHeadlessFreshness(
      { ...definition, freshness: { ...definition.freshness, ignoreStaleFlags } }, data, NOW,
    );
    expect(resolve({ rows: [old] }).status).toBe("not-a-feed");
    expect(resolve({ rows: [old], metadata: { stale: true } }).status).toBe("stale");
    expect(resolve({ rows: [old], metadata: { stale: true } }, true).status).toBe("not-a-feed");
    expect(resolve({ rows: [{ ...old, stale: false }], metadata: { stale: true } }).status).toBe("not-a-feed");
    expect(resolve({ rows: [{ ...old, stale: true }], metadata: { stale: false } }).status).toBe("stale");
    expect(resolve({ rows: [{ ...old, stale: true }, { ...old, stale: false }], metadata: { stale: true } }))
      .toMatchObject({ status: "stale", staleCount: 1, observationCount: 2 });
    expect(resolve({ rows: [{ ...old, stale: true }], metadata: { stale: true } }, true).status).toBe("not-a-feed");
  });

  test("canonical timestamps are observations and future declarations are not", () => {
    const timestamp = "2026-10-09T00:00:00Z";
    for (const value of [timestamp, Date.parse(timestamp), new Date(timestamp)]) {
      expect(deriveHeadlessFreshness(rows(), { rows: [{ timestamp: value }] }, NOW).asOf).toBe("2026-10-09T00:00:00.000Z");
      expect(deriveHeadlessFreshness(rows(), { rows: [], metadata: { timestamp: value } }, NOW).asOf).toBe("2026-10-09T00:00:00.000Z");
    }
    expect(deriveHeadlessFreshness(rows({ asOf: "2027-01-01", nextExpectedAt: "2027-01-01" }), { rows: [{ timestamp }] }, NOW).asOf)
      .toBe("2026-10-09T00:00:00.000Z");
    expect(deriveHeadlessFreshness(rows({ asOf: "2027-01-01" }), { rows: [] }, NOW).asOf).toBeNull();
    expect(deriveHeadlessFreshness(rows({ asOf: NOW + 60_000 }), { rows: [] }, NOW).asOf).toBe("2026-10-09T05:01:00.000Z");
  });

  test("receipt and refresh timestamps cannot supersede a price observation", () => {
    const quoteTime = "2026-10-09T02:00:00Z";
    const result = { rows: [{ quoteTime, updatedAt: NOW, receivedAt: NOW, generatedAt: NOW }],
      metadata: { updatedAt: NOW, receivedAt: NOW, generatedAt: NOW } };
    expect(deriveHeadlessFreshness(rows({ status: "delayed", maxAgeMinutes: 60 }), result, NOW))
      .toMatchObject({ asOf: "2026-10-09T02:00:00.000Z", status: "stale", ageMinutes: 180 });
    expect(deriveHeadlessFreshness(rows(), { rows: [{ lastUpdated: Date.parse(quoteTime), receivedAt: NOW }], metadata: { generatedAt: NOW } }, NOW).asOf)
      .toBe("2026-10-09T02:00:00.000Z");
    expect(deriveHeadlessFreshness(rows(), { rows: [{ receivedAt: NOW }], metadata: { generatedAt: NOW } }, NOW).asOf).toBeNull();
    // CRYP's summary as-of is the newest asset quote, not generatedAt; keep genuine summaries.
    expect(deriveHeadlessFreshness(rows(), { rows: [{ quoteTime }], metadata: { asOf: "2026-10-09T03:00:00Z", generatedAt: NOW } }, NOW).asOf)
      .toBe("2026-10-09T03:00:00.000Z");
  });

  test("a daily series may lag one completed session and no more", () => {
    const daily = { shape: "series" as const, freshness: { status: "not-a-feed" as const, basis: "daily closes", cadence: "daily" as const } };
    const series = (date: string) => ({ series: [{ id: "spy", label: "SPY", points: [{ date, close: 1 }] }] });
    // Before Friday's open, Thursday's close is current and Wednesday's is a day behind.
    expect(deriveHeadlessFreshness(daily, series("2026-10-07T00:00:00Z"), NOW).status).toBe("not-a-feed");
    expect(deriveHeadlessFreshness(daily, series("2026-10-06T00:00:00Z"), NOW)).toMatchObject({ status: "stale", asOf: "2026-10-06T00:00:00.000Z" });
  });

  test("without a dated observation it cites the retrieval time instead of inventing an as-of", () => {
    expect(line(rows({ source: "Your inputs", status: "not-a-feed", basis: "calculator" }), { rows: [{ value: 1 }] }))
      .toBe("Source: Your inputs · retrieved Fri 9 Oct 2026 05:00 UTC · not a live feed (calculator)");
  });

  test("prints the same UTC times whatever the host's zone", async () => {
    const script = `
      import { serializeCliResult } from "./src/cli/result";
      import { DEFAULT_CLI_OPTIONS } from "./src/cli/options";
      import { formatFreshnessLine, deriveHeadlessFreshness } from "./src/cli/pane-functions/freshness";
      const data = [{ updatedAt: "2026-10-08T23:59:00Z", publishedAt: new Date(Date.UTC(2026, 9, 7, 11, 27)), lastUpdated: 1791503940000 }];
      console.log(serializeCliResult({ data }, { ...DEFAULT_CLI_OPTIONS, color: false }));
      console.log(formatFreshnessLine(deriveHeadlessFreshness({ shape: "rows" }, { rows: data }, ${NOW})));
    `;
    const run = async (zone: string) => {
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: process.cwd(), env: { ...process.env, TZ: zone, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(exitCode).toBe(0);
      return stdout;
    };
    const [tokyo, losAngeles] = await Promise.all([run("Asia/Tokyo"), run("America/Los_Angeles")]);
    expect(tokyo).toBe(losAngeles);
    expect(tokyo).toContain("2026-10-08 23:59 UTC");
    expect(tokyo).toContain("2026-10-07 11:27 UTC");
    expect(tokyo).toContain("Thu 8 Oct 2026 23:59 UTC");
  });

  describe("in the reader's time zone", () => {
    afterEach(() => setDisplayTimeZone(null));
    const at = (iso: string, freshness: HeadlessPaneDefinition["freshness"], data: HeadlessPaneResult = { rows: [] }) => (
      deriveHeadlessFreshness(rows(freshness), data, Date.parse(iso))
    );

    test("puts the local time beside UTC, on its own date across the date line", () => {
      setDisplayTimeZone("asia/tokyo");
      expect(formatFreshnessLine(at("2026-10-10T16:56:00Z", { source: "Your inputs", status: "not-a-feed", basis: "calculator" })))
        .toBe("Source: Your inputs · retrieved Sat 10 Oct 2026 16:56 UTC (Sun 11 Oct 01:56 Asia/Tokyo) · not a live feed (calculator)");
      expect(formatUtcTime("2026-10-09T23:59:00Z")).toBe("2026-10-09 23:59 UTC (Sat 10 Oct 08:59 Asia/Tokyo)");
      setDisplayTimeZone("America/Los_Angeles");
      expect(formatUtcTime("2026-10-10T02:00:00Z")).toBe("2026-10-10 02:00 UTC (Fri 9 Oct 19:00 America/Los_Angeles)");
      // Unknown names and zones that are UTC all year print UTC alone.
      for (const zone of ["Tokyo", "Etc/UTC"]) {
        setDisplayTimeZone(zone);
        expect(formatUtcTime("2026-10-09T23:59:00Z")).toBe("2026-10-09 23:59 UTC");
      }
    });

    test("never moves a trading day, and a narrow capture drops the local time before the date", () => {
      setDisplayTimeZone("Asia/Tokyo");
      const close = at("2026-10-10T13:00:00Z", undefined, { rows: [
        { dataSource: "delayed", delayMinutes: 15, sessionExchange: "NASDAQ", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:59:00Z") },
      ] });
      expect(formatStatusLine(close)).toBe("US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon");
      expect(formatStatusLine(at("2026-10-10T13:00:00Z", { status: "not-a-feed", basis: "auction results", observedKey: "auctionDate", tradingDayMarket: "US" }, {
        rows: [{ auctionDate: "2026-10-08" }],
      }))).toBe("US trading day Thu 8 Oct 2026 · not a live feed (auction results)");
      const timed = at("2026-10-12T15:00:00Z", undefined, { rows: [
        { dataSource: "delayed", delayMinutes: 15, sessionExchange: "NASDAQ", marketState: "REGULAR", lastUpdated: Date.parse("2026-10-12T14:45:00Z") },
      ] });
      expect(statusLineVariants(timed)).toEqual([
        "Mon 12 Oct 2026 14:45 UTC (Mon 12 Oct 23:45 Asia/Tokyo) · 15 min delayed · markets open",
        "Mon 12 Oct 2026 14:45 UTC (Mon 12 Oct 23:45 Asia/Tokyo) · 15 min delayed · open",
        "Mon 12 Oct 2026 14:45 UTC · 15 min delayed · open",
        "Mon 12 Oct 2026 14:45 UTC · 15 min delayed",
      ]);
    });
  });
});
