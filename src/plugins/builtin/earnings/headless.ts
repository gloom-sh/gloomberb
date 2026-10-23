import type { EarningsCalendarPayload, EarningsHistoryPayload } from "../../../api-client/earnings";
import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneFreshness,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import type { EarningsEvent } from "../../../types/data-provider";
import { addDays, boardReport, fallbackReport, MIN_AVERAGE_REPORTS, newYorkToday } from "./board-model";
import { BOARD_WEEKS, boardRangeDays, boardRangeLabel, isBoardWeek, requestedBoardRange, type BoardRange } from "./calendar-model";
import { fetchEarningsCalendar, fetchEarningsHistory } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { epsText, impliedText, moneyText, moveSize, signedPercent, TIMING_LABEL } from "./format";
import { historyRows } from "./history-model";
import { loadNoEarningsText } from "./no-earnings";
import { EPS_BASIS_NOTE, epsBasisName, PROVISIONAL_NOTE, showsEpsBasis } from "../shared/earnings-report";
import { isUsListingExchange } from "../../../utils/exchanges";
import { listingAbroadVenue } from "../../../utils/sec";
import { findUsListingOfCompany } from "../../../tickers/us-listing";
import { shortCompanyName } from "../../../tickers/company-name";
import { REPORT_ROWS } from "../shared/headless-options";
import { DATE_OPTION_EXAMPLES, isoDateOption } from "../../../utils/calendar-date";
import type { HeadlessPaneOptionDef } from "../../../types/headless";

const right = "right" as const;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The text report says a provisional figure's basis is provisional; exports keep the basis alone and `epsActualProvisional`. */
const BASIS_COLUMN: HeadlessPaneColumn = {
  key: "epsBasis",
  header: "Basis",
  textFormat: (value, row) => (value == null ? "-" : row.epsActualProvisional === true ? `${String(value)}, provisional` : String(value)),
};

const BOARD_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "dateStatus", header: "Status" },
  { key: "timing", header: "When" },
  { key: "symbol", header: "Ticker" },
  { key: "name", header: "Name" },
  { key: "marketCap", header: "Mkt cap", align: right, format: (value) => moneyText(num(value)) },
  { key: "epsEstimate", header: "EPS est", align: right, format: (value) => epsText(num(value)) },
  { key: "epsAnalysts", header: "Ests", align: right },
  { key: "epsActual", header: "EPS act", align: right, format: (value) => epsText(num(value)) },
  BASIS_COLUMN,
  { key: "epsSurprise", header: "EPS surp", align: right, format: (value) => signedPercent(num(value)) },
  { key: "revenueEstimate", header: "Sales est", align: right, format: (value) => moneyText(num(value)) },
  { key: "impliedMove", header: "Implied", align: right, format: (value) => impliedText(num(value)) },
  { key: "averageMove", header: "Avg move", align: right, format: (value) => moveSize(num(value)) },
];

/** Where the board's caps come from and how old they can be, in its metadata. */
const MARKET_CAP_NOTE = "Each company's market cap as RV shows it: its latest financials snapshot at the regular session's price (the close outside the session), from the newest quote Gloom Cloud holds for it. A company with no snapshot shows the earnings calendar's figure.";

const HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "dateStatus", header: "Status" },
  { key: "timing", header: "When" },
  { key: "fiscalPeriod", header: "Quarter" },
  { key: "epsEstimate", header: "EPS est", align: right, format: (value) => epsText(num(value)) },
  { key: "epsAnalysts", header: "Ests", align: right },
  { key: "epsActual", header: "EPS act", align: right, format: (value) => epsText(num(value)) },
  BASIS_COLUMN,
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

/**
 * EVTS with a ticker: the board is the market's whatever the ticker, so the
 * report says so once, whether the ticker is on it and when, and where its
 * own report dates are.
 */
