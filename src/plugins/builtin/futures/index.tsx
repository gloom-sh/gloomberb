import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneMenuItems,
  useQueryBarSearch,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type DataTableVisibleRange,
  type PaneFooterSegment,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { usePaneVisible } from "../../../state/app/activity";
import { usePaneInstance } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { cycleSortPreference, nextHeaderSort } from "../../../utils/sort-values";
import { useAssetData, usePluginTickerActions } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { FUTURES_SERIES } from "./series";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { quoteObservation } from "../shared/report-freshness";
import {
  boardErrorMessage,
  boardHeadlineQuote,
  quoteBoardFooterInfo,
  quoteBoardStatus,
  useQuoteBoard,
  useVisibleBoardSymbols,
  type BoardQuoteMap,
} from "../shared/use-quote-board";
import {
  FUTURES_CONTRACTS,
  FUTURES_SECTOR_LABELS,
  futuresBoardContract,
  getContractsBySector,
  type FuturesSector,
} from "../../../market-data/futures-board";
import {
  buildFuturesRows,
  DEFAULT_FUTURES_SORT,
  effectiveCollapsedSectors,
  FUTURES_RETURN_COLUMNS,
  futuresRowId,
  type FuturesColumnId,
  type FuturesSortPreference,
  type FuturesTableRow,
} from "./model";
import {
  createFuturesColumns,
  FUTURES_COLUMN_DEFS,
  renderFuturesCell,
  resolveFuturesColumnIds,
  usesSessionText,
  type FuturesColumn,
} from "./table";
import { useFuturesBoardTerms } from "./use-board-terms";
import { useFrontContractReturns } from "./use-front-returns";

const FUTURES_PANE_ID = "futures";

const FUTURES_SYMBOLS = FUTURES_CONTRACTS.map((contract) => contract.symbol);

const alwaysNavigable = () => true;
const NO_BOARD_QUOTES: BoardQuoteMap = new Map();
/** Columns whose order moves with every tick; the others keep a fixed order. */
const LIVE_SORT_COLUMNS = new Set<string>([
  "status", "price", "change", "changePercent", "return1w", "return1m", "returnYtd", "volume", "time",
]);

