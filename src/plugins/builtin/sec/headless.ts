import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { SecFilingItem } from "../../../types/data-provider";
import { loadSecFilings } from "./client";
import { filterFilingsByForms, SEC_FILING_FETCH_LIMIT } from "./forms";
import { buildSecFilingRows, secFilingIssuers, SEC_ACCEPTANCE_NOTE } from "./model";

const SEC_COLUMNS: HeadlessPaneColumn[] = [
  {
    key: "filedAt",
    header: "Filed",
    format: (value) => typeof value === "string" ? value.slice(0, 10) : "-",
  },
  { key: "acceptanceReported", header: "SEC-reported acceptance" },
  { key: "form", header: "Form" },
  { key: "companyName", header: "Issuer" },
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

export interface SecHeadlessOptions {
  /** Keep only these forms, searched across every filing the service returns for the issuer. */
  forms?: readonly string[];
  title?: string;
  argumentDescription?: string;
}

export function createSecHeadless(
  dependencies: SecHeadlessDependencies = defaultDependencies,
  { forms, title = "SEC Filings", argumentDescription = "US equity ticker." }: SecHeadlessOptions = {},
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      placeholder: "ticker",
      description: argumentDescription,
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
    describe: (args) => `${title} | ${args.symbols[0]}`,
    async load(args, ctx) {
      const symbol = args.symbols[0]!;
      const limit = Number(args.options.limit);
      if (!forms) {
        const filings = await dependencies.loadFilings(symbol, limit, args, ctx);
        return {
          rows: buildSecFilingRows(filings).slice(0, limit),
          metadata: { acceptanceNote: SEC_ACCEPTANCE_NOTE, symbol, returned: Math.min(filings.length, limit), issuers: secFilingIssuers(filings.slice(0, limit)) },
        };
      }
      const issuerFilings = await dependencies.loadFilings(symbol, SEC_FILING_FETCH_LIMIT, args, ctx);
      const filings = filterFilingsByForms(issuerFilings, forms).slice(0, limit);
      return {
        rows: buildSecFilingRows(filings),
        // A full page of issuer filings can hide older matches past it.
        complete: issuerFilings.length < SEC_FILING_FETCH_LIMIT,
        metadata: {
          acceptanceNote: SEC_ACCEPTANCE_NOTE,
          symbol,
          returned: filings.length,
          forms: [...forms],
          searchedFilings: issuerFilings.length,
          issuers: secFilingIssuers(filings),
        },
      };
    },
  };
}

export const secHeadless = createSecHeadless();
