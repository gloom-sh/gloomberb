import { describe, expect, test } from "bun:test";
import { migrateSavedConfig } from "./migrations";
import { foldCommoditiesPaneLayout, foldFixedIncomePaneLayout, foldPaneLayout } from "./fold-panes";
import { CURRENT_CONFIG_VERSION, type DockLayoutNode, type LayoutConfig, type PaneInstanceConfig } from "../../../types/config";
import { buildDockStack } from "../../../layout/pane-manager/dock-stack";

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

  test("a stack keeps showing a tab that folds into another pane, and stops being a stack when a fold leaves one tab", () => {
    const folded = foldPaneLayout(layout([
      { instanceId: "short-volume:AAPL", paneId: "short-volume", binding: { kind: "fixed", symbol: "AAPL" } },
      { instanceId: "chart", paneId: "ticker-chart", binding: { kind: "none" } },
      { instanceId: "sovr-1", paneId: "sovr-board", binding: { kind: "none" } },
      { instanceId: "cdx-1", paneId: "cdx-board", binding: { kind: "none" } },
    ], {
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: buildDockStack(["chart", "short-volume:AAPL"], "short-volume:AAPL")!,
      second: buildDockStack(["cdx-1", "sovr-1"], "sovr-1")!,
    }));

    expect(folded.layout.dockRoot).toEqual({
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: buildDockStack(["chart", "short-interest:AAPL"], "short-interest:AAPL")!,
      second: { kind: "pane", instanceId: "cdx-1" },
    });
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

describe("fold fixed income views", () => {
  test("legacy panes route into Fixed Income and keep their isolated pane state", () => {
    const result = migrateSavedConfig({
      configVersion: 26,
      layout: layout([
        { instanceId: "open-auctions", paneId: "treasury-auctions", binding: { kind: "none" }, title: "Treasury Auctions" },
      ], { kind: "pane", instanceId: "open-auctions" }),
      layouts: [{
        name: "Credit and rates",
        layout: layout([
          { instanceId: "cdx-1", paneId: "cdx-board", binding: { kind: "none" } },
          { instanceId: "trace-1", paneId: "trace-bonds", binding: { kind: "none" } },
          { instanceId: "daily-1", paneId: "treasury-daily", binding: { kind: "none" } },
        ]),
        paneState: {
          "cdx-1": { pluginState: { macro: { "credit-boards:tab": "sovereign", "cdx:selected": "CDX-IG" } } },
          "trace-1": { pluginState: { macro: { issuer: "IBM", selectedId: "bond-1" } } },
          "daily-1": { pluginState: { macro: { tab: "debt" } } },
        },
      }],
    }, "/tmp");

    expect((result.config.layout as LayoutConfig).instances[0]).toMatchObject({
      instanceId: "open-auctions",
      paneId: "fixed-income",
      params: { tab: "treasury", view: "auctions" },
    });
    expect((result.config.layout as LayoutConfig).instances[0]).not.toHaveProperty("title");
    const saved = (result.config.layouts as Array<{ layout: LayoutConfig; paneState: Record<string, any> }>)[0]!;
    expect(saved.layout.instances).toEqual([
      { instanceId: "cdx-1", paneId: "fixed-income", binding: { kind: "none" }, params: { tab: "credit", view: "index" } },
      { instanceId: "trace-1", paneId: "fixed-income", binding: { kind: "none" }, params: { tab: "bonds", view: "tape" } },
      { instanceId: "daily-1", paneId: "fixed-income", binding: { kind: "none" }, params: { tab: "treasury", view: "cash-debt" } },
    ]);
    expect(saved.paneState).toMatchObject({
      "cdx-1": { pluginState: {
        macro: { "fixed-income:view:credit": "sovereign" },
        "fixed-income:credit-boards": { "credit-boards:tab": "sovereign", "cdx:selected": "CDX-IG" },
      } },
      "trace-1": { pluginState: {
        macro: { issuer: "IBM", selectedId: "bond-1" },
        "fixed-income:trace-bonds": { issuer: "IBM", selectedId: "bond-1" },
      } },
      "daily-1": { pluginState: {
        macro: { tab: "debt" },
        "fixed-income:treasury-daily": { tab: "debt" },
      } },
    });
    expect(result.applied).toContain("fold-fixed-income-panes");
  });

  test("a typed legacy command keeps its requested view over the prior board tab", () => {
    const folded = foldFixedIncomePaneLayout(layout([
      {
        instanceId: "cdx-1",
        paneId: "cdx-board",
        binding: { kind: "none" },
        params: { tab: "index", tabAt: "123" },
      },
    ]));

    expect(folded.layout.instances[0]).toMatchObject({
      paneId: "fixed-income",
      params: { tab: "credit", view: "index", tabAt: "123" },
    });
    expect(folded.fixedIncomeRoutes.get("cdx-1")?.migrateCreditBoardTab).toBe(false);
  });
});

describe("fold Commodities & Energy panes", () => {
  test("moves each old view into its workspace tab and preserves saved module state", () => {
    const current = layout([
      { instanceId: "curve:1", paneId: "futures-curve", binding: { kind: "none" }, params: { root: "CL" }, title: "CTM CL" },
      { instanceId: "cot:1", paneId: "cot", binding: { kind: "none" }, params: { code: "CL" } },
      { instanceId: "outside", paneId: "ticker-chart", binding: { kind: "none" } },
    ], {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "curve:1" },
      second: { kind: "pane", instanceId: "outside" },
    }, [{ instanceId: "cot:1", x: 0, y: 0, width: 40, height: 20 }]);
    const folded = foldCommoditiesPaneLayout(current);
    expect(folded.instances).toMatchObject([
      { instanceId: "curve:1", paneId: "commodities-energy", params: { root: "CL", tab: "curve" } },
      { instanceId: "cot:1", paneId: "commodities-energy", params: { code: "CL", tab: "positioning" } },
      { instanceId: "outside", paneId: "ticker-chart" },
    ]);
    expect(folded.instances[0]).not.toHaveProperty("title");
    expect(folded.dockRoot).toEqual(current.dockRoot);
    expect(folded.floating).toEqual(current.floating);

    const result = migrateSavedConfig({
      configVersion: CURRENT_CONFIG_VERSION - 1,
      layout: current,
      layouts: [{
        name: "Commodities",
        layout: current,
        paneState: {
          "curve:1": { pluginState: { "market-overview": { tab: "contracts", contract: "CLM26" } } },
          "cot:1": { pluginState: { "market-overview": { report: "disaggregated", scope: "all" } } },
        },
        focusedPaneId: "curve:1",
      }],
    }, "/tmp/gloom-commodities-migration");
    expect(result.applied).toContain("fold-commodities-and-energy-panes");
    const saved = result.config.layouts as Array<{ layout: LayoutConfig; paneState: Record<string, { pluginState: Record<string, unknown> }> }>;
    expect(saved[0]?.layout.instances[0]).toMatchObject({ paneId: "commodities-energy", params: { tab: "curve" } });
    expect(saved[0]?.paneState["curve:1"]?.pluginState).toEqual({
      "market-overview:futures-curve": { tab: "contracts", contract: "CLM26" },
    });
    expect(saved[0]?.paneState["cot:1"]?.pluginState).toEqual({
      "market-overview:cot": { report: "disaggregated", scope: "all" },
    });
  });
});
