import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createMovedSymbolsProvider } from "../../../test-support/moved-symbols";
import { MovedSymbolError } from "../../../tickers/listing-fate";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessBundleResult, HeadlessPaneApiClient } from "../../../types/headless";
import type { IvHistoryPayload, IvMethod, IvPoint, IvScreenPayload, IvScreenRow } from "./client";
import { VCA_DEFINITIONS } from "./format";
import { ivHistoryHeadless, ivScreenHeadless } from "./headless";

const reading = (date: string, method: IvMethod, iv30: number) => ({
  date, method, capturedAt: `${date}T19:55:00Z`, spot: 100, iv7: null, iv30, iv60: null, iv90: iv30 + 0.01, iv180: null, iv365: null,
});
/** A screened symbol: its stored latest reading and the trade close its rank is measured on. */
const row = (symbol: string, latest: ReturnType<typeof reading>, rankDate: string, rank = 40): IvScreenRow => ({
  symbol, status: "ready", latest,
  iv30: { value: 0.3, date: rankDate, method: "trade-close", rank, percentile: rank, low: 0.2, high: 0.4, samples: 250, windowStart: "2025-10-08" },
  iv90: null, skew: null,
});
const load = async (rows: IvScreenRow[], marketData: DataProvider = createTestDataProvider()) => {
  // The response's own date is the day it was fetched, a day after the newest session.
  const payload: IvScreenPayload = { version: 1, asOf: "2026-10-10", rows };
  const apiClient = { impliedVolatility: async () => payload } as unknown as HeadlessPaneApiClient;
  const result = await ivScreenHeadless.load(createTestHeadlessArgs({ symbols: rows.map((entry) => entry.symbol) }),
    createTestHeadlessContext({ apiClient, marketData })) as HeadlessBundleResult;
  const section = result.sections[0]! as Extract<HeadlessBundleResult["sections"][number], { rows: unknown[] }>;
  const cell = (key: string, index: number) => {
    const column = section.columns!.find((entry) => entry.key === key)!;
    const value = section.rows[index]![key];
    return column.format ? column.format(value, section.rows[index]!) : String(value);
  };
  const footer = formatFreshnessLine(deriveHeadlessFreshness(ivScreenHeadless, result, Date.parse("2026-10-10T02:40:00Z")));
  return { title: section.title, keys: section.columns!.map((column) => column.key),
    header: (key: string) => section.columns!.find((column) => column.key === key)?.header, cell, footer, result };
};

