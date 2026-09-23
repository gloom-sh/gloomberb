import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, ScrollBox, TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import {
  ChoiceDialog,
  DataTableStackView,
  PaneStatusBody,
  StatGrid,
  TickerBadgeList,
  openUrl,
  useTableLoadMore,
  type ChoiceDialogChoice,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneHint,
  type StatItem,
} from "../../../components";
import { TickerBadgeText } from "../../../components/ticker/badge/text";
import { RemoteImage, PaneLinkMenu } from "../../../components/ui";
import { useInlineTickerOpener, useInlineTickers } from "../../../state/hooks/inline-tickers";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import type { CloudTweetPayload, CloudTweetSearchResponse } from "../../../api-client";
import { formatTimeAgo } from "../../../utils/format";
import { tokenizeInlineContent } from "../../../utils/inline-content-tokenizer";
import { isPlainKey } from "../../../utils/keyboard";
import { colors } from "../../../theme/colors";
import { SignInWall } from "../cloud/auth-actions";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import {
  appendNewTweets,
  mergeLatestTweets,
  buildTweetColumns,
  formatMetric,
  formatRelativeShort,
  isTweetSortColumnId,
  normalizeTwitterUsername,
  normalizeTweetCellText,
  normalizeTweetDisplayText,
  sortedTweets,
  tweetImageUrls,
  tweetTickers,
  twitterUserSearchQuery,
  type TweetColumn,
  type TweetLoadState,
  type TweetSortColumnId,
  type TweetSortDirection,
} from "./model";
import { useAutoRefresh } from "../shared/auto-refresh";
import { usePaneStatusLinkFooter } from "../shared/pane-footer";

function isAuthError(error: string | null): boolean {
  return !!error && /unauthorized|verification/i.test(error);
}

// Result rows only lived in table state, so switching feed tabs refetched an
// identical search. Cached per request key for the life of the process; `r`
// still forces a fresh search.
// ponytail: in-memory only, move to plugin state if results must survive restarts
const TWEET_RESULT_CACHE = new Map<string, { data: CloudTweetSearchResponse; fetchedAt: number; hasMore: boolean }>();
const TWEET_CACHE_TTL_MS = 5 * 60 * 1000;
/** Matches the server's search cache, so a visible pane never asks for a result it cannot get. */
const TWEET_REFRESH_MS = 2 * 60 * 1000;
// Every edited query is its own key, so the map is capped instead of growing
// with each keystroke-sized search.
const TWEET_CACHE_MAX_ENTRIES = 20;

function cacheTweetResult(requestKey: string, data: CloudTweetSearchResponse, hasMore: boolean): void {
  TWEET_RESULT_CACHE.set(requestKey, { data, fetchedAt: Date.now(), hasMore });
  while (TWEET_RESULT_CACHE.size > TWEET_CACHE_MAX_ENTRIES) {
    const oldest = TWEET_RESULT_CACHE.keys().next().value;
    if (oldest === undefined) break;
    TWEET_RESULT_CACHE.delete(oldest);
  }
}

function cachedTweetResult(requestKey: string) {
  return TWEET_RESULT_CACHE.get(requestKey);
}

/** Pane state key for whether a table's tweet detail is open. */
export function tweetDetailStateKey(footerId: string): string {
  return `${footerId}:detailOpen`;
}

type TweetLink =
  | { kind: "ticker"; symbol: string }
  | { kind: "username"; username: string }
  | { kind: "link"; url: string };

/**
 * What a click can open in a tweet, for the keyboard: its author's feed, the
 * tickers it tags, the accounts it mentions and the links in its text.
 */
