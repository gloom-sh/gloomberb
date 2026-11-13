import { MISSING_VALUE } from "../../../utils/format";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  DataTableStackView,
  loadingText,
  Notice,
  QueryBar,
  unavailableText,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { apiClient } from "../../../api-client";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneInstance } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { nextHeaderSort } from "../../../utils/sort-values";
import { useAssetData, usePluginPaneState } from "../../runtime";
import {
  TRUNCATED_TEXT,
  fetchBondTape,
  issuerFallbackText,
  noPrintsText,
  parseBondQuery,
  quotedCompanyName,
  quotedIssuerListing,
  type CorporateBond,
} from "./client";
import { BondHistoryDetail } from "./detail";
import { loadStoredBond, PRO_HISTORY_TEXT } from "./history";
import {
  DEFAULT_BOND_SORT,
  TRACE_BONDS_PANE_ID,
  bondChangeColor,
  buildBondColumns,
  firstBondSortDirection,
  formatBondChange,
  formatBondDecimal,
  isBondColumnId,
  sharesOneIssuer,
  shownBondSort,
  sortBonds,
  type BondColumn,
  type BondSort,
} from "./model";

const NO_BONDS: CorporateBond[] = [];
/** The tape is asked again for what was typed, once typing pauses. */
const SEARCH_DEBOUNCE_MS = 350;

function dash(value: string | null): string {
  return value ?? MISSING_VALUE;
}

/** What a bond's detail is called: its issuer, coupon and maturity, as a bond is named. */
function bondTitle(bond: CorporateBond): string {
  return [bond.issuerName, bond.couponRate == null ? null : formatBondDecimal(bond.couponRate, 3), bond.maturityDate]
    .filter(Boolean).join(" ");
}

