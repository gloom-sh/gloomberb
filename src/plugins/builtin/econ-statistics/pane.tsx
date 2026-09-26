import { useMemo } from "react";
import {
  PaneStatusBody, useExternalLinkFooter, usePaneNoticeFooter, type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment
} from "../../../components";
import { fredSeriesUrl } from "../../../data/fred-series";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { formatNumber } from "../../../utils/format";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { SeriesListDetail, useSeriesList } from "../shared/series-list-detail";
import { getCachedStatsBundle, loadStatsBundle } from "./client";
import { categoryLabel, changeColor, type StatCategoryId } from "./defs";
import { StatDetail } from "./detail";
import { DEFAULT_STAT_ID } from "./stats";
import { selectStatViews, type StatRangeId, type StatViewModel } from "./view";

const loadBundle = (force: boolean) => loadStatsBundle({ force });

const LIST_WIDTH = 53;
const NAME_MIN_WIDTH = 13;
const PERIOD_WIDTH = 6;

const RANGE_OPTIONS = [
  { value: "5Y" as const, label: "5Y" },
  { value: "20Y" as const, label: "20Y" },
  { value: "ALL" as const, label: "All" },
];

type ColumnId = "name" | "latest" | "previous" | "period" | "percentile";
interface Column extends DataTableColumn { id: ColumnId }

/**
 * Category headings are rows, because the table renders a section header in place
 * of the item that declares it. Interleaving them keeps every statistic visible.
 */
type Row =
  | { kind: "header"; id: string; category: StatCategoryId }
  | { kind: "stat"; id: string; view: StatViewModel };

function withCategoryHeaders(views: readonly StatViewModel[]): Row[] {
  const rows: Row[] = [];
  let category: StatCategoryId | null = null;
  for (const view of views) {
    if (view.stat.category !== category) {
      category = view.stat.category;
      rows.push({ kind: "header", id: `header:${category}`, category });
    }
    rows.push({ kind: "stat", id: view.stat.id, view });
  }
  return rows;
}

