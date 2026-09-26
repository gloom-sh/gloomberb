import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
} from "../../../types/plugin";
import { formatNumber } from "../../../utils/format";
import {
  createStatSeriesLoader,
  loadStatsBundle,
  type StatsBundle,
} from "./client";
import { STAT_CATEGORIES } from "./defs";
import { DEFAULT_STAT_ID, resolveStatArg, STATS } from "./stats";
import { selectStatViews, type StatRangeId, type StatViewModel } from "./view";

function signedSigma(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value, 1)}σ`;
}

function detailEntries(view: StatViewModel): HeadlessPaneEntry[] {
  const format = view.stat.formatValue;
  return [
    { label: "Latest", value: view.latest.value, formatted: format(view.latest.value) },
    {
      label: "Previous",
      value: view.previous?.value ?? null,
      formatted: view.previous ? format(view.previous.value) : "-",
    },
    {
      label: "1Y ago",
      value: view.yearAgo?.value ?? null,
      formatted: view.yearAgo ? format(view.yearAgo.value) : "-",
    },
    { label: "Mean", value: view.mean, formatted: format(view.mean) },
    {
      label: "Historical percentile",
      value: view.percentile,
      formatted: formatNumber(view.percentile, 0),
    },
    {
      label: "Trend deviation",
      value: view.sigmaVsTrend,
      formatted: signedSigma(view.sigmaVsTrend),
    },
    {
      label: "High",
      value: view.high,
      formatted: `${format(view.high.value)} ${view.high.date}`,
    },
    {
      label: "Low",
      value: view.low,
      formatted: `${format(view.low.value)} ${view.low.date}`,
    },
    { label: "As of", value: view.latest.date },
    { label: "Source", value: `FRED ${view.stat.seriesId}` },
  ];
}

export function projectStatsHeadlessBundle(
  bundle: StatsBundle,
  range: StatRangeId,
  selectedId: string,
): HeadlessBundleResult {
  const views = selectStatViews(bundle.builds, range);
  const selected = views.find((view) => view.stat.id === selectedId) ?? views[0] ?? null;
  const sections = STAT_CATEGORIES.flatMap((category) => {
    const categoryViews = views.filter((view) => view.stat.category === category.id);
    if (categoryViews.length === 0) return [];
    return [{
      title: category.label,
      columns: [
        { key: "indicator", header: "Indicator" },
        {
          key: "latest",
          header: "Latest",
          align: "right" as const,
          format: (_value: unknown, row: Record<string, unknown>) => String(row.formattedLatest),
        },
        {
          key: "previous",
          header: "Previous",
          align: "right" as const,
          format: (_value: unknown, row: Record<string, unknown>) => String(row.formattedPrevious),
        },
        {
          key: "percentile",
          header: "%ile",
          align: "right" as const,
          format: (value: unknown) => formatNumber(Number(value), 0),
        },
        { key: "asOf", header: "As of" },
      ],
      rows: categoryViews.map((view) => ({
        id: view.stat.id,
        indicator: view.stat.shortLabel,
        latest: view.latest.value,
        formattedLatest: view.stat.formatValue(view.latest.value),
        previous: view.previous?.value ?? null,
        formattedPrevious: view.previous ? view.stat.formatValue(view.previous.value) : "-",
        percentile: view.percentile,
        asOf: view.latest.date,
        stale: view.observationStale || view.cacheStale,
        fetchedAt: view.fetchedAt,
        cacheStale: view.cacheStale,
        cacheSource: view.cacheSource,
        refreshError: view.refreshError,
      })),
    }];
  });

  return {
    sections: [
      ...sections,
      ...(selected ? [{ title: selected.stat.label, entries: detailEntries(selected) }] : []),
    ],
    errors: bundle.errors,
    metadata: {
      fetchedAt: bundle.fetchedAt,
      fetchedAtComplete: bundle.fetchedAtComplete,
      range,
      selected: selected?.stat.id ?? null,
    },
  };
}

export const econStatisticsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "free-text",
    placeholder: "statistic",
    description: "Optional statistic id, FRED series id, label, or prefix.",
    optional: true,
  },
  options: [{
    key: "range",
    description: "History window used by the selected statistic view.",
    type: "enum",
    values: [{ value: "5Y" }, { value: "20Y" }, { value: "ALL", aliases: ["all"] }],
    defaultValue: "20Y",
  }],
  describe: (args) => `Economic Statistics | ${String(args.options.range)}`,
  async load(args, ctx) {
    const requested = typeof args.argument === "string" ? resolveStatArg(args.argument) : null;
    if (args.argument && !requested) {
      throw new Error(
        `Unknown economic statistic "${String(args.argument)}". Use one of: ${STATS.map(({ id }) => id).join(", ")}.`,
      );
    }
    const range = args.options.range as StatRangeId;
    const bundle = await loadStatsBundle({
      loader: createStatSeriesLoader(ctx.apiClient),
      ...(requested ? { stats: [requested] } : {}),
    });
    return projectStatsHeadlessBundle(bundle, range, requested?.id ?? DEFAULT_STAT_ID);
  },
};