export function TraceBondsPane({ focused, width, height }: PaneProps) {
  const presetIssuer = usePaneInstance()?.params?.issuer ?? "";
  const [query, setQuery] = usePluginPaneState("issuer", presetIssuer);
  const needle = query.trim();
  const marketData = useAssetData();
  // A stock ticker with no bonds of its own is asked again by its company, as its quote names it.
  const companyName = useCallback((ticker: string) => quotedCompanyName(marketData, ticker), [marketData]);
  const access = usePlanAccess();
  const pro = access.hasProAccess;
  // Before its name, its company's bonds as Gloom Cloud links them: Gloom Pro, and without it the name alone, as before.
  const linkedBonds = useCallback(async (ticker: string) => {
    const listing = await quotedIssuerListing(marketData, ticker);
    if (!listing) return null;
    const linked = await apiClient.getCloudIssuerBondIssues(listing);
    return { company: linked.name, cusips: linked.cusips };
  }, [marketData]);
  // An issuer, symbol or CUSIP is asked of the tape itself, not looked for in the latest page.
  const request = useCallback(
    () => fetchBondTape(needle, { companyName, ...(pro ? { linkedBonds } : {}) }),
    [companyName, linkedBonds, needle, pro],
  );
  const { data, loading, error, updatedAt, load, reload } = useAsyncResource(request, { keepPreviousData: true });
  // The last answer stays loaded while the next query runs, and through its failure; its rows never stand in for it.
  const answered = data != null && (data.query?.text ?? "") === (parseBondQuery(needle)?.text ?? "");
  const bonds = answered ? data.bonds : NO_BONDS;
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const [sort, setSort] = usePluginPaneState<BondSort>("sort", DEFAULT_BOND_SORT);
  const { active: searchActive, focus: focusSearch, searchProps } = useQueryBarSearch();

  useAutoRefresh(updatedAt, load);

  // One issuer's tape says its name once, in what was asked, not on every row.
  const sharedIssuer = useMemo(() => sharesOneIssuer(bonds), [bonds]);
  const columns = useMemo(() => buildBondColumns(width, { sharedIssuer }), [sharedIssuer, width]);
  const shownSort = shownBondSort(sort, sharedIssuer);
  const rows = useMemo(() => sortBonds(bonds, shownSort), [bonds, shownSort]);
  const tradeDate = answered ? data.tradeDate : null;
  const footerInfo = useMemo(
    () => (tradeDate ? [{ id: "trade-date", parts: [{ text: tradeDate }] }] : []),
    [tradeDate],
  );
  const notices = answered ? [...(data.truncated ? [TRUNCATED_TEXT] : []), ...data.failures] : [];
  const fallback = answered && data.query && data.issuer && bonds.length > 0
    ? issuerFallbackText(data.query, data.issuer)
    : null;

  useEffect(() => {
    if (!answered) return;
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !rows.some((row) => row.id === selectedId)) setSelectedId(rows[0]!.id);
  }, [answered, rows, selectedId, setSelectedId]);

  // A bond opens on its kept prints: Enter on a row, and with Gloom Pro a CUSIP looked up opens on its own once.
  const [detailOpen, setDetailOpen] = usePluginPaneState("detailOpen", false);
  const selectedBond = rows.find((row) => row.id === selectedId) ?? null;
  const openedFor = useRef<string | null>(null);
  const asked = answered ? data.query : null;
  useEffect(() => {
    if (!pro || asked?.kind !== "cusip" || rows.length !== 1 || openedFor.current === asked.cusip) return;
    openedFor.current = asked.cusip;
    setDetailOpen(true);
  }, [asked, pro, rows.length, setDetailOpen]);
  // A ticker looked up keeps its company's bonds from now on, as `fn TRACE` does; nothing waits on it.
  useEffect(() => {
    if (!pro || asked?.kind !== "issuer" || !asked.ticker) return;
    const controller = new AbortController();
    void apiClient.getCloudStoredIssuerBonds(asked.ticker, { signal: controller.signal }).catch(() => {
      // Intentional ignore: keeping the company's bonds is a side effect; the tape shows without it.
    });
    return () => controller.abort();
  }, [asked, pro]);
  const detailCusip = detailOpen && selectedBond?.cusip ? selectedBond.cusip : null;
  const historyRequest = useCallback(() => loadStoredBond(detailCusip!, apiClient), [detailCusip]);
  const history = useAsyncResource(detailCusip && pro ? historyRequest : null);
  // Without Pro, refused or failed: the detail says why in place of the prints.
  const historyRefusal = !pro ? PRO_HISTORY_TEXT
    : history.data?.refusal ?? (history.error && !history.data ? unavailableText("Kept price history") : null);
  usePaneRefreshKey(() => {
    reload();
    if (detailCusip && pro) history.load();
  }, { focused, enabled: !searchActive });

  const onHeaderClick = useCallback((columnId: string) => {
    if (!isBondColumnId(columnId)) return;
    setSort((current) => nextHeaderSort(shownBondSort(current, sharedIssuer), columnId, {
      firstDirection: firstBondSortDirection,
      resetTo: DEFAULT_BOND_SORT,
    }));
  }, [setSort, sharedIssuer]);

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
          text: row.issuerName || MISSING_VALUE,
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

  // A failure or a load for another query is the table's own message; the footer keeps the answered query's status.
  usePaneStatusFooter({
    registrationId: TRACE_BONDS_PANE_ID,
    loading: (loading && answered) || (!!detailCusip && history.loading && !history.data),
    error: answered ? error : null,
    info: footerInfo,
  });
  usePaneNoticeFooter({
    registrationId: `${TRACE_BONDS_PANE_ID}-notices`,
    notices,
    focused,
  });

  return (
    <DataTableStackView
      focused={focused && !searchActive}
      detailOpen={detailOpen && !!selectedBond}
      onBack={() => setDetailOpen(false)}
      detailTitle={selectedBond ? bondTitle(selectedBond) : undefined}
      detailContent={selectedBond ? (
        <BondHistoryDetail
          bond={selectedBond}
          history={history.data?.history ?? null}
          loading={!!detailCusip && pro && history.loading && !history.data}
          refusal={historyRefusal}
          focused={focused && detailOpen}
          width={width}
          height={Math.max(0, height - 1)}
        />
      ) : null}
      onActivate={(row) => {
        setSelectedId(row.id);
        setDetailOpen(true);
      }}
      rootWidth={width}
      rootHeight={height}
      rootBefore={(
        <Box flexDirection="column" width={width}>
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
          {fallback ? <Box paddingX={1} width={width}><Notice tone="muted">{fallback}</Notice></Box> : null}
        </Box>
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
      sortColumnId={shownSort.columnId}
      sortDirection={shownSort.direction}
      onHeaderClick={onHeaderClick}
      onSortChange={(columnId, direction) => {
        if (isBondColumnId(columnId)) setSort({ columnId, direction });
      }}
      resetScrollKey={`${needle}:${shownSort.columnId ?? ""}:${shownSort.direction}`}
      getItemKey={(row) => row.id}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={error && !answered ? unavailableText("Bond tape")
        : !answered ? loadingText("bond sales")
          : data.query ? noPrintsText(data.query, data.tradeDate, data.issuer) : "No recent sales."}
      emptyStateHint={error && !answered ? error : undefined}
    />
  );
}
