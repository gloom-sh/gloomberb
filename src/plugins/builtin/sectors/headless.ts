import type { DataProvider } from "../../../types/data-provider";
import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import { loadSectorRows, type SectorRowOutcome } from "./client";
import { getSectorCollection, type SectorCollectionId, type SectorDef } from "./sector-data";
import { DEFAULT_SORT_PREFERENCE, sectorExtendedSessions, sectorRowIssues, sortRows, type SectorRow } from "./sector-model";

const price = (value: unknown, row: Record<string, unknown>) => value == null ? "-" : formatCurrency(Number(value), String(row.currency));
const percent = (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value));

const LEAD_COLUMNS: HeadlessPaneColumn[] = [
  { key: "name", header: "Sector" },
  { key: "etf", header: "ETF" },
  { key: "price", header: "Last", align: "right", format: price },
  { key: "changePercent", header: "1D", align: "right", format: percent },
];
const RETURN_COLUMNS: HeadlessPaneColumn[] = [
  { key: "return1M", header: "1M", align: "right", format: percent },
  { key: "return1Y", header: "1Y", align: "right", format: percent },
];
const COLUMNS = [...LEAD_COLUMNS, ...RETURN_COLUMNS];

/** The pre-market or after-hours print and its move from the regular close, for the funds that have one. */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${price(value, row)} ${percent(row.extendedChangePercent)}`
      : "-",
  };
}

export function projectSectorRows(
  definitions: readonly SectorDef[],
  outcomes: readonly SectorRowOutcome[],
): SectorRow[] {
  const byEtf = new Map(outcomes.map((outcome) => [outcome.etf, outcome.row]));
  return sortRows(definitions.map((definition) => ({
    ...definition,
    price: byEtf.get(definition.etf)?.price ?? null,
    changePercent: byEtf.get(definition.etf)?.changePercent ?? null,
    return1M: byEtf.get(definition.etf)?.return1M ?? null,
    return1Y: byEtf.get(definition.etf)?.return1Y ?? null,
    currency: byEtf.get(definition.etf)?.currency ?? "USD",
    loading: false,
    quoteUnavailable: !byEtf.get(definition.etf) || byEtf.get(definition.etf)?.quoteUnavailable === true,
    quoteSessionDate: byEtf.get(definition.etf)?.quoteSessionDate ?? null,
    quoteUpdatedAt: byEtf.get(definition.etf)?.quoteUpdatedAt ?? null,
    quoteDataSource: byEtf.get(definition.etf)?.quoteDataSource,
    quoteIssue: byEtf.get(definition.etf)?.quoteIssue ?? null,
    lastReportedPrice: byEtf.get(definition.etf)?.lastReportedPrice ?? null,
    extendedSession: byEtf.get(definition.etf)?.extendedSession ?? null,
    extendedPrice: byEtf.get(definition.etf)?.extendedPrice ?? null,
    extendedChange: byEtf.get(definition.etf)?.extendedChange ?? null,
    extendedChangePercent: byEtf.get(definition.etf)?.extendedChangePercent ?? null,
    returnIntegrity: byEtf.get(definition.etf)?.returnIntegrity ?? {},
    returnAsOfDate: byEtf.get(definition.etf)?.returnAsOfDate ?? null,
    return1MStartDate: byEtf.get(definition.etf)?.return1MStartDate ?? null,
    return1YStartDate: byEtf.get(definition.etf)?.return1YStartDate ?? null,
  })), DEFAULT_SORT_PREFERENCE);
}

export interface SectorsHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    definitions: readonly SectorDef[],
    provider: DataProvider,
  ): Promise<SectorRowOutcome[]>;
}

const defaultDependencies: SectorsHeadlessDependencies = {
  load: (_args, definitions, provider) => loadSectorRows(definitions, provider),
};

export function createSectorsHeadless(
  dependencies: SectorsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    // Dated by each ETF's quote; the shared session date is the returns' end, not an observation.
    freshness: { observedKey: "quoteUpdatedAt" },
    argument: { kind: "none" },
    options: [{
      key: "collection",
      description: "Sector or industry ETF collection.",
      type: "enum",
      values: [{ value: "sectors" }, { value: "industries" }],
      defaultValue: "sectors",
      pluginState: { pluginId: "market-overview", key: "activeCollectionId" },
    }],
    columns: COLUMNS,
    describe: (args) => `Sector Performance | ${String(args.options.collection)}`,
    async load(args, ctx) {
      const collectionId = args.options.collection as SectorCollectionId;
      const definitions = getSectorCollection(collectionId).items;
      const outcomes = await dependencies.load(args, definitions, ctx.marketData);
      const rows = projectSectorRows(definitions, outcomes);
      const unavailableQuotes = rows.filter((row) => row.quoteUnavailable).map((row) => row.etf);
      const unavailableReturns = rows.filter((row) => row.return1M == null || row.return1Y == null).map((row) => row.etf);
      const unavailableDailyChanges = rows.filter((row) => row.changePercent == null).map((row) => row.etf);
      const unavailableSymbols = [...new Set([...unavailableQuotes, ...unavailableReturns, ...unavailableDailyChanges])];
      // Last and 1D are the regular session; an extended print gets a column only when a fund has one.
      const extendedSessions = sectorExtendedSessions(rows);
      return {
        ...(extendedSessions.length > 0
          ? { columns: [...LEAD_COLUMNS, ...extendedSessions.map(extendedColumn), ...RETURN_COLUMNS] }
          : {}),
        unavailableSymbols: unavailableSymbols.length > 0 ? unavailableSymbols : undefined,
        errors: rows.flatMap((row) => sectorRowIssues(row).map((issue) => `${row.etf}: ${issue}.`)),
        // The quote behind each row says whether it is real-time or delayed, and how current it is.
        rows: rows.map(({ quoteDataSource, ...row }) => ({
          ...row,
          ...(quoteDataSource === "live" || quoteDataSource === "delayed" ? { dataSource: quoteDataSource } : {}),
        })),
        metadata: {
          collection: collectionId,
          available: outcomes.filter((outcome) => outcome.row).length,
          requested: definitions.length,
          unavailableQuotes,
          unavailableReturns,
          unavailableDailyChanges,
          returnDefinition: "ETF price returns in listing currency; cash distributions are not reinvested. Shared ending session and calendar-month/year boundaries; prior close used for holidays.",
          returnWindows: rows.map((row) => ({ symbol: row.etf, asOfDate: row.returnAsOfDate, monthStartDate: row.return1MStartDate, yearStartDate: row.return1YStartDate })),
        },
      };
    },
  };
}

export const sectorsHeadless = createSectorsHeadless();
