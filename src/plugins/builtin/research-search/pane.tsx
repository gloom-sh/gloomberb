import { recordResearchActivity } from "../../../api-client/research-activity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ConfirmDialog,
  DataTableStackView,
  EmptyState,
  InputSearchBar,
  Spinner,
  Tabs,
  useExternalLinkFooter,
  useTableLoadMore,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../components";
import { TickerBadgeList } from "../../../components/ticker/badge/list";
import { colors } from "../../../theme/colors";
import { Box, type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePluginPaneState } from "../../runtime";
import type { PaneProps } from "../../../types/plugin";
import type {
  CloudSavedSearch,
  CloudSearchDocument,
  CloudSearchHit,
} from "../../../api-client";
import { CloudAuthNotice } from "../cloud/auth-actions";
import { useCloudPlanAction } from "../shared/cloud-upgrade";
import { usePlanAccess } from "../shared/plan-access";
import {
  createSavedSearch,
  deleteSavedSearch,
  errorMessage,
  isAbortError,
  loadSavedSearches,
  loadSearchDocument,
  runDocumentSearch,
  statusOf,
  updateSavedSearch,
} from "./data";
import { useDocumentFocusRequest } from "./focus-handoff";
import { SearchFilterBar } from "./filter-bar";
import { SearchDocumentView } from "./document-view";
import { SavedSearchesView } from "./saved-view";
import {
  appendUniqueHits,
  buildResultColumns,
  buildSearchParams,
  DEFAULT_FILTERS,
  filtersFromSaved,
  filtersToSaved,
  formatHitDate,
  hitMatchCountLabel,
  hitTypeLabel,
  parseTickerFilter,
  RESEARCH_SEARCH_PANE_ID,
  savedSearchName,
  type SearchColumn,
  type SearchFilters,
} from "./model";
import { parseMarkedSnippet, snippetPlainText, truncateSegments } from "./snippet";
import { SnippetText } from "./snippet-text";

const QUERY_DEBOUNCE_MS = 300;
const TICKER_FIELD_WIDTH = 22;

type PaneMode = "results" | "saved";
type LoadStatus = "idle" | "loading" | "loaded" | "error";
type ActiveField = "query" | "tickers" | null;

interface RequestFailure {
  message: string;
  status?: number;
}

