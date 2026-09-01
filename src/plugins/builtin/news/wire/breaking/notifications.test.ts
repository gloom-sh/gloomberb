import { describe, expect, test } from "bun:test";
import type { AppNotificationRequest, GloomPluginContext } from "../../../../../types/plugin";
import type { MarketNewsItem, NewsQueryState } from "../../../../../types/news-source";
import {
  BREAKING_NEWS_MUTED_SECTORS_KEY,
  BREAKING_NEWS_SCOPE_KEY,
} from "./filters";
import {
  BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY,
  setupBreakingNewsNotifications,
} from "./notifications";

function article(
  id: string,
  title = id,
  overrides: Partial<MarketNewsItem> = {},
): MarketNewsItem {
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
    scores: { importance: 90, urgency: 90, marketImpact: 80, novelty: 80, confidence: 90 },
    importance: 90,
    isBreaking: true,
    isDeveloping: false,
    ...overrides,
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

interface Harness {
  ctx: GloomPluginContext;
  notifications: AppNotificationRequest[];
  shownPanes: string[];
  state: Map<string, unknown>;
  emit(articles: MarketNewsItem[]): void;
  isWatching(): boolean;
}

function harness(options: {
  settings?: Record<string, unknown>;
  watchedSymbols?: string[];
} = {}): Harness {
  let listener: ((state: NewsQueryState) => void) | null = null;
  const notifications: AppNotificationRequest[] = [];
  const shownPanes: string[] = [];
  const state = new Map<string, unknown>();
  const settings: Record<string, unknown> = {
    [BREAKING_NEWS_NOTIFICATIONS_ENABLED_KEY]: true,
    ...options.settings,
  };
  const watched = options.watchedSymbols ?? ["AAPL"];

  const ctx = {
    configState: { get: (key: string) => settings[key] ?? null },
    persistence: {
      getState: (key: string) => state.get(key) ?? null,
      setState: (key: string, value: unknown) => void state.set(key, value),
    },
    tickerRepository: {
      loadAllTickers: async () =>
        watched.map((symbol) => ({
          metadata: { ticker: symbol, watchlists: ["default"], portfolios: [], positions: [] },
        })),
    },
    watchNewsQuery: (_query: unknown, next: (state: NewsQueryState) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    on: () => () => {},
    notify: (notification: AppNotificationRequest) => void notifications.push(notification),
    showPane: (paneId: string) => void shownPanes.push(paneId),
    log: { warn: () => {} },
  } as unknown as GloomPluginContext;

  return {
    ctx,
    notifications,
    shownPanes,
    state,
    emit: (articles) => listener?.(ready(articles)),
    isWatching: () => listener !== null,
  };
}

/** Lets the async watchlist load settle before articles arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("breaking news notifications", () => {
  test("primes on the first ready batch and notifies for later unseen articles", async () => {
    const h = harness();
    const dispose = setupBreakingNewsNotifications(h.ctx);
    await settle();

    const old = article("old", "Old headline");
    const fresh = article("new", "New headline");

    h.emit([old]);
    h.emit([fresh, old]);

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({
      title: "Breaking News",
      body: "New headline",
      desktop: "always",
    });
    // Breaking toasts must expire on their own; persistent ones stacked up.
    expect(h.notifications[0]?.persistent).toBeUndefined();
    expect(h.notifications[0]?.duration).toBeGreaterThan(0);

    h.notifications[0]!.action?.onClick();
    expect(h.shownPanes).toEqual(["news-breaking"]);

    dispose();
    expect(h.isWatching()).toBe(false);
  });

  test("default scope drops stories about tickers the user does not track", async () => {
    const h = harness({ watchedSymbols: ["AAPL"] });
    setupBreakingNewsNotifications(h.ctx);
    await settle();

    h.emit([article("seed")]);
    h.emit([
      article("unrelated", "Unrelated ticker", { tickers: ["XOM"] }),
      article("seed"),
    ]);
    expect(h.notifications).toHaveLength(0);

    h.emit([article("macro", "Market-wide event", { tickers: [] }), article("seed")]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.body).toBe("Market-wide event");
  });

  test("muted sectors suppress otherwise in-scope stories", async () => {
    const h = harness({
      settings: { [BREAKING_NEWS_MUTED_SECTORS_KEY]: ["health_care"] },
    });
    setupBreakingNewsNotifications(h.ctx);
    await settle();

    h.emit([article("seed")]);
    h.emit([
      article("pharma", "Pharma story", { sectors: ["health_care"] }),
      article("seed"),
    ]);
    expect(h.notifications).toHaveLength(0);
  });

  test("filtered-out articles are still marked seen so relaxing a filter replays nothing", async () => {
    const h = harness({ settings: { [BREAKING_NEWS_SCOPE_KEY]: "watchlist" } });
    setupBreakingNewsNotifications(h.ctx);
    await settle();

    h.emit([article("seed")]);
    const macro = article("macro", "Market-wide event", { tickers: [] });
    h.emit([macro, article("seed")]);
    expect(h.notifications).toHaveLength(0);

    // Same article arriving again must not notify once it has been observed.
    h.emit([macro, article("seed")]);
    expect(h.notifications).toHaveLength(0);
  });

  test("snoozing suppresses notifications until the window passes", async () => {
    const h = harness();
    setupBreakingNewsNotifications(h.ctx);
    await settle();

    h.emit([article("seed")]);
    h.emit([article("first", "First"), article("seed")]);
    expect(h.notifications).toHaveLength(1);

    h.notifications[0]!.secondaryAction?.onClick();
    const confirmation = h.notifications.length;

    h.emit([article("second", "Second"), article("seed")]);
    expect(h.notifications).toHaveLength(confirmation);

    h.state.set("breaking-news-snooze-until", Date.now() - 1);
    h.emit([article("third", "Third"), article("seed")]);
    expect(h.notifications.at(-1)?.body).toBe("Third");
  });
});
