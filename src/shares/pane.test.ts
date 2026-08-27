import { describe, expect, test } from "bun:test";
import { buildPaneSharePayload, openPaneShare } from "./pane";
import type { PaneTemplateDef } from "../types/plugin";

function registry(template: PaneTemplateDef) {
  const opened: unknown[] = [];
  return {
    opened,
    paneTemplates: new Map([[template.id, template]]),
    createPaneFromTemplateAsyncFn: async (templateId: string, options: unknown) => {
      opened.push([templateId, options]);
    },
  } as any;
}

describe("public pane shares", () => {
  test("publishes only through an explicit template adapter", async () => {
    const template: PaneTemplateDef = {
      id: "ticker-news-pane",
      paneId: "ticker-news",
      label: "Ticker News",
      description: "Current news for a ticker.",
      publicShare: {
        serialize: ({ pane }) => pane.binding?.kind === "fixed"
          ? { title: `${pane.binding.symbol} News`, data: { symbol: pane.binding.symbol } }
          : null,
        restore: (data) => typeof data.symbol === "string" ? { symbol: data.symbol } : null,
      },
    };
    const pluginRegistry = registry(template);
    const payload = buildPaneSharePayload(pluginRegistry, {
      instanceId: "news:AAPL",
      paneId: "ticker-news",
      binding: { kind: "fixed", symbol: "AAPL" },
      settings: { privateCache: "not-published" },
    });

    expect(payload).toEqual({
      kind: "pane",
      data: {
        version: 1,
        templateId: "ticker-news-pane",
        title: "AAPL News",
        description: "Current news for a ticker.",
        data: { symbol: "AAPL" },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("privateCache");

    await openPaneShare(pluginRegistry, payload!.data);
    expect(pluginRegistry.opened).toEqual([["ticker-news-pane", { symbol: "AAPL" }]]);
  });

  test("does not share templates without an adapter", () => {
    const pluginRegistry = registry({
      id: "account-pane",
      paneId: "account",
      label: "Account",
      description: "Private account data.",
    });
    expect(buildPaneSharePayload(pluginRegistry, {
      instanceId: "account",
      paneId: "account",
      settings: { token: "secret" },
    })).toBeNull();
  });
});
