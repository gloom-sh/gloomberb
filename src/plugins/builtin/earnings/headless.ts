import { logFailure } from "../../../utils/log-failure";
import { isNotMeaningful, NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
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
import { addDays, boardKey, boardReport, boardRowOf, fallbackReport, historyListing, MIN_AVERAGE_REPORTS, newYorkToday, type BoardReport } from "./board-model";
import { BOARD_WEEKS, boardRangeDays, boardRangeLabel, isBoardWeek, requestedBoardRange, type BoardRange } from "./calendar-model";
import { fetchEarningsCalendar, fetchEarningsHistory, noHistoryAbroad, sameHistoryListing } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { epsText, impliedText, moneyText, moveSize, signedPercent, TIMING_LABEL } from "./format";
import { historyRows, periodText } from "./history-model";
import { fiscalQuarterText } from "./fiscal-quarter";
import { loadNoEarningsText } from "./no-earnings";
import { EPS_BASIS_NOTE, epsBasisName, PROVISIONAL_NOTE, showsEpsBasis } from "../shared/earnings-report";
import { listingAbroadVenue } from "../../../utils/sec";
import { findUsListingOfCompany } from "../../../tickers/us-listing";
import { shortCompanyName } from "../../../tickers/company-name";
import { REPORT_ROWS } from "../shared/headless-options";
import { DATE_OPTION_EXAMPLES, isoDateOption } from "../../../utils/calendar-date";
import type { HeadlessPaneOptionDef } from "../../../types/headless";

const right = "right" as const;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
/**
 * A surprise as exported: a number, or null with the row's `<key>NotMeaningful` set against a loss or zero
 * estimate (the text report draws N/M, as RV and DVD do), never text in the number's column.
 */
function surpriseFields<Key extends "epsSurprise" | "revenueSurprise">(key: Key, value: unknown) {
  return isNotMeaningful(value)
    ? { [key]: null, [`${key}NotMeaningful`]: true } as Record<Key, null> & Record<`${Key}NotMeaningful`, true>
    : { [key]: num(value) } as Record<Key, number | null>;
}

/**
 * A surprise column. Where JSON has null and `<key>NotMeaningful`, the text report draws N/M and CSV leaves the
 * cell empty, its status column saying `n/m`, as DVD's growth does: the column holds only numbers.
 */
function surpriseColumn(key: "epsSurprise" | "revenueSurprise", header: string): HeadlessPaneColumn {
  const flag = `${key}NotMeaningful`;
  const draw = (text: string) => (value: unknown, row: Record<string, unknown>) =>
    typeof value !== "number" && row[flag] === true ? text : signedPercent(num(value));
  return { key, header, align: right, format: draw(NOT_MEANINGFUL_TEXT.toLowerCase()), textFormat: draw(NOT_MEANINGFUL_TEXT) };
}

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
  // Dollars for every company, a listing abroad's too, so the board ranks them together.
  { key: "marketCap", header: "Mkt cap $", align: right, format: (value) => moneyText(num(value)) },
  // The EPS and sales figures' currency: a listing abroad's own (CNY for Tencent).
  { key: "currency", header: "Ccy" },
  { key: "epsEstimate", header: "EPS est", align: right, format: (value) => epsText(num(value)) },
  { key: "epsAnalysts", header: "Ests", align: right },
  { key: "epsActual", header: "EPS act", align: right, format: (value) => epsText(num(value)) },
  BASIS_COLUMN,
  surpriseColumn("epsSurprise", "EPS surp"),
  { key: "revenueEstimate", header: "Sales est", align: right, format: (value) => moneyText(num(value)) },
  { key: "impliedMove", header: "Implied", align: right, format: (value) => impliedText(num(value)) },
  { key: "averageMove", header: "Avg move", align: right, format: (value) => moveSize(num(value)) },
];

/** What the board's currency and cap are, and which listings abroad it has, in its metadata. */
const BOARD_CURRENCY_NOTE = "currency is the ISO currency of a report's EPS and sales figures: dollars for US listings, a listing abroad's own (CNY for Tencent), never converted. marketCap is in dollars for every company, so the board ranks them together. Besides US listings the board has the Hong Kong, China A and Singapore top 100's reports whose date the company confirmed or that are out, from each listing's earnings history; they have no time of day, implied or average move. A company listed on two of those markets is shown once, under its primary listing, and found by any of its lines.";

/** What an ERN <ticker> report's quarter is, in its metadata. */
const FISCAL_QUARTER_NOTE = "fiscalQuarter is the quarter as the company names it (Q3 FY2027), from its earnings calls on record; fiscalPeriod is the month the quarter ended. A company whose calls do not name its quarters has fiscalQuarter null.";

