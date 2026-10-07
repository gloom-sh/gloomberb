import type { SupplyEntity } from "../../../api-client/supply-chain";
import type { GraphPath, GraphPayload } from "../../../api-client/supply-chain-graph";
import { publicTickerKey } from "../../../utils/exchanges";

export const entityKey = (entity: SupplyEntity) => entity.ticker ? publicTickerKey(entity.ticker, entity.exchange ?? undefined) : `id:${entity.id}`;
export const entityLabel = (entity: SupplyEntity) => entity.ticker ?? entity.name;
export function pathLabel(path: GraphPath, data: GraphPayload) {
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  return path.nodeIds.map(id => nodes.get(id) ? entityLabel(nodes.get(id)!) : id).join(" → ");
}
export function exposureLabel(path: GraphPath, data: GraphPayload) {
  const exposure = path.exposure;
  if (!exposure) return "--";
  const denominator = data.nodes.find(node => node.id === exposure.denominatorEntityId);
  return `${Number(exposure.pct.toPrecision(4))}% est. of ${denominator ? entityLabel(denominator) : exposure.denominatorEntityId} ${exposure.basis}`;
}
export interface GraphNode { entity: SupplyEntity; column: number; hops: number; path: GraphPath | null; related: boolean; }
/** A selected path has priority over other positions so every highlighted hop remains connected. */
export function graphNodes(data: GraphPayload, collapsed: readonly string[], selectedPath: GraphPath | null): GraphNode[] {
  if (!data.entity) return [];
  const entities = new Map(data.nodes.map(node => [node.id, node]));
  const result = new Map<string, GraphNode>();
  result.set(data.entity.id, { entity: data.entity, column: 0, hops: 0, path: null, related: false });
  const reaches = [...data.upstream, ...data.downstream, ...data.related];
  const links = new Map(data.links.map(link => [link.id, link]));
  const addPath = (path: GraphPath, direction: "upstream" | "downstream", selected = false) => {
    const sign = direction === "upstream" ? -1 : 1;
    path.nodeIds.forEach((id, index) => {
      const entity = entities.get(id);
      if (!entity || path.nodeIds.slice(1, index).some(node => collapsed.includes(node))) return;
      const previous = result.get(id);
      const prefixLinks = path.linkIds.slice(0, index);
      const prefixPath = index === path.hops ? path : { ...path, nodeIds: path.nodeIds.slice(0, index + 1), linkIds: prefixLinks, hops: index, confidence: prefixLinks.reduce((value, id) => value * (links.get(id)?.confidence ?? 0), 1), score: prefixLinks.reduce((value, id) => value * (links.get(id)?.weight ?? 0), 1), exposure: null };
      const related = prefixLinks.some(id => links.get(id)?.relationship !== "commerce");
      if (!previous || index < previous.hops || selected) result.set(id, { entity, column: index === 0 ? 0 : sign * index, hops: index, path: index ? prefixPath : null, related });
    });
  };
  for (const reach of reaches) addPath(data.options.ranking === "shortest" ? reach.shortestPath : reach.bestPath, reach.direction);
  for (const path of data.paths) addPath(path, path.id.startsWith("upstream|") ? "upstream" : "downstream");
  if (selectedPath) {
    const reach = reaches.find(row => row.bestPath.id === selectedPath.id || row.shortestPath.id === selectedPath.id);
    addPath(selectedPath, reach?.direction ?? (selectedPath.id.startsWith("upstream|") ? "upstream" : "downstream"), true);
  }
  return [...result.values()].sort((a, b) => a.column - b.column || Number(a.related) - Number(b.related) || (b.path?.score ?? 0) - (a.path?.score ?? 0) || a.entity.name.localeCompare(b.entity.name));
}
