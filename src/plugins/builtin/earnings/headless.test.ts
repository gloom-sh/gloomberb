import { expect, test } from "bun:test";
import type { EarningsCalendarPayload, EarningsCalendarReport, EarningsHistoryPayload } from "../../../api-client/earnings";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { addDays, newYorkToday } from "./board-model";
import { calendarWeekDates } from "./calendar-model";
import { sameHistoryListing } from "./client";
import { createEarningsBoardHeadless, createEarningsHeadless } from "./headless";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";

const today = newYorkToday();
type HistoryReport = EarningsHistoryPayload["reports"][number];
const report = (fields: Partial<HistoryReport> & Pick<HistoryReport, "date">): HistoryReport => ({
  symbol: "CRWV", name: "CoreWeave, Inc.", timing: "amc", timingSource: "filing", reportedAt: null, fiscalPeriod: null,
  marketCap: null, epsEstimate: null, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
  implied: null, realized: null, revenueActual: null, ...fields,
});
const history: EarningsHistoryPayload = { asOf: `${today}T12:00:00.000Z`, symbol: "CRWV", name: "CoreWeave, Inc.", reports: [
  report({ date: addDays(today, 30), fiscalPeriod: "2026-09", timingSource: "history", epsEstimate: -1.52697, epsAnalysts: 18, dateStatus: "projected" }),
  report({ date: addDays(today, -60), fiscalPeriod: "2026-06", epsEstimate: -1.52, epsActual: -1.32, epsAnalysts: 5, epsBasis: "adjusted", dateStatus: "reported" }),
  report({ date: addDays(today, -150), fiscalPeriod: "2026-03", epsEstimate: -1.17, epsActual: -1.38, epsAnalysts: 4, epsBasis: null, dateStatus: "reported" }),
] };
const context = {} as HeadlessPaneContext;
const args = { rawArgument: "CRWV", argument: "CRWV", symbols: ["CRWV"], options: {} };

test("ERN rows carry each quarter's basis, the estimate's analysts and whether the next date is projected", async () => {
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => history,
    upcoming: async () => [],
  });
  const result = await definition.load(args, context);
  expect(result.rows.map((row) => [row.dateStatus, row.epsEstimate, row.epsAnalysts, row.epsActual, row.epsBasis])).toEqual([
    ["projected", -1.52697, 18, null, null],
    ["reported", -1.52, 5, -1.32, "adjusted"],
    ["reported", -1.17, 4, -1.38, "unknown"],
  ]);
});

test("a REIT's next report shows the calendar's FFO consensus labelled adjusted, on ERN <ticker> and the board", async () => {
  const pld = report({ symbol: "PLD", name: "Prologis, Inc.", date: addDays(today, 2), timing: "bmo", timingSource: "calendar",
    fiscalPeriod: "2026-09", epsEstimate: 1.58, epsAnalysts: 2, epsBasis: "adjusted", dateStatus: "confirmed" });
  const reported = report({ symbol: "PLD", date: addDays(today, -89), timing: "bmo", fiscalPeriod: "2026-06", epsEstimate: 1.53,
    epsActual: 1.63, epsAnalysts: 4, epsBasis: "adjusted", dateStatus: "reported" });
  const definition = createEarningsHeadless({
    calendar: async () => ({ asOf: `${today}T12:00:00.000Z`, from: today, to: addDays(today, 90),
      reports: [{ ...pld, marketCap: 122.8e9, averageMove: null, averageReports: 0 }] }),
    history: async () => ({ ...history, symbol: "PLD", name: "Prologis, Inc.", reports: [pld, reported] }),
    upcoming: async () => [],
  });
  const ern = await definition.load({ ...args, rawArgument: "PLD", argument: "PLD", symbols: ["PLD"] }, context);
  expect(ern.rows.map((row) => [row.dateStatus, row.epsEstimate, row.epsAnalysts, row.epsActual, row.epsBasis])).toEqual([
    ["confirmed", 1.58, 2, null, "adjusted"],
    ["reported", 1.53, 4, 1.63, "adjusted"],
  ]);
  const board = await definition.load({ rawArgument: "PLD GOOGL", argument: ["PLD", "GOOGL"], symbols: ["PLD", "GOOGL"], options: {} }, context);
  expect(board.rows.map((row) => [row.symbol, row.epsEstimate, row.epsAnalysts, row.epsBasis])).toEqual([["PLD", 1.58, 2, "adjusted"]]);
});

test("past the stored horizon the per-ticker calendar's estimate keeps its own analyst count and date flag", async () => {
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => ({ ...history, reports: history.reports.slice(1) }),
    upcoming: async () => [{
      symbol: "CRWV", name: "CoreWeave, Inc.", earningsDate: new Date(`${addDays(today, 30)}T00:00:00Z`), isDateEstimate: false,
      epsEstimate: -1.52697, epsAnalysts: 18, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, timing: "AMC",
      estimateBasis: {
        epsEstimate: { source: "earningsTrend", sourceValue: -1.52697, period: "0q", periodEndDate: "2026-09-30", currency: "USD" },
        epsAnalysts: { source: "calendarEvents", sourceValue: 9, period: null, periodEndDate: null },
      },
    }],
  });
  const [next] = (await definition.load(args, context)).rows;
  // A count from another forecast does not describe this estimate.
  expect(next).toMatchObject({ upcoming: true, dateStatus: "confirmed", epsEstimate: -1.52697, epsAnalysts: null, epsBasis: null });
});

