import { useMemo, useRef, useState } from "react";
import { hitTestLevel, levelGrabRatio, projectLevels, type ProjectedLevel } from "../levels";
import type { CompositePanelSurfaceProps } from "./props";

/** Over a level a drag moves: always while one moves, never, or at the pointer's height. */
export type LevelGrab = boolean | ((cursorYRatio: number) => boolean);

/** A level being dragged, where it is now: it is saved once, when the pointer lets go. */
export interface LevelDraft {
  id: string;
  value: number;
}

const NO_LEVELS: readonly ProjectedLevel[] = [];

/** The chart's levels on this panel: where each draws, the one being dragged, and where a drag would grab one. */
export function usePanelLevels({
  panel,
  levels,
  armedTool,
  onPickTime,
  onPickPrice,
}: Pick<CompositePanelSurfaceProps, "panel" | "levels" | "armedTool" | "onPickTime" | "onPickPrice">) {
  // A dragged level moves here and is saved once, when the pointer lets go.
  const [levelDraft, setLevelDraft] = useState<LevelDraft | null>(null);
  const levelDraftRef = useRef(levelDraft);
  levelDraftRef.current = levelDraft;
  const levelDomain = useMemo(() => {
    const series = levels ? panel.series.find((entry) => entry.source.id === levels.seriesId) : undefined;
    return series ? panel.axes[series.source.axis] ?? null : null;
  }, [levels, panel]);
  const projectedLevels = useMemo(
    () => levels && levelDomain ? projectLevels(levels.items, levelDomain, levelDraft) : NO_LEVELS,
    [levelDomain, levelDraft, levels],
  );
  // Over a line a plain drag moves, and while one moves, the pointer says it
  // goes up and down. Where the pointer is, the plot reads (see `PanelPlotSurface`).
  const levelGrab = useMemo<LevelGrab>(() => {
    if (levelDraft) return true;
    if (!levels?.onEdit || onPickTime || onPickPrice || (armedTool && armedTool !== "level")) return false;
    return (cursorYRatio) => {
      const hit = hitTestLevel(projectedLevels, cursorYRatio, levelGrabRatio(panel.height));
      return !!hit?.editable && !!hit.draggable;
    };
  }, [armedTool, levelDraft, levels?.onEdit, onPickPrice, onPickTime, panel.height, projectedLevels]);
  return { levelDraftRef, setLevelDraft, levelDomain, projectedLevels, levelGrab };
}
