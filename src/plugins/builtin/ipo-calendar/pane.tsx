import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { IpoDeal } from "../../../api-client/ipo";
import { useAsyncResource, useAutoRefresh, usePluginPaneState } from "../../../public/react";
import { priceColor, type ThemeColors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { usePaneInstance } from "../../../state/app/context";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes, useUiCapabilities } from "../../../ui";
import { COUNTRY_FLAG_CELLS, withCountryFlag } from "../../../components/ui/country-flag";
import { stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { useSearchFocusUp } from "../../../components/input-search-bar";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginTickerActions } from "../../runtime";
import { useCommandValue } from "../shared/command-tab";
import { withoutQuietColumns } from "../shared/research-cells";
import { getCachedIpoCalendar, loadIpoCalendar } from "./client";
import {
  buildIpoColumns,
  DEFAULT_IPO_SORT,
  filterIpoDeals,
  firstIpoSortDirection,
  formatIpoDate,
  formatIpoLockupDate,
  formatIpoPrice,
  formatIpoReturn,
  formatIpoSize,
  IPO_CALENDAR_PANE_ID,
  IPO_LISTS,
  IPO_TABS,
  ipoBoardStatus,
  ipoDateColumnWidths,
  ipoListStatus,
  ipoPriceMayBeBlank,
  ipoShownDate,
  isIpoList,
  ipoTickerKey,
  isIpoTab,
  marketsBehind,
  marketsBehindText,
  marketColumnWidth,
  MISSING,
  sortIpoDeals,
  type IpoBoardStatus,
  type IpoColumn,
  type IpoColumnId,
  type IpoList,
  type IpoSortPreference,
  type IpoTab,
} from "./model";

/** A deal's PRICE: its offer price or range, with a dash marked as one that may be blank only on a deal that owes none. */
export function ipoPriceCell(deal: IpoDeal, colors: Pick<ThemeColors, "text" | "textMuted">): DataTableCell {
  const text = formatIpoPrice(deal);
  return { text, color: text === MISSING ? colors.textMuted : colors.text, ...(ipoPriceMayBeBlank(deal) ? { mayBeBlank: true } : {}) };
}

const NO_DEALS: IpoDeal[] = [];
const TABS = IPO_TABS.map((tab) => ({ label: tab.label, value: tab.value as string }));
const dealKey = (deal: IpoDeal) => deal.id;
/** A STATUS column whose cells are all blank (every deal has the list's own status), and a LOCKUP column with no estimate in it. */
const QUIET_COLUMNS = { status: [""], lockup: [MISSING] };

/**
 * A deal's status, shown only where it differs from its list's own, in colour
 * only where it says something: a book open now, terms set, a deal pulled. A
 * filing, a late or postponed deal read in the quiet tone the rest of the list shares.
 */
