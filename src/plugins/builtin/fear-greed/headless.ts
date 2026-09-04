import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { loadFearGreed, type FearGreedLoadResult } from "./cache";
import { fetchFearGreedData, type FearGreedData } from "./data";
import { formatIndicatorValue, formatScore, ratingLabel } from "./format";

export function projectFearGreedHeadless(data: FearGreedData): HeadlessBundleResult {
  return {
    sections: [
      {
        title: "Fear & Greed Index",
        entries: [
          { label: "Score", value: data.overall.score, formatted: formatScore(data.overall.score) },
          { label: "Rating", value: data.overall.rating, formatted: ratingLabel(data.overall.rating) },
          { label: "Previous close", value: data.overall.previousClose, formatted: formatScore(data.overall.previousClose) },
          { label: "1 week ago", value: data.overall.previousWeek, formatted: formatScore(data.overall.previousWeek) },
          { label: "1 month ago", value: data.overall.previousMonth, formatted: formatScore(data.overall.previousMonth) },
          { label: "1 year ago", value: data.overall.previousYear, formatted: formatScore(data.overall.previousYear) },
          { label: "Updated at", value: data.overall.updatedAt?.toISOString() ?? null },
        ],
      },
      {
        title: "Indicators",
        columns: [
          { key: "indicator", header: "Indicator" },
          { key: "score", header: "Score", align: "right", format: (value) => formatScore(value as number | null) },
          { key: "rating", header: "Rating" },
          { key: "latest", header: "Latest", align: "right" },
          { key: "secondary", header: "Comparison", align: "right" },
          { key: "updatedAt", header: "Updated at" },
        ],
        rows: data.indicators.map((indicator) => ({
          id: indicator.definition.id,
          indicator: indicator.definition.title,
          description: indicator.definition.subtitle,
          score: indicator.score,
          rating: indicator.rating,
          latestValue: indicator.latestValue,
          latest: formatIndicatorValue(indicator.latestValue, indicator.definition.valueFormat),
          secondaryValue: indicator.latestSecondaryValue,
          secondary: indicator.definition.secondaryLabel && indicator.latestSecondaryValue != null
            ? `${indicator.definition.secondaryLabel}: ${formatIndicatorValue(indicator.latestSecondaryValue, indicator.definition.valueFormat)}`
            : "-",
          updatedAt: indicator.updatedAt?.toISOString() ?? null,
        })),
      },
    ],
  };
}

export interface FearGreedHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, signal: AbortSignal): Promise<FearGreedLoadResult>;
}

const defaultDependencies: FearGreedHeadlessDependencies = {
  load: (_args, signal) => loadFearGreed(false, () => fetchFearGreedData({
    fetcher: ((input, init) => fetch(input, { ...init, signal })) as typeof fetch,
  })),
};

export function createFearGreedHeadless(
  dependencies: FearGreedHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    argument: { kind: "none" },
    options: [],
    describe: "Fear & Greed",
    async load(args, ctx) {
      const result = await dependencies.load(args, ctx.signal);
      const projected = projectFearGreedHeadless(result.data);
      return {
        ...projected,
        ...(result.refreshError ? { errors: [result.refreshError] } : {}),
        metadata: { fetchedAt: result.fetchedAt, stale: result.stale },
      };
    },
  };
}

export const fearGreedHeadless = createFearGreedHeadless();
