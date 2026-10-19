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
import {
  DEFAULT_ISSUER_SORT,
  DEFAULT_TRADE_SORT,
  cdsFreshness,
  displayIssuerName,
  formatBp,
  formatEventTime,
  formatNotional,
  formatSpreadChange,
  formatSpreadRange,
  formatUpfront,
  lastTradeOf,
  noTradesMessage,
  sortIssuers,
  sortTrades,
  spreadSummary,
  summarizeIssuers,
  withSpreadLevels,
  type CdsSpreadLevels,
  type CdsTrade,
} from "./model";

const ISSUER_COLUMNS = [
  { key: "issuer", header: "Issuer" },
  { key: "trades", header: "Trades", align: "right" as const },
  { key: "lastTradeAt", header: "Last UTC", shrink: false, format: (value: unknown) => formatEventTime(Number(value)) },
  { key: "spread5yBp", header: "5Y spread", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
  { key: "spread5yDate", header: "5Y date", shrink: false, format: (value: unknown) => (typeof value === "string" ? value : "--") },
];

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
 * its date, the 1M move on the same contract (`--` across a roll) and the
 * range charted. JSON keeps the numbers; text and CSV read as the pane does.
 */
function spreadEntries(history: CdsSpreadHistory): HeadlessPaneEntry[] {
  const summary = spreadSummary(history.points);
  if (!summary) return [];
  return [
    { key: "spreadBp", label: "5Y spread", value: summary.spreadBp, formatted: formatBp(summary.spreadBp) },
    { key: "date", label: "Date", value: summary.date },
    {
      key: "change1mBp",
      label: "1M change",
      value: summary.change1mBp,
      formatted: summary.change1mBp == null ? "--" : formatSpreadChange(summary.change1mBp),
    },
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
}

function projectCdsHeadless({ activity, history, levels }: CdsReportInputs): HeadlessBundleResult {
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
    if (line && entries.length === 0) notes.push(`No 5Y spread level for ${name} in the last two years.`);
    // The 5Y figures are dated by their level's day, each trade by its own time.
    const levelDate = line ? spreadSummary(line.points)?.date : undefined;
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
    ];
    return {
      sections,
      metadata,
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
      // A row is dated by its 5Y level's day (JPM's can be weeks before its last trade), or by its last trade without one.
      rows: sortIssuers(issuers, DEFAULT_ISSUER_SORT).map((issuerRow) => ({ ...issuerRow, asOf: issuerRow.spread5yDate ?? issuerRow.lastTradeAt })),
      empty,
      unit: "bp",
      rowSymbolKey: "issuer",
      rowAsOfKey: "asOf",
    }],
    metadata,
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
    description: `Single-name CDS from DTCC public dissemination. With no argument: the issuers traded in the last ${CDS_TRADE_DAYS} days, most active first, with trade count, last trade and 5Y spread. With a ticker or issuer: its 5Y spread (level, date, 1M change, range) and its trades.`,
    freshness: cdsFreshness(null),
    argument: {
      kind: "free-text",
      placeholder: "ticker or issuer",
      description: "Optional ticker or issuer. Omit to list the most-active issuers with their 5Y spread.",
      optional: true,
    },
    options: [],
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
        return projectCdsHeadless({ activity, history });
      }
      return projectCdsHeadless({ activity, levels: await levels });
    },
  };
}

export const cdsHeadless = createCdsHeadless();
