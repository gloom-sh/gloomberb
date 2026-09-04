import type { DataProvider } from "../../../types/data-provider";
import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCurrency, formatNumber, formatPercentRaw } from "../../../utils/format";
import { loadWorldIndexQuotes, type WorldIndexQuoteResult } from "./client";
import {
  getIndicesByRegion,
  REGION_LABELS,
  REGION_ORDER,
  WORLD_INDICES,
  type IndexEntry,
} from "./indices";

const COLUMNS = [
  { key: "shortName", header: "Index" },
  { key: "name", header: "Name" },
  {
    key: "price",
    header: "Last",
    align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => value == null
      ? "-"
      : formatCurrency(Number(value), String(row.currency ?? "USD")),
  },
  {
    key: "change",
    header: "Change",
    align: "right" as const,
    format: (value: unknown) => value == null ? "-" : `${Number(value) >= 0 ? "+" : ""}${formatNumber(Number(value), 2)}`,
  },
  {
    key: "changePercent",
    header: "Change %",
    align: "right" as const,
    format: (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value)),
  },
  { key: "marketState", header: "Session" },
  {
    key: "lastUpdated",
    header: "Updated",
    format: (value: unknown) => value == null ? "-" : new Date(Number(value)).toISOString(),
  },
];

export function projectWorldIndicesHeadless(
  entries: readonly IndexEntry[],
  loaded: WorldIndexQuoteResult,
): HeadlessBundleResult {
  const grouped = getIndicesByRegion(entries);
  return {
    sections: REGION_ORDER.flatMap((region) => {
      const regionEntries = grouped.get(region) ?? [];
      if (regionEntries.length === 0) return [];
      return [{
        title: REGION_LABELS[region],
        columns: COLUMNS,
        rows: regionEntries.map((entry) => {
          const quote = loaded.quotes.get(entry.symbol);
          return {
            ...entry,
            price: quote?.price ?? null,
            currency: quote?.currency ?? null,
            change: quote?.change ?? null,
            changePercent: quote?.changePercent ?? null,
            marketState: quote?.marketState ?? null,
            lastUpdated: quote?.lastUpdated ?? null,
          };
        }),
      }];
    }),
    errors: loaded.errors,
    metadata: {
      requested: entries.length,
      available: [...loaded.quotes.values()].filter(Boolean).length,
    },
  };
}

export interface WorldIndicesHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    entries: readonly IndexEntry[],
    provider: DataProvider,
  ): Promise<WorldIndexQuoteResult>;
}

const defaultDependencies: WorldIndicesHeadlessDependencies = {
  load: (_args, entries, provider) => loadWorldIndexQuotes(entries, provider),
};

export function createWorldIndicesHeadless(
  dependencies: WorldIndicesHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    argument: { kind: "none" },
    options: [],
    describe: "World Equity Indices",
    async load(args, ctx) {
      const loaded = await dependencies.load(args, WORLD_INDICES, ctx.marketData);
      return projectWorldIndicesHeadless(WORLD_INDICES, loaded);
    },
  };
}

export const worldIndicesHeadless = createWorldIndicesHeadless();
