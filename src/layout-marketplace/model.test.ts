import { describe, expect, test } from "bun:test";
import { cloneLayout } from "../types/config";
import {
  buildOwnedEntries,
  describeArrangement,
  filterGalleryEntries,
  missingPaneIds,
  summarizeLayoutPanes,
} from "./model";
import { paneImagery } from "./pane-imagery";
import { testLayout, testPanes as panes } from "./test-fixture";

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

  test("does not preview the layout browser inside its own active layout", () => {
    const layout = testLayout();
    layout.instances.push({ instanceId: "layout-marketplace:1", paneId: "layout-marketplace" });
    layout.floating.push({
      instanceId: "layout-marketplace:1",
      x: 20,
      y: 5,
      width: 100,
      height: 30,
    });

    const entry = buildOwnedEntries([{ name: "Desk", layout }], 0)[0]!;
    expect(entry.layout.instances.some((instance) => instance.paneId === "layout-marketplace")).toBe(false);
    expect(describeArrangement(entry.layout)).toBe("3 docked · 1 floating · 1 detached");
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

test("pane imagery picks the narrow rule before a broader one", () => {
  // "sectors" also contains the broader "sec" table keyword.
  expect(paneImagery("sectors")).toBe("heatmap");
  expect(paneImagery("some-unknown-plugin-pane")).toBe("generic");
});
