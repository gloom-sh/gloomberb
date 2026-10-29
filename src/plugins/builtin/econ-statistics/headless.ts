import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
} from "../../../types/plugin";
import { servedFromSavedCopy } from "../../../data/saved-copies";
import { fredSourceLabel } from "../../../sources/gloomberb-cloud/fred-series";
import { formatBasisPoints, toBasisPoints } from "../../../utils/basis-points";
import { formatNumber } from "../../../utils/format";
import type { StatDef } from "./defs";
import {
  createStatSeriesLoader,
  loadStatsBundle,
  unansweredErrors,
  type StatsBundle,
} from "./client";
import { historyStartNotice } from "../shared/history-span";
import { formatMoveRank } from "../shared/move-rank";
import type { StatPoint } from "../shared/stat-transform";
import { formatSigma } from "../shared/trend";
import { STAT_CATEGORIES } from "./defs";
import { DEFAULT_STAT_ID, readStatArg, STATS } from "./stats";
import { selectStatViews, type StatRangeId, type StatViewModel } from "./view";

/** How a report reads a statistic: a spread in basis points, everything else as the pane does. */
function reportFormat(stat: StatDef): (value: number) => string {
  return stat.basisPoints ? (value) => formatBasisPoints(value) : stat.formatValue;
}

/**
 * `cutoffShown`: the status line names when in the day the reading was taken, so the period does not repeat it.
 * `text` is the report's text lines, where Previous says its period beside it; exports give the period a line of its own.
 */
function detailEntries(view: StatViewModel, cutoffShown: boolean, text: boolean): HeadlessPaneEntry[] {
  const format = reportFormat(view.stat);
  return [
    { label: "Latest", value: view.latest.value, formatted: format(view.latest.value) },
    {
      label: "Previous",
      value: view.previous?.value ?? null,
      formatted: view.previous ? `${format(view.previous.value)}${text && view.previousReading ? ` (${view.previousReading})` : ""}` : "-",
      ...earlierDating(view, view.previous),
    },
    ...!text && view.previous ? [{ label: "Previous period", value: view.previous.date, formatted: view.previousReading ?? view.previous.date, ...earlierDating(view, view.previous) }] : [],
    {
      label: "1Y ago",
      value: view.yearAgo?.value ?? null,
      formatted: view.yearAgo ? format(view.yearAgo.value) : "-",
      ...earlierDating(view, view.yearAgo),
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
    // A figure dated by its period also says when it was released: "Sep 2026, released Tue 20 Oct".
    { label: "Period", value: view.latest.date, formatted: view.stat.cutoff && !cutoffShown ? `${view.reading} ${view.stat.cutoff}` : view.readingReleased },
    { label: "Source", value: fredSourceLabel(view.stat.seriesId) },
  ];
}

/** A statistic answered from the copy saved by an earlier read, its refresh having failed, says so in its row. */
function savedCopyRow<T extends object>(view: StatViewModel, row: T): T {
  return view.cacheSource === "stale-fallback" && view.fetchedAt != null ? servedFromSavedCopy(row, view.fetchedAt) : row;
}

/** The window the %ile column counts over, in words. */
const PERCENTILE_WINDOW: Record<StatRangeId, string> = {
  "5Y": "the last 5 years",
  "20Y": "the last 20 years",
  ALL: "the full history",
};

/**
 * An earlier reading's own dating (previous, a year ago): its period, no release (the server dates only the
 * latest print's), and its own day for as-of when the series is observed daily or weekly. A reading there is
 * none of is of no period, never the latest's.
 */
function earlierDating(view: StatViewModel, point: StatPoint | null): Pick<HeadlessPaneEntry, "period" | "released" | "asOf"> {
  return { period: point?.date ?? null, released: null, asOf: point && !view.periodicity ? point.date : null };
}

/** The period a statistic's lines cover and the day they were released, for the `period` and `released` of each exported line. */
function exportDating(view: StatViewModel): { period: string; released?: string; asOf: string | null } {
  return { period: view.latest.date, ...(view.releasedOn ? { released: view.releasedOn } : {}), asOf: exportAsOf(view) };
}

/**
 * What an exported row is as of: the day its figure was released, else its own
 * day when it is observed daily or weekly (a Treasury yield), and nothing when
 * the date only starts the period it covers.
 */
function exportAsOf(view: StatViewModel): string | null {
  return view.releasedOn ?? (view.periodicity ? null : view.latest.date);
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
    // The text table keeps the columns a terminal has room for; exports add what each figure is of.
    const columns = (text: boolean) => [
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
      // Which period Previous is: exports carry it beside the figure, the text table has its Period column for the latest.
      ...text ? [] : [{ key: "previousPeriod", header: "Previous period" }],
      {
        key: "percentile",
        header: "%ile",
        align: "right" as const,
        format: (value: unknown) => formatNumber(Number(value), 0),
      },
      // `period` and `released` are the names every dated export gives these (`econ`, `fred`).
      { key: "asOf", header: "period", literalHeader: true, textHeader: "Period", format: (_value: unknown, row: Record<string, unknown>) => String(row.reading) },
      {
        key: "releasedOn",
        header: "released",
        literalHeader: true,
        textHeader: "Released",
        format: (_value: unknown, row: Record<string, unknown>) => typeof row.released === "string" ? row.released.replace(/^released /, "") : "",
      },
    ];
    return [{
      title: category.label,
      columns: columns(false),
      textColumns: columns(true),
      // `as_of` is the release; a figure with none stated is as of its own day when it is observed daily or weekly, never its period's first day.
      rowAsOfKey: "exportAsOf",
      rows: categoryViews.map((view) => savedCopyRow(view, {
        id: view.stat.id,
        indicator: view.stat.shortLabel,
        latest: view.latest.value,
        formattedLatest: reportFormat(view.stat)(view.latest.value),
        previous: view.previous?.value ?? null,
        formattedPrevious: view.previous ? reportFormat(view.stat)(view.previous.value) : "-",
        previousPeriod: view.previous?.date ?? null,
        // A spread's values stay in percentage points; these carry the figures its text shows.
        ...(view.stat.basisPoints ? {
          latestBasisPoints: toBasisPoints(view.latest.value),
          previousBasisPoints: view.previous ? toBasisPoints(view.previous.value) : null,
        } : {}),
        percentile: view.percentile,
        // The period the figure covers; `releasedOn` is when it was published, which the report is as of.
        asOf: view.latest.date,
        releasedOn: view.releasedOn,
        exportAsOf: exportAsOf(view),
        ...(view.periodicity ? { periodicity: view.periodicity } : {}),
        reading: view.reading,
        released: view.released,
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
      ...(selected ? [{
        title: selected.stat.label,
        entries: detailEntries(selected, cutoff != null, false),
        textEntries: detailEntries(selected, cutoff != null, true),
        ...exportDating(selected),
      }] : []),
    ],
    // A statistic answered from its saved copy says so in the source line, not as an error.
    errors: unansweredErrors(bundle),
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
  exportDated: true,
  argument: {
    kind: "free-text",
    placeholder: "statistic",
    description: "Optional statistic id, name (PCE, GDP), label, FRED series id, or prefix.",
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
    const read = typeof args.argument === "string" ? readStatArg(args.argument) : null;
    const requested = read?.stat ?? null;
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
    const report = projectStatsHeadlessBundle(bundle, range, requested?.id ?? DEFAULT_STAT_ID);
    return read?.readAs ? { ...report, warnings: [read.readAs] } : report;
  },
};
