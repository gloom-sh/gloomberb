import type { SeriesDefinition } from "../../../series/types";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadGpuBoard, loadGpuHistory } from "./client";
import { GPU_MODELS, gpuListIndex } from "./model";

/** What the GPU pane says when the free preview leaves history out. */
const GPU_PRO_ONLY = "Full history is available with Pro.";

/**
 * Each GPU's list index, the one the GPU pane's Equities tab reads shares
 * against. The per-provider listings stay on the board and its History tab:
 * the server lists them, and they come and go.
 */
export const GPU_SERIES: readonly SeriesDefinition[] = GPU_MODELS.map((model): SeriesDefinition => ({
  id: `gpu:${model.toLowerCase().replaceAll(" ", "-")}-list-index`,
  name: `${model} rental list index`,
  unit: "USD/GPU-hour",
  frequency: "intraday",
  group: "Alternative data",
  tags: ["GPU", "rental", "compute", "cloud", "list price", model],
  description: `Median list price to rent one ${model} from neocloud providers (hyperscalers where none list it), chained so a change of providers causes no jump, as GPU charts it. Needs Pro.`,
  style: "step",
  load: async () => {
    const board = await loadGpuBoard();
    if (board.payload.access?.locked) throw new Error(GPU_PRO_ONLY);
    const index = gpuListIndex(board.payload.rows, model);
    if (!index) throw new Error(`No ${model} list index is listed yet.`);
    const history = await loadGpuHistory(index.id);
    if (history.payload.access?.locked) throw new Error(GPU_PRO_ONLY);
    return {
      points: history.payload.points
        .filter((point) => `${point.source}:${point.skuKey}` === index.id)
        .map((point) => ({ date: point.observedAt, value: point.pricePerGpuHr })),
      ...cachedSeriesNote(history),
    };
  },
}));
