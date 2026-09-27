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
 * One selection shared by the table and the chart above it. The table's
 * selected row is the chart's cursor; hovering the chart only previews, so the
 * pointer leaving never clears the selection; clicking the chart selects the
 * nearest row; Left and Right step to the previous and next row in time, the
 * direction the chart reads, whatever order the table is sorted in.
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
  const [hover, setHover] = useState<Date | null>(null);
  const hoverRef = useRef<Date | null>(null);
  const onCursorDateChange = useCallback((date: Date | null) => {
    hoverRef.current = date;
    setHover(date);
  }, []);
  const selected = dated.find((row) => row.id === selectedId) ?? null;
  const onActivate = useCallback(() => {
    const time = hoverRef.current?.getTime();
    if (time == null) return;
    const row = nearestDatedRow(dated, time);
    if (row) onSelect(row.id);
  }, [dated, onSelect]);

  // A focused tab strip owns the arrows, as it does over any other chart.
  const arrowsClaimed = usePaneArrowsClaimed();
  useShortcut((event) => {
    if (!isPlainKey(event, "left", "right") || !selected) return;
    const index = dated.indexOf(selected);
    const next = dated[index + (event.name === "right" ? 1 : -1)];
    event.preventDefault?.();
    if (next) onSelect(next.id);
  }, { enabled: enabled && focused && !arrowsClaimed && dated.length > 1 });

  const cursorDate = !enabled
    ? null
    : hover ?? (selected ? new Date(selected.time) : null);
  return { cursorDate, onCursorDateChange, onActivate };
}
