import type {
  HeadlessBundleResult,
  HeadlessBundleSection,
  HeadlessPaneColumn,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneLoadArgs,
  HeadlessPaneRow,
} from "../../../types/plugin";
import {
  CDS_TRADE_DAYS,
  loadCdsActivity,
  loadCdsSpreadHistory,
  loadCdsSpreadLevels,
  type CdsActivity,
  type CdsFetch,
  type CdsHistoryFetch,
  type CdsLevelsFetch,
  type CdsSpreadHistory,
  type InstrumentSearch,
} from "./client";
import { formatContract } from "../credit-boards/model";
import {
  DEFAULT_TRADE_SORT,
  ISSUER_LIST_SORTS,
  cdsFreshness,
  displayIssuerName,
  formatBp,
  formatEventTime,
  formatNotional,
  formatPoints,
  formatPointsMove,
  formatQuoted,
  formatQuotedMove,
  formatSpreadMove,
  formatSpreadRange,
  formatUpfront,
  issuerListSort,
  quotedLevel,
  lastTradeOf,
  noLevelMessage,
  noTradesMessage,
  sortIssuers,
  sortTrades,
  spreadSummary,
  summarizeIssuers,
  withSpreadLevels,
  type CdsIssuerSummary,
  type CdsQuoteUnit,
  type CdsSpreadLevels,
  type CdsTrade,
} from "./model";

const numberOrNull = (value: unknown) => (typeof value === "number" ? value : null);
const unitOf = (row: HeadlessPaneRow): CdsQuoteUnit => (row.unit === "pts" ? "pts" : "bp");

/**
 * A level and its moves are numbers with their unit beside them, as the
 * index board's are: bp, or `pts` for a name quoted in points upfront. Text
 * draws them as the pane does (`409bp`, `57.7 pts`, `+10.9 pts`); exports
 * write the number and name the unit.
 */
const quotedColumn = (key: string, header: string, move: boolean): HeadlessPaneColumn => ({
  key,
  header,
  align: "right",
  unitKey: "unit",
  textFormat: (value, row) => (move ? formatQuotedMove : formatQuoted)(unitOf(row), numberOrNull(value)),
});

const ISSUER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "issuer", header: "Issuer" },
  { key: "trades", header: "Trades", align: "right" as const },
  { key: "lastTradeAt", header: "Last UTC", shrink: false, format: (value: unknown) => formatEventTime(Number(value)) },
  quotedColumn("level", "5Y", false),
  quotedColumn("change1W", "1W", true),
  quotedColumn("change1M", "1M", true),
  { key: "spread5yDate", header: "5Y date", shrink: false, format: (value: unknown) => (typeof value === "string" ? value : "--") },
];

/**
 * A listed issuer as the report keeps it: its level and moves as quoted, with
 * their unit, beside the level in bp it always has. It is dated by its 5Y
 * level's day (JPM's can be weeks before its last trade), or by its last
 * trade without one.
 */
function issuerRow(row: CdsIssuerSummary): HeadlessPaneRow {
  const quoted = quotedLevel(row);
  return {
    key: row.key,
    issuer: row.issuer,
    trades: row.trades,
    lastTradeAt: row.lastTradeAt,
    latestSpreadBp: row.latestSpreadBp,
    spread5yBp: row.spread5yBp,
    spread5yDate: row.spread5yDate,
    quote: row.quote,
    level: quoted.level,
    change1W: quoted.change1w,
    change1M: quoted.change1m,
    unit: quoted.unit,
    ...(row.quote === "upfront" ? { couponBp: row.couponBp } : {}),
    asOf: row.spread5yDate ?? row.lastTradeAt,
  };
}

/** Days of a named issuer's daily 5Y levels the report lists; the line holds two years. */
const DAILY_DAYS = { defaultValue: 365, minimum: 30, maximum: 730 };

