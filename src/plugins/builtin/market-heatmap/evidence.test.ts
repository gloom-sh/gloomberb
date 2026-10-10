import { expect, test } from "bun:test";
import type { DesktopPaneShotPayload } from "../../../cli/desktop-pane-shot";
import type { ResolvedPaneFunction } from "../../../cli/pane-functions/resolver";
import { marketHeatmapEvidence, marketHeatmapScreenshotEvidence as hook } from "./evidence";
import type { HeatmapBoardAsset } from "./portfolio";

const asset = (symbol: string, sector: string | null, changePercent: number | null): HeatmapBoardAsset => ({
  symbol, name: symbol, price: 10, change: 0, changePercent: changePercent ?? 0, hasChange: changePercent != null,
  size: 1, sizeKind: "market-cap", volume: null, currency: "USD", exchange: "NASDAQ", sector, industry: null,
  marketState: null, source: "gloom",
});
const tile = (data: HeatmapBoardAsset) => ({ item: { id: data.symbol, data } });

const assets = [asset("AAA", "Tech", 1), asset("BBB", "Tech", -1), asset("CCC", "Energy", null)];
const board = { tab: "us-equity" as const, tiles: assets.map(tile), assets, grouped: true, loading: false, retained: false };

test("a loaded board counts its tiles and sectors, and is complete only once it settled with moves", () => {
  expect(marketHeatmapEvidence(board)).toMatchObject({ complete: true, plottedValueCount: 3, tiles: 3, sectors: 2, moved: 2 });
  expect(marketHeatmapEvidence({ ...board, grouped: false }).sectors).toBe(0);
  expect(marketHeatmapEvidence({ ...board, loading: true }).complete).toBe(false);
  expect(marketHeatmapEvidence({ ...board, retained: true }).complete).toBe(false);
  expect(marketHeatmapEvidence({ ...board, assets: [asset("CCC", "Energy", null)] }).complete).toBe(false);
  expect(marketHeatmapEvidence({ ...board, tiles: [], assets: [] })).toMatchObject({ complete: false, plottedValueCount: 0 });
});

test("evidence that disagrees with itself is not trusted", () => {
  const evidence = marketHeatmapEvidence(board);
  expect(hook.read(evidence)).toEqual(evidence);
  expect(hook.read({ ...evidence, tiles: 2 })).toBeNull();
  expect(hook.read({ ...evidence, sectors: 4 })).toBeNull();
  expect(hook.read({ ...evidence, moved: 0 })).toBeNull();
  expect(hook.read({ ...evidence, tab: "us-futures" })).toBeNull();
});

test("a capture of another tab than the one requested is refused, and an unfinished board is unavailable", () => {
  const request = (settings: Record<string, unknown>, universe?: string) => ({
    resolved: { options: { universe } } as unknown as ResolvedPaneFunction,
    payload: { paneId: "p", config: { layout: { instances: [{ instanceId: "p", settings }] } } } as unknown as DesktopPaneShotPayload,
  });
  const etf = { ...marketHeatmapEvidence(board), tab: "us-etf" as const };
  expect(hook.mismatches(etf, request({ universe: "us-etf" }, "us-etf"))).toEqual([]);
  expect(hook.mismatches(etf, request({ universe: "us-equity" }, "us-equity"))).toHaveLength(1);
  expect(hook.mismatches(marketHeatmapEvidence(board), request({}))).toEqual([]);
  expect(hook.unavailable(marketHeatmapEvidence(board), request({}))).toEqual([]);
  expect(hook.unavailable(marketHeatmapEvidence({ ...board, loading: true }), request({}))).toEqual(["market heatmap"]);
  expect(hook.unavailable(null, request({}))).toEqual(["market heatmap"]);
});