test("ERN names each quarter as the company does, and places the calendar's next report past the stored horizon in its quarter", async () => {
  // Apple on 2026-11-05: the September quarter closed fiscal 2026; the January report is only on the per-ticker calendar.
  const apple = (fields: Partial<HistoryReport> & Pick<HistoryReport, "date">) => report({ symbol: "AAPL", name: "Apple Inc.", ...fields });
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => ({ asOf: `${today}T12:00:00.000Z`, symbol: "AAPL", name: "Apple Inc.",
      fiscalAnchor: { fiscalPeriod: "2026-09", fiscalYear: 2026, fiscalQuarter: 4 },
      reports: [
        apple({ date: addDays(today, -3), fiscalPeriod: "2026-09", fiscalYear: 2026, fiscalQuarter: 4, epsEstimate: 1.98, epsActual: 2.05, dateStatus: "reported" }),
        apple({ date: addDays(today, -98), fiscalPeriod: "2026-06", fiscalYear: 2026, fiscalQuarter: 3, epsEstimate: 1.88, epsActual: 1.91, dateStatus: "reported" }),
      ] }),
    upcoming: async () => [{
      symbol: "AAPL", name: "Apple Inc.", earningsDate: new Date("2027-01-28T00:00:00Z"), isDateEstimate: true,
      epsEstimate: 2.9, epsAnalysts: null, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, timing: "AMC",
      estimateBasis: { epsEstimate: { source: "calendarEvents", sourceValue: 2.90255, period: null, periodEndDate: null, currency: null } },
    }],
  });
  const result = await definition.load({ ...args, rawArgument: "AAPL", argument: "AAPL", symbols: ["AAPL"] }, context);
  expect(result.rows.map((row) => [row.date, row.fiscalPeriod, row.fiscalQuarter])).toEqual([
    ["2027-01-28", "2026-12", "Q1 FY2027"],
    [addDays(today, -3), "2026-09", "Q4 FY2026"],
    [addDays(today, -98), "2026-06", "Q3 FY2026"],
  ]);
  // Without the company's calendar the quarter stays its end month, and a report without one stays unplaced.
  const bare = createEarningsHeadless({ calendar: async () => { throw new Error("unused"); }, history: async () => history, upcoming: async () => [] });
  expect((await bare.load(args, context)).rows.map((row) => [row.fiscalPeriod, row.fiscalQuarter])).toEqual([
    ["2026-09", null], ["2026-06", null], ["2026-03", null],
  ]);
  expect(result.metadata?.impliedMove).toContain("never estimated");
});

test("the next report keeps the basis Gloom Cloud names for its consensus when the calendar's event names none", async () => {
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => ({ ...history, reports: [{ ...history.reports[0]!, epsEstimate: -1.53, epsBasis: "adjusted" }, ...history.reports.slice(1)] }),
    upcoming: async () => [{
      symbol: "CRWV", name: "CoreWeave, Inc.", earningsDate: new Date(`${addDays(today, 30)}T00:00:00Z`), isDateEstimate: true,
      epsEstimate: -1.53, epsAnalysts: 18, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, timing: "AMC",
      estimateBasis: { epsEstimate: { source: "earningsTrend", sourceValue: -1.52697, period: "0q", periodEndDate: "2026-09-30", currency: "USD" } },
    }],
  });
  const [next] = (await definition.load(args, context)).rows;
  expect(next).toMatchObject({ upcoming: true, epsEstimate: -1.53, epsBasis: "adjusted" });
  // Past the stored horizon the history has no row for it: the company's consensus basis labels it, and only an estimate.
  const calendarOnly = async (consensusBasis: "adjusted" | null, epsEstimate: number | null) => (await createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => ({ ...history, consensusBasis, reports: history.reports.slice(1) }),
    upcoming: async () => [{
      symbol: "CRWV", name: "CoreWeave, Inc.", earningsDate: new Date(`${addDays(today, 30)}T00:00:00Z`), isDateEstimate: true,
      epsEstimate, epsAnalysts: null, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, timing: "AMC",
    }],
  }).load(args, context)).rows[0];
  expect(await calendarOnly("adjusted", -1.53)).toMatchObject({ upcoming: true, epsBasis: "adjusted" });
  expect(await calendarOnly(null, -1.53)).toMatchObject({ upcoming: true, epsBasis: null });
  expect(await calendarOnly("adjusted", null)).toMatchObject({ upcoming: true, epsBasis: null });
});

