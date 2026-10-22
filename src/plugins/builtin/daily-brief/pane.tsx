import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_TABLE_CELL,
  PageStackView,
  PaneStatusBody,
  StatGrid,
  statGridRows,
  usePaneNoticeFooter,
  usePaneStatusLinkFooter,
  type DataTableCell,
  type DataTableColumn,
  type StatItem,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { openUrl } from "../../../components/ui/external-link";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import { getSharedNewsService, useLoadNewsStory, useNewsArticles } from "../../../news/hooks";
import {
  useAppSelector,
  useAsyncResource,
  useAutoRefresh,
  useMarketData,
  usePluginConfigState,
  usePluginPaneState,
  usePluginTickerActions,
} from "../../../public/react";
import { useShortcut } from "../../../react/input";
import type { RatePathPayload } from "../../../api-client/rates";
import type { Quote } from "../../../types/financials";
import type { PaneProps } from "../../../types/plugin";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, ScrollBox, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { formatFeedTime } from "../../../utils/datetime-format";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { compareSortValues, nextHeaderSort, type SortPreference } from "../../../utils/sort-values";
import { loadEarningsBoard, cachedEarningsCalendar } from "../earnings/client";
import { TIMING_LABEL, epsText, moneyText } from "../earnings/format";
import { newYorkToday } from "../earnings/board-model";
import { getCalendarCache, loadCalendar, type EconCalendarLoadResult } from "../econ/calendar-model";
import { getCachedFearGreedData, loadFearGreed, type FearGreedLoadResult } from "../fear-greed/cache";
import { formatScore, ratingLabel, ratingTrend } from "../fear-greed/format";
import { getCachedRatePath, loadRatePath } from "../rate-path/client";
import { meetingLabel, meetingMoves, moveOddsText } from "../rate-path/model";
import { NewsDetailView, useNewsArticleDetail } from "../news/wire/news/detail-view";
import { NEWS_QUERY_PRESETS } from "../news/wire/news/query-presets";
import { listingCell } from "../shared/research-cells";
import { boardErrorMessage, quoteBoardStatus, useQuoteBoard } from "../shared/use-quote-board";
import { EsSessionChart } from "./chart";
import { esChartHeight, esChartStart } from "./chart-window";
import { loadBriefMarks, type SessionMark } from "./session-history";
import { briefFooterInfo } from "./footer";
import { assembleBrief, BRIEF_FUTURES } from "./model";
import { BRIEF_YIELDS, getCachedBriefYields, loadBriefYields, yieldStat } from "./rates";
import { BriefViewBlock, type BriefViewLine } from "./section-view";
import {
  BRIEF_SECTIONS_SETTING,
  briefSectionTitle,
  defaultBriefLayout,
  parseBriefSections,
  type BriefBuiltinSection,
  type BriefViewSection,
} from "./sections";
import { buildBriefProfile } from "./profile";
import {
  BriefTable,
  earningsColumns,
  headlineColumns,
  releaseColumns,
  type BriefTableRow,
} from "./tables";

const BRIEF_VIX = "^VIX";
const BRIEF_SYMBOLS: string[] = [...BRIEF_FUTURES, BRIEF_VIX];
/** Same day cap as the earnings board, so a busy session is not cut after the largest names. */
const EARNINGS_PER_DAY = 200;
const PANE_KEY = "daily-brief";
const UNSORTED: SortPreference<string> = { columnId: null, direction: "asc" };

type HeadlineRow = BriefTableRow & { kind: "headline"; articleId: string; publishedAt: string; source: string; title: string };
type ReleaseRow = BriefTableRow & { kind: "release"; when: string; country: string; title: string };
type EarningsRow = BriefTableRow & {
  kind: "earnings";
  when: string;
  symbol: string;
  company: string;
  rank: number;
  epsEstimate: number | null;
  revenueEstimate: number | null;
};
type NavLine = HeadlineRow | ReleaseRow | EarningsRow | BriefViewLine;

