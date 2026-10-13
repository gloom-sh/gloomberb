import { useCallback, useEffect, useMemo } from "react";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneStatusFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneInstance } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { fetchCorporateBonds, type CorporateBond } from "./client";
import {
  DEFAULT_BOND_SORT,
  TRACE_BONDS_PANE_ID,
  bondChangeColor,
  buildBondColumns,
  filterBondsByIssuer,
  firstBondSortDirection,
  formatBondChange,
  formatBondDecimal,
  isBondColumnId,
  latestTradeDate,
  sortBonds,
  type BondColumn,
  type BondSort,
} from "./model";

const NO_BONDS: CorporateBond[] = [];

function dash(value: string | null): string {
  return value ?? "—";
}

export function TraceBondsPane({ focused, width, height }: PaneProps) {
  const presetIssuer = usePaneInstance()?.params?.issuer ?? "";
  const request = useCallback(() => fetchCorporateBonds(), []);
  const { data, loading, error, updatedAt, load, reload } = useAsyncResource(request);
  const bonds = data ?? NO_BONDS;
  const [query, setQuery] = usePluginPaneState("issuer", presetIssuer);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [sort, setSort] = usePluginPaneState<BondSort>("sort", DEFAULT_BOND_SORT);
  const { active: searchActive, focus: focusSearch, searchProps } = useQueryBarSearch();

  useAutoRefresh(updatedAt, load);
  usePaneRefreshKey(() => void reload(), { focused, enabled: !searchActive });

  const rows = useMemo(
    () => sortBonds(filterBondsByIssuer(bonds, query), sort),
    [bonds, query, sort],
  );
  const columns = useMemo(() => buildBondColumns(width), [width]);
  const tradeDate = latestTradeDate(bonds);
  const footerInfo = useMemo(
    () => (tradeDate ? [{ id: "trade-date", parts: [{ text: tradeDate }] }] : []),
    [tradeDate],
  );

  useEffect(() => {
    if (bonds.length === 0 && loading) return;
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0]!.id);
  }, [bonds.length, loading, rows, selectedId, setSelectedId]);

  const onHeaderClick = useCallback((columnId: string) => {
    if (!isBondColumnId(columnId)) return;
    setSort((current) => nextHeaderSort(current, columnId, {
      firstDirection: firstBondSortDirection,
      resetTo: DEFAULT_BOND_SORT,
    }));
  }, [setSort]);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

  const renderCell = useCallback((row: CorporateBond, column: BondColumn): DataTableCell => {
    switch (column.id) {
      case "issuer":
        return {
          text: row.issuerName || "—",
          color: colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "coupon":
        return { text: formatBondDecimal(row.couponRate, 3), value: row.couponRate, color: colors.text };
      case "maturity":
        return { text: dash(row.maturityDate), value: row.maturityDate, color: colors.textMuted };
      case "price":
        return { text: formatBondDecimal(row.lastSalePrice, 3), value: row.lastSalePrice, color: colors.text };
      case "yield":
        return { text: formatBondDecimal(row.lastSaleYield, 3), value: row.lastSaleYield, color: colors.text };
      case "change":
        return {
          text: formatBondChange(row.priceChangeNumber),
          value: row.priceChangeNumber,
          color: bondChangeColor(row.priceChangeNumber),
          keepColorWhenSelected: row.priceChangeNumber != null && row.priceChangeNumber !== 0,
        };
      case "traded":
        return { text: dash(row.lastTradeDate), value: row.lastTradeDate, color: colors.textMuted };
      case "grade":
        return { text: dash(row.traceGradeCode), color: colors.textDim };
    }
  }, []);

  usePaneStatusFooter({
    registrationId: TRACE_BONDS_PANE_ID,
    loading,
    error,
    info: footerInfo,
  });

  if (loading && bonds.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <PaneStatusBody loading align="center" />
      </Box>
    );
  }

  if (error && bonds.length === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <PaneStatusBody error={error} subject="Bond tape" />
      </Box>
    );
  }

  const needle = query.trim();
  return (
    <DataTableView
      focused={focused && !searchActive}
      rootWidth={width}
      rootHeight={height}
      rootBefore={(
        <QueryBar
          width={width}
          search={{
            value: query,
            onChange: setQuery,
            placeholder: "issuer",
            focused,
            ...searchProps,
          }}
        />
      )}
      onRootKeyDown={handleRootKeyDown}
      selection={{
        kind: "id",
        selectedId,
        getId: (row) => row.id,
        onChange: (id) => setSelectedId(id),
      }}
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={onHeaderClick}
      onSortChange={(columnId, direction) => {
        if (isBondColumnId(columnId)) setSort({ columnId, direction });
      }}
      resetScrollKey={`${needle}:${sort.columnId ?? ""}:${sort.direction}`}
      getItemKey={(row) => row.id}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={needle ? "No matching issuers." : "No recent sales."}
    />
  );
}