test("ERN board rows carry the status, analysts and basis ERN <ticker> shows, ranked by the served cap", async () => {
  const day = addDays(today, 1);
  const calendarReport = (fields: Partial<HistoryReport> & Pick<HistoryReport, "symbol" | "date">) =>
    ({ ...report(fields), averageMove: null, averageReports: 0 });
  const definition = createEarningsHeadless({
    calendar: async () => ({ asOf: `${today}T12:00:00.000Z`, from: today, to: addDays(today, 90), reports: [
      calendarReport({ symbol: "PEP", date: today, marketCap: 210e9, epsEstimate: 2.26, epsActual: 2.29, epsAnalysts: 15, epsBasis: "adjusted", dateStatus: "reported" }),
      calendarReport({ symbol: "GOOGL", date: day, marketCap: 4.31e12, epsEstimate: 3.02071, epsAnalysts: 43, dateStatus: "confirmed" }),
      calendarReport({ symbol: "KO", date: day, marketCap: 386.37e9, epsEstimate: 0.88024, epsAnalysts: 18, epsBasis: null, dateStatus: "confirmed" }),
    ] }),
    history: async () => { throw new Error("unused"); },
    // A company the stored calendar does not carry: its estimate is in another currency, so neither it nor its count is shown.
    upcoming: async () => [{
      symbol: "SAP", name: "SAP SE", earningsDate: new Date(`${addDays(today, 20)}T00:00:00Z`), isDateEstimate: true,
      epsEstimate: 1.6, epsAnalysts: 20, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, timing: "",
      estimateBasis: { epsEstimate: { source: "earningsTrend", sourceValue: 1.6, period: "0q", periodEndDate: "2026-09-30", currency: "EUR" } },
    }],
  });
  const result = await definition.load({ rawArgument: "PEP GOOGL KO SAP", argument: ["PEP", "GOOGL", "KO", "SAP"], symbols: ["PEP", "GOOGL", "KO", "SAP"], options: {} }, context);
  expect(result.rows.map((row) => [row.symbol, row.dateStatus, row.epsEstimate, row.epsAnalysts, row.epsActual, row.epsBasis, row.marketCap])).toEqual([
    ["PEP", "reported", 2.26, 15, 2.29, "adjusted", 210e9],
    ["GOOGL", "confirmed", 3.02071, 43, null, null, 4.31e12],
    ["KO", "confirmed", 0.88024, 18, null, null, 386.37e9],
    ["SAP", "projected", null, null, null, null, null],
  ]);
});

test("EVTS with a ticker stays the market board and says whether that ticker is on it", async () => {
  const day = addDays(today, 1);
  const board = createEarningsBoardHeadless({
    calendar: async () => ({ asOf: `${today}T12:00:00.000Z`, from: today, to: day, reports: [
      { ...report({ date: day }), symbol: "SAN", name: "Banco Santander, S.A.", averageMove: null, averageReports: 0 },
    ] }) as never,
    history: async () => { throw new Error("unused"); },
    upcoming: async () => { throw new Error("unused"); },
  });
  const highlight = async (symbol: string) => (await board.load({ ...args, rawArgument: symbol, argument: symbol, symbols: [symbol] }, context)).metadata?.highlight;
  expect(await highlight("SAN")).toEqual({ symbol: "SAN", onBoard: true, date: day, row: "SAN" });
  // Sanofi in Paris is not the US board's SAN.
  expect(await highlight("SAN:EPA")).toEqual({ symbol: "SAN:EPA", onBoard: false, date: null, row: null });
});

