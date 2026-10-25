import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  usePaneTabs,
  useTableLayoutWidth,
  type ChartTableChart,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { spanAxisFormatter } from "../../../components/chart-table";
import { useChartViewReset } from "../../../components/chart/core/view-reset";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { usePluginPaneState } from "../../runtime";
import { cachedDealerHistory, fetchPrimaryDealers, hasDealerHistory, loadDealerHistory } from "./client";
import {
  DEALER_RANGES,
  DEFAULT_DEALER_RANGE,
  PRIMARY_DEALERS_PANE_ID,
  buildDealerColumns,
  dealerRange,
  dealerRowLabel,
  formatChange,
  formatLevel,
  pointsInRange,
  type DealerColumn,
  type DealerRange,
  type DealerRow,
  type DealerTab,
} from "./model";

const TABS = [
  { label: "Positions", value: "positions" },
  { label: "Fails", value: "fails" },
];
const EMPTY_ROWS: DealerRow[] = [];
const RANGE_OPTIONS = DEALER_RANGES.map(({ value, label, hint }) => ({ value, label, hint }));
/** How long the selection rests before its history is read, so holding a key down the board reads one row, not all it passes. */
const CHART_SETTLE_MS = 150;
/** Ticks in the table's own figures (whole $mn), with decimals only where the plotted range is narrow. */
const formatLevelAxis = spanAxisFormatter((value, digits) => formatNumber(value, digits));

function changeColor(value: number | null): string {
  if (value == null || value === 0) return colors.textMuted;
  return value > 0 ? colors.positive : colors.negative;
}

/** The row the chart follows: the selection once it rests, or at once when its history is already in hand. */
function useChartRow(rows: readonly DealerRow[], selected: DealerRow | null, known: boolean): DealerRow | null {
  const [restedId, setRestedId] = useState<string | null>(null);
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId === restedId) return;
    if (selectedId == null || restedId == null || known || !rows.some((row) => row.id === restedId)) {
      setRestedId(selectedId);
      return;
    }
    const timer = setTimeout(() => setRestedId(selectedId), CHART_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [known, restedId, rows, selectedId]);
  if (known) return selected;
  return rows.find((row) => row.id === restedId) ?? selected;
}

