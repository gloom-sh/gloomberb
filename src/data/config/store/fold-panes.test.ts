import { describe, expect, test } from "bun:test";
import { migrateSavedConfig } from "./migrations";
import { foldPaneLayout, foldSavedPanes } from "./fold-panes";
import { CURRENT_CONFIG_VERSION, type DockLayoutNode, type LayoutConfig, type PaneInstanceConfig } from "../../../types/config";

function layout(instances: PaneInstanceConfig[], dockRoot: DockLayoutNode | null = null, floating: LayoutConfig["floating"] = []): LayoutConfig {
  return { dockRoot, instances, floating, detached: [] };
}

describe("fold short volume and sovereign CDS", () => {
  test("the version 25 helper leaves Filings and Events for their later migration", () => {
    const savedLayout = layout([
      { instanceId: "sec:AAPL", paneId: "sec", binding: { kind: "fixed", symbol: "AAPL" } },
      { instanceId: "mna:AAPL", paneId: "mna", binding: { kind: "fixed", symbol: "AAPL" } },
    ]);
    const paneState = {
      "ticker-research:main": {
        activeTabId: "filing-events",
        pluginState: { "ticker-research": { keep: "state" } },
      },
    };
    const folded = foldSavedPanes({
      layout: savedLayout,
      layouts: [{ name: "Research", layout: savedLayout, paneState }],
    });
    const saved = (folded.layouts as Array<{ layout: LayoutConfig; paneState: typeof paneState }>)[0]!;

    expect(saved.layout.instances.map(({ instanceId, paneId }) => ({ instanceId, paneId }))).toEqual([
      { instanceId: "sec:AAPL", paneId: "sec" },
      { instanceId: "mna:AAPL", paneId: "mna" },
    ]);
    expect(saved.paneState).toEqual(paneState);
  });

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

describe("fold issuer research into Filings and Events", () => {
  test("keeps pane identities and saved state while routing old panes to their workspace tabs", () => {
    const instances: PaneInstanceConfig[] = [
      { instanceId: "sec:NVDA", paneId: "sec", title: "SEC NVDA", binding: { kind: "fixed", symbol: "NVDA" } },
      { instanceId: "sec:NVDA:ETF", paneId: "sec", title: "ETF Filings NVDA", binding: { kind: "fixed", symbol: "NVDA" }, settings: { forms: "N-1A" } },
      { instanceId: "filing-events:NVDA", paneId: "filing-events", binding: { kind: "fixed", symbol: "NVDA" } },
      { instanceId: "risk-factors:NVDA", paneId: "risk-factors", binding: { kind: "fixed", symbol: "NVDA" } },
      { instanceId: "comment-letters:NVDA", paneId: "comment-letters", binding: { kind: "none" }, settings: { query: "NVDA" } },
      { instanceId: "corporate-actions:NVDA", paneId: "corporate-actions", binding: { kind: "fixed", symbol: "NVDA" } },
      { instanceId: "catalysts:NVDA", paneId: "catalysts", binding: { kind: "fixed", symbol: "NVDA" } },
      { instanceId: "litigation:NVDA", paneId: "litigation", binding: { kind: "fixed", symbol: "NVDA" } },
      { instanceId: "mna:market", paneId: "mna", binding: { kind: "none" } },
      { instanceId: "ticker-research:main", paneId: "ticker-research", binding: { kind: "fixed", symbol: "NVDA" }, settings: { hideTabs: true, lockedTabId: "risk-factors" } },
    ];
    const paneState = {
      "sec:NVDA": { pluginState: { "ticker-research": { selectedIdx: 4 } } },
      "comment-letters:NVDA": { pluginState: { "comment-letters": { query: "NVDA", openItemId: "letter-1" } } },
      "mna:market": { pluginState: { "ticker-research": { tab: "distress" } } },
      "ticker-research:main": { activeTabId: "filing-events", pluginState: { "ticker-research": { keep: "state" } } },
    };
    const savedLayout = layout(instances, {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "sec:NVDA" },
      second: { kind: "pane", instanceId: "mna:market" },
    }, [{ instanceId: "corporate-actions:NVDA", x: 4, y: 2, width: 80, height: 24 }]);
    const result = migrateSavedConfig({
      configVersion: 26,
      layout: savedLayout,
      activeLayoutIndex: 0,
      layouts: [{ name: "Research", layout: savedLayout, paneState, focusedPaneId: "mna:market" }],
    }, "/tmp");

    expect(result.config.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(result.applied).toContain("fold-filings-and-events-workspaces");
    const saved = (result.config.layouts as Array<{ layout: LayoutConfig; paneState: typeof paneState; focusedPaneId: string }>)[0]!;
    expect(saved.layout.instances.map(({ instanceId, paneId, params }) => ({ instanceId, paneId, tab: params?.tab }))).toEqual([
      { instanceId: "sec:NVDA", paneId: "filings-workspace", tab: "sec" },
      { instanceId: "sec:NVDA:ETF", paneId: "filings-workspace", tab: "etf" },
      { instanceId: "filing-events:NVDA", paneId: "filings-workspace", tab: "eight-k" },
      { instanceId: "risk-factors:NVDA", paneId: "filings-workspace", tab: "risks" },
      { instanceId: "comment-letters:NVDA", paneId: "filings-workspace", tab: "comments" },
      { instanceId: "corporate-actions:NVDA", paneId: "events-workspace", tab: "corporate-actions" },
      { instanceId: "catalysts:NVDA", paneId: "events-workspace", tab: "catalysts" },
      { instanceId: "litigation:NVDA", paneId: "events-workspace", tab: "litigation" },
      { instanceId: "mna:market", paneId: "events-workspace", tab: "distress" },
      { instanceId: "ticker-research:main", paneId: "ticker-research", tab: undefined },
    ]);
    expect(saved.layout.instances.find(({ instanceId }) => instanceId === "ticker-research:main")?.settings).toEqual({
      hideTabs: true,
      lockedTabId: "filings-workspace",
      lockedWorkspaceTab: "risks",
    });
    expect(saved.layout.dockRoot).toEqual({
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "sec:NVDA" },
      second: { kind: "pane", instanceId: "mna:market" },
    });
    expect(saved.layout.floating[0]?.instanceId).toBe("corporate-actions:NVDA");
    expect(saved.focusedPaneId).toBe("mna:market");
    expect(saved.paneState["sec:NVDA"]).toEqual(paneState["sec:NVDA"]);
    expect(saved.paneState["comment-letters:NVDA"]).toEqual(paneState["comment-letters:NVDA"]);
    expect(saved.paneState["ticker-research:main"]).toEqual({
      activeTabId: "filings-workspace",
      pluginState: { "ticker-research": { keep: "state", "filings:tab": "eight-k" } },
    });
  });
});
