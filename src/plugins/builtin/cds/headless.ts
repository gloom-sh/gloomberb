import type {
  HeadlessBundleResult,
  HeadlessBundleSection,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneLoadArgs,
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
  formatSpreadMove,
  formatSpreadRange,
  formatUpfront,
  issuerListSort,
  lastTradeOf,
  noLevelMessage,
  noTradesMessage,
  sortIssuers,
  sortTrades,
  spreadSummary,
  summarizeIssuers,
  withSpreadLevels,
  type CdsSpreadLevels,
  type CdsTrade,
} from "./model";

const moveOf = (value: unknown) => formatSpreadMove(typeof value === "number" ? value : null);

const ISSUER_COLUMNS = [
  { key: "issuer", header: "Issuer" },
  { key: "trades", header: "Trades", align: "right" as const },
  { key: "lastTradeAt", header: "Last UTC", shrink: false, format: (value: unknown) => formatEventTime(Number(value)) },
  { key: "spread5yBp", header: "5Y spread", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
  { key: "change1wBp", header: "1W", align: "right" as const, format: moveOf },
  { key: "change1mBp", header: "1M", align: "right" as const, format: moveOf },
  { key: "spread5yDate", header: "5Y date", shrink: false, format: (value: unknown) => (typeof value === "string" ? value : "--") },
];

/** Days of a named issuer's daily 5Y levels the report lists; the line holds two years. */
const DAILY_DAYS = { defaultValue: 365, minimum: 30, maximum: 730 };

/**
 * Each day's 5Y level on the contract on the run that day, newest first,
 * over the last `days`: the chart as a table, which `--csv --section daily`
 * exports. Its key is `day`, not `date`, so the history is not read as the
 * report's own observation dates.
 */
function dailySection(history: CdsSpreadHistory, days: number): HeadlessBundleSection {
  const latest = history.points.at(-1)?.date;
  const from = latest ? new Date(Date.parse(`${latest}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10) : "";
  return {
    title: "Daily",
    columns: [
      { key: "day", header: "Date" },
      { key: "spreadBp", header: "5Y spread", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
      { key: "prints", header: "Prints", align: "right" as const },
      { key: "maturity", header: "Contract", format: (value: unknown) => formatContract(typeof value === "string" ? value : null) },
    ],
    rows: history.points.filter((point) => point.date > from).reverse()
      .map((point) => ({ day: point.date, spreadBp: point.spreadBp, prints: point.prints, maturity: point.maturity })),
    empty: "No daily 5Y levels.",
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
 * its date, the 1W and 1M moves through the roll and the range charted.
 * JSON keeps the numbers; text and CSV read as the pane does.
 */
function spreadEntries(history: CdsSpreadHistory): HeadlessPaneEntry[] {
  const summary = spreadSummary(history);
  if (!summary) return [];
  return [
    { key: "spreadBp", label: "5Y spread", value: summary.spreadBp, formatted: formatBp(summary.spreadBp) },
    { key: "date", label: "Date", value: summary.date },
    { key: "change1wBp", label: "1W change", value: summary.change1wBp, formatted: formatSpreadMove(summary.change1wBp) },
    { key: "change1mBp", label: "1M change", value: summary.change1mBp, formatted: formatSpreadMove(summary.change1mBp) },
    ...(summary.range ? [{
      key: "range",
      label: "Range",
      value: summary.range,
      formatted: `${formatSpreadRange(summary.range)} since ${summary.range.since}`,
    }] : []),
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
    const sections: HeadlessBundleSection[] = [
      ...(entries.length ? [{ title: name, entries }] : []),
      {
        title: "Trades",
        columns: TRADE_COLUMNS,
        rows: sortTrades(activity.trades, DEFAULT_TRADE_SORT).map((trade) => ({ ...trade })),
        empty,
      },
      ...(line?.points.length ? [dailySection(line, days)] : []),
    ];
    return {
      sections,
      metadata: { ...metadata, ...(line?.noLevelReason ? { noLevelReason: line.noLevelReason } : {}) },
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
      rows: sortIssuers(issuers, issuerListSort(sort)).map((issuerRow) => ({ ...issuerRow })),
      empty,
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
    description: `Single-name CDS from DTCC public dissemination. With no argument: the issuers traded in the last ${CDS_TRADE_DAYS} days, most active first (or by --sort), with trade count, last trade, 5Y spread and its 1W and 1M moves through the roll. With a ticker or issuer: its 5Y spread (level, date, 1W and 1M change, range), its trades and its daily 5Y levels; --csv --section daily exports those levels.`,
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
        description: "Issuer list order, largest first: trades, 5Y spread, or its 1W or 1M move.",
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