export function FuturesPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const dataProvider = useAssetData();
  const paneInstance = usePaneInstance();
  const liveStreaming = useLiveStreamingSetting();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<FuturesSortPreference>(DEFAULT_FUTURES_SORT);
  // `FUT TTF` opens the board searched for the contract it names.
  const [searchQuery, setSearchQuery] = useState(() => paneInstance?.params?.query ?? "");
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const [collapsedSectors, setCollapsedSectors] = useState<ReadonlySet<FuturesSector>>(new Set());
  const [visibleRange, setVisibleRange] = useState<DataTableVisibleRange | null>(null);

  const contractsBySector = useMemo(() => getContractsBySector(), []);
  // The stream follows the rows on screen; collapsed sectors and filtered-out
  // contracts drop to the off-screen cadence. A sort on a live column moves
  // rows with every tick, so then every listed contract counts as on screen.
  const windowSymbols = useMemo(
    () => buildFuturesRows(contractsBySector, sortPreference, NO_BOARD_QUOTES, {
      query: searchQuery,
      collapsed: collapsedSectors,
    }).map((row) => (row.type === "row" ? row.contract.symbol : null)),
    [collapsedSectors, contractsBySector, searchQuery, sortPreference],
  );
  // The rows the board lists: the cached board paints at once and only these
  // are refreshed, so `FUT gold` waits on gold alone.
  const listedSymbols = useMemo(
    () => new Set(windowSymbols.filter((symbol): symbol is string => symbol !== null)),
    [windowSymbols],
  );
  const liveSort = sortPreference.columnId !== null && LIVE_SORT_COLUMNS.has(sortPreference.columnId);
  const visibleSymbols = useVisibleBoardSymbols(
    windowSymbols,
    liveSort || !visibleRange ? { start: 0, end: windowSymbols.length } : visibleRange,
  );
  const { quotes, refresh } = useQuoteBoard(FUTURES_SYMBOLS, {
    liveStreaming,
    visibleSymbols,
    selectedSymbol: selectedId,
    cacheFirst: true,
    listedSymbols,
  });
  // Status, the empty state and the report's date describe the listed rows, not the hidden ones.
  const listedQuotes = useMemo<BoardQuoteMap>(
    () => new Map([...quotes].filter(([symbol]) => listedSymbols.has(symbol))),
    [listedSymbols, quotes],
  );
  const listedContracts = useMemo(
    () => FUTURES_CONTRACTS.filter((contract) => listedSymbols.has(contract.symbol)),
    [listedSymbols],
  );
  const visibleColumnIds = useMemo(
    () => resolveFuturesColumnIds(paneInstance?.settings?.columnIds as string[] | undefined),
    [paneInstance?.settings?.columnIds],
  );
  const columns = useMemo<FuturesColumn[]>(
    () => createFuturesColumns(width, visibleColumnIds),
    [visibleColumnIds, width],
  );
  const paneVisible = usePaneVisible();
  const showsReturns = columns.some((column) => FUTURES_RETURN_COLUMNS[column.id]);
  const returns = useFrontContractReturns(listedContracts, quotes, dataProvider, showsReturns && paneVisible);
  // The unit a price counts and the month a symbol rolled past, as `quote` reads them.
  const terms = useFuturesBoardTerms(listedContracts, !!dataProvider && paneVisible);

  const visibleCollapsed = effectiveCollapsedSectors(collapsedSectors, searchQuery);
  const rows = useMemo(
    () => buildFuturesRows(contractsBySector, sortPreference, quotes, {
      query: searchQuery,
      collapsed: collapsedSectors,
      returns,
      terms,
    }),
    [collapsedSectors, contractsBySector, quotes, returns, searchQuery, sortPreference, terms],
  );

  const sessionText = usesSessionText(width);
  const quotesRef = useRef(quotes);
  const returnsRef = useRef(returns);
  const termsRef = useRef(terms);
  quotesRef.current = quotes;
  returnsRef.current = returns;
  termsRef.current = terms;
  const renderCell = useCallback((
    row: FuturesTableRow,
    column: FuturesColumn,
  ) => renderFuturesCell(row, column, quotesRef.current, { sessionText, returns: returnsRef.current, terms: termsRef.current }), [sessionText]);
  // Everything a cell reads: the headline figures the board shows, the quote's
  // other fields, whether the last good quote is held over, and the returns.
  const getRowVersion = useCallback((row: FuturesTableRow) => {
    if (row.type !== "row") return row.sector;
    const state = quotes.get(row.contract.symbol);
    const quote = state?.quote ? boardHeadlineQuote(state.quote) : null;
    const values = returns.get(row.contract.symbol);
    const contract = terms.get(row.contract.symbol);
    return [
      state?.loading, state?.stale,
      quote?.price, quote?.change, quote?.changePercent, quote?.previousClose, quote?.volume, quote?.lastUpdated, quote?.marketState, quote?.symbol, quote?.name,
      values?.loading, values?.values["1W"], values?.values["1M"], values?.values.YTD,
      contract?.loading, contract?.terms?.spec?.unit, contract?.terms?.deliveryMonth, contract?.terms?.nearest?.contract,
      contract?.terms?.nearest?.lastTrade,
    ].join(":");
  }, [quotes, returns, terms]);

  const toggleSector = useCallback((sector: FuturesSector) => {
    setCollapsedSectors((current) => {
      const next = new Set(current);
      if (next.has(sector)) next.delete(sector);
      else next.add(sector);
      return next;
    });
  }, []);

  // Memoized so the table's row memo holds while the selection moves.
  const renderSectorHeader = useCallback((row: FuturesTableRow) => (
    row.type === "header"
      ? {
        text: FUTURES_SECTOR_LABELS[row.sector],
        expanded: !visibleCollapsed.has(row.sector),
        onMouseDown: () => toggleSector(row.sector),
      }
      : null
  ), [toggleSector, visibleCollapsed]);

  const cycleSort = useCallback((step: 1 | -1) => {
    setSortPreference((current) => cycleSortPreference<FuturesColumnId>(
      visibleColumnIds,
      current,
      step,
      { allowUnsorted: true },
    ));
  }, [visibleColumnIds]);
  // [ and ] step through the sort orders; the pane menu is where they show.
  usePaneMenuItems(`${FUTURES_PANE_ID}:sort-keys`, () => [
    { id: "sort-next", label: "Next Sort", accelerator: "]", onSelect: () => cycleSort(1) },
    { id: "sort-previous", label: "Previous Sort", accelerator: "[", onSelect: () => cycleSort(-1) },
  ], [cycleSort]);

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId && rows.some((row) => futuresRowId(row) === selectedId)) return;
    const firstNavigable = rows.find((row) => row.type === "row") ?? rows[0];
    setSelectedId(firstNavigable ? futuresRowId(firstNavigable) : null);
  }, [rows, selectedId]);

  // The footer binds the `/` search hint.
  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return true;
    if (isPlainKey(event, "]") || isPlainKey(event, "[")) {
      stopSearchFocusNavigation(event);
      cycleSort(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, [cycleSort, refresh]);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return handlePaneKey(event);
  }, [focusSearch, handlePaneKey]);

  // `fn FUT` and `shot FUT` are dated by the quotes the board shows, as `quote` dates them:
  // the newest, its delay, and whether the markets are open.
  useRemoteUiNode(listedQuotes.size > 0 ? {
    role: "report-freshness",
    label: "Quote freshness",
    getMetadata: () => {
      const now = Date.now();
      return { observations: [...listedQuotes.values()].flatMap((state) => (state.quote ? [quoteObservation(state.quote, now)] : [])) };
    },
  } : null);

  const status = quoteBoardStatus(listedQuotes);
  const errorMessage = boardErrorMessage(listedQuotes);
  // Every load came back empty: a board of dashes reads as broken, so the
  // body says so once and offers a retry. One quote is enough to keep rows.
  const noQuotes = !!dataProvider && listedQuotes.size > 0 && status.unavailable === listedQuotes.size;
  usePaneFooter(FUTURES_PANE_ID, () => {
    if (noQuotes) return { info: [], hints: [] };
    const info: PaneFooterSegment[] = quoteBoardFooterInfo(status);
    if (errorMessage) info.push({ id: "reason", parts: [{ text: errorMessage, tone: "warning" }] });
    return {
      info,
      hints: [{ id: "search", key: "/", label: "search", onPress: focusSearch }],
    };
  }, [
    errorMessage,
    focusSearch,
    noQuotes,
    status.latestTs,
    status.loading,
    status.stale,
    status.unavailable,
  ]);

  if (noQuotes) {
    return (
      <PaneStatusBody
        width={width}
        height={height}
        error={errorMessage ?? "No quotes returned."}
        subject="Futures quotes"
        retry={{ onRetry: refresh }}
      />
    );
  }

  return (
    <DataTableView<FuturesTableRow, FuturesColumn>
      focused={focused && !searchFocused}
      selection={{
        kind: "id",
        selectedId,
        getId: (row) => futuresRowId(row),
        onChange: (id) => setSelectedId(id),
      }}
      isNavigable={alwaysNavigable}
      onActivate={(row) => {
        if (row.type === "header") {
          toggleSector(row.sector);
          return;
        }
        pinTicker(row.contract.symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
      }}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={dataProvider ? rows : []}
      sortable
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={(columnId) => setSortPreference((current) => nextHeaderSort(current, columnId as FuturesColumnId, {
        resetTo: DEFAULT_FUTURES_SORT,
      }))}
      onSortChange={(columnId, direction) => setSortPreference((current) => ({ ...current, columnId: columnId as FuturesSortPreference["columnId"], direction }))}
      getItemKey={futuresRowId}
      visibleRangeKey={windowSymbols.join(",")}
      onVisibleRangeChange={setVisibleRange}
      renderSectionHeader={renderSectorHeader}
      renderCell={renderCell}
      getRowVersion={getRowVersion}
      selectedTextOverridesCellColor
      reportEveryRow
      emptyStateTitle={searchQuery.trim()
        ? "No matching contracts."
        : "No market data provider connected."}
      emptyStateHint={searchQuery.trim() ? "Clear search." : undefined}
      rootBefore={(
        <QueryBar
          width={width}
          search={{
            value: searchQuery,
            onChange: setSearchQuery,
            placeholder: "ticker or name",
            focused,
            ...searchProps,
            debounceMs: 80,
          }}
        />
      )}
      onRootKeyDown={handleRootKeyDown}
    />
  );
}

