import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, usePaneFooter, type DataTableKeyEvent } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import type { EarningsEvent } from "../../../types/data-provider";
import { useAppSelector, usePaneInstance } from "../../../state/app/context";
import { parseTickerListInput, formatTickerListInput } from "../../../tickers/list";
import { useAssetData, usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
import type { PaneSettingsContext, PaneSettingsDef } from "../../../types/plugin";
import { formatTickerListInput as formatTickers } from "../../../tickers/list";
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
import {
  buildEarningsColumns,
  renderEarningsCell,
  renderEarningsSectionHeader,
  type EarningsColumn,
} from "./table";

function EarningsCalendarPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { navigateTicker } = usePluginTickerActions();
  const pane = usePaneInstance();
  const [events, setEvents] = useState<EarningsEvent[]>([]);
  // Starts loading so the first frame never claims there are no earnings.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [selectedIdx, setSelectedIdx] = usePluginPaneState<number>("selectedIdx", 0);
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
  const activeEventIdx = eventCount > 0 ? Math.min(Math.max(selectedIdx, 0), eventCount - 1) : -1;
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

  useEffect(() => {
    if (eventCount > 0 && selectedIdx >= eventCount) {
      setSelectedIdx(eventCount - 1);
    }
  }, [eventCount, selectedIdx, setSelectedIdx]);

  const openEvent = useCallback((event: EarningsEvent) => {
    navigateTicker(event.symbol);
  }, [navigateTicker]);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "r") {
      event.preventDefault?.();
      reload(true);
      return true;
    }
    return false;
  }, [reload]);

  const renderCell = useCallback((
    row: EarningsDisplayRow,
    column: EarningsColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => {
    return renderEarningsCell(row, column, rowState.selected);
  }, []);

  usePaneFooter("earnings-calendar", () => ({
    info: [
      ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
      ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ],
  }), [error, loading, stale]);

  return (
    <DataTableView<EarningsDisplayRow, EarningsColumn>
      focused={focused}
      selection={{
        kind: "index",
        selectedIndex: selectedRowIndex,
        onChange: (_index, row) => {
          if (row.kind === "event") setSelectedIdx(row.eventIdx);
        },
      }}
      isNavigable={(row) => row.kind === "event"}
      onActivate={(row) => {
        if (row.kind === "event") openEvent(row.event);
      }}
      onRootKeyDown={handleTableKeyDown}
      rootWidth={width}
      rootHeight={height}
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
          : tickerSymbols.length === 0
            ? "No tickers in scope."
            : "No upcoming earnings found"
      }
    />
  );
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
    values: { symbolsText: symbols.length > 0 ? formatTickers(symbols) : "" },
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
    ctx.registerCommand({
      id: "earnings-monitor-shortcut",
      label: "Earnings Monitor",
      keywords: ["earnings", "monitor", "calendar", "em", "eps"],
      shortcut: "EM",
      shortcutArg: {
        placeholder: "tickers",
        kind: "text",
        parse: (arg) => ({ tickers: arg.trim() }),
      },
      category: "data",
      description: "Open upcoming earnings, optionally scoped to tickers.",
      execute: (values) => {
        ctx.createPaneFromTemplate("earnings-monitor-pane", {
          arg: values?.tickers ?? "",
        });
      },
    });
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
      settings: earningsSettings,
    },
  ],

  paneTemplates: [
    {
      id: "earnings-calendar-pane",
      paneId: "earnings-calendar",
      label: "Earnings Calendar",
      description: "Upcoming earnings dates and estimates for your tickers.",
      keywords: ["earn", "earnings", "calendar", "eps", "revenue", "quarterly"],
      shortcut: { prefix: "ERN" },
      createInstance: (context) => ({
        settings: context.activeCollectionId
          ? { collectionId: context.activeCollectionId }
          : undefined,
      }),
    },
    {
      id: "earnings-monitor-pane",
      paneId: "earnings-calendar",
      label: "Earnings Monitor",
      description: "Upcoming earnings dates and estimates, optionally scoped to tickers.",
      keywords: ["earn", "earnings", "monitor", "em", "eps", "revenue"],
      canCreate: () => true,
      createInstance: (context, options) => {
        const raw = options?.arg?.trim() ?? "";
        const symbols = raw ? parseTickerListInput(raw) : [];
        return {
          title: symbols.length > 0 ? `EM ${formatTickerListInput(symbols)}` : "Earnings Monitor",
          placement: "floating",
          settings: symbols.length > 0
            ? {
              symbols,
              symbolsText: formatTickerListInput(symbols),
            }
            : context.activeCollectionId
              ? { collectionId: context.activeCollectionId }
              : undefined,
        };
      },
    },
  ],
};
