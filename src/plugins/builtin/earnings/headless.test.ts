import { expect, test } from "bun:test";
import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { addDays, newYorkToday } from "./board-model";
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