export function ResearchSearchPane({ focused, paneId, width, height }: PaneProps) {
  const access = usePlanAccess();
  const openPlan = useCloudPlanAction();
  const dialog = useDialog();

  const [seedQuery] = usePaneSettingValue("query", "");
  const [mode, setMode] = usePluginPaneState<PaneMode>("mode", "results");
  const [query, setQuery] = usePluginPaneState<string>("query", String(seedQuery ?? "").trim());
  const [filters, setFilters] = usePluginPaneState<SearchFilters>("filters", DEFAULT_FILTERS);

  const [hits, setHits] = useState<CloudSearchHit[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedHitId, setSelectedHitId] = useState<string | null>(null);
  const [openHit, setOpenHit] = useState<CloudSearchHit | null>(null);
  const [document, setDocument] = useState<CloudSearchDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentFailure, setDocumentFailure] = useState<RequestFailure | null>(null);

  const [saved, setSaved] = useState<CloudSavedSearch[]>([]);
  const [savedStatus, setSavedStatus] = useState<LoadStatus>("idle");
  const [savedFailure, setSavedFailure] = useState<RequestFailure | null>(null);
  const [savedSelectedId, setSavedSelectedId] = useState<string | null>(null);
  const [savedBusy, setSavedBusy] = useState(false);

  const [activeField, setActiveField] = useState<ActiveField>(null);
  const [fieldFocusToken, setFieldFocusToken] = useState(0);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const queryInputRef = useRef<InputRenderable | null>(null);
  const tickerInputRef = useRef<InputRenderable | null>(null);
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);

  const trimmedQuery = query.trim();

  const focusField = useCallback((field: Exclude<ActiveField, null>) => {
    setActiveField(field);
    setFieldFocusToken((current) => current + 1);
  }, []);
  const blurField = useCallback(() => setActiveField(null), []);

  const runSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    moreAbortRef.current?.abort();
    if (!trimmedQuery || !access.emailVerified) {
      searchAbortRef.current = null;
      setHits([]);
      setStatus("idle");
      setFailure(null);
      setHasMore(false);
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;
    setStatus("loading");
    setFailure(null);
    void runDocumentSearch(buildSearchParams(trimmedQuery, filters), controller.signal)
      .then((response) => {
        // A newer query already took over; this answer is for text nobody is reading.
        if (searchAbortRef.current !== controller) return;
        setHits(response.hits ?? []);
        setHasMore(response.hasMore === true);
        setNextOffset(response.nextOffset ?? (response.hits?.length ?? 0));
        setStatus("loaded");
      })
      .catch((error: unknown) => {
        if (searchAbortRef.current !== controller || isAbortError(error)) return;
        setHits([]);
        setHasMore(false);
        setFailure({ message: errorMessage(error), status: statusOf(error) });
        setStatus("error");
      });
  }, [access.emailVerified, filters, trimmedQuery]);

  useEffect(() => {
    runSearch();
    return () => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      moreAbortRef.current?.abort();
      moreAbortRef.current = null;
    };
  }, [runSearch]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || status !== "loaded" || !trimmedQuery) return;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    setLoadingMore(true);
    void runDocumentSearch(
      buildSearchParams(trimmedQuery, filters, { offset: nextOffset }),
      controller.signal,
    )
      .then((response) => {
        if (moreAbortRef.current !== controller) return;
        setHits((current) => appendUniqueHits(current, response.hits ?? []));
        setHasMore(response.hasMore === true);
        setNextOffset(response.nextOffset ?? nextOffset + (response.hits?.length ?? 0));
      })
      .catch((error: unknown) => {
        if (moreAbortRef.current !== controller || isAbortError(error)) return;
        setFailure({ message: errorMessage(error), status: statusOf(error) });
      })
      .finally(() => {
        if (moreAbortRef.current === controller) setLoadingMore(false);
      });
  }, [filters, hasMore, loadingMore, nextOffset, status, trimmedQuery]);

  const loadMoreFromScroll = useTableLoadMore(
    tableScrollRef,
    hasMore && !loadingMore && status === "loaded",
    loadMore,
  );

  useEffect(() => {
    if (!openHit) {
      setDocument(null);
      setDocumentFailure(null);
      return;
    }
    const controller = new AbortController();
    setDocumentLoading(true);
    setDocumentFailure(null);
    setDocument(null);
    void loadSearchDocument(openHit.docType, openHit.sourceId, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setDocument(loaded);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setDocumentFailure({ message: errorMessage(error), status: statusOf(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setDocumentLoading(false);
      });
    return () => controller.abort();
  }, [openHit]);

  const refreshSaved = useCallback(() => {
    if (!access.emailVerified) return;
    setSavedStatus((current) => (current === "loaded" ? current : "loading"));
    setSavedFailure(null);
    void loadSavedSearches()
      .then((searches) => {
        setSaved(searches);
        // Alerts and delete act on the cursor row, so the list must start on one.
        setSavedSelectedId((current) => (
          current && searches.some((search) => search.id === current)
            ? current
            : searches[0]?.id ?? null
        ));
        setSavedStatus("loaded");
      })
      .catch((error: unknown) => {
        setSavedFailure({ message: errorMessage(error), status: statusOf(error) });
        setSavedStatus("error");
      });
  }, [access.emailVerified]);

  useEffect(() => {
    if (mode !== "saved") return;
    refreshSaved();
  }, [mode, refreshSaved]);

  const saveCurrentSearch = useCallback(() => {
    if (!trimmedQuery || savedBusy) return;
    setSavedBusy(true);
    void createSavedSearch({
      name: savedSearchName(trimmedQuery, filters),
      query: trimmedQuery,
      filters: filtersToSaved(filters),
    })
      .then((search) => {
        setSaved((current) => [search, ...current.filter((entry) => entry.id !== search.id)]);
        setSavedSelectedId(search.id);
        setSavedStatus("loaded");
        setSavedFailure(null);
        setMode("saved");
      })
      .catch((error: unknown) => {
        setSavedFailure({ message: errorMessage(error), status: statusOf(error) });
      })
      .finally(() => setSavedBusy(false));
  }, [filters, savedBusy, setMode, trimmedQuery]);

  const toggleAlert = useCallback((search: CloudSavedSearch) => {
    const next = !search.alertEnabled;
    // Optimistic: the switch has to answer the click, and a failure puts it back.
    setSaved((current) => current.map((entry) => (
      entry.id === search.id ? { ...entry, alertEnabled: next } : entry
    )));
    void updateSavedSearch(search.id, { alertEnabled: next })
      .then((updated) => {
        setSaved((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
        setSavedFailure(null);
      })
      .catch((error: unknown) => {
        setSaved((current) => current.map((entry) => (
          entry.id === search.id ? { ...entry, alertEnabled: search.alertEnabled } : entry
        )));
        setSavedFailure({ message: errorMessage(error), status: statusOf(error) });
      });
  }, []);

  const removeSaved = useCallback(async (search: CloudSavedSearch) => {
    const confirmed = await dialog.prompt<boolean>({
      closeOnClickOutside: true,
      content: (context: PromptContext<boolean>) => (
        <ConfirmDialog
          {...context}
          title="Delete saved search?"
          body={[
            `Delete "${search.name || search.query}"?`,
            search.alertEnabled ? "Its keyword alert stops with it." : "",
          ].filter((line) => line.length > 0)}
          confirmLabel="Delete"
          width={44}
        />
      ),
    }).catch(() => false);
    if (confirmed !== true) return;

    const previous = saved;
    setSaved((current) => current.filter((entry) => entry.id !== search.id));
    try {
      await deleteSavedSearch(search.id);
      setSavedFailure(null);
    } catch (error) {
      setSaved(previous);
      setSavedFailure({ message: errorMessage(error), status: statusOf(error) });
    }
  }, [dialog, saved]);

  const runSavedSearch = useCallback((search: CloudSavedSearch) => {
    setQuery(search.query);
    setFilters(filtersFromSaved(search));
    setSelectedHitId(null);
    setMode("results");
  }, [setFilters, setMode, setQuery]);

  const columns = useMemo(() => buildResultColumns(width), [width]);

  const renderCell = useCallback((
    hit: CloudSearchHit,
    column: SearchColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "ticker":
        return {
          text: hit.ticker,
          color: selectedColor ?? colors.textBright,
          content: (
            <TickerBadgeList
              symbols={[hit.ticker]}
              width={column.width}
              fallbackColor={selectedColor ?? colors.textBright}
              liveQuote={false}
            />
          ),
        };
      case "type":
        return { text: hitTypeLabel(hit), color: selectedColor ?? colors.textMuted };
      case "date":
        return { text: formatHitDate(hit.publishedAt), color: selectedColor ?? colors.textDim };
      case "title":
        return { text: hit.title, color: selectedColor ?? colors.text };
      case "match": {
        // The count leads so collapsing chunks into one row stays visible even
        // where the snippet behind it is cut off.
        const count = hitMatchCountLabel(hit);
        const segments = truncateSegments(
          [...(count ? [{ text: count, marked: false }] : []), ...parseMarkedSnippet(hit.snippet)],
          column.width,
        );
        return {
          text: `${count}${snippetPlainText(hit.snippet)}`,
          content: (
            <SnippetText
              segments={segments}
              color={selectedColor ?? colors.text}
              dimColor={selectedColor ?? colors.textDim}
            />
          ),
        };
      }
    }
  }, []);

  const closeDetail = useCallback(() => setOpenHit(null), []);

  // Opened straight onto a hit from the command bar, ahead of its own results.
  const focusRequestedHit = useCallback((hit: CloudSearchHit) => {
    setSelectedHitId(hit.id);
    setOpenHit(hit);
  }, []);
  useDocumentFocusRequest(paneId, focusRequestedHit);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusField("query");
      return true;
    }
    if (isPlainKey(event, "/")) {
      stopSearchFocusNavigation(event);
      focusField("query");
      return true;
    }
    if (isPlainKey(event, "t")) {
      stopSearchFocusNavigation(event);
      focusField("tickers");
      return true;
    }
    if (event.ctrl && event.name === "s") {
      stopSearchFocusNavigation(event);
      saveCurrentSearch();
      return true;
    }
    return false;
  }, [focusField, saveCurrentSearch]);

  // Search is free and uncapped, so nothing is gated up front: the upsell only
  // appears if the server itself refuses the query.
  const proRequired = failure?.status === 402;
  useEffect(() => {
    if (focused && status === "loaded") recordResearchActivity("research_viewed", "search");
  }, [focused, status]);
  const signInRequired = !access.signedIn || failure?.status === 401 || savedFailure?.status === 401;
  const verificationRequired = !signInRequired
    && (!access.emailVerified || failure?.status === 403);

  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    const info: PaneFooterSegment[] = [];
    if (status === "loading" || documentLoading || savedStatus === "loading") {
      info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    }
    if (loadingMore) {
      info.push({ id: "loading-more", parts: [{ text: "loading more", tone: "muted" }] });
    }
    if (proRequired) {
      info.push({ id: "pro", parts: [{ text: "pro required", tone: "warning" }] });
    }
    // The results table and the document view each show their own failure, so
    // only a status token belongs here. Saved-search writes have nowhere else.
    if (failure && status === "error") {
      info.push({ id: "error", parts: [{ text: "error", tone: "warning" }] });
    }
    if (savedFailure) {
      info.push({ id: "saved-error", parts: [{ text: savedFailure.message, tone: "warning" }] });
    }
    return info;
  }, [
    documentLoading,
    failure,
    loadingMore,
    proRequired,
    savedFailure,
    savedStatus,
    status,
  ]);

  const footerHints = useMemo<PaneHint[]>(() => {
    if (mode === "saved") {
      const selected = saved.find((entry) => entry.id === savedSelectedId);
      if (!selected) return [];
      return [
        { id: "alert", key: "a", label: "lerts", onPress: () => toggleAlert(selected) },
        { id: "delete", key: "d", label: "elete", onPress: () => { void removeSaved(selected); } },
      ];
    }
    if (openHit || !trimmedQuery) return [];
    return [{ id: "save", key: "Ctrl+S", label: "save search", onPress: saveCurrentSearch }];
  }, [
    mode,
    openHit,
    removeSaved,
    saved,
    savedSelectedId,
    saveCurrentSearch,
    toggleAlert,
    trimmedQuery,
  ]);

  // The stack title already names the open document, so the footer carries what
  // the title cannot: which company, when, what kind, and how long it is.
  const documentIdentity = useMemo(() => {
    if (!openHit) return null;
    const sections = document?.chunks.length ?? 0;
    return [
      formatHitDate(openHit.publishedAt),
      // The type leads the footer when the document has no ticker, so repeating
      // it here would say the same thing twice on one row.
      openHit.ticker ? hitTypeLabel(openHit) : null,
      sections ? `${sections} section${sections === 1 ? "" : "s"}` : null,
    ].filter((part): part is string => !!part).join(" \u00b7 ");
  }, [document, openHit]);

  useExternalLinkFooter({
    registrationId: RESEARCH_SEARCH_PANE_ID,
    focused,
    url: openHit?.url ?? null,
    source: documentIdentity,
    // Never a fixed word: the row is led by whichever of these the document
    // actually has, because a footer is for what changes as you move between
    // documents, not for saying "document".
    label: openHit ? (openHit.ticker || hitTypeLabel(openHit)) : "",
    info: footerInfo,
    hints: footerHints,
    showHint: !!openHit?.url,
  });

  if (signInRequired) {
    return <CloudAuthNotice message="Sign in to search transcripts, news, and filings." />;
  }
  if (verificationRequired) {
    return (
      <CloudAuthNotice
        needsVerification
        message="Verify your email to search transcripts, news, and filings."
      />
    );
  }

  const tabs = (
    <Tabs
      tabs={[
        { label: "Results", value: "results" },
        { label: "Saved", value: "saved" },
      ]}
      activeValue={mode}
      onSelect={(value) => setMode(value as PaneMode)}
      focused={focused && !openHit && activeField === null && !typePickerOpen}
    />
  );

  if (mode === "saved") {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <SavedSearchesView
          searches={saved}
          selectedId={savedSelectedId}
          onSelect={setSavedSelectedId}
          onRun={runSavedSearch}
          onToggleAlert={toggleAlert}
          onDelete={(search) => { void removeSaved(search); }}
          focused={focused}
          width={width}
          height={Math.max(1, height - 1)}
          emptyTitle={savedStatus === "loading"
            ? "Loading saved searches..."
            : "Run a search, then press Ctrl+S to save it and get keyword alerts."}
        />
      </Box>
    );
  }

  if (proRequired) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box flexDirection="column" paddingX={1}>
          <EmptyState
            title="This search needs Gloom Cloud Pro."
            message="It indexes earnings call transcripts, news wires, and SEC filings so one query reaches across all three."
          />
          <Box flexDirection="row" marginTop={1}>
            <Button label="Manage account" variant="secondary" onPress={openPlan} />
          </Box>
        </Box>
      </Box>
    );
  }

  const compact = width < 76;
  const searchBars = (
    <Box flexDirection={compact ? "column" : "row"}>
      <InputSearchBar
        value={query}
        focused={focused && !openHit && !typePickerOpen}
        active={activeField === "query"}
        width={compact ? width : Math.max(20, width - TICKER_FIELD_WIDTH)}
        focusToken={fieldFocusToken}
        inputRef={queryInputRef}
        placeholder="words or phrase across calls, news, and filings"
        debounceMs={QUERY_DEBOUNCE_MS}
        onFocus={() => focusField("query")}
        onBlur={blurField}
        onNavigateDown={blurField}
        onQueryChange={setQuery}
      />
      <InputSearchBar
        value={filters.tickers.join(" ")}
        focused={focused && !openHit && !typePickerOpen}
        active={activeField === "tickers"}
        width={compact ? width : TICKER_FIELD_WIDTH}
        focusToken={fieldFocusToken}
        inputRef={tickerInputRef}
        placeholder="tickers"
        glyph="#"
        debounceMs={QUERY_DEBOUNCE_MS}
        onFocus={() => focusField("tickers")}
        onBlur={blurField}
        onNavigateDown={blurField}
        onQueryChange={(value) => setFilters({ ...filters, tickers: parseTickerFilter(value) })}
      />
    </Box>
  );

  const emptyTitle = !trimmedQuery
    ? "Type a query to search transcripts, news, and filings."
    : failure
      ? "Search failed."
      : "No documents matched.";

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableStackView<CloudSearchHit, SearchColumn>
        focused={focused && activeField === null && !typePickerOpen}
        detailOpen={!!openHit}
        onBack={closeDetail}
        detailTitle={openHit?.title}
        detailContent={openHit ? (
          <SearchDocumentView
            hit={openHit}
            document={document}
            loading={documentLoading}
            error={documentFailure?.status === 402
              ? "This document is part of Gloom Cloud Pro."
              : documentFailure?.message ?? null}
            width={width}
          />
        ) : (
          <Box flexGrow={1} />
        )}
        rootBefore={(
          <Box flexDirection="column">
            {searchBars}
            <SearchFilterBar
              filters={filters}
              onChange={setFilters}
              onDialogOpenChange={setTypePickerOpen}
              width={width}
            />
          </Box>
        )}
        onRootKeyDown={handleRootKeyDown}
        rootWidth={width}
        rootHeight={Math.max(1, height - 1)}
        scrollRef={tableScrollRef}
        onBodyScrollActivity={loadMoreFromScroll}
        resetScrollKey={`${trimmedQuery}:${filters.sort}:${filters.range}:${filters.tickers.join(",")}:${filters.docTypes.join(",")}`}
        columns={columns}
        items={hits}
        selection={{
          kind: "id",
          selectedId: selectedHitId,
          getId: (hit) => hit.id,
          onChange: setSelectedHitId,
        }}
        onActivate={(hit) => {
          blurField();
          setOpenHit(hit);
        }}
        sortColumnId={filters.sort === "relevance" ? "match" : "date"}
        sortDirection={filters.sort === "oldest" ? "asc" : "desc"}
        onHeaderClick={(columnId) => {
          if (columnId === "match") {
            setFilters({ ...filters, sort: "relevance" });
            return;
          }
          if (columnId !== "date") return;
          setFilters({ ...filters, sort: filters.sort === "newest" ? "oldest" : "newest" });
        }}
        getItemKey={(hit) => hit.id}
        renderCell={renderCell}
        showHorizontalScrollbar={false}
        emptyContent={status === "loading" && hits.length === 0
          ? <Spinner label="Searching..." />
          : undefined}
        emptyStateTitle={emptyTitle}
        emptyStateHint={failure?.message}
      />
    </Box>
  );
}