function tweetLinks(tweet: CloudTweetPayload): TweetLink[] {
  const links: TweetLink[] = [];
  const seen = new Set<string>();
  const add = (key: string, link: TweetLink) => {
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };
  const author = normalizeTwitterUsername(tweet.author.userName);
  if (author) add(`@${author.toLowerCase()}`, { kind: "username", username: author });
  for (const symbol of tweetTickers(tweet)) add(`$${symbol}`, { kind: "ticker", symbol });
  for (const token of tokenizeInlineContent(normalizeTweetDisplayText(tweet.text))) {
    if (token.kind === "ticker") add(`$${token.symbol}`, { kind: "ticker", symbol: token.symbol });
    else if (token.kind === "username") {
      const username = normalizeTwitterUsername(token.username);
      if (username) add(`@${username.toLowerCase()}`, { kind: "username", username });
    } else if (token.kind === "link") add(token.url, { kind: "link", url: token.url });
  }
  return links;
}

function tweetLinkChoice(link: TweetLink, index: number): ChoiceDialogChoice {
  const id = String(index);
  if (link.kind === "ticker") return { id, label: `$${link.symbol}`, description: "Open ticker" };
  if (link.kind === "username") return { id, label: `@${link.username}`, description: "Open their X feed" };
  return { id, label: link.url, description: "Open link" };
}

function TweetDetail({
  tweet,
  width,
  onOpenUsername,
}: {
  tweet: CloudTweetPayload;
  width: number;
  onOpenUsername: (username: string) => void;
}) {
  const lineWidth = Math.max(1, width - 2);
  const tweetText = normalizeTweetDisplayText(tweet.text);
  const imageUrls = tweetImageUrls(tweet);
  const imageWidth = Math.min(lineWidth, 72);
  const imageHeight = Math.max(6, Math.min(14, Math.floor(imageWidth * 0.35)));
  const { catalog, openTicker } = useInlineTickers([tweetText], { badgeQuotes: true });

  const metrics: StatItem[] = [
    { id: "likes", label: "Likes", value: formatMetric(tweet.metrics.likes) },
    { id: "reposts", label: "Reposts", value: formatMetric(tweet.metrics.retweets) },
    { id: "replies", label: "Replies", value: formatMetric(tweet.metrics.replies) },
    { id: "views", label: "Views", value: formatMetric(tweet.metrics.views) },
  ];

  // The open tweet's tickers, mentions and links are pane menu entries too.
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
      <StatGrid items={metrics} width={width} />
      <ScrollBox scrollY focusable={false} flexGrow={1} flexBasis={0} minHeight={0} paddingX={1}>
        <PaneLinkMenu>
          <Box flexDirection="column" width={lineWidth} gap={1}>
            <TickerBadgeText
              text={tweetText}
              lineWidth={lineWidth}
              catalog={catalog}
              textColor={colors.text}
              openTicker={openTicker}
              openUsername={onOpenUsername}
            />
            {imageUrls.length > 0 ? (
              <Box flexDirection="column" gap={1}>
                {imageUrls.slice(0, 4).map((url, index) => (
                  <RemoteImage
                    key={url}
                    src={url}
                    alt={`Tweet image ${index + 1}`}
                    width={imageWidth}
                    height={imageHeight}
                    label={imageUrls.length > 1 ? `image ${index + 1}` : "image"}
                  />
                ))}
              </Box>
            ) : null}
          </Box>
        </PaneLinkMenu>
      </ScrollBox>
    </Box>
  );
}

