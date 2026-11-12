import { type NativeRendererHost as CliRenderer } from "../../../../ui";
import {
  computeNativePlacements,
  excludeCellRects,
  intersectCellRects,
  sameCellRect,
  type CellRect,
  type NativeChartBitmap,
} from "../chart-rasterizer";
import { KittyImageManager } from "../kitty/manager";
import { getRenderableCellRect, resolveNativeSurfaceVisibleRect, type NativeSurfaceRenderableNode } from "./visibility";

export interface NativePaneLayer {
  paneId: string;
  zIndex: number;
}

export interface NativeOccluder {
  id: string;
  paneId?: string | null;
  rect: CellRect;
  zIndex: number;
  /** Explicit overlays may cover a native surface inside their own pane. */
  occludesOwnPane?: boolean;
}

export interface NativeLocalOccluder {
  id: string;
  paneId: string;
  rect: CellRect;
}

export interface CellInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The box an image draws over. After every frame the terminal shows, the
 * image is measured again from it and kept off every cell something else drew
 * on top of it, so it follows the layout, scrolling and clipping of that frame,
 * goes when the box leaves the screen, and never shows over a window, menu,
 * bar or toast that covers it.
 */
export interface NativeSurfaceAnchor {
  renderable: NativeSurfaceRenderableNode;
  /** Cells kept clear inside the box, as a border or padding does. */
  insets?: CellInsets;
  /** Part of the inset box, from its top-left cell: a crosshair strip over its chart. */
  region?: CellRect;
}

export interface NativeSurfaceSnapshot {
  id: string;
  paneId: string;
  rect: CellRect;
  visibleRect: CellRect | null;
  bitmap: NativeChartBitmap;
  bitmapKey: string;
  /** Kitty stacking order; defaults to the plot layer. */
  imageZIndex?: number;
  anchor?: NativeSurfaceAnchor;
}

interface SurfaceEntry {
  imageManager: KittyImageManager;
  snapshot: NativeSurfaceSnapshot;
}

interface NativeWindowState {
  paneLayers: NativePaneLayer[];
  occluders: NativeOccluder[];
}

function compareRects(a: CellRect, b: CellRect): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.x !== b.x) return a.x - b.x;
  if (a.height !== b.height) return a.height - b.height;
  return a.width - b.width;
}

function samePaneLayer(a: NativePaneLayer, b: NativePaneLayer): boolean {
  return a.paneId === b.paneId && a.zIndex === b.zIndex;
}

function sameOccluder(a: NativeOccluder, b: NativeOccluder): boolean {
  return a.id === b.id
    && (a.paneId ?? null) === (b.paneId ?? null)
    && a.zIndex === b.zIndex
    && a.occludesOwnPane === b.occludesOwnPane
    && sameCellRect(a.rect, b.rect);
}

function sameWindowState(a: NativeWindowState, b: NativeWindowState): boolean {
  if (a.paneLayers.length !== b.paneLayers.length || a.occluders.length !== b.occluders.length) {
    return false;
  }

  for (let index = 0; index < a.paneLayers.length; index += 1) {
    if (!samePaneLayer(a.paneLayers[index]!, b.paneLayers[index]!)) {
      return false;
    }
  }

  for (let index = 0; index < a.occluders.length; index += 1) {
    if (!sameOccluder(a.occluders[index]!, b.occluders[index]!)) {
      return false;
    }
  }

  return true;
}

