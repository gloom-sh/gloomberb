import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { SecFilingItem } from "../../../types/data-provider";
import { loadSecFilings } from "./client";
import { buildSecFilingRows } from "./model";

const SEC_COLUMNS: HeadlessPaneColumn[] = [
  {
    key: "filedAt",
    header: "Filed",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : "-",
  },
  { key: "form", header: "Form" },
  { key: "filing", header: "Filing" },
  { key: "items", header: "Items" },
  { key: "accessionNumber", header: "Accession" },
];

export interface SecHeadlessDependencies {
  loadFilings(
    symbol: string,
    limit: number,
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<SecFilingItem[]>;
}

const defaultDependencies: SecHeadlessDependencies = {
  loadFilings: (symbol, limit, _args, ctx) => loadSecFilings(ctx.marketData, symbol, limit),
};

export function createSecHeadless(
  dependencies: SecHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: "US equity ticker.",
    },
    options: [{
      key: "limit",
      aliases: ["count", "rows"],
      description: "Maximum recent filings.",
      type: "integer",
      defaultValue: 50,
      minimum: 1,
      maximum: 200,
    }],
    columns: SEC_COLUMNS,
    describe: (args) => `SEC Filings | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const limit = Number(args.options.limit);
      const filings = await dependencies.loadFilings(symbol, limit, args, ctx);
      return {
        rows: buildSecFilingRows(filings).slice(0, limit),
        metadata: { symbol, returned: Math.min(filings.length, limit) },
      };
    },
  };
}

export const secHeadless = createSecHeadless();
