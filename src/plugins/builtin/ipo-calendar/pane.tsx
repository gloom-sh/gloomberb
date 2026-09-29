import { useCallback, useMemo, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneTabs,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../components";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import type { IpoDeal, IpoStatus } from "../../../api-client/ipo";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { priceColor, type ThemeColors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginTickerActions } from "../../runtime";
import { getCachedIpoCalendar, loadIpoCalendar } from "./client";
import {
  buildIpoColumns,
  DEFAULT_IPO_SORT,
  filterIpoDeals,
  firstIpoSortDirection,
  calendarDate,
  formatIpoDate,
  formatIpoPrice,
  formatIpoReturn,
  formatIpoSize,
  IPO_CALENDAR_PANE_ID,
  IPO_TABS,
  ipoTickerKey,
  isIpoTab,
  marketsBehind,
  marketsBehindText,
  marketColumnWidth,
  MISSING,
  sortIpoDeals,
  type IpoColumn,
  type IpoColumnId,
  type IpoSortPreference,
  type IpoTab,
} from "./model";

const NO_DEALS: IpoDeal[] = [];
const TABS = IPO_TABS.map((tab) => ({ label: tab.label, value: tab.value as string }));
const dealKey = (deal: IpoDeal) => deal.id;

function statusColor(status: IpoStatus, colors: ThemeColors): string {
  switch (status) {
    case "upcoming": return colors.warning;
    case "priced": return colors.textBright;
    case "listed": return colors.positive;
    case "withdrawn": return colors.negative;
    case "filed":
    case "postponed": return colors.textMuted;
  }
}

export function IpoCalendarPane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const { pinTicker } = usePluginTickerActions();
  const loader = useCallback((force: boolean) => loadIpoCalendar(force), []);
  const resource = useAsyncResource(loader, { initialData: getCachedIpoCalendar });
  const payload = resource.data?.payload ?? null;
  const deals = payload?.deals ?? NO_DEALS;
  const [storedTab, setTab] = usePluginPaneState<IpoTab>("region", "all");
  const tab = isIpoTab(storedTab) ? storedTab : "all";
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [sort, setSort] = useState<IpoSortPreference>(DEFAULT_IPO_SORT);
  const [query, setQuery] = useState("");
  const { active: searching, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();

  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: !searching });

  const rows = useMemo(() => sortIpoDeals(filterIpoDeals(deals, tab, query), sort), [deals, query, sort, tab]);
  // The cursor starts on the first deal, and moves there when its deal leaves the list.
  const selected = rows.find((deal) => deal.id === selectedId) ?? rows[0] ?? null;
  // Sized on the whole board, so switching tabs does not move the columns.
  const marketWidth = useMemo(() => marketColumnWidth(deals), [deals]);
  const columns = useMemo(() => buildIpoColumns(width, marketWidth), [marketWidth, width]);

  const openDeal = useCallback((deal: IpoDeal) => {
    const key = ipoTickerKey(deal);
    if (!key) return;
    blurSearch();
    pinTicker(key, { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null });
  }, [blurSearch, pinTicker]);

  const selectTab = useCallback((value: string) => {
    if (isIpoTab(value)) setTab(value);
  }, [setTab]);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: TABS,
    activeValue: tab,
    onSelect: selectTab,
    focused: focused && !searching,
    compact: true,
    variant: "bare",
  });
  const tabs = tabStrip && <Box height={1} flexShrink={0} overflow="hidden">{tabStrip}</Box>;

  // A board kept from before a failed refresh is old, not partial: the
  // footer says stale rather than repeating the error.
  const stale = !!payload && (resource.data?.stale === true || !!resource.error);
  const behind = payload && !stale ? marketsBehindText(marketsBehind(payload.sources, tab, deals)) : null;
  const info = useMemo<PaneFooterSegment[]>(
    () => (behind ? [{ id: "behind", parts: [{ text: behind, tone: "warning" }] }] : []),
    [behind],
  );
  const hints = useMemo<PaneHint[]>(() => (
    deals.length > 0 ? [{ id: "ipo-search", key: "/", label: "search", onPress: focusSearch }] : []
  ), [deals.length, focusSearch]);
  usePaneStatusFooter({
    registrationId: IPO_CALENDAR_PANE_ID,
    loading: resource.loading && !!payload,
    stale,
    info,
    hints,
  });

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

  const renderCell = useCallback((deal: IpoDeal, column: IpoColumn): DataTableCell => {
    switch (column.id) {
      case "ticker":
        return deal.symbol
          ? { text: deal.symbol, color: colors.textBright, attributes: TextAttributes.BOLD }
          : { text: MISSING, color: colors.textMuted };
      case "company":
        return { text: deal.company, color: colors.text };
      case "market":
        return { text: deal.venue || deal.mic, color: colors.textDim };
      case "date": {
        // A target date the venue has not set yet reads quieter than a set
        // one, and so does a book's closing day standing in for a listing
        // date nobody has named.
        const date = calendarDate(deal);
        return {
          text: formatIpoDate(date),
          value: date,
          color: !deal.listingDate || deal.dateKind === "expected" ? colors.textMuted : colors.text,
        };
      }
      case "status":
        return { text: deal.status, color: statusColor(deal.status, colors) };
      case "price": {
        const text = formatIpoPrice(deal);
        return { text, color: text === MISSING ? colors.textMuted : colors.text };
      }
      case "size":
        return { text: formatIpoSize(deal.offerSizeUsd), value: deal.offerSizeUsd, color: colors.textDim };
      case "return": {
        const value = deal.firstDay?.returnPct ?? null;
        return {
          text: formatIpoReturn(value),
          value: value == null ? null : value * 100,
          color: value == null ? colors.textMuted : priceColor(value, colors),
        };
      }
    }
  }, [colors]);

  if (!payload) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading={resource.loading} error={resource.error} subject="IPO calendar" empty={false} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableView<IpoDeal, IpoColumn>
        focused={focused && !searching}
        rootWidth={width}
        rootHeight={Math.max(1, height - tabRows)}
        rootBefore={(
          <QueryBar
            width={width}
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "company, ticker or market",
              focused,
              debounceMs: 250,
              ...searchProps,
            }}
          />
        )}
        onRootKeyDown={handleRootKeyDown}
        columns={columns}
        items={rows}
        getItemKey={dealKey}
        selection={{
          kind: "id",
          selectedId: selected?.id ?? null,
          getId: dealKey,
          onChange: (id) => setSelectedId(id),
        }}
        onActivate={openDeal}
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id as IpoColumnId, {
          firstDirection: firstIpoSortDirection,
          resetTo: DEFAULT_IPO_SORT,
        }))}
        onSortChange={(id, direction) => setSort({ columnId: id as IpoColumnId, direction })}
        renderCell={renderCell}
        selectedTextOverridesCellColor
        resetScrollKey={`${tab}:${query}`}
        emptyStateTitle={query.trim() ? "No matching IPOs." : "No IPOs."}
      />
    </Box>
  );
}
