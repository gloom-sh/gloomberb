import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShortcut } from "../../../react/input";
import {
  usePaneArrowHold,
  usePaneArrowsClaimed,
  usePaneFooter,
  usePaneHasTabStrip,
} from "../../layout/pane/footer/registration";
import type { PaneHint } from "../../layout/pane/footer/model";
import type { ContextMenuItem } from "../../../types/context-menu";
import type { ResolvedSeries } from "../../../time-series/types";
import { isPlainKey } from "../../../utils/keyboard";
import { nextDrawingId, nextLevelId } from "./drawing-store";
import { CHART_TOOL_MENU, KEYBOARD_TOOL_HINTS, ARMED_TOOL_BY_INTERACTION } from "./tool-catalog";
import {
  COMPOSITE_KEYBOARD_PAN_RATIO,
  COMPOSITE_ZOOM_STEP_FACTOR,
  resolveCompositeChartInteraction,
  type CompositeNavigationFrame,
  type CompositeViewportRange,
} from "./interactions";
import { levelPanel, roundLevelValue, type CompositeChartLevel } from "./levels";
import {
  resolveMeasureAxisDomain,
  resolveMeasureValueAt,
  resolveZoomTimeRange,
  isDrawingTool,
  nextDrawingColor,
  type ChartDrawing,
  type ChartDrawingPoint,
  type ChartToolDrag,
  type ChartToolKind,
} from "./tools";
import { projectCompositeTimestamp } from "./time-scale";
import { projectCompositeValue, resolveAdjacentCompositeCursorDate, unprojectCompositeValue } from "./scene";
import type { CompositeChartProps, CompositeChartScene } from "./types";

/**
 * A tool placed from the keyboard: Enter anchors it at the cursor, the arrows
 * move its end and Enter finishes it. Held in data, so a pan, a zoom or a new
 * bar leaves it on the observations it was placed on.
 */
interface KeyboardToolPlacement {
  kind: ChartToolKind;
  panelId: string;
  start: ChartDrawingPoint;
  end: ChartDrawingPoint;
  /** Every step the end took: the freehand tool's trail. */
  path: ChartDrawingPoint[];
  /** Up or Down set the end's level, so Left and Right stop following the series. */
  freeValue: boolean;
}

/** A keyboard placement projected into the plot of the panel that holds it. */
export interface KeyboardToolDrag {
  panelId: string;
  drag: ChartToolDrag;
  start: ChartDrawingPoint;
  end: ChartDrawingPoint;
}

/** Shift and a letter, whether or not the terminal reports the shift itself. */
function isShiftedLetter(event: { name?: string; shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean }, letter: string): boolean {
  if (event.ctrl || event.meta || event.alt) return false;
  return event.name === letter.toUpperCase() || (event.shift === true && event.name === letter);
}

