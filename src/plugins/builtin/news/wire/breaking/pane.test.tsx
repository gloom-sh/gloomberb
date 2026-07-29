import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../../../components/layout/pane/footer";
import type { NewsService } from "../../../../../news/aggregator";
import { setSharedNewsService } from "../../../../../news/hooks";
import type { NewsArticle, NewsQueryState } from "../../../../../news/types";
import { testRender } from "../../../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../../../state/app/context";
import { createStatefulTestPluginRuntime } from "../../../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../../../types/config";
import { Box } from "../../../../../ui";
import { PluginRenderProvider } from "../../../../runtime";
import { setDetectedProviders } from "../../../ai/providers";
import { setAiRunHost } from "../../../ai/runner";
import { BreakingPane } from "./pane";

const PANE_ID = "news-breaking:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function makeArticle(): NewsArticle {
  return {
    id: "story-1",
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
    scores: {
      importance: 85,
      urgency: 80,
      marketImpact: 75,
      novelty: 60,
      confidence: 90,
    },
    isBreaking: true,
    isDeveloping: false,
    importance: 85,
  };
}

function createReadyNewsService(articles: NewsArticle[]): { service: NewsService; getQueryStateCalls: () => number } {
  const state: NewsQueryState = {
    phase: "ready",
    articles,
    error: null,
    updatedAt: Date.now(),
    sourceIds: ["test"],
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
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId={PANE_ID}>
        <PluginRenderProvider pluginId="news" runtime={createStatefulTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <Box flexDirection="column" width={90} height={18}>
                <BreakingPane focused width={90} height={17} />
                <PaneFooterBar footer={footer} focused width={90} />
              </Box>
            )}
          </PaneFooterProvider>
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

afterEach(async () => {
  setSharedNewsService(null);
  setAiRunHost(null);
  setDetectedProviders(null);
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
});

describe("BreakingPane", () => {
  test("does not run local AI providers when breaking news is mounted", async () => {
    let runCalls = 0;
    const newsService = createReadyNewsService([makeArticle()]);
    setSharedNewsService(newsService.service);
    setDetectedProviders([
      {
        id: "anthropic",
        name: "Claude",
        available: true,
        status: "ready",
        outputModes: ["plain", "structured", "screener"],
      },
    ]);
    setAiRunHost({
      run() {
        runCalls += 1;
        return {
          done: Promise.resolve("digest"),
          cancel: () => {},
        };
      },
    });

    await act(async () => {
      testSetup = await testRender(createHarness(), { width: 90, height: 18 });
      await Bun.sleep(20);
      await testSetup.renderOnce();
      await testSetup.renderOnce();
    });

    expect(runCalls).toBe(0);
    expect(newsService.getQueryStateCalls()).toBeGreaterThan(0);
  });
});
