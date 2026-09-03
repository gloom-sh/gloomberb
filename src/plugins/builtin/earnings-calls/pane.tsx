import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  DataTableStackView,
  EmptyState,
  InputSearchBar,
  Spinner,
  usePaneFooter,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneFooterSegment,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { CloudAuthNotice } from "../cloud/auth-actions";
import { useCloudPlanAction, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { colors } from "../../../theme/colors";
import { Box, Text, type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { useBoundTicker as useSymbolBinding } from "../shared/ticker-request";
import { usePlanAccess } from "../shared/plan-access";
import type {
  CloudEarningsCallPayload,
  CloudEarningsTranscriptPayload,
} from "../../../api-client";
import {
  callStatusLabel,
  isPendingTranscript,
  loadEarningsCalls,
  loadTranscript,
  statusOf,
} from "./data";
import { callTitle, formatCallDate, formatDuration, formatPeriod, formatSentiment } from "./format";
import { TranscriptView } from "./transcript-view";

export const EARNINGS_CALLS_PANE_ID = "earnings-calls";

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

function renderCell(call: CloudEarningsCallPayload, column: CallColumn): DataTableCell {
  switch (column.id) {
    case "ticker":
      return { text: call.ticker };
    case "company":
      return { text: call.companyName ?? call.ticker, color: colors.textDim };
    case "date":
      return { text: formatCallDate(call.callAt), color: colors.textDim };
    case "period":
      return { text: formatPeriod(call.fiscalYear, call.fiscalQuarter) };
    case "length":
      return { text: formatDuration(call.durationSeconds), color: colors.textDim };
    case "sentiment": {
      if (!call.hasTranscript) return { text: callStatusLabel(call), color: colors.textDim };
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

type SortDirection = "asc" | "desc";

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

interface TickerLookup {
  ticker: string;
  /** "none": a real company, but no reachable call. "unknown": not a listed symbol. */
  status: "found" | "pending" | "none" | "unknown" | "error";
  calls: CloudEarningsCallPayload[];
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

export function EarningsCallsPane({ focused, width, height }: EarningsCallsViewProps) {
  const { symbol } = useSymbolBinding();
  const access = usePlanAccess();
  const openUpgrade = useCloudUpgradeAction();
  const openPlan = useCloudPlanAction();

  const [calls, setCalls] = useState<CloudEarningsCallPayload[]>([]);
  const [listStatus, setListStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [listError, setListError] = useState<{ message: string; status?: number } | null>(null);
  const [stale, setStale] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [transcript, setTranscript] = useState<CloudEarningsTranscriptPayload | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<{
    message: string;
    status?: number;
  } | null>(null);
  const [qaOnly, setQaOnly] = useState(false);
  const [sort, setSort] = useState<CallSort>(DEFAULT_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const transcriptScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Typing a symbol the shelf does not have asks the server for that company.
  const [lookup, setLookup] = useState<TickerLookup | null>(null);
  // Set while a call opened without a transcript is being produced.
  const [producing, setProducing] = useState(false);
  // The list answered "pending": the server is still searching for calls.
  const [listPending, setListPending] = useState(false);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const ticker = symbol ? symbol.toUpperCase() : null;

  const fetchCalls = useCallback(
    (force: boolean) => {
      if (!access.emailVerified || !access.hasProAccess) return;
      setListStatus((current) => (current === "loaded" ? current : "loading"));
      loadEarningsCalls(ticker, { force })
        .then((result) => {
          setCalls(result.calls);
          setStale(result.stale);
          setListPending(result.pending === true && result.calls.length === 0);
          setListError(
            result.refreshError ? { message: result.refreshError, status: result.errorStatus } : null,
          );
          setListStatus("loaded");
        })
        .catch((error: unknown) => {
          setListError({
            message: error instanceof Error ? error.message : String(error),
            status: statusOf(error),
          });
          setListStatus("error");
        });
    },
    [ticker, access.emailVerified, access.hasProAccess],
  );

  useEffect(() => {
    fetchCalls(false);
  }, [fetchCalls]);

  // A research tab whose company is still being searched checks back until
  // the calls appear.
  useEffect(() => {
    if (!listPending) return;
    const timer = setTimeout(() => fetchCalls(true), LOOKUP_POLL_MS);
    return () => clearTimeout(timer);
  }, [listPending, fetchCalls, calls.length]);

  // On the shelf, a query that looks like a symbol we do not have becomes a
  // request for that company's calls.
  const lookupTicker = useMemo(() => {
    if (ticker || detailOpen) return null;
    const candidate = searchQuery.trim().toUpperCase();
    if (!TICKER_PATTERN.test(candidate)) return null;
    if (calls.some((call) => call.ticker === candidate)) return null;
    return candidate;
  }, [ticker, detailOpen, searchQuery, calls]);

  // Answered for the current query, or still waiting on the server.
  const lookupState: TickerLookup["status"] | "loading" | null = !lookupTicker
    ? null
    : lookup?.ticker === lookupTicker
      ? lookup.status
      : "loading";

  useEffect(() => {
    if (!lookupTicker) return;
    const answered = lookup?.ticker === lookupTicker;
    if (answered && lookup.status !== "pending") return;
    let cancelled = false;
    // Debounce typing; while the server is still searching, check back slowly.
    const delay = answered ? LOOKUP_POLL_MS : 500;
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
          });
        })
        .catch(() => {
          if (!cancelled) setLookup({ ticker: lookupTicker, status: "error", calls: [] });
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lookupTicker, lookup]);

  const allCalls = useMemo(() => {
    if (!lookup || lookup.calls.length === 0) return calls;
    const known = new Set(calls.map((call) => call.id));
    return [...calls, ...lookup.calls.filter((call) => !known.has(call.id))];
  }, [calls, lookup]);

  const rows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matched = query
      ? allCalls.filter((call) =>
          [
            call.ticker,
            call.companyName ?? "",
            formatPeriod(call.fiscalYear, call.fiscalQuarter),
            formatCallDate(call.callAt),
          ]
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
      : allCalls;
    const sorted = [...matched].sort((a, b) => {
      const left = sortValue(a, sort.columnId);
      const right = sortValue(b, sort.columnId);
      if (left === right) return 0;
      const order = left < right ? -1 : 1;
      return sort.direction === "asc" ? order : -order;
    });
    return sorted;
  }, [allCalls, sort, searchQuery]);

  const selected = useMemo(
    () => allCalls.find((call) => call.id === selectedId) ?? null,
    [allCalls, selectedId],
  );
  const selectedCallId = selected?.id ?? null;
  const selectedHasTranscript = selected?.hasTranscript ?? false;

  // Marks a call as transcribed in whichever list holds it, once it is.
  const markTranscribed = useCallback((callId: string) => {
    const update = (list: CloudEarningsCallPayload[]) =>
      list.map((call) =>
        call.id === callId ? { ...call, hasTranscript: true, status: "published" } : call,
      );
    setCalls(update);
    setLookup((current) => (current ? { ...current, calls: update(current.calls) } : current));
  }, []);

  // A published transcript is immutable, so it loads once per call. Opening
  // a call that has none asks the server to produce it, then checks back
  // until it arrives.
  useEffect(() => {
    if (!detailOpen || !selectedCallId) return;
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
  }, [detailOpen, selectedCallId]);

  const scrollTranscriptBy = useCallback((delta: number) => {
    const scrollBox = transcriptScrollRef.current;
    if (!scrollBox?.viewport) return;
    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollBox.scrollTop + delta));
  }, []);

  // A new call or a narrowed transcript should start at the top.
  useEffect(() => {
    const scrollBox = transcriptScrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [selectedId, detailOpen, qaOnly, searchQuery]);

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

  const handleRootKey = useCallback(
    (event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
      if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
        stopSearchFocusNavigation(event);
        focusSearch();
        return true;
      }
      if (isPlainKey(event, "/")) {
        stopSearchFocusNavigation(event);
        focusSearch();
        return true;
      }
      if (isPlainKey(event, "r")) {
        stopSearchFocusNavigation(event);
        fetchCalls(true);
        return true;
      }
      return false;
    },
    [fetchCalls, focusSearch],
  );

  // `q` is the app's quit key, handled ahead of pane handlers. The reader
  // claims it first while it is open, the same way other panes take keys
  // that clash with global ones.
  useShortcut(
    (event) => {
      if (!isPlainKey(event, "q")) return;
      stopSearchFocusNavigation(event);
      setQaOnly((current) => !current);
    },
    {
      enabled: focused && detailOpen && !searchFocused,
      phase: "before",
      scope: "earnings-calls:reader",
    },
  );

  const handleDetailKey = useCallback(
    (event: DataTableKeyEvent) => {
      if (isPlainKey(event, "/")) {
        stopSearchFocusNavigation(event);
        focusSearch();
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
    [focusSearch, scrollTranscriptBy],
  );

  usePaneFooter(
    EARNINGS_CALLS_PANE_ID,
    () => {
      const info: PaneFooterSegment[] = [];
      if (listStatus === "loading") {
        info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
      }
      if (producing) {
        info.push({ id: "producing", parts: [{ text: "producing transcript", tone: "muted" }] });
      } else if (transcriptLoading) {
        info.push({ id: "transcribing", parts: [{ text: "loading transcript", tone: "muted" }] });
      }
      if (listPending) {
        info.push({ id: "searching", parts: [{ text: "searching for calls", tone: "muted" }] });
      }
      if (lookupTicker && lookupState) {
        if (lookupState === "loading" || lookupState === "pending") {
          info.push({ id: "lookup", parts: [{ text: `looking up ${lookupTicker}`, tone: "muted" }] });
        } else if (lookupState === "unknown" || lookupState === "none") {
          info.push({ id: "lookup", parts: [{ text: `${lookupTicker} not found`, tone: "warning" }] });
        } else if (lookupState === "error") {
          info.push({ id: "lookup", parts: [{ text: `${lookupTicker} lookup failed`, tone: "warning" }] });
        }
      }
      if (stale) {
        info.push({ id: "stale", parts: [{ text: "stale cache", tone: "warning" }] });
      }
      if (listError && listStatus === "error") {
        info.push({ id: "error", parts: [{ text: "error", tone: "warning" }] });
      }
      if (proRequired || transcriptProRequired) {
        info.push({ id: "pro", parts: [{ text: "pro required", tone: "warning" }] });
      }
      if (detailOpen && qaOnly) {
        info.push({ id: "qa", parts: [{ text: "Q&A only", tone: "muted" }] });
      }
      if (searchQuery.trim()) {
        info.push({
          id: "filter",
          parts: [{ text: `"${searchQuery.trim()}"`, tone: "muted" }],
        });
      }

      const hints = detailOpen
        ? [
            { id: "qa", key: "q", label: "&A only", onPress: () => setQaOnly((v) => !v) },
            { id: "find", key: "/", label: "find", onPress: focusSearch },
          ]
        : [{ id: "search", key: "/", label: "search", onPress: focusSearch }];

      return { info, hints };
    },
    [
      listStatus,
      transcriptLoading,
      producing,
      listPending,
      lookupState,
      lookupTicker,
      stale,
      listError,
      proRequired,
      transcriptProRequired,
      detailOpen,
      qaOnly,
      searchQuery,
      focusSearch,
      fetchCalls,
    ],
  );

  if (signInRequired) {
    return <CloudAuthNotice message="Sign in to browse earnings call transcripts." />;
  }
  if (verificationRequired) {
    return (
      <CloudAuthNotice
        needsVerification
        message="Verify your email to browse earnings call transcripts."
      />
    );
  }

  if (proRequired) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <EmptyState
          title="Earnings call transcripts are part of Gloom Cloud Pro."
          message="Gloomberb transcribes the calls itself: full transcripts with speaker attribution, analyst Q&A, and extracted guidance, risks and tone."
        />
        <Box flexDirection="row" marginTop={1} gap={1}>
          <Button label="Upgrade to Pro" onPress={openUpgrade} />
          <Button label="Manage account" variant="secondary" onPress={openPlan} />
        </Box>
      </Box>
    );
  }

  if (listStatus === "loading" && calls.length === 0) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Spinner label="Loading calls..." />
      </Box>
    );
  }

  if (listStatus === "error" && calls.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <EmptyState title="Could not load earnings calls." message={listError?.message ?? ""} />
      </Box>
    );
  }

  // A research tab with nothing yet: either the server is still searching
  // for the company, or it has nothing to search for.
  if (ticker && calls.length === 0) {
    return listPending ? (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Spinner label={`Looking for ${ticker}'s earnings calls...`} />
      </Box>
    ) : (
      <EmptyState
        title={`No earnings calls found for ${ticker}.`}
        message="Calls appear here once the company's investor site or filings list a webcast."
      />
    );
  }

  const detailContent = transcriptProRequired ? (
    <Box flexDirection="column" paddingX={1}>
      <EmptyState
        title="Earnings call transcripts are part of Gloom Cloud Pro."
        message="Full transcripts with speaker attribution, analyst Q&A, guidance and risk extraction, transcribed from the call itself."
      />
      <Box flexDirection="row" marginTop={1} gap={1}>
        <Button label="Upgrade to Pro" onPress={openUpgrade} />
        <Button label="Manage account" variant="secondary" onPress={openPlan} />
      </Box>
    </Box>
  ) : selected && !transcript && (producing || (!selected.hasTranscript && !transcriptError)) ? (
    <Box flexDirection="column" flexGrow={1} paddingX={1} gap={1}>
      <Box height={1}>
        <Text fg={colors.textDim}>
          {[formatCallDate(selected.callAt), formatPeriod(selected.fiscalYear, selected.fiscalQuarter)]
            .filter(Boolean)
            .join("  ·  ")}
        </Text>
      </Box>
      <Spinner label="Producing the transcript. This usually takes two to three minutes." />
    </Box>
  ) : (

    // The reader gets its own search bar: a transcript runs to thousands of
    // words, so finding a topic matters as much as filtering the call list.
    <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} overflow="hidden">
      <InputSearchBar
        value={searchQuery}
        focused={focused && detailOpen}
        active={searchFocused}
        width={width}
        focusToken={searchFocusToken}
        inputRef={searchInputRef}
        placeholder="find in transcript"
        debounceMs={80}
        onFocus={focusSearch}
        onBlur={blurSearch}
        onNavigateDown={blurSearch}
        onQueryChange={setSearchQuery}
      />
      <TranscriptView
        transcript={transcript}
        loading={transcriptLoading}
        error={transcriptError?.message ?? null}
        qaOnly={qaOnly}
        query={searchQuery}
        width={width}
        scrollRef={transcriptScrollRef}
      />
    </Box>
  );

  return (
    <DataTableStackView<CloudEarningsCallPayload, CallColumn>
      focused={focused && !searchFocused}
      detailOpen={detailOpen && !!selected}
      onBack={() => {
        setDetailOpen(false);
        setQaOnly(false);
        setSearchQuery("");
        blurSearch();
      }}
      detailContent={detailContent}
      detailTitle={selected ? callTitle(selected) : undefined}
      rootBefore={
        <InputSearchBar
          value={searchQuery}
          focused={focused && !detailOpen}
          active={searchFocused}
          width={width}
          focusToken={searchFocusToken}
          inputRef={searchInputRef}
          placeholder="ticker, company, or period"
          debounceMs={80}
          onFocus={focusSearch}
          onBlur={blurSearch}
          onNavigateDown={blurSearch}
          onQueryChange={setSearchQuery}
        />
      }
      onRootKeyDown={handleRootKey}
      onDetailKeyDown={handleDetailKey}
      selection={{
        kind: "id",
        selectedId,
        getId: (call) => call.id,
        onChange: setSelectedId,
      }}
      onActivate={() => {
        blurSearch();
        setSearchQuery("");
        setDetailOpen(true);
      }}
      rootWidth={width}
      rootHeight={Math.max(1, height - 1)}
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) =>
        setSort((current) =>
          current.columnId === columnId
            ? { columnId, direction: current.direction === "asc" ? "desc" : "asc" }
            : { columnId, direction: "desc" },
        )
      }
      getItemKey={(call) => call.id}
      renderCell={renderCell}
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
            : "No calls yet."
      }
      emptyStateHint={searchQuery.trim() ? "Clear the search to see all calls." : undefined}
    />
  );
}
