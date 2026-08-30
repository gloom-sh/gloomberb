import type {
  ChartPaintFrame,
  ChartPaintSource,
  ChartPointerInput,
} from "../core/painter";
import type { ResolvedSeries } from "../../../time-series/types";
import {
  clampCompositeViewport,
  panCompositeViewport,
  sameCompositeViewport,
  zoomCompositeViewport,
  type CompositeViewportRange,
} from "./interactions";
import { paintCompositePanel } from "./painter";
import { projectCompositeTimestamp, unprojectCompositeTimestamp } from "./time-scale";
import type {
  CompositeAxisDomain,
  CompositeAxisSide,
  CompositeChartColors,
  CompositeChartScene,
} from "./types";

export type CompositeAxisDomains = ReadonlyMap<
  string,
  Partial<Record<CompositeAxisSide, CompositeAxisDomain>>
>;

export interface CompositeChartEngineConfig {
  resetKey: string;
  initialViewport: CompositeViewportRange;
  navigationBounds: CompositeViewportRange;
  series: ResolvedSeries[];
  allowHistoricalBackfill: boolean;
  buildScene(
    viewport: CompositeViewportRange,
    axisDomains?: CompositeAxisDomains,
    widthScale?: number,
    cursorDate?: Date | null,
  ): CompositeChartScene | null;
  onCommit(
    viewport: CompositeViewportRange | null,
    interaction: "pan" | "reset" | "sync" | "zoom",
  ): void;
}

export interface CompositeChartEngineSnapshot {
  viewport: CompositeViewportRange | null;
  interactionViewport: CompositeViewportRange | null;
  scene: CompositeChartScene | null;
  version: number;
}

interface CompositePaintState {
  scene: CompositeChartScene | null;
  width: number;
  offsetX: number;
  revision: number;
}

function axisDomains(scene: CompositeChartScene | null): CompositeAxisDomains | undefined {
  if (!scene) return undefined;
  return new Map(scene.panels.map((panel) => [panel.id, panel.axes] as const));
}

function sameAxisDomains(
  left: CompositeAxisDomains | undefined,
  right: CompositeAxisDomains | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.size !== right.size) return false;
  for (const [panelId, leftAxes] of left) {
    const rightAxes = right.get(panelId);
    if (!rightAxes) return false;
    for (const side of ["left", "right"] as const) {
      const a = leftAxes[side];
      const b = rightAxes[side];
      if (a === b) continue;
      if (
        !a || !b
        || a.min !== b.min
        || a.max !== b.max
        || a.scale !== b.scale
        || a.unit !== b.unit
        || a.unitGroup !== b.unitGroup
        || a.seriesIds.join("\0") !== b.seriesIds.join("\0")
      ) return false;
    }
  }
  return true;
}

function viewportRatios(
  scene: CompositeChartScene,
  viewport: CompositeViewportRange,
): { start: number; end: number } | null {
  const start = projectCompositeTimestamp(scene.timeScale, viewport.start.getTime())?.ratio;
  const end = projectCompositeTimestamp(scene.timeScale, viewport.end.getTime())?.ratio;
  return typeof start === "number" && typeof end === "number" && end > start
    ? { start, end }
    : null;
}

export class CompositeChartEngine {
  private config: CompositeChartEngineConfig | null = null;
  private pendingConfig: CompositeChartEngineConfig | null = null;
  private frameListeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();
  private interactionViewport: CompositeViewportRange | null = null;
  private drag: {
    width: number;
    startViewport: CompositeViewportRange;
    anchorX: number;
    anchorViewport: CompositeViewportRange;
    lastX: number;
    axes: CompositeAxisDomains | undefined;
    previewScene: CompositeChartScene | null;
    previewWidth: number;
    previewRevision: number;
    offsetX: number;
  } | null = null;
  private snapshot: CompositeChartEngineSnapshot = {
    viewport: null,
    interactionViewport: null,
    scene: null,
    version: 0,
  };

