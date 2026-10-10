/**
 * What `gloomberb shot MAP <layers>` certifies: the layers the map drew and
 * what each held, so a capture taken before the features arrived is refused.
 */
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import type { GeoLayerState } from "./feed";
import { WORLD_VENUE_MAP_PANE_ID } from "./ids";
import { parseLayerTokens } from "./layers";

interface WorldMapEvidenceLayer {
  id: string;
  phase: GeoLayerState["phase"];
  features: number;
  clusters: number;
}

interface WorldMapEvidence {
  kind: "world-map";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  tokens: string[];
  layers: WorldMapEvidenceLayer[];
  tableRows: number;
}

const SETTLED = new Set<GeoLayerState["phase"]>(["ready", "unavailable", "zoom", "locked", "error"]);

export function useWorldMapEvidence(tokens: readonly string[], states: readonly GeoLayerState[], tableRows: number, tableLoading: boolean) {
  useRemoteUiNode({
    role: "chart-data",
    label: "Rendered world map layers",
    getMetadata: () => {
      const layers = states.map((state) => ({ id: state.layer.id, phase: state.phase, features: state.features.length, clusters: state.clusters.length }));
      const complete = !tableLoading && states.every((state) => SETTLED.has(state.phase) && !state.loading);
      return {
        kind: "world-map",
        version: 1,
        complete,
        ready: complete,
        plottedValueCount: layers.reduce((sum, layer) => sum + layer.features + layer.clusters, 0) + tableRows,
        tokens: [...tokens],
        layers,
        tableRows,
      } satisfies WorldMapEvidence & { ready: boolean };
    },
  });
}

function requestedTokens(request: Parameters<PaneScreenshotEvidenceHook["mismatches"]>[1]): string[] {
  const fromOption = parseLayerTokens(request.resolved.options.layer);
  return fromOption.length ? fromOption : parseLayerTokens(request.resolved.createOptions?.arg ?? "");
}

export const worldMapScreenshotEvidence: PaneScreenshotEvidenceHook<WorldMapEvidence> = {
  paneId: WORLD_VENUE_MAP_PANE_ID,
  kind: "world-map",
  label: "world map layers",
  read(value) {
    if (!isRecord(value) || value.kind !== "world-map" || value.version !== 1 || typeof value.complete !== "boolean"
      || !Number.isSafeInteger(value.plottedValueCount) || !Array.isArray(value.layers) || !Array.isArray(value.tokens)) return null;
    return value as unknown as WorldMapEvidence;
  },
  mismatches(evidence, request) {
    const asked = requestedTokens(request);
    return asked.join(",") === evidence.tokens.join(",") ? [] : ["Map layers differ from the request"];
  },
  unavailable(evidence) {
    if (!evidence) return ["world map layers"];
    return evidence.layers.filter((layer) => layer.phase === "error").map((layer) => layer.id);
  },
  symbols() {
    return [];
  },
};
