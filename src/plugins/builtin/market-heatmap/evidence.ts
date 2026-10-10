/**
 * What `gloomberb shot HM` certifies: the tab the heat map drew, how many tiles
 * and sectors are plotted, and whether its snapshot had loaded. The heat map has
 * no table rows or labeled values, so this is how a capture counts as data.
 */
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { heatmapMove } from "./model";
import { heatmapTabId, type HeatmapBoardAsset, type HeatmapTabId } from "./portfolio";

interface MarketHeatmapEvidence {
  kind: "market-heatmap";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  tab: HeatmapTabId;
  tiles: number;
  sectors: number;
  /** Tiles colored by a move, not left grey for want of one. */
  moved: number;
}

interface HeatmapEvidenceInput {
  tab: HeatmapTabId;
  tiles: readonly { item: { id: string; data: Pick<HeatmapBoardAsset, "sector"> } }[];
  /** The assets the tiles are colored by. */
  assets: readonly HeatmapBoardAsset[];
  /** Whether the tiles are grouped into sectors, rather than laid out flat. */
  grouped: boolean;
  /** A snapshot is on its way. */
  loading: boolean;
  /** The tiles are a retained board: its refresh failed, or the server served a stale snapshot. */
  retained: boolean;
}

export function marketHeatmapEvidence({ tab, tiles, assets, grouped, loading, retained }: HeatmapEvidenceInput): MarketHeatmapEvidence {
  const drawn = new Set(tiles.map((tile) => tile.item.id));
  const sectors = grouped
    ? new Set(tiles.flatMap((tile) => (tile.item.data.sector ? [tile.item.data.sector] : []))).size
    : 0;
  const moved = assets.filter((asset) => drawn.has(asset.symbol) && heatmapMove(asset) != null).length;
  return {
    kind: "market-heatmap",
    version: 1,
    complete: !loading && !retained && moved > 0,
    plottedValueCount: tiles.length,
    tab,
    tiles: tiles.length,
    sectors,
    moved,
  };
}

export function useMarketHeatmapEvidence(input: HeatmapEvidenceInput) {
  useRemoteUiNode({
    role: "chart-data",
    label: "Rendered market heatmap",
    // The capture waits for a board that is still loading.
    getMetadata: () => ({ ...marketHeatmapEvidence(input), ready: !input.loading }),
  });
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export const marketHeatmapScreenshotEvidence: PaneScreenshotEvidenceHook<MarketHeatmapEvidence> = {
  paneId: "market-heatmap",
  kind: "market-heatmap",
  label: "market heatmap",
  read(value) {
    if (!isRecord(value) || value.kind !== "market-heatmap" || value.version !== 1 || typeof value.complete !== "boolean"
      || !isCount(value.plottedValueCount) || value.tiles !== value.plottedValueCount
      || value.tab !== heatmapTabId(typeof value.tab === "string" ? value.tab : null)
      || !isCount(value.sectors) || value.sectors > value.tiles
      || !isCount(value.moved) || value.moved > value.tiles
      || (value.complete && value.moved === 0)) return null;
    return value as unknown as MarketHeatmapEvidence;
  },
  mismatches(evidence, { resolved, payload }) {
    const settings = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings;
    const asked = settings?.universe ?? resolved.options.universe;
    return evidence.tab === heatmapTabId(typeof asked === "string" ? asked : null) ? [] : ["Heat map tab differs from the request"];
  },
  unavailable(evidence) {
    return evidence?.complete ? [] : ["market heatmap"];
  },
  symbols() {
    return [];
  },
};
