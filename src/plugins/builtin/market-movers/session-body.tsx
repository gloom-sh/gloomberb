import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudSessionMoversCategory,
  CloudSessionMoversPayload,
  CloudSessionMoversSide,
} from "../../../api-client/market-movers";
import { usePlanAccess } from "../../../api-client/plan-access";
import { DataTableView, EmptyState, QueryBar, usePaneFooter, type DataTableKeyEvent } from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import {
  buildScreenerQuoteTargets,
  resolveScreenerQuoteFeedStatus,
} from "../../../market-data/quotes/screener-live-quotes";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { Box } from "../../../ui";
import { publicTickerKey } from "../../../utils/exchanges";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { ProWall, SignInWall } from "../cloud/auth-actions";
import { loadSessionMovers, SessionMoversAccessError } from "./client";
import { summaryFooterSegments } from "./footer";
import type { MarketSummaryQuote } from "./screener";
import {
  earlierSessionLabel,
  overlaySessionMovers,
  resolveSide,
  sessionListIsLive,
  sessionSides,
  sortSessionRows,
  type SessionMoverRow,
  type SessionMoverSortPreference,
  type UsSession,
} from "./session";
import { buildSessionMoverColumns, renderSessionMoverCell, type SessionMoverColumn } from "./session-table";

const DEFAULT_SORT: SessionMoverSortPreference = { columnId: null, direction: "asc" };
/** The lists are rebuilt once a minute; live quotes move the rows in between. */
const LIST_REFRESH_MS = 60_000;
const NO_ROWS: SessionMoverRow[] = [];
const rowKey = (row: Pick<SessionMoverRow, "symbol" | "exchange">) => publicTickerKey(row.symbol, row.exchange);

interface LoadedList {
  key: string;
  payload: CloudSessionMoversPayload;
}

/** Pre-market, after-hours and gap lists: Pro only, like the ranked lists they sit beside. */
export function SessionMoversBody(props: {
  view: CloudSessionMoversCategory;
  session: UsSession;
  focused: boolean;
  width: number;
  summaryQuotes: MarketSummaryQuote[];
  liveStreaming: boolean;
}) {
  const access = usePlanAccess();
  const [denied, setDenied] = useState(false);
  const deny = useCallback(() => setDenied(true), []);
  const entitled = access.emailVerified && access.hasProAccess && !denied;
  // Behind a wall the footer still carries the index summary; the list registers its own.
  usePaneFooter("market-movers-wall", () => (
    entitled ? null : { info: summaryFooterSegments(props.summaryQuotes) }
  ), [entitled, props.summaryQuotes]);

  if (!access.signedIn) return <SignInWall action="see pre-market, after-hours and gap movers" />;
  if (!access.emailVerified) return <SignInWall action="see pre-market, after-hours and gap movers" needsVerification />;
  if (!entitled) {
    return (
      <ProWall
        title="Pre-market, after-hours and gap movers are part of Gloom Cloud Pro."
        message="The whole listed US market from 04:00 to 20:00, with relative volume, VWAP, float and catalysts."
      />
    );
  }
  return <SessionMoversTable {...props} onDenied={deny} />;
}

