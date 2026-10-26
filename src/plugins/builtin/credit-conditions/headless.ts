import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import {
  loadCreditConditions,
  type CreditConditionsLoadResult,
  type CreditSeriesLoader,
} from "./client";
import { creditRegion, creditSeriesIn, type CreditConditionRow } from "./model";

const COLUMNS = [
  { key: "label", header: "Index" },
  { key: "seriesId", header: "FRED series" },
  { key: "oasBp", header: "OAS", align: "right" as const, format: (value: unknown) => `${Number(value).toFixed(1)}bp` },
  {
    key: "dailyChangeBp",
    header: "1D",
    align: "right" as const,
    format: (value: unknown) => value == null ? "-" : `${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(1)}bp`,
  },
  { key: "date", header: "As of" },
];

/** What the publisher caps the indexes' history at, said once for the report. */
function historyLimits(rows: readonly CreditConditionRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.historyLimit ? [row.historyLimit] : []))];
}

interface CreditConditionsHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, loader: CreditSeriesLoader): Promise<CreditConditionsLoadResult>;
}

const defaultDependencies: CreditConditionsHeadlessDependencies = {
  load: (args, loader) => loadCreditConditions(false, loader, creditSeriesIn(creditRegion(args.options.region))),
};

function createCreditConditionsHeadless(
  dependencies: CreditConditionsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: { kind: "none" },
    options: [{
      key: "region",
      description: "Indexes to list. FRED publishes euro high yield but no euro investment grade spread.",
      type: "enum",
      values: [
        { value: "all" },
        { value: "us", aliases: ["usa", "united states", "america"] },
        { value: "euro", aliases: ["eu", "eur", "europe", "eurozone", "euro area", "ea"] },
      ],
      defaultValue: "all",
    }],
    columns: COLUMNS,
    describe: "Credit Spreads",
    freshness: { source: "FRED", status: "not-a-feed", basis: "daily index levels", cadence: "daily", observedKey: "date" },
    async load(args, ctx) {
      const result = await dependencies.load(
        args,
        (seriesId, options) => ctx.apiClient.getCloudFredSeries(seriesId, options),
      );
      return {
        // The year of history feeds the pane's chart and rank, not the report rows.
        rows: result.rows.map(({ history: _history, historyLimit: _historyLimit, ...row }) => row),
        notes: historyLimits(result.rows),
        errors: result.errors,
        metadata: { stale: result.stale },
      };
    },
  };
}

export const creditConditionsHeadless = createCreditConditionsHeadless();
