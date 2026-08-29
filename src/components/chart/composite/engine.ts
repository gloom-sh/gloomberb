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
import { projectCompositeTimestamp } from "./time-scale";
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
          revision: this.snapshot.version + 0.5,
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
      offsetX: ratios ? -ratios.start * (previewWidth - 1) : 0,
    };
    this.emit(false);
    return true;
  }

  movePixelPan(x: number): void {
    const drag = this.drag;
    if (!drag || !this.config) return;
    const next = panCompositeViewport(
      drag.anchorViewport,
      this.config.navigationBounds,
      (x - drag.anchorX) / drag.width,
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
    const ratios = drag.previewScene ? viewportRatios(drag.previewScene, next) : null;
    if (ratios) drag.offsetX = -ratios.start * (drag.previewWidth - 1);
    this.emit(false);
  }

  endPixelPan(): void {
    const drag = this.drag;
    if (!drag) return;
    const pendingConfig = this.pendingConfig;
    const commit = (pendingConfig ?? this.config)?.onCommit;
    this.drag = null;
    if (!sameCompositeViewport(drag.startViewport, this.effectiveViewport())) {
      commit?.(this.interactionViewport, "pan");
    }
    if (pendingConfig) {
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
}: {
  engine: CompositeChartEngine;
  panelId: string;
  colors: CompositeChartColors;
  width: number;
  height: number;
  interactive: boolean;
  onActivate?: () => void;
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
  return {
    getFrame: frame,
    subscribe: engine.subscribeFrame,
    pointerDown(input: ChartPointerInput): boolean {
      if (!interactive || input.shift || input.alt || input.ctrl) return false;
      const accepted = engine.beginPixelPan(input.x, width);
      if (accepted) onActivate?.();
      return accepted;
    },
    pointerMove: (input) => engine.movePixelPan(input.x),
    pointerUp: () => engine.endPixelPan(),
    pointerCancel: () => engine.cancelPixelPan(),
  };
}
