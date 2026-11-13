import { MISSING_VALUE } from "../../../utils/format";
import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { isTransientFailure } from "../../../api-client/errors";
import { servedFromSavedCopy } from "../../../data/saved-copies";
import { httpFetch } from "../../../utils/http-transport";
import { loadFearGreed, type FearGreedLoadResult } from "./cache";
import { fetchFearGreedData, type FearGreedData } from "./data";
import { formatIndicatorValue, formatScore, ratingLabel } from "./format";

function projectFearGreedHeadless(data: FearGreedData): HeadlessBundleResult {
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
            : MISSING_VALUE,
          updatedAt: indicator.updatedAt?.toISOString() ?? null,
        })),
      },
    ],
  };
}

/** `fn FNG` over a loaded reading, which the pane's footer also reads its source line from. */
export function fearGreedReport(result: FearGreedLoadResult): HeadlessBundleResult {
  // A copy kept for a refresh that could not get through (offline, a timeout) ends the report with when it was
  // saved, as other reports do; any other failure stays an error beside the old reading.
  const savedCopy = result.source === "stale-fallback" && isTransientFailure(result.error);
  const metadata = { fetchedAt: result.fetchedAt, stale: result.stale };
  return {
    ...projectFearGreedHeadless(result.data),
    ...(result.refreshError && !savedCopy ? { errors: [result.refreshError] } : {}),
    // A cached index the refresh could not replace is stale; otherwise CNN's published reading.
    freshness: { source: "CNN", status: result.stale ? "stale" : "not-a-feed", basis: "published index" },
    metadata: savedCopy ? servedFromSavedCopy(metadata, result.fetchedAt) : metadata,
  };
}

export interface FearGreedHeadlessDependencies {
  load(args: HeadlessPaneLoadArgs, signal: AbortSignal): Promise<FearGreedLoadResult>;
}

const defaultDependencies: FearGreedHeadlessDependencies = {
  load: (_args, signal) => loadFearGreed(false, () => fetchFearGreedData({
    fetcher: (url, init) => httpFetch(url, { ...init, signal }),
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
      return fearGreedReport(await dependencies.load(args, ctx.signal));
    },
  };
}

export const fearGreedHeadless = createFearGreedHeadless();
