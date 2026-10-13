import { useCallback, useMemo, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  usePaneStatusFooter,
  usePaneTabs,
  type DataTableCell,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { fetchTreasuryDaily } from "./client";
import {
  CASH_COLUMNS,
  DEBT_COLUMNS,
  TREASURY_DAILY_PANE_ID,
  TREASURY_TABS,
  formatBillions,
  formatTrillions,
  type CashAccount,
  type CashColumn,
  type DebtColumn,
  type DebtDay,
  type TreasuryTab,
} from "./model";

const EMPTY_CASH: CashAccount[] = [];
const EMPTY_DEBT: DebtDay[] = [];

function scaledCell(value: number | null, text: string, muted: string): DataTableCell {
  return value == null ? { text, value, color: muted } : { text, value };
}

export function TreasuryDailyPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const request = useCallback(() => fetchTreasuryDaily(), []);
  const resource = useAsyncResource(request);
  const [storedTab, setTab] = usePluginPaneState<string>("tab", "cash");
  const tab: TreasuryTab = storedTab === "debt" ? "debt" : "cash";
  const data = resource.data;
  const cashRows = data?.cash.rows ?? EMPTY_CASH;
  const debtRows = data?.debt ?? EMPTY_DEBT;
  const activeRows = tab === "cash" ? cashRows : debtRows;
  const recordDate = tab === "cash" ? data?.cash.recordDate ?? null : debtRows[0]?.date ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const resolvedId = activeRows.some((row) => row.id === selectedId) ? selectedId : activeRows[0]?.id ?? null;
  const info = useMemo(
    () => (recordDate ? [{ id: "record-date", parts: [{ text: recordDate, tone: "muted" as const }] }] : []),
    [recordDate],
  );
  const { strip, rows: tabRows } = usePaneTabs({
    tabs: TREASURY_TABS,
    activeValue: tab,
    onSelect: setTab,
    focused,
    dense: true,
  });
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  usePaneStatusFooter({
    registrationId: TREASURY_DAILY_PANE_ID,
    loading: resource.loading,
    error: resource.error,
    info,
  });

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
  if (resource.loading && !data) {
    body = <PaneStatusBody loading align="center" />;
  } else if (!data && resource.error) {
    body = <PaneStatusBody error={resource.error} subject="Treasury cash and debt" />;
  } else if (data && tab === "cash") {
    body = (
      <DataTableView<CashAccount, CashColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={bodyHeight}
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
  } else if (data) {
    body = (
      <DataTableView<DebtDay, DebtColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={bodyHeight}
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
