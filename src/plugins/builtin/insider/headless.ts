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
  buildInsiderDisclosureText,
  matchesInsiderOwner,
  type ParsedInsiderFiling,
} from "./model";
import { relevantInsiderAmendments } from "./amendments";

const INSIDER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "form", header: "Form" },
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
  { key: "security", header: "Security" },
  {
    key: "side",
    header: "Side",
    // A filing without transaction lines, matching the pane's "Form 4 disclosure" row.
    format: (value, row) => typeof value === "string" ? value : row.status === "disclosure" ? "DISCLOSURE" : "-",
  },
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
    format: (value) => value == null ? "-" : `$${formatCompact(Number(value))}`,
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
        description: "Maximum Form 4 and Form 4/A filings to parse.",
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
        ? parsed.filter((entry) => matchesInsiderOwner(entry, name))
        : parsed;
      const amendments = relevantInsiderAmendments(filtered, parsed);
      const incomplete = [...new Set(buildInsiderRows(parsed)
        .filter((row) => row.status !== "parsed" && row.status !== "disclosure")
        .map((row) => row.accessionNumber))];
      return {
        rows: buildInsiderRows(filtered, parsed),
        errors: [
          ...incomplete.map((accessionNumber) => `${accessionNumber}: Form 4 transactions are unavailable or incomplete.`),
          ...amendments.map((scope) => `${scope.accessionNumber}: Form 4/A is unreconciled; affected transaction totals are unavailable.`),
        ],
        metadata: {
          symbol,
          summary: buildInsiderSummary(filtered, Date.now(), parsed),
          amendments,
          notices: amendments.map((scope) => {
            const entry = parsed.find(({ filing }) => filing.accessionNumber === scope.accessionNumber)!;
            return [`Form 4/A ${scope.accessionNumber}${scope.originalFilingDate ? ` | Original filed ${scope.originalFilingDate}` : ""}`,
              buildInsiderDisclosureText(entry)].filter(Boolean).join("\n");
          }),
          parsed: new Set(parsed.filter(({ transaction }) => transaction != null).map(({ filing }) => filing.accessionNumber)).size,
          transactions: filtered.filter(({ transaction }) => transaction != null).length,
          requested: limit,
          name: name || null,
          limitations: ["Loaded Form 4 and Form 4/A rows are as filed, not reconciled transactions; affected aggregates are withheld."],
        },
      };
    },
  };
}

export const insiderHeadless = createInsiderHeadless();
