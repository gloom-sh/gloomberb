import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact, formatNumber } from "../../../utils/format";
import { fetchShortInterest } from "./client";
import {
  buildRows,
  sortRows,
  type SortPreference,
} from "./model";
import type { ShortInterestRecord } from "./types";

const SHORT_INTEREST_COLUMNS: HeadlessPaneColumn[] = [
  { key: "settlementDate", header: "Date" },
  {
    key: "sharesShort",
    header: "Shares Short",
    align: "right",
    format: (value) => formatCompact(Number(value)),
  },
  {
    key: "daysToCover",
    header: "Days to Cover",
    align: "right",
    format: (value) => value == null ? "-" : formatNumber(Number(value), 2),
  },
  {
    key: "averageDailyVolume",
    header: "Avg Daily Vol",
    align: "right",
    format: (value) => value == null ? "-" : formatCompact(Number(value)),
  },
  {
    key: "shortPercentFloat",
    header: "% Float",
    align: "right",
    format: (value) => value == null ? "-" : `${formatNumber(Number(value), 2)}%`,
  },
];

export interface ShortInterestHeadlessDependencies {
  loadRecords(
    symbol: string,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<ShortInterestRecord[]>;
}

const defaultDependencies: ShortInterestHeadlessDependencies = {
  loadRecords: (symbol, _args, ctx) => fetchShortInterest(symbol, ctx.apiClient),
};

export function createShortInterestHeadless(
  dependencies: ShortInterestHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "US equity ticker.",
    },
    options: [
      {
        key: "order",
        description: "Settlement date order.",
        type: "enum",
        values: [{ value: "newest" }, { value: "oldest" }],
        defaultValue: "newest",
      },
      {
        key: "limit",
        aliases: ["count", "rows"],
        description: "Maximum settlement rows.",
        type: "integer",
        defaultValue: 24,
        minimum: 1,
        maximum: 100,
      },
    ],
    columns: SHORT_INTEREST_COLUMNS,
    describe: (args) => `Short Interest | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const records = await dependencies.loadRecords(symbol, args, ctx);
      const preference: SortPreference = {
        columnId: "settlementDate",
        direction: args.options.order === "oldest" ? "asc" : "desc",
      };
      const limit = Number(args.options.limit);
      const rows = sortRows(buildRows(records), preference)
        .slice(0, limit)
        .map((row) => ({
          settlementDate: row.settlementDate,
          sharesShort: row.record.sharesShort,
          daysToCover: row.record.shortRatio,
          averageDailyVolume: row.record.averageDailyVolume,
          shortPercentFloat: row.record.shortPercentFloat,
        }));
      return {
        rows,
        metadata: { symbol, order: args.options.order },
      };
    },
  };
}

export const shortInterestHeadless = createShortInterestHeadless();
