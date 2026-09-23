import { useCallback, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  EmptyState,
  PaneStatusBody, QueryBar, usePaneNoticeFooter, type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableSelectionChangeReason,
  type PaneFooterSegment
} from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, type InputRenderable } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { getCachedStatsBundle, loadStatsBundle } from "./client";
import { categoryLabel, changeColor, type StatCategoryId } from "./defs";
import { StatDetail } from "./detail";
import { DEFAULT_STAT_ID } from "./stats";
import { selectStatViews, type StatRangeId, type StatViewModel } from "./view";

const loadBundle = (force: boolean) => loadStatsBundle({ force });
const noop = () => {};

const SPLIT_MIN_WIDTH = 108;
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
  const nameWidth = width - trailing - 6 - (withPeriod ? PERIOD_WIDTH + 1 : 0);
  return [
    { id: "name", label: "INDICATOR", width: Math.max(NAME_MIN_WIDTH, nameWidth), align: "left" },
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
const isStatRow = (row: Row) => row.kind === "stat";
function renderRowCell(row: Row, column: Column): DataTableCell {
  return row.kind === "stat" ? cellsFor(row.view)[column.id] : { text: "" };
}
function renderRowSectionHeader(row: Row) {
  return row.kind === "header"
    ? { text: categoryLabel(row.category), color: colors.textMuted }
    : null;
}

/**
 * A commit that arrives while the chosen row is filtered away comes from the
 * table's deferred index, not from the user, so it must not rewrite the setting.
 */
export function shouldPersistStat({
  id,
  reason,
  selectionOnScreen,
  knownIds,
}: {
  id: string;
  reason: DataTableSelectionChangeReason;
  selectionOnScreen: boolean;
  knownIds: readonly string[];
}): boolean {
  if (!knownIds.includes(id)) return false;
  return reason !== "keyboard" || selectionOnScreen;
}

export function EconStatisticsPane({ focused, width, height }: PaneProps) {
  const [statId, setStatId] = usePaneSettingValue<string>("stat", DEFAULT_STAT_ID);
  const [range, setRange] = usePaneSettingValue<StatRangeId>("range", "20Y");
  const resource = useAsyncResource(loadBundle, { initialData: () => getCachedStatsBundle() });
  const { data: bundle, load: refresh, reload, updatedAt: lastUpdated } = resource;
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  useAutoRefresh(lastUpdated, refresh);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (isPlainKey(event, "/")) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    if (isPlainKey(event, "r")) {
      stopSearchFocusNavigation(event);
      reload();
      return true;
    }
    return false;
  }, [focusSearch, reload]);

  useShortcut((event) => {
    if (!focused || searchFocused || event.name !== "r") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    reload();
  });

  const views = useMemo(
    () => (bundle ? selectStatViews(bundle.builds, range) : []),
    [bundle, range],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () => views.filter((view) => matchesQuery(view, normalizedQuery)),
    [normalizedQuery, views],
  );
  const rows = useMemo(() => withCategoryHeaders(visible), [visible]);
  const selected = views.find((view) => view.stat.id === statId) ?? views[0] ?? null;
  const selectionOnScreen = visible.some((view) => view.stat.id === selected?.stat.id);

  const chooseStat = useCallback((id: string, reason: DataTableSelectionChangeReason) => {
    if (!shouldPersistStat({
      id,
      reason,
      selectionOnScreen,
      knownIds: views.map((view) => view.stat.id),
    })) return;
    setStatId(id);
  }, [selectionOnScreen, setStatId, views]);

  const error = resource.error ?? bundle?.errors[0] ?? null;
  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    if (!selected) return [];
    const info: PaneFooterSegment[] = [
      { id: "as-of", parts: [{ text: `as of ${selected.latest.date}`, tone: "muted" }] },
    ];
    if (selected.observationStale || selected.cacheStale) {
      info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
    }
    if (normalizedQuery) {
      info.push({ id: "filter", parts: [{ text: `filter: ${normalizedQuery}`, tone: "value" }] });
    }
    return info;
  }, [normalizedQuery, selected]);

  usePaneStatusFooter({
    registrationId: "econ-statistics",
    loading: resource.loading,
    error: selected ? null : error,
    info: footerInfo,
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
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState status={error ? "error" : "empty"} title="Economic statistics unavailable." message={error ?? undefined} />
      </Box>
    );
  }

  const split = width >= SPLIT_MIN_WIDTH;
  const listWidth = split ? Math.min(LIST_WIDTH, Math.floor(width * 0.4)) : width;
  const detailWidth = split ? width - listWidth : width;
  const columns = buildColumns(listWidth, !split);
  const tableHeight = split
    ? Math.max(3, height - 2)
    : Math.min(rows.length + 2, Math.max(3, height - 12));
  // The stacked list consumes real rows. Giving its detail scroller the whole
  // pane height leaves its lower content clipped outside the scroll viewport.
  const bodyHeight = Math.max(1, height - 1 - (error ? 1 : 0));
  const detailHeight = split ? bodyHeight : Math.max(1, bodyHeight - tableHeight);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar
        width={width}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "filter statistics",
          focused,
          active: searchFocused,
          onActiveChange: (active) => active ? focusSearch() : blurSearch(),
          focusToken: searchFocusToken,
          inputRef: searchInputRef,
          debounceMs: 80,
        }}
        view={{ value: range, options: RANGE_OPTIONS, onChange: (value: string) => setRange(value as StatRangeId) }}
      />
      <Box flexDirection={split ? "row" : "column"} flexGrow={1} overflow="hidden">
        <Box flexDirection="column" width={listWidth} flexShrink={0}>
          <Box flexDirection="column" width={listWidth} height={tableHeight} flexShrink={0} overflow="hidden">
            <DataTableView<Row, Column>
              focused={focused && !searchFocused}
              rootWidth={listWidth}
              rootHeight={tableHeight}
              columns={columns}
              items={rows}
              sortColumnId={null}
              sortDirection="asc"
              selection={{
                kind: "id",
                selectedId: selected.stat.id,
                getId: (row) => row.id,
                onChange: (id, _item, _index, reason) => chooseStat(String(id), reason),
              }}
              isNavigable={isStatRow}
              onHeaderClick={noop}
              onRootKeyDown={handlePaneKey}
              getItemKey={rowKey}
              renderCell={renderRowCell}
              renderSectionHeader={renderRowSectionHeader}
              emptyStateTitle={normalizedQuery ? "No statistic matches." : error ?? "No statistics."}
            />
          </Box>
        </Box>

        <Box flexDirection="column" flexGrow={1} width={detailWidth} height={detailHeight} overflow="hidden">
          <ScrollBox height={detailHeight} scrollY focusable={false}>
            <Box flexDirection="column" paddingBottom={1}>
              <StatDetail
                view={selected}
                width={detailWidth}
                height={Math.max(12, height - (split ? 3 : tableHeight + 3))}
                focused={focused && !searchFocused}
              />
            </Box>
          </ScrollBox>
        </Box>
      </Box>
    </Box>
  );
}
