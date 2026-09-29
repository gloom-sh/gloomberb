import { useCallback, useEffect, useMemo } from "react";
import { listingIdentity } from "../shared/ticker-request";
import { Box, ScrollBox, Text, useUiCapabilities } from "../../../ui";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useShortcut, useUpdatedAgo } from "../../../public/react";
import { CompositeChart, DataTableStackView, EmptyState, PaneStatusBody, usePaneNoticeFooter, usePaneStatusLinkFooter, type DataTableCell, StatGrid } from "../../../components";
import { colors } from "../../../theme/colors";
import type { SocialMentionPost, SocialMentionsRange } from "../../../api-client/social-mentions";
import { ApiRequestError } from "../../../api-client/errors";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { cachedSocialMentions, loadSocialMentionPosts, loadSocialMentions } from "./client";
import { SOCIAL_COLUMNS, socialChartPoints, socialCount, socialDayRows, socialRatio, socialStance, socialSummary, sortedSocialRows, stanceWord, topPostCell, type SocialColumn, type SocialDayRow, type SocialSort } from "./model";

const PANELS = [{ id: "main" }];
const WITH_WIKI_PANELS = [{ id: "main", height: 2 }, { id: "wiki", height: 1 }];
const PENDING_RETRY_MS = 5_000;
const clearDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
const stanceColor = (value: number | null) => value == null ? colors.textMuted : value >= .15 ? colors.positive : value <= -.15 ? colors.negative : colors.text;
const RANGES: SocialMentionsRange[] = ["1y", "5y", "max"];

function renderCell(row: SocialDayRow, column: SocialColumn, _index: number, state: { selected: boolean }): DataTableCell {
  const text = column.id === "day" ? row.day : column.id === "mentions" ? socialCount(row.mentions)
    : column.id === "ratio" ? socialRatio(row.ratio) : column.id === "wikiViews" ? socialCount(row.wikiViews)
      : column.id === "redditMentions" ? socialCount(row.redditMentions)
      : column.id === "stance" ? socialStance(row.stance) : topPostCell(row.topPost);
  if (state.selected) return { text, color: colors.selectedText };
  return { text, color: column.id === "stance" ? stanceColor(row.stance)
    : column.id === "ratio" && (row.ratio ?? 0) >= 2.5 ? colors.warning
      : column.id === "topPost" || column.id === "wikiViews" || column.id === "redditMentions" || !row.closed ? colors.textMuted : colors.text };
}

function PostBlock({ post, width }: { post: SocialMentionPost; width: number }) {
  return <Box flexDirection="column" width={width}>
    <Box flexDirection="row" gap={2}>
      <Text fg={colors.text} wrapMode="none" truncate flexShrink={1} minWidth={0}>@{post.author}</Text>
      <Text fg={colors.textMuted} wrapMode="none">{post.views == null ? `${socialCount(post.likes)} likes` : `${socialCount(post.views)} views`}</Text>
      <Text fg={stanceColor(post.stance)} wrapMode="none">{socialStance(post.stance)}</Text>
    </Box>
    <Text fg={colors.textMuted} width={width} wrapMode="word" wrapText>{post.text.replace(/\s+\n/g, "\n").trim()}</Text>
  </Box>;
}