function SessionMoversTable({ view, session, focused, width, summaryQuotes, liveStreaming, onDenied }: {
  view: CloudSessionMoversCategory;
  session: UsSession;
  focused: boolean;
  width: number;
  summaryQuotes: MarketSummaryQuote[];
  liveStreaming: boolean;
  onDenied: () => void;
}) {
  const { pinTicker } = usePluginTickerActions();
  const [savedSide, setSavedSide] = usePluginPaneState<CloudSessionMoversSide>("sessionSide", "up");
  const side = resolveSide(view, savedSide);
  const listKey = `${view}:${side}`;
  const [loaded, setLoaded] = useState<LoadedList | null>(null);
  // The first frame would otherwise claim an empty list.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<SessionMoverSortPreference>(DEFAULT_SORT);
  const fetchGenRef = useRef(0);

  const payload = loaded?.key === listKey ? loaded.payload : null;
  const listRows = payload?.items ?? NO_ROWS;
  const live = !!payload && sessionListIsLive(view, payload.session, session);

  const load = useCallback(async (options?: { forceRefresh?: boolean; background?: boolean }) => {
    const gen = ++fetchGenRef.current;
    if (!options?.background) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const next = await loadSessionMovers(view, side, options);
      if (fetchGenRef.current !== gen) return;
      setLoaded({ key: `${view}:${side}`, payload: next });
      setLoadError(null);
      setLastLoadedAt(Date.now());
    } catch (error) {
      if (fetchGenRef.current !== gen) return;
      if (error instanceof SessionMoversAccessError) {
        onDenied();
        return;
      }
      setLoadError("Session movers temporarily unavailable");
    } finally {
      if (fetchGenRef.current === gen && !options?.background) setLoading(false);
    }
  }, [onDenied, side, view]);

  useEffect(() => {
    setSelectedId(null);
    void load();
  }, [load]);
  const backgroundRefresh = useCallback(() => {
    void load({ background: true });
  }, [load]);
  useAutoRefresh(lastLoadedAt, backgroundRefresh, { intervalMs: LIST_REFRESH_MS });

  // A finished list keeps the prices it closed at, so it holds no quote subscriptions.
  const quoteTargets = useMemo(
    () => (live ? buildScreenerQuoteTargets(listRows, selectedId) : []),
    [listRows, live, selectedId],
  );
  const { entries, freshnessNow, subscriptionStartedAt } = useLiveQuoteEntries(quoteTargets, {
    freshnessScopeKey: `market-movers:${listKey}`,
    liveStreaming,
  });
  const rows = useMemo(
    () => sortSessionRows(live ? overlaySessionMovers(listRows, entries) : listRows, sortPreference),
    [entries, listRows, live, sortPreference],
  );
  const feedStatus = useMemo(
    () => resolveScreenerQuoteFeedStatus(quoteTargets, entries, { now: freshnessNow, subscriptionStartedAt }),
    [entries, freshnessNow, quoteTargets, subscriptionStartedAt],
  );
  const columns = useMemo(() => buildSessionMoverColumns(view, width), [view, width]);

  useEffect(() => {
    if (selectedId && rows.some((row) => rowKey(row) === selectedId)) return;
    setSelectedId(rows[0] ? rowKey(rows[0]) : null);
  }, [rows, selectedId]);

  const sessionLabel = payload ? earlierSessionLabel(payload.session, session) : null;
  usePaneFooter("market-movers", () => ({
    info: [
      ...(loadError ? [{ id: "load-error", parts: [{ text: loadError, tone: "warning" as const }] }] : []),
      ...summaryFooterSegments(summaryQuotes),
      ...(sessionLabel ? [{ id: "session", parts: [{ text: sessionLabel, tone: "muted" as const }] }] : []),
      ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(feedStatus ? [{
        id: "feed",
        parts: [{ text: feedStatus, tone: feedStatus === "live" ? "value" as const : "muted" as const }],
      }] : []),
      ...(payload?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "muted" as const }] }] : []),
    ],
  }), [feedStatus, loadError, loading, payload?.stale, sessionLabel, summaryQuotes]);

  const openRow = useCallback((row: SessionMoverRow) => {
    pinTicker(rowKey(row), { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null });
  }, [pinTicker]);
  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextHeaderSort(current, columnId as SessionMoverColumn["id"], { resetTo: DEFAULT_SORT }));
  }, []);
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, () => load({ forceRefresh: true }), { stopPropagation: true })
  ), [load]);

  const sides = sessionSides(view);
  return (
    <DataTableView<SessionMoverRow, SessionMoverColumn>
      focused={focused}
      rootBefore={(
        <QueryBar
          width={Math.max(1, width - 2)}
          filters={[{
            id: "side",
            label: view === "gaps" ? "Gap" : "List",
            inline: true,
            value: side,
            options: sides,
            onChange: (value: CloudSessionMoversSide) => setSavedSide(value),
          }]}
        />
      )}
      selection={{ kind: "id", selectedId, getId: rowKey, onChange: setSelectedId }}
      onRootKeyDown={handleKeyDown}
      resetScrollKey={listKey}
      sortable
      columns={columns}
      items={rows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={rowKey}
      onActivate={openRow}
      renderCell={renderSessionMoverCell}
      selectedTextOverridesCellColor
      emptyStateTitle={loading && !payload ? "Loading movers..." : loadError ?? "No movers yet."}
      emptyContent={loadError && !payload ? (
        <Box paddingX={1} paddingY={1}>
          <EmptyState title={loadError} message="Try again in a moment." />
        </Box>
      ) : undefined}
    />
  );
}