  configure(config: CompositeChartEngineConfig): void {
    if (this.config === config || this.pendingConfig === config) return;
    if (this.drag && this.config?.resetKey === config.resetKey) {
      this.pendingConfig = config;
      return;
    }
    this.pendingConfig = null;
    const hadConfig = this.config !== null;
    const reset = hadConfig && this.config?.resetKey !== config.resetKey;
    const previousInteraction = this.interactionViewport;
    this.config = config;
    const clampedInteraction = previousInteraction
      ? clampCompositeViewport(previousInteraction, config.navigationBounds)
      : null;
    this.interactionViewport = reset
      ? null
      : previousInteraction && clampedInteraction
        ? sameCompositeViewport(previousInteraction, clampedInteraction)
          ? previousInteraction
          : clampedInteraction
        : null;
    this.drag = null;
    this.rebuild();
    if (reset && previousInteraction) {
      config.onCommit(null, "reset");
    } else if (
      previousInteraction
      && this.interactionViewport
      && !sameCompositeViewport(previousInteraction, this.interactionViewport)
    ) {
      config.onCommit(this.interactionViewport, "sync");
    }
  }

  subscribeFrame = (listener: () => void): (() => void) => {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  };

  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  getSnapshot = (): CompositeChartEngineSnapshot => this.snapshot;

  getPaintState(surfaceWidth: number): CompositePaintState {
    return this.drag
      ? {
          scene: this.drag.previewScene,
          width: this.drag.previewWidth,
          offsetX: this.drag.offsetX,
          revision: this.drag.previewRevision,
        }
      : {
          scene: this.snapshot.scene,
          width: surfaceWidth,
          offsetX: 0,
          revision: this.snapshot.version,
        };
  }

  isConfigured(config: CompositeChartEngineConfig): boolean {
    return this.config === config || this.pendingConfig === config;
  }

