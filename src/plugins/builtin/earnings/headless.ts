import type { EarningsCalendarPayload, EarningsHistoryPayload } from "../../../api-client/earnings";
import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import type { EarningsEvent } from "../../../types/data-provider";
import { addDays, boardReport, fallbackReport, marketDays, MIN_AVERAGE_REPORTS, newYorkToday } from "./board-model";
import { fetchEarningsCalendar, fetchEarningsHistory } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { epsText, impliedText, moneyText, moveSize, signedPercent, TIMING_LABEL } from "./format";
import { historyRows } from "./history-model";

const right = "right" as const;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const BOARD_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "timing", header: "When" },
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "marketCap", header: "Mkt cap", align: right, format: (value) => moneyText(num(value)) },
  { key: "epsEstimate", header: "EPS est", align: right, format: (value) => epsText(num(value)) },
  { key: "epsActual", header: "EPS act", align: right, format: (value) => epsText(num(value)) },
  { key: "revenueEstimate", header: "Sales est", align: right, format: (value) => moneyText(num(value)) },
  { key: "impliedMove", header: "Implied", align: right, format: (value) => impliedText(num(value)) },
  { key: "averageMove", header: "Avg move", align: right, format: (value) => moveSize(num(value)) },
];

const HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "timing", header: "When" },
  { key: "fiscalPeriod", header: "Quarter" },
  { key: "epsEstimate", header: "EPS est", align: right, format: (value) => epsText(num(value)) },
  { key: "epsActual", header: "EPS act", align: right, format: (value) => epsText(num(value)) },
  { key: "epsSurprise", header: "EPS surp", align: right, format: (value) => signedPercent(num(value)) },
  { key: "revenueEstimate", header: "Sales est", align: right, format: (value) => moneyText(num(value)) },
  { key: "revenueActual", header: "Sales act", align: right, format: (value) => moneyText(num(value)) },
  { key: "revenueSurprise", header: "Sales surp", align: right, format: (value) => signedPercent(num(value)) },
  { key: "impliedMove", header: "Implied", align: right, format: (value) => impliedText(num(value)) },
  { key: "impliedFrom", header: "Implied from" },
  { key: "move", header: "Move", align: right, format: (value) => signedPercent(num(value)) },
];

interface EarningsHeadlessDependencies {
  calendar(query: { from: string; to: string; perDay: number; symbols: string[] }, context: HeadlessPaneContext): Promise<EarningsCalendarPayload>;
  history(symbol: string, context: HeadlessPaneContext): Promise<EarningsHistoryPayload>;
  upcoming(symbols: string[], context: HeadlessPaneContext): Promise<EarningsEvent[]>;
}

const defaultDependencies: EarningsHeadlessDependencies = {
  calendar: (query, context) => fetchEarningsCalendar(query, context.apiClient),
  history: (symbol, context) => fetchEarningsHistory(symbol, context.apiClient),
  upcoming: (symbols, context) => loadEarningsCalendar(context.marketData, symbols).then((result) => result.events),
};

const NO_OWNERSHIP = new Map();

async function boardRows(args: HeadlessPaneLoadArgs, context: HeadlessPaneContext, deps: EarningsHeadlessDependencies): Promise<HeadlessRowsResult> {
  const today = newYorkToday();
  const named = args.symbols;
  const days = marketDays(today);
  const query = named.length
    ? { from: today, to: addDays(today, 90), perDay: 0, symbols: named }
    : { from: days[0]!.from, to: days.at(-1)!.to, perDay: 200, symbols: [] };
  const [cloud, fallback] = await Promise.allSettled([
    deps.calendar(query, context),
    named.length ? deps.upcoming(named, context) : Promise.resolve([]),
  ]);
  if (cloud.status === "rejected" && (!named.length || fallback.status === "rejected")) throw cloud.reason;
  const payload = cloud.status === "fulfilled" ? cloud.value : null;
  const reports = (payload?.reports ?? []).map((report) => boardReport(report, NO_OWNERSHIP));
  const covered = new Set(reports.map((report) => report.symbol));
  const extra = fallback.status === "fulfilled"
    ? fallback.value.filter((event) => !covered.has(event.symbol)).map((event) => fallbackReport(event, NO_OWNERSHIP))
    : [];
  const limit = Number(args.options.limit ?? 200);
  const all = [...reports, ...extra].sort((left, right) => left.date.localeCompare(right.date) || (right.marketCap ?? 0) - (left.marketCap ?? 0));
  const rows = all.slice(0, limit).map((report) => ({
    date: report.date,
    timing: report.timing ? TIMING_LABEL[report.timing] : null,
    timingExpected: report.expectedTiming,
    symbol: report.symbol,
    name: report.name,
    marketCap: report.marketCap,
    epsEstimate: report.epsEstimate,
    epsActual: report.epsActual,
    revenueEstimate: report.revenueEstimate,
    impliedMove: report.impliedMove,
    averageMove: report.averageMove,
  }));
  return {
    columns: BOARD_COLUMNS,
    rows,
    errors: cloud.status === "rejected" ? [String(cloud.reason instanceof Error ? cloud.reason.message : cloud.reason)] : undefined,
    metadata: {
      asOf: payload?.asOf ?? null,
      from: query.from,
      to: query.to,
      averageMoveOver: `last 8 reports, at least ${MIN_AVERAGE_REPORTS}`,
      total: all.length,
      returned: rows.length,
      truncated: rows.length < all.length,
    },
  };
}

