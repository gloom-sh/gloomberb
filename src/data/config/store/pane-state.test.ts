import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type LayoutConfig } from "../../../types/config";
import { normalizeLoadedConfig } from "./normalize";
import { hasLegacyPaneSnapshots, sanitizeSavedPaneState } from "./pane-state";

const layout = {
  dockRoot: { kind: "pane", instanceId: "news-top:main" },
  instances: [
    { instanceId: "news-top:main", paneId: "news-top", binding: { kind: "none" } },
    { instanceId: "ticker-news:main", paneId: "ticker-news", binding: { kind: "none" } },
  ],
  floating: [],
  detached: [],
} as unknown as LayoutConfig;

describe("pane state written to the config", () => {
  test("loading a current config schedules removal of old article snapshots without losing choices", () => {
    const config = createDefaultConfig(":memory:");
    const paneState = {
      "news-top:main": { pluginState: { news: {
        "top:curated:articles:v2": [{ id: "story" }],
        "top:curated:selectedArticleId": "story",
      } } },
    };
    const result = normalizeLoadedConfig({
      ...config,
      layout,
      layouts: [{ name: "News", layout, paneState }],
    }, ":memory:");
    expect(result.needsSave).toBe(true);
    expect(result.config.layouts[0]?.paneState?.["news-top:main"]).toEqual({
      pluginState: { news: { "top:curated:selectedArticleId": "story" } },
    });
    expect(paneState["news-top:main"].pluginState.news["top:curated:articles:v2"]).toEqual([{ id: "story" }]);
  });

  test("the news panes' articles an older build saved are dropped, and every setting beside them kept", () => {
    const articles = [{ id: "story", title: "Nvidia tops estimates" }];
    const saved = sanitizeSavedPaneState({
      "news-top:main": {
        pluginState: {
          news: { "top:curated:articles:v2": articles, "industry:topic:MNA:articles:v2": articles, "feed:articles:v2": articles, "breaking:articles:v2": articles, "story:v2": articles, "top:curated:selectedArticleId": "story" },
        },
      },
      "ticker-news:main": {
        pluginState: { news: { "articles:BTC-USD:CCC:v2": articles } },
      },
      "gone:main": { pluginState: { news: { "top:curated:articles:v2": articles } } },
    }, layout);

    expect(hasLegacyPaneSnapshots(saved)).toBe(false);
    expect(saved).toEqual({
      "news-top:main": { pluginState: { news: { "top:curated:selectedArticleId": "story" } } },
      "ticker-news:main": {},
    });
  });
});
