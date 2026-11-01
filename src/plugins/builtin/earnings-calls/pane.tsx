import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudEarningsCallPayload } from "../../../api-client";
import { recordResearchActivity } from "../../../api-client/research-activity";
import {
  DataTableStackView,
  EmptyState,
  PaneStatusBody, QueryBar,
  StatGrid,
  usePaneFooter,
  useQueryBarSearch,
  useTableLoadMore,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneFooterSegment,
  type QueryBarView,
  type StatItem,
} from "../../../components";
import { useCompanyDataFooter } from "../../../components/layout/pane/status-footer";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { AudioPlayer, useCanPlayAudio } from "../../../components/ui";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import {
  Box,
  useRendererHost,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../../ui";
import { scrollByLines } from "../../../state/pane-scroll-registry";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { ProWall, SignInWall } from "../cloud/auth-actions";
import { usePlanAccess } from "../../../api-client/plan-access";
import { listingAbroad } from "../../../api-client/paths";
import { useAgeClock } from "../../../react/auto-refresh";
import { useBoundTicker as useSymbolBinding } from "../shared/ticker-request";
import { CALLS_VIEWS, UpcomingCallsView, type CallsView } from "./calendar";
import {
  cachedEarningsCalls,
  callStatusLabel,
  isPendingTranscript,
  loadEarningsCalls,
  loadTranscript,
  statusOf,
  type EarningsTranscriptResult,
} from "./data";
import { isPermanentClientError } from "../../../api-client/errors";
import { savedCopyFooterInfo } from "../../../components/layout/pane/footer";
import { STALE_SEGMENT } from "../../../components/layout/pane/status-footer";
import { callPeriod, callTitle, eventLabelOf, formatCallDate, formatDuration, formatSentiment } from "./format";
import { findCallForQuarter, findInLines, MIN_FIND_LENGTH, turnParagraphs } from "./model";
import { READER_TABS, TranscriptView, type ReaderTab, type TranscriptPlayback } from "./transcript-view";
import { PLAYBACK_RATES, SEEK_STEP_SECONDS, useCallPlayback } from "./use-call-playback";
import { callAway, callCountdown, callStartText, isUpcomingCall, nextCall } from "./upcoming";

export const EARNINGS_CALLS_PANE_ID = "earnings-calls";

function isReaderTab(value: string): value is ReaderTab {
  return READER_TABS.some((tab) => tab.value === value);
}

interface CallColumn {
  id: string;
  label: string;
  width: number;
  align: "left" | "right";
}

function buildColumns(width: number, showTicker: boolean): CallColumn[] {
  const tickerWidth = showTicker ? 8 : 0;
  const dateWidth = 10;
  const periodWidth = 8;
  const lengthWidth = 7;
  // Wide enough for a state such as "in progress" on calls not yet produced.
  const sentimentWidth = 11;
  const companyWidth = Math.max(
    10,
    width - tickerWidth - dateWidth - periodWidth - lengthWidth - sentimentWidth - 8,
  );

  const columns: CallColumn[] = [];
  if (showTicker) columns.push({ id: "ticker", label: "TICKER", width: tickerWidth, align: "left" });
  columns.push(
    { id: "company", label: "COMPANY", width: companyWidth, align: "left" },
    { id: "date", label: "DATE", width: dateWidth, align: "left" },
    { id: "period", label: "PERIOD", width: periodWidth, align: "left" },
    { id: "length", label: "LENGTH", width: lengthWidth, align: "right" },
    { id: "sentiment", label: "TONE", width: sentimentWidth, align: "right" },
  );
  return columns;
}

function renderCell(call: CloudEarningsCallPayload, column: CallColumn, now: number): DataTableCell {
  switch (column.id) {
    case "ticker":
      return { text: call.ticker };
    case "company":
      return { text: call.companyName ?? call.ticker, color: colors.textDim };
    case "date":
      return { text: formatCallDate(call.callAt), color: colors.textDim };
    case "period":
      return { text: callPeriod(call) };
    case "length":
      return { text: formatDuration(call.durationSeconds), color: colors.textDim };
    case "sentiment": {
      // A call still to come says how far away it is, not that it is queued.
      if (isUpcomingCall(call, now)) return { text: callCountdown(call, now), color: colors.text };
      if (!call.hasTranscript) return { text: callStatusLabel(call, now), color: colors.textDim };
      const tone =
        call.sentiment === null
          ? colors.textDim
          : call.sentiment > 0.15
            ? colors.positive
            : call.sentiment < -0.15
              ? colors.negative
              : colors.textDim;
      return { text: formatSentiment(call.sentiment), color: tone };
    }
    default:
      return { text: "" };
  }
}

interface CallSort {
  columnId: string;
  direction: SortDirection;
}

const DEFAULT_SORT: CallSort = { columnId: "date", direction: "desc" };

/** "AVGO", "BRK-B", "brk.b": something worth asking the server about. */
const TICKER_PATTERN = /^[A-Z]{1,5}(?:[.-][A-Z]{1,2})?$/;

/** How often to ask again while a transcript is being produced. */
const PRODUCE_POLL_MS = 15_000;
/** How often to ask again while the server is still finding a company's calls. */
const LOOKUP_POLL_MS = 20_000;
/** Rows per list request. Scrolling to the end of the shelf asks for the next page. */
const CALL_PAGE_SIZE = 50;

interface TickerLookup {
  ticker: string;
  /** "none": a real company, but no reachable call. "unknown": not a listed symbol. */
  status: "found" | "pending" | "none" | "unknown" | "error";
  calls: CloudEarningsCallPayload[];
  fetchedAt?: number;
  stale?: boolean;
  /** Its refresh failed and the copy saved at this time (ms) answered instead. */
  savedAt?: number;
  refreshError?: string;
  refreshRequest?: number;
}

/** A page can overlap the rows already held when the shelf reorders mid-scroll. */
function appendNewCalls(
  current: CloudEarningsCallPayload[],
  incoming: CloudEarningsCallPayload[],
): CloudEarningsCallPayload[] {
  const known = new Set(current.map((call) => call.id));
  const added = incoming.filter((call) => !known.has(call.id));
  return added.length > 0 ? [...current, ...added] : current;
}

function sortValue(call: CloudEarningsCallPayload, columnId: string): string | number {
  switch (columnId) {
    case "ticker":
      return call.ticker;
    case "company":
      return (call.companyName ?? call.ticker).toLowerCase();
    case "period":
      return (call.fiscalYear ?? 0) * 10 + (call.fiscalQuarter ?? 0);
    case "length":
      return call.durationSeconds ?? 0;
    case "sentiment":
      return call.sentiment ?? Number.NEGATIVE_INFINITY;
    default:
      return call.callAt ? Date.parse(call.callAt) : 0;
  }
}

/**
 * Props are the intersection of a pane and a ticker research tab so the same
 * component can serve both surfaces.
 */
interface EarningsCallsViewProps {
  focused: boolean;
  width: number;
  height: number;
}

/** The next call's own line: when it starts here and in New York, and how far away it is. */
function nextCallFigure(call: CloudEarningsCallPayload, now: number): StatItem {
  const { start, newYork } = callStartText(call, now);
  // A countdown that is a day's name repeats the start's; it says something within a day.
  const away = callAway(call, now);
  const detail = [newYork, away].filter(Boolean).join(" · ");
  return {
    id: "next-call",
    label: "Next call",
    value: start,
    ...(detail ? { detail, detailVariants: [away ?? newYork ?? ""] } : {}),
    tone: "accent",
  };
}

/**
 * CALLS: with a ticker, that company's calls, its next one on its own line;
 * alone, the calendar of every company's calls this week, or the shelf of
 * transcripts.
 */
export function EarningsCallsPane({ focused, width, height }: EarningsCallsViewProps) {
  const { symbol, exchange, ticker: boundTicker } = useSymbolBinding();
  // `shot CALLS --view transcripts` (a pane setting) opens on the shelf; a choice made in the pane wins.
  const [requestedView] = usePaneSettingValue<string>("view", "");
  const [chosenView, setView] = usePluginPaneState<CallsView | null>("view", null);
  const view: CallsView = chosenView ?? (CALLS_VIEWS.some((option) => option.value === requestedView) ? requestedView as CallsView : "upcoming");
  const viewChoice = useMemo<QueryBarView<CallsView>>(() => ({ value: view, options: CALLS_VIEWS, onChange: setView }), [setView, view]);

  if (symbol) {
    return (
      <CallsListView
        focused={focused} width={width} height={height}
        symbol={symbol} exchange={exchange} listingName={boundTicker?.metadata.name}
      />
    );
  }
  if (view === "transcripts") {
    return <CallsListView focused={focused} width={width} height={height} symbol={null} view={viewChoice} />;
  }
  return (
    <UpcomingCallsView
      focused={focused} width={width} height={height} view={viewChoice}
      renderCompany={({ ticker, focused: companyFocused, height: companyHeight, onHoldsKeys }) => (
        <CallsListView
          key={ticker}
          focused={companyFocused} width={width} height={companyHeight}
          symbol={ticker} stateKey="company:" footerId={`${EARNINGS_CALLS_PANE_ID}:company`}
          openFromSettings={false} onHoldsKeys={onHoldsKeys}
        />
      )}
    />
  );
}

interface CallsListProps extends EarningsCallsViewProps {
  /** The company whose calls these are; null for the shelf of every company's transcripts. */
  symbol: string | null;
  exchange?: string;
  /** The listing's company name, so a listing abroad reads its own calls. */
  listingName?: string;
  /** Prefix of the pane state this view keeps, so a company opened from the calendar keeps its own. */
  stateKey?: string;
  footerId?: string;
  /** The calendar or the shelf, chosen in the query bar of CALLS alone. */
  view?: QueryBarView<CallsView>;
  /** Whether the pane's `quarter` and `reader` settings open a call here (a layout or a shot). */
  openFromSettings?: boolean;
  /** Told when this view holds the keys a stack around it would take: a call open, or its search focused. */
  onHoldsKeys?: (holds: boolean) => void;
}

function CallsListView({
  focused, width, height, symbol, exchange, listingName: boundName, stateKey = "", footerId = EARNINGS_CALLS_PANE_ID,
  view, openFromSettings = true, onHoldsKeys,
}: CallsListProps) {
  const access = usePlanAccess();
  // Read once per mount: a binding change reads the cache again in its own effect.
  const [initialShelf] = useState(() => {
    const initialTicker = symbol ? symbol.toUpperCase() : null;
    const initialAbroad = initialTicker ? listingAbroad(initialTicker, exchange, boundName) : null;
    return cachedEarningsCalls(initialTicker, {
      limit: CALL_PAGE_SIZE, exchange: initialAbroad?.exchange, name: initialAbroad?.name,
    });
  });

  const [calls, setCalls] = useState<CloudEarningsCallPayload[]>(initialShelf?.calls ?? []);
  const [listStatus, setListStatus] = useState<"idle" | "loading" | "loaded" | "error">(initialShelf ? "loaded" : "idle");
  const [listError, setListError] = useState<{ message: string; status?: number } | null>(null);
  const [stale, setStale] = useState(initialShelf?.stale === true);
  // The company's home line the shelf is read from, for a receipt or a foreign line.
  const [companyFrom, setCompanyFrom] = useState(initialShelf?.companyFrom ?? null);
  // The list's refresh failed and a copy saved at this time (ms) answered instead.
  const [listSavedAt, setListSavedAt] = useState<number | null>(null);
  const [listFetchedAt, setListFetchedAt] = useState(initialShelf?.fetchedAt ?? 0);
  const listRequestVersion = useRef(0);
  const [listCompletedRequest, setListCompletedRequest] = useState(0);
  // The shelf is paged: the server answers a page at a time and reports no
  // total, so a full page means there is probably another one behind it.
  const [hasMore, setHasMore] = useState(initialShelf?.sourceLimitReached === true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(initialShelf?.calls.length ?? 0);
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(`${stateKey}selectedId`, null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>(`${stateKey}detailOpen`, false);
  const [transcript, setTranscript] = useState<EarningsTranscriptResult | null>(null);
  useEffect(() => {
    if (focused && transcript && detailOpen) recordResearchActivity("pro_feature_used", "transcripts");
  }, [focused, transcript, detailOpen]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<{
    message: string;
    status?: number;
  } | null>(null);
  const [readerTab, setReaderTab] = usePluginPaneState<ReaderTab>(`${stateKey}readerTab`, "summary");
  // A layout or `gloom shot CALLS NVDA --quarter latest --reader summary`
  // can land straight on a transcript instead of the shelf. `quarter` takes
  // the same tokens as the headless option; only transcribed calls qualify,
  // since opening a call without one asks the server to produce it.
  const [quarterSetting] = usePaneSettingValue<string>("quarter", "");
  const [readerSetting] = usePaneSettingValue<string>("reader", "");
  const openQuarter = openFromSettings ? quarterSetting : "";
  const openReader = openFromSettings ? readerSetting : "";
  const openedQuarter = useRef<string | null>(null);
  const [sort, setSort] = useState<CallSort>(DEFAULT_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();
  const transcriptScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // An exact symbol query asks for the company's shelf, including older calls.
  const [lookup, setLookup] = useState<TickerLookup | null>(null);
  const [lookupRefresh, setLookupRefresh] = useState<{ ticker: string; request: number } | null>(null);
  // Set while a call opened without a transcript is being produced.
  const [producing, setProducing] = useState(false);
  // The list answered "pending": the server is still searching for calls.
  const [listPending, setListPending] = useState(initialShelf?.pending === true && initialShelf.calls.length === 0);

  const ticker = symbol ? symbol.toUpperCase() : null;
  // A listing abroad asks for its own calls by venue and company, never a US namesake's.
  const abroad = ticker ? listingAbroad(ticker, exchange, boundName) : null;
  const listingVenue = abroad?.exchange;
  const listingName = abroad?.name;

  const fetchCalls = useCallback(
    (force: boolean) => {
      if (!access.emailVerified || !access.hasProAccess) return;
      const request = ++listRequestVersion.current;
      setListStatus((current) => (current === "loaded" ? current : "loading"));
      setLoadingMore(false);
      loadEarningsCalls(ticker, { force, limit: CALL_PAGE_SIZE, exchange: listingVenue, name: listingName })
        .then((result) => {
          if (request !== listRequestVersion.current) return;
          setCalls(result.calls);
          setNextOffset(result.calls.length);
          setHasMore(result.sourceLimitReached === true);
          setStale(result.stale);
          setCompanyFrom(result.companyFrom ?? null);
          setListSavedAt(result.savedAt ?? null);
          setListFetchedAt(result.fetchedAt);
          setListPending(result.pending === true && result.calls.length === 0);
          // A saved copy says when it was saved, in the footer, rather than why the refresh failed.
          setListError(
            result.refreshError && result.savedAt == null ? { message: result.refreshError, status: result.errorStatus } : null,
          );
          setListStatus("loaded");
          setListCompletedRequest(request);
        })
        .catch((error: unknown) => {
          if (request !== listRequestVersion.current) return;
          setListPending(false);
          setHasMore(false);
          setNextOffset(0);
          setListSavedAt(null);
          setListError({
            message: error instanceof Error ? error.message : String(error),
            status: statusOf(error),
          });
          setListStatus("error");
        });
    },
    [ticker, listingVenue, listingName, access.emailVerified, access.hasProAccess],
  );

  // Scrolling to the end of the shelf asks the server for the next page. A
  // page belongs to the list request that was current when it was asked for:
  // a refresh or a binding change abandons whatever was in flight.
  const loadMoreCalls = useCallback(() => {
    if (!access.emailVerified || !access.hasProAccess) return;
    const request = listRequestVersion.current;
    setLoadingMore(true);
    loadEarningsCalls(ticker, { limit: CALL_PAGE_SIZE, offset: nextOffset, exchange: listingVenue, name: listingName })
      .then((result) => {
        if (request !== listRequestVersion.current) return;
        setCalls((current) => appendNewCalls(current, result.calls));
        setNextOffset(nextOffset + result.calls.length);
        setHasMore(result.sourceLimitReached === true);
        setLoadingMore(false);
      })
      .catch((error: unknown) => {
        if (request !== listRequestVersion.current) return;
        // The rows already loaded stay: only the next page failed.
        setHasMore(false);
        setLoadingMore(false);
        setListError({
          message: error instanceof Error ? error.message : String(error),
          status: statusOf(error),
        });
      });
  }, [ticker, listingVenue, listingName, nextOffset, access.emailVerified, access.hasProAccess]);

  const loadMoreFromScroll = useTableLoadMore(
    tableScrollRef,
    hasMore && !loadingMore && !detailOpen && listStatus === "loaded",
    loadMoreCalls,
  );

  // The call restored with the pane survives the first run; only a later
  // binding change closes the reader and clears the selection.
  const firstShelfLoadRef = useRef(true);
  useEffect(() => {
    const keepRestoredCall = firstShelfLoadRef.current;
    firstShelfLoadRef.current = false;
    const held = cachedEarningsCalls(ticker, { limit: CALL_PAGE_SIZE, exchange: listingVenue, name: listingName });
    setCalls(held?.calls ?? []);
    setHasMore(held?.sourceLimitReached === true);
    setLoadingMore(false);
    setNextOffset(held?.calls.length ?? 0);
    setListStatus(held ? "loaded" : "idle");
    setListPending(held?.pending === true && held.calls.length === 0);
    setStale(held?.stale === true);
    setCompanyFrom(held?.companyFrom ?? null);
    setListSavedAt(null);
    setListFetchedAt(held?.fetchedAt ?? 0);
    setListError(null);
    setLookup(null);
    setLookupRefresh(null);
    if (!keepRestoredCall) {
      setSelectedId(null);
      setDetailOpen(false);
    }
    setTranscript(null);
    setTranscriptLoading(false);
    setTranscriptError(null);
    setProducing(false);
    setSearchQuery("");
    if (!keepRestoredCall) setReaderTab("summary");
    fetchCalls(false);
    return () => { listRequestVersion.current++; };
  }, [fetchCalls]);

  // A research tab whose company is still being searched checks back until
  // the calls appear.
  useEffect(() => {
    if (!listPending) return;
    const timer = setTimeout(() => fetchCalls(true), LOOKUP_POLL_MS);
    return () => clearTimeout(timer);
  }, [listPending, fetchCalls, listCompletedRequest]);

  // The global shelf may contain only one of a company's calls. Resolve exact
  // symbol queries independently so older quarters remain reachable.
  const lookupTicker = useMemo(() => {
    if (ticker || detailOpen) return null;
    const candidate = searchQuery.trim().toUpperCase();
    if (!TICKER_PATTERN.test(candidate)) return null;
    return candidate;
  }, [ticker, detailOpen, searchQuery]);

  // Answered for the current query, or still waiting on the server.
  const lookupState: TickerLookup["status"] | "loading" | null = !lookupTicker
    ? null
    : lookup?.ticker === lookupTicker
      ? lookup.status
      : "loading";

  useEffect(() => {
    if (!lookupTicker || !access.emailVerified || !access.hasProAccess) return;
    const answered = lookup?.ticker === lookupTicker;
    const refreshRequest = lookupRefresh?.ticker === lookupTicker ? lookupRefresh.request : 0;
    const manualRefresh = refreshRequest !== (answered ? lookup.refreshRequest ?? 0 : 0);
    if (answered && lookup.status !== "pending" && !manualRefresh) return;
    let cancelled = false;
    // Manual reload refreshes this company as well as the global shelf.
    const delay = manualRefresh ? 0 : answered ? LOOKUP_POLL_MS : 500;
    const timer = setTimeout(() => {
      loadEarningsCalls(lookupTicker, { force: true })
        .then((result) => {
          if (cancelled) return;
          setLookup({
            ticker: lookupTicker,
            status: result.unknownTicker
              ? "unknown"
              : result.calls.length > 0
                ? "found"
                : result.pending
                  ? "pending"
                  : "none",
            calls: result.calls,
            fetchedAt: result.fetchedAt,
            stale: result.stale,
            savedAt: result.savedAt,
            refreshError: result.savedAt == null ? result.refreshError : undefined,
            refreshRequest,
          });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          // A refusal asking again will not change clears the rows; a passing failure keeps them.
          const retainRows = !isPermanentClientError(error);
          setLookup((current) => ({
            ticker: lookupTicker,
            status: "error",
            calls: retainRows && current?.ticker === lookupTicker ? current.calls : [],
            fetchedAt: retainRows && current?.ticker === lookupTicker ? current.fetchedAt : undefined,
            stale: retainRows && current?.ticker === lookupTicker && current.calls.length > 0,
            savedAt: retainRows && current?.ticker === lookupTicker ? current.savedAt : undefined,
            refreshError: error instanceof Error ? error.message : String(error),
            refreshRequest,
          }));
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lookupTicker, lookup, lookupRefresh, access.emailVerified, access.hasProAccess]);

  const allCalls = useMemo(() => {
    if (!lookup || lookup.calls.length === 0) return calls;
    const refreshed = new Map(lookup.calls.map((call) => [call.id, call]));
    const lookupIsNewer = (lookup.fetchedAt ?? 0) >= listFetchedAt;
    const known = new Set(calls.map((call) => call.id));
    return [
      ...calls.map((call) => lookupIsNewer ? refreshed.get(call.id) ?? call : call),
      ...lookup.calls.filter((call) => !known.has(call.id)),
    ];
  }, [calls, lookup, listFetchedAt]);

  // Countdowns move on a coarse clock that rests while the pane is hidden.
  const now = useAgeClock(listFetchedAt || null);
  // A company's next call is its own line above its calls, not one of the rows.
  const next = useMemo(() => (ticker ? nextCall(allCalls, now) : null), [allCalls, now, ticker]);
  const listedCalls = useMemo(() => (next ? allCalls.filter((call) => call.id !== next.id) : allCalls), [allCalls, next]);

  const rows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matched = query
      ? listedCalls.filter((call) =>
          [
            call.ticker,
            call.companyName ?? "",
            callPeriod(call),
            eventLabelOf(call) ?? "",
            formatCallDate(call.callAt),
          ]
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
      : listedCalls;
    const sorted = [...matched].sort((a, b) => {
      const left = sortValue(a, sort.columnId);
      const right = sortValue(b, sort.columnId);
      if (left === right) return 0;
      const order = left < right ? -1 : 1;
      return sort.direction === "asc" ? order : -order;
    });
    return sorted;
  }, [listedCalls, sort, searchQuery]);

  useEffect(() => {
    const quarter = openQuarter.trim();
    if (!quarter || openedQuarter.current === quarter || listStatus !== "loaded") return;
    const target = findCallForQuarter(
      allCalls.filter((call) => call.hasTranscript),
      quarter,
    );
    if (!target) return;
    openedQuarter.current = quarter;
    setSelectedId(target.id);
    setReaderTab(isReaderTab(openReader) ? openReader : "summary");
    setDetailOpen(true);
  }, [openQuarter, openReader, listStatus, allCalls]);

  const selected = useMemo(
    () => allCalls.find((call) => call.id === selectedId) ?? null,
    [allCalls, selectedId],
  );
  const selectedCallId = selected?.id ?? null;
  const selectedHasTranscript = selected?.hasTranscript ?? false;
  // A call still to come has nothing to read, and asking for its transcript
  // would ask the server to produce one before the call has happened.
  const selectedUpcoming = !!selected && isUpcomingCall(selected, now);
  // The reader shows only a call the pane can find. A restored call that is not
  // on the reloaded shelf (a lookup result, or one that aged off) closes once
  // the shelf has loaded, rather than leave the keys pointing at a reader that
  // is not on screen.
  const readerOpen = detailOpen && !!selected;
  useEffect(() => {
    // A `quarter` setting still waiting to open its call wins over closing.
    const pendingQuarter = openQuarter.trim();
    if (pendingQuarter && openedQuarter.current !== pendingQuarter) return;
    if (detailOpen && !selected && listStatus === "loaded") setDetailOpen(false);
  }, [detailOpen, listStatus, openQuarter, selected, setDetailOpen]);
  const selectedTranscript = transcript?.id === selectedCallId ? transcript : null;

  // The desktop and the web play the call beside its transcript, and their
  // find marks every match and steps through them where the terminal's
  // narrows the turns to the ones that match.
  const { nativePaneChrome } = useUiCapabilities();
  const canPlayAudio = useCanPlayAudio();
  const stepFind = nativePaneChrome === true && (selectedTranscript?.turns?.length ?? 0) > 0;
  const transcriptRefused = transcriptError?.status === 402;
  const playback = useCallPlayback({
    callId: selectedCallId,
    transcript: selectedTranscript,
    enabled: canPlayAudio && readerOpen && !!selectedTranscript && !transcriptRefused
      && access.emailVerified && access.hasProAccess,
  });
  const playerShown = !!playback.audio && !!selectedTranscript && readerOpen;
  const transcriptPlayback = useMemo<TranscriptPlayback | undefined>(
    () => playerShown ? { starts: playback.starts, current: playback.current, onPlay: playback.playFrom } : undefined,
    [playerShown, playback.starts, playback.current, playback.playFrom],
  );

  const findLines = useMemo(() => {
    if (!stepFind || !selectedTranscript || readerTab === "summary") return [];
    return (selectedTranscript.turns ?? []).flatMap((turn, index) => (
      readerTab === "qa" && !turn.isQa ? [] : turnParagraphs(turn).map((text, paragraph) => ({ turn: index, paragraph, text }))
    ));
  }, [stepFind, selectedTranscript, readerTab]);
  const findMatches = useMemo(() => findInLines(findLines, searchQuery), [findLines, searchQuery]);
  const [matchIndex, setMatchIndex] = useState(0);
  useEffect(() => setMatchIndex(0), [findMatches]);
  const activeMatch = findMatches.length > 0 ? findMatches[Math.min(matchIndex, findMatches.length - 1)]! : null;
  const stepMatch = useCallback((direction: 1 | -1) => {
    const count = findMatches.length;
    if (count > 0) setMatchIndex((index) => (index + direction + count) % count);
  }, [findMatches.length]);

  // Marks a call as transcribed in whichever list holds it, once it is.
  const markTranscribed = useCallback((callId: string) => {
    const update = (list: CloudEarningsCallPayload[]) =>
      list.map((call) =>
        call.id === callId ? { ...call, hasTranscript: true, status: "published" } : call,
      );
    setCalls(update);
    setLookup((current) => (current ? { ...current, calls: update(current.calls) } : current));
  }, []);

  // Warms a published transcript while the cursor rests on its row, so
  // opening it does not wait. Only calls that already have one: the same
  // request on a call without a transcript asks the server to produce it,
  // which is a deliberate act reserved for Enter.
  const prefetchTranscript = useCallback((call: CloudEarningsCallPayload) => {
    if (!call.hasTranscript || !access.emailVerified || !access.hasProAccess) return;
    void loadTranscript(call.id).catch(() => { /* Intentional ignore: a warm-up that fails is loaded again, and its failure shown, when the call opens. */ });
  }, [access.emailVerified, access.hasProAccess]);

  // A published transcript is immutable, so it loads once per call. Opening
  // a call that has none asks the server to produce it, then checks back
  // until it arrives.
  useEffect(() => {
    if (!detailOpen || !selectedCallId || selectedUpcoming || !access.emailVerified || !access.hasProAccess) return;
    // A binding change clears selection in an effect; do not start a request
    // for that previous selection during the same render's effect pass.
    if (ticker && selected?.ticker.toUpperCase() !== ticker) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setTranscriptError(null);

    const attempt = (force: boolean) => {
      setTranscriptLoading(true);
      loadTranscript(selectedCallId, { force })
        .then((result) => {
          if (cancelled) return;
          if (isPendingTranscript(result)) {
            setTranscript(null);
            setProducing(true);
            timer = setTimeout(() => attempt(true), PRODUCE_POLL_MS);
            return;
          }
          setTranscript(result);
          setProducing(false);
          if (!selectedHasTranscript) {
            markTranscribed(selectedCallId);
            fetchCalls(true);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setTranscript(null);
          setProducing(false);
          setTranscriptError({
            message: error instanceof Error ? error.message : String(error),
            status: statusOf(error),
          });
        })
        .finally(() => {
          if (!cancelled) setTranscriptLoading(false);
        });
    };
    attempt(!selectedHasTranscript);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setProducing(false);
    };
    // The call's identity is what matters; list refreshes must not restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailOpen, selectedCallId, selectedUpcoming, ticker, access.emailVerified, access.hasProAccess]);

  const scrollTranscriptBy = useCallback((delta: number) => {
    if (transcriptScrollRef.current) scrollByLines(transcriptScrollRef.current, delta);
  }, []);

  // A new call or a narrowed transcript should start at the top. A find that
  // steps through its matches moves the view itself.
  const narrowingQuery = stepFind ? "" : searchQuery;
  useEffect(() => {
    const scrollBox = transcriptScrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [selectedId, detailOpen, readerTab, narrowingQuery]);

  // A new search opens matching turns; an existing query must not override
  // the reader's subsequent choice to return to the summary.
  const changeTranscriptQuery = useCallback((query: string) => {
    setSearchQuery(query);
    if (query.trim()) setReaderTab((current) => current === "summary" ? "transcript" : current);
  }, []);

  const rendererHost = useRendererHost();
  const openSource = useCallback(() => {
    if (selected?.webcastUrl) void rendererHost.openExternal(selected.webcastUrl);
  }, [rendererHost, selected]);

  const signInRequired = !access.signedIn || listError?.status === 401;
  const verificationRequired =
    !signInRequired && (!access.emailVerified || listError?.status === 403);
  // The whole feature is a Pro entitlement, so the list itself can be refused.
  const proRequired =
    !signInRequired &&
    !verificationRequired &&
    (!access.hasProAccess || listError?.status === 402);
  const transcriptProRequired = transcriptError?.status === 402;

  const columns = useMemo(() => buildColumns(width, !ticker), [width, ticker]);
  const renderRow = useCallback((call: CloudEarningsCallPayload, column: CallColumn) => renderCell(call, column, now), [now]);

  const handleRootKey = useCallback(
    (event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
      if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
        stopSearchFocusNavigation(event);
        focusSearch();
        return true;
      }
      return handleRefreshKey(event, () => {
        fetchCalls(true);
        if (lookupTicker) setLookupRefresh((current) => ({ ticker: lookupTicker, request: (current?.request ?? 0) + 1 }));
      }, { stopPropagation: true });
    },
    [fetchCalls, focusSearch, lookupTicker],
  );

  // `q` is the app's quit key, handled ahead of pane handlers. The reader
  // claims it first while it is open, the same way other panes take keys
  // that clash with global ones.
  useShortcut(
    (event) => {
      if (!isPlainKey(event, "q")) return;
      stopSearchFocusNavigation(event);
      setReaderTab("qa");
    },
    {
      enabled: focused && readerOpen && !searchFocused,
      phase: "before",
      scope: "earnings-calls:reader",
    },
  );

  // Only a loaded transcript has a find field; a wall, an upsell or a first
  // load has no list or reader for the search keys to reach.
  const readerSearchable = readerOpen && !!selectedTranscript && !transcriptProRequired;
  // A calendar around this view gives it Back, Esc and Backspace while a call
  // is open here or the search has the keys.
  const holdsKeys = readerOpen || searchFocused;
  useEffect(() => {
    onHoldsKeys?.(holdsKeys);
  }, [holdsKeys, onHoldsKeys]);
  useEffect(() => () => onHoldsKeys?.(false), [onHoldsKeys]);
  // Mirrors the bodies below: the list renders unless a wall, an upsell, or an
  // empty shelf's loading, failed or research-tab state takes its place.
  const listShown = !signInRequired && !verificationRequired && !proRequired
    && !(calls.length === 0 && (listStatus === "loading" || listStatus === "error" || !!ticker));

  const handleDetailKey = useCallback(
    (event: DataTableKeyEvent) => {
      if (playerShown && isPlainKey(event, "space")) {
        stopSearchFocusNavigation(event);
        playback.toggle();
        return true;
      }
      if (playerShown && isPlainKey(event, "left", "right")) {
        stopSearchFocusNavigation(event);
        playback.seekBy(event.name === "left" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS);
        return true;
      }
      if (isPlainKey(event, "s")) {
        stopSearchFocusNavigation(event);
        setReaderTab("summary");
        return true;
      }
      if (isPlainKey(event, "t")) {
        stopSearchFocusNavigation(event);
        setReaderTab("transcript");
        return true;
      }
      if (isPlainKey(event, "o")) {
        stopSearchFocusNavigation(event);
        openSource();
        return true;
      }
      if (isPlainKey(event, "j", "down")) {
        stopSearchFocusNavigation(event);
        scrollTranscriptBy(1);
        return true;
      }
      if (isPlainArrowUp(event) || isPlainKey(event, "k")) {
        stopSearchFocusNavigation(event);
        // Like the list: pressing up at the top moves into the search field.
        if ((transcriptScrollRef.current?.scrollTop ?? 0) <= 0 && isPlainArrowUp(event)) {
          focusSearch();
          return true;
        }
        scrollTranscriptBy(-1);
        return true;
      }
      return false;
    },
    [focusSearch, scrollTranscriptBy, openSource, playerShown, playback.toggle, playback.seekBy],
  );

  // A receipt's or foreign line's calls are its company's, read from the home line.
  useCompanyDataFooter(companyFrom, !readerOpen);
  usePaneFooter(
    footerId,
    () => {
      const info: PaneFooterSegment[] = [];
      if (listStatus === "loading") {
        info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
      } else if (loadingMore) {
        info.push({ id: "loading-more", parts: [{ text: "loading more calls", tone: "muted" }] });
      }
      if (producing) {
        info.push({ id: "producing", parts: [{ text: "producing transcript", tone: "muted" }] });
      } else if (transcriptLoading) {
        info.push({ id: "transcribing", parts: [{ text: "loading transcript", tone: "muted" }] });
      }
      if (readerOpen && playback.status === "loading" && !playback.audio) {
        info.push({ id: "audio-loading", parts: [{ text: "loading audio", tone: "muted" }] });
      }
      if (readerOpen && playback.error) {
        info.push({ id: "audio-error", parts: [{ text: "audio unavailable", tone: "warning" }], title: playback.error });
      }
      if (readerOpen && stepFind && searchQuery.trim().length >= MIN_FIND_LENGTH && readerTab !== "summary") {
        info.push(activeMatch
          ? { id: "find", parts: [{ text: `match ${Math.min(matchIndex, findMatches.length - 1) + 1} of ${findMatches.length}`, tone: "muted" }] }
          : { id: "find", parts: [{ text: "no matches", tone: "warning" }] });
      }
      if (listPending) {
        info.push({ id: "searching", parts: [{ text: "searching for calls", tone: "muted" }] });
      }
      if (lookupTicker && lookupState) {
        if (lookupState === "loading" || lookupState === "pending") {
          info.push({ id: "lookup", parts: [{ text: `looking up ${lookupTicker}`, tone: "muted" }] });
        } else if (lookupState === "unknown") {
          info.push({ id: "lookup", parts: [{ text: `${lookupTicker} not found`, tone: "warning" }] });
        } else if (lookupState === "none") {
          info.push({ id: "lookup", parts: [{ text: `no ${lookupTicker} calls yet`, tone: "muted" }] });
        } else if (lookupState === "error") {
          info.push({ id: "lookup", parts: [{ text: `${lookupTicker}: ${lookup?.refreshError ?? "lookup failed"}`, tone: "warning" }] });
        }
      }
      const visibleLookup = lookup && (lookup.ticker === lookupTicker || (detailOpen && selected?.ticker === lookup.ticker)) ? lookup : null;
      if (visibleLookup?.refreshError && lookupState !== "error") {
        info.push({ id: "lookup-error", parts: [{ text: `${visibleLookup.ticker}: ${visibleLookup.refreshError}`, tone: "warning" }] });
      }
      // What a failed refresh left on screen: a saved copy says when it was saved; a list
      // held from an earlier session, still refreshing, is only stale.
      const savedCopy = savedCopyFooterInfo([listSavedAt, visibleLookup?.savedAt, readerOpen ? selectedTranscript?.savedAt : null]);
      info.push(...savedCopy);
      if (stale && listSavedAt == null) info.push(STALE_SEGMENT);
      if (listError) {
        info.push({ id: "error", parts: [{ text: listError.message, tone: "warning" }] });
      }
      if (proRequired || transcriptProRequired) {
        info.push({ id: "pro", parts: [{ text: "pro required", tone: "warning" }] });
      }

      const playing = playback.state === "playing" || playback.state === "loading";
      const hints = !listShown
        ? []
        : readerOpen
          ? [
              ...(playerShown
                ? [{ id: "play", key: "space", label: playing ? "pause" : "play", onPress: playback.toggle }]
                : []),
              ...(selected?.webcastUrl
                ? [{ id: "open", key: "o", label: "pen source", onPress: openSource }]
                : []),
              ...(readerSearchable ? [{ id: "find", key: "/", label: "find", onPress: focusSearch }] : []),
            ]
          : [{ id: "search", key: "/", label: "search", onPress: focusSearch }];
      // The desktop's find key, where the browser's own would search the page.
      const keys = listShown && readerSearchable && nativePaneChrome === true
        ? [{ id: "find-key", key: "CmdOrCtrl+F", label: "find", onPress: focusSearch }]
        : [];

      return { info, hints, keys };
    },
    [
      listStatus,
      loadingMore,
      transcriptLoading,
      producing,
      listPending,
      lookupState,
      lookupTicker,
      lookup,
      stale,
      listSavedAt,
      selectedTranscript,
      listError,
      proRequired,
      transcriptProRequired,
      detailOpen,
      listShown,
      readerOpen,
      readerSearchable,
      selected,
      focusSearch,
      openSource,
      fetchCalls,
      nativePaneChrome,
      playerShown,
      playback.status,
      playback.audio,
      playback.error,
      playback.state,
      playback.toggle,
      stepFind,
      searchQuery,
      readerTab,
      activeMatch,
      matchIndex,
      findMatches.length,
    ],
  );

  if (signInRequired || verificationRequired) {
    return (
      <SignInWall
        placement={detailOpen ? "calls-transcript-signin" : "calls-signin"}
        width={width} height={height} symbol={detailOpen ? selected?.ticker ?? symbol : symbol} exchange={exchange}
        action="browse earnings call transcripts"
        needsVerification={verificationRequired}
      />
    );
  }

  if (proRequired) {
    return (
      <ProWall
        placement="calls-wall"
        width={width} height={height} symbol={symbol} exchange={exchange}
        title="Earnings call transcripts are part of Gloom Cloud Pro."
        message="Full transcripts of each earnings call with speaker attribution, analyst Q&A, and extracted guidance, risks and tone."
      />
    );
  }

  if (listStatus === "loading" && calls.length === 0) {
    return (
      <PaneStatusBody loading align="center" loadingLabel="Loading calls..." />
    );
  }

  if (listStatus === "error" && calls.length === 0) {
    return (
      <PaneStatusBody error={listError?.message ?? "Could not load earnings calls."} errorTitle="Could not load earnings calls." />
    );
  }

  // A research tab with nothing yet: either the server is still searching
  // for the company, or it has nothing to search for.
  if (ticker && calls.length === 0) {
    return listPending ? (
      <PaneStatusBody loading align="center" loadingLabel={`Looking for ${ticker}'s earnings calls...`} />
    ) : (
      <EmptyState
        title={`No earnings calls found for ${ticker}.`}
        message="Calls appear here once the company's investor site or filings list a webcast."
      />
    );
  }

  const detailContent = transcriptProRequired ? (
    <ProWall
      placement="calls-transcript-wall"
      width={width} height={height - 1} symbol={selected?.ticker ?? symbol} exchange={exchange}
      title="Earnings call transcripts are part of Gloom Cloud Pro."
      message="Full transcripts with speaker attribution, analyst Q&A, guidance and risk extraction, transcribed from the call itself."
    />
  ) : selected && selectedUpcoming ? (
    <UpcomingCallState call={selected} now={now} />
  ) : selected && !selectedTranscript && (producing || (!selected.hasTranscript && !transcriptError)) ? (
    <PaneStatusBody loading loadingLabel="Producing the transcript. This usually takes two to three minutes." />
  ) : (

    // The reader gets its own find field: a transcript runs to thousands of
    // words, so finding a topic matters as much as filtering the call list.
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} overflow="hidden">
      <TranscriptView
        search={{
          value: searchQuery,
          onChange: changeTranscriptQuery,
          placeholder: "find in transcript",
          focused: focused && readerOpen,
          ...searchProps,
          debounceMs: 80,
          ...(stepFind ? { onStep: stepMatch } : {}),
        }}
        transcript={selectedTranscript}
        loading={transcriptLoading}
        error={transcriptError?.message ?? null}
        tab={readerTab}
        onTabChange={setReaderTab}
        tabsFocused={focused && readerOpen && !searchFocused}
        query={stepFind ? undefined : searchQuery}
        width={width}
        scrollRef={transcriptScrollRef}
        {...(stepFind ? { find: { query: searchQuery, active: activeMatch } } : {})}
        {...(transcriptPlayback ? { playback: transcriptPlayback } : {})}
      />
      {/* The recording stays with the call across its sections. */}
      {playerShown && playback.audio && selected ? (
        <AudioPlayer
          src={playback.audio.url}
          sourceKey={selected.id}
          label={`${callTitle(selected)}${eventLabelOf(selected) ? "" : " call"} recording`}
          durationSeconds={playback.audio.durationSeconds}
          rates={PLAYBACK_RATES}
          rate={playback.rate}
          onRateChange={playback.setRate}
          handleRef={playback.handleRef}
          onTimeUpdate={playback.onTimeUpdate}
          onStateChange={playback.onStateChange}
          onError={playback.onError}
        />
      ) : null}
    </Box>
  );

  return (
    <DataTableStackView<CloudEarningsCallPayload, CallColumn>
      focused={focused && !searchFocused}
      detailOpen={readerOpen}
      onBack={() => {
        setDetailOpen(false);
        setReaderTab("summary");
        setSearchQuery("");
        blurSearch();
      }}
      detailContent={detailContent}
      detailTitle={selected ? callTitle(selected) : undefined}
      rootBefore={
        <Box flexDirection="column" flexShrink={0}>
          <QueryBar
            width={width}
            search={{
              value: searchQuery,
              onChange: setSearchQuery,
              placeholder: "ticker, company, or period",
              focused: focused && !readerOpen,
              ...searchProps,
              debounceMs: 80,
            }}
            view={view}
          />
          {next ? <StatGrid items={[nextCallFigure(next, now)]} width={width} /> : null}
        </Box>
      }
      onRootKeyDown={handleRootKey}
      onDetailKeyDown={handleDetailKey}
      scrollRef={tableScrollRef}
      onBodyScrollActivity={loadMoreFromScroll}
      selection={{
        kind: "id",
        selectedId,
        getId: (call) => call.id,
        onChange: setSelectedId,
      }}
      onActivate={() => {
        blurSearch();
        setSearchQuery("");
        setTranscript((current) => current?.id === selectedCallId ? current : null);
        setTranscriptError(null);
        setDetailOpen(true);
      }}
      prefetchDetail={prefetchTranscript}
      rootWidth={width}
      // The search bar sits inside the frame, so the frame takes the full height.
      rootHeight={Math.max(2, height)}
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) =>
        setSort((current) => nextHeaderSort(current, columnId, { firstDirection: "desc" }))
      }
      getItemKey={(call) => call.id}
      renderCell={renderRow}
      emptyStateTitle={
        lookupTicker && lookupState
          ? lookupState === "unknown"
            ? `${lookupTicker} is not a listed company.`
            : lookupState === "none"
              ? `No reachable earnings call for ${lookupTicker} yet.`
              : lookupState === "error"
                ? `Could not look up ${lookupTicker}.`
                : `Looking up ${lookupTicker}...`
          : searchQuery.trim()
            ? "No matching calls."
            : next ? "No calls before this one yet." : "No calls yet."
      }
      emptyStateHint={searchQuery.trim() ? "Clear the search to see all calls." : undefined}
    />
  );
}

/** An open call still to come: when it starts, here and in New York, and how far away. */
function UpcomingCallState({ call, now }: { call: CloudEarningsCallPayload; now: number }) {
  const { start, newYork } = callStartText(call, now);
  const away = callAway(call, now);
  return (
    <EmptyState
      title={`Starts ${start}${newYork ? ` (${newYork})` : ""}${away ? `, ${away}` : ""}.`}
      message="The transcript follows once the call is over."
    />
  );
}