export function useCompositeChartKeyboard({
  focused,
  interactive,
  navigable,
  showLegend,
  scene,
  cursorDate,
  updateCursor,
  onActivate,
  timePick,
  levels,
  visibleLegendSeries,
  visibleSeriesIds,
  onToggleSeries,
  isSeriesToggleable,
  navigationFrame,
  activeUserViewport,
  panViewportByRatio,
  zoomViewport,
  setViewportRange,
  resetViewport,
  drawings,
  selectedDrawingId,
  setSelectedDrawingId,
  drawColor,
  addDrawing,
  removeDrawing,
  pickDrawColor,
}: {
  focused: boolean;
  interactive: boolean;
  navigable: boolean;
  showLegend: boolean;
  scene: CompositeChartScene | null;
  cursorDate: CompositeChartProps["cursorDate"];
  updateCursor: (date: Date | null) => void;
  onActivate: CompositeChartProps["onActivate"];
  timePick: CompositeChartProps["timePick"];
  levels: CompositeChartProps["levels"];
  visibleLegendSeries: ResolvedSeries[];
  visibleSeriesIds: ReadonlySet<string>;
  onToggleSeries: CompositeChartProps["onToggleSeries"];
  isSeriesToggleable: CompositeChartProps["isSeriesToggleable"];
  navigationFrame: CompositeNavigationFrame | null;
  activeUserViewport: CompositeViewportRange | null;
  panViewportByRatio: (shiftRatio: number) => void;
  zoomViewport: (zoomFactor: number, anchorRatio?: number) => void;
  setViewportRange: (range: CompositeViewportRange) => void;
  resetViewport: () => void;
  drawings: readonly ChartDrawing[];
  selectedDrawingId: string | null;
  setSelectedDrawingId: (id: string | null) => void;
  drawColor: string;
  addDrawing: (drawing: ChartDrawing) => void;
  removeDrawing: () => void;
  pickDrawColor: (color: string) => void;
}) {
  const [legendKeyboardIndex, setLegendKeyboardIndex] = useState<number | null>(null);
  const [armedTool, setArmedTool] = useState<ChartToolKind | null>(null);
  const [keyboardPlacement, setKeyboardPlacement] = useState<KeyboardToolPlacement | null>(null);
  // Whether the user moved into the chart from the pane's tab strip; see `inside`.
  const [entered, setEntered] = useState(false);
  const keyboardId = `composite-chart:${useId()}`;
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  useEffect(() => {
    setLegendKeyboardIndex((current) => (
      current === null || visibleLegendSeries.length === 0
        ? null
        : Math.min(current, visibleLegendSeries.length - 1)
    ));
  }, [visibleLegendSeries.length]);
  // Sticky while armed: the toolbar chip shows which tool owns the drag, and a
  // one-shot tool would blink off before the user could see it.
  const armTool = useCallback((tool: ChartToolKind | null) => {
    // A tool is placed with the arrows, so picking one moves into the chart.
    if (tool !== null) setEntered(true);
    setArmedTool((current) => current === tool ? null : tool);
    setKeyboardPlacement(null);
    if (tool === null) setSelectedDrawingId(null);
    if (tool !== "level") setSelectedLevelId(null);
  }, []);
  const cancelKeyboardPlacement = useCallback(() => setKeyboardPlacement(null), []);
  // A press, drag or wheel on the chart moves into it, as Down or Enter do.
  const activateFromPointer = useCallback(() => {
    setEntered(true);
    onActivate?.();
  }, [onActivate]);
  const levelHost = useMemo(
    () => scene && levels ? levelPanel(scene, levels.seriesId) : null,
    [levels, scene],
  );
  const levelItems = levels?.items ?? [];
  const levelsEditable = !!levels?.onEdit && !!levelHost;
  const selectedLevel = levelItems.find((level) => level.id === selectedLevelId) ?? null;
  useEffect(() => {
    if (selectedLevelId && !selectedLevel) setSelectedLevelId(null);
  }, [selectedLevel, selectedLevelId]);
  const keyboardCursorDateRef = useRef<Date | null>(scene?.cursorDate ?? null);
  keyboardCursorDateRef.current = scene?.cursorDate ?? null;

  // The cursor keys belong to every focused chart; pan, zoom, the tools and
  // their keys only to one that navigates.
  const arrowsClaimed = usePaneArrowsClaimed();
  const keyboardActive = focused && interactive;
  const toolsActive = keyboardActive && navigable;
  // Under a tab strip, a chart you pan and draw on is one focus level down: the
  // strip keeps Left, Right, h and l until Down, Enter, a click or a tool moves
  // into the chart, and Esc or Up hands them back. A pane with no strip (G)
  // leaves the chart its keys throughout.
  const paneHasStrip = usePaneHasTabStrip();
  const zoned = navigable && paneHasStrip;
  const inside = zoned && entered;
  usePaneArrowHold(focused && inside);
  // The next visit to the pane or the tab starts at the strip.
  const wasFocusedRef = useRef(focused);
  useEffect(() => {
    if (wasFocusedRef.current && !focused) setEntered(false);
    wasFocusedRef.current = focused;
  }, [focused]);
  // A time is picked with the arrows and Enter.
  const picking = !!timePick;
  useEffect(() => {
    if (picking) setEntered(true);
  }, [picking]);
  useEffect(() => {
    if (!toolsActive) setKeyboardPlacement(null);
  }, [toolsActive]);
  const legendKeysActive = keyboardActive && showLegend && visibleLegendSeries.length > 0;
  const legendEntry = legendKeyboardIndex === null ? undefined : visibleLegendSeries[legendKeyboardIndex];
  const legendEntryToggleable = !!legendEntry && !!onToggleSeries && (isSeriesToggleable?.(legendEntry) ?? true);
  const anyLegendToggleable = legendKeysActive && !!onToggleSeries
    && visibleLegendSeries.some((entry) => isSeriesToggleable?.(entry) ?? true);
  // With a drawing tool in hand, [ and ] step through the drawings instead of
  // the legend, the way a click with that tool picks one.
  const drawingKeysActive = toolsActive && isDrawingTool(armedTool) && drawings.length > 0 && !keyboardPlacement;
  // Backspace only deletes what the user is working on; otherwise it is the
  // pane's back key.
  const canDeleteDrawing = toolsActive && drawings.length > 0 && (!!selectedDrawingId || isDrawingTool(armedTool));
  // An owner that holds the cursor decides when it goes, so Esc stays the pane's.
  const clearableCursor = !!scene?.cursorDate && cursorDate === undefined;

  const enterChart = () => {
    setEntered(true);
    // The cursor shows where the keys went, starting on the latest bar.
    if (!scene || cursorDate !== undefined || keyboardCursorDateRef.current) return;
    const date = resolveAdjacentCompositeCursorDate(scene, null, -1);
    keyboardCursorDateRef.current = date;
    updateCursor(date);
  };
  const leaveChart = () => {
    setEntered(false);
    setLegendKeyboardIndex(null);
    if (!clearableCursor) return;
    keyboardCursorDateRef.current = null;
    updateCursor(null);
  };
  const placementPanel = (panelId: string) => scene?.panels.find((panel) => panel.id === panelId) ?? null;
  const startKeyboardPlacement = () => {
    if (!scene || !armedTool) return;
    const panel = scene.panels.find((entry) => resolveMeasureAxisDomain(entry) !== null);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    const date = keyboardCursorDateRef.current ?? resolveAdjacentCompositeCursorDate(scene, null, -1);
    if (!panel || !domain || !date) return;
    const time = date.getTime();
    const value = resolveMeasureValueAt(panel, time) ?? unprojectCompositeValue(0.5, domain);
    if (value === null) return;
    const anchor = { time, value };
    onActivate?.();
    if (isDrawingTool(armedTool)) setSelectedDrawingId(null);
    setKeyboardPlacement({ kind: armedTool, panelId: panel.id, start: anchor, end: anchor, path: [anchor], freeValue: false });
    keyboardCursorDateRef.current = date;
    updateCursor(date);
  };
  /** Moves the end to a new bar, following the series until Up or Down set a level. */
  const moveKeyboardPlacement = (
    placement: KeyboardToolPlacement,
    move: { time: number } | { level: 1 | -1 },
  ): KeyboardToolPlacement | null => {
    const panel = placementPanel(placement.panelId);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    if (!panel || !domain) return null;
    let { time, value } = placement.end;
    let freeValue = placement.freeValue;
    if ("level" in move) {
      // Half a row per press: fine enough to reach a wick, quick enough to cross the plot.
      const step = 1 / (2 * Math.max(panel.height - 1, 1));
      const ratio = projectCompositeValue(value, domain) ?? 0.5;
      value = unprojectCompositeValue(Math.max(0, Math.min(1, ratio - move.level * step)), domain) ?? value;
      freeValue = true;
    } else {
      time = move.time;
      if (!freeValue) value = resolveMeasureValueAt(panel, time) ?? value;
    }
    const end = { time, value };
    return { ...placement, end, path: [...placement.path, end], freeValue };
  };
  const finishKeyboardPlacement = () => {
    const placement = keyboardPlacement;
    setKeyboardPlacement(null);
    // A placement that never left its anchor spans nothing, like a click.
    if (!placement || placement.start.time === placement.end.time) return;
    if (placement.kind === "zoom") {
      if (!navigationFrame) return;
      const range = resolveZoomTimeRange(placement.start.time, placement.end.time, navigationFrame.minimumSpanMs);
      if (range) setViewportRange(range);
      return;
    }
    if (!isDrawingTool(placement.kind)) return;
    const points = placement.kind === "pencil"
      ? placement.path.filter((point, index, path) => (
        index === 0 || point.time !== path[index - 1]!.time || point.value !== path[index - 1]!.value
      ))
      : [placement.start, placement.end];
    if (points.length < 2) return;
    addDrawing({ id: nextDrawingId(), panelId: placement.panelId, points, color: drawColor });
  };
  const stepLegend = (direction: -1 | 1) => {
    onActivate?.();
    setLegendKeyboardIndex((current) => (
      current === null
        ? direction > 0 ? 0 : visibleLegendSeries.length - 1
        : (current + direction + visibleLegendSeries.length) % visibleLegendSeries.length
    ));
  };
  const toggleLegendEntry = () => {
    if (!legendEntry || !legendEntryToggleable) return;
    onActivate?.();
    onToggleSeries?.(legendEntry.id);
  };
  /** A level at the keyboard cursor's price, or the last price without a cursor. */
  const addLevelAtCursor = () => {
    if (!levels?.onEdit || !levelHost || !scene) return;
    const { panel, domain } = levelHost;
    const date = keyboardCursorDateRef.current ?? scene.dates.at(-1) ?? null;
    // The levels' own series, not whichever one the panel lists first.
    const pricePanel = { ...panel, series: panel.series.filter((entry) => entry.source.id === levels.seriesId) };
    const value = (date ? resolveMeasureValueAt(pricePanel, date.getTime()) : null)
      ?? (panel.lastPrice?.seriesId === levels.seriesId ? panel.lastPrice.value : null)
      ?? unprojectCompositeValue(0.5, domain);
    if (value === null) return;
    const rounded = roundLevelValue(value, domain);
    onActivate?.();
    // Enter again at the same cursor picks the level already there.
    const existing = levelItems.find((level) => level.editable && level.value === rounded);
    if (existing) {
      setSelectedLevelId(existing.id);
      return;
    }
    const id = nextLevelId();
    levels.onEdit({ kind: "add", id, value: rounded });
    setSelectedLevelId(id);
  };
  /** Half a row per press, like a keyboard-placed tool's end. */
  const nudgeLevel = (level: CompositeChartLevel, direction: 1 | -1) => {
    if (!levels?.onEdit || !levelHost) return;
    const { panel, domain } = levelHost;
    const ratio = projectCompositeValue(level.value, domain);
    if (ratio === null) return;
    const step = 1 / (2 * Math.max(panel.height - 1, 1));
    const value = unprojectCompositeValue(Math.max(0, Math.min(1, ratio - direction * step)), domain);
    if (value !== null) levels.onEdit({ kind: "move", id: level.id, value: roundLevelValue(value, domain) });
  };
  const stepLevel = (direction: -1 | 1) => {
    // Top to bottom, the order they read in on the plot.
    const ordered = [...levelItems].sort((left, right) => right.value - left.value);
    if (ordered.length === 0) return;
    const index = ordered.findIndex((level) => level.id === selectedLevelId);
    const next = index < 0
      ? direction > 0 ? 0 : ordered.length - 1
      : (index + direction + ordered.length) % ordered.length;
    setSelectedLevelId(ordered[next]!.id);
  };
  const removeSelectedLevel = () => {
    if (!selectedLevel?.editable) return;
    levels?.onEdit?.({ kind: "remove", id: selectedLevel.id });
    setSelectedLevelId(null);
  };
  const runLevelAction = () => {
    if (selectedLevel?.actionable) levels?.action?.run(selectedLevel);
  };
  const stepDrawing = (direction: -1 | 1) => {
    if (drawings.length === 0) return;
    const index = drawings.findIndex((drawing) => drawing.id === selectedDrawingId);
    const next = index < 0
      ? direction > 0 ? 0 : drawings.length - 1
      : (index + direction + drawings.length) % drawings.length;
    setSelectedDrawingId(drawings[next]!.id);
  };
  const keyboardToolDrag = useMemo<KeyboardToolDrag | null>(() => {
    if (!keyboardPlacement || !scene) return null;
    const panel = scene.panels.find((entry) => entry.id === keyboardPlacement.panelId);
    const domain = panel ? resolveMeasureAxisDomain(panel) : null;
    if (!panel || !domain) return null;
    const project = (point: ChartDrawingPoint) => {
      const xRatio = projectCompositeTimestamp(scene.timeScale, point.time)?.ratio;
      const yRatio = projectCompositeValue(point.value, domain);
      return typeof xRatio === "number" && yRatio !== null ? { xRatio, yRatio } : null;
    };
    const start = project(keyboardPlacement.start);
    const end = project(keyboardPlacement.end);
    if (!start || !end) return null;
    return {
      panelId: panel.id,
      start: keyboardPlacement.start,
      end: keyboardPlacement.end,
      drag: {
        kind: keyboardPlacement.kind,
        startXRatio: start.xRatio,
        startYRatio: start.yRatio,
        endXRatio: end.xRatio,
        endYRatio: end.yRatio,
        path: keyboardPlacement.path.flatMap((point) => {
          const projected = project(point);
          return projected ? [projected] : [];
        }),
      },
    };
  }, [keyboardPlacement, scene]);

  // Scoped, so the chart sees its keys before an older pane or stack handler
  // (Backspace back, Esc close) whichever mounted first; a dialog opened over
  // it is a newer scope and still comes first.
  useShortcut((event) => {
    if (!keyboardActive) return;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (timePick && scene && isPlainKey(event, "return", "enter", "escape")) {
      consume();
      if (event.name === "escape") timePick.onCancel();
      else chartActionsRef.current.pick();
      return;
    }
    if (zoned && !entered && isPlainKey(event, "down", "return", "enter")) {
      consume();
      enterChart();
      return;
    }
    const levelKeys = toolsActive && armedTool === "level" && levelsEditable && !keyboardPlacement;
    if (levelKeys && isPlainKey(event, "return", "enter")) {
      consume();
      addLevelAtCursor();
      return;
    }
    if (levelKeys && selectedLevel?.editable && isPlainKey(event, "up", "down")) {
      consume();
      nudgeLevel(selectedLevel, event.name === "up" ? 1 : -1);
      return;
    }
    if (levelKeys && levelItems.length > 0 && isPlainKey(event, "[", "]")) {
      consume();
      stepLevel(event.name === "[" ? -1 : 1);
      return;
    }
    if (toolsActive && selectedLevel?.editable && levelsEditable && isPlainKey(event, "backspace")) {
      consume();
      removeSelectedLevel();
      return;
    }
    // Taken even once the level has its alert, which then says so, so a quick
    // second press never falls through to the plain `a` pan.
    if (toolsActive && selectedLevel && levels?.action && isShiftedLetter(event, "a")) {
      consume();
      levels.action.run(selectedLevel);
      return;
    }
    if (toolsActive && armedTool && isPlainKey(event, "return", "enter") && scene) {
      consume();
      if (keyboardPlacement) finishKeyboardPlacement();
      else startKeyboardPlacement();
      return;
    }
    if (keyboardPlacement && (isPlainKey(event, "escape") || isPlainKey(event, "backspace"))) {
      consume();
      setKeyboardPlacement(null);
      return;
    }
    if (keyboardPlacement && keyboardPlacement.kind !== "zoom" && isPlainKey(event, "up", "down")) {
      consume();
      const level = event.name === "up" ? 1 : -1;
      setKeyboardPlacement((current) => current && moveKeyboardPlacement(current, { level }));
      return;
    }
    if (isPlainKey(event, "[", "]") && (drawingKeysActive || legendKeysActive)) {
      consume();
      const direction = event.name === "[" ? -1 : 1;
      if (drawingKeysActive) stepDrawing(direction);
      else stepLegend(direction);
      return;
    }
    if (isPlainKey(event, "space") && legendKeysActive && legendEntryToggleable) {
      consume();
      toggleLegendEntry();
      return;
    }
    if (isPlainKey(event, "escape") && toolsActive && (armedTool || selectedDrawingId || selectedLevelId)) {
      consume();
      setArmedTool(null);
      setSelectedDrawingId(null);
      setSelectedLevelId(null);
      return;
    }
    if (isPlainKey(event, "escape") && legendKeysActive && legendKeyboardIndex !== null && !clearableCursor) {
      consume();
      setLegendKeyboardIndex(null);
      return;
    }
    // Whatever a tool or a pick held is gone by now, so Esc steps out to the
    // strip, and so does Up: the strip sits above. Consumed, so leaving never
    // counts toward a double-Esc close.
    if (inside && isPlainKey(event, "escape", "up")) {
      consume();
      leaveChart();
      return;
    }
    const interaction = resolveCompositeChartInteraction(event);
    if (!interaction) return;
    const cursorInteraction = interaction === "cursor-left"
      || interaction === "cursor-right"
      || interaction === "clear-cursor";
    if (!cursorInteraction && !toolsActive) return;
    if (
      (interaction === "clear-cursor" && !clearableCursor)
      || ((interaction === "arm-measure"
        || interaction === "arm-zoom"
        || interaction === "arm-line"
        || interaction === "arm-pencil") && !scene)
      || (interaction === "arm-level" && !levelsEditable)
      || (interaction === "delete-drawing" && !canDeleteDrawing)
      || (interaction === "cycle-colour" && !isDrawingTool(armedTool) && !selectedDrawingId)
      // A focused tab strip in the pane keeps the arrows until the user moves
      // into a chart they pan and draw on; a read-only chart never takes them.
      || ((interaction === "cursor-left" || interaction === "cursor-right") && (!scene || (arrowsClaimed && !inside)))
      || ((interaction === "zoom-in"
        || interaction === "zoom-out"
        || interaction === "pan-left"
        || interaction === "pan-right") && !navigationFrame)
    ) {
      return;
    }
    consume();
    switch (interaction) {
      case "arm-measure":
      case "arm-zoom":
      case "arm-line":
      case "arm-pencil":
      case "arm-level":
        onActivate?.();
        armTool(ARMED_TOOL_BY_INTERACTION[interaction]);
        return;
      case "delete-drawing":
        removeDrawing();
        return;
      case "cycle-colour":
        pickDrawColor(nextDrawingColor(drawColor));
        return;
      case "clear-cursor":
        keyboardCursorDateRef.current = null;
        updateCursor(null);
        return;
      case "cursor-left":
      case "cursor-right": {
        const nextDate = resolveAdjacentCompositeCursorDate(
          scene!,
          keyboardCursorDateRef.current,
          interaction === "cursor-left" ? -1 : 1,
        );
        keyboardCursorDateRef.current = nextDate;
        updateCursor(nextDate);
        if (nextDate && keyboardPlacement) {
          const time = nextDate.getTime();
          setKeyboardPlacement((current) => current && moveKeyboardPlacement(current, { time }));
        }
        return;
      }
      case "pan-left":
        panViewportByRatio(COMPOSITE_KEYBOARD_PAN_RATIO);
        return;
      case "pan-right":
        panViewportByRatio(-COMPOSITE_KEYBOARD_PAN_RATIO);
        return;
      case "reset":
        resetViewport();
        return;
      case "zoom-in":
        zoomViewport(COMPOSITE_ZOOM_STEP_FACTOR);
        return;
      case "zoom-out":
        zoomViewport(1 / COMPOSITE_ZOOM_STEP_FACTOR);
    }
  }, { enabled: keyboardActive, scope: keyboardId });

  // The keys a mode adds show where they act: Enter with a tool in hand, Space
  // on a legend entry. Everything else the chart answers is in the pane menu.
  // Footer and menu entries outlive the render that registered them, so they
  // call through to this render's actions.
  const chartActions = {
    pick: () => {
      const date = keyboardCursorDateRef.current ?? scene?.dates.at(-1) ?? null;
      if (date) timePick?.onPick(date);
    },
    start: armedTool === "level" ? addLevelAtCursor : startKeyboardPlacement,
    finish: finishKeyboardPlacement,
    stepLevel,
    removeLevel: removeSelectedLevel,
    levelAction: runLevelAction,
    toggleLegend: toggleLegendEntry,
    stepLegend,
    stepDrawing,
    removeDrawing,
    cycleColour: () => pickDrawColor(nextDrawingColor(drawColor)),
    reset: resetViewport,
    arm: (tool: ChartToolKind) => {
      onActivate?.();
      armTool(tool);
    },
    leave: leaveChart,
  };
  const chartActionsRef = useRef(chartActions);
  chartActionsRef.current = chartActions;
  // Inside the chart the footer names the way back first, so it never falls
  // behind More; on the strip there is nothing to say.
  const leaveHint = keyboardActive && inside;
  usePaneFooter(`${keyboardId}:leave`, () => leaveHint
    ? { order: -2, hints: [{ id: "chart-leave", key: "Esc", label: "tabs", title: "Back to Tabs", onPress: () => chartActionsRef.current.leave() }] }
    : null, [leaveHint]);
  const armedHints = armedTool ? KEYBOARD_TOOL_HINTS[armedTool] : null;
  const placing = !!keyboardPlacement;
  const legendEntryVisible = !!legendEntry && visibleSeriesIds.has(legendEntry.id);
  const resettable = !!activeUserViewport;
  const timePickLabel = timePick?.label ?? null;
  const levelActionHint = selectedLevel?.actionable && levels?.action ? levels.action : null;
  const levelToolKeys = toolsActive && armedTool === "level" && levelsEditable;
  const canDeleteLevel = toolsActive && levelsEditable && !!selectedLevel?.editable;
  usePaneFooter(keyboardId, () => {
    if (!keyboardActive || !scene) return null;
    const hints: PaneHint[] = [];
    if (timePickLabel) {
      hints.push({ id: "chart-pick", key: "Enter", label: timePickLabel, onPress: () => chartActionsRef.current.pick() });
    } else if (toolsActive && armedHints) {
      hints.push(placing
        ? { id: "chart-tool", key: "Enter", label: armedHints.finish, title: armedHints.finishTitle, onPress: () => chartActionsRef.current.finish() }
        : { id: "chart-tool", key: "Enter", label: armedHints.start, title: armedHints.startTitle, onPress: () => chartActionsRef.current.start() });
    }
    if (toolsActive && levelActionHint) {
      hints.push({
        id: "chart-level-action",
        key: "Shift+A",
        label: levelActionHint.label,
        title: levelActionHint.title,
        onPress: () => chartActionsRef.current.levelAction(),
      });
    }
    if (legendKeysActive && legendEntryToggleable) {
      hints.push({
        id: "chart-series",
        key: "Space",
        label: legendEntryVisible ? "hide" : "show",
        title: legendEntryVisible ? "Hide Series" : "Show Series",
        onPress: () => chartActionsRef.current.toggleLegend(),
      });
    }
    const menu: ContextMenuItem[] = [];
    if (toolsActive) {
      for (const tool of CHART_TOOL_MENU.filter((entry) => entry.kind !== "level" || levelsEditable)) {
        menu.push({
          id: `chart-tool-${tool.kind}`,
          label: tool.label,
          accelerator: tool.accelerator,
          checked: armedTool === tool.kind,
          onSelect: () => chartActionsRef.current.arm(tool.kind),
        });
      }
      if (drawingKeysActive) {
        menu.push({ id: "chart-drawing-next", label: "Next Drawing", accelerator: "]", onSelect: () => chartActionsRef.current.stepDrawing(1) });
      }
      if (canDeleteDrawing) {
        menu.push({ id: "chart-drawing-delete", label: "Delete Drawing", accelerator: "Backspace", onSelect: () => chartActionsRef.current.removeDrawing() });
      }
      if (levelToolKeys && levelItems.length > 0) {
        menu.push({ id: "chart-level-next", label: "Next Level", accelerator: "]", onSelect: () => chartActionsRef.current.stepLevel(1) });
      }
      if (canDeleteLevel) {
        menu.push({ id: "chart-level-delete", label: "Delete Level", accelerator: "Backspace", onSelect: () => chartActionsRef.current.removeLevel() });
      }
      if (isDrawingTool(armedTool) || selectedDrawingId) {
        menu.push({
          id: "chart-drawing-colour",
          label: "Drawing Colour",
          accelerator: "c",
          onSelect: () => chartActionsRef.current.cycleColour(),
        });
      }
      if (resettable) menu.push({ id: "chart-reset", label: "Reset Zoom", accelerator: "0", onSelect: () => chartActionsRef.current.reset() });
    }
    if (legendKeysActive && anyLegendToggleable && !drawingKeysActive) {
      menu.push({ id: "chart-series-next", label: "Next Series", accelerator: "]", onSelect: () => chartActionsRef.current.stepLegend(1) });
    }
    return { order: 10, hints, menu };
  }, [
    armedHints,
    anyLegendToggleable,
    armedTool,
    canDeleteDrawing,
    drawingKeysActive,
    keyboardActive,
    legendEntryToggleable,
    legendEntryVisible,
    legendKeysActive,
    placing,
    resettable,
    !!scene,
    selectedDrawingId,
    timePickLabel,
    levelActionHint,
    levelToolKeys,
    levelItems.length,
    canDeleteLevel,
    levelsEditable,
    toolsActive,
  ]);

  return {
    armedTool,
    armTool,
    cancelKeyboardPlacement,
    activateFromPointer,
    legendKeyboardIndex,
    levelHost,
    levelsEditable,
    selectedLevelId,
    setSelectedLevelId,
    keyboardToolDrag,
  };
}