function matchesQuery(view: StatViewModel, query: string): boolean {
  if (!query) return true;
  const haystack = [
    view.stat.label,
    view.stat.shortLabel,
    view.stat.seriesId,
    categoryLabel(view.stat.category),
    view.stat.note,
  ].join(" ").toLowerCase();
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

function buildColumns(width: number, stacked: boolean): Column[] {
  const withPercentile = !stacked || width >= 100;
  const trailing = 19 + (withPercentile ? 6 : 0);
  // Rows print at different cadences, so each value keeps its own period
  // whenever the name column can spare the room.
  const withPeriod = width - trailing - 6 - (PERIOD_WIDTH + 1) >= NAME_MIN_WIDTH;
  return [
    { id: "name", label: "INDICATOR", width: NAME_MIN_WIDTH, flexGrow: 1, align: "left" },
    { id: "latest", label: "LATEST", width: 10, align: "right" },
    { id: "previous", label: "PREV", width: 9, align: "right" },
    ...(withPercentile
      ? [{ id: "percentile" as const, label: "%ILE", width: 6, align: "right" as const }]
      : []),
    ...(withPeriod
      ? [{ id: "period" as const, label: "DATE", width: PERIOD_WIDTH, align: "right" as const }]
      : []),
  ];
}

/**
 * The previous print rather than the difference. For a statistic that is already a
 * change, like payrolls, a delta would be a second derivative and mean very little.
 */
function cellsFor(view: StatViewModel): Record<ColumnId, DataTableCell> {
  return {
    name: { text: view.stat.shortLabel, color: colors.textBright },
    latest: {
      text: view.stat.formatValue(view.latest.value),
      color: changeColor(view.stat.direction, view.changeOnPrevious),
    },
    previous: {
      text: view.previous ? view.stat.formatValue(view.previous.value) : "--",
      color: colors.textMuted,
    },
    period: { text: view.period, color: colors.textMuted },
    percentile: { text: formatNumber(view.percentile, 0), color: colors.textMuted },
  };
}

// Module-level so the table's memoized rows keep their identity across pane
// renders; an inline arrow would re-render every visible row on each keypress.
const rowKey = (row: Row) => row.id;
const statIdOf = (view: StatViewModel) => view.stat.id;
const isStatRow = (row: Row) => row.kind === "stat";
function renderRowCell(row: Row, column: Column): DataTableCell {
  return row.kind === "stat" ? cellsFor(row.view)[column.id] : { text: "" };
}
function renderRowSectionHeader(row: Row) {
  return row.kind === "header"
    ? { text: categoryLabel(row.category), color: colors.textMuted }
    : null;
}

export function EconStatisticsPane({ focused, width, height }: PaneProps) {
  const [statId, setStatId] = usePaneSettingValue<string>("stat", DEFAULT_STAT_ID);
  const [range, setRange] = usePaneSettingValue<StatRangeId>("range", "20Y");
  const resource = useAsyncResource(loadBundle, { initialData: () => getCachedStatsBundle() });
  const { data: bundle, load: refresh, reload, updatedAt: lastUpdated } = resource;
  useAutoRefresh(lastUpdated, refresh);

  const views = useMemo(
    () => (bundle ? selectStatViews(bundle.builds, range) : []),
    [bundle, range],
  );
  const list = useSeriesList({
    focused,
    items: views,
    getId: statIdOf,
    matchesQuery,
    selectedId: statId,
    onSelect: setStatId,
    reload,
    range: { value: range, options: RANGE_OPTIONS, onChange: setRange },
  });
  const { selected, searchFocused } = list;
  const rows = useMemo(() => withCategoryHeaders(list.visible), [list.visible]);

  const error = resource.error ?? bundle?.errors[0] ?? null;
  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    if (!selected) return [];
    const info: PaneFooterSegment[] = [
      { id: "as-of", parts: [{ text: `as of ${selected.latest.date}`, tone: "muted" }] },
    ];
    // The cached first paint is being replaced; its age only counts once that load fails.
    const seeding = resource.loading && resource.updatedAt === null && !selected.refreshError;
    if (selected.observationStale || (selected.cacheStale && !seeding)) {
      info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
    }
    return info;
  }, [resource.loading, resource.updatedAt, selected]);

  usePaneStatusFooter({
    registrationId: "econ-statistics",
    loading: resource.loading,
    error: selected ? null : error,
    info: footerInfo,
  });
  // `o` opens the selected statistic's official series page, the link under its chart.
  useExternalLinkFooter({
    registrationId: "econ-statistics:source",
    focused: focused && !searchFocused,
    url: selected ? fredSeriesUrl(selected.stat.seriesId) : null,
  });
  usePaneNoticeFooter({
    registrationId: "econ-statistics:notices",
    notices: error ? [error] : [],
    focused: focused && !searchFocused,
    enabled: !!selected,
    title: "Economic data",
  });

  if (!bundle && resource.error === null) {
    return (
      <PaneStatusBody loading align="center" width={width} height={height} loadingLabel="Loading economic statistics..." />
    );
  }

  if (!selected) {
    return (
      <PaneStatusBody
        error={error}
        errorTitle="Economic statistics unavailable."
        empty
        emptyTitle="Economic statistics unavailable."
      />
    );
  }

  return (
    <SeriesListDetail
      list={list}
      width={width}
      height={height}
      focused={focused}
      listWidth={LIST_WIDTH}
      searchPlaceholder="filter statistics"
      columns={buildColumns}
      rows={rows}
      getRowId={rowKey}
      renderCell={renderRowCell}
      isNavigable={isStatRow}
      renderSectionHeader={renderRowSectionHeader}
      emptyStateTitle={list.normalizedQuery ? "No statistic matches." : error ?? "No statistics."}
      renderDetail={(size) => <StatDetail view={selected} {...size} />}
    />
  );
}
