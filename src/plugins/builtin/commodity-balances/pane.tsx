import { useCallback, useEffect, useMemo } from "react";
import {
  DataTableView,
  PaneStatusBody,
  usePaneStatusFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import type { PaneFooterSegment } from "../../../components/layout/pane/footer";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh, useUpdatedAgo } from "../../../react/auto-refresh";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { fetchCommodityBalances } from "./client";
import {
  BALANCE_SORT,
  PRICE_SORT,
  formatBalanceValue,
  formatForecast,
  sortBalanceRows,
  sortPriceRows,
  type BalanceColumnId,
  type BalanceRow,
  type PriceColumnId,
  type PriceForecast,
} from "./model";

const PANE_ID = "commodity-balances";
const EMPTY_ROWS: BalanceRow[] = [];
const EMPTY_PRICES: PriceForecast[] = [];

type BalanceColumn = DataTableColumn & { id: BalanceColumnId };
type PriceColumn = DataTableColumn & { id: PriceColumnId };

const BALANCE_COLUMNS: BalanceColumn[] = [
  { id: "crop", label: "Crop", width: 10, align: "left" },
  { id: "country", label: "Country", width: 16, align: "left", flexGrow: 1 },
  { id: "attribute", label: "Attribute", width: 14, align: "left" },
  { id: "value", label: "Value", width: 12, align: "right" },
  { id: "unit", label: "Unit", width: 20, align: "left", flexGrow: 1 },
  { id: "year", label: "Year", width: 8, align: "left" },
];

const PRICE_COLUMNS: PriceColumn[] = [
  { id: "crop", label: "Crop", width: 12, align: "left", flexGrow: 1 },
  { id: "forecast", label: "Forecast", width: 10, align: "right" },
  { id: "unit", label: "Unit", width: 8, align: "left" },
  { id: "season", label: "Season", width: 8, align: "left" },
];

const TABS = [
  { label: "Balances", value: "balances" },
  { label: "Prices", value: "prices" },
];

