import { describe, expect, test } from "bun:test";
import { migrateSavedConfig } from "./migrations";
import { foldPaneLayout } from "./fold-panes";
import { CURRENT_CONFIG_VERSION, type DockLayoutNode, type LayoutConfig, type PaneInstanceConfig } from "../../../types/config";

function layout(instances: PaneInstanceConfig[], dockRoot: DockLayoutNode | null = null, floating: LayoutConfig["floating"] = []): LayoutConfig {
  return { dockRoot, instances, floating, detached: [] };
}

describe("fold short volume and sovereign CDS", () => {
  test("a daily-volume pane becomes the short interest pane on Daily volume, and a sovereign board beside an index board is removed", () => {
    const folded = foldPaneLayout(layout([
      { instanceId: "short-volume:AAPL", paneId: "short-volume", binding: { kind: "fixed", symbol: "AAPL" }, params: { keep: "1" } },
      { instanceId: "sovr-1", paneId: "sovr-board", binding: { kind: "none" } },
      { instanceId: "cdx-1", paneId: "cdx-board", binding: { kind: "none" } },
      {
        instanceId: "chart",
        paneId: "ticker-chart",
        binding: { kind: "follow", sourceInstanceId: "short-volume:AAPL" },
        placementMemory: { docked: { anchorInstanceId: "short-volume:AAPL" } },
      },
    ], {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "short-volume:AAPL" },
      second: { kind: "pane", instanceId: "sovr-1" },
    }, [{ instanceId: "cdx-1", x: 0, y: 0, width: 10, height: 10 }]));

    const volume = folded.layout.instances.find((instance) => instance.instanceId === "short-interest:AAPL");
    expect(volume).toMatchObject({ paneId: "short-interest", params: { keep: "1", tab: "volume" } });
    expect(folded.layout.instances.map((instance) => instance.paneId).sort()).toEqual(["cdx-board", "short-interest", "ticker-chart"]);
    expect(folded.layout.dockRoot).toEqual({ kind: "pane", instanceId: "short-interest:AAPL" });
    expect(folded.layout.instances.find((instance) => instance.instanceId === "chart")).toMatchObject({
      binding: { kind: "follow", sourceInstanceId: "short-interest:AAPL" },
      placementMemory: { docked: { anchorInstanceId: "short-interest:AAPL" } },
    });
    expect(folded.layout.floating.map((entry) => entry.instanceId)).toEqual(["cdx-1"]);
  });

  test("a sovereign board with no index board keeps its id and opens on Sovereign", () => {
    const folded = foldPaneLayout(layout([
      { instanceId: "sovr-a", paneId: "sovr-board", binding: { kind: "none" }, params: { region: "em" } },
      { instanceId: "sovr-b", paneId: "sovr-board", binding: { kind: "none" } },
    ], {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "sovr-a" },
      second: { kind: "pane", instanceId: "sovr-b" },
    }));

    expect(folded.layout.instances).toEqual([
      { instanceId: "sovr-a", paneId: "cdx-board", binding: { kind: "none" }, params: { region: "em", tab: "sovereign" } },
    ]);
    expect(folded.layout.dockRoot).toEqual({ kind: "pane", instanceId: "sovr-a" });
  });

  test("an existing short interest pane keeps its tab when the volume pane for that symbol is dropped", () => {
    const folded = foldPaneLayout(layout([
      { instanceId: "short-interest:AAPL", paneId: "short-interest", binding: { kind: "fixed", symbol: "AAPL" }, params: { tab: "interest" } },
      { instanceId: "short-volume:AAPL", paneId: "short-volume", binding: { kind: "fixed", symbol: "AAPL" } },
      { instanceId: "short-volume:171", paneId: "short-volume", binding: { kind: "fixed", symbol: "MSFT" } },
    ], { kind: "pane", instanceId: "short-volume:171" }));

    expect(folded.layout.instances.map((instance) => instance.instanceId).sort()).toEqual(["short-interest:171", "short-interest:AAPL"]);
    expect(folded.layout.instances.find((instance) => instance.instanceId === "short-interest:AAPL")?.params).toEqual({ tab: "interest" });
    expect(folded.layout.instances.find((instance) => instance.instanceId === "short-interest:171")?.params).toEqual({ tab: "volume" });
    expect(folded.layout.dockRoot).toEqual({ kind: "pane", instanceId: "short-interest:171" });
  });

  test("saved layouts move pane state and focus with a rewritten id, and drop focus on a removed pane", () => {
    const result = migrateSavedConfig({
      configVersion: 24,
      layout: layout([
        { instanceId: "short-volume:TSLA", paneId: "short-volume", binding: { kind: "fixed", symbol: "TSLA" } },
      ], { kind: "pane", instanceId: "short-volume:TSLA" }),
      layouts: [
        {
          name: "Volume",
          layout: layout([
            { instanceId: "short-volume:TSLA", paneId: "short-volume", binding: { kind: "fixed", symbol: "TSLA" } },
          ], { kind: "pane", instanceId: "short-volume:TSLA" }),
          paneState: { "short-volume:TSLA": { pluginState: { volume: true } } },
          focusedPaneId: "short-volume:TSLA",
        },
        {
          name: "Both",
          layout: layout([
            { instanceId: "cdx-2", paneId: "cdx-board", binding: { kind: "none" } },
            { instanceId: "sovr-2", paneId: "sovr-board", binding: { kind: "none" } },
          ], {
            kind: "split",
            axis: "horizontal",
            ratio: 0.5,
            first: { kind: "pane", instanceId: "cdx-2" },
            second: { kind: "pane", instanceId: "sovr-2" },
          }),
          paneState: { "sovr-2": { gone: true }, "cdx-2": { keep: true } },
          focusedPaneId: "sovr-2",
        },
      ],
    }, "/tmp");

    expect(result.config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(result.applied).toContain("fold-short-volume-and-sovereign-cds");
    const open = result.config.layout as LayoutConfig;
    expect(open.instances[0]).toMatchObject({ instanceId: "short-interest:TSLA", paneId: "short-interest", params: { tab: "volume" } });
    const saved = result.config.layouts as Array<{ name: string; paneState: Record<string, unknown>; focusedPaneId: string | null; layout: LayoutConfig }>;
    expect(saved[0]).toMatchObject({
      paneState: { "short-interest:TSLA": { pluginState: { volume: true } } },
      focusedPaneId: "short-interest:TSLA",
    });
    expect(saved[1]).toMatchObject({
      paneState: { "cdx-2": { keep: true } },
      focusedPaneId: null,
    });
    expect(saved[1]?.layout.dockRoot).toEqual({ kind: "pane", instanceId: "cdx-2" });
  });
});

