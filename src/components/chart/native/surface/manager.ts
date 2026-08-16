import { type NativeRendererHost as CliRenderer } from "../../../../ui";
import {
  computeNativePlacements,
  excludeCellRects,
  intersectCellRects,
  type CellRect,
  type NativeChartBitmap,
} from "../chart-rasterizer";
import { KittyImageManager } from "../kitty/manager";

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

export interface NativeSurfaceSnapshot {
  id: string;
  paneId: string;
  rect: CellRect;
  visibleRect: CellRect | null;
  bitmap: NativeChartBitmap;
  bitmapKey: string;
  /** Kitty stacking order; defaults to the plot layer. */
  imageZIndex?: number;
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

function sameRect(a: CellRect | null, b: CellRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function samePaneLayer(a: NativePaneLayer, b: NativePaneLayer): boolean {
  return a.paneId === b.paneId && a.zIndex === b.zIndex;
}

function sameOccluder(a: NativeOccluder, b: NativeOccluder): boolean {
  return a.id === b.id
    && (a.paneId ?? null) === (b.paneId ?? null)
    && a.zIndex === b.zIndex
    && a.occludesOwnPane === b.occludesOwnPane
    && sameRect(a.rect, b.rect);
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

function sameSnapshot(a: NativeSurfaceSnapshot, b: NativeSurfaceSnapshot): boolean {
  return a.id === b.id
    && a.paneId === b.paneId
    && a.bitmapKey === b.bitmapKey
    && a.imageZIndex === b.imageZIndex
    && sameRect(a.rect, b.rect)
    && sameRect(a.visibleRect, b.visibleRect);
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

  constructor(private readonly renderer: CliRenderer) {}

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

  upsertSurface(snapshot: NativeSurfaceSnapshot) {
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
      && sameRect(entry.snapshot.rect, geometry.rect)
      && sameRect(entry.snapshot.visibleRect, geometry.visibleRect)) {
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
      && sameRect(existing.rect, occluder.rect)
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

  destroy() {
    for (const id of [...this.surfaces.keys()]) {
      this.removeSurface(id);
    }
    this.localOccluders.clear();
  }

  retransmitAll() {
    for (const entry of this.surfaces.values()) {
      entry.imageManager.forgetPlacedImages();
      this.syncSurface(entry);
    }
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

    const surfaceZIndex = this.windowState.paneLayers.find((layer) => layer.paneId === entry.snapshot.paneId)?.zIndex ?? 0;
    const localOccluders: NativeOccluder[] = [...this.localOccluders.values()].map((occluder) => ({
      ...occluder,
      zIndex: this.windowState.paneLayers.find((layer) => layer.paneId === occluder.paneId)?.zIndex ?? 0,
      occludesOwnPane: true,
    }));
    const fragments = computeSurfaceVisibleFragments(
      entry.snapshot.rect,
      entry.snapshot.visibleRect,
      surfaceZIndex,
      entry.snapshot.paneId,
      [...this.windowState.occluders, ...localOccluders],
    );

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