function useTweetSearchData(
  requestKey: string,
  load: (offset: number) => Promise<CloudTweetSearchResponse>,
  onResult?: (result: CloudTweetSearchResponse) => void,
  onError?: (message: string) => void,
  enabled = true,
) {
  // Starts loading when a request is about to run so the first paint is not a
  // premature "No tweets".
  const [state, setState] = useState<TweetLoadState>(() => {
    const cached = cachedTweetResult(requestKey);
    return {
      data: cached?.data ?? null,
      loading: enabled && !cached,
      error: null,
      loadingMore: false,
      hasMore: cached?.hasMore ?? false,
    };
  });
  const fetchGenRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  const reload = useCallback((force = false) => {
    if (!enabled) {
      fetchGenRef.current += 1;
      setState((current) => (
        current.data || current.loading || current.error
          ? { data: null, loading: false, error: null, loadingMore: false, hasMore: false }
          : current
      ));
      return;
    }

    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    const cached = force ? undefined : cachedTweetResult(requestKey);
    const fresh = cached && Date.now() - cached.fetchedAt < TWEET_CACHE_TTL_MS;
    if (cached) {
      setState({ data: cached.data, loading: !fresh, error: null, loadingMore: false, hasMore: cached.hasMore });
    }
    if (fresh) return;
    // A forced reload keeps the rows on screen; a new request key must not show
    // the previous feed's tweets while its own search runs.
    if (!cached) {
      setState((current) => ({
        data: force ? current.data : null, loading: true, error: null, loadingMore: false, hasMore: false,
      }));
    }
    load(0)
      .then((data) => {
        const hasMore = data.hasMore === true;
        cacheTweetResult(requestKey, data, hasMore);
        if (fetchGenRef.current !== gen) return;
        setState({ data, loading: false, error: null, loadingMore: false, hasMore });
        onResultRef.current?.(data);
      })
      .catch((error) => {
        if (fetchGenRef.current !== gen) return;
        const message = error instanceof Error ? error.message : String(error);
        // A failed refresh keeps the tweets it had; the footer says it failed.
        setState((current) => ({ data: force || cached ? current.data : null, loading: false, error: message, loadingMore: false, hasMore: false }));
        onErrorRef.current?.(message);
      });
  }, [enabled, load, requestKey]);

  // Reading to the end of a feed asks for the tweets below it. The window the
  // server keeps is deeper than one page, and older ones are fetched on demand.
  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (!enabled || current.loading || current.loadingMore || !current.hasMore || !current.data) return;
    const gen = fetchGenRef.current;
    const offset = current.data.tweets.length;
    setState((value) => ({ ...value, loadingMore: true }));
    load(offset)
      .then((page) => {
        if (fetchGenRef.current !== gen) return;
        setState((value) => {
          if (!value.data) return { ...value, loadingMore: false };
          const tweets = appendNewTweets(value.data.tweets, page.tweets);
          // A server without paging answers the same page again. Repeating it
          // is the end of the feed, not a reason to keep asking.
          const hasMore = page.hasMore === true && tweets.length > value.data.tweets.length;
          const data = { ...value.data, tweets };
          cacheTweetResult(requestKey, data, hasMore);
          return { ...value, data, loadingMore: false, hasMore };
        });
      })
      .catch(() => {
        if (fetchGenRef.current !== gen) return;
        // The tweets already on screen are still the answer; a failed page just
        // ends the feed rather than replacing it with an error.
        setState((value) => ({ ...value, loadingMore: false, hasMore: false }));
      });
  }, [enabled, load, requestKey]);

  useEffect(() => {
    reload();
  }, [reload, requestKey]);

  // While the pane can be seen, the first page refreshes in the background and
  // merges in, so the reading position and older pages survive.
  const refreshLatest = useCallback(() => {
    const current = stateRef.current;
    if (!enabled || current.loading || current.loadingMore || !current.data) return;
    const gen = fetchGenRef.current;
    load(0)
      .then((page) => {
        if (fetchGenRef.current !== gen) return;
        setState((value) => {
          if (!value.data) return value;
          const data = { ...value.data, tweets: mergeLatestTweets(value.data.tweets, page.tweets) };
          cacheTweetResult(requestKey, data, value.hasMore);
          return { ...value, data };
        });
      })
      // The tweets on screen are still the answer; the next cycle tries again.
      .catch(() => {});
  }, [enabled, load, requestKey]);
  const fetchedAt = state.data ? cachedTweetResult(requestKey)?.fetchedAt ?? null : null;
  useAutoRefresh(fetchedAt, refreshLatest, { intervalMs: TWEET_REFRESH_MS });

  return { ...state, reload, loadMore };
}

