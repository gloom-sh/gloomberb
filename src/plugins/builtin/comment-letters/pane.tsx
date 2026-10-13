import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  DetailScrollBody,
  InlineTickerBadge,
  KeyValueRow,
  Notice,
  PaneStatusBody,
  Prose,
  QueryBar,
  usePagedRows,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  useQueryBarSearch,
  useTableLoadMore,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { getSharedMarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import { useResolvedEntryValue, useSecFilingContent } from "../../../market-data/hooks";
import type { InlineTickerCatalogEntry } from "../../../state/hooks/inline-tickers";
import { instrumentFromTicker } from "../../../market-data/request-types";
import {
  useDebouncedPluginPaneState,
  usePaneSettingValue,
  usePaneTitle,
  usePluginPaneState,
} from "../../../public/react";
import { extractFilingContent, PDF_FALLBACK_MESSAGE } from "../../../sources/sec-edgar/content";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, type ScrollBoxRenderable } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { SEC_FILING_FETCH_LIMIT } from "../sec/forms";
import { useOpenDescription } from "../shared/open-description";
import { toneColor, type StateTone } from "../shared/research-cells";
import {
  createCommentLettersLoader,
  isPdfLetter,
  letterFilingItem,
  letterMarkup,
  letterPlainText,
  letterTopics,
  CommentLettersClient,
  type IssuerFilingsLoader,
} from "./client";
import { COMMENT_LETTERS_PANE_ID, type CommentLetter } from "./types";

const SEARCH_DEBOUNCE_MS = 350;
/** How the filing text reader ends a document it cut short. */
const TRUNCATION_MARK = /\s*\[truncated\]\s*$/;

type ColumnId = "filed" | "from" | "form" | "company" | "ticker";
type LetterColumn = DataTableColumn & { id: ColumnId };

const AUTHOR_LABEL = { staff: "SEC staff", company: "Company" } as const;
/** A staff letter is the regulator asking; the company's answer reads as plain text. */
const AUTHOR_TONE: Record<CommentLetter["author"], StateTone> = { staff: "warning", company: "text" };

function letterColumns(width: number, issuerView: boolean): LetterColumn[] {
  return [
    { id: "filed", label: "Filed", width: 10, align: "left" },
    { id: "from", label: "From", width: 9, align: "left" },
    ...(width >= 64 || issuerView
      ? [{ id: "form" as const, label: "Form", width: 7, align: "left" as const, ...(issuerView ? { flexGrow: 1 } : {}) }]
      : []),
    ...(issuerView ? [] : [
      { id: "company" as const, label: "Company", width: 16, align: "left" as const, flexGrow: 1 },
      ...(width >= 52 ? [{ id: "ticker" as const, label: "Ticker", width: 8, align: "left" as const }] : []),
    ]),
  ];
}

/**
 * EDGAR lists the filer's tickers, so the symbol is drawn as a badge as it is.
 * A badge list looks each symbol up first and prints the ones whose lookup
 * fails (often only a burst of lookups throttled) as plain text, so one
 * column mixed chips and bare symbols.
 */
const LISTED_TICKER: InlineTickerCatalogEntry = { status: "ready", ticker: null, quote: null };

function LetterTickerBadge({ symbol, width, onOpen }: { symbol: string; width: number; onOpen: (symbol: string) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box flexDirection="row" width={width} height={1} overflow="hidden">
      <InlineTickerBadge
        entry={LISTED_TICKER}
        symbol={symbol}
        liveQuote={false}
        hovered={hovered}
        maxTextWidth={Math.max(1, width - 2)}
        trailingGap={false}
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        onOpen={onOpen}
      />
    </Box>
  );
}

const formatDate = (date: Date): string =>
  Number.isNaN(date.getTime()) ? "-" : date.toISOString().slice(0, 10);

const companyLabel = (letter: CommentLetter): string =>
  letter.companyName || `CIK ${Number(letter.cik)}`;

// The issuer list is the one the SEC pane reads, through the same cache.
const loadIssuerFilings: IssuerFilingsLoader = async (ticker, force) => {
  const coordinator = getSharedMarketDataCoordinator();
  const instrument = instrumentFromTicker(null, ticker);
  if (!coordinator || !instrument) return null;
  const entry = await coordinator.loadSecFilings({ instrument, count: SEC_FILING_FETCH_LIMIT }, { forceRefresh: force });
  const filings = resolveEntryValue(entry);
  if (!filings || entry.error) return null;
  return { filings, complete: filings.length < SEC_FILING_FETCH_LIMIT };
};