/** When an upcoming report has an implied move, in an ERN <ticker> report's metadata. */
const IMPLIED_NOTE = "An upcoming report's implied move is read from its options' prices from 8 days before the report, for companies worth $2 billion or more. Before then, or for a smaller company, impliedMove is null: it is never estimated.";

/** Where the board's caps come from and how old they can be, in its metadata. */
const MARKET_CAP_NOTE = "Each company's market cap as RV shows it: its latest financials snapshot at the regular session's price (the close outside the session), from the newest quote Gloom Cloud holds for it. A company with no snapshot shows the earnings calendar's figure.";

const HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "dateStatus", header: "Status" },
  { key: "timing", header: "When" },
  // The quarter as the company names it; its end month where the company's calls do not say. Exports keep both.
  { key: "fiscalQuarter", header: "Quarter", format: (value, row) => typeof value === "string" ? value : typeof row.fiscalPeriod === "string" ? row.fiscalPeriod : "-" },
  { key: "epsEstimate", header: "EPS est", align: right, format: (value) => epsText(num(value)) },
  { key: "epsAnalysts", header: "Ests", align: right },
  { key: "epsActual", header: "EPS act", align: right, format: (value) => epsText(num(value)) },
  BASIS_COLUMN,
  surpriseColumn("epsSurprise", "EPS surp"),
  { key: "revenueEstimate", header: "Sales est", align: right, format: (value) => moneyText(num(value)) },
  { key: "revenueActual", header: "Sales act", align: right, format: (value) => moneyText(num(value)) },
  surpriseColumn("revenueSurprise", "Sales surp"),
  { key: "impliedMove", header: "Implied", align: right, format: (value) => impliedText(num(value)) },
  { key: "impliedFrom", header: "Implied from" },
  { key: "move", header: "Move", align: right, format: (value) => signedPercent(num(value)) },
];

/** A Hong Kong, Singapore or China A listing's report: what its figures cover, their currency and its results announcement; no options or moves are read for it. */
const LISTING_HISTORY_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date" },
  { key: "dateStatus", header: "Status" },
  { key: "timing", header: "When" },
  { key: "period", header: "Period" },
  { key: "currency", header: "Ccy" },
  ...HISTORY_COLUMNS.filter((column) => ["epsEstimate", "epsAnalysts", "epsActual", "epsBasis", "epsSurprise", "revenueEstimate", "revenueActual", "revenueSurprise"].includes(column.key)),
  { key: "filing", header: "Filing" },
];

/** What a Hong Kong, Singapore or China A listing's ERN report's period, currency and filing are, in its metadata. */
const LISTING_PERIOD_NOTE = "period is what the figures cover: a quarter (Q3 FY2026, or its end month), a half (H1 FY2026), a year (FY2025) or a year to date (9M FY2026), a fiscal year named by the calendar year it ends in. A half-yearly reporter's half is never a quarter. currency is the ISO currency of every amount on the row, estimates included. EPS estimates and actuals are the street's quarter figures, compared only in one currency and on one basis; a period the street has no quarter for shows the company's reported EPS and revenue from its results announcement (filing) with no estimate, its EPS diluted (basis GAAP) where the filing gives one, else basic (basis basic). The street's quarters and the exchange's results calendar (each report's day, time and period) are everyone's; the announcements' figures and links come with Gloom Pro, as KPIS has them. The next report's date is the company's where its exchange has it (status confirmed), else the day the same report came out a year before, 52 weeks on (status projected).";

