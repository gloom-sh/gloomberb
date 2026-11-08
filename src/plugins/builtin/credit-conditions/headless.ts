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

const REGION_VALUES = [
  { value: "all" },
  { value: "us", aliases: ["usa", "united states", "america"] },
  { value: "euro", aliases: ["eu", "eur", "europe", "eurozone", "euro area", "ea"] },
  { value: "em", aliases: ["emerging", "emerging markets", "emerging market", "ems"] },
  { value: "asia", aliases: ["asian", "apac", "asia pacific", "asia em"] },
];

const regionToken = (text: string) => text.toLowerCase().replace(/[^a-z]/g, "");

/** A region as typed (`Asia`, `emerging markets`), as the option's value. */
function regionValue(text: string): string {
  const token = regionToken(text);
  const found = REGION_VALUES.find((region) => [region.value, ...region.aliases ?? []].some((name) => regionToken(name) === token));
  if (!found) throw new Error(`Invalid --region value "${text}". Use one or more of: ${REGION_VALUES.map(({ value }) => value).join(", ")}.`);
  return found.value;
}

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
      description: "Indexes to list, one region or several as a comma list. em is the emerging markets corporate indexes, Asia's among them; "
        + "FRED publishes euro high yield but no euro investment grade spread.",
      type: "enum",
      list: true,
      values: REGION_VALUES,
      defaultValue: "all",
      example: "--region asia,us",
      normalize: (value) => value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => regionValue(part)).join(","),
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