type BriefTableBlock =
  | { builtin: "headlines"; section: BriefBuiltinSection; items: HeadlineRow[] }
  | { builtin: "today"; section: BriefBuiltinSection; items: ReleaseRow[] }
  | { builtin: "earnings"; section: BriefBuiltinSection; items: EarningsRow[] }
  | { builtin: "view"; section: BriefViewSection; items: BriefViewLine[] };

function earningsQuery() {
  const date = newYorkToday();
  return { from: date, to: date, perDay: EARNINGS_PER_DAY };
}

function noticeList(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const notices: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    notices.push(text);
  }
  return notices;
}

function eventWhen(at: string): string {
  if (at === "99:99") return "--";
  if (at === "bmo" || at === "amc" || at === "dmh") return TIMING_LABEL[at];
  return at;
}

function whenRank(when: string): number {
  if (when === "BMO") return 0;
  if (when === "DMH") return 1;
  if (when === "AMC") return 2;
  return 3;
}

function headlineSortValue(row: HeadlineRow, column: string): string {
  if (column === "time") return row.publishedAt;
  if (column === "source") return row.source;
  return row.title;
}

function releaseSortValue(row: ReleaseRow, column: string): string {
  if (column === "time") return row.when;
  if (column === "country") return row.country;
  return row.title;
}

function earningsSortValue(row: EarningsRow, column: string): string | number | null {
  if (column === "when") return row.rank;
  if (column === "ticker") return row.symbol;
  if (column === "eps") return row.epsEstimate;
  if (column === "sales") return row.revenueEstimate;
  return row.company;
}

function scopeRows<T extends { id: string }>(sectionId: string, rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row, id: `${sectionId}:${row.id}` }));
}

function pricedMeeting(payload: RatePathPayload, today: string): { date: string; step: number } | null {
  const moves = meetingMoves(payload.meetings);
  for (const meeting of [...payload.meetings].sort((a, b) => a.date.localeCompare(b.date))) {
    if (meeting.date < today) continue;
    const step = moves.get(meeting.date);
    if (step == null) continue;
    return { date: meeting.date, step };
  }
  return null;
}

function eventParts(label: string, symbol: string | null): { country: string; title: string } {
  if (symbol) return { country: "", title: label };
  const space = label.indexOf(" ");
  if (space <= 0) return { country: "", title: label };
  return { country: label.slice(0, space), title: label.slice(space + 1) };
}

function ordered<T>(rows: readonly T[], sort: SortPreference<string>, value: (row: T, columnId: string) => string | number | null): T[] {
  if (!sort.columnId) return [...rows];
  const columnId = sort.columnId;
  return [...rows].sort((left, right) => compareSortValues(value(left, columnId), value(right, columnId), sort.direction));
}

function finiteQuotePrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The session print. An extended-hours field that is not a real price falls back to the quote's own last. */
function quoteLast(quote: Quote | null | undefined): { last: number | null; changePercent: number | null } {
  const display = getActiveQuoteDisplay(quote);
  const shown = display?.price;
  const own = quote?.price;
  const last = finiteQuotePrice(shown) ? shown : finiteQuotePrice(own) ? own : null;
  const shownChange = display?.changePercent;
  const ownChange = quote?.changePercent;
  const change = finiteQuotePrice(shownChange) ? shownChange : finiteQuotePrice(ownChange) ? ownChange : null;
  return { last, changePercent: last == null ? null : change };
}

function priceStat(id: string, label: string, last: number | null, change: number | null): StatItem {
  return {
    id,
    label,
    value: last == null ? "--" : formatNumber(last),
    detail: change == null ? undefined : formatPercentRaw(change),
    tone: change == null || change === 0 ? "neutral" : change > 0 ? "positive" : "negative",
  };
}