function boardTickerNotice(symbol: string, board: ReadonlyArray<{ symbol: string; date: string }>, from: string, to: string): { notice: string; date: string | null } {
  const [bare = symbol, venue] = symbol.toUpperCase().split(":");
  // The board lists US tickers; a listing named abroad is never one of them.
  const report = venue && !isUsListingExchange(venue) ? undefined : board.find((entry) => entry.symbol.toUpperCase() === bare);
  const where = report ? `${symbol} reports on ${report.date}` : `${symbol} is not on it`;
  const days = from === to ? from : `${from} to ${to}`;
  return {
    notice: `EVTS is the market's earnings board for ${days}, not one company's: ${where}. For ${symbol}'s own report dates run \`gloom fn ERN ${symbol}\`.`,
    date: report?.date ?? null,
  };
}

async function boardRows(args: HeadlessPaneLoadArgs, context: HeadlessPaneContext, deps: EarningsHeadlessDependencies, highlight?: string, range: BoardRange = ""): Promise<HeadlessRowsResult> {
  const today = newYorkToday();
  const named = args.symbols;
  const days = boardRangeDays(range, today);
  // Named companies' upcoming reports by default; a chosen week or day reads that range for them as for the market.
  const query = named.length && !range
    ? { from: today, to: addDays(today, 90), perDay: 0, symbols: named }
    : { from: days[0]!.from, to: days.at(-1)!.to, perDay: named.length ? 0 : 200, symbols: named };
  const inRange = (event: EarningsEvent) => {
    const date = event.earningsDate.toISOString().slice(0, 10);
    return !range || (date >= query.from && date <= query.to);
  };
  const [cloud, fallback] = await Promise.allSettled([
    deps.calendar(query, context),
    named.length ? deps.upcoming(named, context).then((events) => events.filter(inRange)) : Promise.resolve([]),
  ]);
  if (cloud.status === "rejected" && (!named.length || fallback.status === "rejected")) throw cloud.reason;
  const payload = cloud.status === "fulfilled" ? cloud.value : null;
  const reports = (payload?.reports ?? []).map((report) => boardReport(report, NO_OWNERSHIP));
  const covered = new Set(reports.map((report) => report.symbol));
  const extra = fallback.status === "fulfilled"
    ? fallback.value.filter((event) => !covered.has(event.symbol)).map((event) => fallbackReport(event, NO_OWNERSHIP, today))
    : [];
  const limit = Number(args.options.limit ?? 200);
  const all = [...reports, ...extra].sort((left, right) => left.date.localeCompare(right.date) || (right.marketCap ?? 0) - (left.marketCap ?? 0));
  const rows = all.slice(0, limit).map((report) => ({
    date: report.date,
    dateStatus: report.dateStatus,
    timing: report.timing ? TIMING_LABEL[report.timing] : null,
    timingExpected: report.expectedTiming,
    symbol: report.symbol,
    name: report.name,
    marketCap: report.marketCap,
    epsEstimate: report.epsEstimate,
    epsAnalysts: report.epsAnalysts,
    epsActual: report.epsActual,
    epsActualProvisional: report.provisional,
    epsBasis: showsEpsBasis(report) ? epsBasisName(report.epsBasis) : null,
    epsSurprise: report.epsSurprise,
    revenueEstimate: report.revenueEstimate,
    impliedMove: report.impliedMove,
    averageMove: report.averageMove,
  }));
  const ticker = highlight ? boardTickerNotice(highlight, all, query.from, query.to) : null;
  return {
    columns: BOARD_COLUMNS,
    rows,
    errors: cloud.status === "rejected" ? [String(cloud.reason instanceof Error ? cloud.reason.message : cloud.reason)] : undefined,
    metadata: {
      ...(ticker ? { notices: [ticker.notice], highlight: { symbol: highlight, onBoard: ticker.date != null, date: ticker.date } } : {}),
      asOf: payload?.asOf ?? null,
      from: query.from,
      to: query.to,
      averageMoveOver: `last 8 reports, at least ${MIN_AVERAGE_REPORTS}`,
      epsBasis: EPS_BASIS_NOTE,
      provisional: PROVISIONAL_NOTE,
      marketCap: MARKET_CAP_NOTE,
      total: all.length,
      returned: rows.length,
      truncated: rows.length < all.length,
    },
  };
}