function statusColor(status: IpoBoardStatus, colors: ThemeColors): string {
  switch (status) {
    case "offering": return colors.warning;
    case "priced": return colors.textBright;
    case "withdrawn": return colors.negative;
    case "listed": return colors.text;
    case "upcoming":
    case "overdue":
    case "delayed":
    case "filed":
    case "postponed": return colors.textDim;
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
  // Upcoming deals and recent listings are two lists with their own columns.
  const [storedList, setList] = usePluginPaneState<IpoList | null>("list", null);
  const list: IpoList = isIpoList(storedList) ? storedList : "upcoming";
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selected", null);
  const [sort, setSort] = useState<IpoSortPreference>(DEFAULT_IPO_SORT);
  // `IPO japan` opens on that search, as `fn IPO japan` reads it.
  const [query, setQuery] = useCommandValue(IPO_CALENDAR_PANE_ID, "query", (params) => params.search ?? null, "");
  const { active: searching, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();

  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => resource.reload(), { focused, enabled: !searching });

  // One clock per board, so a deal's status, its place and a search for it agree.
  const now = useMemo(() => new Date(), [deals, resource.updatedAt]);
  const rows = useMemo(() => sortIpoDeals(filterIpoDeals(deals, tab, query, now, list), sort, now, query), [deals, list, now, query, sort, tab]);
  // A search that finds deals only on the other list says so, rather than reading as no match at all.
  const otherList: IpoList = list === "upcoming" ? "listed" : "upcoming";
  const otherMatches = useMemo(() => (query.trim() && rows.length === 0 ? filterIpoDeals(deals, tab, query, now, otherList).length : 0),
    [deals, now, otherList, query, rows.length, tab]);
  // `IPO arm` opens on the list its deals are on, once the board is in, as `fn IPO arm` lists them.
  const instance = usePaneInstance();
  const commandSearch = instance?.paneId === IPO_CALENDAR_PANE_ID ? instance.params?.search ?? null : null;
  const commandAt = commandSearch ? instance?.params?.tabAt ?? "" : null;
  // A list already chosen in this pane wins over the command it was opened with, until a newer command.
  const placedCommand = useRef<string | null>(storedList ? commandAt : null);
  useEffect(() => {
    // Waits for the search to be the command's and for deals to search.
    if (commandAt === null || placedCommand.current === commandAt || query !== commandSearch || deals.length === 0) return;
    placedCommand.current = commandAt;
    if (otherMatches > 0) setList(otherList);
  }, [commandAt, commandSearch, deals.length, otherList, otherMatches, query, setList]);
  // The cursor starts on the first deal, and moves there when its deal leaves the list.
  const selected = rows.find((deal) => deal.id === selectedId) ?? rows[0] ?? null;
  // Sized on the whole board, so switching tabs does not move the columns.
  // The desktop and the web lead each venue with its country's flag.
  const flagged = useUiCapabilities().nativePaneChrome === true;
  const marketWidth = useMemo(() => marketColumnWidth(deals) + (flagged ? COUNTRY_FLAG_CELLS : 0), [deals, flagged]);
  const dateWidths = useMemo(() => ipoDateColumnWidths(deals, now), [deals, now]);
  // STATUS says only what differs from the list's own (priced among the upcoming deals), and goes when nothing does;
  // LOCKUP goes when no deal listed has an estimate (one outside the US).
  const columns = useMemo(() => withoutQuietColumns(buildIpoColumns(width, marketWidth, list, dateWidths), rows,
    (deal, id) => (id === "status" ? ipoListStatus(deal, list, now) : id === "lockup" ? formatIpoLockupDate(deal.lockup?.endsOn, now) : null),
    QUIET_COLUMNS) as IpoColumn[], [dateWidths, list, marketWidth, now, rows, width]);

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

  const isSearchUp = useSearchFocusUp();
  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isSearchUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [isSearchUp, focusSearch]);

  const renderCell = useCallback((deal: IpoDeal, column: IpoColumn): DataTableCell => {
    switch (column.id) {
      case "ticker":
        return deal.symbol
          ? { text: deal.symbol, color: colors.textBright, attributes: TextAttributes.BOLD }
          : { text: MISSING, color: colors.textMuted };
      case "company":
        return { text: deal.company, color: colors.text };
      case "market":
        return withCountryFlag({ text: deal.venue || deal.mic, color: colors.textDim }, deal.country, flagged);
      case "date": {
        // A target date the venue has not set yet reads quieter than a set
        // one, and so does a book's closing day standing in for a listing
        // date nobody has named. A priced deal whose book has closed has no date ahead.
        const date = ipoShownDate(deal, now);
        return {
          text: formatIpoDate(date, now),
          value: date,
          color: !deal.listingDate || deal.dateKind === "expected" ? colors.textMuted : colors.text,
        };
      }
      case "status":
        return { text: ipoListStatus(deal, list, now), color: statusColor(ipoBoardStatus(deal, now), colors) };
      case "price":
        return ipoPriceCell(deal, colors);
      case "size":
        return { text: formatIpoSize(deal.offerSizeUsd), value: deal.offerSizeUsd, color: colors.textDim };
      case "return": {
        const value = deal.firstDay?.returnPct ?? deal.opening?.returnPct ?? null;
        return {
          text: value != null && deal.opening && !deal.firstDay ? `${formatIpoReturn(value)} open` : formatIpoReturn(value),
          value: value == null ? null : value * 100,
          color: value == null ? colors.textMuted : priceColor(value, colors),
        };
      }
      case "lockup": {
        // An estimate (~), as `fn IPO` gives it; one that has ended reads quieter than one ahead.
        const endsOn = deal.lockup?.endsOn ?? null;
        return {
          text: formatIpoLockupDate(endsOn, now),
          value: endsOn,
          color: !endsOn || endsOn < now.toISOString().slice(0, 10) ? colors.textMuted : colors.text,
        };
      }
    }
  }, [colors, flagged, list, now]);

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
              onChange: (value) => {
                setQuery(value);
                setSelectedId(null);
              },
              placeholder: "company, ticker or market",
              focused,
              debounceMs: 250,
              ...searchProps,
            }}
            // Which of the two lists the table shows, each with its own columns: the bar's view, first.
            view={{
              label: "List",
              start: true,
              value: list,
              options: IPO_LISTS,
              onChange: (value: IpoList) => {
                setList(value);
                setSelectedId(null);
                setSort(DEFAULT_IPO_SORT);
              },
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
        resetScrollKey={`${tab}:${list}:${query}`}
        emptyStateTitle={query.trim() ? `No matching ${list === "upcoming" ? "upcoming IPOs" : "recent listings"}.` : list === "upcoming" ? "No upcoming IPOs." : "No recent listings."}
        emptyStateHint={otherMatches ? `${IPO_LISTS.find((entry) => entry.value === otherList)!.label} has ${otherMatches}.` : undefined}
      />
    </Box>
  );
}
