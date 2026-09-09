import { describe, expect, test } from "bun:test";
import type { PluginRegistry } from "../plugins/registry";
import type { ContextMenuItem } from "../types/context-menu";
import type { TickerRecord } from "../types/ticker";
import {
  editableTextContextMenuItems,
  linkContextMenuItems,
  tickerContextMenuItems,
} from "./context-menu";

function ticker(overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return {
    metadata: {
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple",
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

function menuLabels(items: ContextMenuItem[]): string[] {
  return items.flatMap((item) => item.type === "divider" ? [] : [item.label ?? ""]);
}

describe("context menu item builders", () => {
  test("editable text menu returns native edit roles", () => {
    expect(editableTextContextMenuItems().map((item) => item.type === "role" ? item.role : "divider")).toEqual([
      "undo",
      "redo",
      "divider",
      "cut",
      "copy",
      "paste",
      "divider",
      "selectAll",
    ]);
  });

  test("link menu includes open and copy actions", () => {
    const labels = menuLabels(linkContextMenuItems({
      url: "https://example.com",
      open: () => {},
      copy: () => {},
    }));

    expect(labels).toEqual(["Open Link", "Copy Link"]);
  });

  test("ticker menu includes plugin ticker actions and hides remove actions without memberships", () => {
    const registry = {
      getEnabledTickerActions() { return [...this.tickerActions.values()]; },
    tickerActions: new Map([
        ["alert", {
          id: "alert",
          label: "Set Alert",
          execute: () => {},
        }],
      ]),
      navigateTicker: () => {},
      pinTicker: () => {},
      openCommandBar: () => {},
    } as unknown as PluginRegistry;

    const labels = menuLabels(tickerContextMenuItems({
      ticker: ticker(),
      financials: null,
      registry,
      copyText: async () => {},
    }));

    expect(labels).toContain("Set Alert");
    expect(labels).toContain("Add to Watchlist...");
    expect(labels).not.toContain("Remove from Watchlist...");
    expect(labels).not.toContain("Remove from Portfolio...");
  });

  test("ticker menu includes remove actions when memberships exist", () => {
    const labels = menuLabels(tickerContextMenuItems({
      ticker: ticker({ watchlists: ["watchlist:tech"], portfolios: ["portfolio:main"] }),
      financials: null,
      registry: null,
      copyText: async () => {},
    }));

    expect(labels).toContain("Remove from Watchlist...");
    expect(labels).toContain("Remove from Portfolio...");
  });
});