test("EVTS reads the Hong Kong, China A and Singapore listings too: a listing named lands on its row, in its own currency, ranked by its dollar cap", async () => {
  const day = addDays(today, 6);
  const queries: Array<{ symbols: string[]; markets?: string; perDay: number }> = [];
  // As Gloom Cloud serves them with markets=all: Tencent's confirmed Q3 in CNY, CCB under its A share, NVDA in dollars.
  const listing = (fields: Partial<EarningsCalendarReport> & Pick<EarningsCalendarReport, "symbol" | "marketCap">) => ({
    ...report({ date: day, timing: null, timingSource: null, fiscalPeriod: "2026-09", dateStatus: "confirmed" }),
    averageMove: null, averageReports: 0, implied: null, ...fields,
  });
  const board = createEarningsBoardHeadless({
    calendar: async (query) => {
      queries.push(query);
      return { asOf: `${today}T12:00:00.000Z`, from: query.from, to: query.to, reports: [
        listing({ symbol: "0700:HKEX", name: "Tencent Holdings Limited", marketCap: 459.65e9, currency: "CNY", listings: ["0700:HKEX"],
          epsEstimate: 7.21, epsAnalysts: 12, revenueEstimate: 210.24e9 }),
        listing({ symbol: "601939:SSE", name: "China Construction Bank", marketCap: 471.2e9, currency: "CNY", listings: ["601939:SSE", "0939:HKEX"],
          epsEstimate: 0.37, dateStatus: "reported", epsActual: 0.38 }),
        { ...report({ symbol: "NVDA", date: day, timing: "amc", marketCap: 4.5e12, epsEstimate: 1.25 }), averageMove: 0.07, averageReports: 8 },
        // Alibaba reports the same day as BABA and 9988:HKEX: the board shows BABA, with the listing's lines.
        { ...report({ symbol: "BABA", date: day, timing: "bmo", marketCap: 380e9, epsEstimate: 2.12 }), averageMove: 0.05, averageReports: 8,
          listings: ["9988:HKEX"] },
      ] } as EarningsCalendarPayload;
    },
    history: async () => { throw new Error("unused"); },
    upcoming: async () => { throw new Error("unused"); },
  });
  const load = (symbol: string) => board.load({ ...args, rawArgument: symbol, argument: symbol, symbols: symbol ? [symbol] : [] }, context);
  const tencent = await load("0700:HKEX");
  // The listing is named so the board keeps it whatever the day's cut; a US ticker is not.
  expect(queries.at(-1)).toMatchObject({ perDay: 200, symbols: ["0700:HKEX"], markets: "all" });
  expect(tencent.metadata?.highlight).toEqual({ symbol: "0700:HKEX", onBoard: true, date: day, row: "0700:HKEX" });
  expect(tencent.metadata?.notices).toEqual([expect.stringContaining(`0700:HKEX reports on ${day}.`)]);
  expect(tencent.rows.map((row) => [row.symbol, row.currency, row.marketCap, row.epsEstimate, row.revenueEstimate, row.timing])).toEqual([
    ["NVDA", "USD", 4.5e12, 1.25, null, "AMC"],
    ["601939:SSE", "CNY", 471.2e9, 0.37, null, null],
    ["0700:HKEX", "CNY", 459.65e9, 7.21, 210.24e9, null],
    ["BABA", "USD", 380e9, 2.12, null, "BMO"],
  ]);
  // Alibaba named by its Hong Kong line is BABA's row; BABA named is its own, though it carries the listing's lines.
  expect((await load("9988.HK")).metadata?.highlight).toMatchObject({ onBoard: true, row: "BABA" });
  expect((await load("9988.HK")).metadata?.notices).toEqual([expect.stringContaining(`9988.HK reports on ${day} (as BABA).`)]);
  expect((await load("BABA")).metadata?.highlight).toMatchObject({ onBoard: true, row: "BABA" });
  expect((await load("BABA")).metadata?.notices).toEqual([expect.stringContaining(`BABA reports on ${day}.`)]);
  expect(tencent.metadata?.currency).toContain("never converted");
  // CCB named by its H share is on the board under its A share; a 700 typed without its zero is Tencent's row.
  expect((await load("0939:HKEX")).metadata?.highlight).toEqual({ symbol: "0939:HKEX", onBoard: true, date: day, row: "601939:SSE" });
  expect((await load("0939:HKEX")).metadata?.notices).toEqual([expect.stringContaining(`0939:HKEX reports on ${day} (as 601939:SSE).`)]);
  expect((await load("700:HKEX")).metadata?.highlight).toMatchObject({ onBoard: true, row: "0700:HKEX" });
  // Typed with its vendor suffix where its quote could not be read, it is still Tencent's listing, kept by name.
  expect((await load("0700.HK")).metadata?.highlight).toMatchObject({ onBoard: true, row: "0700:HKEX" });
  expect(queries.at(-1)).toMatchObject({ symbols: ["0700:HKEX"] });
  await load("NVDA");
  expect(queries.at(-1)).toMatchObject({ symbols: [], markets: "all" });
  // A US ticker is never a listing abroad's row, nor one of its lines.
  expect((await load("SSE")).metadata?.highlight).toMatchObject({ onBoard: false });
});

test("ERN for a listing abroad shows its next report and names the company's US listing instead of the US board's other SAN", async () => {
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    // The board files SAN under Banco Santander, so SAN:EPA must never be asked for there.
    history: async () => { throw new Error("A US ticker symbol is required"); },
    upcoming: async () => [{
      symbol: "SAN:EPA", name: "Sanofi", earningsDate: new Date(`${addDays(today, 19)}T00:00:00Z`), isDateEstimate: false,
      epsEstimate: 2.85, epsActual: null, revenueEstimate: 13.22e9, revenueActual: null, surprise: null, timing: "",
    }],
  });
  const marketData = {
    search: async (query: string) => query === "Sanofi"
      ? [{ providerId: "test", symbol: "SNY", name: "Sanofi ADR", exchange: "NASDAQ", type: "ADR", currency: "USD" }]
      : [],
  } as unknown as HeadlessPaneContext["marketData"];
  const result = await definition.load({ rawArgument: "SAN:EPA", argument: ["SAN:EPA"], symbols: ["SAN:EPA"], options: {} }, { marketData } as HeadlessPaneContext);
  expect(result.errors).toBeUndefined();
  expect(result.rows.map((row) => [row.date, row.epsEstimate])).toEqual([[addDays(today, 19), 2.85]]);
  expect(result.metadata?.notices).toEqual([
    "Past reports, surprises and implied moves cover US, Hong Kong, Singapore and China A listings only, so SAN:EPA shows its next report. Sanofi's US listing is SNY: ERN SNY has them.",
  ]);
});

