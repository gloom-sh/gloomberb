import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  EmptyState,
  InputSearchBar,
  SegmentedControl,
  Spinner,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableSelectionChangeReason,
  type PaneFooterSegment,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, type InputRenderable } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { getCachedStatsBundle, loadStatsBundle, type StatsBundle } from "./client";
import { categoryLabel, changeColor, type StatCategoryId } from "./defs";
import { StatDetail } from "./detail";
import { DEFAULT_STAT_ID } from "./stats";
import { selectStatViews, type StatRangeId, type StatViewModel } from "./view";

const SPLIT_MIN_WIDTH = 108;
const LIST_WIDTH = 46;

const RANGE_OPTIONS = [
  { value: "5Y" as const, label: "5Y" },
  { value: "20Y" as const, label: "20Y" },
  { value: "ALL" as const, label: "All" },
];

type LoadState =
  | { status: "idle" }
  | { status: "loading"; previous: StatsBundle | null }
  | { status: "ready"; bundle: StatsBundle }
  | { status: "error"; message: string; previous: StatsBundle | null };

type ColumnId = "name" | "latest" | "previous" | "percentile";
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

function bundleOf(state: LoadState): StatsBundle | null {
  switch (state.status) {
    case "idle":
      return null;
    case "loading":
    case "error":
      return state.previous;
    case "ready":
      return state.bundle;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
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
  return [
    { id: "name", label: "INDICATOR", width: Math.max(13, width - trailing - 6), align: "left" },
    { id: "latest", label: "LATEST", width: 10, align: "right" },
    { id: "previous", label: "PREV", width: 9, align: "right" },
    ...(withPercentile
      ? [{ id: "percentile" as const, label: "%ILE", width: 6, align: "right" as const }]
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
    percentile: { text: formatNumber(view.percentile, 0), color: colors.textMuted },
  };
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
  const [state, setState] = useState<LoadState>(() => {
    const cached = getCachedStatsBundle();
    return cached ? { status: "ready", bundle: cached } : { status: "idle" };
  });
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    setState((previous) => ({ status: "loading", previous: bundleOf(previous) }));
    try {
      const next = await loadStatsBundle();
      if (generation.current !== current) return;
      setState({ status: "ready", bundle: next });
      setLastUpdated(Date.now());
    } catch (error) {
      if (generation.current !== current) return;
      setState((previous) => ({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        previous: bundleOf(previous),
      }));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(() => { void load(); }, [load]);
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
      refresh();
      return true;
    }
    return false;
  }, [focusSearch, refresh]);

  useShortcut((event) => {
    if (!focused || searchFocused || event.name !== "r") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    refresh();
  });

  const bundle = bundleOf(state);
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

  const error = state.status === "error" ? state.message : bundle?.errors[0] ?? null;
  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    if (!selected) return [];
    const info: PaneFooterSegment[] = [
      { id: "as-of", parts: [{ text: `as of ${selected.latest.date}`, tone: "muted" }] },
    ];
    if (selected.observationStale) {
      info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
    }
    if (normalizedQuery) {
      info.push({ id: "filter", parts: [{ text: `filter: ${normalizedQuery}`, tone: "value" }] });
    }
    return info;
  }, [normalizedQuery, selected]);

  usePaneStatusFooter({
    registrationId: "econ-statistics",
    loading: state.status === "loading",
    error,
    info: footerInfo,
  });

  if (!bundle && state.status !== "error") {
    return (
      <Box width={width} height={height} justifyContent="center" alignItems="center">
        <Spinner label="Loading economic statistics..." />
      </Box>
    );
  }

  if (!selected) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState title="Economic statistics unavailable." message={error ?? undefined} />
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

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection={split ? "row" : "column"} flexGrow={1} overflow="hidden">
        <Box flexDirection="column" width={listWidth} flexShrink={0}>
          <InputSearchBar
            value={query}
            focused={focused}
            active={searchFocused}
            width={listWidth}
            focusToken={searchFocusToken}
            inputRef={searchInputRef}
            placeholder="filter statistics"
            debounceMs={80}
            onFocus={focusSearch}
            onBlur={blurSearch}
            onQueryChange={setQuery}
          />
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
              isNavigable={(row) => row.kind === "stat"}
              onHeaderClick={() => {}}
              onRootKeyDown={handlePaneKey}
              getItemKey={(row) => row.id}
              renderCell={(row, column) =>
                row.kind === "stat"
                  ? cellsFor(row.view)[column.id]
                  : { text: "" }}
              renderSectionHeader={(row) => (row.kind === "header"
                ? { text: categoryLabel(row.category), color: colors.textMuted }
                : null)}
              emptyStateTitle={normalizedQuery ? "No statistic matches." : error ?? "No statistics."}
            />
          </Box>
        </Box>

        <Box flexDirection="column" flexGrow={1} width={detailWidth} overflow="hidden">
          <Box flexDirection="row" height={1} paddingX={1} overflow="hidden" justifyContent="flex-end">
            <SegmentedControl
              options={RANGE_OPTIONS}
              value={range}
              onChange={(value) => setRange(value as StatRangeId)}
            />
          </Box>
          <ScrollBox flexGrow={1} scrollY focusable={false}>
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
      {error ? (
        <Box height={1} paddingX={1} overflow="hidden">
          <Text fg={colors.warning}>{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
