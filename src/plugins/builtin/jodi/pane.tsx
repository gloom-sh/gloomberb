import { useCallback, useMemo } from "react";
import {
  DataTableView,
  PaneStatusBody,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { usePluginPaneState } from "../../runtime";
import { fetchBalances } from "./client";
import {
  JODI_PANE_ID,
  balanceColumns,
  formatBalance,
  formatBalanceMonth,
  type BalanceCommodity,
  type BalanceRow,
} from "./model";

const EMPTY_ROWS: BalanceRow[] = [];
const TABS = [
  { label: "Oil", value: "oil" },
  { label: "Gas", value: "gas" },
];

export function JodiPane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const loader = useCallback(() => fetchBalances(), []);
  const resource = useAsyncResource(loader);
  useAutoRefresh(resource.updatedAt, resource.load);
  const balances = resource.data;
  const gas = balances?.gas ?? null;
  const [storedTab, setTab] = usePluginPaneState<string>("commodity", "oil");
  const tab: BalanceCommodity = gas && storedTab === "gas" ? "gas" : "oil";
  const board = tab === "gas" ? gas : balances?.oil ?? null;
  const rows = board?.rows ?? EMPTY_ROWS;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const columns = useMemo(() => balanceColumns(tab), [tab]);
  const refresh = useCallback(() => {
    resource.reload();
  }, [resource.reload]);
  const onRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, refresh, { stopPropagation: true });
  }, [refresh]);
  usePaneRefreshKey(refresh, { focused });
  const selectTab = useCallback((value: string) => {
    setTab(value === "gas" ? "gas" : "oil");
  }, [setTab]);
  const { strip: tabs, rows: tabRows } = usePaneTabs(gas ? {
    tabs: TABS,
    activeValue: tab,
    onSelect: selectTab,
    focused,
    compact: true,
    variant: "underline",
    queryBarWidth: width,
  } : null);
  const info = useMemo(
    () => (resource.error || !board ? [] : [{ id: "month", parts: [{ text: formatBalanceMonth(board.month) }] }]),
    [board, resource.error],
  );
  usePaneStatusFooter({
    registrationId: JODI_PANE_ID,
    loading: resource.loading,
    error: resource.error,
    stale: !!balances?.stale,
    info,
  });
  usePaneNoticeFooter({ registrationId: `${JODI_PANE_ID}:notices`, focused, notices: balances?.gaps ?? [] });

  const renderCell = useCallback((row: BalanceRow, column: { id: string }): DataTableCell => {
    const number = (value: number | null): DataTableCell => ({
      text: formatBalance(value),
      value,
      color: value == null ? colors.textMuted : colors.text,
    });
    switch (column.id) {
      case "country":
        return { text: row.country, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "month":
        return { text: row.month ? formatBalanceMonth(row.month) : "—", value: row.month, color: colors.textMuted };
      case "production":
        return number(row.production);
      case "demand":
        return number(row.demand);
      case "imports":
        return number(row.imports);
      case "exports":
        return number(row.exports);
      case "stocks":
        return number(row.stocks);
      case "unit":
        return { text: row.unit, color: colors.textDim };
      default:
        return { text: "" };
    }
  }, [colors]);

  if (!balances) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody
          loading={resource.loading}
          error={resource.loading ? null : resource.error ?? "Balances are unavailable."}
          subject="Balances"
          align="center"
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableView
        focused={focused}
        rootWidth={width}
        rootHeight={Math.max(1, height - tabRows)}
        columns={columns}
        items={rows}
        getItemKey={(row) => row.country}
        sortColumnId={null}
        sortDirection="asc"
        selection={{
          kind: "id",
          selectedId,
          getId: (row) => row.country,
          onChange: (id) => setSelectedId(id),
        }}
        onRootKeyDown={onRootKeyDown}
        renderCell={renderCell}
        selectedTextOverridesCellColor
        emptyStateTitle="No balances for this month."
      />
    </Box>
  );
}
