import { expect, test } from "bun:test";
import { act, useReducer, useState } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../../state/app/context";
import { createTestArticle } from "../../../../test-support/news";
import { TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../../types/config";
import type { MarketNewsItem } from "../../../../types/news-source";
import { Text } from "../../../../ui";
import { usePersistedNewsArticles } from "./persisted-articles";

const tui = createOpenTuiTestHarness({ width: 80, height: 5 });
const paneId = "news-feed:test";
const key = "feed:articles";

function harness(snapshot: unknown, fresh: MarketNewsItem[] = [], legacy = false) {
  const initial = createInitialState(createDefaultConfig("/tmp/gloom-news-publisher-test"));
  initial.paneState[paneId] = { pluginState: { news: { [legacy ? key : `${key}:v2`]: snapshot } } };
  const stateRef: { current: AppState } = { current: initial };
  let setArticles: (articles: MarketNewsItem[]) => void = () => {};
  const runtime = createTestPluginRuntime();
  function Probe() {
    const [articles, update] = useState(fresh);
    setArticles = update;
    const visible = usePersistedNewsArticles(key, articles);
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
    snapshot: () => stateRef.current.paneState[paneId]?.pluginState?.news?.[`${key}:v2`],
    legacySnapshot: () => stateRef.current.paneState[paneId]?.pluginState?.news?.[key] };
}

test("old pane snapshots cannot restore intermediary publisher credits while news is unavailable", async () => {
  const article = createTestArticle("story", { source: "Old delivery service" });
  const scenario = harness([{ ...article, publishedAt: article.publishedAt.toISOString() }], [], true);
  await tui.render(<scenario.Harness />);
  expect(await tui.waitForFrameToContain("No articles")).not.toContain("Old delivery service");
  await tui.renderFrames(1);
  expect(scenario.legacySnapshot()).toBeUndefined();
  expect(scenario.snapshot()).toBeUndefined();
});

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