describe("VCA dates", () => {
  test("a quote reading and the close it is ranked on are each dated once, and the footer agrees", async () => {
    const { title, keys, footer } = await load([
      row("NVDA", reading("2026-10-09", "quote-mid", 0.293), "2026-10-09"),
      row("AAPL", reading("2026-10-09", "quote-mid", 0.265), "2026-10-09"),
    ]);
    expect(title).toContain("IV30 2026-10-09 quote · IVR/IVP vs 52 weeks to 2026-10-09 close");
    expect(title).not.toContain("live");
    expect(keys).not.toContain("date");
    expect(keys).not.toContain("rankDate");
    expect(footer).toBe("Source: Gloom Cloud · Fri 9 Oct 2026 · not a live feed (daily implied volatility)");
  });

  test("a trade-close reading on its rank date says so once", async () => {
    const { title } = await load([row("SPY", reading("2026-10-09", "trade-close", 0.123), "2026-10-09")]);
    expect(title.endsWith("· 2026-10-09 close")).toBe(true);
  });

  test("rows on different readings or rank dates get a column each, and the footer is the newest reading", async () => {
    const { title, keys, cell, footer } = await load([
      row("NVDA", reading("2026-10-09", "quote-mid", 0.293), "2026-10-09"),
      row("XLF", reading("2026-10-09", "trade-close", 0.171), "2026-10-09"),
      row("IWM", reading("2026-10-08", "quote-mid", 0.182), "2026-10-08"),
    ]);
    expect(title).toBe("Rich/cheap · Custom symbols");
    expect(keys).toContain("date");
    expect(keys).toContain("rankDate");
    expect([0, 1, 2].map((index) => cell("date", index))).toEqual(["2026-10-09 quote", "2026-10-09 close", "2026-10-08 quote"]);
    expect([0, 1, 2].map((index) => cell("rankDate", index))).toEqual(["2026-10-09 close", "2026-10-09 close", "2026-10-08 close"]);
    expect(footer).toContain(" · Fri 9 Oct 2026 · ");
  });

  test("a quote ahead of its rank says which close the rank is on", async () => {
    const { title, keys } = await load([
      row("NVDA", reading("2026-10-09", "quote-mid", 0.293), "2026-10-08"),
      row("AAPL", reading("2026-10-09", "quote-mid", 0.265), "2026-10-08"),
    ]);
    expect(title).toContain("IV30 2026-10-09 quote · IVR/IVP vs 52 weeks to 2026-10-08 close");
    expect(keys).not.toContain("rankDate");
  });

  test("IV1Y and its percentile join only when a row has them, ranked on the same close", async () => {
    expect((await load([row("NVDA", reading("2026-10-09", "quote-mid", 0.293), "2026-10-09")])).keys).not.toContain("iv1y");
    const oneYear = (symbol: string, closeDate: string) => {
      const base = row(symbol, reading("2026-10-09", "quote-mid", 0.3), "2026-10-09");
      return { ...base, latest: { ...base.latest!, iv365: 0.31 }, iv365: { ...base.iv30!, value: 0.3, percentile: 22, date: closeDate } };
    };
    const { keys, cell } = await load([oneYear("NVDA", "2026-10-09"), oneYear("AAPL", "2026-10-08")]);
    expect(keys.slice(keys.indexOf("verdict"), keys.indexOf("verdict") + 3)).toEqual(["verdict", "iv1y", "iv1yPercentile"]);
    expect([0, 1].map((index) => [cell("iv1y", index), cell("iv1yPercentile", index)])).toEqual([["31.0%", "22"], ["31.0%", "--"]]);
  });

  test("skew from an older capture than the reading is dated", async () => {
    const stale = { ...row("NVDA", reading("2026-10-09", "trade-close", 0.293), "2026-10-09"),
      skew: { date: "2026-10-08", put25: 0.3, call25: 0.28, skew: 0.02 } };
    const { keys, header, cell, result } = await load([stale]);
    expect(keys).toContain("skewDate");
    // The header names the sign: OVDV's risk reversal subtracts the other way.
    expect(header("skew")).toBe("25D skew put-call (pts)");
    expect(cell("skewDate", 0)).toBe("2026-10-08");
    // Puts at 30% against calls at 28% read +2.0, and the report says which side is subtracted and in what unit.
    expect(cell("skew", 0)).toBe("+2.0");
    expect(result.notes).toEqual([...VCA_DEFINITIONS]);
    expect(result.notes?.[0]).toContain("25-delta put IV minus 25-delta call IV, in vol points; positive means puts are richer");
  });
});

