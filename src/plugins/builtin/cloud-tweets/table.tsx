import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, ScrollBox, Text, TextAttributes } from "../../../ui";
import {
  DataTableStackView,
  TickerBadgeList,
  type DataTableCell,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import { TickerBadgeText } from "../../../components/ticker/badge/text";
import { RemoteImage } from "../../../components/ui";
import { useInlineTickers } from "../../../state/hooks/inline-tickers";
import { usePluginAppActions } from "../../runtime";
import type { CloudTweetPayload, CloudTweetSearchResponse } from "../../../api-client";
import { formatTimeAgo } from "../../../utils/format";
import { colors } from "../../../theme/colors";
import { CloudAuthNotice } from "../cloud/auth-actions";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import {
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
import { usePaneStatusLinkFooter } from "../shared/pane-footer";

function isAuthError(error: string | null): boolean {
  return !!error && /unauthorized|verification/i.test(error);
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
  const { catalog, openTicker } = useInlineTickers([tweetText]);

  return (
    <ScrollBox scrollY focusable={false} flexGrow={1} paddingX={1}>
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
        <Box flexDirection="row" height={1}>
          <Text fg={colors.textDim}>
            {`likes ${formatMetric(tweet.metrics.likes)}  reposts ${formatMetric(tweet.metrics.retweets)}  replies ${formatMetric(tweet.metrics.replies)}  views ${formatMetric(tweet.metrics.views)}`}
          </Text>
        </Box>
      </Box>
    </ScrollBox>
  );
}

function useTweetSearchData(
  requestKey: string,
  load: () => Promise<CloudTweetSearchResponse>,
  onResult?: (result: CloudTweetSearchResponse) => void,
  onError?: (message: string) => void,
  enabled = true,
) {
  const [state, setState] = useState<TweetLoadState>({
    data: null,
    loading: false,
    error: null,
  });
  const fetchGenRef = useRef(0);
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  const reload = useCallback(() => {
    if (!enabled) {
      fetchGenRef.current += 1;
      setState((current) => (
        current.data || current.loading || current.error
          ? { data: null, loading: false, error: null }
          : current
      ));
      return;
    }

    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    load()
      .then((data) => {
        if (fetchGenRef.current !== gen) return;
        setState({ data, loading: false, error: null });
        onResultRef.current?.(data);
      })
      .catch((error) => {
        if (fetchGenRef.current !== gen) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ data: null, loading: false, error: message });
        onErrorRef.current?.(message);
      });
  }, [enabled, load]);

  useEffect(() => {
    reload();
  }, [reload, requestKey]);

  return { ...state, reload };
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
  load: () => Promise<CloudTweetSearchResponse>;
  onResult?: (result: CloudTweetSearchResponse) => void;
  onError?: (message: string) => void;
  onFocusSearch?: () => void;
  emptyStateTitle?: string;
  emptyStateHint?: string;
}) {
  const { createPaneFromTemplate } = usePluginAppActions();
  const { data, loading, error, reload } = useTweetSearchData(requestKey, load, onResult, onError, enabled);
  const [selectedTweetId, setSelectedTweetId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sort, setSort] = useState<{ columnId: TweetSortColumnId; direction: TweetSortDirection }>({
    columnId: "views",
    direction: "desc",
  });
  const rows = useMemo(() => sortedTweets(data?.tweets ?? [], sort.columnId, sort.direction), [data?.tweets, sort]);
  const columns = useMemo(() => buildTweetColumns(width), [width]);
  const selectedIndex = rows.findIndex((tweet) => tweet.id === selectedTweetId);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : rows.length > 0 ? 0 : -1;
  const selectedTweet = rows[activeIndex] ?? null;
  const openSelectedTweet = usePaneStatusLinkFooter({
    registrationId: footerId,
    focused,
    url: detailOpen ? selectedTweet?.url : null,
    source: detailOpen && selectedTweet
      ? `@${selectedTweet.author.userName || selectedTweet.author.name}`
      : null,
    loading,
    error,
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
    if (event.name !== "r") return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    reload();
    return true;
  }, [onFocusSearch, reload]);

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name !== "o") return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    openSelectedTweet();
    return true;
  }, [openSelectedTweet]);

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
              liveQuote={false}
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

  const emptyContent = error && isAuthError(error)
    ? <CloudAuthNotice message={error} showSignup />
    : undefined;

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
      emptyStateTitle={loading ? "Loading tweets..." : error ?? emptyStateTitle ?? "No tweets"}
      emptyStateHint={emptyStateHint ?? data?.query}
    />
  );
}
