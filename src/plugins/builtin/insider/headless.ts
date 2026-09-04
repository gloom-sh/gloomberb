import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { formatCompact, formatCurrency } from "../../../utils/format";
import { loadParsedInsiderFilings } from "./client";
import {
  buildInsiderRows,
  buildInsiderSummary,
  type ParsedInsiderFiling,
} from "./model";

const INSIDER_COLUMNS: HeadlessPaneColumn[] = [
  {
    key: "filingDate",
    header: "Filed",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : "-",
  },
  {
    key: "transactionDate",
    header: "Tx",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : "-",
  },
  { key: "insider", header: "Insider" },
  { key: "title", header: "Title" },
  { key: "side", header: "Side" },
  {
    key: "shares",
    header: "Shares",
    align: "right",
    format: (value) => value == null ? "-" : formatCompact(Number(value)),
  },
  {
    key: "pricePerShare",
    header: "Price",
    align: "right",
    format: (value) => value == null ? "-" : formatCurrency(Number(value)),
  },
  {
    key: "totalValue",
    header: "Value",
    align: "right",
    format: (value) => value == null ? "-" : formatCurrency(Number(value)),
  },
];

export interface InsiderHeadlessDependencies {
  loadParsed(
    symbol: string,
    limit: number,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<ParsedInsiderFiling[]>;
}

const defaultDependencies: InsiderHeadlessDependencies = {
  loadParsed: (symbol, limit, _args, ctx) => loadParsedInsiderFilings(ctx.marketData, symbol, {
    limit,
    signal: ctx.signal,
  }),
};

export function createInsiderHeadless(
  dependencies: InsiderHeadlessDependencies = defaultDependencies,
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
        key: "name",
        description: "Exact reporting owner name.",
        type: "string",
        defaultValue: "",
        pluginState: { pluginId: "ticker-research", key: "nameFilter" },
      },
      {
        key: "limit",
        aliases: ["count", "rows"],
        description: "Maximum Form 4 filings to parse.",
        type: "integer",
        defaultValue: 20,
        minimum: 1,
        maximum: 100,
      },
    ],
    columns: INSIDER_COLUMNS,
    describe: (args) => `Insider Transactions | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const limit = Number(args.options.limit);
      const parsed = await dependencies.loadParsed(symbol, limit, args, ctx);
      const name = String(args.options.name ?? "").trim().toLocaleLowerCase();
      const filtered = name
        ? parsed.filter(({ transaction }) => transaction?.reportedName.toLocaleLowerCase() === name)
        : parsed;
      return {
        rows: buildInsiderRows(filtered),
        metadata: {
          symbol,
          summary: buildInsiderSummary(parsed),
          parsed: parsed.filter(({ transaction }) => transaction != null).length,
          requested: limit,
          name: name || null,
        },
      };
    },
  };
}

export const insiderHeadless = createInsiderHeadless();