interface EarningsHeadlessDependencies {
  calendar(query: { from: string; to: string; perDay: number; symbols: string[]; markets?: "all" }, context: HeadlessPaneContext): Promise<EarningsCalendarPayload>;
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
function boardTickerNotice(symbol: string, board: ReadonlyArray<Pick<BoardReport, "symbol" | "listings" | "date">>, from: string, to: string): { notice: string; date: string | null; row: string | null } {
  const report = board.find((entry) => boardRowOf(entry, symbol));
  // CCB named by its H share is on the board under its A share.
  const shownAs = report?.listings && !sameHistoryListing(report.symbol, boardKey(symbol)) ? ` (as ${report.symbol})` : "";
  const where = report ? `${symbol} reports on ${report.date}${shownAs}` : `${symbol} is not on it`;
  const days = from === to ? from : `${from} to ${to}`;
  return {
    notice: `EVTS is the market's earnings board for ${days}, not one company's: ${where}. For ${symbol}'s own report dates run \`gloom fn ERN ${symbol}\`.`,
    date: report?.date ?? null,
    row: report?.symbol ?? null,
  };
}

/** Two dates this close are one report under the per-ticker calendar and the stored board. */
const SAME_REPORT_DAYS = 3;
const eventDay = (event: EarningsEvent) => event.earningsDate.toISOString().slice(0, 10);
const dayGap = (left: string, right: string) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;

/**
 * The stored board's own report for each named company whose per-ticker
 * calendar still names a report gone by (META the week after it reported),
 * read over those days as `ERN --date` reads them: the estimate it was
 * measured against, its analysts, the actual, its basis and the cap, as the
 * date board and `ERN <ticker>` show them. One the board does not have is
 * left to the per-ticker calendar.
 */
async function storedPastReports(
  events: readonly EarningsEvent[],
  today: string,
  context: HeadlessPaneContext,
  deps: EarningsHeadlessDependencies,
): Promise<Map<EarningsEvent, BoardReport>> {
  const past = events.filter((event) => eventDay(event) < today);
  const found = new Map<EarningsEvent, BoardReport>();
  if (!past.length) return found;
  const from = addDays(past.map(eventDay).sort()[0]!, -SAME_REPORT_DAYS);
  const symbols = [...new Set(past.map((event) => event.symbol))];
  const payload = await deps.calendar({ from, to: addDays(today, -1), perDay: 0, symbols }, context)
    .catch(logFailure("earnings.headless", "Read the board's past reports for named companies failed", null));
  for (const event of past) {
    const nearest = (payload?.reports ?? [])
      .filter((report) => report.symbol === event.symbol && dayGap(report.date, eventDay(event)) <= SAME_REPORT_DAYS)
      .sort((left, right) => dayGap(left.date, eventDay(event)) - dayGap(right.date, eventDay(event)))[0];
    if (nearest) found.set(event, boardReport(nearest, NO_OWNERSHIP));
  }
  return found;
}

async function boardRows(args: HeadlessPaneLoadArgs, context: HeadlessPaneContext, deps: EarningsHeadlessDependencies, highlight?: string, range: BoardRange = ""): Promise<HeadlessRowsResult> {
  const today = newYorkToday();
  const named = args.symbols;
  const days = boardRangeDays(range, today);
  // Named companies' upcoming reports by default; a chosen week or day reads that range for them as for the market.
  // Every view of the board shows each report's currency, so it reads the listings abroad too; EVTS 0700.HK names its
  // listing, which the board then keeps whatever the day's cut.
  const abroad = highlight && listingAbroadVenue(boardKey(highlight)) ? [boardKey(highlight)] : [];
  const query = named.length && !range
    ? { from: today, to: addDays(today, 90), perDay: 0, symbols: named, markets: "all" as const }
    : { from: days[0]!.from, to: days.at(-1)!.to, perDay: named.length ? 0 : 200, symbols: named.length ? named : abroad, markets: "all" as const };
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
  // A listing abroad named by another of its company's lines (0939:HKEX) is covered by its row.
  const covered = new Set(reports.flatMap((report) => [report.symbol, ...report.listings ?? []]));
  const uncovered = fallback.status === "fulfilled" ? fallback.value.filter((event) => !covered.has(event.symbol)) : [];
  // The days ahead leave out a report just gone by, which the stored board has as the date board shows it.
  const stored = named.length && !range ? await storedPastReports(uncovered, today, context, deps) : new Map<EarningsEvent, BoardReport>();
  const extra = uncovered.map((event) => stored.get(event) ?? fallbackReport(event, NO_OWNERSHIP, today));
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
    currency: report.currency ?? null,
    ...report.listings ? { listings: report.listings } : {},
    epsEstimate: report.epsEstimate,
    epsAnalysts: report.epsAnalysts,
    epsActual: report.epsActual,
    epsActualProvisional: report.provisional,
    epsBasis: showsEpsBasis(report) ? epsBasisName(report.epsBasis) : null,
    ...surpriseFields("epsSurprise", report.epsSurprise),
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
      ...(ticker ? { notices: [ticker.notice], highlight: { symbol: highlight, onBoard: ticker.date != null, date: ticker.date, row: ticker.row } } : {}),
      asOf: payload?.asOf ?? null,
      from: query.from,
      to: query.to,
      averageMoveOver: `last 8 reports, at least ${MIN_AVERAGE_REPORTS}`,
      epsBasis: EPS_BASIS_NOTE,
      provisional: PROVISIONAL_NOTE,
      marketCap: MARKET_CAP_NOTE,
      currency: BOARD_CURRENCY_NOTE,
      total: all.length,
      returned: rows.length,
      truncated: rows.length < all.length,
    },
  };
}

/**
 * What ERN says for a listing abroad, whose next report is its own but whose
 * past reports, surprises and implied moves only the US board and Hong Kong's
 * results announcements have: that, and the company's US listing to read
 * them on (Sanofi's SNY for SAN:EPA).
 */