describe("fold Financial Analysis into Ticker Research", () => {
  test("migrates open and saved FA panes while preserving their instance state and focus", () => {
    const saved = {
      configVersion: 29,
      layout: layout([
        {
          instanceId: "financial-analysis:AAPL",
          paneId: "financial-analysis",
          title: "FA AAPL",
          binding: { kind: "fixed" as const, symbol: "AAPL" },
          params: { section: "ratios" },
          settings: { period: "quarterly" },
        },
      ], { kind: "pane", instanceId: "financial-analysis:AAPL" }),
      layouts: [{
        name: "Statements",
        layout: layout([
          { instanceId: "financial-analysis:MSFT", paneId: "financial-analysis", binding: { kind: "fixed" as const, symbol: "MSFT" } },
          { instanceId: "ticker-research:NVDA", paneId: "ticker-research", binding: { kind: "fixed" as const, symbol: "NVDA" } },
        ], {
          kind: "split" as const,
          axis: "horizontal" as const,
          ratio: 0.5,
          first: { kind: "pane" as const, instanceId: "financial-analysis:MSFT" },
          second: { kind: "pane" as const, instanceId: "ticker-research:NVDA" },
        }),
        paneState: { "financial-analysis:MSFT": { pluginState: { retained: true } } },
        focusedPaneId: "financial-analysis:MSFT",
      }],
    };

    const result = migrateSavedConfig(saved, "/tmp");
    expect(result.config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(result.applied).toContain("fold-financial-analysis-into-ticker-research");
    expect(result.config.layout).toMatchObject({
      dockRoot: { kind: "pane", instanceId: "financial-analysis:AAPL" },
      instances: [{
        instanceId: "financial-analysis:AAPL",
        paneId: "ticker-research",
        title: "FA AAPL",
        binding: { kind: "fixed", symbol: "AAPL" },
        params: { section: "ratios", tab: "financials" },
        settings: { period: "quarterly", hideTabs: true, lockedTabId: "financials" },
      }],
    });
    expect(result.config.layouts).toMatchObject([{
      layout: { instances: [
        { instanceId: "financial-analysis:MSFT", paneId: "ticker-research", params: { tab: "financials" }, settings: { hideTabs: true, lockedTabId: "financials" } },
        { instanceId: "ticker-research:NVDA", paneId: "ticker-research" },
      ] },
      paneState: { "financial-analysis:MSFT": { pluginState: { retained: true } } },
      focusedPaneId: "financial-analysis:MSFT",
    }]);
  });
});
