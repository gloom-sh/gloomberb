import { describe, expect, test } from "bun:test";
import type { EarningsCalendarReport, EarningsHistoryPayload } from "../../../api-client/earnings";
import { colors } from "../../../theme/colors";
import { notMeaningfulColor } from "../../../components/ui/not-meaningful";
import type { Quote } from "../../../types/financials";
import { boardReport, boardRowOf, reportMove, type BoardRow } from "./board-model";
import { boardColumns, boardHasActuals, boardHasCurrencies, boardSymbolWidth, renderBoardCell, type BoardCellContext, type BoardColumn } from "./board-table";
import { historyFigures, historyRows } from "./history-model";
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

describe("EVTS when narrow", () => {
  const ids = (width: number, actuals?: boolean) => boardColumns(width, { actuals }).map((entry) => entry.id);
  // The board's width at 720px, where the dropped columns used to hide the actuals.
  const NARROW = 88;

  test("with no actual on the board, keeps today's order and spends no space on empty actual columns", () => {
    expect(boardHasActuals([row(LADR), row(HDB), { kind: "section", key: "today", label: "Today" } as BoardRow])).toBe(false);
    expect(ids(NARROW)).toEqual(["owned", "symbol", "name", "when", "implied", "move", "average", "epsEstimate", "revenueEstimate"]);
    for (let width = 50; width <= 160; width += 1) expect(ids(width, false)).toEqual(ids(width));
  });

  test("with an actual on the board, EPS ACT and then EPS SURP outrank SALES EST, MKT CAP and AVG MOVE", () => {
    expect(boardHasActuals([row(LADR), row(TRV)])).toBe(true);
    expect(ids(NARROW, true)).toEqual(["owned", "symbol", "name", "when", "implied", "move", "epsEstimate", "epsActual", "epsSurprise"]);
    for (let width = 50; width <= 160; width += 1) {
      const shown = new Set(ids(width, true));
      const context = ["revenueEstimate", "cap", "average"].filter((id) => shown.has(id as BoardColumn["id"]));
      if (context.length > 0) expect([width, shown.has("epsActual"), shown.has("epsSurprise")]).toEqual([width, true, true]);
      if (shown.has("epsSurprise")) expect([width, shown.has("epsActual")]).toEqual([width, true]);
      // The implied move and the move on the report never go.
      expect([width, shown.has("implied"), shown.has("move")]).toEqual([width, true, true]);
    }
    // Wide enough, every column shows either way.
    expect(ids(2000, true)).toEqual(ids(2000));
  });
});

