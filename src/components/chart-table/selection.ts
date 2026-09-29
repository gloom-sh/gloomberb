import { useCallback, useMemo, useRef, useState } from "react";
import { usePaneArrowsClaimed } from "../layout/pane/footer/registration";
import { useShortcut } from "../../react/input";
import { isPlainKey } from "../../utils/keyboard";

export interface ChartTableSelectionOptions<T> {
  rows: readonly T[];
  getId: (row: T) => string;
  /** Where the row sits on the chart's time axis; null when it has no point. */
  getDate: (row: T) => Date | null;
  /** The table's selected row, already resolved to a real row id. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The pane's focus: Left and Right step through time only while focused. */
  focused: boolean;
  enabled?: boolean;
}

export interface ChartTableSelection {
  /** The chart's controlled cursor: the pointer while it hovers, else the selected row. */
  cursorDate: Date | null;
  onCursorDateChange: (date: Date | null) => void;
  /** Clicking the chart selects the row under the pointer. */
  onActivate: () => void;
}

interface DatedRow {
  id: string;
  time: number;
}

/** The row nearest a date, or null when no row has a point. */
export function nearestDatedRow(rows: readonly DatedRow[], time: number): DatedRow | null {
  let best: DatedRow | null = null;
  for (const row of rows) {
    if (!best || Math.abs(row.time - time) < Math.abs(best.time - time)) best = row;
  }
  return best;
}

/**
 * From a row without a point, the nearest rows around it in the table that
 * have one, named by which way they lie in time. The table's own order stands
 * in for the missing date, read in the direction its dated rows run.
 */
function undatedNeighbours(
  rows: readonly (DatedRow | { id: string; time: null })[],
  index: number,
): { earlier: DatedRow | null; later: DatedRow | null } {
  const dated = (row: DatedRow | { id: string; time: null } | undefined): row is DatedRow => row?.time != null;
  const before = rows.slice(0, index).findLast(dated) ?? null;
  const after = rows.slice(index + 1).find(dated) ?? null;
  const first = rows.find(dated);
  const last = rows.findLast(dated);
  const ascending = !first || !last || first.time <= last.time;
  return ascending ? { earlier: before, later: after } : { earlier: after, later: before };
}

/**
 * One selection shared by the table and the chart above it. The table's
 * selected row is the chart's cursor; hovering the chart only previews, so the
 * pointer leaving never clears the selection; clicking the chart selects the
 * nearest row; Left and Right step to the previous and next row in time, the
 * direction the chart reads, whatever order the table is sorted in. From a
 * row with no point they step to the nearest row that has one.
 */
export function useChartTableSelection<T>({
  rows,
  getId,
  getDate,
  selectedId,
  onSelect,
  focused,
  enabled = true,
}: ChartTableSelectionOptions<T>): ChartTableSelection {
  const dated = useMemo(() => rows
    .flatMap((row): DatedRow[] => {
      const time = getDate(row)?.getTime();
      return time != null && Number.isFinite(time) ? [{ id: getId(row), time }] : [];
    })
    .sort((left, right) => left.time - right.time), [getDate, getId, rows]);
  const datedRef = useRef(dated);
  datedRef.current = dated;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // The hover belongs to the selection it was made under: once the table or
  // the keys move the selection, the resting pointer stops overriding it.
  const [hover, setHover] = useState<{ date: Date; under: string | null } | null>(null);
  const hoverRef = useRef<Date | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // A press with no hover before it reports its date right after onActivate.
  const pressRef = useRef(false);
  const selectNearest = useCallback((date: Date) => {
    const row = nearestDatedRow(datedRef.current, date.getTime());
    if (!row) return;
    onSelectRef.current(row.id);
    setHover(null);
  }, []);
  const onCursorDateChange = useCallback((date: Date | null) => {
    hoverRef.current = date;
    setHover(date ? { date, under: selectedIdRef.current } : null);
    if (pressRef.current && date) {
      pressRef.current = false;
      selectNearest(date);
    }
  }, [selectNearest]);
  const selected = dated.find((row) => row.id === selectedId) ?? null;
  const onActivate = useCallback(() => {
    if (hoverRef.current) {
      selectNearest(hoverRef.current);
      return;
    }
    pressRef.current = true;
    queueMicrotask(() => { pressRef.current = false; });
  }, [selectNearest]);

  // A focused tab strip owns the arrows, as it does over any other chart.
  const arrowsClaimed = usePaneArrowsClaimed();
  useShortcut((event) => {
    if (!isPlainKey(event, "left", "right")) return;
    const right = event.name === "right";
    let next: DatedRow | null | undefined;
    if (selected) {
      next = dated[dated.indexOf(selected) + (right ? 1 : -1)];
    } else {
      const index = rows.findIndex((row) => getId(row) === selectedId);
      if (index < 0) return;
      const timed = rows.map((row) => {
        const time = getDate(row)?.getTime();
        return { id: getId(row), time: time != null && Number.isFinite(time) ? time : null };
      });
      const around = undatedNeighbours(timed, index);
      next = right ? around.later : around.earlier;
    }
    event.preventDefault?.();
    if (next) onSelect(next.id);
  }, { enabled: enabled && focused && !arrowsClaimed && dated.length > 0 });

  const shownHover = hover && hover.under === selectedId ? hover.date : null;
  const cursorDate = !enabled
    ? null
    : shownHover ?? (selected ? new Date(selected.time) : null);
  return { cursorDate, onCursorDateChange, onActivate };
}
