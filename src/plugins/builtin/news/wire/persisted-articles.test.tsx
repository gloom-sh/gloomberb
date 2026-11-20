import { expect, test } from "bun:test";
import { act, useReducer, useState } from "react";
import { apiClient } from "../../../../api-client";
import { createAppRuntime } from "../../../../core/app-runtime";
import { normalizeLoadedConfig } from "../../../../data/config/store/normalize";
import { JsonPersistence } from "../../../../data/json-persistence";
import { JsonTickerRepository } from "../../../../data/json-ticker-repository";
import { cloudNewsSnapshotScope } from "../../../../news/cloud-session";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../../state/app/context";
import { verifiedUser } from "../../../../test-support/cloud-api";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestArticle } from "../../../../test-support/news";
import { createTestPaneConfig, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createDefaultConfig, createPaneInstance } from "../../../../types/config";
import type { MarketNewsItem } from "../../../../types/news-source";
import { Text } from "../../../../ui";
import { listedHeadline } from "../../../../news/news-model";
import { usePersistedNewsArticles, usePersistedStory } from "./persisted-articles";

const tui = createOpenTuiTestHarness({ width: 100, height: 5 });
const paneId = "news-story:test";
const key = "story:v2";

test("an unconfirmed session shows live news or its public upgrade seed, never the account's cached list", async () => {
  const pane = createPaneInstance("news-top", { instanceId: "news-top:offline" });
  const newsKey = "top:curated:articles";
  const legacy = createTestArticle("atom:public", { title: "Public legacy headline" });
  const paid = createTestArticle("paid", { title: "Cached Pro headline" });
  const live = createTestArticle("live", { title: "Live headline" });
  const saved = createTestPaneConfig("/unused/news-upgrade", pane);
  saved.layouts[0]!.paneState = { [pane.instanceId]: { pluginState: { news: { [`${newsKey}:v2`]: [legacy] } } } };
  const { config } = normalizeLoadedConfig(JSON.parse(JSON.stringify(saved)), saved.dataDir);
  const proUser = { ...verifiedUser, plan: "pro" } as const;
  apiClient.setSessionToken("verified-news-session");
  apiClient.restoreCachedUser(proUser);
  const services = createAppRuntime({
    config, plugins: [], persistence: new JsonPersistence(), tickerRepository: new JsonTickerRepository(),
    dataProvider: createTestDataProvider(),
  });
  try {
    await services.ready;
    const registry = services.pluginRegistry;
    registry.newsPaneSnapshots.write(pane, "news", `${newsKey}:v2`, cloudNewsSnapshotScope()!, [paid]);
    const state = createInitialState(config);
    let setArticles!: (articles: MarketNewsItem[]) => void;
    function Probe() {
      const [articles, update] = useState<MarketNewsItem[]>([]);
      setArticles = update;
      const visible = usePersistedNewsArticles(newsKey, articles);
      return <Text>{visible.map((article) => article.title).join(", ") || "No headlines"}</Text>;
    }
    await tui.render(<TestPaneProvider state={state} paneId={pane.instanceId} pluginId="news" runtime={registry}>
      <Probe />
    </TestPaneProvider>);
    await tui.waitForFrameToContain(paid.title);
    await act(async () => {
      apiClient.setSessionToken("unconfirmed-news-session");
      apiClient.restoreCachedUser(proUser, false);
    });
    expect(cloudNewsSnapshotScope()).toBeNull();
    expect(await tui.waitForFrameToContain(legacy.title)).not.toContain(paid.title);
    await act(async () => { setArticles([live]); });
    expect(await tui.waitForFrameToContain(live.title)).not.toContain(paid.title);
    await act(async () => { setArticles([]); });
    await tui.waitForFrameToContain(legacy.title);
    await act(async () => { apiClient.restoreCachedUser(proUser); });
    expect(await tui.waitForFrameToContain(paid.title)).not.toContain(live.title);
  } finally {
    await tui.destroy();
    services.destroy();
    apiClient.dispose();
    apiClient.setSessionToken(null);
  }
});

function harness(snapshot: unknown, fresh: MarketNewsItem[] = []) {
  const initial = createInitialState(createDefaultConfig("/tmp/gloom-news-publisher-test"));
  initial.paneState[paneId] = { pluginState: { news: { [key]: snapshot } } };
  const stateRef: { current: AppState } = { current: initial };
  let setArticles: (articles: MarketNewsItem[]) => void = () => {};
  const runtime = createTestPluginRuntime();
  function Probe() {
    const [articles, update] = useState(fresh);
    setArticles = update;
    const visible = usePersistedStory(articles);
    return <Text>{visible.map((article) => article.source).join(", ") || "No articles"}</Text>;
  }
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    stateRef.current = state;
    return <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="news" runtime={runtime}>
      <Probe />
    </TestPaneProvider>;
  }
  return { Harness, setArticles: (articles: MarketNewsItem[]) => setArticles(articles),
    snapshot: () => stateRef.current.paneState[paneId]?.pluginState?.news?.[key] };
}

test("publisher and original-link corrections survive a restart with unchanged story identity and time", async () => {
  const article = createTestArticle("story", { source: "Actual Publisher", url: "https://publisher.example/story" });
  const stored = { ...article, publishedAt: article.publishedAt.toISOString(), source: "Old credit", url: "https://delivery.example/story" };
  const scenario = harness([stored], [article]);
  await tui.render(<scenario.Harness />);
  await tui.waitForFrameToContain("Actual Publisher");
  await tui.renderFrames(1);
  expect(scenario.snapshot()).toMatchObject([{ source: article.source, url: article.url }]);
  await act(async () => { scenario.setArticles([]); });
  expect(await tui.waitForFrameToContain("Actual Publisher")).not.toContain("Old credit");
  await tui.destroy();
  const restarted = harness(scenario.snapshot());
  await tui.render(<restarted.Harness />);
  expect(await tui.waitForFrameToContain("Actual Publisher")).not.toContain("Old credit");
});

test("a folded row of routine notices restored from the pane's state reads its notices' first day again", async () => {
  const article = createTestArticle("notice", { title: "Transaction in own shares", source: "HKEXnews", publishedAt: new Date("2026-11-10T18:19:26.000Z"),
    routine: { kind: "buyback", notices: 8, since: new Date("2026-10-30T18:32:16.000Z"), programme: null } });
  const first = harness([], [article]);
  await tui.render(<first.Harness />);
  await tui.waitForFrameToContain("HKEXnews");
  await tui.renderFrames(1);
  // Pane state keeps dates as text, as a saved layout does.
  const saved = JSON.parse(JSON.stringify(first.snapshot()));
  expect(saved).toMatchObject([{ routine: { notices: 8, since: "2026-10-30T18:32:16.000Z" } }]);
  await tui.destroy();
  let restored: MarketNewsItem[] = [];
  const initial = createInitialState(createDefaultConfig("/tmp/gloom-news-publisher-test"));
  initial.paneState[paneId] = { pluginState: { news: { [key]: saved } } };
  function Probe() {
    restored = usePersistedStory([]);
    return <Text>{restored.map((item) => listedHeadline(item)).join(", ") || "No articles"}</Text>;
  }
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    return <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="news" runtime={createTestPluginRuntime()}>
      <Probe />
    </TestPaneProvider>;
  }
  await tui.render(<Harness />);
  await tui.waitForFrameToContain("8 notices since 30 Oct");
  expect(restored[0]?.routine?.since).toBeInstanceOf(Date);
  expect(restored[0]?.routine?.since.toISOString()).toBe("2026-10-30T18:32:16.000Z");
});
