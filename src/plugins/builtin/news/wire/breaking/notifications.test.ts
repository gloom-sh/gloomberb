import { describe, expect, test } from "bun:test";
import type { AppNotificationRequest, GloomPluginContext } from "../../../../../types/plugin";
import type { MarketNewsItem, NewsQueryState } from "../../../../../types/news-source";
import {
  BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY,
  setupBreakingNewsNotifications,
} from "./notifications";

function article(id: string, title = id): MarketNewsItem {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: "Test Wire",
    publishedAt: new Date(),
    topic: "general",
    topics: ["general"],
    sectors: [],
    categories: ["general"],
    tickers: ["AAPL"],
    scores: {
      importance: 90,
      urgency: 90,
      marketImpact: 80,
      novelty: 80,
      confidence: 90,
    },
    importance: 90,
    isBreaking: true,
    isDeveloping: false,
  };
}

function ready(articles: MarketNewsItem[]): NewsQueryState {
  return {
    phase: "ready",
    articles,
    error: null,
    updatedAt: Date.now(),
    sourceIds: ["test"],
    nextCursor: null,
    loadingMore: false,
  };
}

describe("breaking news notifications", () => {
  test("primes on the first ready batch and notifies for later unseen articles", () => {
    let enabled = true;
    let listener: ((state: NewsQueryState) => void) | null = null;
    const notifications: AppNotificationRequest[] = [];
    const shownPanes: string[] = [];

    const ctx = {
      configState: {
        get: (key: string) => key === BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY ? enabled : null,
      },
      watchNewsQuery: (_query: unknown, nextListener: (state: NewsQueryState) => void) => {
        listener = nextListener;
        return () => {
          listener = null;
        };
      },
      on: (_event: string, _handler: unknown) => () => {},
      notify: (notification: AppNotificationRequest) => {
        notifications.push(notification);
      },
      showPane: (paneId: string) => {
        shownPanes.push(paneId);
      },
      log: {
        warn: () => {},
      },
    } as unknown as GloomPluginContext;

    const dispose = setupBreakingNewsNotifications(ctx);
    const oldArticle = article("old", "Old headline");
    const newArticle = article("new", "New headline");

    listener?.(ready([oldArticle]));
    listener?.(ready([newArticle, oldArticle]));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "Breaking News",
      body: "New headline",
      desktop: "always",
      persistent: true,
    });

    notifications[0]!.action?.onClick();
    expect(shownPanes).toEqual(["news-breaking"]);

    enabled = false;
    listener?.(ready([article("newer", "Newer headline"), newArticle, oldArticle]));
    expect(notifications).toHaveLength(1);

    dispose();
    expect(listener).toBeNull();
  });
});