/** What the open letter says, read through the SEC filing content the SEC pane uses. */
function useLetterText(letter: CommentLetter | null) {
  const pdf = !!letter && isPdfLetter(letter);
  const target = useMemo(() => (letter && !pdf ? letterFilingItem(letter) : null), [letter, pdf]);
  const entry = useSecFilingContent(target);
  const raw = useResolvedEntryValue(entry);
  return useMemo(() => {
    if (!letter) return { text: null, topics: null, loading: false, error: null };
    if (pdf) return { text: PDF_FALLBACK_MESSAGE, topics: null, loading: false, error: null };
    const loading = !entry || entry.phase === "idle" || entry.phase === "loading" || (entry.phase === "refreshing" && raw == null);
    const error = entry?.error && entry.error.reasonCode !== "NO_DATA" ? entry.error.message : null;
    if (!raw) return { text: null, topics: null, loading, error };
    const text = extractFilingContent(letterMarkup(raw), "", { form: letter.form, sourceUrl: letter.primaryDocumentUrl });
    return { text, topics: text ? letterTopics(letterPlainText(raw)) : null, loading: false, error: null };
  }, [entry, letter, pdf, raw]);
}

export function CommentLettersPane({ width, height, focused }: PaneProps) {
  const client = useMemo(() => new CommentLettersClient(), []);
  const colors = useThemeColors();
  const openDescription = useOpenDescription();
  const [storedQuery] = usePaneSettingValue("query", "");
  const initialQuery = String(storedQuery ?? "").trim();
  const [query, setQuery] = usePluginPaneState("query", initialQuery);
  const [selectedId, setSelectedId] = useDebouncedPluginPaneState<string | null>("selectedId", null);
  // The open letter is what the pane shows, so a reload or a shared layout opens it again.
  const [openItemId, setOpenItemId] = usePluginPaneState<string | null>("openItemId", null);
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const term = query.trim();
  // The search can change after the pane opens; the title follows it.
  usePaneTitle(term ? `Comment Letters ${term}` : "Comment Letters");
  const loadPage = useMemo(() => createCommentLettersLoader(client, term, loadIssuerFilings), [client, term]);
  const letters = usePagedRows(loadPage, { getId: (letter) => letter.id, keepPreviousRows: true });
  const rows = letters.rows;
  const issuer = letters.pages[0]?.issuer ?? null;
  const windowLimited = letters.pages[letters.pages.length - 1]?.windowLimited ?? false;
  const loadMore = useTableLoadMore(scrollRef, letters.hasMore && !openItemId, letters.loadMore);
  const columns = useMemo(() => letterColumns(width, !!issuer), [issuer, width]);

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const openLetter = openItemId ? rows.find((row) => row.id === openItemId) ?? null : null;
  // A restored open letter can sit past the first page: page on until it
  // arrives, and drop it only once every page is in without it.
  useEffect(() => {
    if (!openItemId || openLetter || letters.status !== "loaded" || letters.loadingMore) return;
    if (letters.hasMore && !letters.moreError) letters.loadMore();
    else setOpenItemId(null);
  }, [letters, openItemId, openLetter, setOpenItemId]);

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery.trim());
    setSelectedId(null);
    setOpenItemId(null);
  }, [setOpenItemId, setQuery, setSelectedId]);

  const letterText = useLetterText(openLetter);
  const loading = letters.loading && rows.length === 0;
  const error = letters.error?.message ?? null;
  usePaneRefreshKey(letters.reload, { focused, enabled: !searchFocused && !openItemId });

  const linkLetter = openLetter ?? selected;
  const detailUrl = linkLetter ? linkLetter.primaryDocumentUrl ?? linkLetter.filingUrl : null;
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(letters.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
    ...(letters.moreError ? [{ id: "more-error", parts: [{ text: letters.moreError.message, tone: "warning" as const }] }] : []),
  ], [letters.loadingMore, letters.moreError]);
  // Funds and BDCs file without a ticker; their rows have nothing to open.
  const linkTicker = linkLetter?.tickers[0] ?? null;
  const hints = useMemo<PaneHint[]>(() => [
    ...(openItemId ? [] : [{ id: "search", key: "/", label: "search", onPress: focusSearch }]),
    ...(linkTicker ? [{ id: "description", key: "d", label: "es", title: `Open ${linkTicker}`, onPress: () => openDescription(linkTicker) }] : []),
  ], [focusSearch, linkTicker, openDescription, openItemId]);
  usePaneStatusLinkFooter({
    registrationId: COMMENT_LETTERS_PANE_ID,
    focused,
    url: detailUrl,
    label: "letter",
    loading: letters.loading || (!!openLetter && letterText.loading),
    error: openLetter ? letterText.error : rows.length > 0 ? error : null,
    info,
    hints,
    showOpenHint: !!detailUrl,
  });
  usePaneNoticeFooter({
    registrationId: `${COMMENT_LETTERS_PANE_ID}:window`,
    notices: windowLimited
      ? ["The SEC's full-text search lists only the first 10,000 matches. Narrow the search to reach older letters."]
      : [],
    focused,
    enabled: !openLetter,
    title: "Comment letters",
  });

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

  const renderCell = useCallback((letter: CommentLetter, column: LetterColumn): DataTableCell => {
    switch (column.id) {
      case "filed":
        return { text: formatDate(letter.filingDate), value: letter.filingDate, color: colors.textMuted };
      case "from":
        return { text: AUTHOR_LABEL[letter.author], color: toneColor(AUTHOR_TONE[letter.author], colors) };
      case "form":
        return { text: letter.form, color: colors.textDim };
      case "company":
        return { text: companyLabel(letter), color: colors.textBright };
      case "ticker": {
        const ticker = letter.tickers[0] ?? "";
        // The badge opens the company's DES on click, like a ticker anywhere else; so does the rest of the cell.
        return ticker
          ? {
            text: ticker,
            onMouseDown: () => openDescription(ticker),
            content: <LetterTickerBadge symbol={ticker} width={column.width} onOpen={openDescription} />,
          }
          : { text: "" };
      }
    }
  }, [colors, openDescription]);

  const searchBar = (
    <QueryBar
      width={width}
      search={{
        value: query,
        onChange: updateQuery,
        placeholder: "words or a ticker",
        focused: focused && !openItemId,
        debounceMs: SEARCH_DEBOUNCE_MS,
        normalizeValue: (value) => value.trim(),
        ...searchProps,
      }}
      meta={issuer ? `${issuer.name} · CIK ${Number(issuer.cik)}` : undefined}
    />
  );

  if (loading || (error && rows.length === 0)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {searchBar}
        <PaneStatusBody loading={loading} error={error} subject="comment letters" errorTitle="Comment letters unavailable." />
      </Box>
    );
  }

  const detailWidth = Math.max(0, width - 2);
  const detail = openLetter ? (
    <DetailScrollBody ref={detailScrollRef} resetScrollKey={openLetter.id}>
      <Box flexDirection="column">
        <KeyValueRow label="Filed" value={formatDate(openLetter.filingDate)} width={detailWidth} />
        <KeyValueRow label="From" value={`${AUTHOR_LABEL[openLetter.author]} (${openLetter.form})`} width={detailWidth} />
        <KeyValueRow label="CIK" value={String(Number(openLetter.cik))} width={detailWidth} />
        <KeyValueRow label="Accession" value={openLetter.accessionNumber} width={detailWidth} />
        {letterText.topics && letterText.topics.length > 0 ? (
          <KeyValueRow label="Mentions" value={letterText.topics.join(", ")} width={detailWidth} />
        ) : null}
        <Box height={1} />
        {letterText.text ? (
          <>
            {letterText.text.replace(TRUNCATION_MARK, "").split("\n").map((paragraph, index) => (
              paragraph.trim()
                ? <Prose key={index} text={paragraph} width={detailWidth} figures={false} />
                : <Box key={index} height={1} />
            ))}
            {TRUNCATION_MARK.test(letterText.text) ? (
              <Notice tone="muted">The letter continues past this preview; o opens all of it.</Notice>
            ) : null}
          </>
        ) : (
          <Text fg={colors.textDim}>
            {letterText.loading ? "Loading the letter..." : letterText.error ? "The letter's text is unavailable." : "This letter has no readable text."}
          </Text>
        )}
      </Box>
    </DetailScrollBody>
  ) : null;

  return (
    <DataTableStackView<CommentLetter, LetterColumn>
      focused={focused && !searchFocused}
      detailOpen={!!openLetter}
      onBack={() => setOpenItemId(null)}
      detailContent={detail}
      detailTitle={openLetter ? `${companyLabel(openLetter)}${openLetter.tickers[0] ? ` (${openLetter.tickers[0]})` : ""}` : undefined}
      detailScrollRef={detailScrollRef}
      rootBefore={searchBar}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      getItemKey={(letter) => letter.id}
      renderCell={renderCell}
      selection={{
        kind: "id",
        selectedId: selected?.id ?? null,
        getId: (letter) => letter.id,
        onChange: (id) => setSelectedId(id),
      }}
      onActivate={(letter) => setOpenItemId(letter.id)}
      onRootKeyDown={handleRootKeyDown}
      sortColumnId={null}
      sortDirection="desc"
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
      selectedTextOverridesCellColor
      emptyStateTitle={issuer ? `No comment letters for ${issuer.name}.` : term ? `No comment letters match ${term}.` : "No comment letters."}
      emptyStateHint="Press / to search…"
    />
  );
}
