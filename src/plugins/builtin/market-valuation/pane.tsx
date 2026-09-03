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
import { getCachedValuationBundle, loadValuationBundle } from "./client";
import { shortZoneLabel, type ValuationRangeId } from "./defs";
import { IndicatorDetail } from "./detail";
import { RANGE_OPTIONS, VALUATION_DEFAULTS } from "./settings";
import {
  formatSigma,
  selectValuationViews,
  type IndicatorViewModel,
  type ValuationBundle,
} from "./view";

/** Below this the detail sits under the table instead of beside it. */
const SPLIT_MIN_WIDTH = 108;
const LIST_WIDTH = 46;

type LoadState =
  | { status: "idle" }
  | { status: "loading"; previous: ValuationBundle | null }
  | { status: "ready"; bundle: ValuationBundle }
  | { status: "error"; message: string; previous: ValuationBundle | null };

type ColumnId = "name" | "value" | "zone" | "percentile" | "sigma";
interface Column extends DataTableColumn { id: ColumnId }

function bundleOf(state: LoadState): ValuationBundle | null {
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

function initialLoadState(): LoadState {
  const cached = getCachedValuationBundle();
  return cached ? { status: "ready", bundle: cached } : { status: "idle" };
}

function matchesQuery(view: IndicatorViewModel, query: string): boolean {
  if (!query) return true;
  const haystack = [
    view.indicator.label,
    view.indicator.shortLabel,
    view.indicator.description,
    view.zone.label,
  ].join(" ").toLowerCase();
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

/** Stacked mode keeps only what fits; the split has a whole column to work with. */
function buildColumns(width: number, stacked: boolean): Column[] {
  const withTrend = stacked && width >= 100;
  // 25 for value/zone/rich, 8 more for trend, then gutters between the columns.
  const trailing = 25 + (withTrend ? 8 : 0);
  const name = Math.max(11, width - trailing - 6);
  return [
    { id: "name", label: "INDICATOR", width: name, align: "left" },
    { id: "value", label: "VALUE", width: 8, align: "right" },
    { id: "zone", label: "ZONE", width: 11, align: "right" },
    { id: "percentile", label: "RICH", width: 6, align: "right" },
    ...(withTrend
      ? [{ id: "sigma" as const, label: "TREND", width: 8, align: "right" as const }]
      : []),
  ];
}

function cellsFor(view: IndicatorViewModel): Record<ColumnId, DataTableCell> {
  return {
    name: { text: view.indicator.shortLabel, color: colors.textBright },
    value: { text: view.indicator.formatValue(view.current.ratio), color: view.zone.color },
    zone: { text: shortZoneLabel(view.zone.id), color: view.zone.color },
    // Restated so a high number always means expensive, whichever way the
    // underlying measure runs, otherwise the column cannot be read down.
    percentile: { text: formatNumber(view.richPercentile, 0), color: colors.text },
    sigma: { text: formatSigma(view.richSigma), color: colors.textMuted },
  };
}

/**
 * The table commits keyboard moves by index after a short delay. When a filter
 * changes the rows in between, that index lands on a different indicator, and
 * honouring it would silently rewrite the persisted setting as the user types.
 * Pointer and activation commits are explicit, so they are always honoured.
 */
export function shouldPersistSelection({
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

export function MarketValuationPane({ focused, width, height }: PaneProps) {
  const [indicatorId, setIndicatorId] = usePaneSettingValue<string>(
    "indicator",
    VALUATION_DEFAULTS.indicator,
  );
  const [range, setRange] = usePaneSettingValue<ValuationRangeId>("range", VALUATION_DEFAULTS.range);
  const [state, setState] = useState<LoadState>(initialLoadState);
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
      const next = await loadValuationBundle();
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
    () => (bundle ? selectValuationViews(bundle, range) : []),
    [bundle, range],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () => views.filter((view) => matchesQuery(view, normalizedQuery)),
    [normalizedQuery, views],
  );
  // Filtering narrows the list, but the detail keeps showing the chosen indicator
  // until the user picks another, so typing never blanks the chart.
  const selected = views.find((view) => view.indicator.id === indicatorId) ?? views[0] ?? null;
  const selectionOnScreen = visible.some((view) => view.indicator.id === selected?.indicator.id);

  const chooseIndicator = useCallback((
    id: string,
    reason: DataTableSelectionChangeReason,
  ) => {
    if (!shouldPersistSelection({
      id,
      reason,
      selectionOnScreen,
      knownIds: views.map((view) => view.indicator.id),
    })) return;
    setIndicatorId(id);
  }, [selectionOnScreen, setIndicatorId, views]);

  const error = state.status === "error" ? state.message : bundle?.errors[0] ?? null;
  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    if (!selected) return [];
    const info: PaneFooterSegment[] = [
      { id: "as-of", parts: [{ text: `as of ${selected.asOf}`, tone: "muted" }] },
      { id: "delayed", parts: [{ text: "delayed", tone: "muted" }] },
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
    registrationId: "market-valuation",
    loading: state.status === "loading",
    error,
    info: footerInfo,
  });

  if (!bundle && state.status !== "error") {
    return (
      <Box width={width} height={height} justifyContent="center" alignItems="center">
        <Spinner label="Loading market valuation..." />
      </Box>
    );
  }

  if (!selected) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState title="Market valuation unavailable." message={error ?? undefined} />
      </Box>
    );
  }

  const split = width >= SPLIT_MIN_WIDTH;
  const listWidth = split ? Math.min(LIST_WIDTH, Math.floor(width * 0.4)) : width;
  const detailWidth = split ? width - listWidth : width;
  const columns = buildColumns(listWidth, !split);
  // Header plus every row, and one more line for the horizontal scrollbar.
  const tableHeight = split
    ? Math.max(3, height - 2)
    : Math.min(visible.length + 2, Math.max(3, height - 12));

  const list = (
    <Box flexDirection="column" width={listWidth} flexShrink={0}>
      <InputSearchBar
        value={query}
        focused={focused}
        active={searchFocused}
        width={listWidth}
        focusToken={searchFocusToken}
        inputRef={searchInputRef}
        placeholder="filter indicators"
        debounceMs={80}
        onFocus={focusSearch}
        onBlur={blurSearch}
        onQueryChange={setQuery}
      />
      <Box flexDirection="column" width={listWidth} height={tableHeight} flexShrink={0} overflow="hidden">
        <DataTableView<IndicatorViewModel, Column>
          focused={focused && !searchFocused}
          rootWidth={listWidth}
          rootHeight={tableHeight}
          columns={columns}
          items={visible}
          sortColumnId={null}
          sortDirection="asc"
          selection={{
            kind: "id",
            selectedId: selected.indicator.id,
            getId: (view) => view.indicator.id,
            onChange: (id, _item, _index, reason) => chooseIndicator(String(id), reason),
          }}
          onHeaderClick={() => {}}
          onRootKeyDown={handlePaneKey}
          getItemKey={(view) => view.indicator.id}
          renderCell={(view, column) => cellsFor(view)[column.id]}
          emptyStateTitle={normalizedQuery ? "No indicator matches." : error ?? "No indicators."}
        />
      </Box>
    </Box>
  );

  const detail = (
    <Box flexDirection="column" flexGrow={1} width={detailWidth} overflow="hidden">
      <Box flexDirection="row" height={1} paddingX={1} overflow="hidden" justifyContent="flex-end">
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={range}
          onChange={(value) => setRange(value as ValuationRangeId)}
        />
      </Box>
      <ScrollBox flexGrow={1} scrollY focusable={false}>
        <Box flexDirection="column" paddingBottom={1}>
          <IndicatorDetail
            view={selected}
            width={detailWidth}
            height={Math.max(12, height - (split ? 3 : tableHeight + 3))}
            focused={focused && !searchFocused}
          />
        </Box>
      </ScrollBox>
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection={split ? "row" : "column"} flexGrow={1} overflow="hidden">
        {list}
        {detail}
      </Box>
      {error ? (
        <Box height={1} paddingX={1} overflow="hidden">
          <Text fg={colors.warning}>{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
