import { describe, expect, test } from "bun:test";
import type { GloomPluginContext, PaneTemplateDef } from "../../../types/plugin";
import { createTestTemplateContext } from "../../../test-support/headless";
import { createFeed } from "./model";
import { registerTwitterFeedFeature } from "./registration";

const context = createTestTemplateContext();

function twitterTemplate(): PaneTemplateDef {
  let template: PaneTemplateDef | null = null;
  registerTwitterFeedFeature({
    registerTickerResearchTab() {},
    registerPane() {},
    registerCommand() {},
    registerPaneTemplate(value) { template = value; },
  } as unknown as GloomPluginContext);
  if (!template) throw new Error("X Feed template was not registered");
  return template;
}

describe("X Feed pane sharing", () => {
  test("restores the active advanced-search query", async () => {
    const template = twitterTemplate();
    const first = createFeed("$SPY", "Latest");
    const active = createFeed("$NVDA OR $AMD", "Top");
    const shared = template.publicShare?.serialize({
      pane: {
        instanceId: "twitter-feed:private-query-id",
        paneId: "twitter-feed",
        params: { query: "old", queryType: "Latest" },
      },
      paneState: {
        pluginState: {
          "gloomberb-cloud": {
            feeds: { feeds: [first, active] },
            activeFeedId: active.id,
          },
        },
      },
    });

    expect(shared?.data).toEqual({ query: "$NVDA OR $AMD", queryType: "Top" });
    const options = template.publicShare?.restore(shared!.data);
    const instance = await template.createInstance?.(context, options ?? undefined);
    expect(instance?.params).toEqual({ query: "$NVDA OR $AMD", queryType: "Top" });
  });
});
