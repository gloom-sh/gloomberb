import { describe, expect, test } from "bun:test";
import type { LayoutMarketplacePayload } from "./portable-layout";
import type { PaneDef, PaneTemplateDef } from "../types/plugin";
import { buildPaneSharePayload, openPaneShare } from "./pane";
import { getLoadablePlugins } from "../plugins/catalog";

const paneDef: PaneDef = {
  id: "ticker-news",
  name: "Ticker News",
  component: () => null,
  defaultPosition: "right",
};

function registry(template?: PaneTemplateDef, pane: PaneDef = paneDef) {
  const opened: unknown[] = [];
  const portable: LayoutMarketplacePayload[] = [];
  return {
    opened,
    portable,
    panes: new Map([[pane.id, pane]]),
    paneTemplates: new Map(template ? [[template.id, template]] : []),
    createPaneFromTemplateAsync: async (templateId: string, options: unknown) => {
      opened.push([templateId, options]);
    },
    openPortablePaneShareAsync: async (layout: LayoutMarketplacePayload) => {
      portable.push(layout);
    },
  } as any;
}

describe("public pane shares", () => {
  test("publishes registered panes through the generic portable projection", async () => {
    const pluginRegistry = registry({
      id: "ticker-news-pane",
      paneId: "ticker-news",
      label: "Ticker News",
      description: "Current news for a ticker.",
    });
    const payload = buildPaneSharePayload(pluginRegistry, {
      instanceId: "news:private-local-id",
      paneId: "ticker-news",
      title: "AAPL News",
      binding: { kind: "fixed", symbol: "AAPL" },
      params: { query: "earnings" },
      settings: { dense: true, sessionToken: "secret" },
    }, {
      pluginState: { news: { selectedTab: "latest", accessToken: "secret" } },
    });

    expect(payload).toMatchObject({
      kind: "pane",
      data: {
        version: 2,
        title: "AAPL News",
        description: "Current news for a ticker.",
        layout: {
          schemaVersion: 2,
          layout: {
            instances: [{
              instanceId: "p1",
              paneId: "ticker-news",
              binding: { kind: "fixed", symbol: "AAPL" },
              params: { query: "earnings" },
              settings: { dense: true },
            }],
          },
          paneState: {
            p1: { pluginState: { news: { selectedTab: "latest" } } },
          },
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("private-local-id");
    expect(JSON.stringify(payload)).not.toContain("secret");

    await openPaneShare(pluginRegistry, payload!.data);
    expect(pluginRegistry.portable).toEqual([payload!.data.version === 2 ? payload!.data.layout : null]);
  });

  test.each([
    { paneType: "ticker-research", settings: { expiration: 1800000000, expirationTargetKey: "EXAMPLE:NASDAQ" }, state: { activeTabId: "options" } },
    { paneType: "ticker-news", settings: {}, state: { pluginState: { news: { "openArticleId:EXAMPLE": "invented-story" } } } },
  ])("the global link reopens $paneType on the selected content", async ({ paneType, settings, state }) => {
    const def = getLoadablePlugins().flatMap(plugin => plugin.panes ?? []).find(pane => pane.id === paneType)!;
    const host = registry(undefined, def);
    const payload = buildPaneSharePayload(host, { instanceId: "selected", paneId: paneType, settings, binding: { kind: "fixed", symbol: "EXAMPLE" } }, state);
    if (payload?.data.version !== 2) throw new Error("expected a portable share");
    await openPaneShare(host, payload.data);
    const reopened = host.portable[0] as LayoutMarketplacePayload;
    expect(reopened.layout.instances[0]?.settings ?? {}).toEqual(settings);
    expect(reopened.layout.instances[0]?.binding).toEqual({ kind: "fixed", symbol: "EXAMPLE" });
    expect(reopened.paneState?.p1).toEqual(state);
  });

  test("opens legacy adapter shares for existing links", async () => {
    const template: PaneTemplateDef = {
      id: "ticker-news-pane",
      paneId: "ticker-news",
      label: "Ticker News",
      description: "Current news for a ticker.",
      publicShare: {
        serialize: () => null,
        restore: (data) => typeof data.symbol === "string" ? { symbol: data.symbol } : null,
      },
    };
    const pluginRegistry = registry(template);

    await openPaneShare(pluginRegistry, {
      version: 1,
      templateId: template.id,
      title: "AAPL News",
      data: { symbol: "AAPL" },
    });

    expect(pluginRegistry.opened).toEqual([["ticker-news-pane", { symbol: "AAPL" }]]);
  });

  test("does not share unregistered panes", () => {
    const pluginRegistry = registry();
    pluginRegistry.panes.clear();
    expect(buildPaneSharePayload(pluginRegistry, {
      instanceId: "missing:main",
      paneId: "missing",
    })).toBeNull();
  });
});
