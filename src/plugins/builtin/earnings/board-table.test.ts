import { MISSING_VALUE } from "../../../utils/format";
import { describe, expect, test } from "bun:test";
import type { EarningsCalendarReport, EarningsHistoryPayload } from "../../../api-client/earnings";
import { colors } from "../../../theme/colors";
import { notMeaningfulColor } from "../../../components/ui/not-meaningful";
import type { Quote } from "../../../types/financials";
import { boardReport, boardRowOf, newYorkToday, reportMove, type BoardRow } from "./board-model";
import { boardColumns, boardHasCurrencies, boardSymbolWidth, renderBoardCell, type BoardCellContext, type BoardColumn } from "./board-table";
import { historyFigures, historyRows } from "./history-model";

test("the next-report figure retains a rounded consensus independently of dropped narrow table columns", () => {
  const rows = historyRows({ asOf: `${TODAY}T15:00:00Z`, symbol: "CRWV", name: null, reports: [
    { ...calendarReport({ symbol: "CRWV", date: "2026-11-18", fiscalPeriod: "2026-10", epsEstimate: 1.6374, dateStatus: "confirmed" }), revenueActual: null },
  ] }, "2026-11-15", null);
  const next = historyFigures(rows, "2026-11-15").find((figure) => figure.id === "next")!;
  expect(next.detail).toStartWith("EPS est 1.64");
  expect(next.detailVariants).toEqual(["EPS est 1.64"]);
});
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
const column = (id: BoardColumn["id"]) => [...boardColumns(2000, { kind: "reported" }), ...boardColumns(2000)].find((entry) => entry.id === id)!;
const cell = (report: typeof TRV, id: BoardColumn["id"], context?: Partial<BoardCellContext>) =>
  renderBoardCell(row(report), column(id), { statusShown: true, move: () => null, ...context });

describe("EVTS rows", () => {
  test("a reported row shows its EPS and surprise; a press release's EPS reads quieter until the calendar's arrives", () => {
    expect(TRV).toMatchObject({ epsActual: 9.18, provisional: true });
    expect(TRV.epsSurprise).toBeCloseTo(0.2984, 4);
    expect(cell(TRV, "epsActual")).toEqual({ text: "9.18", value: 9.18, color: colors.textMuted });
    expect(cell(PEP, "epsActual")).toEqual({ text: "2.29", value: 2.29, color: colors.text });
    expect(cell(TRV, "epsSurprise")).toEqual({ text: "+29.8%", color: colors.positive });
    expect(cell(TRV, "basis")).toEqual({ text: "adj", color: colors.textMuted });
  });

  test("a report out with no actual yet says pending, and keeps EPS ACT on a narrow board", () => {
    // Disney this morning: out before the open, the calendar's figure due tomorrow, its release unproven.
    const today = newYorkToday();
    const DIS = boardReport(calendarReport({ symbol: "DIS", date: today, reportedAt: `${today}T10:45:00.000Z`, epsEstimate: 1.06, epsAnalysts: 17, dateStatus: "reported" }), new Map());
    expect(cell(DIS, "epsActual")).toEqual({ text: "pending", color: colors.textDim });
    expect(boardColumns(88, { kind: "reported" }).map((entry) => entry.id)).toContain("epsActual");
    // A listing abroad's figures come from its own documents, with Gloom Pro: one out without them is waiting on nothing.
    const FN = boardReport(calendarReport({ symbol: "F99:SGX", currency: "SGD", dateStatus: "reported" }), new Map());
    expect(cell(FN, "epsActual").text).toBe(MISSING_VALUE);
    // Past the week the calendar reads a date for, none is coming: the dash again.
    const OLD = boardReport(calendarReport({ symbol: "OXY", date: "2026-10-01", dateStatus: "reported" }), new Map());
    expect(cell(OLD, "epsActual").text).toBe(MISSING_VALUE);
  });

  test("MOVE is the move on a report out today, beside the implied move", () => {
    expect(cell(TRV, "move", { move: () => 0.0123 })).toEqual({ text: "+1.2%", color: colors.positive });
    expect(cell(TRV, "move", { move: () => "loading" })).toEqual({ text: "…", color: colors.textDim });
    expect(cell(LADR, "move")).toEqual({ text: MISSING_VALUE, color: colors.textDim });
    const ids = boardColumns(2000, { kind: "reported" }).map((entry) => entry.id);
    expect(ids.slice(ids.indexOf("implied"), ids.indexOf("implied") + 3)).toEqual(["implied", "move", "average"]);
  });

  test("narrow, without STATUS, WHEN quiets a projected date", () => {
    expect(boardColumns(88).map((entry) => entry.id)).not.toContain("status");
    expect(cell(HDB, "when", { statusShown: false })).toEqual({ text: MISSING_VALUE, color: colors.textMuted });
    expect(cell(LADR, "when", { statusShown: false })).toEqual({ text: "BMO", color: colors.textDim });
    // With STATUS on screen WHEN is the time alone.
    expect(cell(TRV, "when")).toEqual({ text: "BMO", color: colors.textDim });
    expect(cell(HDB, "when")).toEqual({ text: MISSING_VALUE, color: colors.textDim });
  });
});