describe("VCA backfill states", () => {
  afterEach(() => { setSystemTime(); });
  const ready = row("AAPL", reading("2026-10-09", "trade-close", 0.3), "2026-10-09");
  const pending = (symbol: string, coverageStatus: IvScreenRow["coverageStatus"], addedAt: string | null, backfilledThrough: string | null,
    warnings: string[] = []): IvScreenRow => ({ symbol, status: coverageStatus === "unavailable" && !warnings.length ? "ready" : "queued",
    coverageStatus, coverage: addedAt ? { source: "demand", addedAt, backfilledThrough } : null, warnings,
    iv30: null, iv90: null, latest: null, skew: null });
  const report = async (rows: IvScreenRow[]) => {
    setSystemTime(new Date("2026-10-11T08:04:00Z"));
    const { result } = await load(rows);
    return { notes: result.notes!.filter((note) => !(VCA_DEFINITIONS as readonly string[]).includes(note)),
      complete: result.complete, unavailableSymbols: result.unavailableSymbols };
  };

  test("a mixed list is incomplete only for history still to come, and says when each symbol was queued or reached", async () => {
    expect(await report([
      ready,
      pending("ZZZZ", "queued", "2026-10-11T07:58:12Z", null),
      pending("ABCD", "backfilling", "2026-10-11T07:31:00Z", "2025-03-14"),
      pending("PFAI", "unavailable", "2026-10-11T04:09:51Z", "2026-10-09"),
      pending("NEXE", "unavailable", "2026-10-11T00:45:22Z", "2026-10-09"),
    ])).toEqual({
      notes: [
        "Queued for backfill: ZZZZ since 07:58 UTC; a first backfill usually takes under 10 minutes, try again after 08:08 UTC.",
        "Backfilling: ABCD through 2025-03-14.",
        "No options history: PFAI, NEXE.",
      ],
      complete: false,
      unavailableSymbols: ["ZZZZ", "ABCD"],
    });
  });

  test("symbols that finished without options leave the screen complete", async () => {
    expect(await report([ready, pending("PFAI", "unavailable", "2026-10-11T04:09:51Z", "2026-10-09"),
      pending("NEXE", "unavailable", "2026-10-11T00:45:22Z", "2026-10-09")]))
      .toEqual({ notes: ["No options history: PFAI, NEXE."], complete: true, unavailableSymbols: [] });
  });

  test("a symbol demand coverage could not take is not final", async () => {
    expect(await report([ready, pending("FULL", "unavailable", null, null, ["Coverage for new underlyings is full; try again later."])]))
      .toEqual({ notes: ["Not queued: FULL. Coverage for new underlyings is full; try again later."], complete: false, unavailableSymbols: ["FULL"] });
  });

  test("a row with no reading says what became of its symbol, and one that stopped trading is not listed again as having no options history", async () => {
    setSystemTime(new Date("2026-10-11T08:04:00Z"));
    const lastTrade = Date.parse("2022-10-27T23:59:59.953Z");
    const hop = { from: "FB", to: "META", date: "2022-06-09" };
    const marketData = createTestDataProvider({
      getQuote: async (symbol) => symbol === "TWTR"
        ? createTestQuote({ symbol, price: 53.86, lastUpdated: lastTrade, lastTradeTime: lastTrade, stale: true })
        : createTestQuote({ symbol, name: "ProShares S&P 500 Dynamic Daily Buffer ETF", listingExchangeName: "BATS" }),
      getTickerChanges: async (symbol) => symbol === "FB"
        ? { symbol, moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [hop] }, formerly: null, listedName: null, changes: [hop] }
        : null,
    });
    const final = (symbol: string) => pending(symbol, "unavailable", "2026-10-11T04:09:51Z", "2026-10-09");
    const { keys, result } = await load([ready, final("TWTR"), final("FB")], marketData);
    expect(keys.at(-1)).toBe("note");
    const section = result.sections[0] as { rows: Array<{ note?: string }> };
    expect(section.rows.map((row) => row.note ?? null)).toEqual([
      null,
      "TWTR stopped trading 2022-10-27; no history or options served",
      "FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)",
    ]);
    expect(result.notes?.[0]).toBe("No options history: FB.");
  });

  test("one symbol whose company moved has nothing to load: HIVG and VCA fail with its change, whatever came back under it", async () => {
    const marketData = createMovedSymbolsProvider();
    const apiClient = { impliedVolatility: async (path: string) => path.startsWith("history")
      ? { version: 1, symbol: "HFC", asOf: "2026-10-10", status: "ready", coverage: null, stats: { iv30: null, iv90: null }, latest: null, series: [], warnings: [] }
      : { version: 1, asOf: "2026-10-10", rows: [pending("HFC", "unavailable", null, null)] } } as unknown as HeadlessPaneApiClient;
    const ctx = createTestHeadlessContext({ apiClient, marketData });
    for (const definition of [ivHistoryHeadless, ivScreenHeadless]) {
      const failure = await Promise.resolve(definition.load(createTestHeadlessArgs({ symbols: ["HFC"] }), ctx)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MovedSymbolError);
      expect((failure as MovedSymbolError).change).toMatchObject({ note: "HFC became DINO on 2022-03-15", tradesAs: "DINO" });
    }
    // META, which a new company holds, loads.
    expect(await ivHistoryHeadless.load(createTestHeadlessArgs({ symbols: ["META"] }), ctx)).toBeDefined();
  });

  test("an older server's queued symbol reads as before, retried from now", async () => {
    const queued: IvScreenRow = { symbol: "ZZZZ", status: "queued", iv30: null, iv90: null, latest: null, skew: null };
    expect(await report([ready, queued])).toEqual({
      notes: ["Queued for backfill: ZZZZ; a first backfill usually takes under 10 minutes, try again after 08:14 UTC."],
      complete: false, unavailableSymbols: ["ZZZZ"],
    });
  });
});