export const futuresModule: PluginModule = {
  series: FUTURES_SERIES,
  panes: [
    {
      id: FUTURES_PANE_ID,
      name: "Futures",
      icon: "F",
      component: FuturesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 76, height: 34 },
      tableExport: true,
      shotFitsRows: true,
      // Resolved per open so the dialog shows the full default set until the
      // user saves a narrower selection.
      settings: (context) => ({
        title: "Futures Settings",
        values: {
          columnIds: resolveFuturesColumnIds(context.settings.columnIds as string[] | undefined),
        },
        fields: [{
          key: "columnIds",
          label: "Columns",
          type: "ordered-multi-select",
          options: FUTURES_COLUMN_DEFS.map((column) => ({
            value: column.id,
            label: column.label,
            description: column.description,
          })),
        }],
      }),
    },
  ],

  paneTemplates: [
    {
      id: "futures-pane",
      paneId: FUTURES_PANE_ID,
      label: "Futures Board",
      description:
        "Each root's most active futures contract across equity index, equity sectors, rates, energy, metals, agriculture, livestock, and FX with last price, unit, session change, search, and collapsible sectors.",
      keywords: [
        "futures",
        "commodities",
        "crude",
        "oil",
        "gold",
        "silver",
        "copper",
        "corn",
        "wheat",
        "cattle",
        "hogs",
        "lumber",
        "aluminum",
        "ttf",
        "energy",
        "natural gas",
        "gas",
        "lng",
        "brent",
        "wti",
        "heating oil",
        "gasoline",
        "treasuries",
        "contracts",
        "cme",
      ],
      shortcut: {
        prefix: "FUT",
        aliases: ["GLCO"],
        argKind: "text",
        argPlaceholder: "code or name",
        argOptional: true,
      },
      // A board code or symbol searches for that contract alone (NG=F: a bare NG also matches Orange Juice); other text searches as typed.
      createInstance: (_context, options) => {
        const input = options?.arg?.trim();
        if (!input) return {};
        const query = futuresBoardContract(input)?.symbol ?? input;
        return { title: `FUT ${input.toUpperCase()}`, params: { query } };
      },
    },
  ],
};
