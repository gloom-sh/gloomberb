import { useEffect, useRef } from "react";
import { usePaneSettingValue } from "../../../state/app/context";
import { CHART_DRAWINGS_SETTING_KEY, parseChartDrawings, type ChartDrawing } from "./tools";

let nextDrawingSequence = 1;

export function nextDrawingId(): string {
  return `drawing:${nextDrawingSequence++}`;
}

/** Levels are stored with the account, so their ids must not repeat across sessions. */
export function nextLevelId(): string {
  return `${Date.now().toString(36)}-${(nextDrawingSequence++).toString(36)}`;
}

export const NO_DRAWINGS: readonly ChartDrawing[] = [];
/** Coalesces a drag into one write instead of one per pointer move. */
const DRAWING_PERSIST_DELAY_MS = 400;

/**
 * Drawings are anchored to data, so they outlive the mounted chart: they ride
 * along with the pane settings that already carry the chart spec. Only mounted
 * inside a pane, so a standalone chart still renders without app state.
 */
export function ChartDrawingStore({
  paneInstanceId,
  drawings,
  onRestore,
}: {
  paneInstanceId: string;
  drawings: readonly ChartDrawing[];
  onRestore: (drawings: readonly ChartDrawing[]) => void;
}) {
  const [stored, setStored] = usePaneSettingValue<readonly ChartDrawing[]>(
    CHART_DRAWINGS_SETTING_KEY,
    NO_DRAWINGS,
    paneInstanceId,
  );
  const restoredRef = useRef<readonly ChartDrawing[] | null>(null);
  if (restoredRef.current === null) {
    restoredRef.current = parseChartDrawings(stored);
  }

  useEffect(() => {
    const restored = restoredRef.current;
    if (restored && restored.length > 0) onRestore(restored);
    // Restoring once on mount: later writes must not scroll back in time.
  }, []);

  useEffect(() => {
    const restored = restoredRef.current ?? NO_DRAWINGS;
    if (drawings === restored) return;
    if (drawings.length === 0 && restored.length === 0) return;
    const timer = setTimeout(() => setStored(drawings), DRAWING_PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [drawings, setStored]);

  return null;
}

