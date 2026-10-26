import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../../../api-client";
import { PaneFooterBar, PaneFooterProvider } from "../../../../../components/layout/pane/footer";
import type { NewsService } from "../../../../../news/aggregator";
import { setSharedNewsService } from "../../../../../news/hooks";
import type { NewsAccess, NewsArticle, NewsQueryState } from "../../../../../news/types";
import { createOpenTuiTestHarness } from "../../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../../state/app/context";
import { createStatefulTestPluginRuntime } from "../../../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../../../types/config";
import { Box } from "../../../../../ui";
import { BreakingPane } from "../index";
import { TestPaneProvider } from "../../../../../test-support/pane";
import { createTestArticle } from "../../../../../test-support/news";

const PANE_ID = "news-breaking:test";

const tui = createOpenTuiTestHarness();

function makeArticle(): NewsArticle {
  return createTestArticle("story-1", {
    title: "Chip stocks rally on new AI demand",
    url: "https://example.com/story",
    source: "example",
    publishedAt: new Date("2026-05-13T12:00:00.000Z"),
    summary: "Semiconductor names moved higher after hyperscaler capex commentary.",
    topic: "earnings",
    topics: ["earnings"],
    sectors: ["information_technology"],
    categories: ["earnings", "information_technology"],
    tickers: ["AMD", "NVDA"],
    sentiment: "positive",
    scores: { importance: 85, urgency: 80, marketImpact: 75, novelty: 60, confidence: 90 },
    isBreaking: true,
    importance: 85,
  });
}

function createReadyNewsService(
  articles: NewsArticle[],
  access: NewsAccess | null = null,
): { service: NewsService; getQueryStateCalls: () => number } {
  const state: NewsQueryState = {
    phase: "ready",
    articles,
    error: null,
    updatedAt: Date.now(),
    sourceIds: ["test"],
    nextCursor: null,
    loadingMore: false,
    access,
  };
  const listeners = new Set<(state: NewsQueryState) => void>();
  let queryStateCalls = 0;
  const service = {
    watchQuery(_query: unknown, listener: (state: NewsQueryState) => void) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    getQueryState() {
      queryStateCalls += 1;
      return state;
    },
    async load() {
      return state;
    },
    async loadStory() {
      return null;
    },
  } as unknown as NewsService;
  return { service, getQueryStateCalls: () => queryStateCalls };
}

function createHarness() {
  const config = createDefaultConfig("/tmp/gloomberb-breaking-news");
  config.layout.instances.push({
    instanceId: PANE_ID,
    paneId: "news-breaking",
    title: "Breaking News",
  });
  const state = createInitialState(config);
  state.focusedPaneId = PANE_ID;

  return (
    <TestPaneProvider state={state} paneId={PANE_ID} pluginId="news" runtime={createStatefulTestPluginRuntime()}>
      <PaneFooterProvider>
        {(footer) => (
          <Box flexDirection="column" width={90} height={18}>
            <BreakingPane paneId={PANE_ID} paneType="news-breaking" focused width={90} height={17} />
            <PaneFooterBar footer={footer} focused width={90} />
          </Box>
        )}
      </PaneFooterProvider>
    </TestPaneProvider>
  );
}

afterEach(() => {
  setSharedNewsService(null);
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
});

describe("BreakingPane", () => {
  test("reads the wire through the shared news service when it is mounted", async () => {
    const newsService = createReadyNewsService([makeArticle()]);
    setSharedNewsService(newsService.service);

    await act(async () => {
      await tui.render(createHarness(), { width: 90, height: 18 });
      await Bun.sleep(20);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    expect(newsService.getQueryStateCalls()).toBeGreaterThan(0);
  });

  test("labels the wire by what the service answered, not by the plan the app remembers", async () => {
    // A paying Pro account, as restored from disk at launch.
    apiClient.setSessionToken("news-label-session");
    apiClient.restoreCachedUser({ id: "user-pro", email: "pro@example.com", emailVerified: true, plan: "pro" });
    const footer = async (access: NewsAccess | null) => {
      setSharedNewsService(createReadyNewsService([makeArticle()], access).service);
      await tui.render(createHarness(), { width: 90, height: 18 });
      const frame = await tui.waitForFrameToContain("Chip stocks rally");
      return frame.split("\n").filter((line) => line.trim()).at(-1) ?? "";
    };

    expect(await footer("realtime")).toContain("real-time news");
    // A read that went out before the session: held back, said so, and nothing to upgrade to.
    const heldBack = await footer("delayed");
    expect(heldBack).toContain("12h");
    expect(heldBack).not.toContain("real-time news");
    expect(heldBack).not.toContain("upgrade");
    // An answer that does not say is not called live on the plan's word.
    expect(await footer(null)).not.toContain("real-time news");
  });
});