function placeholderCell(row: BriefTableRow, columnId: string, textColumn: string, text: string, color: string): DataTableCell | null {
  if (!row.placeholder) return null;
  return columnId === textColumn ? { text, color } : EMPTY_TABLE_CELL;
}

export function DailyBriefPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const { navigateTicker } = usePluginTickerActions();
  const [now, setNow] = useState(() => Date.now());
  const [chartToken, setChartToken] = useState(0);
  const [sorts, setSorts] = useState<Record<string, SortPreference<string>>>({});
  const [viewLines, setViewLines] = useState<Record<string, BriefViewLine[]>>({});
  const [viewErrors, setViewErrors] = useState<Record<string, string>>({});
  const [storedSections] = usePluginConfigState<unknown>(BRIEF_SECTIONS_SETTING, "");
  const recentTickers = useAppSelector((state: any) => state?.recentTickers ?? []);
  const recentCommands = useAppSelector((state: any) => state?.recentCommands ?? []);
  const paneIds = useAppSelector((state: any) => (state?.config?.layout?.instances ?? []).map((i: any) => i?.paneId).filter(Boolean));
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const rowAt = useRef(new Map<string, number>());
  const board = useQuoteBoard(BRIEF_SYMBOLS);
  const news = useNewsArticles(NEWS_QUERY_PRESETS.top);
  const loadStory = useLoadNewsStory();
  const { detailArticle, openArticle, closeDetail } = useNewsArticleDetail(news.articles, loadStory, `${PANE_KEY}:article`);
  const loadEarnings = useCallback((force: boolean) => loadEarningsBoard(earningsQuery(), force), []);
  const earnings = useAsyncResource(loadEarnings, { initialData: () => cachedEarningsCalendar(earningsQuery()) });
  const loadEcon = useCallback((force: boolean) => loadCalendar(force), []);
  const econ = useAsyncResource<EconCalendarLoadResult>(loadEcon, { initialData: getCalendarCache });
  const fear = useAsyncResource<FearGreedLoadResult>(loadFearGreed, { initialData: getCachedFearGreedData });
  const rates = useAsyncResource(loadRatePath, { initialData: getCachedRatePath });
  const loadYields = useCallback((force: boolean) => loadBriefYields(force), []);
  const yields = useAsyncResource(loadYields, { initialData: getCachedBriefYields });
  const provider = useMarketData();
  const loadMarks = useCallback(async () => {
    if (!provider) return new Map<string, SessionMark>();
    const end = Date.now();
    return loadBriefMarks(provider, esChartStart(end), end);
  }, [provider]);
  const marks = useAsyncResource(provider ? loadMarks : null, { keepPreviousData: true });

  const reload = useCallback(() => {
    setNow(Date.now());
    setChartToken((token) => token + 1);
    void earnings.reload();
    void econ.reload();
    void fear.reload();
    void rates.reload();
    void yields.reload();
    void marks.reload();
    board.refresh();
    void getSharedNewsService()?.load(NEWS_QUERY_PRESETS.top);
  }, [board.refresh, earnings.reload, econ.reload, fear.reload, marks.reload, rates.reload, yields.reload]);
  usePaneRefreshKey(reload, { focused });
  const refreshEarnings = useCallback(() => {
    setNow(Date.now());
    void earnings.reload();
  }, [earnings.reload]);
  useAutoRefresh(earnings.updatedAt, refreshEarnings);
  useAutoRefresh(econ.updatedAt, () => { void econ.reload(); });
  useAutoRefresh(fear.updatedAt, () => { void fear.reload(); });
  useAutoRefresh(rates.updatedAt, () => { void rates.reload(); });
  useAutoRefresh(yields.updatedAt, () => { void yields.reload(); });
  useAutoRefresh(marks.updatedAt, () => { void marks.reload(); });

  const shownQuotes = useMemo(() => {
    const quotes = new Map<string, { last: number | null; changePercent: number | null }>();
    for (const symbol of BRIEF_SYMBOLS) {
      quotes.set(symbol, quoteLast(board.quotes.get(symbol)?.quote));
    }
    for (const [symbol, mark] of marks.data ?? []) {
      const current = quotes.get(symbol);
      if (current?.last == null) quotes.set(symbol, mark);
    }
    return quotes;
  }, [board.quotes, marks.data]);

  const brief = useMemo(() => assembleBrief({
    now,
    quotes: shownQuotes,
    articles: news.articles,
    earnings: earnings.data?.payload.reports ?? [],
    econ: econ.data?.data ?? [],
    fetchedAt: [
      quoteBoardStatus(board.quotes).latestTs || null,
      news.updatedAt,
      earnings.data?.payload.asOf,
      econ.data?.fetchedAt,
      fear.data?.fetchedAt,
      rates.data?.fetchedAt,
      yields.data?.fetchedAt,
    ],
  }), [earnings.data, econ.data, fear.data, news.articles, news.updatedAt, now, rates.data, shownQuotes, yields.data]);

  const onSort = useCallback((table: string, columnId: string) => {
    setSorts((current) => {
      const prev = current[table] ?? UNSORTED;
      return { ...current, [table]: nextHeaderSort(prev, columnId, { resetTo: UNSORTED }) };
    });
  }, []);
  const onViewLines = useCallback((id: string, next: BriefViewLine[], error: string | null) => {
    const text = error?.trim() || null;
    setViewLines((current) => {
      if (next.length === 0) {
        if (!(id in current)) return current;
        const rest = { ...current };
        delete rest[id];
        return rest;
      }
      const prev = current[id];
      if (
        prev
        && prev.length === next.length
        && prev.every((line, index) => {
          const other = next[index];
          return !!other
            && line.id === other.id
            && line.symbol === other.symbol
            && line.url === other.url
            && line.articleId === other.articleId
            && line.placeholder === other.placeholder;
        })
      ) return current;
      return { ...current, [id]: next };
    });
    setViewErrors((current) => {
      if ((current[id] ?? null) === text) return current;
      if (!text) {
        const rest = { ...current };
        delete rest[id];
        return rest;
      }
      return { ...current, [id]: text };
    });
  }, []);

  const parsedSections = useMemo(() => parseBriefSections(storedSections), [storedSections]);
  const profile = useMemo(() => buildBriefProfile({ recentTickers, recentCommands, layout: { instances: paneIds.map((id: string) => ({ paneId: id })) } } as any), [recentTickers, recentCommands, paneIds]);
  const layout = "layout" in parsedSections ? parsedSections.layout : defaultBriefLayout(profile);
  const sectionsError = "error" in parsedSections ? parsedSections.error : null;

  const headlineBase = useMemo<HeadlineRow[]>(() => {
    const rows = brief.headlines.map((headline) => ({
      kind: "headline" as const,
      id: headline.articleId,
      articleId: headline.articleId,
      publishedAt: headline.publishedAt,
      source: headline.source,
      title: headline.title,
    }));
    if (rows.length > 0) return rows;
    return news.phase === "ready" || news.phase === "error"
      ? [{ kind: "headline" as const, id: "empty", articleId: "", placeholder: true, publishedAt: "", source: "", title: "No headlines." }]
      : [];
  }, [brief.headlines, news.phase]);

  const releaseBase = useMemo<ReleaseRow[]>(() => {
    const rows = brief.events.flatMap((event) => {
      if (event.symbol) return [];
      const parts = eventParts(event.label, null);
      return [{ kind: "release" as const, id: event.id, when: eventWhen(event.at), country: parts.country, title: parts.title }];
    });
    if (rows.length > 0) return rows;
    return !earnings.loading && !econ.loading
      ? [{ kind: "release" as const, id: "empty", placeholder: true, when: "", country: "", title: "No releases today." }]
      : [];
  }, [brief.events, earnings.loading, econ.loading]);

  const earningsBase = useMemo<EarningsRow[]>(() => brief.events.flatMap((event) => {
    if (!event.symbol) return [];
    const when = eventWhen(event.at);
    return [{
      kind: "earnings" as const,
      id: event.id,
      when,
      symbol: event.symbol,
      company: event.name ?? "",
      rank: whenRank(when),
      epsEstimate: event.epsEstimate,
      revenueEstimate: event.revenueEstimate,
    }];
  }), [brief.events]);

  const tables = useMemo((): BriefTableBlock[] => layout.sections.map((section) => {
    if (section.kind === "view") {
      return { builtin: "view", section, items: viewLines[section.id] ?? [] };
    }
    const sort = sorts[section.id] ?? UNSORTED;
    if (section.builtin === "headlines") {
      return { builtin: "headlines", section, items: scopeRows(section.id, ordered(headlineBase, sort, headlineSortValue)) };
    }
    if (section.builtin === "today") {
      return { builtin: "today", section, items: scopeRows(section.id, ordered(releaseBase, sort, releaseSortValue)) };
    }
    return { builtin: "earnings", section, items: scopeRows(section.id, ordered(earningsBase, sort, earningsSortValue)) };
  }), [earningsBase, headlineBase, layout.sections, releaseBase, sorts, viewLines]);

  const lines = useMemo(
    () => tables.flatMap((table) => table.items.filter((row) => !row.placeholder)),
    [tables],
  );

  useEffect(() => {
    if (lines.length === 0) return;
    if (!lines.some((line) => line.id === selectedId)) setSelectedId(lines[0]!.id);
  }, [lines, selectedId, setSelectedId]);
  const selected = lines.find((line) => line.id === selectedId) ?? lines[0] ?? null;

  const articles = useMemo(() => new Map(news.articles.map((article) => [article.id, article])), [news.articles]);
  const openLine = useCallback((line: NavLine) => {
    if (line.placeholder) return;
    setSelectedId(line.id);
    if (line.kind === "headline") {
      const article = line.articleId ? articles.get(line.articleId) : undefined;
      if (article) openArticle(article);
      return;
    }
    if (line.kind === "earnings") {
      navigateTicker(line.symbol);
      return;
    }
    if (line.kind !== "view") return;
    const article = line.articleId ? articles.get(line.articleId) : undefined;
    if (article) {
      openArticle(article);
      return;
    }
    if (line.symbol) {
      navigateTicker(line.symbol);
      return;
    }
    if (line.url) openUrl(line.url);
  }, [articles, navigateTicker, openArticle, setSelectedId]);

  const quoteStatus = quoteBoardStatus(board.quotes);
  const loading = earnings.loading || econ.loading || fear.loading || rates.loading
    || marks.loading
    || news.phase === "loading" || news.phase === "refreshing"
    || quoteStatus.loading > 0;
  const hasPaint = brief.markets.some((row) => row.last != null)
    || news.articles.length > 0
    || earnings.data != null
    || econ.data != null;
  const failure = earnings.error ?? econ.error ?? news.error ?? boardErrorMessage(board.quotes);
  const stale = quoteStatus.stale > 0 || !!earnings.data?.stale || !!econ.data?.stale || !!yields.data?.stale;
  const selectedHeadline = selected?.kind === "headline" && !selected.placeholder ? selected : null;
  const selectedView = selected?.kind === "view" && !selected.placeholder ? selected : null;
  const link = detailArticle
    ? { url: detailArticle.url, source: detailArticle.source }
    : selectedHeadline
      ? {
        url: brief.headlines.find((headline) => headline.articleId === selectedHeadline.articleId)?.url ?? null,
        source: selectedHeadline.source,
      }
      : { url: selectedView?.url ?? null, source: null };
  const asOf = brief.asOf ? briefFooterInfo({ asOf: brief.asOf }) : "";
  const info = useMemo(
    () => asOf && asOf !== "Live" ? [{ id: "asof", parts: [{ text: asOf, tone: "muted" as const }] }] : [],
    [asOf],
  );
  usePaneStatusLinkFooter({
    registrationId: PANE_KEY,
    focused,
    url: link.url,
    source: link.source,
    label: "story",
    loading,
    stale,
    info,
    showOpenHint: !!link.url,
  });
  usePaneNoticeFooter({
    registrationId: `${PANE_KEY}:notices`,
    focused,
    notices: hasPaint ? noticeList([
      earnings.error,
      earnings.data?.refreshError,
      econ.error,
      econ.data?.refreshError,
      fear.error,
      fear.data?.refreshError,
      rates.error,
      yields.error,
      ...(yields.data?.errors ?? []),
      news.error,
      boardErrorMessage(board.quotes),
      sectionsError,
      ...Object.values(viewErrors),
    ]) : [],
  });

  const mood = fear.data?.data.overall ?? null;
  const meeting = rates.data ? pricedMeeting(rates.data, brief.session.date) : null;
  const vix = shownQuotes.get(BRIEF_VIX);
  const yieldRows = yields.data?.rows ?? BRIEF_YIELDS.map((row) => ({ id: row.id, label: row.label, level: null }));
  const stats: StatItem[] = [
    ...brief.markets.map((row) => priceStat(row.symbol, row.label, row.last, row.changePercent)),
    ...yieldRows.map(yieldStat),
    {
      id: "fng",
      label: "FNG",
      value: mood ? formatScore(mood.score) : "--",
      detail: mood ? ratingLabel(mood.rating) : undefined,
      tone: mood ? ratingTrend(mood.rating) : "neutral",
    },
    priceStat(BRIEF_VIX, "VIX", vix?.last ?? null, vix?.changePercent ?? null),
    {
      id: "fomc",
      label: "FOMC",
      value: meeting ? moveOddsText(meeting.step) : "--",
      detail: meeting ? meetingLabel(meeting.date) : undefined,
    },
  ];
  const chartHeight = esChartHeight(height);
  const columns = useMemo(() => ({
    headlines: headlineColumns(width),
    today: releaseColumns(width),
    earnings: earningsColumns(width),
  }), [width]);

  const positions = new Map<string, number>();
  let row = statGridRows(stats, width, 3) + chartHeight;
  for (const table of tables) {
    if (table.items.length === 0) continue;
    row += 1;
    table.items.forEach((item, index) => positions.set(item.id, row + 1 + index));
    row += 1 + table.items.length;
  }
  rowAt.current = positions;

  const reveal = useCallback((id: string) => {
    const at = rowAt.current.get(id);
    const box = scrollRef.current;
    if (at == null || !box) return;
    const top = box.scrollTop ?? 0;
    const view = Math.max(1, height);
    if (at < top) box.scrollTo(at);
    else if (at >= top + view) box.scrollTo(Math.max(0, at - view + 1));
  }, [height]);

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable || lines.length === 0) return;
    const down = isPlainKey(event, "j", "down");
    const up = isPlainKey(event, "k", "up");
    const activate = event.name === "enter" || event.name === "return";
    if (!down && !up && !activate) return;
    event.preventDefault();
    event.stopPropagation();
    if (activate) {
      if (selected) openLine(selected);
      return;
    }
    const current = lines.findIndex((line) => line.id === selected?.id);
    const origin = current < 0 ? 0 : current;
    const next = lines[Math.max(0, Math.min(lines.length - 1, origin + (down ? 1 : -1)))];
    if (!next) return;
    reveal(next.id);
    if (next.id !== selected?.id) setSelectedId(next.id);
  }, { enabled: focused && !detailArticle });

  const renderHeadline = useCallback((row: HeadlineRow, column: DataTableColumn): DataTableCell => {
    const empty = placeholderCell(row, column.id, "title", row.title, colors.textDim);
    if (empty) return empty;
    if (column.id === "time") return { text: formatFeedTime(row.publishedAt, now), color: colors.textDim };
    if (column.id === "source") return { text: row.source, color: colors.textMuted };
    return { text: row.title, color: colors.text, attributes: TextAttributes.BOLD };
  }, [colors, now]);

  const renderRelease = useCallback((row: ReleaseRow, column: DataTableColumn): DataTableCell => {
    const empty = placeholderCell(row, column.id, "event", row.title, colors.textDim);
    if (empty) return empty;
    if (column.id === "time") return { text: row.when, color: colors.textDim };
    if (column.id === "country") return { text: row.country, color: colors.textMuted };
    return { text: row.title, color: colors.text };
  }, [colors]);

  const renderEarnings = useCallback((row: EarningsRow, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (column.id === "when") return { text: row.when, color: colors.textDim };
    if (column.id === "ticker") return listingCell(row.symbol, colors, state.selected);
    if (column.id === "eps") return { text: epsText(row.epsEstimate), color: colors.textDim };
    if (column.id === "sales") return { text: moneyText(row.revenueEstimate), color: colors.textDim };
    return row.company ? { text: row.company, color: colors.text } : EMPTY_TABLE_CELL;
  }, [colors]);

  if (!hasPaint && (loading || failure)) {
    return (
      <PaneStatusBody
        loading={loading}
        error={loading ? null : failure}
        subject="the daily brief"
        width={width}
        height={height}
      />
    );
  }

  const tableFocused = focused && !detailArticle;

  return (
    <Box width={width} height={height} flexDirection="column">
      <PageStackView
        focused={focused}
        detailOpen={!!detailArticle}
        onBack={closeDetail}
        detailTitle={detailArticle?.title}
        detailContent={detailArticle ? (
          <NewsDetailView item={detailArticle} focused={focused} width={width} showTitle={false} />
        ) : null}
        rootContent={(
          <ScrollBox ref={scrollRef} width={width} height={height} flexDirection="column" scrollY focusable={false}>
            <StatGrid items={stats} width={width} columns={3} />
            <EsSessionChart width={width} height={chartHeight} focused={tableFocused} now={now} reloadToken={chartToken} />
            {tables.map((table) => {
              if (table.builtin === "view") {
                const sort = sorts[table.section.id] ?? UNSORTED;
                return (
                  <BriefViewBlock
                    key={table.section.id}
                    section={table.section}
                    width={width}
                    focused={tableFocused}
                    selectedId={selected?.id ?? null}
                    reloadToken={chartToken}
                    sort={sort}
                    onSelect={setSelectedId}
                    onActivate={openLine}
                    onHeaderClick={(columnId) => onSort(table.section.id, columnId)}
                    onLines={onViewLines}
                  />
                );
              }
              const sort = sorts[table.section.id] ?? UNSORTED;
              const shared = {
                label: briefSectionTitle(table.section),
                count: table.items.filter((item) => !item.placeholder).length,
                width,
                focused: tableFocused,
                selectedId: selected?.id ?? null,
                onSelect: setSelectedId,
                onActivate: openLine,
                sortColumnId: sort.columnId,
                sortDirection: sort.direction,
                onHeaderClick: (columnId: string) => onSort(table.section.id, columnId),
              };
              if (table.builtin === "headlines") {
                return (
                  <BriefTable
                    key={table.section.id}
                    {...shared}
                    columns={columns.headlines}
                    items={table.items}
                    renderCell={renderHeadline}
                  />
                );
              }
              if (table.builtin === "today") {
                return (
                  <BriefTable
                    key={table.section.id}
                    {...shared}
                    columns={columns.today}
                    items={table.items}
                    renderCell={renderRelease}
                  />
                );
              }
              return (
                <BriefTable
                  key={table.section.id}
                  {...shared}
                  columns={columns.earnings}
                  items={table.items}
                  renderCell={renderEarnings}
                />
              );
            })}
          </ScrollBox>
        )}
      />
    </Box>
  );
}