async function historyReport(symbol: string, context: HeadlessPaneContext, deps: EarningsHeadlessDependencies): Promise<HeadlessRowsResult> {
  const [history, upcoming] = await Promise.allSettled([deps.history(symbol, context), deps.upcoming([symbol], context)]);
  if (history.status === "rejected" && upcoming.status === "rejected") throw history.reason;
  const payload = history.status === "fulfilled" ? history.value : null;
  const next = upcoming.status === "fulfilled" ? upcoming.value[0] ?? null : null;
  const rows = historyRows(payload, newYorkToday(), next).map((row) => ({
    date: row.date,
    upcoming: row.upcoming,
    timing: row.timing ? TIMING_LABEL[row.timing] : null,
    timingExpected: row.expectedTiming,
    fiscalPeriod: row.fiscalPeriod,
    epsEstimate: row.epsEstimate,
    epsActual: row.epsActual,
    epsSurprise: row.epsSurprise,
    revenueEstimate: row.revenueEstimate,
    revenueActual: row.revenueActual,
    revenueSurprise: row.revenueSurprise,
    impliedMove: row.implied,
    impliedFrom: row.impliedMethod === "trade-close" ? "trade closes" : row.impliedMethod === "quote-mid" ? "quote mids" : null,
    move: row.move,
  }));
  return {
    columns: HISTORY_COLUMNS,
    rows,
    errors: history.status === "rejected" ? [String(history.reason instanceof Error ? history.reason.message : history.reason)] : undefined,
    metadata: { symbol, name: payload?.name ?? next?.name ?? null, asOf: payload?.asOf ?? null },
  };
}

/** EVTS: the market board, whatever ticker is given. */
function createEarningsBoardHeadless(deps: EarningsHeadlessDependencies = defaultDependencies): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: { kind: "ticker", placeholder: "ticker", description: "Optional; the board is the same.", minimum: 0, maximum: 1 },
    options: [
      { key: "limit", description: "Maximum rows.", type: "integer", defaultValue: 200, minimum: 1, maximum: 1000 },
    ],
    columns: BOARD_COLUMNS,
    describe: () => "Earnings Calendar",
    load(args, context) {
      return boardRows({ ...args, symbols: [] }, context, deps);
    },
  };
}

function createEarningsHeadless(deps: EarningsHeadlessDependencies = defaultDependencies): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "symbol-list",
      placeholder: "tickers",
      description: "None for the market's report days, one for its report history, several for their upcoming reports.",
      minimum: 0,
      maximum: 100,
    },
    options: [
      { key: "limit", description: "Maximum rows on the market board or a ticker list.", type: "integer", defaultValue: 200, minimum: 1, maximum: 1000 },
    ],
    columns: BOARD_COLUMNS,
    describe: (args) => (args.symbols.length === 0 ? "Earnings Calendar" : `ERN ${args.symbols.join(", ")}`),
    load(args, context) {
      return args.symbols.length === 1 ? historyReport(args.symbols[0]!, context, deps) : boardRows(args, context, deps);
    },
  };
}

export const earningsCalendarHeadless = createEarningsHeadless();
export const earningsBoardHeadless = createEarningsBoardHeadless();