/**
 * What ERN says for a listing abroad, whose next report is its own but whose
 * past reports, surprises and implied moves only the US board has: that, and
 * the company's US listing to read them on (Sanofi's SNY for SAN:EPA).
 */
async function abroadHistoryNotice(symbol: string, company: string | null, context: HeadlessPaneContext): Promise<string> {
  const lead = `Past reports, surprises and implied moves cover US listings only, so ${symbol} shows its next report.`;
  const us = await findUsListingOfCompany(context.marketData, company);
  return us ? `${lead} ${shortCompanyName(company!)}'s US listing is ${us.symbol}: ERN ${us.symbol} has them.` : lead;
}

async function historyReport(symbol: string, context: HeadlessPaneContext, deps: EarningsHeadlessDependencies): Promise<HeadlessRowsResult> {
  // The board is US listings'; SAN:EPA's past reports are not on it, and bare SAN there is another company.
  const abroad = listingAbroadVenue(symbol) != null;
  const [history, upcoming] = await Promise.allSettled([
    abroad ? Promise.resolve(null) : deps.history(symbol, context),
    deps.upcoming([symbol], context),
  ]);
  if (history.status === "rejected" && upcoming.status === "rejected") throw history.reason;
  const payload = history.status === "fulfilled" ? history.value : null;
  const next = upcoming.status === "fulfilled" ? upcoming.value[0] ?? null : null;
  const notice = abroad
    ? await abroadHistoryNotice(symbol, next?.name ?? await context.marketData.getQuote(symbol, "").then((quote) => quote.name ?? null, () => null), context)
    : null;
  const rows = historyRows(payload, newYorkToday(), next).map((row) => ({
    date: row.date,
    upcoming: row.upcoming,
    dateStatus: row.dateStatus,
    timing: row.timing ? TIMING_LABEL[row.timing] : null,
    timingExpected: row.expectedTiming,
    fiscalPeriod: row.fiscalPeriod,
    epsEstimate: row.epsEstimate,
    epsAnalysts: row.epsAnalysts,
    epsActual: row.epsActual,
    epsActualProvisional: row.provisional,
    epsBasis: showsEpsBasis(row) ? epsBasisName(row.epsBasis) : null,
    epsSurprise: row.epsSurprise,
    revenueEstimate: row.revenueEstimate,
    revenueActual: row.revenueActual,
    revenueActualProvisional: row.revenueProvisional,
    revenueSurprise: row.revenueSurprise,
    impliedMove: row.implied,
    impliedFrom: row.impliedMethod === "trade-close" ? "trade closes" : row.impliedMethod === "quote-mid" ? "quote mids" : null,
    move: row.move,
  }));
  // An ETF, an index, a currency pair, a coin or a future has no earnings: that is the answer, not a gap in the data,
  // and a history that failed for one (a coin is no US ticker) is no error.
  const noEarnings = rows.length === 0 && !abroad ? await loadNoEarningsText(context.marketData, symbol, "cli") : null;
  return {
    columns: HISTORY_COLUMNS,
    rows,
    ...(noEarnings ? { empty: noEarnings, complete: true, unavailableSymbols: [] } : {}),
    errors: history.status === "rejected" && !noEarnings ? [String(history.reason instanceof Error ? history.reason.message : history.reason)] : undefined,
    metadata: {
      symbol, name: payload?.name ?? next?.name ?? null, asOf: payload?.asOf ?? null,
      epsBasis: EPS_BASIS_NOTE,
      provisional: PROVISIONAL_NOTE,
      ...(notice ? { notices: [notice] } : {}),
    },
  };
}