function sameInsets(a: CellInsets | undefined, b: CellInsets | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

function sameAnchor(a: NativeSurfaceAnchor | undefined, b: NativeSurfaceAnchor | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.renderable === b.renderable
    && sameInsets(a.insets, b.insets)
    && sameCellRect(a.region ?? null, b.region ?? null);
}

function sameSnapshot(a: NativeSurfaceSnapshot, b: NativeSurfaceSnapshot): boolean {
  return a.id === b.id
    && a.paneId === b.paneId
    && a.bitmapKey === b.bitmapKey
    && a.imageZIndex === b.imageZIndex
    && sameAnchor(a.anchor, b.anchor)
    && sameCellRect(a.rect, b.rect)
    && sameCellRect(a.visibleRect, b.visibleRect);
}

export function insetCellRect(rect: CellRect, insets: CellInsets | undefined): CellRect | null {
  if (!insets) return rect;
  const width = rect.width - insets.left - insets.right;
  const height = rect.height - insets.top - insets.bottom;
  if (width <= 0 || height <= 0) return null;
  return { x: rect.x + insets.left, y: rect.y + insets.top, width, height };
}

/**
 * Where an anchored image is in the frame just drawn: its box (or the part of
 * it the region names) and the cells of it its ancestors leave on screen, none
 * once the box is hidden, destroyed or out of the tree.
 */
function measureNativeSurfaceAnchor(
  anchor: NativeSurfaceAnchor,
  terminalWidth: number,
  terminalHeight: number,
  attached: (renderable: unknown) => boolean,
): { rect: CellRect; visibleRect: CellRect | null } | null {
  const box = insetCellRect(getRenderableCellRect(anchor.renderable), anchor.insets);
  if (!box) return null;
  const rect = anchor.region
    ? { x: box.x + anchor.region.x, y: box.y + anchor.region.y, width: anchor.region.width, height: anchor.region.height }
    : box;
  if (!attached(anchor.renderable)) return { rect, visibleRect: null };
  const outer = resolveNativeSurfaceVisibleRect(anchor.renderable, terminalWidth, terminalHeight);
  return { rect, visibleRect: outer ? intersectCellRects(rect, outer) : null };
}

/** The renderable a pane window carries its pane id on. */
const PANE_ID_PROPERTY = "data-gloom-pane-id";
const MAX_ANCESTOR_DEPTH = 256;
/** More pieces than this means something scattered covers the image: it is hidden instead. */
const MAX_UNCOVERED_FRAGMENTS = 128;

type ParentedNode = { parent?: unknown } | null | undefined;

function parentOf(node: unknown): unknown {
  return node && typeof node === "object" ? (node as ParentedNode)?.parent ?? null : null;
}

/**
 * Whether a renderable the frame drew on top of an anchored image covers it.
 * The image's own pane draws over its charts on purpose (legends, toolbars,
 * axis labels): only its explicit local occluders cut those. Anything else
 * covers the image where it or a box it sits in fills its cells, up to the
 * first box the image also sits in: a window, a menu, a bar, a toast. A
 * see-through layer (a click catcher) does not, and text without a background
 * draws over the image anyway.
 */
function createCoverTest(
  anchor: NativeSurfaceRenderableNode,
  paints: (renderable: unknown) => boolean,
): (hit: unknown) => boolean {
  // The image's ancestors up to its pane window hold its own pane's drawing;
  // the ones above it hold everything else.
  const chain: unknown[] = [];
  let home = -1;
  let node = parentOf(anchor);
  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    chain.push(node);
    if (home < 0 && typeof (node as Record<string, unknown>)[PANE_ID_PROPERTY] === "string") home = chain.length - 1;
    node = parentOf(node);
  }
  // Outside any pane, what the image's own component draws beside it is its own.
  if (home < 0) home = chain.length > 0 ? 0 : -1;
  const own = new Set<unknown>([anchor, ...chain.slice(0, home + 1)]);
  const shared = new Set<unknown>(chain.slice(home + 1));
  const known = new Map<unknown, boolean>();
  return (hit) => {
    if (hit == null || hit === anchor) return false;
    const cached = known.get(hit);
    if (cached !== undefined) return cached;
    let covers = false;
    let current: unknown = hit;
    for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      if (own.has(current)) {
        covers = false;
        break;
      }
      if (shared.has(current)) break;
      if (paints(current)) covers = true;
      current = parentOf(current);
    }
    known.set(hit, covers);
    return covers;
  };
}

/**
 * The cells of `rect` nothing covers, as rectangles: runs of uncovered cells
 * row by row, a run that lines up with the one above it extending it down.
 */
function uncoveredCellRects(rect: CellRect, covered: (x: number, y: number) => boolean): CellRect[] {
  const done: CellRect[] = [];
  let open: CellRect[] = [];
  const right = rect.x + rect.width;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const next: CellRect[] = [];
    let start = -1;
    for (let x = rect.x; x <= right; x += 1) {
      const free = x < right && !covered(x, y);
      if (free && start < 0) start = x;
      if (!free && start >= 0) {
        const above = open.find((candidate) => candidate.x === start && candidate.x + candidate.width === x);
        if (above) {
          above.height += 1;
          next.push(above);
        } else {
          next.push({ x: start, y, width: x - start, height: 1 });
        }
        start = -1;
      }
    }
    for (const candidate of open) if (!next.includes(candidate)) done.push(candidate);
    open = next;
  }
  return [...done, ...open];
}