describe("HIVG skew history", () => {
  const point = (sessionDate: string, method: IvMethod, wings?: { put25_30: number | null; call25_30: number | null }): IvPoint => ({
    sessionDate, method, capturedAt: `${sessionDate}T${method === "quote-mid" ? "19:47" : "23:30"}:00Z`, spot: 100,
    iv7: null, iv30: 0.2, iv60: null, iv90: 0.21, iv180: null, iv365: null, ...wings,
  });
  const noWings = { put25_30: null, call25_30: null };
  const report = async (series: IvPoint[]) => {
    const payload: IvHistoryPayload = { version: 1, symbol: "SPY", asOf: "2026-10-10", status: "ready",
      coverage: { source: "seed", addedAt: "2026-09-23T00:00:00Z", backfilledThrough: "2026-10-09", since: "2026-10-05" },
      stats: { iv30: null, iv90: null }, latest: null, series, warnings: [] };
    const args = createTestHeadlessArgs({ rawArgument: "SPY", argument: "SPY", symbols: ["SPY"], options: { lookback: "ALL", hvWindow: "20" } });
    const apiClient = { impliedVolatility: async () => payload } as unknown as HeadlessPaneApiClient;
    const result = await ivHistoryHeadless.load(args, createTestHeadlessContext({ apiClient })) as HeadlessBundleResult;
    const freshness = deriveHeadlessFreshness(ivHistoryHeadless, result);
    const csv = renderReportCsv(headlessReportTables(ivHistoryHeadless, result, args, "HIVG", freshness, { complete: true, unavailableSymbols: [] }));
    const daily = csv.split("# section: Daily history\n")[1]!.split("\n\n")[0]!.split("\n");
    return { result, daily, text: renderHeadlessPaneText(ivHistoryHeadless, result, args, "HIVG", freshness) };
  };

  test("each session joins its own capture's skew, blank before the first, and the notes say when it starts", async () => {
    const { result, daily, text } = await report([
      point("2026-10-05", "trade-close", noWings), point("2026-10-06", "trade-close", noWings),
      // A capture that missed a wing is no skew at all, not half of one.
      point("2026-10-06", "quote-mid", { put25_30: 0.25, call25_30: null }),
      point("2026-10-07", "trade-close", noWings), point("2026-10-07", "quote-mid", { put25_30: 0.24, call25_30: 0.212 }),
      point("2026-10-08", "trade-close", noWings), point("2026-10-08", "quote-mid", { put25_30: 0.23, call25_30: 0.205 }),
    ]);
    // Existing columns keep their order; the two skew columns follow IV-HV, each naming its sign.
    expect(daily[0]!.split(",").map((header) => header.replace(/ \(%\)$/, "")))
      .toEqual(["Session", "IV30", "IV90", "IV1Y", "HV", "IV-HV", "skew25d put-call (pts)", "rr25d call-put (pts)", "status"]);
    expect(daily.slice(1).map((line) => line.split(",").slice(-3, -1).join(","))).toEqual(["2.5,-2.5", "2.8,-2.8", ",", ","]);
    expect(daily.slice(1).map((line) => line.split(",")[0])).toEqual(["2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05"]);
    expect(result.notes).toEqual(["no IV1Y history yet", "skew from 2026-10-07"]);
    const cells = (date: string) => text.split("\n").find((line) => line.startsWith(date))!.trim().split(/\s{2,}/);
    expect(cells("2026-10-08").slice(-2)).toEqual(["+2.5", "-2.5"]);
    expect(cells("2026-10-05").slice(-2)).toEqual(["--", "--"]);
  });

  test("an older server without the wing fields keeps the CSV columns blank and says skew is unavailable", async () => {
    const { result, daily, text } = await report([point("2026-10-07", "trade-close"), point("2026-10-07", "quote-mid"), point("2026-10-08", "trade-close")]);
    expect(daily[0]!.endsWith(",IV-HV,skew25d put-call (pts),rr25d call-put (pts),status")).toBe(true);
    expect(daily.slice(1).every((line) => line.endsWith(",,,"))).toBe(true);
    expect(result.notes).toContain("skew unavailable from this server");
    // The text table leaves out columns no session fills.
    expect(text).not.toContain("skew25d");
  });
});