async function abroadHistoryNotice(symbol: string, company: string | null, context: HeadlessPaneContext): Promise<string> {
  const lead = `Past reports, surprises and implied moves cover US, Hong Kong, Singapore and China A listings only, so ${symbol} shows its next report.`;
  const us = await findUsListingOfCompany(context.marketData, company);
  return us ? `${lead} ${shortCompanyName(company!)}'s US listing is ${us.symbol}: ERN ${us.symbol} has them.` : lead;
}

async function historyReport(symbol: string, context: HeadlessPaneContext, deps: EarningsHeadlessDependencies): Promise<HeadlessRowsResult> {
  // The board is US listings'; SAN:EPA's past reports are not on it, and bare SAN there is another company.
  // A Hong Kong, Singapore or China A listing has its own, from its exchange's results calendar and announcements.
  const { listing, abroad, ownAbroad } = historyListing(symbol);
  const [history, upcoming] = await Promise.allSettled([
    abroad ? Promise.resolve(null) : ownAbroad ? deps.history(listing, context).catch(noHistoryAbroad) : deps.history(listing, context),
    deps.upcoming([symbol], context),
  ]);
  if (history.status === "rejected" && upcoming.status === "rejected") throw history.reason;
  const payload = history.status === "fulfilled" ? history.value : null;
  const next = upcoming.status === "fulfilled" ? upcoming.value[0] ?? null : null;
  const notice = abroad
    ? await abroadHistoryNotice(symbol, next?.name ?? await context.marketData.getQuote(symbol, "").then((quote) => quote.name ?? null, logFailure("earnings.headless", "Load earnings company name failed", null)), context)
    : null;
  const rows = historyRows(payload, newYorkToday(), next, { abroad: ownAbroad }).map((row) => ({
    date: row.date,
    upcoming: row.upcoming,
    dateStatus: row.dateStatus,
    timing: row.timing ? TIMING_LABEL[row.timing] : null,
    timingExpected: row.expectedTiming,
    fiscalPeriod: row.fiscalPeriod,
    fiscalQuarter: fiscalQuarterText(row.fiscalQuarter),
    ...(ownAbroad ? {
      period: periodText(row, false),
      periodKind: row.periodKind,
      periodMonths: row.periodMonths,
      currency: row.currency,
      filing: row.filingUrl,
    } : {}),
    epsEstimate: row.epsEstimate,
    epsAnalysts: row.epsAnalysts,
    epsActual: row.epsActual,
    epsActualProvisional: row.provisional,
    epsBasis: !showsEpsBasis(row) ? null : !row.epsBasis && row.epsDilution === "basic" ? "basic" : epsBasisName(row.epsBasis),
    ...surpriseFields("epsSurprise", row.epsSurprise),
    revenueEstimate: row.revenueEstimate,
    revenueActual: row.revenueActual,
    revenueActualProvisional: row.revenueProvisional,
    ...surpriseFields("revenueSurprise", row.revenueSurprise),
    impliedMove: row.implied,
    impliedFrom: row.impliedMethod === "trade-close" ? "trade closes" : row.impliedMethod === "quote-mid" ? "quote mids" : null,
    move: row.move,
  }));
  // An ETF, an index, a currency pair, a coin or a future has no earnings: that is the answer, not a gap in the data,
  // and a history that failed for one (a coin is no US ticker) is no error.
  const noEarnings = rows.length === 0 && !abroad ? await loadNoEarningsText(context.marketData, symbol, "cli") : null;
  // A company ERN covers whose history answered with nothing (AIA's, 1299:HKEX) has no reports on record yet: no
  // complete answer, and not one ERN does not cover.
  const empty = noEarnings ?? (rows.length === 0 && payload ? `No earnings reports on record for ${symbol}.` : null);
  return {
    columns: ownAbroad ? LISTING_HISTORY_COLUMNS : HISTORY_COLUMNS,
    rows,
    ...(noEarnings ? { empty: noEarnings, complete: true, unavailableSymbols: [] } : empty ? { empty } : {}),
    errors: history.status === "rejected" && !noEarnings ? [String(history.reason instanceof Error ? history.reason.message : history.reason)] : undefined,
    metadata: {
      symbol, name: payload?.name ?? next?.name ?? null, asOf: payload?.asOf ?? null,
      epsBasis: EPS_BASIS_NOTE,
      provisional: PROVISIONAL_NOTE,
      fiscalQuarter: FISCAL_QUARTER_NOTE,
      ...(ownAbroad ? { period: LISTING_PERIOD_NOTE } : { impliedMove: IMPLIED_NOTE }),
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
