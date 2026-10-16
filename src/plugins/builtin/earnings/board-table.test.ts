import { describe, expect, test } from "bun:test";
import type { EarningsCalendarReport, EarningsHistoryPayload } from "../../../api-client/earnings";
import { colors } from "../../../theme/colors";
import type { Quote } from "../../../types/financials";
import { boardReport, reportMove, type BoardRow } from "./board-model";
import { boardColumns, renderBoardCell, type BoardCellContext, type BoardColumn } from "./board-table";
import { historyRows } from "./history-model";
import { historyColumns, renderHistoryCell } from "./history-table";

const TODAY = "2026-10-16";
const calendarReport = (fields: Partial<EarningsCalendarReport> & Pick<EarningsCalendarReport, "symbol">): EarningsCalendarReport => ({
  name: null, date: TODAY, timing: "bmo", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-09", marketCap: 60e9,
  epsEstimate: null, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null, implied: null, realized: null,
  averageMove: null, averageReports: 0, ...fields,
});
// The Travelers this morning: its press release's core EPS, before the calendar has the quarter.
const TRV = boardReport(calendarReport({
  symbol: "TRV", name: "The Travelers Companies, Inc.", reportedAt: `${TODAY}T10:30:00.000Z`, epsEstimate: 7.07, epsActual: 9.18,
  epsActualSource: "press-release", epsBasis: "adjusted", dateStatus: "reported", implied: { move: 0.033 } as never,
}), new Map());
const PEP = boardReport(calendarReport({ symbol: "PEP", epsEstimate: 2.26, epsActual: 2.29, epsActualSource: "calendar", epsBasis: "adjusted", dateStatus: "reported" }), new Map());
const HDB = boardReport(calendarReport({ symbol: "HDB", timing: null, epsEstimate: 0.39, dateStatus: "projected" }), new Map());
const LADR = boardReport(calendarReport({ symbol: "LADR", timing: "bmo", timingSource: "calendar", epsEstimate: 0.33, dateStatus: "confirmed" }), new Map());

const row = (report: typeof TRV): BoardRow => ({ kind: "report", key: report.key, report, showDay: false });
const column = (id: BoardColumn["id"]) => boardColumns(2000).find((entry) => entry.id === id)!;
const cell = (report: typeof TRV, id: BoardColumn["id"], context?: Partial<BoardCellContext>) =>
  renderBoardCell(row(report), column(id), { statusShown: true, move: () => null, ...context });

describe("EVTS rows", () => {
  test("a reported row shows its EPS and surprise; a press release's EPS reads quieter until the calendar's arrives", () => {
    expect(TRV).toMatchObject({ epsActual: 9.18, provisional: true });
    expect(TRV.epsSurprise).toBeCloseTo(0.2984, 4);
    expect(cell(TRV, "epsActual")).toEqual({ text: "9.18", color: colors.textMuted });
    expect(cell(PEP, "epsActual")).toEqual({ text: "2.29", color: colors.text });
    expect(cell(TRV, "epsSurprise")).toEqual({ text: "+29.8%", color: colors.positive });
    expect(cell(TRV, "basis")).toEqual({ text: "adj", color: colors.textMuted });
  });

  test("EPS ACT, EPS SURP and BASIS show -- with nothing to show, as ERN does", () => {
    for (const id of ["epsActual", "epsSurprise", "basis"] as const) expect(cell(LADR, id)).toEqual({ text: "--", color: colors.textDim });
  });

  test("MOVE is the move on a report out today, beside the implied move", () => {
    expect(cell(TRV, "move", { move: () => 0.0123 })).toEqual({ text: "+1.2%", color: colors.positive });
    expect(cell(TRV, "move", { move: () => "loading" })).toEqual({ text: "…", color: colors.textDim });
    expect(cell(LADR, "move")).toEqual({ text: "--", color: colors.textDim });
    const ids = boardColumns(2000).map((entry) => entry.id);
    expect(ids.slice(ids.indexOf("implied"), ids.indexOf("implied") + 3)).toEqual(["implied", "move", "average"]);
  });

  test("narrow, without STATUS, WHEN checks a report that is out and quiets a projected date", () => {
    const narrow = boardColumns(88).map((entry) => entry.id);
    expect(narrow).not.toContain("status");
    // The move on the report stays beside the implied move and its average.
    expect(narrow).toEqual(expect.arrayContaining(["implied", "move", "average"]));
    expect(cell(TRV, "when", { statusShown: false })).toEqual({ text: "BMO ✓", color: colors.textDim });
    expect(cell(HDB, "when", { statusShown: false })).toEqual({ text: "--", color: colors.textMuted });
    expect(cell(LADR, "when", { statusShown: false })).toEqual({ text: "BMO", color: colors.textDim });
    // With STATUS on screen WHEN is the time alone.
    expect(cell(TRV, "when")).toEqual({ text: "BMO", color: colors.textDim });
    expect(cell(HDB, "when")).toEqual({ text: "--", color: colors.textDim });
  });
});