// `fn ERN VOW3:XETRA`, 13 Nov 2026: no next report on the calendar, yet the notice promised one and the table was bare.
test("ERN for a listing abroad with no next report says so, with its last report, and promises none", async () => {
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => { throw new Error("A US ticker symbol is required"); },
    upcoming: async () => [],
  });
  const marketData = {
    search: async () => [],
    getQuote: async () => ({ symbol: "VOW3", name: "Volkswagen AG", price: 90, currency: "EUR" }),
    getCorporateActions: async () => ({ earnings: [
      { date: "2026-10-29", dateType: "announcement", epsActual: 1.62, fiscalPeriod: "2026-09-30" },
      { date: "2027-03-10", dateType: "announcement", epsActual: null },
    ] }),
    getTickerFinancials: async () => ({ quarterlyStatements: [] }),
  } as unknown as HeadlessPaneContext["marketData"];
  const result = await definition.load({ rawArgument: "VOW3:XETRA", argument: ["VOW3:XETRA"], symbols: ["VOW3:XETRA"], options: {} },
    { marketData } as HeadlessPaneContext);
  expect(result.rows).toEqual([]);
  expect(result.metadata?.notices).toEqual(["Past reports, surprises and implied moves cover US, Hong Kong, Singapore and China A listings only."]);
  expect(result.empty).toBe("VOW3:XETRA: no next report date on record; last reported 2026-10-29 (quarter ended 2026-09-30). Headlines: gloom news VOW3:XETRA");
});