export function TweetSearchTable({
  focused,
  width,
  height,
  requestKey,
  footerId,
  rootBefore,
  enabled = true,
  load,
  onResult,
  onError,
  onFocusSearch,
  emptyStateTitle,
  emptyStateHint,
}: {
  focused: boolean;
  width: number;
  height: number;
  requestKey: string;
  footerId: string;
  rootBefore?: ReactNode;
  enabled?: boolean;
  load: (offset: number) => Promise<CloudTweetSearchResponse>;
  onResult?: (result: CloudTweetSearchResponse) => void;
  onError?: (message: string) => void;
  onFocusSearch?: () => void;
  emptyStateTitle?: string;
  emptyStateHint?: string;
}) {
  const { createPaneFromTemplate } = usePluginAppActions();
  const { data, loading, error, loadingMore, hasMore, reload, loadMore } = useTweetSearchData(requestKey, load, onResult, onError, enabled);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const onBodyScrollActivity = useTableLoadMore(scrollRef, hasMore && !loadingMore, loadMore);
  // Keyed by footer id because two panes share this table, and held in pane
  // state so a reload or a shared layout comes back to the same tweet.
  const [selectedTweetId, setSelectedTweetId] = usePluginPaneState<string | null>(`${footerId}:selectedTweetId`, null);
  const [detailOpen, setDetailOpen] = usePluginPaneState(tweetDetailStateKey(footerId), false);
  const [sort, setSort] = useState<{ columnId: TweetSortColumnId; direction: TweetSortDirection }>({
    columnId: "views",
    direction: "desc",
  });
  const rows = useMemo(() => sortedTweets(data?.tweets ?? [], sort.columnId, sort.direction), [data?.tweets, sort]);
  const columns = useMemo(() => buildTweetColumns(width), [width]);
  const selectedIndex = rows.findIndex((tweet) => tweet.id === selectedTweetId);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : rows.length > 0 ? 0 : -1;
  const selectedTweet = rows[activeIndex] ?? null;
  const openUsernameFeed = useCallback((username: string) => {
    const normalizedUsername = normalizeTwitterUsername(username);
    if (!normalizedUsername) return;
    const query = twitterUserSearchQuery(normalizedUsername);
    createPaneFromTemplate("twitter-feed-pane", {
      arg: query,
      values: {
        query,
        queryType: "Latest",
      },
    });
  }, [createPaneFromTemplate]);
  const dialog = useDialog();
  const openTicker = useInlineTickerOpener();
  const selectedLinks = useMemo(() => (selectedTweet ? tweetLinks(selectedTweet) : []), [selectedTweet]);
  // Tickers, accounts and links are badges a click opens; `m` lists them.
  const openTweetLinks = useCallback(async () => {
    if (selectedLinks.length === 0) return;
    const choice = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<string>) => (
        <ChoiceDialog {...ctx} title="Open from this tweet" choices={selectedLinks.map(tweetLinkChoice)} />
      ),
    }).catch(() => undefined);
    const link = choice === undefined ? undefined : selectedLinks[Number(choice)];
    if (!link) return;
    if (link.kind === "ticker") openTicker(link.symbol);
    else if (link.kind === "username") openUsernameFeed(link.username);
    else openUrl(link.url);
  }, [dialog, openTicker, openUsernameFeed, selectedLinks]);
  const linkHints = useMemo<PaneHint[]>(() => (
    selectedLinks.length > 0
      ? [{ id: "mentions", key: "m", label: "entions", title: "Mentions and Links", onPress: () => { void openTweetLinks(); } }]
      : []
  ), [openTweetLinks, selectedLinks.length]);
  const openSelectedTweet = usePaneStatusLinkFooter({
    registrationId: footerId,
    focused,
    url: detailOpen ? selectedTweet?.url : null,
    source: detailOpen && selectedTweet
      ? `@${selectedTweet.author.userName || selectedTweet.author.name}`
      : null,
    loading: loading || loadingMore,
    error,
    hints: linkHints,
  });

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedTweetId !== null) setSelectedTweetId(null);
      setDetailOpen(false);
      return;
    }
    if (!selectedTweetId || selectedIndex < 0) {
      setSelectedTweetId(rows[0]!.id);
    }
  }, [rows, selectedIndex, selectedTweetId]);

  const handleHeaderClick = useCallback((columnId: string) => {
    if (!isTweetSortColumnId(columnId)) return;
    setSort((current) => (
      current.columnId === columnId
        ? { columnId, direction: current.direction === "desc" ? "asc" : "desc" }
        : { columnId, direction: "desc" }
    ));
  }, []);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (onFocusSearch && context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      onFocusSearch();
      return true;
    }
    if (isPlainKey(event, "m") && selectedLinks.length > 0) {
      void openTweetLinks();
      return true;
    }
    if (!isPlainKey(event, "r")) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    reload(true);
    return true;
  }, [onFocusSearch, openTweetLinks, reload, selectedLinks.length]);

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "m") && selectedLinks.length > 0) {
      void openTweetLinks();
      return true;
    }
    if (!isPlainKey(event, "o")) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    openSelectedTweet();
    return true;
  }, [openSelectedTweet, openTweetLinks, selectedLinks.length]);

  const renderCell = useCallback((
    tweet: CloudTweetPayload,
    column: TweetColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "time":
        return { text: formatRelativeShort(tweet.createdAt), color: selectedColor ?? colors.textDim };
      case "author":
        return {
          text: `@${tweet.author.userName || tweet.author.name}`,
          color: selectedColor ?? colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "text":
        return { text: normalizeTweetCellText(tweet.text), color: selectedColor ?? colors.text };
      case "tickers": {
        const tickers = tweetTickers(tweet);
        return {
          text: tickers.map((ticker) => `$${ticker}`).join(" "),
          content: (
            <TickerBadgeList
              symbols={tickers}
              width={column.width}
              fallbackColor={selectedColor ?? colors.positive}
            />
          ),
          color: selectedColor ?? colors.positive,
        };
      }
      case "likes":
        return { text: formatMetric(tweet.metrics.likes), color: selectedColor ?? colors.textDim };
      case "views":
        return { text: formatMetric(tweet.metrics.views), color: selectedColor ?? colors.textDim };
    }
  }, []);

  // Signed out with nothing cached, the wall is the whole body: a sortable
  // header over "sign in" would read as a live, empty feed. A feed's search
  // bar stays above it so the query and the `/` hint still have a field.
  if (rows.length === 0 && error && isAuthError(error)) {
    const wall = <SignInWall action="search X" needsVerification={/verification/i.test(error)} />;
    if (!rootBefore) return wall;
    return (
      <Box flexDirection="column" width={width} height={height}>
        {rootBefore}
        {wall}
      </Box>
    );
  }

  // Owns the whole empty body so loading, failure, and "nothing found" each get
  // their own rows instead of the table's single run-on empty line.
  const emptyContent = (
    <PaneStatusBody
      loading={loading}
      error={error}
      empty
      subject="Tweets"
      emptyTitle={emptyStateTitle ?? "No tweets"}
      emptyMessage={emptyStateHint ?? data?.query}
    />
  );

  return (
    <DataTableStackView<CloudTweetPayload, TweetColumn>
      focused={focused}
      detailOpen={detailOpen}
      onBack={() => setDetailOpen(false)}
      detailTitle={selectedTweet ? `@${selectedTweet.author.userName || selectedTweet.author.name} - ${formatTimeAgo(selectedTweet.createdAt)}` : "Tweet"}
      detailContent={selectedTweet ? <TweetDetail tweet={selectedTweet} width={width} onOpenUsername={openUsernameFeed} /> : null}
      selection={{
        kind: "id",
        selectedId: selectedTweetId,
        getId: (tweet) => tweet.id,
        onChange: (id) => setSelectedTweetId(id),
      }}
      onActivate={(tweet) => {
        setSelectedTweetId(tweet.id);
        setDetailOpen(true);
      }}
      onRootKeyDown={handleRootKeyDown}
      onDetailKeyDown={handleDetailKeyDown}
      scrollRef={scrollRef}
      onBodyScrollActivity={onBodyScrollActivity}
      rootBefore={rootBefore}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(tweet) => tweet.id}
      renderCell={renderCell}
      emptyContent={emptyContent}
      emptyStateTitle={emptyStateTitle ?? "No tweets"}
      emptyStateHint={emptyStateHint ?? data?.query}
    />
  );
}
