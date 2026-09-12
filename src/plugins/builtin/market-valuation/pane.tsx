import { useCallback, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  EmptyState, ExternalLinkText,
  InputSearchBar, Notice, PaneStatusBody, SegmentedControl, type DataTableCell,
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
import { Box, ScrollBox, Text, type InputRenderable } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { getCachedValuationBundle, loadValuationBundle } from "./client";
import { indicatorUnavailableReason, shortZoneLabel, type IndicatorDef, type ValuationRangeId } from "./defs";
import { IndicatorDetail } from "./detail";
import { INDICATORS } from "./indicators";
import { RANGE_OPTIONS, VALUATION_DEFAULTS } from "./settings";
import {
  formatSigma,
  selectValuationViews,
  type IndicatorViewModel
} from "./view";

/** Below this the detail sits under the table instead of beside it. */
const loadBundle = () => loadValuationBundle();

const SPLIT_MIN_WIDTH = 108;
const LIST_WIDTH = 46;

type ColumnId = "name" | "value" | "zone" | "percentile" | "sigma";
interface Column extends DataTableColumn { id: ColumnId }

interface IndicatorRow {
  indicator: IndicatorDef;
  view: IndicatorViewModel | null;
  error: string | null;
}

function matchesQuery(row: IndicatorRow, query: string): boolean {
  if (!query) return true;
  const haystack = [
    row.indicator.label,
    row.indicator.shortLabel,
    row.indicator.description,
    row.view?.zone.label,
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

function cellsFor(row: IndicatorRow): Record<ColumnId, DataTableCell> {
  const view = row.view;
  if (!view) {
    return {
      name: { text: row.indicator.shortLabel, color: colors.textBright },
      value: { text: "--", color: colors.textDim },
      zone: { text: "Unavailable", color: colors.warning },
      percentile: { text: "--", color: colors.textDim },
      sigma: { text: "--", color: colors.textDim },
    };
  }
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
  const resource = useAsyncResource(loadBundle, { initialData: () => getCachedValuationBundle() });
  const { data: bundle, load: refresh, updatedAt: lastUpdated } = resource;
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

  const views = useMemo(
    () => (bundle ? selectValuationViews(bundle, range) : []),
    [bundle, range],
  );
  const rows = useMemo<IndicatorRow[]>(() => bundle ? INDICATORS.flatMap((indicator) => {
    const view = views.find((entry) => entry.indicator.id === indicator.id) ?? null;
    const error = indicatorUnavailableReason(indicator);
    return view || error ? [{ indicator, view, error }] : [];
  }) : [], [bundle, views]);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () => rows.filter((row) => matchesQuery(row, normalizedQuery)),
    [normalizedQuery, rows],
  );
  // Filtering narrows the list, but the detail keeps showing the chosen indicator
  // until the user picks another, so typing never blanks the chart.
  const selected = rows.find((row) => row.indicator.id === indicatorId) ?? rows[0] ?? null;
  const selectedView = selected?.view;
  const selectionOnScreen = visible.some((view) => view.indicator.id === selected?.indicator.id);

  const chooseIndicator = useCallback((
    id: string,
    reason: DataTableSelectionChangeReason,
  ) => {
    if (!shouldPersistSelection({
      id,
      reason,
      selectionOnScreen,
      knownIds: rows.map((row) => row.indicator.id),
    })) return;
    setIndicatorId(id);
  }, [selectionOnScreen, setIndicatorId, rows]);

  const basisErrors = new Set(INDICATORS.flatMap((indicator) => {
    const reason = indicatorUnavailableReason(indicator);
    return reason ? [`${indicator.label}: ${reason}`] : [];
  }));
  const sourceError = bundle?.errors.find((entry) => !basisErrors.has(entry));
  const unavailableCount = bundle?.errors.filter((entry) => basisErrors.has(entry)).length ?? 0;
  const bodyError = resource.error ?? sourceError ?? null;
  const error = bodyError ?? selected?.error
    ?? (unavailableCount ? `${unavailableCount} unavailable` : null);
  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    if (!selectedView) return [];
    const info: PaneFooterSegment[] = [
      { id: "as-of", parts: [{ text: `as of ${selectedView.asOf}`, tone: "muted" }] },
      ...(width >= 80 ? [{ id: "delayed", parts: [{ text: "delayed", tone: "muted" as const }] }] : []),
    ];
    if (selectedView.observationStale) {
      info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
    }
    if (normalizedQuery) {
      info.push({ id: "filter", parts: [{ text: `filter: ${normalizedQuery}`, tone: "value" }] });
    }
    return info;
  }, [normalizedQuery, selectedView, width]);

  usePaneStatusFooter({
    registrationId: "market-valuation",
    loading: resource.loading,
    error,
    info: footerInfo,
  });

  if (!bundle && resource.error === null) {
    return (
      <PaneStatusBody loading align="center" width={width} height={height} loadingLabel="Loading market valuation..." />
    );
  }

  if (!selected) {
    return (
      <Box width={width} height={height} padding={1} flexDirection="column" gap={1}>
        <EmptyState status={error ? "error" : "empty"} title="Market valuation unavailable." message={error ?? undefined} />
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
  // The stacked table consumes rows outside the detail scroll viewport.
  const bodyHeight = Math.max(1, height - (bodyError ? 1 : 0));
  const detailHeight = split ? bodyHeight : Math.max(1, bodyHeight - tableHeight - 1);

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
        <DataTableView<IndicatorRow, Column>
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
    <Box flexDirection="column" flexGrow={1} width={detailWidth} height={detailHeight} overflow="hidden">
      <Box flexDirection="row" height={1} paddingX={1} overflow="hidden" justifyContent="flex-end">
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={range}
          onChange={(value) => setRange(value as ValuationRangeId)}
        />
      </Box>
      <ScrollBox height={Math.max(1, detailHeight - 1)} scrollY focusable={false}>
        <Box flexDirection="column" paddingBottom={1}>
          {selectedView ? <IndicatorDetail
            view={selectedView}
            width={detailWidth}
            height={Math.max(12, height - (split ? 3 : tableHeight + 3))}
            focused={focused && !searchFocused}
          /> : (
            <Box flexDirection="column" padding={1} gap={1}>
              <EmptyState status="error" title={`${selected.indicator.label} unavailable`} message={selected.error ?? undefined} />
              <Text fg={colors.textDim} wrapMode="word" wrapText>{selected.indicator.description}</Text>
              {selected.indicator.link ? <ExternalLinkText
                url={selected.indicator.link.url}
                label={selected.indicator.link.label}
                color={colors.textDim}
              /> : null}
            </Box>
          )}
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
      {bodyError ? (
        <Box height={1} paddingX={1} overflow="hidden">
          <Notice>{bodyError}</Notice>
        </Box>
      ) : null}
    </Box>
  );
}