describe("EVTS when narrow", () => {
  const ids = (width: number, kind: "upcoming" | "reported" = "upcoming") => boardColumns(width, { kind }).map((entry) => entry.id);
  // The board's width at 720px.
  const NARROW = 88;

  test("reports to come spend no space on an actual, a surprise or a move none of them has yet", () => {
    expect(ids(2000)).toEqual(["owned", "symbol", "name", "when", "status", "implied", "average", "epsEstimate", "analysts", "revenueEstimate", "cap"]);
    expect(ids(NARROW)).toEqual(["owned", "symbol", "name", "when", "implied", "average", "epsEstimate", "revenueEstimate", "cap"]);
  });

  test("reports out: EPS ACT and then EPS SURP outrank SALES EST, MKT CAP and AVG MOVE, and no STATUS or ESTS says what is past", () => {
    expect(ids(2000, "reported")).not.toContain("status");
    expect(ids(2000, "reported")).not.toContain("analysts");
    expect(ids(NARROW, "reported")).toEqual(["owned", "symbol", "name", "when", "implied", "move", "epsEstimate", "epsActual", "epsSurprise"]);
    for (let width = 50; width <= 160; width += 1) {
      const shown = new Set(ids(width, "reported"));
      const context = ["revenueEstimate", "cap", "average"].filter((id) => shown.has(id as BoardColumn["id"]));
      if (context.length > 0) expect([width, shown.has("epsActual"), shown.has("epsSurprise")]).toEqual([width, true, true]);
      if (shown.has("epsSurprise")) expect([width, shown.has("epsActual")]).toEqual([width, true]);
      // The implied move and the move on the report never go.
      expect([width, shown.has("implied"), shown.has("move")]).toEqual([width, true, true]);
    }
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
  test("a report in another currency writes its code after each figure, a dollar one bare, and no column says USD down the board", () => {
    expect(boardHasCurrencies([row(LADR), row(BABA)])).toBe(false);
    expect(boardHasCurrencies([row(LADR), row(TENCENT)])).toBe(true);
    const wide = boardColumns(2000, { currencies: true });
    expect(wide.map((entry) => entry.label)).not.toContain("CCY");
    expect(wide.find((entry) => entry.id === "cap")).toMatchObject({ label: "MKT CAP $", width: 9 });
    // The figures take the room for " CNY".
    expect(wide.find((entry) => entry.id === "epsEstimate")?.width).toBe(11);
    // A board of US reports looks as it always has.
    expect(boardColumns(2000).find((entry) => entry.id === "cap")).toMatchObject({ label: "MKT CAP", width: 8 });
    expect(boardColumns(2000).find((entry) => entry.id === "epsEstimate")?.width).toBe(7);
    const context: BoardCellContext = { statusShown: true, move: () => null };
    const column = (id: string) => wide.find((entry) => entry.id === id)!;
    expect(renderBoardCell(row(TENCENT), column("epsEstimate"), context)).toEqual({ text: "7.21 CNY", value: 7.21, color: colors.textDim });
    expect(renderBoardCell(row(TENCENT), column("revenueEstimate"), context).text).toBe("210.24B CNY");
    expect(renderBoardCell(row(LADR), column("epsEstimate"), context).text).not.toContain("USD");
    expect(cell(TENCENT, "cap")).toEqual({ text: "459.65B", color: colors.textDim });
    expect(cell(TENCENT, "when")).toEqual({ text: MISSING_VALUE, color: colors.textDim });
  });

  test("TICKER fits the longest listing abroad's key on the board, a US board's stays as it was", () => {
    expect(boardSymbolWidth([row(LADR), row(TENCENT)])).toBe(9);
    expect(boardSymbolWidth([row(LADR), row(CCB)])).toBe(10);
    expect(boardSymbolWidth([row(LADR), row(BABA)])).toBe(6);
    expect(boardColumns(2000, { symbolWidth: 10 }).find((entry) => entry.id === "symbol")?.width).toBe(10);
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

  test("BASIS waits for reported EPS, and a reported basis survives beside pending rows", () => {
    const pending = historyRows({ asOf: `${TODAY}T15:00:00Z`, symbol: "TFC", name: null,
      reports: [report({ date: "2027-01-15", dateStatus: "projected" })] }, TODAY, null);
    expect(historyColumns(2000, pending).some((column) => column.id === "basis")).toBe(false);
    const mixed = [...pending, ...rows];
    const basis = historyColumns(2000, mixed).find((column) => column.id === "basis")!;
    expect(basis.mayBeBlank).toBe(true);
    expect(mixed.map((row) => renderHistoryCell(row, basis).text)).toEqual([MISSING_VALUE, "adj", "?"]);
  });

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
    expect(renderHistoryCell(rows[0]!, ratio, () => 0.017)).toEqual({ text: MISSING_VALUE, color: colors.textDim });
    // A settled move is the row's own, whatever the quote says.
    const settled = { ...rows[0]!, move: -0.021 };
    expect(renderHistoryCell(settled, move, () => 0.017)).toEqual({ text: "-2.1%", color: colors.negative });
  });
});

describe("ERN for a US listing that reports in another currency", () => {
  type Report = EarningsHistoryPayload["reports"][number];
  const report = (fields: Partial<Report> & Pick<Report, "date">): Report => ({
    symbol: "BIDU", name: "Baidu, Inc.", timing: null, timingSource: "calendar", reportedAt: null, fiscalPeriod: "2026-09",
    marketCap: 24e9, epsEstimate: 2.04, epsActual: 2.11, epsActualSource: "calendar", epsAnalysts: 2, revenueEstimate: null,
    revenueAnalysts: null, implied: null, realized: null, revenueActual: null, dateStatus: "reported", ...fields,
  });
  const rows = historyRows({ asOf: "2026-11-19T03:00:00Z", symbol: "BIDU", name: null, reports: [
    report({ date: "2026-11-16", reportedRevenue: { amount: 30.807e9, currency: "CNY", source: "press-release" } }),
    report({ date: "2026-08-20", fiscalPeriod: "2026-06", reportedRevenue: { amount: 31.325e9, currency: "CNY", source: "statements" } }),
    // Dollars are served as revenueActual, never through the company's own currency.
    report({ date: "2026-05-18", fiscalPeriod: "2026-03", reportedRevenue: { amount: 4.4e9, currency: "USD", source: "statements" } }),
  ] }, "2026-11-19", null);
  const columns = historyColumns(2000, rows);
  const sales = columns.find((entry) => entry.id === "revenueActual")!;

  test("its sales in that currency, labelled; its EPS in dollars stays bare", () => {
    expect(rows.map((row) => [row.revenueActual, row.revenueCurrency, row.revenueSurprise])).toEqual([
      [30.807e9, "CNY", null],
      [31.325e9, "CNY", null],
      [null, null, null],
    ]);
    expect(rows.map((row) => renderHistoryCell(row, sales).text)).toEqual(["30.81B CNY", "31.32B CNY", MISSING_VALUE]);
    expect(renderHistoryCell(rows[0]!, sales).color).toBe(colors.textMuted);
    expect(renderHistoryCell(rows[0]!, columns.find((entry) => entry.id === "epsActual")!).text).toBe("2.11");
    // SALES ACT, nine wide, takes the currency after each figure.
    expect(sales.width).toBe(9 + 4);
  });
});

describe("surprises against a loss or zero estimate", () => {
  type Report = EarningsHistoryPayload["reports"][number];
  const report = (fields: Partial<Report> & Pick<Report, "date">): Report => ({
    symbol: "CRWV", name: "CoreWeave", timing: "amc", timingSource: "filing", reportedAt: null, fiscalPeriod: "2026-06",
    marketCap: null, epsEstimate: null, epsActual: null, epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null,
    implied: null, realized: null, revenueActual: null, dateStatus: "reported", epsBasis: "gaap", epsActualSource: "press-release", ...fields,
  });

  test("read N/M in EVTS and ERN, in N/M's colour as every pane draws it, and still count a narrower loss as a beat", () => {
    const loss = boardReport(calendarReport({ symbol: "CRWV", epsEstimate: -1.47, epsActual: -1.14, epsActualSource: "press-release", dateStatus: "reported", epsBasis: "gaap" }), new Map());
    expect(loss.epsSurprise).toBe("not-meaningful");
    expect(cell(loss, "epsSurprise")).toEqual({ text: "N/M", color: notMeaningfulColor() });
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

  test("leaves out a column blank in every row: WHEN where the exchange gave no time, ESTS where no count is served", () => {
    const ids = (reports: Report[]) =>
      historyColumns(2000, historyRows(payload(reports), TODAY, null, { abroad: true }), { abroad: true }).map((column) => column.id);
    const untimed = [quarter({ date: "2026-08-12" }), quarter({ date: "2026-05-13", fiscalPeriod: "2026-03", fiscalQuarter: 1 })];
    expect(ids(untimed)).not.toContain("when");
    expect(ids(untimed)).not.toContain("analysts");
    expect(ids(untimed)).toContain("epsEstimate");
    // One row with a time, or a count of estimates, keeps the column.
    const timed = [quarter({ date: "2026-08-12", timing: "amc", timingSource: "filing", epsAnalysts: 12 }), untimed[1]!];
    expect(ids(timed)).toContain("when");
    expect(ids(timed)).toContain("analysts");
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
