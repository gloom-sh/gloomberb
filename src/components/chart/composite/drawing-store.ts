import { useCallback, useEffect, useRef } from "react";
import { usePaneSettingValue } from "../../../state/app/context";
import { CHART_DRAWINGS_SETTING_KEY, readSavedChartDrawings, type ChartDrawing, type SavedChartDrawings } from "./tools";

let nextDrawingSequence = 1;

/** Drawings are saved with the pane, so, like levels, their ids must not repeat across sessions. */
export function nextDrawingId(): string {
  return `drawing:${Date.now().toString(36)}-${(nextDrawingSequence++).toString(36)}`;
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
  const restoredRef = useRef<SavedChartDrawings | null>(null);
  if (restoredRef.current === null) {
    restoredRef.current = readSavedChartDrawings(stored);
  }
  // What the settings hold, so removing the last drawing is told even when the
  // pane opened with none: it is not "nothing to say" but "the stored one is gone".
  const writtenRef = useRef<readonly ChartDrawing[]>(restoredRef.current.drawings);
  const pendingRef = useRef<readonly ChartDrawing[] | null>(null);
  const setStoredRef = useRef(setStored);
  setStoredRef.current = setStored;

  useEffect(() => {
    const restored = restoredRef.current?.drawings;
    if (restored && restored.length > 0) onRestore(restored);
    // Restoring once on mount: later writes must not scroll back in time.
  }, []);

  const write = useCallback((next: readonly ChartDrawing[]) => {
    pendingRef.current = null;
    writtenRef.current = next;
    // Saved entries this build cannot read ride along, so the next edit never
    // writes away a drawing a newer build made.
    const unreadable = restoredRef.current?.unreadable ?? [];
    setStoredRef.current(unreadable.length > 0 ? [...next, ...unreadable as ChartDrawing[]] : next);
  }, []);

  useEffect(() => {
    // Untouched, or still waiting for the restore above: nothing of the user's to write.
    if (drawings === NO_DRAWINGS || drawings === writtenRef.current || (drawings.length === 0 && writtenRef.current.length === 0)) {
      pendingRef.current = null;
      return;
    }
    pendingRef.current = drawings;
    const timer = setTimeout(() => write(drawings), DRAWING_PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [drawings, write]);

  // A change made just before the chart goes away (a tab switch) is still saved.
  useEffect(() => () => {
    if (pendingRef.current) write(pendingRef.current);
  }, [write]);

  return null;
}