/**
 * Each day's 5Y level on the contract on the run that day, newest first,
 * over the last `days`: the chart as a table, which `--csv --section daily`
 * exports. Its key is `day`, not `date`, so the history is not read as the
 * report's own observation dates. Each exported row is the name's, dated by
 * its own day, in the unit the line is quoted in (`bp`, or `pts` upfront).
 */
function dailySection(history: CdsSpreadHistory, days: number, name: string): HeadlessBundleSection {
  const latest = history.points.at(-1)?.date;
  const from = latest ? new Date(Date.parse(`${latest}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10) : "";
  // A name quoted upfront lists each day's points beside its spread.
  const upfront = history.quote === "upfront";
  return {
    title: "Daily",
    columns: [
      { key: "day", header: "Date" },
      { key: "spreadBp", header: "5Y spread", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
      ...(upfront ? [{
        key: "upfrontPts",
        header: "5Y upfront",
        align: "right" as const,
        unitKey: "unit",
        textFormat: (value: unknown) => formatPoints(numberOrNull(value)),
      }] : []),
      { key: "prints", header: "Prints", align: "right" as const },
      { key: "maturity", header: "Contract", format: (value: unknown) => formatContract(typeof value === "string" ? value : null) },
    ],
    rows: history.points.filter((point) => point.date > from).reverse()
      .map((point) => ({
        day: point.date,
        spreadBp: point.spreadBp,
        ...(upfront ? { upfrontPts: point.upfrontPts ?? null } : {}),
        unit: upfront ? "pts" : "bp",
        prints: point.prints,
        maturity: point.maturity,
      })),
    empty: "No daily 5Y levels.",
    symbol: name,
    rowUnitKey: "unit",
    rowAsOfKey: "day",
  };
}

function tradeForFormatting(row: Record<string, unknown>): CdsTrade {
  return row as unknown as CdsTrade;
}

const TRADE_COLUMNS = [
  { key: "eventAt", header: "Time UTC", shrink: false, format: (value: unknown) => formatEventTime(Number(value)) },
  { key: "issuer", header: "Issuer" },
  { key: "maturity", header: "Maturity" },
  {
    key: "notional",
    header: "Notional",
    align: "right" as const,
    format: (_value: unknown, row: Record<string, unknown>) => formatNotional(tradeForFormatting(row)),
  },
  { key: "currency", header: "CCY" },
  { key: "couponBp", header: "Coupon", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
  { key: "spreadBp", header: "Spread", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
  {
    key: "upfront",
    header: "Abs upfront",
    align: "right" as const,
    format: (_value: unknown, row: Record<string, unknown>) => formatUpfront(tradeForFormatting(row)),
  },
];

/**
 * The pane's figures over its 5Y chart, as label and value lines: the level,
 * its date, the 1W and 1M moves through the roll and the range charted, in
 * bp, or for a name quoted upfront in points with its coupon. JSON keeps the
 * numbers; text and CSV read as the pane does.
 */
function spreadEntries(history: CdsSpreadHistory): HeadlessPaneEntry[] {
  const summary = spreadSummary(history);
  if (!summary) return [];
  const { unit } = summary;
  const range = summary.range ? {
    key: "range",
    label: "Range",
    value: unit === "pts"
      ? { lowPts: summary.range.low, highPts: summary.range.high, since: summary.range.since }
      : { lowBp: summary.range.low, highBp: summary.range.high, since: summary.range.since },
    formatted: `${formatSpreadRange(unit, summary.range)} since ${summary.range.since}`,
  } : null;
  if (unit === "pts") {
    return [
      { key: "upfrontPts", label: "5Y upfront", value: summary.level, formatted: formatPoints(summary.level), unit: "pts" },
      { key: "couponBp", label: "Coupon", value: summary.couponBp, formatted: formatBp(summary.couponBp) },
      { key: "date", label: "Date", value: summary.date },
      { key: "change1wPts", label: "1W change", value: summary.change1w, formatted: formatPointsMove(summary.change1w), unit: "pts" },
      { key: "change1mPts", label: "1M change", value: summary.change1m, formatted: formatPointsMove(summary.change1m), unit: "pts" },
      ...(range ? [range] : []),
    ];
  }
  return [
    { key: "spreadBp", label: "5Y spread", value: summary.level, formatted: formatBp(summary.level) },
    { key: "date", label: "Date", value: summary.date },
    { key: "change1wBp", label: "1W change", value: summary.change1w, formatted: formatSpreadMove(summary.change1w) },
    { key: "change1mBp", label: "1M change", value: summary.change1m, formatted: formatSpreadMove(summary.change1m) },
    ...(range ? [range] : []),
  ];
}

interface CdsReportInputs {
  activity: CdsActivity;
  /** The issuer's 5Y line, or the error that kept it out. */
  history?: CdsSpreadHistory | Error | null;
  /** Each listed issuer's 5Y level, or the error that kept them out. */
  levels?: CdsSpreadLevels | Error | null;
  /** The list's `--sort`. */
  sort?: unknown;
  /** Days of the issuer's daily levels listed. */
  days?: number;
}

function projectCdsHeadless({ activity, history, levels, sort, days = DAILY_DAYS.defaultValue }: CdsReportInputs): HeadlessBundleResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const empty = noTradesMessage({ query: activity.query, issuer: activity.issuer, days: activity.days });
  const metadata = { issuer: activity.issuer, days: activity.days };
  if (activity.query) {
    const line = history instanceof Error || !history ? null : history;
    if (history instanceof Error) errors.push("5Y spread history unavailable.");
    const entries = line ? spreadEntries(line) : [];
    // The name the tape was queried for heads the figures, as in the pane, so a ticker says what it became.
    const name = displayIssuerName(activity.issuer ?? line?.issuer ?? activity.query);
    const why = line ? noLevelMessage(line.noLevelReason, line.points.at(-1)?.date ?? null) : null;
    if (why) notes.push(`${why}.`);
    else if (line && entries.length === 0) notes.push(`No 5Y spread level for ${name} in the last two years.`);
    // The 5Y figures are dated by their level's day, each trade and each daily level by its own.
    const levelDate = line ? spreadSummary(line)?.date : undefined;
    const sections: HeadlessBundleSection[] = [
      ...(entries.length ? [{ title: name, entries, symbol: name, ...(levelDate ? { asOf: levelDate } : {}) }] : []),
      {
        title: "Trades",
        columns: TRADE_COLUMNS,
        rows: sortTrades(activity.trades, DEFAULT_TRADE_SORT).map((trade) => ({ ...trade })),
        empty,
        rowSymbolKey: "issuer",
        rowUnitKey: "currency",
        rowAsOfKey: "eventAt",
      },
      ...(line?.points.length ? [dailySection(line, days, name)] : []),
    ];
    return {
      sections,
      metadata: {
        ...metadata,
        ...(line?.noLevelReason ? { noLevelReason: line.noLevelReason } : {}),
        ...(line?.points.length ? { quote: spreadSummary(line)!.unit === "pts" ? "upfront" : "spread" } : {}),
      },
      freshness: cdsFreshness(lastTradeOf(activity.trades, line?.points)),
      ...(errors.length ? { errors } : {}),
      ...(notes.length ? { notes } : {}),
    };
  }
  if (levels instanceof Error) errors.push("5Y spreads unavailable.");
  const issuers = withSpreadLevels(summarizeIssuers(activity.trades), levels instanceof Error ? null : levels ?? null);
  return {
    sections: [{
      title: "Issuers",
      columns: ISSUER_COLUMNS,
      rows: sortIssuers(issuers, issuerListSort(sort)).map(issuerRow),
      empty,
      // Each row is its issuer's, in the unit it is quoted in (bp, or pts upfront), on its own day.
      rowSymbolKey: "issuer",
      rowUnitKey: "unit",
      rowAsOfKey: "asOf",
    }],
    metadata: { ...metadata, sort: issuerListSort(sort).columnId },
    freshness: cdsFreshness(lastTradeOf(activity.trades)),
    ...(errors.length ? { errors } : {}),
  };
}

function settled<T>(pending: Promise<T>): Promise<T | Error> {
  return pending.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
}

export interface CdsHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    issuer: string | null,
    fetchCds: CdsFetch,
    searchInstruments: InstrumentSearch,
  ): Promise<CdsActivity>;
  loadHistory?(issuer: string, fetchHistory: CdsHistoryFetch): Promise<CdsSpreadHistory>;
  loadLevels?: typeof loadCdsSpreadLevels;
}

const defaultDependencies: CdsHeadlessDependencies = {
  load: (_args, issuer, fetchCds, searchInstruments) => (
    loadCdsActivity(issuer, fetchCds, searchInstruments)
  ),
  loadHistory: (issuer, fetchHistory) => loadCdsSpreadHistory(issuer, fetchHistory),
  loadLevels: loadCdsSpreadLevels,
};

export function createCdsHeadless(
  dependencies: CdsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  const loadHistory = dependencies.loadHistory ?? defaultDependencies.loadHistory!;
  const loadLevels = dependencies.loadLevels ?? defaultDependencies.loadLevels!;
  return {
    shape: "bundle",
    description: `Single-name CDS from DTCC public dissemination. With no argument: the issuers traded in the last ${CDS_TRADE_DAYS} days, most active first (or by --sort), with trade count, last trade, 5Y spread and its 1W and 1M moves through the roll, shown while the level is within 5 trading days of the tape. Past 2,000bp a name is quoted in points upfront (58.2 pts), moves too, and ranks after the bp names. With a ticker or issuer: its 5Y spread (level, date, 1W and 1M change, range), its trades and its daily 5Y levels; --csv --section daily exports those levels.`,
    freshness: cdsFreshness(null),
    argument: {
      kind: "free-text",
      placeholder: "ticker or issuer",
      description: "Optional ticker or issuer. Omit to list the most-active issuers with their 5Y spread and moves.",
      optional: true,
    },
    options: [
      {
        key: "sort",
        type: "enum",
        settingKey: "sort",
        values: ISSUER_LIST_SORTS.map((value) => ({ value })),
        defaultValue: "trades",
        description: "Issuer list order, largest first: trades, 5Y spread, or its 1W or 1M move. Names quoted in points rank after the bp names, names without one last.",
        example: "--sort 1m",
        exampleWithoutArgument: true,
      },
      {
        key: "days",
        type: "integer",
        ...DAILY_DAYS,
        shot: { reportOnly: "sets how many days of an issuer's daily 5Y levels the report lists" },
        description: "Days of a named issuer's daily 5Y levels, the report's Daily section (fn CDS F --csv --section daily).",
      },
    ],
    describe: (args) => typeof args.argument === "string" ? `CDS | ${args.argument}` : "Single-Name CDS",
    async load(args, ctx) {
      const issuer = typeof args.argument === "string" ? args.argument : null;
      const fetchHistory: CdsHistoryFetch = (params) => ctx.apiClient.getCloudCdsHistory(params);
      const fetchLevels: CdsLevelsFetch = () => ctx.apiClient.getCloudCdsLevels();
      // The list's levels are one request for every issuer, read beside its trades.
      const levels = issuer?.trim() ? null : settled(loadLevels(fetchLevels));
      const activity = await dependencies.load(
        args,
        issuer,
        (params) => ctx.apiClient.getCloudCds(params),
        (query, limit) => ctx.apiClient.searchInstruments(query, limit),
      );
      if (activity.query) {
        // The line follows the name the tape was queried for, as the pane's does.
        const history = activity.issuer ? await settled(loadHistory(activity.issuer, fetchHistory)) : null;
        return projectCdsHeadless({ activity, history, days: Number(args.options.days ?? DAILY_DAYS.defaultValue) });
      }
      return projectCdsHeadless({ activity, levels: await levels, sort: args.options.sort });
    },
  };
}

export const cdsHeadless = createCdsHeadless();
