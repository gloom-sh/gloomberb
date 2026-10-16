import { useCallback, useEffect, useMemo } from "react";
import {
  DataTableView,
  loadingText,
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
import { fetchBondTape, noPrintsText, type CorporateBond } from "./client";
import {
  DEFAULT_BOND_SORT,
  TRACE_BONDS_PANE_ID,
  bondChangeColor,
  buildBondColumns,
  firstBondSortDirection,
  formatBondChange,
  formatBondDecimal,
  isBondColumnId,
  sortBonds,
  type BondColumn,
  type BondSort,
} from "./model";

const NO_BONDS: CorporateBond[] = [];
/** The tape is asked again for what was typed, once typing pauses. */
const SEARCH_DEBOUNCE_MS = 350;

function dash(value: string | null): string {
  return value ?? "—";
}

export function TraceBondsPane({ focused, width, height }: PaneProps) {
  const presetIssuer = usePaneInstance()?.params?.issuer ?? "";
  const [query, setQuery] = usePluginPaneState("issuer", presetIssuer);
  const needle = query.trim();
  // An issuer, symbol or CUSIP is asked of the tape itself, not looked for in the latest page.
  const request = useCallback(() => fetchBondTape(needle), [needle]);
  const { data, loading, error, updatedAt, load, reload } = useAsyncResource(request, { keepPreviousData: true });
  const bonds = data?.bonds ?? NO_BONDS;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [sort, setSort] = usePluginPaneState<BondSort>("sort", DEFAULT_BOND_SORT);
  const { active: searchActive, focus: focusSearch, searchProps } = useQueryBarSearch();

  useAutoRefresh(updatedAt, load);
  usePaneRefreshKey(() => void reload(), { focused, enabled: !searchActive });

  const rows = useMemo(() => sortBonds(bonds, sort), [bonds, sort]);
  const columns = useMemo(() => buildBondColumns(width), [width]);
  const tradeDate = data?.tradeDate ?? null;
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
      case "cusip":
        return { text: dash(row.cusip), value: row.cusip, color: colors.textMuted };
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

  // Only the first load replaces the table: a new query keeps the search field and the last answer.
  if (loading && !data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <PaneStatusBody loading align="center" />
      </Box>
    );
  }

  if (error && !data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <PaneStatusBody error={error} subject="Bond tape" />
      </Box>
    );
  }

  // Rows still on screen from the last query wait for this one's answer.
  const answered = data != null && (data.query?.text ?? "") === needle.replace(/\s+/g, " ");
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
            placeholder: "issuer, symbol or CUSIP",
            focused,
            debounceMs: SEARCH_DEBOUNCE_MS,
            normalizeValue: (value) => value.trim(),
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
      emptyStateTitle={loading && !answered ? loadingText("bond sales")
        : data?.query ? noPrintsText(data.query, tradeDate) : "No recent sales."}
    />
  );
}
