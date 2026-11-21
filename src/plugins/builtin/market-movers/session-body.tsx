import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CloudSessionMoversCategory,
  CloudSessionMoversSide,
} from "../../../api-client/market-movers";
import { CLOUD_QUOTE_DELAY_MINUTES, useCloudDisplayScope, usePlanAccess } from "../../../api-client/plan-access";
import { isPermanentClientError, sourceDidNotAnswer } from "../../../api-client/errors";
import { useListDelayFooter } from "../shared/cloud-upgrade";
import { DataTableView, EmptyState, QueryBar, usePaneFooter, type DataTableKeyEvent } from "../../../components";
import { STALE_SEGMENT } from "../../../components/layout/pane/status-footer";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import {
  buildScreenerQuoteTargets,
  resolveScreenerQuoteFeedStatus,
} from "../../../market-data/quotes/screener-live-quotes";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useAsyncResource } from "../../../react/async-resource";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { Box, useUiCapabilities } from "../../../ui";
import { publicTickerKey } from "../../../utils/exchanges";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { ProWall, SignInWall } from "../cloud/auth-actions";
import { loadSessionMovers, SessionMoversAccessError } from "./client";
import { ANY_FLOAT, minFloatEmptyTitle, minFloatFilter, minFloatShares, partialFloatFooter } from "./min-float";
import { moverFreshnessFooter, SESSION_PART, shownListSession, summaryFooterSegments } from "./footer";
import type { MarketSummaryQuote } from "./screener";
import { isProOnlyTab } from "./model";
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

/**
 * Pre-market, after-hours and gap lists. Pre-market and after hours open on
 * every plan: without Pro the server answers with the list as it was built a
 * delay before (`access: "delayed"`), as old as the account's quotes, and the
 * footer gives that time. Gaps are Pro only, like the ranked lists they sit
 * beside.
 */
export function SessionMoversBody(props: {
  view: CloudSessionMoversCategory;
  session: UsSession;
  focused: boolean;
  width: number;
  height: number;
  summaryQuotes: MarketSummaryQuote[];
  liveStreaming: boolean;
}) {
  const access = usePlanAccess();
  const proOnly = isProOnlyTab(props.view);
  const [denied, setDenied] = useState(false);
  const deny = useCallback(() => setDenied(true), []);
  // A refusal is about the plan the account had then; a new plan asks again.
  useEffect(() => setDenied(false), [access.signedIn, access.emailVerified, access.hasProAccess]);
  const entitled = !proOnly || (access.emailVerified && access.hasProAccess && !denied);
  // Behind a wall the footer still carries the index summary; the list registers its own.
  usePaneFooter("market-movers-wall", () => (
    entitled ? null : { info: summaryFooterSegments(props.summaryQuotes) }
  ), [entitled, props.summaryQuotes]);

  if (proOnly && !access.signedIn) return <SignInWall placement="most-signin" width={props.width} height={props.height} action="see gap movers" />;
  if (proOnly && !access.emailVerified) return <SignInWall placement="most-signin" width={props.width} height={props.height} action="see gap movers" needsVerification />;
  if (!entitled) {
    return (
      <ProWall
        placement="most-wall"
        width={props.width} height={props.height}
        title="Gap movers are part of Gloom Cloud Pro."
        message="Every listed US stock that opened away from its prior close, with relative volume, VWAP, float and catalysts."
      />
    );
  }
  // A new plan reads the list again: live with Pro, a delay before without.
  return <SessionMoversTable key={access.hasProAccess ? "pro" : "free"} {...props} onDenied={proOnly ? deny : undefined} />;
}