test("ERN for a Hong Kong listing reads its own reports: each in its period and currency, a half never a quarter", async () => {
  const tencent = (fields: Partial<HistoryReport> & Pick<HistoryReport, "date">) =>
    report({ symbol: "0700:HKEX", name: "Tencent", timing: null, timingSource: null, currency: "CNY", dateStatus: "reported", ...fields });
  const next = addDays(today, 12);
  const payload: EarningsHistoryPayload = {
    asOf: `${today}T12:00:00.000Z`, symbol: "0700:HKEX", name: "Tencent",
    fiscalAnchor: { fiscalPeriod: "2025-12", fiscalYear: 2025, fiscalQuarter: 4 }, consensusBasis: "adjusted",
    reports: [
      tencent({ date: next, fiscalPeriod: "2026-09", fiscalYear: 2026, fiscalQuarter: 3, epsEstimate: 7.22, dateStatus: "confirmed" }),
      tencent({ date: addDays(today, -86), timing: "amc", timingSource: "filing", fiscalPeriod: "2026-06", fiscalYear: 2026, fiscalQuarter: 2,
        epsEstimate: 7.23544, epsActual: 7.433, epsBasis: "adjusted", revenueActual: 204.8e9, revenueActualSource: "filing",
        filing: { url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0812/2026081200296.pdf", title: "Results", publishedAt: "2026-08-12T08:31:00.000Z" } }),
      // A half the street has no quarter for: its own row, with no estimate.
      tencent({ date: addDays(today, -88), fiscalPeriod: "2026-06", periodKind: "half", periodMonths: 6, fiscalYear: 2026, fiscalHalf: 1,
        epsActual: 12.1, epsActualSource: "filing", epsBasis: "gaap", revenueActual: 400e9, revenueActualSource: "filing" }),
      // A figure with no currency could be any: it is not shown.
      tencent({ date: addDays(today, -180), fiscalPeriod: "2026-03", epsEstimate: 7.2, epsActual: 7.3, currency: null }),
    ],
  };
  let served: EarningsHistoryPayload | Error = payload;
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async (symbol) => {
      expect(symbol).toBe("0700:HKEX");
      if (served instanceof Error) throw served;
      return served;
    },
    upcoming: async () => [{
      symbol: "0700:HKEX", name: "Tencent", earningsDate: new Date(`${next}T08:10:00Z`), isDateEstimate: false, timing: "BMO",
      epsEstimate: 7.22, epsActual: null, revenueEstimate: 210.36e9, revenueActual: null, surprise: null, epsAnalysts: 12,
      estimateBasis: {
        epsEstimate: { source: "earningsTrend", sourceValue: 7.22, period: "0q", periodEndDate: "2026-09-30", currency: "CNY" },
        revenueEstimate: { source: "earningsTrend", sourceValue: 210.36e9, period: "0q", periodEndDate: "2026-09-30", currency: "CNY" },
      },
    }],
  });
  const load = () => definition.load({ rawArgument: "0700:HKEX", argument: ["0700:HKEX"], symbols: ["0700:HKEX"], options: {} }, context);
  const result = await load();
  expect(result.metadata?.notices).toBeUndefined();
  expect(result.columns?.map((column) => column.key)).toContain("currency");
  expect(result.rows.map((row) => [row.date, row.timing, row.period, row.currency, row.epsEstimate, row.epsActual, row.epsBasis, row.revenueEstimate, row.revenueActual])).toEqual([
    // New York's "BMO" is not Hong Kong's session.
    [next, null, "Q3 FY2026", "CNY", 7.22, null, "adjusted", 210.36e9, null],
    [addDays(today, -86), "AMC", "Q2 FY2026", "CNY", 7.23544, 7.433, "adjusted", null, 204.8e9],
    [addDays(today, -88), null, "H1 FY2026", "CNY", null, 12.1, "GAAP", null, 400e9],
  ]);
  expect(result.rows[1]!.filing).toContain("hkexnews.hk");
  // The pane gets the listing as typed: every way of naming it reads its own reports, never a US ticker's.
  for (const typed of ["0700.HK", "700.HK", "00700.HK", "0700:XHKG"]) {
    const read = await definition.load({ rawArgument: typed, argument: [typed], symbols: [typed], options: {} }, context);
    expect([typed, read.errors, read.rows.map((row) => [row.period, row.currency])])
      .toEqual([typed, undefined, result.rows.map((row) => [row.period, row.currency])]);
  }
  // A server that does not read Hong Kong's history yet refuses it: the next report stands alone, with no error.
  const { ApiRequestError } = await import("../../../api-client/errors");
  served = new ApiRequestError("A US ticker symbol is required", 400);
  const old = await load();
  expect(old.errors).toBeUndefined();
  expect(old.rows.map((row) => [row.date, row.currency, row.epsEstimate])).toEqual([[next, "CNY", 7.22]]);
  // Gloom Cloud names the listing by its four-digit code.
  expect([sameHistoryListing("0700:HKEX", "700:HKEX"), sameHistoryListing("0700:HKEX", "0700:HKEX"), sameHistoryListing("0700:HKEX", "7000:HKEX"), sameHistoryListing("SAN", "SAN:EPA")])
    .toEqual([true, true, false, false]);
});

test("a press release's figures are flagged provisional on the board and in the history, and the text report says so", async () => {
  const definition = createEarningsHeadless({
    calendar: async () => ({ asOf: `${today}T12:00:00.000Z`, from: today, to: addDays(today, 90), reports: [
      { ...report({ symbol: "TFC", date: today, timing: "bmo", marketCap: 60e9, epsEstimate: 1.17, epsActual: 1.16, epsActualSource: "press-release",
        epsAnalysts: 20, epsBasis: "adjusted", dateStatus: "reported" }), averageMove: null, averageReports: 0 },
      { ...report({ symbol: "PEP", date: today, marketCap: 210e9, epsEstimate: 2.26, epsActual: 2.29, epsActualSource: "calendar",
        epsBasis: "adjusted", dateStatus: "reported" }), averageMove: null, averageReports: 0 },
    ] }),
    history: async () => ({ ...history, symbol: "TFC", reports: [
      report({ symbol: "TFC", date: today, fiscalPeriod: "2026-09", epsEstimate: 1.17, epsActual: 1.16, epsActualSource: "press-release",
        epsBasis: "adjusted", dateStatus: "reported", revenueActual: 5.31e9, revenueActualSource: "press-release" }),
    ] }),
    upcoming: async () => [],
  });
  const board = await definition.load({ rawArgument: "TFC PEP", argument: ["TFC", "PEP"], symbols: ["TFC", "PEP"], options: {} }, context);
  expect(board.rows.map((row) => [row.symbol, row.epsActual, row.epsActualProvisional, row.epsBasis])).toEqual([
    ["PEP", 2.29, false, "adjusted"],
    ["TFC", 1.16, true, "adjusted"],
  ]);
  expect(board.rows.find((row) => row.symbol === "TFC")?.epsSurprise).toBeCloseTo(-0.0085, 4);
  expect(board.metadata?.provisional).toContain("press release");
  const basis = board.columns!.find((column) => column.key === "epsBasis")!;
  expect(board.rows.map((row) => basis.textFormat!(row.epsBasis, row))).toEqual(["adjusted", "adjusted, provisional"]);
  // Exports keep the basis alone; the flag is its own field.
  expect(basis.format).toBeUndefined();

  const ern = await definition.load({ ...args, rawArgument: "TFC", argument: "TFC", symbols: ["TFC"] }, context);
  expect(ern.rows.map((row) => [row.epsActual, row.epsActualProvisional, row.revenueActual, row.revenueActualProvisional])).toEqual([
    [1.16, true, 5.31e9, true],
  ]);
  expect(ern.metadata?.provisional).toContain("press release");
});

test("EVTS looks back a week or a day, the days the pane's Range shows, and ERN's history refuses a range it would not use", async () => {
  const queries: { from: string; to: string; perDay: number; symbols: string[]; markets?: "all" }[] = [];
  const deps = {
    calendar: async (query: { from: string; to: string; perDay: number; symbols: string[]; markets?: "all" }) => {
      queries.push(query);
      return { asOf: `${today}T12:00:00.000Z`, from: query.from, to: query.to, reports: [
        { ...report({ symbol: "NFLX", date: query.from, epsEstimate: 0.82, epsActual: 0.87, dateStatus: "reported" }), averageMove: null, averageReports: 0 },
      ] };
    },
    history: async () => history,
    upcoming: async () => [],
  };
  const board = createEarningsBoardHeadless(deps);
  const [monday, , , , friday] = calendarWeekDates(today, -1);
  const lastWeek = { from: monday!, to: friday! };
  const week = await board.load({ rawArgument: "", argument: null, symbols: [], options: { week: "last" } }, context);
  expect(queries.at(-1)).toEqual({ ...lastWeek, perDay: 200, symbols: [], markets: "all" });
  expect(week.rows[0]).toMatchObject({ symbol: "NFLX", date: lastWeek.from, epsActual: 0.87, dateStatus: "reported" });
  expect(board.describe instanceof Function && board.describe({ rawArgument: "", argument: null, symbols: [], options: { week: "last" } })).toBe("Earnings Calendar | Last week");

  await board.load({ rawArgument: "", argument: null, symbols: [], options: { date: "2026-10-15" } }, context);
  expect(queries.at(-1)).toMatchObject({ from: "2026-10-15", to: "2026-10-15" });
  await expect(board.load({ rawArgument: "", argument: null, symbols: [], options: { date: "2026-10-15", week: "last" } }, context)).rejects.toThrow("--date or --week");

  // ERN takes the same range for the board and a ticker list; one ticker's history already holds its past reports.
  const ern = createEarningsHeadless(deps);
  await ern.load({ rawArgument: "NFLX TSLA", argument: ["NFLX", "TSLA"], symbols: ["NFLX", "TSLA"], options: { week: "last" } }, context);
  expect(queries.at(-1)).toEqual({ ...lastWeek, perDay: 0, symbols: ["NFLX", "TSLA"], markets: "all" });
  await expect(ern.load({ ...args, options: { week: "last" } }, context)).rejects.toThrow("gloom fn EVTS CRWV --week last");
});

test("a Hong Kong half or year never takes the calendar's quarter figures, and no actual comes without its currency", async () => {
  const smic = (fields: Partial<HistoryReport> & Pick<HistoryReport, "date">) =>
    report({ symbol: "0981:HKEX", name: "SMIC", timing: null, timingSource: null, currency: "USD", dateStatus: "reported", ...fields });
  const halfDay = addDays(today, -40);
  const next = addDays(today, 6);
  const payload: EarningsHistoryPayload = {
    asOf: `${today}T12:00:00.000Z`, symbol: "0981:HKEX", name: "SMIC",
    fiscalAnchor: { fiscalPeriod: "2025-12", fiscalYear: 2025, fiscalQuarter: 4 }, consensusBasis: null, access: { pro: true },
    reports: [
      smic({ date: next, fiscalPeriod: "2026-09", fiscalYear: 2026, fiscalQuarter: 3, epsEstimate: 0.05, dateStatus: "confirmed" }),
      // Its interim's revenue alone: no EPS of its own.
      smic({ date: halfDay, fiscalPeriod: "2026-06", periodKind: "half", periodMonths: 6, fiscalYear: 2026, fiscalHalf: 1,
        revenueActual: 5.511e9, revenueActualSource: "filing" }),
    ],
  };
  const event = (date: string, fields: Record<string, unknown>) => ({
    symbol: "0981:HKEX", name: "SMIC", earningsDate: new Date(`${date}T00:00:00Z`), isDateEstimate: false, timing: "",
    epsEstimate: null, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, ...fields,
  });
  const load = async (upcoming: unknown) => (await createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => payload,
    upcoming: async () => [upcoming] as never,
  }).load({ rawArgument: "0981:HKEX", argument: ["0981:HKEX"], symbols: ["0981:HKEX"], options: {} }, context)).rows;
  // The calendar's reported quarter, dated by the half: its 0.06 is a quarter's, not the half's.
  const half = await load(event(addDays(halfDay, 1), {
    dateStatus: "reported", epsActual: 0.06, epsEstimate: 0.035,
    estimateBasis: { epsEstimate: { source: "earningsTrend", sourceValue: 0.035, period: "0q", periodEndDate: "2026-06-30", currency: "USD" } },
  }));
  expect(half.find((row) => row.period === "H1 FY2026")).toMatchObject({ epsActual: null, epsEstimate: null, revenueActual: 5.511e9 });
  // An actual the calendar gives with no currency is not shown under the listing's.
  const bare = await load(event(next, { dateStatus: "reported", epsActual: 0.07 }));
  expect(bare.find((row) => row.date === next)).toMatchObject({ currency: "USD", epsActual: null, epsEstimate: 0.05 });
})

