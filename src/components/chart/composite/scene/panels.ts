// Panel layout for the composite chart scene: which panels a set of series
// draws, how the available height is shared between them, and re-laying a
// panel at another height.
import type { ChartPanelSpec, ResolvedSeries } from "../../../../time-series/types";
import type { CompositeAxisDomain, CompositePanelScene } from "../types";
import { compositeAxisMaxTicks } from "../format";
import { isFiniteNumber } from "../../../../utils/guards";

export function panelSpecsForSeries(series: ResolvedSeries[], panels: ChartPanelSpec[]): ChartPanelSpec[] {
  const visiblePanelIds = new Set(series.map((entry) => entry.panelId));
  const ordered = panels.filter((panel) => visiblePanelIds.has(panel.id));
  const knownIds = new Set(ordered.map((panel) => panel.id));
  for (const entry of series) {
    if (knownIds.has(entry.panelId)) continue;
    knownIds.add(entry.panelId);
    ordered.push({ id: entry.panelId });
  }
  return ordered;
}

export function allocateCompositePanelHeights(
  panels: ChartPanelSpec[],
  availableHeight: number,
): Map<string, number> {
  const heights = new Map<string, number>();
  if (panels.length === 0) return heights;

  const totalHeight = Math.max(panels.length, Math.floor(availableHeight));
  const weights = panels.map((panel) => (
    isFiniteNumber(panel.height) && panel.height > 0 ? panel.height : 1
  ));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || panels.length;
  const quotas = weights.map((weight) => (weight / totalWeight) * totalHeight);
  const allocations = quotas.map((quota) => Math.max(1, Math.floor(quota)));
  let allocated = allocations.reduce((sum, value) => sum + value, 0);

  while (allocated < totalHeight) {
    let index = 0;
    for (let candidate = 1; candidate < allocations.length; candidate += 1) {
      if (quotas[candidate]! - allocations[candidate]!
        > quotas[index]! - allocations[index]!) {
        index = candidate;
      }
    }
    allocations[index] = (allocations[index] ?? 0) + 1;
    allocated += 1;
  }
  while (allocated > totalHeight) {
    let index = -1;
    for (let candidate = 0; candidate < allocations.length; candidate += 1) {
      if (allocations[candidate]! <= 1) continue;
      if (index < 0 || allocations[candidate]! - quotas[candidate]!
        > allocations[index]! - quotas[index]!) {
        index = candidate;
      }
    }
    if (index < 0) break;
    allocations[index] = allocations[index]! - 1;
    allocated -= 1;
  }

  panels.forEach((panel, index) => heights.set(panel.id, allocations[index] ?? 1));
  return heights;
}

/** A panel laid out at another height keeps as many axis ticks as it can
 * label. Hosts that place labels at exact heights drop the row snapping. */
export function resizeCompositePanel(
  panel: CompositePanelScene,
  height: number,
  snapTicksToRows = true,
): CompositePanelScene {
  const maxTicks = compositeAxisMaxTicks(height);
  const tickRows = snapTicksToRows ? height : undefined;
  const fits = (domain: CompositeAxisDomain) => domain.maxTicks === maxTicks && domain.tickRows === tickRows;
  if (panel.height === height && (["left", "right"] as const).every((side) => !panel.axes[side] || fits(panel.axes[side]!))) {
    return panel;
  }
  const axes: CompositePanelScene["axes"] = {};
  for (const side of ["left", "right"] as const) {
    const domain = panel.axes[side];
    if (domain) axes[side] = fits(domain) ? domain : { ...domain, maxTicks, tickRows };
  }
  return { ...panel, height, axes };
}
