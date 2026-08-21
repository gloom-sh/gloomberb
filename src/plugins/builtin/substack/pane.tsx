import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import {
  EmptyState,
  Spinner,
  useTableLoadMore,
  type DataTableKeyEvent,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import {
  clearSubstackAuth,
  getStoredSubstackAuth,
} from "./api/store";
import {
  loadSubstackArticleDetail,
  loadSubstackHome,
  loadSubstackHomeMore,
  loadSubstackPublicationFeed,
} from "./api/loaders";
import {
  SubstackAuthError,
  type SubstackAuthState,
  type SubstackCachedData,
  type SubstackHomeData,
  type SubstackPublicationFeedPage,
} from "./api/types";
import { ArticleDetail } from "./article-detail";
import { SubstackArticleStack } from "./article-stack";
import { SubstackFeedTabs } from "./feed-tabs";
import { SubstackLoginView } from "./login-view";
import {
  buildSubstackColumns,
  isSubstackSortColumnId,
  nextSubstackSort,
  publicationFromTabId,
  sortedSubstackArticles,
  tabIdForPublication,
} from "./table";
import {
  SUBSTACK_FEED_TAB_ID,
  type SubstackArticleDetail,
  type SubstackArticleSummary,
  type SubstackPublication,
  type SubstackSortColumnId,
  type SubstackSortDirection,
} from "./types";
import { useSubstackPaneFooter } from "./pane-footer";
import {
  activeFeedStateFromSources,
  detailLoadStateFromCache,
  emptyLoadState,
  emptyPublicationFeedState,
  errorMessage,
  homeLoadStateFromCache,
  mergePublicationFeedPages,
  publicationLoadStateFromCache,
  type DetailState,
  type LoadState,
  type PublicationFeedState,
} from "./pane-state";
import { useSubstackReadState } from "./read-state";

const PUBLICATION_LOAD_MORE_THRESHOLD_ROWS = 8;

export function SubstackPane({ focused, width, height }: PaneProps) {
  const rendererHost = useRendererHost();
  const [auth, setAuth] = useState<SubstackAuthState | null>(() => getStoredSubstackAuth());
  const [home, setHome] = useState<LoadState<SubstackHomeData>>(homeLoadStateFromCache);
  const [publicationFeeds, setPublicationFeeds] = useState<Record<string, PublicationFeedState>>({});
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [activeTab, setActiveTab] = usePluginPaneState<string>("activeTab", SUBSTACK_FEED_TAB_ID);
  const [selectedArticleId, setSelectedArticleId] = useDebouncedPluginPaneState<string | null>("selectedArticleId", null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>("detailOpen", false);
  const [sort, setSort] = useState<{ columnId: SubstackSortColumnId; direction: SubstackSortDirection }>({
    columnId: "published",
    direction: "desc",
  });
  const { readArticleIds, markArticleRead } = useSubstackReadState();
  const homeFetchGenRef = useRef(0);
  const publicationFetchGenRef = useRef<Record<string, number>>({});
  const detailFetchGenRef = useRef(0);
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const handleAuthFailure = useCallback((error: unknown) => {
    if (!(error instanceof SubstackAuthError)) return false;
    clearSubstackAuth();
    setAuth(null);
    setDetailOpen(false);
    setHome((current) => ({
      ...current,
      loading: false,
      error: error.message,
    }));
    return true;
  }, []);

  const loadHome = useCallback((force = false) => {
    if (!auth) return;
    homeFetchGenRef.current += 1;
    const gen = homeFetchGenRef.current;
    setHome((current) => ({
      ...current,
      loading: !current.data || force,
      error: null,
    }));
    loadSubstackHome(force)
      .then((data) => {
        if (homeFetchGenRef.current !== gen) return;
        setHome({
          data,
          loading: false,
          error: null,
          fetchedAt: data.fetchedAt,
          stale: data.stale,
        });
      })
      .catch((loadError) => {
        if (homeFetchGenRef.current !== gen) return;
        if (handleAuthFailure(loadError)) return;
        setHome((current) => ({
          ...current,
          loading: false,
          error: errorMessage(loadError),
        }));
      });
  }, [auth, handleAuthFailure]);

  const loadHomeMore = useCallback((cursor: string) => {
    if (!auth) return;
    const gen = homeFetchGenRef.current;
    loadSubstackHomeMore(cursor)
      .then((page) => {
        if (homeFetchGenRef.current !== gen) return;
        setHome((current) => {
          if (!current.data) return current;
          const itemsById = new Map(current.data.feed.map((article) => [article.id, article]));
          for (const article of page.items) itemsById.set(article.id, article);
          return {
            ...current,
            data: {
              ...current.data,
              feed: [...itemsById.values()],
              hasMore: !!page.nextCursor,
              nextCursor: page.nextCursor,
            },
          };
        });
      })
      .catch((loadError) => {
        if (homeFetchGenRef.current !== gen) return;
        handleAuthFailure(loadError);
      });
  }, [auth, handleAuthFailure]);

  useEffect(() => {
    if (!auth) return;
    loadHome(false);
  }, [auth, loadHome]);

  const subscriptions = home.data?.subscriptions ?? [];
  const activePublication = useMemo(
    () => publicationFromTabId(activeTab, subscriptions),
    [activeTab, subscriptions],
  );
  const activePublicationTabId = activePublication ? tabIdForPublication(activePublication) : null;

  useEffect(() => {
    if (!home.data || activeTab === SUBSTACK_FEED_TAB_ID) return;
    if (!publicationFromTabId(activeTab, subscriptions)) {
      setActiveTab(SUBSTACK_FEED_TAB_ID);
      setDetailOpen(false);
    }
  }, [activeTab, home.data, setActiveTab, setDetailOpen, subscriptions]);

  const loadPublication = useCallback((publication: SubstackPublication, force = false, offset = 0) => {
    const tabId = tabIdForPublication(publication);
    const isLoadMore = offset > 0 && !force;
    const gen = (publicationFetchGenRef.current[tabId] ?? 0) + 1;
    publicationFetchGenRef.current[tabId] = gen;
    setPublicationFeeds((current) => ({
      ...current,
      [tabId]: {
        ...(current[tabId] ?? emptyPublicationFeedState()),
        loading: !isLoadMore,
        loadingMore: isLoadMore,
        error: null,
      },
    }));
    loadSubstackPublicationFeed(publication, force, offset)
      .then((entry: SubstackCachedData<SubstackPublicationFeedPage>) => {
        if (publicationFetchGenRef.current[tabId] !== gen) return;
        setPublicationFeeds((current) => ({
          ...current,
          [tabId]: (() => {
            const previous = current[tabId] ?? emptyPublicationFeedState();
            return {
              data: isLoadMore ? mergePublicationFeedPages(previous.data, entry.data) : entry.data,
              loading: false,
              loadingMore: false,
              error: null,
              fetchedAt: entry.fetchedAt,
              stale: entry.stale,
            };
          })(),
        }));
      })
      .catch((loadError) => {
        if (publicationFetchGenRef.current[tabId] !== gen) return;
        if (handleAuthFailure(loadError)) return;
        setPublicationFeeds((current) => ({
          ...current,
          [tabId]: {
            ...(current[tabId] ?? emptyPublicationFeedState()),
            loading: false,
            loadingMore: false,
            error: errorMessage(loadError),
          },
        }));
      });
  }, [handleAuthFailure]);

  useEffect(() => {
    if (!activePublication || !activePublicationTabId) return;
    const entry = publicationFeeds[activePublicationTabId];
    if (entry?.data || entry?.loading || entry?.loadingMore || entry?.error) return;
    const cached = publicationLoadStateFromCache(activePublication);
    if (cached) {
      setPublicationFeeds((current) => ({
        ...current,
        [activePublicationTabId]: cached,
      }));
      return;
    }
    loadPublication(activePublication, false);
  }, [activePublication, activePublicationTabId, loadPublication, publicationFeeds]);

  const activeFeedState = useMemo(() => activeFeedStateFromSources({
    activePublication,
    activePublicationTabId,
    publicationFeeds,
    home,
  }), [activePublication, activePublicationTabId, home, publicationFeeds]);

  const loadMoreHome = useCallback(() => {
    if (!auth || home.loading || detailOpen || !home.data?.hasMore || !home.data.nextCursor) return;
    loadHomeMore(home.data.nextCursor);
  }, [auth, detailOpen, home.data?.hasMore, home.data?.nextCursor, home.loading, loadHomeMore]);

  const loadMoreActivePublicationRows = useTableLoadMore(
    tableScrollRef,
    !detailOpen && (
      activePublication
        ? !!(publicationFeeds[activePublicationTabId ?? ""]?.data?.hasMore
          && publicationFeeds[activePublicationTabId ?? ""]?.data?.nextOffset != null
          && !publicationFeeds[activePublicationTabId ?? ""]?.loading
          && !publicationFeeds[activePublicationTabId ?? ""]?.loadingMore
          && !publicationFeeds[activePublicationTabId ?? ""]?.error)
        : !!(home.data?.hasMore && home.data.nextCursor && !home.loading)
    ),
    () => {
      if (activePublication) {
        const page = publicationFeeds[activePublicationTabId ?? ""]?.data;
        if (page?.nextOffset != null) loadPublication(activePublication, false, page.nextOffset);
        return;
      }
      loadMoreHome();
    },
    PUBLICATION_LOAD_MORE_THRESHOLD_ROWS,
  );

  const sortedRows = useMemo(() => (
    sortedSubstackArticles(activeFeedState.data ?? [], sort)
  ), [activeFeedState.data, sort]);

  useEffect(() => {
    loadMoreActivePublicationRows();
  }, [loadMoreActivePublicationRows, sortedRows.length]);

  const selectedIndex = selectedArticleId
    ? sortedRows.findIndex((article) => article.id === selectedArticleId)
    : -1;
  const selectedArticle = sortedRows[selectedIndex >= 0 ? selectedIndex : 0] ?? null;

  useEffect(() => {
    if (sortedRows.length === 0) {
      if (!home.loading && !activeFeedState.loading && !activeFeedState.loadingMore) {
        if (selectedArticleId !== null) setSelectedArticleId(null);
        setDetailOpen(false);
      }
      return;
    }
    if (!selectedArticleId || selectedIndex < 0) {
      setSelectedArticleId(sortedRows[0]!.id);
    }
  }, [
    activeFeedState.loading,
    activeFeedState.loadingMore,
    home.loading,
    selectedArticleId,
    selectedIndex,
    setDetailOpen,
    setSelectedArticleId,
    sortedRows,
  ]);

  const loadSelectedDetail = useCallback((article: SubstackArticleSummary, force = false) => {
    detailFetchGenRef.current += 1;
    const gen = detailFetchGenRef.current;
    setDetails((current) => ({
      ...current,
      [article.id]: {
        ...(current[article.id] ?? emptyLoadState<SubstackArticleDetail>()),
        loading: true,
        error: null,
      },
    }));
    loadSubstackArticleDetail(article, force)
      .then((entry) => {
        if (detailFetchGenRef.current !== gen) return;
        setDetails((current) => ({
          ...current,
          [article.id]: {
            data: entry.data,
            loading: false,
            error: null,
            fetchedAt: entry.fetchedAt,
            stale: entry.stale,
          },
        }));
      })
      .catch((loadError) => {
        if (detailFetchGenRef.current !== gen) return;
        if (handleAuthFailure(loadError)) return;
        setDetails((current) => ({
          ...current,
          [article.id]: {
            ...(current[article.id] ?? emptyLoadState<SubstackArticleDetail>()),
            loading: false,
            error: errorMessage(loadError),
          },
        }));
      });
  }, [handleAuthFailure]);

  useEffect(() => {
    if (!detailOpen || !selectedArticle) return;
    const existing = details[selectedArticle.id];
    if (existing?.data || existing?.loading) return;
    const cached = detailLoadStateFromCache(selectedArticle);
    if (cached) {
      setDetails((current) => ({
        ...current,
        [selectedArticle.id]: cached,
      }));
      if (!cached.stale) return;
    }
    loadSelectedDetail(selectedArticle, false);
  }, [detailOpen, details, loadSelectedDetail, selectedArticle]);

  useEffect(() => {
    if (!detailOpen) return;
    if (detailScrollRef.current) detailScrollRef.current.scrollTop = 0;
  }, [detailOpen, selectedArticle?.id]);

  const selectTab = useCallback((tabId: string) => {
    setActiveTab(tabId);
    setDetailOpen(false);
  }, [setActiveTab, setDetailOpen]);

  const refreshActive = useCallback(() => {
    if (activePublication) {
      loadPublication(activePublication, true);
      return;
    }
    loadHome(true);
  }, [activePublication, loadHome, loadPublication]);

  const openSelectedArticle = useCallback(() => {
    if (!selectedArticle?.url) return;
    markArticleRead(selectedArticle.id);
    void rendererHost.openExternal(selectedArticle.url);
  }, [markArticleRead, rendererHost, selectedArticle]);

  const handleLogin = useCallback((nextAuth: SubstackAuthState) => {
    setAuth(nextAuth);
    setActiveTab(SUBSTACK_FEED_TAB_ID);
  }, [setActiveTab]);

  const handleHeaderClick = useCallback((columnId: string) => {
    if (!isSubstackSortColumnId(columnId)) return;
    setSort((current) => nextSubstackSort(current, columnId));
  }, []);

  const scrollDetailBy = useCallback((delta: number) => {
    const scrollBox = detailScrollRef.current;
    if (!scrollBox?.viewport) return;
    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollBox.scrollTop + delta));
  }, []);

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refreshActive();
      return true;
    }
    if (isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedArticle();
      return true;
    }
    return false;
  }, [openSelectedArticle, refreshActive]);

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "j", "down")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      scrollDetailBy(1);
      return true;
    }
    if (isPlainKey(event, "k", "up")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      scrollDetailBy(-1);
      return true;
    }
    if (isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedArticle();
      return true;
    }
    if (isPlainKey(event, "r") && selectedArticle) {
      event.preventDefault?.();
      event.stopPropagation?.();
      loadSelectedDetail(selectedArticle, true);
      return true;
    }
    return false;
  }, [loadSelectedDetail, openSelectedArticle, scrollDetailBy, selectedArticle]);

  const includePublication = !activePublication;
  const columns = useMemo(() => buildSubstackColumns(width, includePublication), [includePublication, width]);
  const activeDetail = selectedArticle ? details[selectedArticle.id] ?? emptyLoadState<SubstackArticleDetail>() : emptyLoadState<SubstackArticleDetail>();
  useSubstackPaneFooter({
    auth,
    detailOpen,
    activeFeedState,
    activeDetail,
    selectedArticle,
    openSelectedArticle,
  });

  if (!auth) {
    return (
      <SubstackLoginView
        width={width}
        height={height}
        focused={focused}
        onLogin={handleLogin}
      />
    );
  }

  const tabs = (
    <SubstackFeedTabs
      subscriptions={subscriptions}
      activeTab={activeTab}
      focused={focused}
      detailOpen={detailOpen}
      onSelect={selectTab}
    />
  );

  if (home.loading && !home.data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label="Loading Substack..." />
        </Box>
      </Box>
    );
  }

  if (home.error && !home.data) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <Box padding={1}>
          <EmptyState title="Substack unavailable." message={home.error} />
        </Box>
      </Box>
    );
  }

  const detailContent = selectedArticle ? (
    <ArticleDetail
      article={selectedArticle}
      detail={activeDetail.data}
      width={width}
      loading={activeDetail.loading}
      error={activeDetail.error}
      scrollRef={detailScrollRef}
      onOpenArticle={openSelectedArticle}
    />
  ) : null;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <SubstackArticleStack
        focused={focused}
        detailOpen={detailOpen}
        onBack={() => setDetailOpen(false)}
        selectedArticle={selectedArticle}
        detailContent={detailContent}
        selectedArticleId={selectedArticleId}
        readArticleIds={readArticleIds}
        onActivate={(article) => {
          markArticleRead(article.id);
          setSelectedArticleId(article.id, { immediate: true });
          setDetailOpen(true);
        }}
        onSelectionChange={(id) => setSelectedArticleId(id)}
        onRootKeyDown={handleRootKeyDown}
        onDetailKeyDown={handleDetailKeyDown}
        onBodyScrollActivity={loadMoreActivePublicationRows}
        tableScrollRef={tableScrollRef}
        width={width}
        height={height}
        columns={columns}
        sortedRows={sortedRows}
        activePublication={activePublication}
        activeFeedState={activeFeedState}
        sort={sort}
        onHeaderClick={handleHeaderClick}
      />
    </Box>
  );
}
