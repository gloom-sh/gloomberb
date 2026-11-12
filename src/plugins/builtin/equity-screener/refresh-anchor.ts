import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScreenRow } from "../../../api-client/equity-screener";
import { screenRowId } from "./model";

/** How long a refresh keeps asking the table to hold the row that was at its top. */
const REFRESH_ANCHOR_HOLD_MS = 2_000;

export interface RefreshAnchor {
  index: number;
  version: number;
}

/**
 * A refresh puts a new snapshot's rows under the scroll position. This asks
 * the table to keep the row that sat at its top there: the anchor is the
 * row's place in the new rows, as a `scrollToIndex` request with a new
 * `version` per refresh. A list at its top stays there, and a row the new
 * snapshot dropped leaves the scroll as it is. The request lapses once the
 * user scrolls (`release`), and a moment after, when the table has long since
 * applied it.
 */
export function useRefreshAnchor(
  snapshotId: string | null,
  rows: readonly ScreenRow[],
  firstVisible: number,
): { anchor: RefreshAnchor | null; release: () => void } {
  const topRow = rows[firstVisible];
  const topRowId = topRow ? screenRowId(topRow) : null;
  const kept = useRef({ snapshotId, topRowId, firstVisible });
  const [anchor, setAnchor] = useState<RefreshAnchor | null>(null);
  useLayoutEffect(() => {
    const before = kept.current;
    kept.current = { snapshotId, topRowId, firstVisible };
    if (!before.topRowId || !before.snapshotId || !snapshotId || before.snapshotId === snapshotId || before.firstVisible === 0) return;
    const index = rows.findIndex((row) => screenRowId(row) === before.topRowId);
    if (index >= 0 && index !== before.firstVisible) setAnchor((current) => ({ index, version: (current?.version ?? 0) + 1 }));
  });
  useEffect(() => {
    if (!anchor) return;
    const timer = setTimeout(() => setAnchor(null), REFRESH_ANCHOR_HOLD_MS);
    return () => clearTimeout(timer);
  }, [anchor]);
  const release = useCallback(() => setAnchor(null), []);
  return { anchor, release };
}