  hasResetKey(resetKey: string): boolean {
    return this.config?.resetKey === resetKey;
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  private emit(publishState: boolean): void {
    for (const listener of this.frameListeners) listener();
    if (publishState) {
      for (const listener of this.stateListeners) listener();
    }
  }

  private effectiveViewport(): CompositeViewportRange | null {
    if (!this.config) return null;
    return this.interactionViewport ?? this.config.initialViewport;
  }

  private rebuild(axes?: CompositeAxisDomains, publishState = true): void {
    const viewport = this.effectiveViewport();
    const scene = this.config && viewport
      ? this.config.buildScene(viewport, axes)
      : null;
    this.snapshot = {
      viewport,
      interactionViewport: this.interactionViewport,
      scene,
      version: this.snapshot.version + 1,
    };
    this.emit(publishState);
  }

  private updateViewport(
    next: CompositeViewportRange,
    axes?: CompositeAxisDomains,
    publishState = true,
  ): boolean {
    if (!this.config || sameCompositeViewport(next, this.effectiveViewport())) return false;
    this.interactionViewport = sameCompositeViewport(next, this.config.initialViewport)
      ? null
      : next;
    this.rebuild(axes, publishState);
    return true;
  }

  pan(
    shiftRatio: number,
    fromViewport?: CompositeViewportRange,
    commit = true,
  ): void {
    if (!this.config) return;
    const base = fromViewport ?? this.effectiveViewport();
    if (!base) return;
    const next = panCompositeViewport(
      base,
      this.config.navigationBounds,
      shiftRatio,
      this.config.series,
      this.config.allowHistoricalBackfill,
    );
    const changed = this.updateViewport(next, this.drag?.axes, commit);
    if (changed && commit) this.commit("pan");
  }

  zoom(zoomFactor: number, anchorRatio: number, minimumSpanMs: number): void {
    if (!this.config) return;
    const base = this.effectiveViewport();
    if (!base) return;
    const changed = this.updateViewport(zoomCompositeViewport(
      base,
      this.config.navigationBounds,
      zoomFactor,
      anchorRatio,
      minimumSpanMs,
      this.config.series,
    ));
    if (changed) this.commit("zoom");
  }

  setViewport(viewport: CompositeViewportRange): void {
    if (!this.config) return;
    if (this.updateViewport(clampCompositeViewport(viewport, this.config.navigationBounds))) {
      this.commit("zoom");
    }
  }

  reset(): void {
    if (!this.config) return;
    this.interactionViewport = null;
    this.rebuild();
    this.config.onCommit(null, "reset");
  }

  beginPixelPan(x: number, width: number): boolean {
    const viewport = this.effectiveViewport();
    if (!this.config || !viewport || !(width > 0)) return false;
    const axes = axisDomains(this.snapshot.scene);
    const older = panCompositeViewport(
      viewport,
      this.config.navigationBounds,
      1,
      this.config.series,
      this.config.allowHistoricalBackfill,
    );
    const newer = panCompositeViewport(
      viewport,
      this.config.navigationBounds,
      -1,
      this.config.series,
      this.config.allowHistoricalBackfill,
    );
    const previewScene = this.config.buildScene(
      { start: older.start, end: newer.end },
      axes,
      3,
    ) ?? this.snapshot.scene;
    const ratios = previewScene ? viewportRatios(previewScene, viewport) : null;
    const previewWidth = ratios
      ? 1 + Math.max(width - 1, 1) / (ratios.end - ratios.start)
      : width;
    this.drag = {
      width: Math.max(width - 1, 1),
      startViewport: viewport,
      anchorX: x,
      anchorViewport: viewport,
      lastX: x,
      axes,
      previewScene,
      previewWidth,
      previewRevision: this.snapshot.version + 0.5,
      offsetX: ratios ? -ratios.start * (previewWidth - 1) : 0,
    };
    this.emit(false);
    return true;
  }

  movePixelPan(x: number): void {
    const drag = this.drag;
    if (!drag || !this.config) return;
    const shiftRatio = (x - drag.anchorX) / drag.width;
    const next = panCompositeViewport(
      drag.anchorViewport,
      this.config.navigationBounds,
      shiftRatio,
      this.config.series,
      this.config.allowHistoricalBackfill,
    );
    if (sameCompositeViewport(next, this.effectiveViewport())) {
      if (x !== drag.lastX) {
        drag.anchorX = x;
        drag.anchorViewport = next;
      }
      drag.lastX = x;
      return;
    }
    drag.lastX = x;
    this.interactionViewport = sameCompositeViewport(next, this.config.initialViewport)
      ? null
      : next;
    const bounds = this.config.navigationBounds;
    if (
      (shiftRatio < 0 && next.end.getTime() === bounds.end.getTime())
      || (shiftRatio > 0 && next.start.getTime() === bounds.start.getTime())
    ) {
      drag.anchorX = x;
      drag.anchorViewport = next;
    }
    const ratios = drag.previewScene ? viewportRatios(drag.previewScene, next) : null;
    if (ratios) drag.offsetX = -ratios.start * (drag.previewWidth - 1);
    this.emit(false);
  }

  refreshPixelPanState(pointerX: number): CompositeChartScene | null {
    const drag = this.drag;
    const viewport = this.effectiveViewport();
    const config = this.pendingConfig ?? this.config;
    if (!drag || !viewport || !config) return null;
    const ratio = Math.max(0, Math.min(
      1,
      (pointerX - drag.offsetX) / Math.max(drag.previewWidth - 1, 1),
    ));
    const cursorDate = drag.previewScene
      ? new Date(unprojectCompositeTimestamp(drag.previewScene.timeScale, ratio))
      : null;
    const scene = config.buildScene(viewport, undefined, 1, cursorDate);
    const nextVersion = this.snapshot.version + 1;
    this.snapshot = {
      viewport,
      interactionViewport: this.interactionViewport,
      scene,
      version: nextVersion,
    };

    const nextAxes = axisDomains(scene);
    const visibleRatios = drag.previewScene
      ? viewportRatios(drag.previewScene, viewport)
      : null;
    const bounds = config.navigationBounds;
    const needsRecentering = !visibleRatios
      || (visibleRatios.start < 0.15 && viewport.start.getTime() > bounds.start.getTime())
      || (visibleRatios.end > 0.85 && viewport.end.getTime() < bounds.end.getTime());
    if (!sameAxisDomains(drag.axes, nextAxes) || needsRecentering) {
      const older = panCompositeViewport(
        viewport,
        bounds,
        0.5,
        config.series,
        config.allowHistoricalBackfill,
      );
      const newer = panCompositeViewport(
        viewport,
        bounds,
        -0.5,
        config.series,
        config.allowHistoricalBackfill,
      );
      const previewScene = config.buildScene(
        { start: older.start, end: newer.end },
        nextAxes,
        2,
        cursorDate,
      ) ?? scene;
      const ratios = previewScene ? viewportRatios(previewScene, viewport) : null;
      const previewWidth = ratios
        ? 1 + drag.width / (ratios.end - ratios.start)
        : drag.width + 1;
      drag.anchorX = pointerX;
      drag.anchorViewport = viewport;
      drag.axes = nextAxes;
      drag.previewScene = previewScene;
      drag.previewWidth = previewWidth;
      drag.previewRevision = nextVersion + 0.5;
      drag.offsetX = ratios ? -ratios.start * (previewWidth - 1) : 0;
      this.emit(true);
    } else {
      for (const listener of this.stateListeners) listener();
    }
    return scene;
  }

  endPixelPan(): void {
    const drag = this.drag;
    if (!drag) return;
    const pendingConfig = this.pendingConfig;
    const commit = (pendingConfig ?? this.config)?.onCommit;
    const viewport = this.effectiveViewport();
    const hasLiveScene = !!viewport
      && !!this.snapshot.viewport
      && sameCompositeViewport(viewport, this.snapshot.viewport);
    this.drag = null;
    if (!sameCompositeViewport(drag.startViewport, viewport)) {
      commit?.(this.interactionViewport, "pan");
    }
    if (hasLiveScene) {
      if (pendingConfig) {
        this.pendingConfig = null;
        this.config = pendingConfig;
      }
      this.emit(true);
    } else if (pendingConfig) {
      this.pendingConfig = null;
      this.configure(pendingConfig);
    } else {
      this.rebuild();
    }
  }

  cancelPixelPan(): void {
    const drag = this.drag;
    if (!drag) return;
    const pendingConfig = this.pendingConfig;
    this.drag = null;
    if (!this.updateViewport(drag.startViewport)) this.rebuild();
    if (pendingConfig) {
      this.pendingConfig = null;
      this.configure(pendingConfig);
    }
  }

  private commit(interaction: "pan" | "zoom"): void {
    this.config?.onCommit(this.interactionViewport, interaction);
  }
}

export function createCompositePanelPaintSource({
  engine,
  panelId,
  colors,
  width,
  height,
  interactive,
  onActivate,
  onPanFrame,
}: {
  engine: CompositeChartEngine;
  panelId: string;
  colors: CompositeChartColors;
  width: number;
  height: number;
  interactive: boolean;
  onActivate?: () => void;
  onPanFrame?: (cursorDate: Date | null, yRatio: number) => void;
}): ChartPaintSource {
  const frame = (): ChartPaintFrame | null => {
    const paintState = engine.getPaintState(width);
    const panel = paintState.scene?.panels.find((entry) => entry.id === panelId);
    return panel
      ? {
          width: paintState.width,
          height,
          revision: paintState.revision,
          offsetX: paintState.offsetX,
          paint: (painter) => paintCompositePanel(
            painter,
            panel,
            colors,
            paintState.width,
            height,
          ),
        }
      : null;
  };
  let scrollPosition = 0;
  let scrollPanning = false;
  const endScrollPan = () => {
    if (!scrollPanning) return;
    scrollPanning = false;
    scrollPosition = 0;
    engine.endPixelPan();
  };
  return {
    getFrame: frame,
    subscribe: engine.subscribeFrame,
    pointerDown(input: ChartPointerInput): boolean {
      if (!interactive || input.shift || input.alt || input.ctrl) return false;
      endScrollPan();
      const accepted = engine.beginPixelPan(input.x, width);
      if (accepted) onActivate?.();
      return accepted;
    },
    pointerMove: (input) => engine.movePixelPan(input.x),
    pointerUp: () => engine.endPixelPan(),
    pointerCancel: () => engine.cancelPixelPan(),
    scrollPan(deltaPixels: number): boolean {
      if (!interactive || !Number.isFinite(deltaPixels) || deltaPixels === 0) return false;
      if (!scrollPanning) {
        if (engine.isDragging() || !engine.beginPixelPan(0, width)) return false;
        scrollPanning = true;
        scrollPosition = 0;
        onActivate?.();
      }
      scrollPosition -= deltaPixels;
      engine.movePixelPan(scrollPosition);
      return true;
    },
    panFrame(input) {
      const scene = engine.refreshPixelPanState(input.x);
      onPanFrame?.(
        scene?.cursorDate ?? null,
        Math.max(0, Math.min(1, input.y / Math.max(height - 1, 1))),
      );
    },
    scrollPanEnd: endScrollPan,
  };
}
