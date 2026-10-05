import { useCallback, useEffect, useMemo, useState } from "react";
import type { NewsArticle } from "../../../../../news/types";
import { mergeNewsArticle } from "../../../../../news/news-model";
import { useLoadNewsStory } from "../../../../../news/hooks";
import { PaneStatusBody } from "../../../../../components";
import { usePaneInstance } from "../../../../../state/app/context";
import type { PaneProps, PaneTemplateCreateOptions, PaneTemplateDef } from "../../../../../types/plugin";
import { usePluginAppActions } from "../../../../runtime";
import { usePersistedNewsArticles } from "../persisted-articles";
import { NewsDetailView } from "./detail-view";
import { useNewsArticleFooter } from "./footer";

export const NEWS_STORY_PANE_ID = "news-story";
const NEWS_STORY_TEMPLATE_ID = "news-story-pane";
const NO_STORY: NewsArticle[] = [];

/**
 * Stories on their way from a list to the pane just opened for them. Once
 * open, the pane keeps its own copy in pane state, so this only has to cover
 * the hand-off and stays small.
 */
const MAX_HANDED_OFF_STORIES = 20;
const handedOffStories = new Map<string, NewsArticle>();

function handOffNewsStory(article: NewsArticle): void {
  handedOffStories.delete(article.id);
  handedOffStories.set(article.id, article);
  for (const id of handedOffStories.keys()) {
    if (handedOffStories.size <= MAX_HANDED_OFF_STORIES) break;
    handedOffStories.delete(id);
  }
}

function handedOffStory(articleId: string): NewsArticle | null {
  if (!articleId) return null;
  return handedOffStories.get(articleId) ?? null;
}

export const openNewsStoryPane = (
  article: NewsArticle,
  createPaneFromTemplate: (templateId: string, options?: PaneTemplateCreateOptions) => void,
): void => {
  handOffNewsStory(article);
  createPaneFromTemplate(NEWS_STORY_TEMPLATE_ID, {
    arg: article.id,
    values: { title: article.title },
  });
};

export function usePopOutNewsArticle(onReturnedToList?: () => void) {
  const { createPaneFromTemplate } = usePluginAppActions();

  return useCallback((article: NewsArticle | null | undefined) => {
    if (!article) return;
    openNewsStoryPane(article, createPaneFromTemplate);
    onReturnedToList?.();
  }, [createPaneFromTemplate, onReturnedToList]);
}

export function createNewsStoryPaneTemplate(): PaneTemplateDef {
  return {
    id: NEWS_STORY_TEMPLATE_ID,
    paneId: NEWS_STORY_PANE_ID,
    label: "Story",
    description: "One news story in its own pane.",
    canCreate: (_context, options) => !!options?.arg?.trim(),
    createInstance: (_context, options) => {
      const articleId = options?.arg?.trim() ?? "";
      if (!articleId) return null;
      return {
        title: options?.values?.title?.trim() || "Story",
        params: { articleId },
        placement: "floating",
      };
    },
  };
}

export function NewsStoryPane({ focused, width }: PaneProps) {
  const articleId = usePaneInstance()?.params?.articleId ?? "";
  const loadNewsStory = useLoadNewsStory();
  const [loaded, setLoaded] = useState<NewsArticle | null>(() => handedOffStory(articleId));
  // The pane keeps a copy of its story, so a relaunch or a shared layout shows
  // it at once, including a story from an RSS feed that cannot be fetched by id.
  const story = useMemo(() => (loaded?.id === articleId ? [loaded] : NO_STORY), [articleId, loaded]);
  const kept = usePersistedNewsArticles("story", story);
  const article = kept.find((entry) => entry.id === articleId) ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!articleId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void loadNewsStory(articleId)
      .then((story) => {
        if (!active) return;
        if (story) {
          setLoaded((current) => (current?.id === story.id ? mergeNewsArticle(current, story) : story));
        } else {
          setError("Story detail unavailable.");
        }
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Story detail unavailable.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [articleId, loadNewsStory]);

  // A story already on screen stays readable when the refresh fails.
  useNewsArticleFooter({
    registrationId: "news-story",
    focused,
    article,
    loading: loading && !article,
    error: article ? null : error,
  });

  if (!articleId) {
    return (
      <PaneStatusBody
        empty
        subject="Story"
        emptyTitle="No story open."
        emptyMessage="Open one from a news list."
      />
    );
  }
  if (!article) {
    return (
      <PaneStatusBody
        loading={loading}
        error={error}
        empty={!loading && !error}
        subject="Story"
        emptyTitle="Story unavailable."
        emptyMessage="Open it again from the list."
      />
    );
  }
  return (
    <NewsDetailView
      item={article}
      focused={focused}
      width={width}
      showTitle={false}
    />
  );
}
