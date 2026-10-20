import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { newsProvider } from "../../../../../capabilities";
import { NewsService } from "../../../../../news/aggregator";
import { setSharedNewsService } from "../../../../../news/hooks";
import { createOpenTuiTestHarness } from "../../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../../state/app/context";
import { createTestArticle } from "../../../../../test-support/news";
import { createTestPaneConfig, TestPaneFrame } from "../../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../../test-support/plugin-runtime";
import { NewsPresetPane } from "./preset-pane";

const tui = createOpenTuiTestHarness({ width: 120, height: 15 });
const query = { feed: "latest", limit: 200 } as const;

afterEach(() => setSharedNewsService(null));

for (const key of ["feeds", "disabledDefaultFeedIds"]) {
  test(`${key}: News shows unreadable settings even when Cloud finishes before RSS registers`, async () => {
    const service = new NewsService();
    const article = createTestArticle("available", { title: "Available market story" });
    service.register(newsProvider({
      id: "available", name: "Available news",
      provider: { fetchNews: async () => [article] },
    }));
    await service.load(query);
    setSharedNewsService(service);
    const config = createTestPaneConfig("/unused-news-settings", { instanceId: "news-feed", paneId: "news-feed" });
    config.pluginConfig.news = { [key]: '["broken"' };
    const runtime = createTestPluginRuntime();
    let repair: () => void = () => {};
    function Harness() {
      const [current, setConfig] = useState(config);
      repair = () => setConfig({ ...config, pluginConfig: { news: { [key]: [] } } });
      return <TestPaneFrame state={createInitialState(current)} paneId="news-feed" pluginId="news" runtime={runtime} width={120} height={15}>
        {(body) => <NewsPresetPane {...body} paneId="news-feed" paneType="news-feed" focused
          paneKey="feed" title="News Feed" query={query} columns={["time", "title"]}
          defaultSort={{ columnId: "time", direction: "desc" }}
          emptyStateTitle="No feed stories yet" emptyStateHint="" />}
      </TestPaneFrame>;
    }
    try {
      await act(async () => { await tui.render(<Harness />); });
      const failed = await tui.waitForFrameToContain("News feed settings could not be read. Saved settings were kept.");
      expect(failed).toContain("Available market story");

      await act(async () => { repair(); });
      expect(await tui.waitForFrameToExclude("News feed settings could not be read"))
        .toContain("Available market story");
    } finally {
      service.stop();
    }
  });
}