describe("EVTS with listings abroad", () => {
  // Tencent's confirmed Q3 as the board serves it: its figures in CNY, its value in dollars, no time of day.
  const TENCENT = boardReport(calendarReport({
    symbol: "0700:HKEX", name: "Tencent Holdings Limited", date: "2026-11-18", timing: null, timingSource: null, marketCap: 459.65e9,
    epsEstimate: 7.21, epsAnalysts: 12, revenueEstimate: 210.24e9, dateStatus: "confirmed", currency: "CNY", listings: ["0700:HKEX"],
  }), new Map());
  // Alibaba the day it reports as BABA and as 9988:HKEX: the board's BABA row carries the listing's lines.
  const BABA = boardReport(calendarReport({ symbol: "BABA", epsEstimate: 2.12, listings: ["9988:HKEX"] }), new Map());
  const CCB = boardReport(calendarReport({ symbol: "601939:SSE", currency: "CNY", listings: ["601939:SSE", "0939:HKEX"] }), new Map());
  const ids = (width: number, currencies: boolean, actuals = false) =>
    boardColumns(width, { currencies, actuals }).map((entry) => entry.id);

  test("a board with a report in another currency shows CCY before the figures it is the currency of, and says its cap is in dollars", () => {
    expect(boardHasCurrencies([row(LADR), row(BABA)])).toBe(false);
    expect(boardHasCurrencies([row(LADR), row(TENCENT)])).toBe(true);
    const wide = boardColumns(2000, { currencies: true });
    const at = wide.map((entry) => entry.id);
    expect(at.slice(at.indexOf("ccy"), at.indexOf("ccy") + 2)).toEqual(["ccy", "epsEstimate"]);
    expect(wide.find((entry) => entry.id === "cap")).toMatchObject({ label: "MKT CAP $", width: 9 });
    // A board of US reports looks as it always has.
    expect(ids(2000, false)).not.toContain("ccy");
    expect(boardColumns(2000).find((entry) => entry.id === "cap")).toMatchObject({ label: "MKT CAP", width: 8 });
    const ccy = wide.find((entry) => entry.id === "ccy")!;
    const context: BoardCellContext = { statusShown: true, move: () => null };
    expect(renderBoardCell(row(TENCENT), ccy, context)).toEqual({ text: "CNY", color: colors.textDim });
    expect(renderBoardCell(row(LADR), ccy, context)).toEqual({ text: "USD", color: colors.textDim });
    expect(cell(TENCENT, "cap")).toEqual({ text: "459.65B", color: colors.textDim });
    expect(cell(TENCENT, "when")).toEqual({ text: "--", color: colors.textDim });
  });

  test("TICKER fits the longest listing abroad's key on the board, a US board's stays as it was", () => {
    expect(boardSymbolWidth([row(LADR), row(TENCENT)])).toBe(9);
    expect(boardSymbolWidth([row(LADR), row(CCB)])).toBe(10);
    expect(boardSymbolWidth([row(LADR), row(BABA)])).toBe(6);
    expect(boardColumns(2000, { symbolWidth: 10 }).find((entry) => entry.id === "symbol")?.width).toBe(10);
  });

  test("narrow, CCY stays while any EPS or sales figure does, and goes with the last", () => {
    for (const actuals of [false, true]) {
      for (let width = 40; width <= 200; width += 1) {
        const shown = new Set(ids(width, true, actuals));
        const figures = (["epsEstimate", "epsActual", "revenueEstimate"] as const).some((id) => shown.has(id));
        expect([width, actuals, shown.has("ccy")]).toEqual([width, actuals, figures]);
      }
    }
  });

  test("a listing is found as typed, by another of its company's lines, or as the US line shown for it; a US ticker only as itself", () => {
    expect(boardRowOf(TENCENT, "0700.HK")).toBe(true);
    expect(boardRowOf(TENCENT, "700:HKEX")).toBe(true);
    expect(boardRowOf(CCB, "0939.HK")).toBe(true);
    expect(boardRowOf(BABA, "9988.HK")).toBe(true);
    expect(boardRowOf(BABA, "BABA")).toBe(true);
    expect(boardRowOf(TENCENT, "TCEHY")).toBe(false);
    expect(boardRowOf(LADR, "0700.HK")).toBe(false);
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

describe("surprises against a loss or zero estimate", () => {
  type Report = EarningsHistoryPayload["reports"][number];
  const report = (fields: Partial<Report> & Pick<Report, "date">): Report => ({
    symbol: "CRWV", name: "CoreWeave", timing: "amc", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-06",
    marketCap: null, epsEstimate: null, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
    implied: null, realized: null, revenueActual: null, dateStatus: "reported", ...fields,
  });

  test("read N/M in EVTS and ERN, in N/M's colour as every pane draws it, and still count a narrower loss as a beat", () => {
    const loss = boardReport(calendarReport({ symbol: "CRWV", epsEstimate: -1.47, epsActual: -1.14, epsActualSource: "calendar", dateStatus: "reported" }), new Map());
    expect(loss.epsSurprise).toBe("not-meaningful");
    expect(cell(loss, "epsSurprise")).toEqual({ text: "N/M", color: notMeaningfulColor() });
    expect(cell(PEP, "epsSurprise").text).toBe("+1.3%");
    const rows = historyRows({ asOf: `${TODAY}T15:00:00Z`, symbol: "CRWV", name: null, reports: [
      report({ date: "2026-08-11", epsEstimate: -1.47, epsActual: -1.14, revenueEstimate: 0, revenueActual: 2.1e9 }),
      report({ date: "2026-05-07", fiscalPeriod: "2026-03", epsEstimate: -1.17, epsActual: -1.38, revenueEstimate: 1.9e9, revenueActual: 2e9 }),
      report({ date: "2026-02-26", fiscalPeriod: "2025-12", epsEstimate: 0.2, epsActual: 0.25 }),
      report({ date: "2025-11-10", fiscalPeriod: "2025-09", epsEstimate: 0.3, epsActual: 0.25 }),
    ] }, TODAY, null);
    const columns = historyColumns(2000, rows);
    const draw = (index: number, id: string) => renderHistoryCell(rows[index]!, columns.find((entry) => entry.id === id)!);
    expect(draw(0, "epsSurprise")).toEqual({ text: "N/M", color: notMeaningfulColor() });
    // Sales against a zero estimate: N/M too.
    expect(draw(0, "revenueSurprise")).toEqual({ text: "N/M", color: notMeaningfulColor() });
    expect(draw(1, "revenueSurprise").text).toBe("+5.3%");
    expect(draw(2, "epsSurprise")).toEqual({ text: "+25.0%", color: colors.positive });
    // Two of four beat: the narrower loss and the profit above its estimate.
    expect(historyFigures(rows, TODAY).find((figure) => figure.id === "beats")?.value).toBe("2 of 4");
  });
});

describe("ERN for a Hong Kong listing", () => {
  type Report = EarningsHistoryPayload["reports"][number];
  const quarter = (fields: Partial<Report> & Pick<Report, "date">): Report => ({
    symbol: "0700:HKEX", name: "Tencent", timing: null, timingSource: null, reportedAt: null, fiscalPeriod: "2026-06",
    marketCap: null, epsEstimate: 7.23544, epsActual: 7.433, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
    implied: null, realized: null, revenueActual: null, currency: "CNY", dateStatus: "reported", fiscalYear: 2026, fiscalQuarter: 2, ...fields,
  });
  const payload = (reports: Report[]): EarningsHistoryPayload => ({
    asOf: `${TODAY}T15:00:00Z`, symbol: "0700:HKEX", name: "Tencent",
    fiscalAnchor: { fiscalPeriod: "2025-12", fiscalYear: 2025, fiscalQuarter: 4 }, reports,
  });

  test("names its period column PERIOD whether its rows are quarters only or hold a half, and a US listing's stays QTR", () => {
    const label = (reports: Report[], abroad: boolean) =>
      historyColumns(2000, historyRows(payload(reports), TODAY, null, { abroad }), { abroad }).find((column) => column.id === "period")?.label;
    const quarters = [quarter({ date: "2026-08-12" })];
    const withHalf = [...quarters, quarter({ date: "2026-08-13", periodKind: "half", periodMonths: 6, fiscalQuarter: null, fiscalHalf: 1,
      epsEstimate: null, epsActual: 12.1, epsActualSource: "filing" })];
    expect([label(quarters, true), label(withHalf, true)]).toEqual(["PERIOD", "PERIOD"]);
    expect(label([quarter({ date: "2026-08-12", currency: undefined })], false)).toBe("QTR");
  });

  test("names the calendar's next quarter by its fiscal year from the company's year end, as its past quarters are", () => {
    const rows = historyRows(payload([quarter({ date: "2026-08-12" })]), TODAY, {
      symbol: "0700:HKEX", name: "Tencent", earningsDate: new Date("2026-11-18T08:10:00Z"), isDateEstimate: false, timing: "",
      epsEstimate: 7.22, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null,
      estimateBasis: { epsEstimate: { source: "earningsTrend", sourceValue: 7.22, period: "0q", periodEndDate: "2026-09-30", currency: "CNY" } },
    }, { abroad: true });
    const columns = historyColumns(2000, rows, { abroad: true });
    const period = columns.find((column) => column.id === "period")!;
    expect(rows.map((row) => renderHistoryCell(row, period).text)).toEqual(["Q3 FY26", "Q2 FY26"]);
  });
});
