import type { ChartMouseEvent } from "../../core/pointer";
import type { CompositeCursorSource } from "../cursor-source";
import type { CompositeAxisValueFormatter } from "../format";
import type { CompositeNavigationFrame, CompositeViewportRange } from "../interactions";
import type { CompositeChartLevels } from "../levels";
import type { ChartDrawing, ChartToolKind, ChartToolSpan } from "../tools";
import type { CompositeAxisSide, CompositeChartColors, CompositeChartScene, CompositePanelScene } from "../types";
import type { KeyboardToolDrag } from "../use-composite-chart-keyboard";
import type { CompositeValueRange } from "../value-scale";

export interface CompositePanelSurfaceProps {
  panel: CompositePanelScene;
  /** The chart's scene, without its cursor: the crosshair comes from `cursor`. */
  scene: CompositeChartScene;
  cursor: CompositeCursorSource;
  plotWidth: number;
  leftAxisWidth: number;
  rightAxisWidth: number;
  axisGap: number;
  colors: CompositeChartColors;
  interactive: boolean;
  /** False keeps the hover cursor but removes pan, zoom, and the tools. */
  navigable: boolean;
  formatAxisValue?: CompositeAxisValueFormatter;
  remoteKind?: string;
  viewport: CompositeViewportRange;
  frame: CompositeNavigationFrame;
  armedTool: ChartToolKind | null;
  drawings: readonly ChartDrawing[];
  selectedDrawingId: string | null;
  drawColor: string;
  onDraw: (drawing: ChartDrawing) => void;
  onEditDrawing: (id: string, update: (drawing: ChartDrawing) => ChartDrawing) => void;
  onSelectDrawing: (id: string | null) => void;
  onActivate?: () => void;
  onCursorDateChange: (date: Date | null) => void;
  /** The cursor shown is another chart's, so the pointer's level is not part of it. */
  sharedCursor: boolean;
  /** Positive positions move toward older observations. A gesture supplies the frame and origin it started from. */
  onPanViewport: (
    deltaPositions: number,
    gesture?: { frame: CompositeNavigationFrame; from: CompositeViewportRange },
  ) => void;
  onZoomViewport: (zoomFactor: number, anchorRatio: number) => void;
  onSetViewport: (range: CompositeViewportRange) => void;
  onToolSpanChange: (span: ChartToolSpan | null) => void;
  /** A press on the plot started (true) or stopped (false) dragging: a pan, a tool, a drawing or a level. */
  onDragActiveChange?: (dragging: boolean) => void;
  /** The tool being placed from the keyboard, when it lives in this panel. */
  keyboardToolDrag: KeyboardToolDrag | null;
  /** A press on the plot: the pointer takes over from a keyboard placement. */
  onPointerPress: () => void;
  showTextFallback: boolean;
  /** Set while the owner is picking a bar: a press picks instead of panning. */
  onPickTime?: (date: Date) => void;
  /** Set while the owner is picking a price on the levels' series: a press picks the one under it. */
  onPickPrice?: (value: number) => void;
  /** The chart's levels when they draw on this panel. */
  levels: CompositeChartLevels | null;
  selectedLevelId: string | null;
  onSelectLevel: (id: string | null) => void;
  /** The value axes stretch and squeeze under a drag or the wheel, and a double click fits them again. */
  valueScalable: boolean;
  onSetValueScale: (panelId: string, side: CompositeAxisSide, key: string, range: CompositeValueRange) => void;
  onResetValueScale: (panelId: string) => void;
  /** A hairline on the line above this panel (desktop and web), as the chart's `panelRules` asks. */
  ruleAbove?: boolean;
  /** The line above this panel, which a drag moves (desktop and web): null for the top panel. */
  dividerAbove?: { active: boolean; gestures: PanelDividerGestures } | null;
  /** A double click on bare plot gives this panel the whole chart, or gives the others back. */
  onToggleMaximized?: () => void;
}

interface PanelDividerGestures {
  onMouseDown: (event: ChartMouseEvent) => void;
  onMouseDrag: (event: ChartMouseEvent) => void;
  onMouseUp: (event: ChartMouseEvent) => void;
  onMouseDragEnd: (event: ChartMouseEvent) => void;
}
