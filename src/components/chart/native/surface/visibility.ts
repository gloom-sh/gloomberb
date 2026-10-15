import { intersectCellRects, type CellRect } from "../chart-rasterizer";

export interface NativeSurfaceRenderableNode {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
  parent: NativeSurfaceRenderableNode | null;
}

const MAX_RENDERABLE_ANCESTOR_DEPTH = 256;

export function getRenderableCellRect(
  renderable: Pick<NativeSurfaceRenderableNode, "x" | "y" | "width" | "height">,
): CellRect {
  return {
    x: renderable.x,
    y: renderable.y,
    width: renderable.width,
    height: renderable.height,
  };
}

export function resolveNativeSurfaceVisibleRect(
  renderable: NativeSurfaceRenderableNode | null,
  terminalWidth: number,
  terminalHeight: number,
): CellRect | null {
  if (!renderable) return null;

  const cached = visibleRectCache.get(renderable);
  if (cached && cached.terminalWidth === terminalWidth && cached.terminalHeight === terminalHeight && ancestorChainUnchanged(renderable, cached.chain)) {
    return cached.visible;
  }
  const chain: Array<CellRect & { visible: boolean }> = [];
  let current: NativeSurfaceRenderableNode | null = renderable;
  const seen = new Set<NativeSurfaceRenderableNode>();
  let depth = 0;
  let visible: CellRect = {
    x: 0,
    y: 0,
    width: terminalWidth,
    height: terminalHeight,
  };
  while (current && !seen.has(current)) {
    if (depth >= MAX_RENDERABLE_ANCESTOR_DEPTH) return null;
    seen.add(current);
    depth += 1;
    if (current.visible === false) return null;
    const rect = getRenderableCellRect(current);
    const nextVisible = intersectCellRects(visible, rect);
    if (!nextVisible) return null;
    chain.push({ ...rect, visible: true });
    visible = nextVisible;
    current = current.parent;
  }
  visibleRectCache.set(renderable, { terminalWidth, terminalHeight, chain, visible });
  return visible;
}

function ancestorChainUnchanged(
  renderable: NativeSurfaceRenderableNode,
  chain: ReadonlyArray<CellRect & { visible: boolean }>,
): boolean {
  let current: NativeSurfaceRenderableNode | null = renderable;
  let index = 0;
  const seen = new Set<NativeSurfaceRenderableNode>();
  while (current && !seen.has(current)) {
    if (index >= chain.length || index >= MAX_RENDERABLE_ANCESTOR_DEPTH) return false;
    seen.add(current);
    const cached = chain[index]!;
    if (current.visible === false || current.x !== cached.x || current.y !== cached.y || current.width !== cached.width || current.height !== cached.height) return false;
    current = current.parent;
    index += 1;
  }
  return index === chain.length;
}

const visibleRectCache = new WeakMap<NativeSurfaceRenderableNode, {
  terminalWidth: number;
  terminalHeight: number;
  chain: Array<CellRect & { visible: boolean }>;
  visible: CellRect;
}>();
