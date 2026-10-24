import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  PaneLinkMenu,
  PaneStatusBody,
  QueryBar,
  usePagedRows,
  usePaneFooter,
  usePaneStatusLinkFooter,
  useQueryBarSearch,
  useTableLoadMore,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PageRequest,
  type PaneFooterSegment,
  type PaneHint,
  type QueryBarFilter,
  type RowPage,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { DetailReader, type DetailFact } from "../../../components/reader/detail-reader";
import { tf } from "../../../i18n";
import {
  useAssetData,
  useDebouncedPluginPaneState,
  usePaneSettingValue,
  usePluginPaneState,
} from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { ThemeColors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { useOpenDescription } from "../shared/open-description";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { ClinicalTrialsClient, type ClinicalTrial, type DatePrecision, type TrialDateType } from "./client";
import {
  ALL,
  PHASE_FILTER_OPTIONS,
  SPONSOR_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  keepsToneWhenSelected,
  looksLikeTicker,
  normalizeTrialFilters,
  sponsorClassLabel,
  trialFiltersNarrow,
  trialFiltersQuery,
  trialLayout,
  trialPhaseDetail,
  trialPhaseLabel,
  trialStatus,
  trialStatusColor,
  trialStatusText,
  type TrialColumn,
  type TrialFilterOption,
  type TrialFilters,
} from "./model";
import { useSponsorTickers, type SponsorTicker } from "./sponsor-tickers";
import { tickerSponsorName } from "./ticker-sponsor";
import { CLINICAL_TRIALS_PANE_ID } from "./types";

const SEARCH_DEBOUNCE_MS = 250;
const DEFAULT_PAGE_SIZE = 50;

/** As precise as the registry gave it, marked when it is the sponsor's estimate. */
function formatDate(date: Date | null, precision: DatePrecision = "day", type?: TrialDateType): string {
  if (!date || Number.isNaN(date.getTime()) || date.getTime() === 0) return "-";
  const text = date.toISOString().slice(0, precision === "year" ? 4 : precision === "month" ? 7 : 10);
  return type === "ESTIMATED" ? `${text} (est.)` : text;
}

/** When the study was posted. */
function trialPosted(trial: ClinicalTrial): Date | null {
  return trial.firstPostDate ?? trial.firstSubmitDate;
}

/** The ticker cell: the symbol, its venue when there is room; blank when there is none; `?` when it was not looked up. */
function tickerCell(ticker: SponsorTicker | undefined, showVenue: boolean, colors: ThemeColors, selected: boolean, open: () => void): DataTableCell {
  if (ticker?.kind === "listed") {
    const venue = showVenue && ticker.exchange && !/^(NYSE|NASDAQ|AMEX|ARCA|BATS|CBOE)$/.test(ticker.exchange) ? ticker.exchange : "";
    return {
      text: venue ? `${ticker.ticker} ${venue}` : ticker.ticker,
      content: (
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={selected ? colors.selectedText : colors.textBright} attributes={TextAttributes.BOLD}>{ticker.ticker}</Text>
          {venue ? <Text fg={selected ? colors.selectedText : colors.textDim}>{` ${venue}`}</Text> : null}
        </Box>
      ),
      onMouseDown: (event?: { button?: number }) => { if ((event?.button ?? 0) === 0) open(); },
    };
  }
  if (ticker?.kind === "failed") return { text: "?", value: null, color: colors.textMuted };
  return { text: "", value: null };
}

/** What the detail says about the sponsor's listing, in words. */
function tickerDetail(ticker: SponsorTicker | undefined): string {
  switch (ticker?.kind) {
    case "listed": return ticker.exchange ? `${ticker.ticker} · ${ticker.exchange}` : ticker.ticker;
    case "none":
      if (ticker.ambiguous) return "Ambiguous: the name fits more than one company";
      return ticker.entityName ? `None listed for ${ticker.entityName}` : "No listed company matched";
    case "failed": return `Not looked up: ${ticker.reason}`;
    default: return "Looking up…";
  }
}

/**
 * The study at a glance, label beside value, in the order a wide pane pairs
 * them: status and phase, sponsor and its ticker, size and registry id, then
 * the dates; the summary follows across the pane.
 */
function trialFacts(trial: ClinicalTrial, ticker: SponsorTicker | undefined, colors: ThemeColors, openTicker: () => void): DetailFact[] {
  const status = trialStatus(trial.status);
  const sponsorClass = sponsorClassLabel(trial.sponsorClass);
  const studyType = trial.studyType ? trial.studyType.toLowerCase().replace(/_/g, " ") : "";
  return [
    { label: "Status", value: status.label, color: trialStatusColor(status.tone, colors) },
    { label: "Phase", value: studyType ? `${trialPhaseDetail(trial.phases)} · ${studyType}` : trialPhaseDetail(trial.phases) },
    { label: "Sponsor", value: sponsorClass ? `${trial.sponsor} · ${sponsorClass}` : trial.sponsor },
    ticker?.kind === "listed"
      ? { label: "Ticker", value: tickerDetail(ticker), color: colors.textBright, link: { label: tf("Open {ticker}", { ticker: ticker.ticker }), onOpen: openTicker } }
      : { label: "Ticker", value: tickerDetail(ticker), color: colors.textDim },
    { label: "Enrollment", value: trial.enrollment != null ? trial.enrollment.toLocaleString("en-US") : "-" },
    { label: "Registry ID", value: trial.nctId },
    { label: "Start", value: formatDate(trial.startDate, trial.startDatePrecision, trial.startDateType) },
    { label: "Posted", value: formatDate(trialPosted(trial)) },
    { label: "Updated", value: formatDate(trial.lastUpdatePostDate) },
    { label: "Primary completion", value: formatDate(trial.primaryCompletionDate, trial.primaryCompletionDatePrecision, trial.primaryCompletionDateType) },
    { label: "Completion", value: formatDate(trial.completionDate, trial.completionDatePrecision, trial.completionDateType) },
    { label: "Conditions", value: trial.conditions.length > 0 ? trial.conditions.join(", ") : "None listed" },
  ];
}

function filterOptions(options: readonly TrialFilterOption[], colors: ThemeColors) {
  return options.map(({ tone, ...option }) => (tone ? { ...option, color: trialStatusColor(tone, colors) } : option));
}

export function TrialsPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const client = useMemo(() => new ClinicalTrialsClient(), []);
  const dataProvider = useAssetData();
  const openDescription = useOpenDescription();
  const session = useResearchCloudSession();

  const [storedQuery] = usePaneSettingValue("query", "");
  const initialQuery = String(storedQuery ?? "").trim();
  const [query, setQuery] = usePluginPaneState("query", initialQuery);
  // A function's options (`TRIAL obesity --phase 3`) set the filters the pane opens with.
  const [storedStatus] = usePaneSettingValue("status", "");
  const [storedPhase] = usePaneSettingValue("phase", "");
  const [storedSponsorClass] = usePaneSettingValue("sponsorClass", "");
  const initialFilters = useMemo(
    () => normalizeTrialFilters({ status: storedStatus, phase: storedPhase, sponsorClass: storedSponsorClass }),
    [storedPhase, storedSponsorClass, storedStatus],
  );
  const [savedFilters, setSavedFilters] = usePluginPaneState<TrialFilters>("filters", initialFilters);
  const filters = useMemo(() => normalizeTrialFilters(savedFilters), [savedFilters]);

  const [selectedId, setSelectedId] = useDebouncedPluginPaneState<string | null>("selectedId", null);
  // The open study is what the pane shows, so a reload or a shared layout opens it again.
  // `open` (a share, `gloom shot TRIAL obesity --open NCT07868939`) opens one study first.
  const [initialOpen] = usePaneSettingValue("open", "");
  const [openItemId, setOpenItemId] = usePluginPaneState<string | null>("openItemId", String(initialOpen ?? "").trim() || null);
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // The registry pages by an opaque token, which the next page's offset keys.
  // A new search or filter makes a new loader and so starts over with no tokens.
  const term = query.trim();
  const filtersKey = `${filters.status}|${filters.phase}|${filters.sponsorClass}`;
  const loadPage = useMemo(() => {
    const tokens = new Map<number, string>();
    const narrowing = trialFiltersQuery(filters);
    return async ({ offset, signal }: PageRequest): Promise<RowPage<ClinicalTrial>> => {
      const pageToken = offset > 0 ? tokens.get(offset) : undefined;
      if (offset > 0 && !pageToken) return { rows: [], hasMore: false };
      const page = await client.listTrials({ term: term || undefined, ...narrowing, pageSize: DEFAULT_PAGE_SIZE, pageToken }, signal);
      const nextOffset = offset + page.trials.length;
      if (page.nextPageToken) tokens.set(nextOffset, page.nextPageToken);
      return { rows: page.trials, hasMore: !!page.nextPageToken, nextOffset };
    };
    // `filtersKey` stands for `filters`, which is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, filtersKey, term]);
  const studies = usePagedRows(loadPage, { getId: (trial) => trial.nctId, keepPreviousRows: true });
  const trials = studies.rows;
  const error = studies.error?.message ?? null;
  const loadMore = useTableLoadMore(scrollRef, studies.hasMore && !openItemId, studies.loadMore);
  // Scrolling asks for the next page, so a page that does not fill a tall
  // pane asks for it once it is laid out.
  const { hasMore, loadingMore, loadMore: loadNextPage } = studies;
  useEffect(() => {
    if (!hasMore || loadingMore || openItemId) return;
    const timer = setTimeout(() => {
      const box = scrollRef.current;
      if (box?.viewport && box.scrollHeight > 0 && box.scrollHeight <= box.viewport.height) loadNextPage();
    }, 0);
    return () => clearTimeout(timer);
  }, [hasMore, height, loadNextPage, loadingMore, openItemId, trials.length]);

  // Tickers come from Gloom Cloud a page of sponsors at a time; rows never wait for them.
  const sponsors = useMemo(() => [...new Set(trials.map((trial) => trial.sponsor))], [trials]);
  const sponsorTickers = useSponsorTickers(sponsors, session.requestKey);
  const tickerOf = useCallback((trial: ClinicalTrial) => sponsorTickers.tickers.get(trial.sponsor), [sponsorTickers.tickers]);

  const selectedTrial = trials.find((item) => item.nctId === selectedId) ?? trials[0] ?? null;
  const openTrial = openItemId
    ? trials.find((trial) => trial.nctId === openItemId) ?? null
    : null;
  const detailTrial = openTrial ?? selectedTrial;
  // A restored open study can sit past the first page: page on until it
  // arrives, and drop it only once every page is in without it.
  useEffect(() => {
    if (!openItemId || openTrial || studies.status !== "loaded" || studies.loadingMore) return;
    if (studies.hasMore && !studies.moreError) studies.loadMore();
    else setOpenItemId(null);
  }, [openItemId, openTrial, setOpenItemId, studies]);

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery.trim());
    setSelectedId(null);
    setOpenItemId(null);
  }, [setOpenItemId, setQuery, setSelectedId]);
  const updateFilter = useCallback((key: keyof TrialFilters, value: string) => {
    setSavedFilters({ ...filters, [key]: value });
    setSelectedId(null);
    setOpenItemId(null);
  }, [filters, setOpenItemId, setSavedFilters, setSelectedId]);

  const reload = useCallback(() => {
    studies.reload();
    sponsorTickers.retry();
  }, [sponsorTickers, studies]);
  // `TRIAL VKTX`: no study names a symbol, so one that finds nothing is
  // searched as its company's name, quoted so the registry matches the whole
  // name as a sponsor files it, and the search box then shows it. Each term
  // is looked up once.
  const [looked, setLooked] = useState<ReadonlySet<string>>(() => new Set());
  const resolvingTicker = studies.status === "loaded" && trials.length === 0 && !studies.error
    && looksLikeTicker(term) && !looked.has(term.toUpperCase());
  useEffect(() => {
    if (!resolvingTicker) return;
    let live = true;
    void tickerSponsorName(dataProvider, term).catch(() => null).then((name) => {
      if (!live) return;
      setLooked((current) => new Set([...current, term.toUpperCase()]));
      if (name) updateQuery(`"${name}"`);
    });
    return () => { live = false; };
  }, [dataProvider, resolvingTicker, term, updateQuery]);
  const loading = (studies.loading && trials.length === 0) || resolvingTicker;
  usePaneRefreshKey(reload, { focused, enabled: !searchFocused && !openItemId });

  const detailTicker = detailTrial ? tickerOf(detailTrial) : undefined;
  const listedTicker = detailTicker?.kind === "listed" ? detailTicker : null;
  const openTicker = useCallback(() => {
    if (listedTicker) openDescription(listedTicker.ticker, listedTicker.exchange ?? undefined);
  }, [listedTicker, openDescription]);

  const detailUrl = detailTrial?.url || null;
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(studies.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
    ...(studies.moreError ? [{ id: "more-error", parts: [{ text: studies.moreError.message, tone: "warning" as const }] }] : []),
    ...(sponsorTickers.failure && trials.length > 0
      ? [{ id: "tickers", parts: [{ text: "tickers not looked up", tone: "muted" as const }] }]
      : []),
  ], [sponsorTickers.failure, studies.loadingMore, studies.moreError, trials.length]);
  const hints = useMemo<PaneHint[]>(() => [
    ...(openItemId ? [] : [{ id: "search", key: "/", label: "search", onPress: focusSearch }]),
    ...(listedTicker ? [{ id: "description", key: "d", label: "es", title: "Description (DES)", onPress: openTicker }] : []),
  ], [focusSearch, listedTicker, openItemId, openTicker]);
  usePaneStatusLinkFooter({
    registrationId: CLINICAL_TRIALS_PANE_ID,
    focused,
    url: detailUrl,
    loading: studies.loading,
    error: trials.length > 0 ? error : null,
    info,
    hints,
    showOpenHint: !!detailUrl,
  });

  // Reading on: the next or previous study opens in place, and the list cursor
  // follows it so Back lands on the last one read.
  const openIndex = openTrial ? trials.indexOf(openTrial) : -1;
  const openAdjacent = useCallback((step: 1 | -1) => {
    const next = openIndex >= 0 ? trials[openIndex + step] : undefined;
    if (!next) return;
    setSelectedId(next.nctId);
    setOpenItemId(next.nctId);
  }, [openIndex, setOpenItemId, setSelectedId, trials]);
  usePaneFooter(`${CLINICAL_TRIALS_PANE_ID}:reading`, () => (focused && openIndex >= 0 ? {
    order: 1,
    hints: [
      { id: "trial-next", key: "n", label: "ext", title: "Next Study", disabled: openIndex >= trials.length - 1, onPress: () => openAdjacent(1) },
      { id: "trial-previous", key: "p", label: "rev", title: "Previous Study", disabled: openIndex <= 0, onPress: () => openAdjacent(-1) },
    ],
  } : null), [focused, openAdjacent, openIndex, trials.length]);

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

  const layout = useMemo(() => trialLayout(width), [width]);
  const renderCell = useCallback((trial: ClinicalTrial, column: TrialColumn, _index: number, rowState: { selected: boolean }): DataTableCell => {
    switch (column.id) {
      case "updated": {
        const updated = formatDate(trial.lastUpdatePostDate);
        return trial.lastUpdatePostDate ? { text: updated, value: updated, color: colors.textDim } : { text: "--", value: null, color: colors.textMuted };
      }
      case "phase": {
        const text = trialPhaseLabel(trial.phases, layout.compact);
        return { text, color: text === "--" || text === "N/A" ? colors.textMuted : colors.text };
      }
      case "status": {
        const status = trialStatus(trial.status);
        return {
          text: trialStatusText(status, column.width),
          value: status.label,
          color: trialStatusColor(status.tone, colors),
          keepColorWhenSelected: keepsToneWhenSelected(status.tone),
        };
      }
      case "title":
        return { text: trial.title, color: colors.text, attributes: rowState.selected ? TextAttributes.BOLD : undefined };
      case "sponsor":
        return { text: trial.sponsor, color: trial.sponsorClass === "INDUSTRY" ? colors.textBright : colors.textDim };
      case "ticker": {
        const ticker = tickerOf(trial);
        return tickerCell(ticker, layout.showVenue, colors, rowState.selected, () => {
          if (ticker?.kind === "listed") openDescription(ticker.ticker, ticker.exchange ?? undefined);
        });
      }
    }
  }, [colors, layout, openDescription, tickerOf]);

  const statusOptions = useMemo(() => filterOptions(STATUS_FILTER_OPTIONS, colors), [colors]);
  const queryFilters = useMemo<QueryBarFilter[]>(() => [
    { id: "status", label: "Status", value: filters.status, defaultValue: ALL, options: statusOptions, onChange: (value: string) => updateFilter("status", value) },
    { id: "phase", label: "Phase", value: filters.phase, defaultValue: ALL, options: PHASE_FILTER_OPTIONS, onChange: (value: string) => updateFilter("phase", value) },
    { id: "sponsorClass", label: "Sponsor", title: "Lead sponsor class", value: filters.sponsorClass, defaultValue: ALL, options: SPONSOR_FILTER_OPTIONS,
      onChange: (value: string) => updateFilter("sponsorClass", value) },
  ], [filters, statusOptions, updateFilter]);

  const searchBar = (
    <QueryBar
      width={width}
      search={{
        value: query,
        onChange: updateQuery,
        placeholder: "condition, drug, or sponsor",
        focused: focused && !openItemId,
        debounceMs: SEARCH_DEBOUNCE_MS,
        normalizeValue: (value) => value.trim(),
        ...searchProps,
      }}
      filters={queryFilters}
    />
  );

  if (loading || (error && trials.length === 0)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {searchBar}
        <PaneStatusBody loading={loading} error={error} subject="Trials" />
      </Box>
    );
  }

  const detail = openTrial ? (
    <PaneLinkMenu>
      <DetailReader
        ref={detailScrollRef}
        resetScrollKey={openTrial.nctId}
        width={width}
        facts={trialFacts(openTrial, tickerOf(openTrial), colors, openTicker)}
        body={openTrial.summary || "No summary was published for this study."}
      />
    </PaneLinkMenu>
  ) : null;

  const narrowed = trialFiltersNarrow(filters);
  return (
    <DataTableStackView<ClinicalTrial, TrialColumn>
      focused={focused && !searchFocused}
      detailOpen={!!openTrial}
      onBack={() => setOpenItemId(null)}
      detailContent={detail}
      detailTitle={openTrial?.title}
      detailScrollRef={detailScrollRef}
      rootBefore={searchBar}
      rootWidth={width}
      rootHeight={height}
      columns={layout.columns}
      items={trials}
      getItemKey={(trial) => trial.nctId}
      renderCell={renderCell}
      selection={{
        kind: "id",
        selectedId: selectedTrial?.nctId ?? null,
        getId: (trial) => trial.nctId,
        onChange: (id) => setSelectedId(id),
      }}
      onActivate={(trial) => {
        setSelectedId(trial.nctId);
        setOpenItemId(trial.nctId);
      }}
      onRootKeyDown={handleRootKeyDown}
      sortColumnId={null}
      sortDirection="desc"
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
      resetScrollKey={`${term}|${filtersKey}`}
      showHorizontalScrollbar={false}
      selectedTextOverridesCellColor
      emptyStateTitle={term
        ? `No trials match ${term}${narrowed ? " with these filters" : ""}.`
        : narrowed ? "No trials match these filters." : "No trials loaded."}
      emptyStateHint={narrowed ? "Clear a filter to see more…" : term ? "Try the company or drug name…" : "Press / to search…"}
    />
  );
}
