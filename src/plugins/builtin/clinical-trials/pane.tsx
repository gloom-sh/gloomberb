import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  FeedDataTableStackView,
  PaneStatusBody,
  QueryBar,
  usePagedRows,
  usePaneStatusLinkFooter,
  useQueryBarSearch,
  useTableLoadMore,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type FeedDataTableItem,
  type PageRequest,
  type PaneFooterSegment,
  type PaneHint,
  type RowPage,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import {
  useDebouncedPluginPaneState,
  usePaneSettingValue,
  usePluginPaneState,
} from "../../../public/react";
import type { PaneProps } from "../../../types/plugin";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { ClinicalTrialsClient, type ClinicalTrial, type DatePrecision, type TrialDateType } from "./client";
import { CLINICAL_TRIALS_PANE_ID } from "./types";

const SEARCH_DEBOUNCE_MS = 250;
const DEFAULT_PAGE_SIZE = 50;

function formatStatus(status: string): string {
  const lower = status.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatPhase(phases: string[]): string {
  if (phases.length === 0) return "No phase";
  if (phases.length === 1 && phases[0]!.toUpperCase() === "EARLY_PHASE1") return "Early phase 1";
  const numbers = phases
    .map((phase) => phase.toUpperCase().replace("EARLY_PHASE", "").replace("PHASE", "").trim())
    .filter(Boolean)
    .sort();
  return `Phase ${numbers.join("/")}`;
}

/** As precise as the registry gave it, marked when it is the sponsor's estimate. */
function formatDate(date: Date | null, precision: DatePrecision = "day", type?: TrialDateType): string {
  if (!date || Number.isNaN(date.getTime()) || date.getTime() === 0) return "-";
  const text = date.toISOString().slice(0, precision === "year" ? 4 : precision === "month" ? 7 : 10);
  return type === "ESTIMATED" ? `${text} (est.)` : text;
}

/** When the study was posted: always past, so the list's time column can read it as an age. */
function trialTimestamp(trial: ClinicalTrial): Date | null {
  return trial.firstPostDate ?? trial.firstSubmitDate;
}

function buildDetailMeta(trial: ClinicalTrial): string[] {
  return [
    `${trial.nctId} · ${formatStatus(trial.status)}`,
    `${formatPhase(trial.phases)}${trial.studyType ? ` · ${trial.studyType.toLowerCase()}` : ""}`,
    trial.sponsorClass ? `${trial.sponsor} (${trial.sponsorClass})` : trial.sponsor,
    trial.conditions.length > 0 ? trial.conditions.join(", ") : "No conditions listed",
    `Posted ${formatDate(trialTimestamp(trial))} · Start ${formatDate(trial.startDate, trial.startDatePrecision, trial.startDateType)}`,
    `Primary completion ${formatDate(trial.primaryCompletionDate, trial.primaryCompletionDatePrecision, trial.primaryCompletionDateType)}`
      + ` · Completion ${formatDate(trial.completionDate, trial.completionDatePrecision, trial.completionDateType)}`,
    trial.enrollment != null ? `Enrollment: ${trial.enrollment}` : "Enrollment: -",
  ];
}

function toFeedItems(trials: ClinicalTrial[]): FeedDataTableItem[] {
  return trials.map((trial) => ({
    id: trial.nctId,
    eyebrow: formatPhase(trial.phases),
    title: `${formatStatus(trial.status)} · ${trial.title} · ${trial.sponsor}`,
    timestamp: trialTimestamp(trial),
    detailTitle: trial.title,
    detailMeta: buildDetailMeta(trial),
    detailBody: trial.summary || "No summary was published for this study.",
  }));
}

export function TrialsPane({ width, height, focused }: PaneProps) {
  const client = useMemo(() => new ClinicalTrialsClient(), []);

  const [storedQuery] = usePaneSettingValue("query", "");
  const initialQuery = String(storedQuery ?? "").trim();
  const [query, setQuery] = usePluginPaneState("query", initialQuery);

  const [selectedId, setSelectedId] = useDebouncedPluginPaneState<string | null>("selectedId", null);
  // The open study is what the pane shows, so a reload or a shared layout opens it again.
  const [openItemId, setOpenItemId] = usePluginPaneState<string | null>("openItemId", null);
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // The registry pages by an opaque token, which the next page's offset keys.
  // A new search makes a new loader and so starts over with no tokens.
  const term = query.trim();
  const loadPage = useMemo(() => {
    const tokens = new Map<number, string>();
    return async ({ offset, signal }: PageRequest): Promise<RowPage<ClinicalTrial>> => {
      const pageToken = offset > 0 ? tokens.get(offset) : undefined;
      if (offset > 0 && !pageToken) return { rows: [], hasMore: false };
      const page = await client.listTrials({ term: term || undefined, pageSize: DEFAULT_PAGE_SIZE, pageToken }, signal);
      const nextOffset = offset + page.trials.length;
      if (page.nextPageToken) tokens.set(nextOffset, page.nextPageToken);
      return { rows: page.trials, hasMore: !!page.nextPageToken, nextOffset };
    };
  }, [client, term]);
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

  const selectedTrial = trials.find((item) => item.nctId === selectedId) ?? trials[0] ?? null;
  const selectedIdx = selectedTrial ? trials.indexOf(selectedTrial) : 0;
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

  const loading = studies.loading && trials.length === 0;
  const items = useMemo(() => toFeedItems(trials), [trials]);
  usePaneRefreshKey(studies.reload, { focused, enabled: !searchFocused && !openItemId });

  const detailUrl = detailTrial?.url || null;
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(studies.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
    ...(studies.moreError ? [{ id: "more-error", parts: [{ text: studies.moreError.message, tone: "warning" as const }] }] : []),
  ], [studies.loadingMore, studies.moreError]);
  const hints = useMemo<PaneHint[]>(
    () => (openItemId ? [] : [{ id: "search", key: "/", label: "search", onPress: focusSearch }]),
    [focusSearch, openItemId],
  );
  usePaneStatusLinkFooter({
    registrationId: CLINICAL_TRIALS_PANE_ID,
    focused,
    url: detailUrl,
    loading: studies.loading,
    error,
    info,
    hints,
    showOpenHint: !!detailUrl,
  });

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

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

  return (
    <FeedDataTableStackView
      width={width}
      height={height}
      focused={focused && !searchFocused}
      rootBefore={searchBar}
      items={items}
      selectedIdx={selectedIdx}
      onSelect={(index) => setSelectedId(trials[index]?.nctId ?? null)}
      openItemId={openItemId}
      onOpenItemIdChange={setOpenItemId}
      onRootKeyDown={handleRootKeyDown}
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
      sourceLabel="Phase"
      titleLabel="Status · Title · Sponsor"
      emptyStateTitle={term ? `No trials match ${term}.` : "No trials loaded."}
      emptyStateHint="Press / to search…"
    />
  );
}