function DayDetail({ symbol, row, recent, width, height }: {
  symbol: string; row: SocialDayRow; recent: SocialMentionPost[]; width: number; height: number;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  // Today is still open on the server; its posts come with the history.
  const loader = useCallback(() => loadSocialMentionPosts(symbol, row.day), [symbol, row.day]);
  const posts = useAsyncResource(row.closed ? loader : null);
  const list = (row.closed ? posts.data : null) ?? recent.filter((post) => post.day === row.day);
  const lineWidth = Math.max(1, width - 2);
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
    <StatGrid width={width} items={[
      { id: "posts", label: "Posts", value: socialCount(row.mentions), detail: row.closed ? undefined : "so far" },
      { id: "ratio", label: "Vs median", value: socialRatio(row.ratio) },
      { id: "stance", label: "Stance", value: socialStance(row.stance), detail: stanceWord(row.stance) },
    ]} />
    <ScrollBox width={width} height={nativePaneChrome ? undefined : Math.max(1, height - 3)} flexGrow={1} flexBasis={0} minHeight={0} contentOptions={{ paddingX: 1 }}>
      <PaneStatusBody loading={posts.loading && !list.length} error={!list.length ? posts.error : null} subject="top posts"
        empty={!posts.loading && !list.length} emptyTitle="No top posts for this day.">
        <Box flexDirection="column" gap={1} width={lineWidth}>
          {list.map((post) => <PostBlock key={post.id} post={post} width={lineWidth} />)}
        </Box>
      </PaneStatusBody>
    </ScrollBox>
  </Box>;
}

export function SocialMentionsPane({ width, height, focused }: Pick<PaneProps, "width" | "height" | "focused">) {
  const { ticker } = usePaneTickerIdentity();
  const [rangeValue] = usePaneSettingValue("socialRange", "1y");
  const range: SocialMentionsRange = RANGES.includes(rangeValue as SocialMentionsRange) ? rangeValue as SocialMentionsRange : "1y";
  const listing = listingIdentity(ticker?.metadata.ticker);
  const symbol = listing?.symbol && /^[A-Z][A-Z0-9]{0,5}$/.test(listing.symbol) ? listing.symbol : null;
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadSocialMentions(symbol!, range, force), [symbol, range, session.requestKey]);
  const resource = useAsyncResource(symbol ? loader : null, {
    initialData: () => symbol ? cachedSocialMentions(symbol, range) : null, clearOnError: clearDenied,
  });
  const data = resource.data?.payload;
  const identity = `${range}:${symbol}`;
  const [sort, setSort] = usePluginPaneState<SocialSort>("social-mentions:sort", { column: "day", direction: "desc" });
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("social-mentions:selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("social-mentions:open", null);
  const rowKey = (row: SocialDayRow) => `${identity}:${row.day}`;
  const allRows = useMemo(() => data ? socialDayRows(data) : [], [data]);
  const rows = useMemo(() => sortedSocialRows(allRows, sort), [allRows, sort]);
  const summary = useMemo(() => data ? socialSummary(data, allRows) : null, [data, allRows]);
  const selectedIndex = Math.max(0, rows.findIndex((row) => rowKey(row) === selectedId));
  const openRow = rows.find((row) => rowKey(row) === openId);
  const selected = openRow ?? rows[selectedIndex];
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const hasWiki = allRows.some((row) => row.wikiViews !== null);
  const series = useMemo(() => [
    staticSeries(socialChartPoints(allRows), { id: "x-posts", label: "Posts on X", color: colors.warning, style: "columns", calendarSpaced: true }),
    ...(hasWiki ? [{ ...staticSeries(socialChartPoints(allRows, (row) => row.wikiViews), {
      id: "wiki-views", label: "Wikipedia views", color: colors.borderFocused, calendarSpaced: true }), panelId: "wiki" }] : []),
  ], [allRows, hasWiki]);
  const chartHeight = height >= 16 ? Math.max(5, Math.min(12, Math.floor(height * .38))) : 0;
  // The server is still filling history or posts; ask again until it is done.
  const pending = !!data?.pending.length;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void resource.reload(), PENDING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [pending, resource.updatedAt, resource.reload]);
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => { if (focused && isPlainKey(event, "r")) { event.preventDefault(); void resource.reload(); } });
  usePaneNoticeFooter({ registrationId: "social-mentions:notices", focused,
    notices: [...(data?.warnings ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusLinkFooter({ registrationId: "social-mentions", focused, loading: resource.loading || pending, error: resource.error,
    url: selected?.topPost?.url ?? (symbol ? `https://x.com/search?q=%24${symbol}` : null), showOpenHint: true,
    info: data ? [
      ...(updatedAgo ? [{ id: "updated", parts: [{ text: updatedAgo, tone: "muted" as const }] }] : []),
      ...(resource.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ] : [],
  });
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view social mentions" needsVerification={session.needsVerification} />;
  if (!listing?.symbol) return <EmptyState title="No ticker selected." message="Select a ticker to view social mentions." />;
  if (!symbol) return <EmptyState title="This ticker cannot be searched as a cashtag." message="Use a symbol of up to six letters and digits, starting with a letter." />;
  const latest = summary?.latest ?? null;
  return <Box flexDirection="column" width={width} height={height}>
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} subject="social mentions"
      empty={!resource.loading && !resource.error && !!data && !data.x.days.length && !pending} emptyTitle="No mention history yet.">
      {data ? <DataTableStackView<SocialDayRow, SocialColumn>
        focused={focused} rootWidth={width} rootHeight={height} emptyStateTitle="Counting mentions." columns={SOCIAL_COLUMNS} items={rows} freezeFirstColumn
        getItemKey={rowKey} renderCell={renderCell} resetScrollKey={identity}
        selection={{ kind: "index", selectedIndex: rows.length ? selectedIndex : -1, onChange: (index) => setSelectedId(rows[index] ? rowKey(rows[index]!) : null) }}
        onActivate={(row) => setOpenId(rowKey(row))} detailOpen={!!openRow} onBack={() => setOpenId(null)}
        detailTitle={openRow?.day} detailContent={openRow ? <DayDetail symbol={symbol} row={openRow} recent={data.topPosts} width={width} height={Math.max(3, height - 2)} /> : null}
        sortColumnId={sort.column} sortDirection={sort.direction}
        onHeaderClick={(column) => setSort((current) => ({ column: column as SocialSort["column"], direction: current.column === column && current.direction === "desc" ? "asc" : "desc" }))}
        rootBefore={<Box flexDirection="column" flexShrink={0}>
          <StatGrid width={width} items={[
            { id: "posts", label: "Posts", value: socialCount(latest?.mentions), detail: latest ? `${socialRatio(latest.ratio)} median · ${latest.day.slice(5)}` : undefined },
            { id: "median", label: "30D median", value: socialCount(data.x.baseline) },
            { id: "stance", label: "Stance 7D", value: socialStance(summary?.stance ?? null), detail: stanceWord(summary?.stance ?? null) },
            { id: "peak", label: `Peak ${range === "max" ? "all" : range.toUpperCase()}`, value: socialCount(summary?.peak?.mentions), detail: summary?.peak?.day },
            ...(summary?.wiki ? [{ id: "wiki", label: "Wiki views", value: socialCount(summary.wiki.views),
              detail: `${socialRatio(summary.wiki.ratio)} median · ${summary.wiki.day.slice(5)}` }] : []),
            ...(summary?.reddit ? [{ id: "reddit", label: "Reddit", value: socialCount(summary.reddit.mentions),
              detail: `${socialRatio(summary.reddit.ratio)} median · ${summary.reddit.day.slice(5)}` }] : []),
          ]} />
          {chartHeight && allRows.length ? <Box paddingX={1} flexShrink={0}>
            <CompositeChart series={series} panels={hasWiki ? WITH_WIKI_PANELS : PANELS} width={Math.max(1, width - 2)} height={chartHeight} focused={focused && !openRow} showLegend={hasWiki} showTimeAxis navigable={false}
              formatAxisValue={(value) => socialCount(value)} remoteKind="social-mentions-history" />
          </Box> : null}
        </Box>}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
