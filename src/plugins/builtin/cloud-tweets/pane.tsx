import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, type InputRenderable } from "../../../ui";
import {
  EmptyState,
  Tabs,
} from "../../../components";
import type { PaneProps, TickerResearchTabProps } from "../../../types/plugin";
import { usePaneInstance, usePaneInstanceId, usePaneTicker } from "../../../state/app/context";
import { usePluginPaneState, usePluginState } from "../../runtime";
import { apiClient, type CloudTweetQueryType, type CloudTweetSearchResponse } from "../../../api-client";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import {
  DEFAULT_TWEET_HOURS,
  DEFAULT_TWEET_LIMIT,
  EMPTY_FEED_STATE,
  TWEET_SEARCH_SCHEMA_VERSION,
  TWITTER_FEED_LAUNCH_SCHEMA_VERSION,
  TWITTER_FEED_LAUNCH_STATE_KEY,
  createFeed,
  deriveFeedTitle,
  normalizeFeedQuery,
  normalizeFeeds,
  type PersistedTwitterFeedState,
  type TwitterFeed,
  type TwitterFeedLaunchRequest,
} from "./model";
import { TweetSearchTable } from "./table";
import { TwitterFeedSearchBar } from "./search-bar";
import { useTwitterFeedFooter } from "./footer";
import { useTwitterFeedKeyboard } from "./keyboard";

export function TwitterTickerTab({ focused, width, height }: TickerResearchTabProps) {
  const { symbol } = usePaneTicker();
  const load = useCallback(() => {
    if (!symbol) throw new Error("No ticker selected");
    return apiClient.getCloudTickerTweets({
      ticker: symbol,
      hours: DEFAULT_TWEET_HOURS,
      limit: DEFAULT_TWEET_LIMIT,
      includeReplies: false,
    });
  }, [symbol]);

  if (!symbol) {
    return <EmptyState title="No ticker selected." />;
  }

  return (
    <TweetSearchTable
      focused={focused}
      width={width}
      height={height}
      requestKey={`ticker:${symbol}`}
      footerId="ticker-tweets"
      load={load}
    />
  );
}

