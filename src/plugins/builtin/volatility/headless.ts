import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import {
  loadVolatilityData,
  type VolatilityLoadResult,
  type VolatilitySeriesLoader,
} from "./client";
import type { VolatilityData } from "./model";

function formattedValue(value: number | null, digits = 2): string {
  return value == null ? "-" : value.toFixed(digits);
}

export function projectVolatilityHeadless(data: VolatilityData): HeadlessBundleResult {
  return {
    sections: [
      {
        title: "Term structure",
        entries: [
          { label: "State", value: data.termState },
          { label: "As of", value: data.termDate },
          { label: "3M / 30D", value: data.ratio, formatted: formattedValue(data.ratio) },
          { label: "3M spread", value: data.slope, formatted: data.slope == null ? "-" : `${data.slope > 0 ? "+" : ""}${data.slope.toFixed(2)} pts` },
        ],
      },
      {
        title: "Volatility tenors",
        columns: [
          { key: "label", header: "Index" },
          { key: "tenor", header: "Tenor" },
          { key: "value", header: "Close", align: "right", format: (value) => formattedValue(value as number | null) },
          { key: "date", header: "As of" },
          { key: "title", header: "Series" },
        ],
        rows: data.metrics.map((metric) => ({ ...metric })),
      },
    ],
  };
}

export interface VolatilityHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, loader: VolatilitySeriesLoader): Promise<VolatilityLoadResult>;
}

const defaultDependencies: VolatilityHeadlessDependencies = {
  load: (_args, loader) => loadVolatilityData(false, loader),
};

export function createVolatilityHeadless(
  dependencies: VolatilityHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    argument: { kind: "none" },
    options: [],
    describe: "VIX 30D/3M Curve",
    async load(args, ctx) {
      const result = await dependencies.load(
        args,
        (seriesId, options) => ctx.apiClient.getCloudFredSeries(seriesId, options),
      );
      const projected = projectVolatilityHeadless(result.data);
      return {
        ...projected,
        errors: result.errors,
        metadata: { stale: result.stale },
      };
    },
  };
}

export const volatilityHeadless = createVolatilityHeadless();