export function computeSurfaceVisibleFragments(
  rect: CellRect,
  visibleRect: CellRect | null,
  surfaceZIndex: number,
  paneId: string,
  occluders: NativeOccluder[],
): CellRect[] {
  if (!visibleRect) return [];
  const clipped = intersectCellRects(rect, visibleRect);
  if (!clipped) return [];

  const relevantCuts = occluders
    .filter((occluder) => (
      occluder.paneId === paneId
        ? occluder.occludesOwnPane === true
        : occluder.zIndex >= surfaceZIndex
    ))
    .sort((left, right) => right.zIndex - left.zIndex)
    .map((occluder) => occluder.rect);

  return excludeCellRects(clipped, relevantCuts).sort(compareRects);
}

export class NativeSurfaceManager {
  private windowState: NativeWindowState = { paneLayers: [], occluders: [] };
  private readonly surfaces = new Map<string, SurfaceEntry>();
  private readonly localOccluders = new Map<string, NativeLocalOccluder>();

  private readonly onFrame = () => {
    if (this.surfaces.size === 0) return;
    this.frameSync();
  };

  constructor(private readonly renderer: CliRenderer) {
    // Only a terminal host reports what its frames drew; then every frame it
    // shows re-measures the anchored images and re-cuts them all.
    if (renderer.frameHits && typeof renderer.on === "function") renderer.on("frame", this.onFrame);
  }

  setWindowState(windowState: NativeWindowState) {
    if (sameWindowState(this.windowState, windowState)) {
      return;
    }
    this.windowState = {
      paneLayers: [...windowState.paneLayers],
      occluders: [...windowState.occluders],
    };
    this.syncAll();
  }

  upsertSurface(incoming: NativeSurfaceSnapshot) {
    // An anchored image goes where its box is in the frame on screen, which
    // the rect React measured before that frame's layout can trail.
    const snapshot = this.onScreen(incoming);
    const existing = this.surfaces.get(snapshot.id);
    if (existing) {
      if (sameSnapshot(existing.snapshot, snapshot)) {
        return;
      }
      existing.snapshot = snapshot;
      this.syncSurface(existing);
      return;
    }

    const entry: SurfaceEntry = {
      imageManager: new KittyImageManager(this.renderer),
      snapshot,
    };
    this.surfaces.set(snapshot.id, entry);
    this.syncSurface(entry);
  }

  updateSurfaceGeometry(id: string, geometry: Pick<NativeSurfaceSnapshot, "paneId" | "rect" | "visibleRect">) {
    const entry = this.surfaces.get(id);
    if (!entry) return;
    if (entry.snapshot.paneId === geometry.paneId
      && sameCellRect(entry.snapshot.rect, geometry.rect)
      && sameCellRect(entry.snapshot.visibleRect, geometry.visibleRect)) {
      return;
    }
    entry.snapshot = {
      ...entry.snapshot,
      ...geometry,
    };
    this.syncSurface(entry);
  }

  removeSurface(id: string) {
    const entry = this.surfaces.get(id);
    if (!entry) return;
    entry.imageManager.destroy();
    this.surfaces.delete(id);
  }

  upsertLocalOccluder(occluder: NativeLocalOccluder) {
    const existing = this.localOccluders.get(occluder.id);
    if (
      existing
      && existing.paneId === occluder.paneId
      && sameCellRect(existing.rect, occluder.rect)
    ) {
      return;
    }
    this.localOccluders.set(occluder.id, occluder);
    this.syncAll();
  }

  removeLocalOccluder(id: string) {
    if (!this.localOccluders.delete(id)) return;
    this.syncAll();
  }

  /**
   * Every image as it shows now, with the cells left visible once the panes,
   * menus and dialogs over it are cut away: what a picture of the screen
   * draws back over the blank cells kitty images leave in the frame.
   */
  visibleImages(): Array<{ rect: CellRect; fragments: CellRect[]; bitmap: NativeChartBitmap }> {
    const occluders = this.resolvedOccluders();
    return [...this.surfaces.values()]
      .map(({ snapshot }) => ({ snapshot, zIndex: this.paneZIndex(snapshot.paneId) }))
      .sort((a, b) => a.zIndex - b.zIndex || (a.snapshot.imageZIndex ?? 0) - (b.snapshot.imageZIndex ?? 0))
      .map(({ snapshot }) => ({
        rect: snapshot.rect,
        fragments: this.visibleFragments(snapshot, occluders),
        bitmap: snapshot.bitmap,
      }))
      .filter((image) => image.fragments.length > 0);
  }

