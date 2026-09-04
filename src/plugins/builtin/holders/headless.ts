import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { loadHolderSnapshot } from "./client";
import {
  displayDate,
  formatHolderOwnershipPercent,
  formatMaybePercent,
  formatMoneyCompact,
  formatSignedCompact,
  resolveHolderOwnershipPercent,
} from "./format";
import { buildRows, sortRows } from "./table-model";
import type { HolderData } from "../../../types/financials";
import type { HolderColumnId } from "./types";

const HOLDER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "name", header: "Holder" },
  { key: "ownerType", header: "Type" },
  {
    key: "value",
    header: "Value",
    align: "right",
    format: (value, row) => formatMoneyCompact(
      value == null ? undefined : Number(value),
      String(row.currency ?? "USD"),
    ),
  },
  {
    key: "shares",
    header: "Amount",
    align: "right",
    format: (value) => value == null ? "-" : formatCompact(Number(value)),
  },
  {
    key: "changeShares",
    header: "Chg",
    align: "right",
    format: (value) => formatSignedCompact(value == null ? undefined : Number(value)),
  },
  {
    key: "changePercent",
    header: "Chg%",
    align: "right",
    format: (value) => formatMaybePercent(value == null ? undefined : Number(value)),
  },
  {
    key: "percentHeld",
    header: "Held",
    align: "right",
    format: (value) => formatHolderOwnershipPercent(value == null ? undefined : Number(value)),
  },
  {
    key: "reportDate",
    header: "Date",
    format: (value) => displayDate(typeof value === "string" ? value : undefined),
  },
];

const SORT_COLUMNS: Record<string, HolderColumnId> = {
  holder: "holder",
  value: "value",
  shares: "shares",
  change: "changeShares",
  "change-percent": "changePercent",
  held: "percentHeld",
  date: "reportDate",
};

interface HolderSnapshot {
  data: HolderData;
  marketCap?: number;
}

export interface HoldersHeadlessDependencies {
  loadSnapshot(
    symbol: string,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<HolderSnapshot>;
}

const defaultDependencies: HoldersHeadlessDependencies = {
  loadSnapshot: (symbol, _args, ctx) => loadHolderSnapshot(ctx.marketData, symbol),
};

export function createHoldersHeadless(
  dependencies: HoldersHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "Ticker whose institutional holders should be loaded.",
    },
    options: [
      {
        key: "sort",
        description: "Column used to sort holder rows.",
        type: "enum",
        values: Object.keys(SORT_COLUMNS).map((value) => ({ value })),
        defaultValue: "value",
      },
      {
        key: "order",
        description: "Sort direction.",
        type: "enum",
        values: [{ value: "desc" }, { value: "asc" }],
        defaultValue: "desc",
      },
      {
        key: "limit",
        aliases: ["count", "rows"],
        description: "Maximum holder rows.",
        type: "integer",
        defaultValue: 25,
        minimum: 1,
        maximum: 200,
      },
    ],
    columns: HOLDER_COLUMNS,
    describe: (args) => `Holders | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const { data, marketCap } = await dependencies.loadSnapshot(symbol, args, ctx);
      const currency = data.currency ?? "USD";
      const rows = sortRows(buildRows(data), {
        columnId: SORT_COLUMNS[String(args.options.sort)] ?? "value",
        direction: args.options.order === "asc" ? "asc" : "desc",
      }, marketCap)
        .slice(0, Number(args.options.limit))
        .map((row) => ({
          name: row.name,
          ownerType: row.ownerType,
          value: row.value ?? null,
          shares: row.shares ?? null,
          changeShares: row.changeShares ?? null,
          changePercent: row.changePercent ?? null,
          percentHeld: resolveHolderOwnershipPercent(row, marketCap) ?? null,
          reportDate: row.reportDate ?? null,
          currency,
        }));
      return {
        rows,
        metadata: {
          symbol: data.symbol || symbol,
          name: data.name ?? null,
          currency,
          asOf: data.asOf ?? null,
          summary: data.summary ?? null,
        },
      };
    },
  };
}

export const holdersHeadless = createHoldersHeadless();