test("a Hong Kong filed EPS that is basic says so instead of GAAP", async () => {
  const payload: EarningsHistoryPayload = {
    asOf: `${today}T12:00:00.000Z`, symbol: "0941:HKEX", name: "China Mobile", access: { pro: true },
    fiscalAnchor: { fiscalPeriod: "2025-12", fiscalYear: 2025, fiscalQuarter: 4 },
    reports: [
      report({ symbol: "0941:HKEX", date: addDays(today, -200), timing: null, timingSource: null, currency: "CNY", dateStatus: "reported",
        fiscalPeriod: "2025-12", periodKind: "year", periodMonths: 12, fiscalYear: 2025, epsActual: 6.6, epsActualSource: "filing",
        epsBasis: null, epsDilution: "basic" }),
    ],
  };
  const rows = (await createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => payload,
    upcoming: async () => [],
  }).load({ rawArgument: "0941:HKEX", argument: ["0941:HKEX"], symbols: ["0941:HKEX"], options: {} }, context)).rows;
  expect(rows.map((row) => [row.period, row.epsActual, row.epsBasis])).toEqual([["FY2025", 6.6, "basic"]]);
})

test("an account without Pro gets a Hong Kong listing's street quarters, named by its fiscal year, with no notice", async () => {
  const next = addDays(today, 12);
  const result = await createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => ({
      asOf: `${today}T12:00:00.000Z`, symbol: "0700:HKEX", name: "Tencent", consensusBasis: "adjusted", access: { pro: false },
      fiscalAnchor: { fiscalPeriod: "2025-12", fiscalYear: 2025, fiscalQuarter: 4 },
      reports: [
        report({ symbol: "0700:HKEX", date: next, timing: null, timingSource: null, currency: "CNY", dateStatus: "confirmed",
          fiscalPeriod: "2026-09", fiscalYear: 2026, fiscalQuarter: 3, epsEstimate: 7.22 }),
        report({ symbol: "0700:HKEX", date: addDays(today, -86), timing: null, timingSource: null, currency: "CNY", dateStatus: "reported",
          fiscalPeriod: "2026-06", fiscalYear: 2026, fiscalQuarter: 2, epsEstimate: 7.23544, epsActual: 7.433, epsBasis: "adjusted" }),
      ],
    }),
    upcoming: async () => [],
  }).load({ rawArgument: "0700:HKEX", argument: ["0700:HKEX"], symbols: ["0700:HKEX"], options: {} }, context);
  expect(result.errors).toBeUndefined();
  expect(result.metadata?.notices).toBeUndefined();
  expect(result.rows.map((row) => [row.period, row.currency, row.epsEstimate, row.epsActual, row.filing])).toEqual([
    ["Q3 FY2026", "CNY", 7.22, null, null],
    ["Q2 FY2026", "CNY", 7.23544, 7.433, null],
  ]);
})

