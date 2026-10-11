import type { DataProvider } from "../../../types/data-provider";
import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import { EXTENDED_SESSION_LABELS, getQuoteSessionFields, marketStateLabel, type ExtendedSession } from "../../../market-data/market/status";
import type { MarketState } from "../../../types/financials";
import { loadWorldIndexQuotes, NOT_IN_FEED, type WorldIndexQuoteResult } from "./client";
import {
  getIndicesByRegion,
  REGION_LABELS,
  REGION_ORDER,
  WORLD_INDICES,
  type IndexEntry,
} from "./indices";
import { quoteFreshnessFields } from "../shared/report-freshness";

/** A row for an index the feed does not carry has no figures to print; its last column says why. */
const isGap = (row: Record<string, unknown>) => row.unavailable === true;

const COLUMNS = [
  { key: "shortName", header: "Index", shrink: false },
  { key: "name", header: "Name" },
  {
    key: "price",
    header: "Last",
    align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => isGap(row) ? "" : value == null
      ? "-"
      : formatNumber(Number(value), 2),
  },
  {
    key: "change",
    header: "Change",
    align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => isGap(row) ? "" : value == null ? "-" : `${Number(value) >= 0 ? "+" : ""}${formatNumber(Number(value), 2)}`,
  },
  {
    key: "changePercent",
    header: "Change %",
    align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => isGap(row) ? "" : value == null ? "-" : formatPercentRaw(Number(value)),
  },
  {
    key: "marketState",
    header: "Session",
    shrink: false,
    format: (value: unknown, row: Record<string, unknown>) => isGap(row) ? "" : typeof value === "string" && value ? marketStateLabel(value as MarketState) ?? value : "-",
  },
  {
    key: "lastUpdated",
    header: "Updated",
    shrink: false,
    format: (value: unknown, row: Record<string, unknown>) => {
      const time = value == null ? Number.NaN : Number(value);
      return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC` : isGap(row) ? NOT_IN_FEED : "-";
    },
  },
];

/** A pre-market or after-hours print and its move from the regular close, for a row that has one. */
function extendedColumn(session: ExtendedSession) {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => row.extendedSession === session && typeof value === "number"
      ? `${formatNumber(value, 2)} ${formatPercentRaw(typeof row.extendedChangePercent === "number" ? row.extendedChangePercent : undefined)}`
      : isGap(row) ? "" : "-",
  };
}

/** The table's columns, with an extended column after Change % only where a row has such a print. */
function sectionColumns(rows: readonly Record<string, unknown>[]) {
  const sessions = (["PRE", "POST"] as const).filter((session) => rows.some((row) => row.extendedSession === session));
  return sessions.length === 0 ? COLUMNS : [...COLUMNS.slice(0, 5), ...sessions.map(extendedColumn), ...COLUMNS.slice(5)];
}

function projectWorldIndicesHeadless(
  entries: readonly IndexEntry[],
  loaded: WorldIndexQuoteResult,
): HeadlessBundleResult {
  const grouped = getIndicesByRegion(entries);
  const isGapEntry = (entry: IndexEntry) => loaded.gaps.has(entry.symbol) && !loaded.quotes.get(entry.symbol);
  return {
    sections: REGION_ORDER.flatMap((region) => {
      const regionEntries = grouped.get(region) ?? [];
      if (regionEntries.length === 0) return [];
      const rows = regionEntries.map((entry) => {
        const quote = loaded.quotes.get(entry.symbol);
        // Last and Change are the regular session, as `ticker` reads them.
        const { price, change, changePercent, ...extended } = getQuoteSessionFields(quote);
        return {
          ...quoteFreshnessFields(quote),
          ...entry,
          price,
          unit: "index points",
          currency: quote?.currency ?? null,
          change,
          changePercent,
          ...extended,
          marketState: quote?.marketState ?? null,
          lastUpdated: quote?.lastUpdated ?? null,
          ...(isGapEntry(entry) ? { unavailable: true } : {}),
        };
      });
      return [{ title: REGION_LABELS[region], columns: sectionColumns(rows), rows }];
    }),
    errors: loaded.errors,
    // A symbol the feed lacks is a gap in the data, not a failure: its row says so, and the report is not whole.
    ...(entries.some(isGapEntry) ? { unavailableSymbols: entries.filter(isGapEntry).map((entry) => entry.symbol) } : {}),
    metadata: {
      requested: entries.length,
      available: [...loaded.quotes.values()].filter(Boolean).length,
    },
  };
}

interface WorldIndicesHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    entries: readonly IndexEntry[],
    provider: DataProvider,
  ): Promise<WorldIndexQuoteResult>;
}

const defaultDependencies: WorldIndicesHeadlessDependencies = {
  load: (_args, entries, provider) => loadWorldIndexQuotes(entries, provider),
};

function createWorldIndicesHeadless(
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
