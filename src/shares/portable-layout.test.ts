import { describe, expect, test } from "bun:test";
import type { PaneRuntimeState } from "../core/state/app/types";
import type { PaneDef } from "../types/plugin";
import {
  materializeMarketplaceLayout,
  parseMarketplaceLayoutEntry,
  parseMarketplaceLayoutList,
  publishableMarketplaceLayout,
  publishableMarketplacePane,
} from "./portable-layout";

const component = () => null;
const panes = new Map<string, PaneDef>([
  ["twitter-feed", {
    id: "twitter-feed",
    name: "X Feed",
    component,
    defaultPosition: "right",
  }],
  ["prediction-markets", {
    id: "prediction-markets",
    name: "Prediction Markets",
    component,
    defaultPosition: "right",
  }],
  ["portfolio-list", {
    id: "portfolio-list",
    name: "Portfolio",
    component,
    defaultPosition: "left",
    portableShare: {
      private: { title: true, params: true, settings: true, state: true },
    },
  }],
]);

function portableFixture() {
  const feedId = "twitter-feed:from:@private-user";
  const predictionId = "prediction-markets:fed-search";
  const portfolioId = "portfolio-list:private-account";
  const layout = {
    dockRoot: {
      kind: "split" as const,
      axis: "horizontal" as const,
      ratio: 0.6,
      first: { kind: "pane" as const, instanceId: feedId },
      second: {
        kind: "split" as const,
        axis: "vertical" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: predictionId },
        second: { kind: "pane" as const, instanceId: portfolioId },
      },
    },
    instances: [
      {
        instanceId: feedId,
        paneId: "twitter-feed",
        title: "Semiconductor X Feed",
        params: { query: "$NVDA OR $AMD", queryType: "Latest" },
        settings: { dense: true, accessToken: "must-not-leave-device" },
        binding: { kind: "none" as const },
        placementMemory: { floating: { x: 1, y: 2, width: 20, height: 8 } },
      },
      {
        instanceId: predictionId,
        paneId: "prediction-markets",
        params: { query: "fed", scope: "polymarket" },
        binding: { kind: "follow" as const, sourceInstanceId: feedId },
      },
      {
        instanceId: portfolioId,
        paneId: "portfolio-list",
        title: "Family account",
        params: { collectionId: "family" },
        settings: { visibleCollectionIds: ["family"] },
        binding: { kind: "none" as const },
      },
    ],
    floating: [],
    detached: [],
  };
  const paneState: Record<string, PaneRuntimeState> = {
    [feedId]: {
      pluginState: {
        "gloomberb-cloud": {
          feeds: {
            feeds: [{ id: "feed-1", query: "$NVDA OR $AMD", queryType: "Latest" }],
          },
          sessionToken: "must-not-leave-device",
        },
      },
    },
    [predictionId]: {
      pluginState: {
        "prediction-markets": {
          venueScope: "polymarket",
          searchQuery: "fed",
          browseTab: "top",
        },
      },
    },
    [portfolioId]: {
      collectionId: "family",
      pluginState: { portfolio: { currentValue: 1_000_000 } },
    },
  };
  return { layout, paneState };
}

