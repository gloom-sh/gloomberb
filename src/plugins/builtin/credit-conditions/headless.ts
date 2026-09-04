import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import {
  loadCreditConditions,
  type CreditConditionsLoadResult,
  type CreditSeriesLoader,
} from "./client";

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

export interface CreditConditionsHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, loader: CreditSeriesLoader): Promise<CreditConditionsLoadResult>;
}

const defaultDependencies: CreditConditionsHeadlessDependencies = {
  load: (_args, loader) => loadCreditConditions(false, loader),
};

export function createCreditConditionsHeadless(
  dependencies: CreditConditionsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: { kind: "none" },
    options: [],
    columns: COLUMNS,
    describe: "Credit Spreads",
    async load(args, ctx) {
      const result = await dependencies.load(
        args,
        (seriesId, options) => ctx.apiClient.getCloudFredSeries(seriesId, options),
      );
      return {
        rows: result.rows.map((row) => ({ ...row })),
        errors: result.errors,
        metadata: { stale: result.stale },
      };
    },
  };
}

export const creditConditionsHeadless = createCreditConditionsHeadless();
