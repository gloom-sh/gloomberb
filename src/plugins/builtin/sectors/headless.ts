import type { DataProvider } from "../../../types/data-provider";
import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { loadSectorRows, type SectorRowOutcome } from "./client";
import { getSectorCollection, type SectorCollectionId, type SectorDef } from "./sector-data";
import { DEFAULT_SORT_PREFERENCE, sectorRowIssues, sortRows, type SectorRow } from "./sector-model";

const COLUMNS = [
  { key: "name", header: "Sector" },
  { key: "etf", header: "ETF" },
  { key: "price", header: "Last", align: "right" as const, format: (value: unknown, row: Record<string, unknown>) => value == null ? "-" : formatCurrency(Number(value), String(row.currency)) },
  { key: "changePercent", header: "1D", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value)) },
  { key: "return1M", header: "1M", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value)) },
  { key: "return1Y", header: "1Y", align: "right" as const, format: (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value)) },
];

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
    quoteIssue: byEtf.get(definition.etf)?.quoteIssue ?? null,
    lastReportedPrice: byEtf.get(definition.etf)?.lastReportedPrice ?? null,
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
    argument: { kind: "none" },
    options: [{
      key: "collection",
      description: "Sector or industry ETF collection.",
      type: "enum",
      values: [{ value: "sectors" }, { value: "industries" }],
      defaultValue: "sectors",
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
      return {
        unavailableSymbols: unavailableSymbols.length > 0 ? unavailableSymbols : undefined,
        errors: rows.flatMap((row) => sectorRowIssues(row).map((issue) => `${row.etf}: ${issue}.`)),
        rows: rows.map((row) => ({ ...row })),
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
