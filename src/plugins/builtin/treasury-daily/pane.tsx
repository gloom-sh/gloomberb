import { useCallback, useMemo, useState } from "react";
import {
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  usePaneTabs,
  type ChartTableChart,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { spanAxisFormatter } from "../../../components/chart-table";
import { useChartViewReset } from "../../../components/chart/core/view-reset";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { STALE_SEGMENT } from "../../../components/layout/pane/status-footer";
import { useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKeyboardEvent } from "../../../utils/keyboard";
import { useTreasuryDailyResources } from "./resource";
import {
  CASH_COLUMNS,
  DEBT_COLUMNS,
  TGA_RANGES,
  TREASURY_DAILY_PANE_ID,
  TREASURY_TABS,
  formatBillions,
  formatTrillions,
  tgaClosesInRange,
  tgaRange,
  type CashAccount,
  type CashColumn,
  type DebtColumn,
  type DebtDay,
  type TgaRange,
  type TreasuryTab,
} from "./model";

const EMPTY_CASH: CashAccount[] = [];
const EMPTY_DEBT: DebtDay[] = [];
const RANGE_OPTIONS = TGA_RANGES.map(({ value, label, hint }) => ({ value, label, hint }));
const TGA_SERIES_LABEL = "TGA closing balance $bn";
/** Ticks in billions, with thousands separators and the decimals the plotted range needs. */
const formatBillionsAxis = spanAxisFormatter((value, digits) => formatNumber(value, digits), 2);
const formatBillionsLevel = (value: number) => formatNumber(value, 2);

function scaledCell(value: number | null, text: string, muted: string): DataTableCell {
  return value == null ? { text, value, color: muted } : { text, value };
}

export function TreasuryDailyPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { cash, debt, history } = useTreasuryDailyResources();
  const [storedTab, setTab] = usePluginPaneState<string>("tab", "cash");
  const tab: TreasuryTab = storedTab === "debt" ? "debt" : "cash";
  const active = tab === "cash" ? cash : debt;
  const cashRows = cash.data?.rows ?? EMPTY_CASH;
  const debtRows = debt.data ?? EMPTY_DEBT;
  const activeRows = tab === "cash" ? cashRows : debtRows;
  const recordDate = tab === "cash" ? cash.data?.recordDate ?? null : debtRows[0]?.date ?? null;
  const [storedRange, setStoredRange] = usePluginPaneState<string>("range", "1Y");
  const range = tgaRange(storedRange);
  const resetChartView = useChartViewReset();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const resolvedId = activeRows.some((row) => row.id === selectedId) ? selectedId : activeRows[0]?.id ?? null;
  const { strip, rows: tabRows } = usePaneTabs({
    tabs: TREASURY_TABS,
    activeValue: tab,
    onSelect: setTab,
    focused,
    dense: true,
  });
  const resources = [cash, debt, history];
  const lastUpdated = resources.every((section) => section.updatedAt !== null && section.savedAt === null && !section.error)
    ? Math.min(...resources.map((section) => section.updatedAt!)) : null;
  const refresh = useCallback(() => {
    cash.reload();
    debt.reload();
    history.reload();
  }, [cash.reload, debt.reload, history.reload]);
  useAutoRefresh(lastUpdated, refresh);
  usePaneRefreshKey(refresh, { focused });
  const subject = tab === "cash" ? "Treasury cash" : "Treasury debt";
  const activeError = active.data ? null : active.error;
  const activeLoading = !active.data && active.loading;
  const historyDate = tab === "cash" && history.savedAt !== null ? history.data?.at(-1)?.date : undefined;
  const partial = resources.some((section) => section.error) && resources.some((section) => section.data);
  const stale = active.savedAt !== null;
  const info = useMemo(() => [
    ...(recordDate ? [{ id: "record-date", capture: partial || stale, parts: [{ text: recordDate, tone: "muted" as const }] }] : []),
    ...(stale ? [{ ...STALE_SEGMENT, capture: true }] : []),
    ...(historyDate ? [{ id: "history-date", capture: true, parts: [{ text: `History stale · ${historyDate}`, tone: "warning" as const }] }] : []),
    ...(partial ? [{ id: "partial", capture: true, parts: [{ text: "partial", tone: "warning" as const }] }] : []),
  ], [historyDate, partial, recordDate, stale]);
  usePaneStatusFooter({
    registrationId: TREASURY_DAILY_PANE_ID,
    loading: active.loading,
    error: activeError,
    info,
  });
  usePaneNoticeFooter({
    registrationId: `${TREASURY_DAILY_PANE_ID}:warnings`,
    focused,
    notices: [
      { label: "Cash", section: cash, bodyError: tab === "cash" && activeError },
      { label: "Debt", section: debt, bodyError: tab === "debt" && activeError },
      { label: "Closing balance history", section: history, bodyError: false },
    ].flatMap(({ label, section, bodyError }) => section.error && !bodyError
      ? [`${label} ${section.data ? "refresh failed; showing saved data" : "unavailable"}: ${section.error}`]
      : []),
  });

  // The closing balance the table's last line states for the day, drawn over the range chosen.
  const series = useMemo(() => {
    const closes = tgaClosesInRange(history.data ?? [], range);
    return closes.length < 2 ? [] : [staticSeries(
      closes.map((close) => scalarPoint(new Date(`${close.date}T00:00:00Z`), close.millions / 1_000)),
      { id: "tga-closing-balance", label: TGA_SERIES_LABEL, color: colors.positive, calendarSpaced: true },
    )];
  }, [colors.positive, history.data, range]);
  const chart: ChartTableChart | null = !history.data ? null : {
    series,
    formatValue: formatBillionsLevel,
    formatAxisValue: formatBillionsAxis,
    remoteKind: "treasury-general-account",
    empty: "No closing balance history.",
  };
  // The number keys pick the range, as the bar's hints say; picking the one showing sends the chart back to it.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return true;
    if (!isPlainKeyboardEvent(event)) return false;
    const picked = TGA_RANGES.find((option) => option.hint === event.name);
    if (!picked) return false;
    event.preventDefault?.();
    if (picked.value === range) resetChartView();
    else setStoredRange(picked.value);
    return true;
  }, [range, refresh, resetChartView, setStoredRange]);

  const bodyHeight = Math.max(1, height - tabRows);
  const renderCash = useCallback((row: CashAccount, column: CashColumn): DataTableCell => {
    if (column.id === "account") return { text: row.account };
    const value = column.id === "today" ? row.today : row.month;
    return scaledCell(value, formatBillions(value), colors.textMuted);
  }, [colors.textMuted]);
  const renderDebt = useCallback((row: DebtDay, column: DebtColumn): DataTableCell => {
    if (column.id === "date") return { text: row.date, value: row.date, color: colors.textMuted };
    const value = column.id === "heldByPublic" ? row.heldByPublic
      : column.id === "intragovernmental" ? row.intragovernmental
        : row.total;
    return scaledCell(value, formatTrillions(value), colors.textMuted);
  }, [colors.textMuted]);

  let body = null;
  if (activeLoading && (tab === "debt" || !chart)) {
    body = <PaneStatusBody loading align="center" />;
  } else if (tab === "cash") {
    body = (
      <DataTableView<CashAccount, CashColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={bodyHeight}
        status={{ loading: activeLoading, error: activeError, subject }}
        rootBefore={chart ? (
          <ChartTableHeader
            width={width}
            height={bodyHeight}
            tableRows={cashRows.length}
            tableColumns={CASH_COLUMNS}
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
                  onChange: (value: string) => setStoredRange(tgaRange(value) satisfies TgaRange),
                }]}
              />
            )}
            chart={chart}
          />
        ) : undefined}
        onRootKeyDown={handleKeyDown}
        columns={CASH_COLUMNS}
        items={cashRows}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(row) => row.id}
        selection={{
          kind: "id",
          selectedId: resolvedId,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        selectedTextOverridesCellColor
        renderCell={renderCash}
        emptyStateTitle="No cash balance for this day."
      />
    );
  } else {
    body = (
      <DataTableView<DebtDay, DebtColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={bodyHeight}
        status={{ error: activeError, subject }}
        columns={DEBT_COLUMNS}
        items={debtRows}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(row) => row.id}
        selection={{
          kind: "id",
          selectedId: resolvedId,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        selectedTextOverridesCellColor
        renderCell={renderDebt}
        emptyStateTitle="No debt figures for recent business days."
      />
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {strip}
      {body}
    </Box>
  );
}