describe("HIVG exports for scripts", () => {
  const session = (sessionDate: string, iv30: number): IvPoint => ({
    sessionDate, method: "trade-close", capturedAt: `${sessionDate}T23:30:00Z`, spot: 100,
    iv7: null, iv30, iv60: null, iv90: iv30 + 0.01, iv180: null, iv365: null,
  });
  // September 2026's sessions: weekdays, and Labor Day (7 Sep) is none.
  const september = Array.from({ length: 30 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`)
    .filter((date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) && date !== "2026-09-07")
    .map((date, index) => session(date, 0.12 + index / 1000));
  const load = async (symbol: string, series: IvPoint[], options: Record<string, string | number> = {}) => {
    const payload: IvHistoryPayload = { version: 1, symbol, asOf: "2026-10-01", status: series.length ? "ready" : "unavailable",
      coverage: { source: "seed", addedAt: "2026-08-01T00:00:00Z", backfilledThrough: "2026-09-30", since: series[0]?.sessionDate ?? null },
      stats: { iv30: null, iv90: null }, latest: null, series, warnings: series.length ? [] : ["Coverage for new underlyings is full; try again later."] };
    const args = createTestHeadlessArgs({ rawArgument: symbol, argument: symbol, symbols: [symbol], options: { lookback: "ALL", hvWindow: "20", offset: 0, ...options } });
    const apiClient = { impliedVolatility: async () => payload } as unknown as HeadlessPaneApiClient;
    const result = await ivHistoryHeadless.load(args, createTestHeadlessContext({ apiClient })) as HeadlessBundleResult;
    const freshness = deriveHeadlessFreshness(ivHistoryHeadless, result);
    const csv = renderReportCsv(headlessReportTables(ivHistoryHeadless, result, args, "HIVG", freshness, { complete: true, unavailableSymbols: [] }), freshness);
    return { result, lines: csv.split("\n") };
  };
  const headers = (lines: string[]) => lines.filter((_, index) => lines[index - 1]?.startsWith("# section:"));

  test("a symbol with no IV history exports the same columns as one with it, with no unit moving into or out of a header", async () => {
    const covered = await load("SPY", september);
    const uncovered = await load("SCHD", []);
    expect(headers(uncovered.lines)).toEqual(headers(covered.lines));
    expect(headers(covered.lines)).toEqual([
      "Measure,Current,As of,Method,52w low,52w high,Rank,Pctl,Sessions,status,symbol_or_series,currency_or_unit,interval,source,as_of",
      "Session,IV30 (%),IV90 (%),IV1Y (%),HV (%),IV-HV,skew25d put-call (pts),rr25d call-put (pts),status,symbol_or_series,currency_or_unit,interval,source,as_of",
    ]);
    // Each measure's unit stays in its label, figures or none.
    const measures = (lines: string[]) => lines.filter((line) => /^(IV|HV) /.test(line)).map((line) => line.split(",")[0]);
    expect(measures(uncovered.lines)).toEqual(measures(covered.lines));
  });

  test("--event fomc --offset -6 is one row per past release, read on the sixth session before it", async () => {
    const { lines } = await load("SPY", september, { event: "fomc", offset: -6 });
    expect(lines[0]).toBe("Release,Release date,Offset (sessions),Session,IV30 (%),IV90 (%),IV1Y (%),HV (%),IV-HV,"
      + "skew25d put-call (pts),rr25d call-put (pts),status,symbol_or_series,currency_or_unit,interval,source,as_of");
    // 16 Sep's FOMC, six sessions back over Labor Day; July's is before the history.
    expect(lines.filter((line) => line.startsWith("FOMC,"))).toEqual([expect.stringMatching(/^FOMC,2026-09-16,-6,2026-09-08,12\.4,13\.4,/)]);

    // A session past the history's last is not there yet: the release is left out and named.
    const ahead = await load("SPY", september, { event: "fomc", offset: 15 });
    expect(ahead.result.sections[0]!.rows).toEqual([]);
    expect(ahead.result.notes).toContain("Left out FOMC 2026-09-16, whose session at --offset 15 has not closed yet.");
    expect(ahead.result.unavailableSymbols).toEqual(["SPY"]);
    await expect(Promise.resolve(ivHistoryHeadless.load(createTestHeadlessArgs({ symbols: ["SPY"], options: { lookback: "1Y", hvWindow: "20", offset: -6 } }),
      createTestHeadlessContext()))).rejects.toThrow("--offset counts sessions from a release day: add --event fomc, cpi or jobs.");
  });
});
