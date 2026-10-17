import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
} from "../../../types/plugin";
import { formatBasisPoints, toBasisPoints } from "../../../utils/basis-points";
import { formatNumber } from "../../../utils/format";
import type { StatDef } from "./defs";
import {
  createStatSeriesLoader,
  loadStatsBundle,
  type StatsBundle,
} from "./client";
import { historyStartNotice } from "../shared/history-span";
import { formatMoveRank } from "../shared/move-rank";
import { formatSigma } from "../shared/trend";
import { STAT_CATEGORIES } from "./defs";
import { DEFAULT_STAT_ID, resolveStatArg, STATS } from "./stats";
import { selectStatViews, type StatRangeId, type StatViewModel } from "./view";

/** How a report reads a statistic: a spread in basis points, everything else as the pane does. */
function reportFormat(stat: StatDef): (value: number) => string {
  return stat.basisPoints ? (value) => formatBasisPoints(value) : stat.formatValue;
}

/** `cutoffShown`: the status line names when in the day the reading was taken, so the period does not repeat it. */
function detailEntries(view: StatViewModel, cutoffShown: boolean): HeadlessPaneEntry[] {
  const format = reportFormat(view.stat);
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
      formatted: formatSigma(view.sigmaVsTrend),
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
    // A daily rate's last moves, in bp, ranked by size against every move since the series began.
    ...view.moves.map((move): HeadlessPaneEntry => ({
      label: `${move.horizon} move`,
      value: {
        date: move.date, from: move.from, change: move.change, changeBasisPoints: toBasisPoints(move.change),
        percentile: move.percentile, observations: move.observations, since: move.since,
      },
      formatted: [formatBasisPoints(move.change), formatMoveRank(move)].filter(Boolean).join(" · "),
    })),
    // FRED dates a monthly reading at the month's first day; the text says which period it is.
    // A Treasury yield adds when in the day it was taken, so it is not read against ^TNX's earlier close.
    { label: "Period", value: view.latest.date, formatted: view.stat.cutoff && !cutoffShown ? `${view.reading} ${view.stat.cutoff}` : view.reading },
    { label: "Source", value: `FRED ${view.stat.seriesId}` },
  ];
}

/** The window the %ile column counts over, in words. */
const PERCENTILE_WINDOW: Record<StatRangeId, string> = {
  "5Y": "the last 5 years",
  "20Y": "the last 20 years",
  ALL: "the full history",
};

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
        { key: "asOf", header: "Period", format: (_value: unknown, row: Record<string, unknown>) => String(row.reading) },
      ],
      rows: categoryViews.map((view) => ({
        id: view.stat.id,
        indicator: view.stat.shortLabel,
        latest: view.latest.value,
        formattedLatest: reportFormat(view.stat)(view.latest.value),
        previous: view.previous?.value ?? null,
        formattedPrevious: view.previous ? reportFormat(view.stat)(view.previous.value) : "-",
        // A spread's values stay in percentage points; these carry the figures its text shows.
        ...(view.stat.basisPoints ? {
          latestBasisPoints: toBasisPoints(view.latest.value),
          previousBasisPoints: view.previous ? toBasisPoints(view.previous.value) : null,
        } : {}),
        percentile: view.percentile,
        asOf: view.latest.date,
        reading: view.reading,
        stale: view.observationStale || view.cacheStale,
        fetchedAt: view.fetchedAt,
        cacheStale: view.cacheStale,
        cacheSource: view.cacheSource,
        refreshError: view.refreshError,
      })),
    }];
  });

  const notice = selected ? historyStartNotice(selected.stat.label, range, selected.span) : null;
  // Treasury yields alone (fn ECST 10Y) name when in the day they are taken, as GC does; a mixed table cannot.
  const cutoffs = new Set(views.map((view) => view.stat.cutoff));
  const cutoff = cutoffs.size === 1 ? [...cutoffs][0] : undefined;
  return {
    ...(cutoff ? { freshness: { ...ECST_FRESHNESS, schedule: cutoff } } : {}),
    sections: [
      ...sections,
      ...(selected ? [{ title: selected.stat.label, entries: detailEntries(selected, cutoff != null) }] : []),
    ],
    errors: bundle.errors,
    notes: [
      `%ile is the share of past readings at or below the latest one, over ${PERCENTILE_WINDOW[range]}.`
      + (range === "ALL" ? "" : " Full history: --range ALL."),
      ...(selected?.moves.length
        ? ["A move's pctl is the share of all 1D (or 1W) moves since that year that were smaller, ties counted half; --range does not change it."]
        : []),
    ],
    metadata: {
      fetchedAt: bundle.fetchedAt,
      fetchedAtComplete: bundle.fetchedAtComplete,
      range,
      selected: selected?.stat.id ?? null,
      // The dates the selected statistic's chart covers; its row's figures count over them.
      span: selected?.span ?? null,
      ...(notice ? { notices: [notice] } : {}),
    },
  };
}

// Each row checks its own release schedule and says when it is stale.
const ECST_FRESHNESS = { source: "FRED", status: "not-a-feed", basis: "published statistics" } as const;

export const econStatisticsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: ECST_FRESHNESS,
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
