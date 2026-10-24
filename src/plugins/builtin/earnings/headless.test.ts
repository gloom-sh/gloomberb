import { expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { addDays, newYorkToday } from "./board-model";
import { calendarWeekDates } from "./calendar-model";
import { createEarningsBoardHeadless, createEarningsHeadless } from "./headless";

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
  expect(await highlight("SAN")).toEqual({ symbol: "SAN", onBoard: true, date: day });
  // Sanofi in Paris is not the US board's SAN.
  expect(await highlight("SAN:EPA")).toEqual({ symbol: "SAN:EPA", onBoard: false, date: null });
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
    "Past reports, surprises and implied moves cover US listings only, so SAN:EPA shows its next report. Sanofi's US listing is SNY: ERN SNY has them.",
  ]);
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
  const queries: { from: string; to: string; perDay: number; symbols: string[] }[] = [];
  const deps = {
    calendar: async (query: { from: string; to: string; perDay: number; symbols: string[] }) => {
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
  expect(queries.at(-1)).toEqual({ ...lastWeek, perDay: 200, symbols: [] });
  expect(week.rows[0]).toMatchObject({ symbol: "NFLX", date: lastWeek.from, epsActual: 0.87, dateStatus: "reported" });
  expect(board.describe instanceof Function && board.describe({ rawArgument: "", argument: null, symbols: [], options: { week: "last" } })).toBe("Earnings Calendar | Last week");

  await board.load({ rawArgument: "", argument: null, symbols: [], options: { date: "2026-10-15" } }, context);
  expect(queries.at(-1)).toMatchObject({ from: "2026-10-15", to: "2026-10-15" });
  await expect(board.load({ rawArgument: "", argument: null, symbols: [], options: { date: "2026-10-15", week: "last" } }, context)).rejects.toThrow("--date or --week");

  // ERN takes the same range for the board and a ticker list; one ticker's history already holds its past reports.
  const ern = createEarningsHeadless(deps);
  await ern.load({ rawArgument: "NFLX TSLA", argument: ["NFLX", "TSLA"], symbols: ["NFLX", "TSLA"], options: { week: "last" } }, context);
  expect(queries.at(-1)).toEqual({ ...lastWeek, perDay: 0, symbols: ["NFLX", "TSLA"] });
  await expect(ern.load({ ...args, options: { week: "last" } }, context)).rejects.toThrow("gloom fn EVTS CRWV --week last");
});
