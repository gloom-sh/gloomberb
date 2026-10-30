import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient, type CloudNewsPayload } from "../../../../../api-client";
import { NewsService } from "../../../../../news/aggregator";
import { setSharedNewsService } from "../../../../../news/hooks";
import type { NewsCapability } from "../../../../../capabilities";
import { createGloomberbCloudCapabilities } from "../../../../../sources/gloomberb-cloud";
import { createOpenTuiTestHarness, settleFrame } from "../../../../../renderers/opentui/test-utils";
import { TestPaneProvider, createTestPaneConfig } from "../../../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../../../test-support/plugin-runtime";
import { createInitialState, appReducer } from "../../../../../state/app/context";
import { parsePaneFunctionArgs } from "../../../../../cli/pane-functions/options";
import { resolvePaneFunction } from "../../../../../cli/pane-functions/resolver";
import type { PaneFunctionCatalog } from "../../../../../cli/pane-functions/catalog";
import type { MarketContext } from "../../../../../cli/types";
import { createDefaultConfig } from "../../../../../types/config";
import { Box } from "../../../../../ui";
import { newsWireModule } from "..";
import { NewsStoryPane } from "./pop-out";

const FULL_ID = "6067684e-2e13-41c5-a7cf-5052b3cefc07";
const tui = createOpenTuiTestHarness();
const originalGetCloudNewsStory = apiClient.getCloudNewsStory.bind(apiClient);
let service: NewsService | null = null;

afterEach(() => {
  apiClient.getCloudNewsStory = originalGetCloudNewsStory;
  service?.stop();
  setSharedNewsService(null);
});

function cloudStory(id: string): CloudNewsPayload {
  return {
    id,
    headline: "Allstate Says Impersonation Scams Lead Top 2026 Scam Cases",
    summary: "Allstate warns that impersonation scams are leading its reported scam cases in 2026.",
    category: "general", sentiment: "neutral", sectors: [],
    firstPublishedAt: "2026-10-29T13:03:00.000Z", lastPublishedAt: "2026-10-29T13:03:00.000Z",
    firstSeenAt: "2026-10-29T13:03:10.000Z", lastSeenAt: "2026-10-29T13:03:10.000Z",
    primaryUrl: "https://www.businesswire.com/news/home/20261029982574", primarySource: "business-wire",
    variantCount: 1, sourceCount: 1, sources: ["business-wire"], entities: [], tickerLinks: [],
  };
}

/**
 * `fn news-story-pane 6067684e` showed "Story unavailable.": Gloom Cloud
 * answers the short id `news` prints with the full id of the story it starts,
 * and the load threw "Story detail identity mismatch" on the difference.
 */
test("fn news-story-pane opens the story a short id names when Gloom Cloud answers with its full id", async () => {
  const asked: string[] = [];
  apiClient.getCloudNewsStory = async (storyId) => {
    asked.push(storyId);
    return cloudStory(FULL_ID);
  };
  service = new NewsService({ pollIntervalMs: 60_000 });
  service.register(createGloomberbCloudCapabilities().find((capability) => capability.kind === "news") as NewsCapability);
  setSharedNewsService(service);

  // The pane `fn news-story-pane 6067684e` opens, as the resolver builds it.
  const catalog: PaneFunctionCatalog = {
    panes: new Map((newsWireModule.panes ?? []).map((entry) => [entry.id, entry])),
    paneTemplates: new Map((newsWireModule.paneTemplates ?? []).map((entry) => [entry.id, entry])),
    destroy: () => {},
  };
  const context = { config: createDefaultConfig("/tmp/news-story-short-id-unused") } as MarketContext;
  const { instance } = await resolvePaneFunction(catalog, context,
    parsePaneFunctionArgs(["news-story-pane", "6067684e"]), { command: "shot" });
  expect(instance.params).toEqual({ articleId: "6067684e" });

  const config = createTestPaneConfig("/tmp/news-story-short-id-unused", { instanceId: "story", paneId: instance.paneId, params: instance.params });
  const initial = createInitialState(config);
  initial.focusedPaneId = "story";
  const runtime = createStatefulTestPluginRuntime();
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    return (
      <TestPaneProvider state={state} dispatch={dispatch} paneId="story" pluginId="news" runtime={runtime}>
        <Box width={100} height={20}>
          <NewsStoryPane paneId="story" paneType={instance.paneId} focused width={100} height={20} />
        </Box>
      </TestPaneProvider>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 20 }); });
  await settleFrame(tui.setup(), 12);

  const frame = tui.frame();
  expect(asked[0]).toBe("6067684e");
  expect(frame).toContain("Allstate warns that impersonation scams");
  expect(frame).not.toContain("Story unavailable");
  expect(frame).not.toContain("identity mismatch");
  // Another story's id is still a mismatch, never shown as this one.
  apiClient.getCloudNewsStory = async () => cloudStory("1234abcd-2e13-41c5-a7cf-5052b3cefc07");
  await expect(service.loadStory("6067684e")).rejects.toThrow("Story detail unavailable.");
});