export function PrimaryDealersPane({ focused, width, height }: PaneProps) {
  const request = useCallback(() => fetchPrimaryDealers(), []);
  const { data, loading, error, load } = useAsyncResource(request);
  const [storedTab, setTab] = usePluginPaneState<string>("tab", "positions");
  const tab: DealerTab = storedTab === "fails" ? "fails" : "positions";
  const [positionId, setPositionId] = usePluginPaneState<string | null>("selected:positions", null);
  const [failId, setFailId] = usePluginPaneState<string | null>("selected:fails", null);
  const [storedRange, setStoredRange] = usePluginPaneState<string>("range", DEFAULT_DEALER_RANGE);
  const range = dealerRange(storedRange);
  const resetChartView = useChartViewReset();
  const rows = tab === "fails" ? data?.fails ?? EMPTY_ROWS : data?.positions ?? EMPTY_ROWS;
  const selectedId = tab === "fails" ? failId : positionId;
  const setSelectedId = tab === "fails" ? setFailId : setPositionId;
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const seriesBreak = data?.seriesBreak ?? null;
  const asOf = useMemo(() => {
    let best: string | null = null;
    for (const row of rows) {
      if (row.asOf && (best == null || row.asOf > best)) best = row.asOf;
    }
    return best;
  }, [rows]);
  const layoutWidth = useTableLayoutWidth(width);
  const columns = useMemo(() => buildDealerColumns(layoutWidth), [layoutWidth]);
  const footerInfo = useMemo(
    () => asOf ? [{ id: "as-of", parts: [{ text: asOf, tone: "muted" as const }] }] : [],
    [asOf],
  );

  // The chart follows the selected row. Its history is read for that row alone.
  const known = !!selected && !!seriesBreak && hasDealerHistory(seriesBreak, selected);
  const chartRow = useChartRow(rows, selected, known);
  const loadHistory = useMemo(
    () => chartRow && seriesBreak ? (force: boolean) => loadDealerHistory(seriesBreak, chartRow, force) : null,
    [chartRow, seriesBreak],
  );
  const historyResource = useAsyncResource(loadHistory, { keepPreviousData: true });
  const history = useMemo(
    () => (chartRow && seriesBreak ? cachedDealerHistory(seriesBreak, chartRow) : null) ?? historyResource.data,
    [chartRow, historyResource.data, seriesBreak],
  );
  // While another row's history loads the chart keeps the last one drawn, unless that row is not on this tab.
  const historyRow = history ? rows.find((row) => row.id === history.rowId) ?? null : null;
  const series = useMemo(() => history && historyRow
    ? [staticSeries(
      pointsInRange(history.points, range).map((point) => scalarPoint(new Date(`${point.asOf}T00:00:00Z`), point.value)),
      { id: historyRow.id, label: `${historyRow.label} $mn`, color: colors.positive, calendarSpaced: true },
    )]
    : [], [history, historyRow, range]);
  const historyFailed = history?.rowId !== chartRow?.id && !!historyResource.error;
  const chart: ChartTableChart | null = selected && !historyFailed ? {
    series,
    formatValue: formatLevel,
    formatAxisValue: formatLevelAxis,
    remoteKind: "primary-dealer-history",
    loading: !historyRow,
    empty: `No history for ${selected.label}`,
  } : null;

  const { reload: reloadHistory } = historyResource;
  const refresh = useCallback(() => {
    void load();
    void reloadHistory();
  }, [load, reloadHistory]);
  const selectTab = useCallback((value: string) => setTab(value === "fails" ? "fails" : "positions"), [setTab]);
  const selectRange = useCallback((value: DealerRange) => setStoredRange(value), [setStoredRange]);
  usePaneRefreshKey(refresh, { focused });

  // The number keys pick the range, as the bar's hints say; picking the one showing sends the chart back to it.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return true;
    if (!isPlainKeyboardEvent(event)) return false;
    const picked = DEALER_RANGES.find((option) => option.hint === event.name);
    if (!picked) return false;
    event.preventDefault?.();
    if (picked.value === range) resetChartView();
    else selectRange(picked.value);
    return true;
  }, [range, refresh, resetChartView, selectRange]);

  const { strip: tabs, rows: tabRows } = usePaneTabs({
    tabs: TABS,
    activeValue: tab,
    onSelect: selectTab,
    focused,
    compact: true,
    dense: true,
  });

  usePaneStatusFooter({
    registrationId: PRIMARY_DEALERS_PANE_ID,
    loading: loading && !data,
    error,
    info: footerInfo,
  });
  usePaneNoticeFooter({
    registrationId: `${PRIMARY_DEALERS_PANE_ID}:history`,
    focused,
    notices: historyFailed && selected ? [`History for ${selected.label} is unavailable: ${historyResource.error}`] : [],
  });

  const renderCell = useCallback((
    row: DealerRow,
    column: DealerColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "position":
        // A breakdown reads under its total, in plain weight.
        return {
          text: dealerRowLabel(row),
          value: row.label,
          color: selectedColor ?? (row.depth === 0 ? colors.textBright : colors.text),
          attributes: row.depth === 0 ? TextAttributes.BOLD : undefined,
        };
      case "asOf":
        return { text: row.asOf ?? "—", color: selectedColor ?? colors.textMuted };
      case "latest":
        return { text: formatLevel(row.latest), value: row.latest, color: selectedColor ?? colors.text };
      case "previous":
        return { text: formatLevel(row.previous), value: row.previous, color: selectedColor ?? colors.textDim };
      case "change":
        return { text: formatChange(row.change), value: row.change, color: selectedColor ?? changeColor(row.change) };
    }
  }, []);

  if (!data && loading) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading align="center" />
      </Box>
    );
  }

  if (!data && error) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody error={error} errorTitle="Positions unavailable." />
      </Box>
    );
  }

  const rootHeight = Math.max(1, height - tabRows);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableView<DealerRow, DealerColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={rootHeight}
        rootBefore={selected ? (
          <ChartTableHeader
            width={width}
            height={rootHeight}
            tableRows={rows.length}
            tableColumns={columns}
            query={(
              <QueryBar
                width={width}
                filters={[{
                  id: "range",
                  label: "Range",
                  inline: true,
                  chartRange: true,
                  value: range,
                  options: RANGE_OPTIONS,
                  onChange: (value: string) => selectRange(dealerRange(value)),
                }]}
              />
            )}
            chart={chart}
          />
        ) : undefined}
        selection={{
          kind: "id",
          selectedId: selected?.id ?? null,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        onRootKeyDown={handleKeyDown}
        columns={columns}
        items={rows}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(row) => row.id}
        renderCell={renderCell}
        resetScrollKey={tab}
        emptyStateTitle={tab === "fails" ? "No fails in this release." : "No positions in this release."}
      />
    </Box>
  );
}