function validEntry() {
  const fixture = portableFixture();
  const payload = publishableMarketplaceLayout(fixture.layout, fixture.paneState, panes);
  return {
    id: "0123456789abcdef0123456789abcdef",
    name: "Social Desk",
    ...payload,
    author: { username: "analyst", displayName: "Analyst" },
    publishedAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("layout marketplace payloads", () => {
  test("projects one pane through the same privacy contract", () => {
    const pane = publishableMarketplacePane({
      instanceId: "twitter-feed:private-source",
      paneId: "twitter-feed",
      title: "Semiconductor X Feed",
      params: { query: "$NVDA OR $AMD" },
      settings: { dense: true, accessToken: "secret" },
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:private" },
    }, {
      pluginState: {
        "gloomberb-cloud": {
          feeds: { feeds: [{ query: "$NVDA OR $AMD" }] },
          sessionToken: "secret",
        },
      },
    }, panes, "NVDA");

    expect(pane.layout.instances).toEqual([{
      instanceId: "p1",
      paneId: "twitter-feed",
      title: "Semiconductor X Feed",
      params: { query: "$NVDA OR $AMD" },
      settings: { dense: true },
      binding: { kind: "fixed", symbol: "NVDA" },
    }]);
    expect(pane.paneState.p1).toMatchObject({
      pluginState: {
        "gloomberb-cloud": {
          feeds: { feeds: [{ query: "$NVDA OR $AMD" }] },
        },
      },
    });
    expect(JSON.stringify(pane)).not.toContain("private-source");
    expect(JSON.stringify(pane)).not.toContain("secret");
  });

  test("drops cache-sized pane state instead of failing the share", () => {
    const pane = publishableMarketplacePane({
      instanceId: "news-top:main",
      paneId: "prediction-markets",
      binding: { kind: "none" },
    }, {
      sort: { columnId: "time", direction: "desc" },
      "news-top:articles": Array.from({ length: 400 }, (_, index) => ({
        id: `article-${index}`,
        title: "x".repeat(200),
        publishedAt: "2026-08-26T00:00:00.000Z",
      })),
    }, panes);

    expect(pane.paneState.p1).toEqual({ sort: { columnId: "time", direction: "desc" } });
  });

  test("drops an oversized plugin-state key without taking the pane's open item with it", () => {
    const pane = publishableMarketplacePane({
      instanceId: "news-top:main",
      paneId: "prediction-markets",
      binding: { kind: "none" },
    }, {
      pluginState: {
        news: {
          "news-top:openArticleId": "article-7",
          "news-top:articles": Array.from({ length: 400 }, (_, index) => ({
            id: `article-${index}`,
            title: "x".repeat(200),
            publishedAt: "2026-08-26T00:00:00.000Z",
          })),
        },
      },
    }, panes);

    expect(pane.paneState.p1).toEqual({
      pluginState: { news: { "news-top:openArticleId": "article-7" } },
    });
  });

  test("pins a fixed binding to its public listing key and leaves the broker contract behind", () => {
    const listed = publishableMarketplacePane({
      instanceId: "chart:1",
      paneId: "twitter-feed",
      binding: { kind: "fixed", symbol: "SHEL", listing: { exchange: "LSE", name: "Shell", currency: "GBp", type: "Common Stock" } },
    }, {}, panes);
    expect(listed.layout.instances[0]?.binding).toEqual({ kind: "fixed", symbol: "SHEL:XLON" });

    const brokered = publishableMarketplacePane({
      instanceId: "chart:2",
      paneId: "twitter-feed",
      binding: {
        kind: "fixed",
        symbol: "aapl",
        instrument: { brokerId: "ibkr", brokerInstanceId: "ibkr:1", conId: 265598, symbol: "AAPL", exchange: "SMART" } as never,
      },
    }, {}, panes);
    expect(brokered.layout.instances[0]?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });
    expect(JSON.stringify(brokered)).not.toContain("265598");
  });

  test("lets a pane pin what it resolved locally before it leaves the device", () => {
    const prepared = publishableMarketplacePane({
      instanceId: "chart:1",
      paneId: "pinning",
      settings: { symbol: "SHEL" },
    }, {}, new Map([["pinning", {
      id: "pinning",
      name: "Pinning",
      component,
      defaultPosition: "right",
      portableShare: {
        prepare: (pane, { tickers }) => ({
          ...pane,
          settings: { ...pane.settings, exchange: tickers.get(String(pane.settings?.symbol))?.metadata.exchange },
        }),
      },
    }]]), null, {
      tickers: new Map([["SHEL", { metadata: { ticker: "SHEL", exchange: "LSE" } } as never]]),
    });
    expect(prepared.layout.instances[0]?.settings).toEqual({ symbol: "SHEL", exchange: "LSE" });
  });

  test("shares portable pane setup and state while redacting private data", () => {
    const fixture = portableFixture();
    const payload = publishableMarketplaceLayout(fixture.layout, fixture.paneState, panes);

    expect(payload.schemaVersion).toBe(2);
    expect(payload.layout.instances.map((instance) => instance.instanceId)).toEqual(["p1", "p2", "p3"]);
    expect(payload.layout.instances[0]).toEqual({
      instanceId: "p1",
      paneId: "twitter-feed",
      title: "Semiconductor X Feed",
      params: { query: "$NVDA OR $AMD", queryType: "Latest" },
      settings: { dense: true },
      binding: { kind: "none" },
    });
    expect(payload.layout.instances[1]?.binding).toEqual({ kind: "follow", sourceInstanceId: "p1" });
    expect(payload.layout.instances[2]).toEqual({
      instanceId: "p3",
      paneId: "portfolio-list",
      binding: { kind: "none" },
    });
    expect(payload.paneState.p1).toMatchObject({
      pluginState: {
        "gloomberb-cloud": {
          feeds: { feeds: [{ query: "$NVDA OR $AMD", queryType: "Latest" }] },
        },
      },
    });
    expect(payload.paneState.p2).toMatchObject({
      pluginState: { "prediction-markets": { searchQuery: "fed" } },
    });
    expect(payload.paneState.p3).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("must-not-leave-device");
    expect(JSON.stringify(payload)).not.toContain("family");
    expect(JSON.stringify(payload)).not.toContain("private-user");
    expect(JSON.stringify(payload)).not.toContain("placementMemory");
  });

  test("keeps the config of a pane whose plugin is not installed here", () => {
    const payload = publishableMarketplaceLayout({
      dockRoot: { kind: "pane", instanceId: "tv:1" },
      instances: [{
        instanceId: "tv:1",
        paneId: "gloomberb-tv:screener",
        title: "Movers",
        params: { universe: "sp500" },
        settings: { dense: true, apiKey: "leak" },
      }],
      floating: [],
      detached: [],
    }, { "tv:1": { cursorSymbol: "NVDA", password: "no" } }, panes);
    expect(payload.layout.instances[0]).toEqual({
      instanceId: "p1",
      paneId: "gloomberb-tv:screener",
      title: "Movers",
      params: { universe: "sp500" },
      settings: { dense: true },
    });
    expect(payload.paneState.p1).toEqual({ cursorSymbol: "NVDA" });
    expect(JSON.stringify(payload)).not.toContain("leak");
    expect(JSON.stringify(payload)).not.toContain("password");
  });

  test("keeps team-scoped collection references and drops personal ones", () => {
    const layout = {
      dockRoot: { kind: "pane" as const, instanceId: "pl:1" },
      instances: [{
        instanceId: "pl:1",
        paneId: "portfolio-list",
        params: { collectionId: "team:org-1:abc" },
        settings: { collectionId: "team:org-1:abc", visibleCollectionIds: ["team:org-1:abc", "team:org-1:def"] },
      }],
      floating: [],
      detached: [],
    };
    // The real portfolio pane marks the collection fields private by name.
    const portfolioPanes = new Map<string, PaneDef>([["portfolio-list", {
      id: "portfolio-list",
      name: "Portfolio",
      component,
      defaultPosition: "left",
      portableShare: {
        private: {
          params: ["collectionId"],
          settings: ["collectionId", "visibleCollectionIds"],
          state: ["collectionId", "collectionSorts"],
        },
      },
    }]]);
    const team = publishableMarketplaceLayout(layout, { "pl:1": { collectionId: "team:org-1:abc" } }, portfolioPanes);
    expect(team.layout.instances[0]?.params).toEqual({ collectionId: "team:org-1:abc" });
    expect(team.layout.instances[0]?.settings).toEqual({
      collectionId: "team:org-1:abc",
      visibleCollectionIds: ["team:org-1:abc", "team:org-1:def"],
    });
    expect(team.paneState.p1).toEqual({ collectionId: "team:org-1:abc" });

    const personal = publishableMarketplaceLayout({
      ...layout,
      instances: [{ ...layout.instances[0]!, params: { collectionId: "main" }, settings: { collectionId: "broker:ibkr:x", visibleCollectionIds: ["team:org-1:abc", "main"] } }],
    }, { "pl:1": { collectionId: "main" } }, portfolioPanes);
    expect(personal.layout.instances[0]?.params).toBeUndefined();
    expect(personal.layout.instances[0]?.settings).toBeUndefined();
    expect(personal.paneState.p1).toBeUndefined();
  });

  test("round-trips a custom view spec through publish and materialize unchanged", () => {
    const spec = JSON.stringify({
      version: 1,
      source: { kind: "inline", pane: "SCR", argument: "sp500", options: { limit: 50 } },
      projection: { columns: [{ key: "symbol" }, { key: "change", transform: "percent" }], filters: [{ key: "change", op: "gt", value: 0.02 }], sort: { by: "change", direction: "desc" } },
      presentation: { title: "Movers", symbolKey: "symbol" },
    });
    const viewPanes = new Map<string, PaneDef>([["custom-view", { id: "custom-view", name: "View", component, defaultPosition: "right" }]]);
    const layout = {
      dockRoot: { kind: "pane" as const, instanceId: "view:1" },
      instances: [{ instanceId: "view:1", paneId: "custom-view", title: "Movers", settings: { spec } }],
      floating: [],
      detached: [],
    };
    const payload = publishableMarketplaceLayout(layout, {}, viewPanes);
    expect(payload.layout.instances[0]?.settings).toEqual({ spec });
    const materialized = materializeMarketplaceLayout(payload);
    expect(materialized.layout.instances[0]?.settings).toEqual({ spec });
    const shared = publishableMarketplacePane(layout.instances[0]!, {}, viewPanes);
    expect(shared.layout.instances[0]?.settings).toEqual({ spec });
  });

  test("materializes independent pane ids and rewrites state and follow bindings", () => {
    const entry = validEntry();
    const materialized = materializeMarketplaceLayout(
      entry,
      (paneId, index) => `${paneId}:copy-${index + 1}`,
    );

    expect(materialized.layout.instances.map((instance) => instance.instanceId)).toEqual([
      "twitter-feed:copy-1",
      "prediction-markets:copy-2",
      "portfolio-list:copy-3",
    ]);
    expect(materialized.layout.instances[1]?.binding).toEqual({
      kind: "follow",
      sourceInstanceId: "twitter-feed:copy-1",
    });
    expect(materialized.paneState["twitter-feed:copy-1"]).toEqual(entry.paneState.p1);
    expect(materialized.paneState.p1).toBeUndefined();
  });

  test("accepts old structural entries and rejects malformed or private v2 responses", () => {
    const entry = validEntry();
    expect(parseMarketplaceLayoutList({ items: [entry] })).toEqual([entry]);

    const legacy = {
      ...entry,
      schemaVersion: 1,
      layout: {
        dockRoot: { kind: "pane", instanceId: "legacy:query-is-visible" },
        instances: [{ instanceId: "legacy:query-is-visible", paneId: "twitter-feed" }],
        floating: [],
        detached: [],
      },
    } as Record<string, unknown>;
    delete legacy.paneState;
    expect(parseMarketplaceLayoutEntry(legacy)).toMatchObject({ schemaVersion: 1, paneState: {} });

    const privateResponse = structuredClone(entry);
    privateResponse.layout.instances[0]!.settings = { sessionToken: "secret" };
    expect(parseMarketplaceLayoutEntry(privateResponse)).toBeNull();

    const rawIds = structuredClone(entry);
    rawIds.layout.instances[0]!.instanceId = "twitter-feed:raw-query";
    expect(parseMarketplaceLayoutEntry(rawIds)).toBeNull();

    const dangling = structuredClone(entry);
    dangling.layout.dockRoot = { kind: "pane", instanceId: "p99" };
    expect(parseMarketplaceLayoutEntry(dangling)).toBeNull();
  });
});