test("ERN reads a half-yearly reporter's own reports and its projected next date, and a Singapore or China A line's history too", async () => {
  const aia = (fields: Partial<HistoryReport> & Pick<HistoryReport, "date">) =>
    report({ symbol: "1299:HKEX", name: "AIA Group Limited", timing: null, timingSource: null, currency: "USD", dateStatus: "reported", ...fields });
  const asked: string[] = [];
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async (symbol) => {
      asked.push(symbol);
      return {
        asOf: `${today}T12:00:00.000Z`, symbol, name: "AIA Group Limited",
        fiscalAnchor: { fiscalPeriod: "2025-12", fiscalYear: 2025, fiscalQuarter: 4 }, consensusBasis: null,
        reports: [
          // No street quarter and no notified date: the day the same report came out a year before, 52 weeks on.
          aia({ date: addDays(today, 126), fiscalPeriod: "2026-12", periodKind: "year", periodMonths: 12, fiscalYear: 2026, currency: null, dateStatus: "projected" }),
          aia({ date: addDays(today, -84), timing: "bmo", timingSource: "filing", fiscalPeriod: "2026-06", periodKind: "half", periodMonths: 6, fiscalYear: 2026, fiscalHalf: 1,
            epsActual: 0.41, epsActualSource: "filing", epsBasis: "gaap", epsDilution: "diluted",
            filing: { url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0820/2026082000001.pdf", title: "Interim Results", publishedAt: "2026-08-19T22:01:00.000Z" } }),
        ],
      };
    },
    upcoming: async () => [],
  });
  const load = (symbol: string) => definition.load({ rawArgument: symbol, argument: [symbol], symbols: [symbol], options: {} }, context);
  const result = await load("1299:HKEX");
  expect(result.empty).toBeUndefined();
  expect(result.rows.map((row) => [row.date, row.dateStatus, row.period, row.currency, row.epsActual, row.timing])).toEqual([
    [addDays(today, 126), "projected", "FY2026", null, null, null],
    [addDays(today, -84), "reported", "H1 FY2026", "USD", 0.41, "BMO"],
  ]);
  expect(result.rows[1]!.filing).toContain("hkexnews.hk");
  // Singapore's and China A's lines ask for their own history, as Hong Kong's do.
  await load("D05:SGX");
  await load("600519:SSE");
  expect(asked).toEqual(["1299:HKEX", "D05:SGX", "600519:SSE"]);
});

test("a surprise against a loss estimate exports null with its NotMeaningful flag, never text; the text report draws N/M", async () => {
  // CoreWeave's quarters: estimates of -1.52 and -1.17 a share. A beat of a loss is no percentage of it.
  const definition = createEarningsHeadless({
    calendar: async () => { throw new Error("unused"); },
    history: async () => history,
    upcoming: async () => [],
  });
  const result = await definition.load(args, context);
  const reported = result.rows.filter((row) => row.dateStatus === "reported");
  expect(reported.map((row) => [row.epsSurprise, row.epsSurpriseNotMeaningful])).toEqual([[null, true], [null, true]]);
  expect(result.rows[0]).not.toHaveProperty("epsSurpriseNotMeaningful");
  const json = serializeHeadlessPaneResult(definition, result) as { rows: Array<Record<string, unknown>> };
  expect(json.rows.filter((row) => row.dateStatus === "reported").map((row) => row.epsSurprise)).toEqual([null, null]);
  const text = renderHeadlessPaneText(definition, result, args, "ERN");
  expect(text.match(/N\/M/g)).toHaveLength(2);
  // CSV's EPS surprise column holds only numbers: the row's status column says why it is empty.
  const csv = renderReportCsv(headlessReportTables(definition, result, args, "ERN", deriveHeadlessFreshness(definition, result), { complete: true, unavailableSymbols: [] }));
  const lines = csv.split("\n");
  const header = lines[0]!.split(",");
  const surprise = header.indexOf("EPS surp (%)");
  expect(surprise).toBeGreaterThan(-1);
  const rows = lines.slice(1).filter((line) => line.includes(",reported,")).map((line) => line.split(","));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row[surprise]).toBe("");
    expect(row.at(-1)).toContain("EPS surp: n/m");
  }
});