function SessionMoversTable({ view, session, focused, width, summaryQuotes, liveStreaming, onDenied }: {
  view: CloudSessionMoversCategory;
  session: UsSession;
  focused: boolean;
  width: number;
  summaryQuotes: MarketSummaryQuote[];
  liveStreaming: boolean;
  /** Gaps: the server refused the list for the account's plan. */
  onDenied?: () => void;
}) {
  const { pinTicker } = usePluginTickerActions();
  const scope = useCloudDisplayScope();
  const [savedSide, setSavedSide] = usePluginPaneState<CloudSessionMoversSide>("sessionSide", "up");
  const side = resolveSide(view, savedSide);
  const [minFloatValue, setMinFloatValue] = usePluginPaneState<string>("minFloat", ANY_FLOAT);
  const minFloat = minFloatShares(minFloatValue);
  const listKey = JSON.stringify([view, side, minFloat, scope]);
  const loader = useCallback(async (forceRefresh: boolean) => {
    try {
      return await loadSessionMovers(view, side, { forceRefresh, minFloat });
    } catch (error) {
      if (error instanceof SessionMoversAccessError || isPermanentClientError(error)) throw error;
      throw sourceDidNotAnswer("Session movers temporarily unavailable");
    }
  }, [minFloat, scope, side, view]);
  const { data: payload, loading, error: loadError, updatedAt, savedAt, load, reload } = useAsyncResource(loader, {
    savedCopy: scope ? { key: ["session-movers", listKey] } : null,
    clearOnError: (error) => {
      if (!(error instanceof SessionMoversAccessError)) return isPermanentClientError(error);
      onDenied?.();
      return true;
    },
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<SessionMoverSortPreference>(DEFAULT_SORT);
  const listRows = payload?.items ?? NO_ROWS;
  // A free account's list is the one built a delay before: no live prices on its rows.
  const delayed = payload?.access === "delayed";
  const sessionTrading = !!payload && sessionListIsLive(view, payload.session, session);
  const live = sessionTrading && !delayed;
  // While the list's session trades it is rebuilt every minute, and a failed or
  // stale answer is asked for again as often; a finished list does not change,
  // so it follows the refresh interval the user set.
  const refreshEachMinute = sessionListIsLive(view, session.date, session) || !payload || payload.stale === true;

  useEffect(() => {
    setSelectedId(null);
  }, [listKey]);
  useAutoRefresh(updatedAt, load, { intervalMs: refreshEachMinute ? LIST_REFRESH_MS : null });

  // A finished list keeps the prices it closed at, so it holds no quote subscriptions.
  const quoteTargets = useMemo(
    () => (live ? buildScreenerQuoteTargets(listRows, selectedId) : []),
    [listRows, live, selectedId],
  );
  const { entries, freshnessNow, subscriptionStartedAt } = useLiveQuoteEntries(quoteTargets, {
    freshnessScopeKey: `market-movers:${listKey}`,
    liveStreaming,
  });
  const columns = useMemo(() => buildSessionMoverColumns(view, width, { float: minFloat != null }), [minFloat, view, width]);
  // The sort survives a change of list, but not onto a column this list or width does not show.
  const sort = columns.some((column) => column.id === sortPreference.columnId) ? sortPreference : DEFAULT_SORT;
  const rows = useMemo(
    () => sortSessionRows(live ? overlaySessionMovers(listRows, entries) : listRows, sort),
    [entries, listRows, live, sort],
  );
  const feedStatus = useMemo(
    () => resolveScreenerQuoteFeedStatus(quoteTargets, entries, { now: freshnessNow, subscriptionStartedAt }),
    [entries, freshnessNow, quoteTargets, subscriptionStartedAt],
  );

  useEffect(() => {
    if (selectedId && rows.some((row) => rowKey(row) === selectedId)) return;
    setSelectedId(rows[0] ? rowKey(rows[0]) : null);
  }, [rows, selectedId]);

  // A list whose session is over is dated by it (`Fri 20 Nov pre-market`), which also names an earlier session's day.
  const shownSession = payload?.phase === "closed"
    ? shownListSession(payload.asOf, freshnessNow, { session: payload.session, ...(SESSION_PART[view] ? { part: SESSION_PART[view] } : {}) }) : null;
  const sessionLabel = payload && !shownSession ? earlierSessionLabel(payload.session, session) : null;
  const quoteDelay = useListDelayFooter(delayed ? payload.delayMinutes ?? CLOUD_QUOTE_DELAY_MINUTES : null, "movers-delay");
  usePaneFooter("market-movers", () => ({
    info: [
      ...(loadError ? [{ id: "load-error", parts: [{ text: loadError, tone: "warning" as const }] }] : []),
      ...(quoteDelay ? [quoteDelay] : []),
      ...(payload ? moverFreshnessFooter(payload.asOf, savedAt == null ? updatedAt : null, shownSession) : []),
      ...(sessionLabel ? [{ id: "session", parts: [{ text: sessionLabel, tone: "muted" as const }] }] : []),
      ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(feedStatus ? [{
        id: "feed",
        parts: [{ text: feedStatus === "live" ? "quotes live" : feedStatus, tone: feedStatus === "live" ? "value" as const : "muted" as const }],
      }] : []),
      ...(payload?.stale && savedAt == null ? [STALE_SEGMENT] : []),
      // A float the source does not date says so once, while the FLOAT column shows.
      ...partialFloatFooter(columns.some((column) => column.id === "floatShares"), rows),
      ...summaryFooterSegments(summaryQuotes),
    ],
  }), [columns, feedStatus, loadError, loading, payload, quoteDelay, rows, savedAt, sessionLabel, summaryQuotes, updatedAt]);

  const openRow = useCallback((row: SessionMoverRow) => {
    pinTicker(rowKey(row), { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null });
  }, [pinTicker]);
  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference(nextHeaderSort(sort, columnId as SessionMoverColumn["id"], { resetTo: DEFAULT_SORT }));
  }, [sort]);
  const logos = useUiCapabilities().nativePaneChrome === true;
  const renderCell = useCallback((row: SessionMoverRow, column: SessionMoverColumn) => renderSessionMoverCell(row, column, logos), [logos]);
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, reload, { stopPropagation: true })
  ), [reload]);

  const sides = sessionSides(view);
  // Until this list's first answer the table is loading, including the frame
  // between a change of list and its request going out.
  const emptyTitle = payload ? (minFloat != null ? minFloatEmptyTitle(minFloatValue) : "No movers yet.") : loadError ?? "Loading movers...";
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
          }, minFloatFilter(minFloatValue, setMinFloatValue)]}
        />
      )}
      selection={{ kind: "id", selectedId, getId: rowKey, onChange: setSelectedId }}
      onRootKeyDown={handleKeyDown}
      resetScrollKey={listKey}
      sortable
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={rowKey}
      onActivate={openRow}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={emptyTitle}
      emptyContent={loadError && !payload ? (
        <Box paddingX={1} paddingY={1}>
          <EmptyState title={loadError} message="Try again in a moment." />
        </Box>
      ) : undefined}
    />
  );
}
