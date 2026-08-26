import { describe, expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import {
  buildOwnedEntries,
  describeArrangement,
  filterGalleryEntries,
  missingPaneIds,
  summarizeLayoutPanes,
} from "./model";
import { paneImagery } from "./pane-imagery";

function paneDef(id: string, name: string, icon: string): PaneDef {
  return {
    id,
    name,
    icon,
    component: () => null,
    defaultPosition: "left",
  };
}

const panes = new Map<string, PaneDef>([
  ["ticker-research", paneDef("ticker-research", "Ticker Research", "T")],
  ["portfolio-list", paneDef("portfolio-list", "Portfolio", "P")],
  ["chat", paneDef("chat", "Chat", "M")],
  ["ticker-chart", paneDef("ticker-chart", "Chart", "C")],
]);

function testLayout() {
  const layout = cloneLayout(createDefaultConfig("/tmp/gloomberb-gallery-model-test").layout);
  layout.instances = [
    ...layout.instances,
    { instanceId: "ticker-chart:1", paneId: "ticker-chart", binding: { kind: "fixed", symbol: "NVDA" } },
    { instanceId: "mystery:1", paneId: "mystery-pane" },
  ];
  layout.floating = [{ instanceId: "ticker-chart:1", x: 10, y: 4, width: 30, height: 12 }];
  layout.detached = [{ instanceId: "mystery:1", x: 60, y: 2, width: 24, height: 10 }];
  return layout;
}

describe("gallery layout summaries", () => {
  test("labels every pane, including uninstalled types, and keeps only public bindings", () => {
    const summaries = summarizeLayoutPanes(testLayout(), panes);

    const chart = summaries.find((pane) => pane.instanceId === "ticker-chart:1")!;
    expect(chart).toMatchObject({
      name: "Chart",
      icon: "C",
      symbol: "NVDA",
      placement: "floating",
      missing: false,
      imagery: "chart",
    });

    const missing = summaries.find((pane) => pane.instanceId === "mystery:1")!;
    // An unavailable pane still gets a readable label instead of a blank box.
    expect(missing).toMatchObject({ name: "mystery-pane", missing: true, placement: "detached" });
    expect(missing.icon.length).toBeGreaterThan(0);
    expect(summaries.every((pane) => pane.name.length > 0)).toBe(true);
    expect(missingPaneIds(testLayout(), panes)).toEqual(["mystery-pane"]);
  });

  test("counts placements without double counting floating or detached panes", () => {
    expect(describeArrangement(testLayout())).toBe("3 docked · 1 floating · 1 detached");
  });

  test("ignores saved instances that are no longer placed in the layout", () => {
    const layout = testLayout();
    layout.instances = [...layout.instances, { instanceId: "orphan:1", paneId: "ticker-chart" }];

    expect(describeArrangement(layout)).toBe("3 docked · 1 floating · 1 detached");
    expect(summarizeLayoutPanes(layout, panes).some((pane) => pane.instanceId === "orphan:1")).toBe(false);
  });
});

test("search matches layout names and the pane types inside them", () => {
  const layout = testLayout();
  const entries = buildOwnedEntries(
    [{ name: "Macro Desk", layout }, { name: "Options Flow", layout: cloneLayout(layout) }],
    0,
  );

  expect(filterGalleryEntries(entries, "macro", panes).map((entry) => entry.name)).toEqual(["Macro Desk"]);
  // Registered pane names are searchable even though they are not in the title.
  expect(filterGalleryEntries(entries, "portfolio", panes).length).toBe(2);
  expect(filterGalleryEntries(entries, "", panes).length).toBe(2);
  expect(filterGalleryEntries(entries, "zzzz", panes).length).toBe(0);
});

test("pane imagery is deterministic and specific before generic", () => {
  expect(paneImagery("ticker-chart")).toBe("chart");
  expect(paneImagery("news-top")).toBe("feed");
  expect(paneImagery("earnings-calendar")).toBe("calendar");
  expect(paneImagery("market-heatmap")).toBe("heatmap");
  expect(paneImagery("fear-greed")).toBe("gauge");
  expect(paneImagery("macro-tv")).toBe("media");
  expect(paneImagery("portfolio-list")).toBe("table");
  expect(paneImagery("chat")).toBe("chat");
  expect(paneImagery("some-unknown-plugin-pane")).toBe("generic");
  expect(paneImagery("ticker-chart")).toBe(paneImagery("ticker-chart"));
});