/** EVTS: the market board, whatever ticker is given. */
export const EARNINGS_CALENDAR: HeadlessPaneFreshness = { status: "not-a-feed", basis: "calendar" };

/** The board's days, as the pane's Range saves them: a day, a week, or the days ahead. */
const BOARD_RANGE_OPTIONS: HeadlessPaneOptionDef[] = [
  { key: "date", type: "string", settingKey: "date", placeholder: "date", example: "--date 2026-10-15", exampleWithoutArgument: true,
    description: `One day's reports, past or ahead, as ${DATE_OPTION_EXAMPLES}.`, normalize: (value) => isoDateOption(value, "date") },
  { key: "week", type: "enum", settingKey: "week", values: BOARD_WEEKS.map((value) => ({ value })), example: "--week last", exampleWithoutArgument: true,
    description: "A week's reports, Monday to Friday: last, this or next. Without it or --date, the days ahead." },
];

/** The days `--date` or `--week` asks for; the days ahead without either. */
function boardRange(options: HeadlessPaneLoadArgs["options"]): BoardRange {
  if (options.date && isBoardWeek(options.week)) throw new Error("Use --date or --week, not both.");
  return requestedBoardRange(options.date, options.week);
}

export function createEarningsBoardHeadless(deps: EarningsHeadlessDependencies = defaultDependencies): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: EARNINGS_CALENDAR,
    argument: { kind: "ticker", placeholder: "ticker", description: "Optional; the board is the same.", minimum: 0, maximum: 1 },
    options: [
      ...BOARD_RANGE_OPTIONS,
      { key: "limit", shot: REPORT_ROWS, description: "Maximum rows.", type: "integer", defaultValue: 200, minimum: 1, maximum: 1000 },
    ],
    columns: BOARD_COLUMNS,
    describe: (args) => {
      const range = boardRangeLabel(boardRange(args.options), newYorkToday());
      return range ? `Earnings Calendar | ${range}` : "Earnings Calendar";
    },
    async load(args, context) {
      return boardRows({ ...args, symbols: [] }, context, deps, args.symbols[0], boardRange(args.options));
    },
  };
}

export function createEarningsHeadless(deps: EarningsHeadlessDependencies = defaultDependencies): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: EARNINGS_CALENDAR,
    argument: {
      kind: "symbol-list",
      placeholder: "tickers",
      description: "None for the market's report days, one for its report history, several for their upcoming reports.",
      minimum: 0,
      maximum: 100,
    },
    options: [
      ...BOARD_RANGE_OPTIONS,
      { key: "limit", shot: REPORT_ROWS, description: "Maximum rows on the market board or a ticker list.", type: "integer", defaultValue: 200, minimum: 1, maximum: 1000 },
    ],
    columns: BOARD_COLUMNS,
    describe: (args) => {
      const range = args.symbols.length === 1 ? null : boardRangeLabel(boardRange(args.options), newYorkToday());
      const title = args.symbols.length === 0 ? "Earnings Calendar" : `ERN ${args.symbols.join(", ")}`;
      return range ? `${title} | ${range}` : title;
    },
    async load(args, context) {
      const range = boardRange(args.options);
      if (args.symbols.length === 1 && range) {
        const symbol = args.symbols[0]!;
        throw new Error(`ERN ${symbol} is its report history, past reports included; --date and --week pick the board's days. Run \`gloom fn EVTS ${symbol} ${args.options.date ? `--date ${args.options.date}` : `--week ${args.options.week}`}\` for the market's.`);
      }
      return args.symbols.length === 1 ? historyReport(args.symbols[0]!, context, deps) : boardRows(args, context, deps, undefined, range);
    },
  };
}

export const earningsCalendarHeadless = createEarningsHeadless();
export const earningsBoardHeadless = createEarningsBoardHeadless();