export function CommodityBalancesPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const request = useCallback(() => fetchCommodityBalances(), []);
  const { data, loading, error, updatedAt, load } = useAsyncResource(request);
  const [tab, setTab] = usePluginPaneState("tab", "balances");
  const [balanceSort, setBalanceSort] = usePluginPaneState("balanceSort", BALANCE_SORT);
  const [priceSort, setPriceSort] = usePluginPaneState("priceSort", PRICE_SORT);
  const [balanceId, setBalanceId] = usePluginPaneState<string | null>("selectedBalance", null);
  const [priceId, setPriceId] = usePluginPaneState<string | null>("selectedPrice", null);
  const prices = data?.prices ?? EMPTY_PRICES;
  const showPrices = prices.length > 0;
  const activeTab = showPrices && tab === "prices" ? "prices" : "balances";
  const balanceRows = useMemo(
    () => sortBalanceRows(data?.rows ?? EMPTY_ROWS, balanceSort),
    [balanceSort, data?.rows],
  );
  const priceRows = useMemo(() => sortPriceRows(prices, priceSort), [priceSort, prices]);
  const { strip, rows: tabRows } = usePaneTabs(showPrices ? {
    tabs: TABS,
    activeValue: activeTab,
    onSelect: (value) => setTab(value),
    focused,
    compact: true,
    variant: "underline",
    queryBarWidth: width,
  } : null);
  const updatedAgo = useUpdatedAgo(updatedAt);
  const info = useMemo<PaneFooterSegment[]>(() => {
    const year = data?.marketYear;
    const updated: PaneFooterSegment[] = updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" }] }] : [];
    return year ? [...updated, { id: "year", parts: [{ text: year, tone: "muted" }] }] : updated;
  }, [data?.marketYear, updatedAgo]);

  useAutoRefresh(updatedAt, load);
  usePaneRefreshKey(load, { focused });
  usePaneStatusFooter({
    registrationId: PANE_ID,
    loading,
    error: data ? error : null,
    info,
  });

  useEffect(() => {
    if (balanceRows.length === 0) return;
    if (balanceId && balanceRows.some((row) => row.id === balanceId)) return;
    setBalanceId(balanceRows[0]!.id);
  }, [balanceId, balanceRows, setBalanceId]);

  useEffect(() => {
    if (priceRows.length === 0) return;
    if (priceId && priceRows.some((row) => row.id === priceId)) return;
    setPriceId(priceRows[0]!.id);
  }, [priceId, priceRows, setPriceId]);

  const onBalanceHeader = useCallback((columnId: string) => {
    setBalanceSort((current) => nextHeaderSort(current, columnId as BalanceColumnId, {
      firstDirection: columnId === "value" ? "desc" : "asc",
      resetTo: BALANCE_SORT,
    }));
  }, [setBalanceSort]);
  const onPriceHeader = useCallback((columnId: string) => {
    setPriceSort((current) => nextHeaderSort(current, columnId as PriceColumnId, {
      firstDirection: columnId === "forecast" ? "desc" : "asc",
      resetTo: PRICE_SORT,
    }));
  }, [setPriceSort]);
  const renderBalanceCell = useCallback((row: BalanceRow, column: BalanceColumn): DataTableCell => {
    switch (column.id) {
      case "crop":
        return { text: row.crop, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "country":
        return { text: row.country, color: colors.text };
      case "attribute":
        return { text: row.attribute, color: colors.text };
      case "value":
        return { text: formatBalanceValue(row.value), value: row.value, color: colors.text };
      case "unit":
        return { text: row.unit, color: colors.textMuted };
      case "year":
        return { text: row.year, color: colors.textMuted };
    }
  }, [colors]);
  const renderPriceCell = useCallback((row: PriceForecast, column: PriceColumn): DataTableCell => {
    switch (column.id) {
      case "crop":
        return { text: row.crop, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "forecast":
        return { text: formatForecast(row.forecast), value: row.forecast, color: colors.text };
      case "unit":
        return { text: row.unit, color: colors.textMuted };
      case "season":
        return { text: row.season, color: colors.textMuted };
    }
  }, [colors]);

  if (loading && !data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {strip}
        <PaneStatusBody loading align="center" />
      </Box>
    );
  }

  if (!data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {strip}
        <PaneStatusBody error={error} errorTitle="Crop balances unavailable." />
      </Box>
    );
  }

  const tableHeight = Math.max(1, height - tabRows);
  return (
    <Box flexDirection="column" width={width} height={height}>
      {strip}
      {activeTab === "prices" ? (
        <DataTableView<PriceForecast, PriceColumn>
          focused={focused}
          rootWidth={width}
          rootHeight={tableHeight}
          columns={PRICE_COLUMNS}
          items={priceRows}
          getItemKey={(row) => row.id}
          sortColumnId={priceSort.columnId}
          sortDirection={priceSort.direction}
          onHeaderClick={onPriceHeader}
          onSortChange={(columnId, direction) => setPriceSort({ columnId: columnId as PriceColumnId, direction })}
          selectedTextOverridesCellColor
          selection={{
            kind: "id",
            selectedId: priceId,
            getId: (row) => row.id,
            onChange: (id) => setPriceId(id),
          }}
          renderCell={renderPriceCell}
          emptyStateTitle="No price forecasts."
          resetScrollKey={activeTab}
        />
      ) : (
        <DataTableView<BalanceRow, BalanceColumn>
          focused={focused}
          rootWidth={width}
          rootHeight={tableHeight}
          columns={BALANCE_COLUMNS}
          items={balanceRows}
          getItemKey={(row) => row.id}
          sortColumnId={balanceSort.columnId}
          sortDirection={balanceSort.direction}
          onHeaderClick={onBalanceHeader}
          onSortChange={(columnId, direction) => setBalanceSort({ columnId: columnId as BalanceColumnId, direction })}
          selectedTextOverridesCellColor
          selection={{
            kind: "id",
            selectedId: balanceId,
            getId: (row) => row.id,
            onChange: (id) => setBalanceId(id),
          }}
          renderCell={renderBalanceCell}
          emptyStateTitle="No crop balances."
          resetScrollKey={activeTab}
        />
      )}
    </Box>
  );
}