describe("the move on a report", () => {
  const quote = (fields: Partial<Quote>): Quote => ({
    symbol: "TRV", exchangeName: "NYSE", price: 300, currency: "USD", change: 6, changePercent: 2, previousClose: 294,
    lastUpdated: Date.parse(`${TODAY}T15:00:00Z`),
    ...fields,
  } as Quote);

  test("out before the open: the pre-market's print, then the session's move", () => {
    expect(reportMove(TRV, quote({ marketState: "REGULAR" }), TODAY)).toBeCloseTo(0.02, 6);
    expect(reportMove(TRV, quote({
      marketState: "PRE", price: 294, change: 1, changePercent: 0.34, preMarketPrice: 300, preMarketChange: 6, preMarketChangePercent: 2.04,
      regularClose: 294, regularCloseSessionDate: "2026-10-15", regularChange: 1, regularChangePercent: 0.34, extendedSessionPrint: true,
      lastUpdated: Date.parse(`${TODAY}T12:00:00Z`),
    }), TODAY)).toBeCloseTo(6 / 294, 6);
  });

  test("out after the close: the after-hours print from the close, nothing before one", () => {
    const amc = { ...TRV, timing: "amc" as const };
    const closed = { marketState: "POST" as const, price: 300, regularClose: 300, regularCloseSessionDate: TODAY, regularChange: 6, regularChangePercent: 2.04 };
    expect(reportMove(amc, quote({ ...closed, postMarketPrice: 315, postMarketChange: 15, postMarketChangePercent: 5 }), TODAY)).toBeCloseTo(0.05, 6);
    expect(reportMove(amc, quote(closed), TODAY)).toBeNull();
  });

  test("none before the report, on another day, or without a quote", () => {
    expect(reportMove(LADR, quote({ marketState: "REGULAR" }), TODAY)).toBeNull();
    expect(reportMove(TRV, quote({ marketState: "REGULAR" }), "2026-10-19")).toBeNull();
    expect(reportMove(TRV, null, TODAY)).toBeNull();
  });
});

describe("ERN rows", () => {
  type Report = EarningsHistoryPayload["reports"][number];
  const report = (fields: Partial<Report> & Pick<Report, "date">): Report => ({
    symbol: "TFC", name: "Truist Financial Corporation", timing: "bmo", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-09",
    marketCap: null, epsEstimate: 1.17, epsActual: null, epsAnalysts: null, revenueEstimate: 5.36e9, revenueAnalysts: null,
    implied: null, realized: null, revenueActual: null, ...fields,
  });
  const rows = historyRows({ asOf: `${TODAY}T15:00:00Z`, symbol: "TFC", name: null, reports: [
    report({ date: TODAY, epsActual: 1.16, epsActualSource: "press-release", epsBasis: "adjusted", dateStatus: "reported",
      revenueActual: 5.31e9, revenueActualSource: "press-release" }),
    report({ date: "2026-07-17", fiscalPeriod: "2026-06", epsEstimate: 1.21, epsActual: 1.23, epsActualSource: "calendar",
      epsBasis: "adjusted", dateStatus: "reported", revenueActual: 5.27e9, revenueActualSource: "statements" }),
  ] }, TODAY, null);
  const columns = historyColumns(2000, rows);
  const draw = (index: number, id: string) => renderHistoryCell(rows[index]!, columns.find((entry) => entry.id === id)!);

  test("mark the press release's EPS and sales quieter, as EVTS does", () => {
    expect(draw(0, "epsActual")).toEqual({ text: "1.16", color: colors.textMuted });
    expect(draw(0, "revenueActual")).toEqual({ text: "5.31B", color: colors.textMuted });
    expect(draw(1, "epsActual")).toEqual({ text: "1.23", color: colors.text });
    expect(draw(1, "revenueActual")).toEqual({ text: "5.27B", color: colors.text });
  });

  test("a report out today shows its move so far, as EVTS does, until the first close after settles it", () => {
    const move = columns.find((entry) => entry.id === "move")!;
    const ratio = columns.find((entry) => entry.id === "ratio")!;
    expect(renderHistoryCell(rows[0]!, move, () => 0.017)).toEqual({ text: "+1.7%", color: colors.positive });
    expect(renderHistoryCell(rows[0]!, move, () => "loading")).toEqual({ text: "…", color: colors.textDim });
    // The ratio waits for the settled move.
    expect(renderHistoryCell(rows[0]!, ratio, () => 0.017)).toEqual({ text: "--", color: colors.textDim });
    // A settled move is the row's own, whatever the quote says.
    const settled = { ...rows[0]!, move: -0.021 };
    expect(renderHistoryCell(settled, move, () => 0.017)).toEqual({ text: "-2.1%", color: colors.negative });
  });
});
