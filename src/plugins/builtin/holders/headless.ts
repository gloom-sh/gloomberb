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
import { SEC_FILINGS } from "../shared/report-freshness";
import {
  holderValueBasis,
  holdersHeaderLine,
  moneyColumnHeader,
  nonUsHolderCaveat,
  sharedReportDate,
} from "./report-header";

/** Columns a source fills only when it reports the quarter's change. */
const CHANGE_COLUMN_KEYS = new Set(["changeShares", "changePercent"]);

const HOLDER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "name", header: "Holder" },
  { key: "ownerType", header: "Type" },
  {
    key: "value",
    header: "Mkt value",
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
    header: "Period",
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
    freshness: { ...SEC_FILINGS, basis: "13F filings" },
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
      {
        key: "view",
        description: "Rendered pane view: the holder table or the ownership treemap.",
        type: "enum",
        values: [{ value: "table" }, { value: "chart" }],
        defaultValue: "table",
        pluginState: { pluginId: "ticker-research", key: "viewMode" },
      },
    ],
    columns: HOLDER_COLUMNS,
    describe: (args) => `Holders | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const { data, marketCap } = await dependencies.loadSnapshot(symbol, args, ctx);
      const currency = data.currency ?? "USD";
      const sorted = sortRows(buildRows(data), {
        columnId: SORT_COLUMNS[String(args.options.sort)] ?? "value",
        direction: args.options.order === "asc" ? "asc" : "desc",
      }, marketCap);
      const rows = sorted
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
      const total = data.summary?.institutionsCount ?? null;
      const changeReported = rows.some((row) => row.changeShares != null || row.changePercent != null);
      const reportDate = sharedReportDate(rows);
      const valueBasis = holderValueBasis(reportDate);
      const positionsBasis = rows.length > 0 ? nonUsHolderCaveat(data.exchange, currency) : null;
      // The title names the ticker and the closing line carries the as-of date.
      const header = holdersHeaderLine({
        name: data.name,
        symbol: data.symbol && data.symbol !== symbol ? data.symbol : null,
        exchange: data.exchange,
        currency,
        shown: rows.length,
        reported: sorted.length,
        total,
      });
      const basis = rows.length === 0 ? null : [
        `Mkt value = ${valueBasis}.`,
        changeReported ? "" : `Change vs prior quarter: not reported by this source; see fn 13F ${symbol}`,
      ].filter(Boolean).join(" ");
      return {
        // A change column that is empty on every row says nothing; the line above explains it once.
        columns: HOLDER_COLUMNS
          .filter((column) => changeReported || !CHANGE_COLUMN_KEYS.has(column.key))
          .map((column) => column.key === "value" ? { ...column, header: moneyColumnHeader(column.header, currency) } : column),
        rows,
        metadata: {
          symbol: data.symbol || symbol,
          name: data.name ?? null,
          exchange: data.exchange ?? null,
          currency,
          asOf: data.asOf ?? null,
          summary: data.summary ?? null,
          shown: rows.length,
          reported: sorted.length,
          total,
          truncated: rows.length < (total ?? sorted.length),
          valueBasis,
          changeReported,
          positionsBasis,
          notices: [header, basis, positionsBasis].filter((line): line is string => !!line),
        },
      };
    },
  };
}

export const holdersHeadless = createHoldersHeadless();