export function TwitterFeedPane({ focused, width, height }: PaneProps) {
  const paneId = usePaneInstanceId();
  const paneInstance = usePaneInstance();
  const [persistedState, setPersistedState] = usePluginState<PersistedTwitterFeedState>(
    `twitter-feed:${paneId}`,
    EMPTY_FEED_STATE,
    { schemaVersion: TWEET_SEARCH_SCHEMA_VERSION },
  );
  const [launchRequest, setLaunchRequest] = usePluginState<TwitterFeedLaunchRequest | null>(
    TWITTER_FEED_LAUNCH_STATE_KEY,
    null,
    { schemaVersion: TWITTER_FEED_LAUNCH_SCHEMA_VERSION },
  );
  const [activeFeedId, setActiveFeedId] = usePluginPaneState<string | null>("activeFeedId", null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const initializedRef = useRef(false);
  const feeds = useMemo(() => normalizeFeeds(persistedState), [persistedState]);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);

  const blurSearch = useCallback(() => {
    setSearchFocused(false);
  }, []);

  const updateFeeds = useCallback((updater: (feeds: TwitterFeed[]) => TwitterFeed[]) => {
    setPersistedState((current) => ({ feeds: updater(normalizeFeeds(current)) }));
  }, [setPersistedState]);

  const addFeed = useCallback((query = "", queryType: CloudTweetQueryType = "Latest") => {
    const feed = createFeed(query, queryType);
    updateFeeds((current) => [...current, feed]);
    setActiveFeedId(feed.id);
    focusSearch();
    return feed.id;
  }, [focusSearch, setActiveFeedId, updateFeeds]);

  const openOrCreateFeed = useCallback((
    query: string,
    queryType: CloudTweetQueryType = "Latest",
    options?: { focusSearch?: boolean },
  ) => {
    const normalizedQuery = normalizeFeedQuery(query);
    if (!normalizedQuery) {
      if (feeds.length === 0) addFeed("", queryType);
      return;
    }

    let nextActiveId: string | null = null;
    updateFeeds((current) => {
      const existing = current.find((feed) => normalizeFeedQuery(feed.query) === normalizedQuery);
      if (existing) {
        nextActiveId = existing.id;
        return current;
      }
      const feed = createFeed(query, queryType);
      nextActiveId = feed.id;
      return [...current, feed];
    });
    if (nextActiveId) setActiveFeedId(nextActiveId);
    if (options?.focusSearch) focusSearch();
  }, [addFeed, feeds.length, focusSearch, setActiveFeedId, updateFeeds]);

  const updateFeedQuery = useCallback((feedId: string, query: string) => {
    const now = Date.now();
    updateFeeds((current) => current.map((feed) => (
      feed.id === feedId
        ? {
          ...feed,
          query,
          title: deriveFeedTitle(query),
          updatedAt: now,
          lastError: null,
        }
        : feed
    )));
  }, [updateFeeds]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (feeds.length > 0) return;
    const seedQuery = typeof paneInstance?.params?.query === "string" ? paneInstance.params.query : "";
    const seedType = paneInstance?.params?.queryType === "Top" ? "Top" : "Latest";
    const feed = createFeed(seedQuery, seedType);
    setPersistedState({ feeds: [feed] });
    setActiveFeedId(feed.id);
    if (!seedQuery.trim()) focusSearch();
  }, [feeds.length, focusSearch, paneInstance?.params?.query, paneInstance?.params?.queryType, setActiveFeedId, setPersistedState]);

  useEffect(() => {
    if (!launchRequest) return;
    if (launchRequest.targetPaneId && launchRequest.targetPaneId !== paneId) return;

    const queryType = launchRequest.queryType === "Top" ? "Top" : "Latest";
    if (launchRequest.query.trim()) {
      openOrCreateFeed(launchRequest.query, queryType);
    } else if (feeds.length === 0) {
      addFeed("", queryType);
    }
    setLaunchRequest(null);
  }, [addFeed, feeds.length, launchRequest, openOrCreateFeed, paneId, setLaunchRequest]);

  useEffect(() => {
    if (feeds.length === 0) {
      if (activeFeedId !== null) setActiveFeedId(null);
      return;
    }
    if (!activeFeedId || !feeds.some((feed) => feed.id === activeFeedId)) {
      setActiveFeedId(feeds[0]!.id);
    }
  }, [activeFeedId, feeds, setActiveFeedId]);

  const activeFeed = feeds.find((feed) => feed.id === activeFeedId) ?? feeds[0] ?? null;

  const removeFeed = useCallback((feedId: string) => {
    let nextActiveId: string | null = null;
    let createdEmpty = false;
    updateFeeds((current) => {
      const next = current.filter((feed) => feed.id !== feedId);
      if (next.length === 0) {
        const feed = createFeed("", "Latest");
        nextActiveId = feed.id;
        createdEmpty = true;
        return [feed];
      }
      nextActiveId = activeFeedId === feedId
        ? next[0]!.id
        : activeFeedId && next.some((feed) => feed.id === activeFeedId)
          ? activeFeedId
          : next[0]!.id;
      return next;
    });
    if (nextActiveId) setActiveFeedId(nextActiveId);
    if (createdEmpty) focusSearch();
  }, [activeFeedId, focusSearch, setActiveFeedId, updateFeeds]);

  const cycleFeeds = useCallback((direction: -1 | 1) => {
    if (!activeFeed || feeds.length <= 1) return;
    const index = feeds.findIndex((feed) => feed.id === activeFeed.id);
    const nextIndex = (index + direction + feeds.length) % feeds.length;
    setActiveFeedId(feeds[nextIndex]!.id);
  }, [activeFeed, feeds, setActiveFeedId]);

  useTwitterFeedKeyboard({
    activeFeed,
    addFeed,
    blurSearch,
    cycleFeeds,
    focusSearch,
    focused,
    removeFeed,
    searchFocused,
  });

  const activeFeedIdValue = activeFeed?.id ?? null;
  const activeFeedQuery = activeFeed?.query.trim() ?? "";
  const activeFeedQueryType = activeFeed?.queryType ?? "Latest";
  const searchEnabled = activeFeedQuery.length > 0;
  const loadActiveFeed = useCallback(() => {
    if (!activeFeedQuery) throw new Error("No X feed selected");
    return apiClient.searchCloudTweets({
      query: activeFeedQuery,
      queryType: activeFeedQueryType,
      hours: DEFAULT_TWEET_HOURS,
      limit: DEFAULT_TWEET_LIMIT,
    });
  }, [activeFeedQuery, activeFeedQueryType]);

  const markFeedResult = useCallback((result: CloudTweetSearchResponse) => {
    if (!activeFeedIdValue) return;
    const now = Date.now();
    updateFeeds((current) => current.map((feed) => (
      feed.id === activeFeedIdValue
        ? { ...feed, lastSuccessAt: now, lastError: null, title: deriveFeedTitle(result.query) }
        : feed
    )));
  }, [activeFeedIdValue, updateFeeds]);

  const markFeedError = useCallback((message: string) => {
    if (!activeFeedIdValue) return;
    updateFeeds((current) => current.map((feed) => (
      feed.id === activeFeedIdValue ? { ...feed, lastError: message } : feed
    )));
  }, [activeFeedIdValue, updateFeeds]);

  useTwitterFeedFooter({
    activeFeed,
  });

  const searchBar = activeFeed ? (
    <TwitterFeedSearchBar
      feed={activeFeed}
      focused={focused}
      active={searchFocused}
      width={width}
      focusToken={searchFocusToken}
      inputRef={searchInputRef}
      onFocus={focusSearch}
      onBlur={blurSearch}
      onNavigateDown={blurSearch}
      onQueryChange={updateFeedQuery}
    />
  ) : null;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1}>
        <Tabs
          tabs={feeds.map((feed) => ({
            label: truncateWithEllipsis(feed.title, 18),
            value: feed.id,
            onClose: removeFeed,
            onDoubleClick: focusSearch,
          }))}
          activeValue={activeFeed?.id ?? null}
          onSelect={(id) => {
            setActiveFeedId(id);
          }}
          compact
          variant="pill"
          closeMode="active"
          onAdd={() => addFeed()}
          focused={focused && !searchFocused}
        />
      </Box>

      {!activeFeed ? (
        <Box padding={1} flexGrow={1}>
          <EmptyState title="No X feeds yet." />
        </Box>
      ) : (
        <TweetSearchTable
          focused={focused && !searchFocused}
          width={width}
          height={Math.max(1, height - 1)}
          requestKey={`feed:${activeFeed.id}:${activeFeed.query}:${activeFeed.queryType}`}
          footerId="twitter-feed-search"
          rootBefore={searchBar}
          enabled={searchEnabled}
          load={loadActiveFeed}
          onResult={markFeedResult}
          onError={markFeedError}
          onFocusSearch={focusSearch}
          emptyStateTitle={searchEnabled ? "No tweets" : "Enter a search query"}
          emptyStateHint={searchEnabled ? activeFeedQuery : undefined}
        />
      )}
    </Box>
  );
}
