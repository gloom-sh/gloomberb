import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableStackView, usePaneFooter, type DataTableKeyEvent } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import type { EarningsEvent } from "../../../types/data-provider";
import { useAppSelector, usePaneInstance, usePaneSettingValue } from "../../../state/app/context";
import { parseTickerListInput, formatTickerListInput } from "../../../tickers/list";
import { useAssetData, usePluginAppActions, usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useUiCapabilities } from "../../../ui";
import { EarningsDetailView } from "./detail-view";
import { useAutoRefresh } from "../shared/auto-refresh";
import type {
  PaneSettingsContext,
  PaneSettingsDef,
  PaneTemplateCreateOptions,
} from "../../../types/plugin";
import {
  attachEarningsCalendarPersistence,
  loadEarningsCalendar,
  resetEarningsCalendarPersistence,
} from "./data/cache";
import {
  groupEarningsByRelativeDate,
  resolveEarningsCollectionId,
  resolveEarningsMonitorSymbols,
  scopedSymbolsFromSettings,
  trackedEarningsSymbols,
  type EarningsDisplayRow,
  type EarningsEventDisplayRow,
} from "./model";
import { earningsCalendarHeadless } from "./headless";
import {
  buildEarningsColumns,
  renderEarningsCell,
  renderEarningsSectionHeader,
  type EarningsColumn,
} from "./table";

function EarningsCalendarPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { navigateTicker } = usePluginTickerActions();
  const { createPaneFromTemplate } = usePluginAppActions();
  const { nativePaneChrome } = useUiCapabilities();
  // The open detail is remembered by symbol and date so a reload keeps it.
  const [openKey, setOpenKey] = usePluginPaneState<string | null>("openEvent", null);
  // A layout or `gloomberb shot ERN NVDA,AMD --open NVDA` lands on that
  // company's next report instead of the list.
  const [openSymbol] = usePaneSettingValue<string>("open", "");
  const openedSymbol = useRef<string | null>(null);
  const pane = usePaneInstance();
  const [events, setEvents] = useState<EarningsEvent[]>([]);
  // Starts loading so the first frame never claims there are no earnings.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // Keyed like the open event, so a reload or a shared layout keeps the row.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  const requestIdRef = useRef(0);

  const tickers = useAppSelector((state) => state.tickers);
  const legacyCollectionId = useAppSelector((state) => (
    state.config.portfolios[0]?.id ?? state.config.watchlists[0]?.id ?? null
  ));
  const scopedSymbols = useMemo(() => scopedSymbolsFromSettings(pane?.settings), [pane?.settings]);
  const scopedCollectionId = useMemo(
    () => resolveEarningsCollectionId(pane?.settings, legacyCollectionId),
    [legacyCollectionId, pane?.settings],
  );
  const fallbackTickerSymbols = useMemo(
    () => trackedEarningsSymbols(tickers.values(), scopedCollectionId),
    [scopedCollectionId, tickers],
  );
  const tickerSymbols = useMemo(
    () => resolveEarningsMonitorSymbols(scopedSymbols, fallbackTickerSymbols),
    [fallbackTickerSymbols, scopedSymbols],
  );

  const rows = useMemo(() => groupEarningsByRelativeDate(events), [events]);
  const eventRows = useMemo(
    () => rows.filter((row): row is EarningsEventDisplayRow => row.kind === "event"),
    [rows],
  );
  const eventCount = eventRows.length;
  const activeEventIdx = eventCount > 0
    ? Math.max(0, eventRows.findIndex((row) => eventKey(row.event) === selectedKey))
    : -1;
  const selectedRowIndex = rows.findIndex((row) => row.kind === "event" && row.eventIdx === activeEventIdx);
  const columns = useMemo(() => buildEarningsColumns(width), [width]);

  const reload = useCallback((force = false) => {
    const requestId = ++requestIdRef.current;
    if (tickerSymbols.length === 0) {
      setEvents([]);
      setError(null);
      setStale(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    loadEarningsCalendar(dataProvider, tickerSymbols, { force })
      .then((result) => {
        if (requestId !== requestIdRef.current) return;
        setEvents(result.events);
        setStale(result.stale);
        setError(result.refreshError ?? null);
        setLastUpdated(result.fetchedAt);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
      });
  }, [dataProvider, tickerSymbols]);

  useEffect(() => {
    reload(false);
  }, [reload]);

  // The 30-minute cache decides whether a tick reaches the provider.
  const refresh = useCallback(() => reload(false), [reload]);
  useAutoRefresh(stale ? null : lastUpdated, refresh);

  useEffect(() => () => {
    requestIdRef.current += 1;
  }, []);

  const selectedEvent = eventRows[activeEventIdx]?.event ?? null;

  useEffect(() => {
    const symbol = openSymbol.trim().toUpperCase();
    if (!symbol || openedSymbol.current === symbol || events.length === 0) return;
    const match = eventRows.find((row) => row.event.symbol === symbol)?.event;
    if (!match) return;
    openedSymbol.current = symbol;
    setOpenKey(eventKey(match));
  }, [eventRows, events.length, openSymbol, setOpenKey]);
  const openEvent = useMemo(
    () => (openKey ? events.find((event) => eventKey(event) === openKey) ?? null : null),
    [events, openKey],
  );

  const openTicker = useCallback((symbol: string) => navigateTicker(symbol), [navigateTicker]);
  const openEstimates = useCallback((symbol: string) => createPaneFromTemplate("earnings-estimates-pane", { symbol }), [createPaneFromTemplate]);
  const openCalls = useCallback((symbol: string) => createPaneFromTemplate("earnings-calls-pane", { symbol }), [createPaneFromTemplate]);
  const openAnalysts = useCallback((symbol: string) => createPaneFromTemplate("analyst-research-pane", { symbol }), [createPaneFromTemplate]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    const symbol = openEvent?.symbol ?? selectedEvent?.symbol ?? null;
    if (event.name === "r") {
      event.preventDefault?.();
      reload(true);
      return true;
    }
    if (!symbol) return false;
    const actions: Record<string, (symbol: string) => void> = { t: openTicker, e: openEstimates, c: openCalls, a: openAnalysts };
    const action = event.name ? actions[event.name] : undefined;
    if (!action) return false;
    event.preventDefault?.();
    action(symbol);
    return true;
  }, [openAnalysts, openCalls, openEstimates, openEvent, openTicker, reload, selectedEvent]);

  const renderCell = useCallback((
    row: EarningsDisplayRow,
    column: EarningsColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => {
    return renderEarningsCell(row, column, rowState.selected);
  }, []);

  usePaneFooter("earnings-calendar", () => {
    const symbol = openEvent?.symbol ?? selectedEvent?.symbol ?? null;
    return {
      info: [
        ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
        ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
        ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
      ],
      hints: symbol
        ? [
            { id: "ticker", key: "t", label: "icker", onPress: () => openTicker(symbol) },
            { id: "estimates", key: "e", label: "stimates", onPress: () => openEstimates(symbol) },
            { id: "calls", key: "c", label: "alls", onPress: () => openCalls(symbol) },
            { id: "analysts", key: "a", label: "nalysts", onPress: () => openAnalysts(symbol) },
          ]
        : [],
    };
  }, [error, loading, stale, openEvent, selectedEvent, openTicker, openEstimates, openCalls, openAnalysts]);

  const detailContent = openEvent ? (
    <EarningsDetailView
      event={openEvent}
      width={width}
      height={Math.max(4, height - 1)}
    />
  ) : null;

  return (
    <DataTableStackView<EarningsDisplayRow, EarningsColumn>
      focused={focused}
      detailOpen={!!openEvent}
      onBack={() => setOpenKey(null)}
      detailTitle={openEvent ? `${openEvent.symbol} · ${openEvent.name}` : undefined}
      detailContent={detailContent}
      onDetailKeyDown={handleKeyDown}
      selection={{
        kind: "index",
        selectedIndex: selectedRowIndex,
        onChange: (_index, row) => {
          if (row.kind === "event") setSelectedKey(eventKey(row.event));
        },
      }}
      isNavigable={(row) => row.kind === "event"}
      onActivate={(row) => {
        if (row.kind === "event") setOpenKey(eventKey(row.event));
      }}
      onRootKeyDown={handleKeyDown}
      rootWidth={width}
      rootHeight={Math.max(3, height - (nativePaneChrome ? 1 : 0))}
      columns={columns}
      items={rows}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      getItemKey={(row) => row.key}
      renderSectionHeader={renderEarningsSectionHeader}
      renderCell={renderCell}
      emptyStateTitle={
        loading
          ? "Loading earnings..."
          : error && events.length === 0
            ? error
            : tickerSymbols.length === 0
              ? "No tickers in scope."
              : "No upcoming earnings found"
      }
    />
  );
}

function eventKey(event: EarningsEvent): string {
  return `${event.symbol}:${event.earningsDate.toISOString().slice(0, 10)}`;
}

/** Tickers named on the command bar or the CLI win over the active collection. */
function earningsScopeSymbols(options: PaneTemplateCreateOptions | undefined): string[] {
  if (options?.symbols && options.symbols.length > 0) return options.symbols;
  const raw = options?.arg?.trim() ?? "";
  if (!raw) return [];
  try {
    return parseTickerListInput(raw);
  } catch {
    return [];
  }
}

/** The monitor's scope lives in pane settings, so it has to be editable there too. */
function earningsSettings(context: PaneSettingsContext): PaneSettingsDef {
  const collections = [
    ...context.config.portfolios.map((portfolio) => ({ value: portfolio.id, label: portfolio.name })),
    ...context.config.watchlists.map((watchlist) => ({ value: watchlist.id, label: watchlist.name })),
  ];
  const symbols = scopedSymbolsFromSettings(context.settings);
  return {
    title: "Earnings Scope",
    values: { symbolsText: symbols.length > 0 ? formatTickerListInput(symbols) : "" },
    fields: [
      {
        key: "symbolsText",
        label: "Tickers",
        description: "Leave empty to follow a collection instead.",
        type: "text",
        placeholder: "AAPL, MSFT",
        clearOnChange: ["symbols"],
      },
      ...(collections.length > 0 ? [{
        key: "collectionId",
        label: "Collection",
        description: "Used when no tickers are listed above.",
        type: "select" as const,
        options: [{ value: "", label: "All tracked tickers" }, ...collections],
      }] : []),
    ],
  };
}

export const earningsModule: PluginModule = {
  setup(ctx) {
    attachEarningsCalendarPersistence(ctx.persistence);
  },

  dispose() {
    resetEarningsCalendarPersistence();
  },

  panes: [
    {
      id: "earnings-calendar",
      name: "Earnings Calendar",
      icon: "$",
      component: EarningsCalendarPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 85, height: 25 },
      tableExport: true,
      settings: earningsSettings,
    },
  ],

  paneTemplates: [
    {
      id: "earnings-calendar-pane",
      paneId: "earnings-calendar",
      label: "Earnings Calendar",
      description: "Upcoming earnings dates and estimates: alone, for your portfolio and watchlists; with tickers, for those.",
      keywords: ["earn", "earnings", "calendar", "monitor", "em", "eps", "revenue", "quarterly"],
      // Tickers are optional on purpose: ERN alone follows the active
      // collection and must not silently narrow to the active ticker.
      shortcut: { prefix: "ERN", argPlaceholder: "tickers", argKind: "ticker-list", argOptional: true },
      headless: earningsCalendarHeadless,
      canCreate: () => true,
      // Tickers named on the command bar win over the collection. Ignoring
      // them left `ERN NKE` scoped to the active collection, which rendered
      // "No tickers in scope" while the report listed NKE's earnings.
      createInstance: (context, options) => {
        const symbols = earningsScopeSymbols(options);
        return {
          title: symbols.length > 0 ? `ERN ${formatTickerListInput(symbols)}` : "Earnings Calendar",
          placement: "floating",
          settings: symbols.length > 0
            ? { symbols, symbolsText: formatTickerListInput(symbols) }
            : context.activeCollectionId
              ? { collectionId: context.activeCollectionId }
              : undefined,
        };
      },
    },
  ],
};