  destroy() {
    if (this.renderer.frameHits && typeof this.renderer.off === "function") this.renderer.off("frame", this.onFrame);
    for (const id of [...this.surfaces.keys()]) {
      this.removeSurface(id);
    }
    this.localOccluders.clear();
  }

  /** After a frame: each anchored image where its box is now, each image off what now covers it. */
  private frameSync() {
    for (const entry of this.surfaces.values()) {
      entry.snapshot = this.onScreen(entry.snapshot);
      this.syncSurface(entry);
    }
  }

  /** An anchored snapshot measured from its box as the frame on screen laid it out. */
  private onScreen(snapshot: NativeSurfaceSnapshot): NativeSurfaceSnapshot {
    const attached = this.renderer.frameHits?.attached;
    if (!snapshot.anchor || !attached) return snapshot;
    const measured = measureNativeSurfaceAnchor(snapshot.anchor, this.renderer.terminalWidth, this.renderer.terminalHeight, attached);
    if (!measured) return snapshot.visibleRect === null ? snapshot : { ...snapshot, visibleRect: null };
    if (sameCellRect(measured.rect, snapshot.rect) && sameCellRect(measured.visibleRect, snapshot.visibleRect)) return snapshot;
    return { ...snapshot, rect: measured.rect, visibleRect: measured.visibleRect };
  }

  /** The cells of an image left to show: its visible rect, less the layout's occluders and whatever the frame drew over it. */
  private visibleFragments(snapshot: NativeSurfaceSnapshot, occluders: NativeOccluder[]): CellRect[] {
    const fragments = computeSurfaceVisibleFragments(
      snapshot.rect,
      snapshot.visibleRect,
      this.paneZIndex(snapshot.paneId),
      snapshot.paneId,
      occluders,
    );
    const hits = this.renderer.frameHits;
    if (!hits || !snapshot.anchor || fragments.length === 0) return fragments;
    const covers = createCoverTest(snapshot.anchor.renderable, hits.paints);
    const uncovered = fragments.flatMap((fragment) => uncoveredCellRects(fragment, (x, y) => covers(hits.at(x, y))));
    return uncovered.length > MAX_UNCOVERED_FRAGMENTS ? [] : uncovered.sort(compareRects);
  }

  private paneZIndex(paneId: string): number {
    return this.windowState.paneLayers.find((layer) => layer.paneId === paneId)?.zIndex ?? 0;
  }

  private resolvedOccluders(): NativeOccluder[] {
    const localOccluders: NativeOccluder[] = [...this.localOccluders.values()].map((occluder) => ({
      ...occluder,
      zIndex: this.paneZIndex(occluder.paneId),
      occludesOwnPane: true,
    }));
    return [...this.windowState.occluders, ...localOccluders];
  }

  private syncAll() {
    for (const entry of this.surfaces.values()) {
      this.syncSurface(entry);
    }
  }

  private syncSurface(entry: SurfaceEntry) {
    const resolution = this.renderer.resolution;
    if (!resolution) {
      entry.imageManager.clear();
      return;
    }

    const fragments = this.visibleFragments(entry.snapshot, this.resolvedOccluders());

    const placements = computeNativePlacements(
      entry.snapshot.rect,
      fragments,
      entry.snapshot.bitmap,
      resolution,
      this.renderer.terminalWidth,
      this.renderer.terminalHeight,
    ).map((placement) => (
      entry.snapshot.imageZIndex === undefined
        ? placement
        : { ...placement, zIndex: entry.snapshot.imageZIndex }
    ));

    if (placements.length === 0) {
      entry.imageManager.clear();
      return;
    }

    entry.imageManager.render(entry.snapshot.bitmap, placements, entry.snapshot.bitmapKey);
  }
}

const nativeSurfaceManagers = new WeakMap<CliRenderer, NativeSurfaceManager>();

export function getNativeSurfaceManager(renderer: CliRenderer): NativeSurfaceManager {
  const existing = nativeSurfaceManagers.get(renderer);
  if (existing) return existing;
  const manager = new NativeSurfaceManager(renderer);
  nativeSurfaceManagers.set(renderer, manager);
  return manager;
}
